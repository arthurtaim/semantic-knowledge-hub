"""«Пустой документ»: a document created without a template (server-owned technical metadata, free Markdown) and
«Применить шаблон» later."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml
from fastapi.testclient import TestClient

from app.domain.schema import split_frontmatter
from tests.conftest import make_doc

FREE_BODY = """# Заметки о витрине клиентов

Свободный текст без шаблона: что знаем о витрине и что ещё проверить.
Связано с [[SEM-ARCH-001]].

## Контекст
Витрина собирается ночью из ARIS.

## Мои вопросы
- откуда берётся сегмент клиента?
"""


def blank(client: TestClient, **overrides: Any) -> Any:
    payload: dict[str, Any] = {
        "metadata": {"title": "Заметки о витрине клиентов", "owner": "", "tags": []},
        "body": FREE_BODY,
        "reason": "Записать, что известно о витрине",
    }
    payload.update(overrides)
    return client.post("/api/authoring/drafts", json=payload)


def front(content: str) -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load(split_frontmatter(content)[0])
    return data


def codes(issues: list[dict[str, Any]]) -> set[str]:
    return {i["code"] for i in issues}


# --- creating a blank document -------------------------------------------------------------------------------


def test_blank_info_names_the_prefix_the_next_id_and_the_default_section(client: TestClient) -> None:
    info = client.get("/api/authoring/blank").json()
    assert info == {
        "id_prefix": "SEM-DOC",
        "suggested_id": "SEM-DOC-001",
        "suggested_path": "SEM-DOC-001.md",
        "default_type": "guide",
    }
    blank(client)
    assert client.get("/api/authoring/blank").json()["suggested_id"] == "SEM-DOC-002"  # skips open drafts


def test_blank_document_gets_technical_metadata_from_the_server(client: TestClient) -> None:
    response = blank(client)
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["operation"] == "create" and draft["status"] == "draft" and draft["origin"] == "manual"
    assert draft["document_id"] == "SEM-DOC-001" and draft["document_path"] == "SEM-DOC-001.md"
    assert draft["template_id"] is None and draft["template_version"] is None
    meta = front(draft["proposed_content"])
    assert meta["id"] == "SEM-DOC-001" and meta["status"] == "draft" and meta["owner"] == "unassigned"
    assert meta["type"] == "guide"  # the general section when none is chosen
    assert "template" not in meta and "template_version" not in meta
    # free Markdown: no required sections, the WikiLink stays a link; nothing to fix before review
    issues = codes(draft["validation"])
    assert "template_section_missing" not in issues and draft["error_count"] == 0
    assert "owner_unassigned" in issues
    assert draft["new_document"]["body"] == FREE_BODY
    # a draft is not knowledge
    assert client.get("/api/documents/SEM-DOC-001").status_code == 404


def test_blank_document_takes_the_chosen_section_and_rejects_an_invented_one(client: TestClient) -> None:
    chosen = blank(client, metadata={"title": "Регламент сверки", "owner": "team-a", "type": "process"})
    assert chosen.status_code == 201, chosen.text
    meta = front(chosen.json()["proposed_content"])
    assert meta["type"] == "process" and meta["owner"] == "team-a"
    invented = blank(client, metadata={"title": "Документ", "type": "notes"})
    assert invented.status_code == 422
    preview = client.post(
        "/api/authoring/check",
        json={"metadata": {"title": "Документ", "type": "glossary"}, "body": FREE_BODY},
    )
    assert preview.status_code == 200, preview.text
    assert front(preview.json()["content"])["type"] == "glossary"
    assert front(preview.json()["content"])["id"] == "SEM-DOC-002"


def test_a_template_document_cannot_take_another_section(client: TestClient) -> None:
    response = blank(client, template_id="architecture", metadata={"title": "Х", "type": "guide"})
    assert response.status_code == 422 and response.json()["code"] == "template_type_mismatch"
    same = blank(client, template_id="architecture", metadata={"title": "Х", "type": "architecture"})
    assert same.status_code == 201 and same.json()["template_id"] == "architecture"


def test_blank_body_keeps_the_existing_size_and_safety_rules(client: TestClient) -> None:
    short = blank(client, body="Коротко").json()
    assert "empty_body" in codes(short["validation"]) and not short["can_mark_ready"]
    secret = blank(client, body=FREE_BODY + "\npassword = SuperSecret123!\n").json()
    assert "secret_detected" in codes(secret["validation"])
    script = blank(client, body=FREE_BODY + "\n<script>alert(1)</script>\n").json()
    preview = client.post(
        "/api/authoring/check",
        json={"metadata": {"title": "Х"}, "body": FREE_BODY + "<script>alert(1)</script>"},
    ).json()
    assert "<script" not in preview["preview_html"] and "unsafe_markup" in codes(script["validation"])


def test_blank_creation_is_idempotent(client: TestClient) -> None:
    first = blank(client, client_request_id="blank-req-0001").json()
    again = blank(client, client_request_id="blank-req-0001")
    assert again.status_code == 201 and again.json()["id"] == first["id"]
    assert sum(1 for p in client.get("/api/drafts").json()["items"] if p["id"] == first["id"]) == 1


def test_blank_draft_is_edited_saved_and_sent_to_review_like_any_draft(client: TestClient) -> None:
    draft = blank(client).json()
    body = FREE_BODY + "\n## Итог\nВитрина пересобирается раз в сутки.\n"
    saved = client.put(
        f"/api/drafts/{draft['id']}",
        json={
            "expected_version": 1,
            "metadata": {
                "title": "Витрина клиентов",
                "owner": "team-a",
                "tags": ["витрина"],
                "type": "dataset",
            },
            "body": body,
        },
    )
    assert saved.status_code == 200, saved.text
    detail = saved.json()
    meta = front(detail["proposed_content"])
    assert detail["edit_version"] == 2 and detail["document_id"] == "SEM-DOC-001"
    assert meta["title"] == "Витрина клиентов" and meta["type"] == "dataset" and "template" not in meta
    # a save without `type` keeps the section the draft has
    kept = client.put(
        f"/api/drafts/{draft['id']}",
        json={
            "expected_version": 2,
            "metadata": {"title": "Витрина клиентов", "owner": "team-a"},
            "body": body,
        },
    )
    assert front(kept.json()["proposed_content"])["type"] == "dataset"
    moved = client.put(
        f"/api/drafts/{draft['id']}",
        json={"expected_version": 3, "metadata": {"id": "SEM-DOC-777", "title": "Х"}, "body": body},
    )
    assert moved.status_code == 422 and moved.json()["code"] == "document_id_immutable"
    stale = client.put(
        f"/api/drafts/{draft['id']}", json={"expected_version": 1, "metadata": {"title": "Х"}, "body": body}
    )
    assert stale.status_code == 409 and stale.json()["code"] == "draft_modified"
    ready = client.post(f"/api/drafts/{draft['id']}/mark-ready")
    assert ready.status_code == 200, ready.text
    assert ready.json()["status"] == "ready_for_review" and not ready.json()["can_edit"]


def test_an_imported_file_opened_in_the_editor_keeps_its_other_yaml_fields(client: TestClient) -> None:
    content = make_doc(
        "SEM-IMP-010",
        title="Импортированный регламент",
        status="draft",
        extra="relations:\n  depends_on: [SEM-ARCH-001]\naliases: [регламент сверки]\nsynthetic: true\n",
    )
    imported = client.post(
        "/api/documents/import",
        json={"content": content, "keep_original_metadata": True, "reason": "Импорт файла"},
    ).json()
    assert imported["template_id"] is None
    saved = client.put(
        f"/api/drafts/{imported['id']}",
        json={
            "expected_version": 1,
            "metadata": {"title": "Импортированный регламент", "owner": "test-team", "tags": ["test"]},
            "body": "# Заголовок\n\nСодержимое импортированного документа, исправленное в редакторе.\n",
        },
    )
    assert saved.status_code == 200, saved.text
    meta = front(saved.json()["proposed_content"])
    assert meta["relations"] == {"depends_on": ["SEM-ARCH-001"]} and meta["aliases"] == ["регламент сверки"]
    assert meta["synthetic"] is True and str(meta["reviewed_at"]) == "2026-11-01"
    assert meta["type"] == "process" and "template" not in meta


def test_import_without_any_active_template_becomes_a_blank_document(
    client_factory: Callable[..., TestClient], tmp_path: Path
) -> None:
    empty = tmp_path / "no-templates"
    empty.mkdir()
    client = client_factory(document_templates_dir=str(empty))
    preview = client.post("/api/documents/import/preview", json={"content": "# Заметка\n\nПросто текст.\n"})
    assert preview.status_code == 200, preview.text
    data = preview.json()
    fields = {f["field"]: f for f in data["fields"]}
    assert data["document_id"] == "SEM-DOC-001"
    assert fields["template"]["origin"] == "missing" and fields["type"]["value"] == "guide"
    created = client.post(
        "/api/documents/import",
        json={
            "content": "# Заметка\n\nПросто текст достаточной длины для черновика.\n",
            "metadata": {"title": "Заметка", "type": "guide"},
            "reason": "Импорт без шаблона",
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["template_id"] is None and created.json()["origin"] == "import"
