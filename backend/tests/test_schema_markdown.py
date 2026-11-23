"""Frontmatter parsing/validation and safe Markdown rendering (AC-12, AC-14)."""

from __future__ import annotations

from html.parser import HTMLParser

import pytest

from app.domain.markdown import parse_markdown, render_html, slugify
from app.domain.schema import is_valid_document_id, parse_document
from tests.conftest import make_doc


class _Collector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, dict[str, str | None]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append((tag, dict(attrs)))


def parsed_elements(html: str) -> list[tuple[str, dict[str, str | None]]]:
    collector = _Collector()
    collector.feed(html)
    return collector.elements


def codes(text: str, **kwargs: str) -> set[str]:
    return {i.code for i in parse_document(text, **kwargs).issues}


def test_valid_document_parses() -> None:
    parsed = parse_document(make_doc("TEST-001", title="Пример"))
    assert parsed.is_valid, parsed.issues
    assert parsed.metadata["id"] == "TEST-001"
    assert parsed.metadata["tags"] == ["test", "demo"]
    assert str(parsed.metadata["reviewed_at"]) == "2026-11-01"


def test_crlf_and_bom_are_normalized() -> None:
    text = "﻿" + make_doc("TEST-002").replace("\n", "\r\n")
    assert parse_document(text).is_valid


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("# no frontmatter\n\nbody text that is long enough", "frontmatter_missing"),
        ("---\nid: A\ntitle: t\n", "frontmatter_unterminated"),
        ("---\nid: [unclosed\n---\n\n# H\n\nbody text long enough", "frontmatter_invalid_yaml"),
        ("---\n- just\n- a list\n---\n\n# H\n\nbody text long enough", "frontmatter_not_mapping"),
    ],
)
def test_structural_errors(text: str, code: str) -> None:
    assert code in codes(text)


def test_missing_required_fields() -> None:
    text = "---\nid: TEST-003\ntitle: Без полей\n---\n\n# H\n\nДостаточно длинное содержимое документа."
    missing = {i.field for i in parse_document(text).issues if i.code == "missing_field"}
    assert missing == {"type", "status", "owner", "tags"}


def test_invalid_enums_and_id() -> None:
    text = (
        make_doc("../etc/passwd")
        .replace("type: process", "type: banana")
        .replace("status: approved", "status: published")
    )
    found = codes(text)
    assert {"invalid_id", "invalid_type", "invalid_status"} <= found


def test_duplicate_yaml_key_rejected() -> None:
    text = make_doc("TEST-004").replace("id: TEST-004\n", "id: TEST-004\nid: TEST-005\n")
    assert "frontmatter_invalid_yaml" in codes(text)


def test_yaml_aliases_rejected() -> None:
    text = make_doc("TEST-005", extra="anchors: &a [1, 2]\nrefs: *a\n")
    assert "frontmatter_invalid_yaml" in codes(text)


def test_unknown_field_is_warning_not_error() -> None:
    parsed = parse_document(make_doc("TEST-006", extra="custom_field: value\n"))
    assert parsed.is_valid
    assert any(w.code == "unknown_field" for w in parsed.warnings)
    assert parsed.extra_metadata["custom_field"] == "value"


def test_empty_body_rejected() -> None:
    assert "empty_body" in codes(make_doc("TEST-007", body="# H\n"))


def test_secrets_and_personal_data_rejected() -> None:
    assert "secret_detected" in codes(
        make_doc("TEST-008", body="# H\n\ntoken glpat-abcdefghijklmnopqrstuvwxyz\n")
    )
    assert "secret_detected" in codes(make_doc("TEST-009", body="# H\n\npassword = Sup3rS3cretValue!\n"))
    assert "personal_data_detected" in codes(
        make_doc("TEST-010", body="# H\n\nКарта 4111 1111 1111 1111 в тексте.\n")
    )


def test_placeholder_credentials_are_not_flagged() -> None:
    assert "secret_detected" not in codes(
        make_doc("TEST-011", body="# H\n\nУкажите `password=<placeholder>` в секретах.\n")
    )


def test_expected_id_mismatch() -> None:
    assert "id_changed" in codes(make_doc("OTHER-ID"), expected_id="TEST-012")


@pytest.mark.parametrize("value", ["SEM-ARCH-001", "a", "doc_1.v2"])
def test_valid_ids(value: str) -> None:
    assert is_valid_document_id(value)


@pytest.mark.parametrize("value", ["", "../x", "a/b", "a..b", "-start", "x" * 129, "id with space", "a\\b"])
def test_invalid_ids(value: str) -> None:
    assert not is_valid_document_id(value)


# --- Markdown ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(1)">',
        "[click](javascript:alert(1))",
        "[data](data:text/html;base64,PHNjcmlwdD4=)",
        '<a href="javascript:alert(1)">x</a>',
        "<iframe src='https://evil.example'></iframe>",
        "![x](https://tracker.example/pixel.png)",
    ],
)
def test_xss_payloads_are_neutralized(payload: str) -> None:
    elements = parsed_elements(render_html(f"# Title\n\n{payload}\n"))
    tags = {tag for tag, _ in elements}
    assert not tags & {"script", "img", "iframe", "object", "embed", "style"}
    for _, attrs in elements:
        assert not any(name.startswith("on") for name in attrs)
        href = attrs.get("href", "") or ""
        assert not href.lower().startswith(("javascript:", "data:", "vbscript:"))


def test_raw_html_is_escaped_as_text() -> None:
    html = render_html("<b>bold</b>")
    assert "&lt;b&gt;" in html


def test_external_links_get_safe_rel_and_doc_links_are_internal() -> None:
    html = render_html("[ext](https://example.org) and [doc](SEM-ARCH-001.md#principles)")
    assert 'rel="noopener noreferrer nofollow"' in html
    assert 'href="/documents/SEM-ARCH-001#principles"' in html


def test_heading_anchors_match_sections() -> None:
    body = "# Обзор\n\nТекст.\n\n## Детали\n\nЕщё.\n\n## Детали\n\nПовтор.\n"
    parsed = parse_markdown(body)
    anchors = [s.anchor for s in parsed.sections]
    assert anchors == ["обзор", "детали", "детали-1"]
    html = render_html(body)
    for anchor in anchors:
        assert f'id="{anchor}"' in html


def test_slugify_keeps_cyrillic() -> None:
    assert slugify("Открытые вопросы (v2)") == "открытые-вопросы-v2"
