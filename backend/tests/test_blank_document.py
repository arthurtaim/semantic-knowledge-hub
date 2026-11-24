"""«Пустой документ»: a document created without a template (server-owned technical metadata, free Markdown) and
«Применить шаблон» later — to a draft (updated after confirmation) or to an indexed document (a change proposal)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from app.domain.models import DocType
from app.domain.schema import split_frontmatter
from app.domain.template_apply import apply_template_to_body, apply_template_to_content
from app.domain.templates import DocumentTemplate
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


def template(**overrides: Any) -> DocumentTemplate:
    values: dict[str, Any] = {
        "id": "architecture",
        "title": "Архитектура",
        "description": "",
        "doc_type": DocType.architecture,
        "id_prefix": "SEM-ARCH",
        "default_tags": (),
        "sections": ("Назначение", "Контекст", "Компоненты"),
        "body": "## Назначение\n> Требует уточнения: зачем\n\n## Контекст\n> Требует уточнения: окружение\n\n"
        "## Компоненты\n> Требует уточнения: части\n\n## Связанное\n> Требует уточнения: ссылки\n",
        "order": 1,
        "version": 3,
        "optional_sections": ("Связанное",),
    }
    values.update(overrides)
    return DocumentTemplate(**values)


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


# --- applying a template: the body algorithm --------------------------------------------------------------------


def test_apply_maps_headings_adds_required_skeletons_and_only_adds_lines() -> None:
    body = "# Т\n\nВступление.\n\n## контекст\nТекст контекста.\n\n## Мои вопросы\n- вопрос\n"
    applied = apply_template_to_body(body, template())
    assert applied.body == (
        "# Т\n\nВступление.\n\n"
        "## Назначение\n> Требует уточнения: зачем\n\n"
        "## контекст\nТекст контекста.\n\n"
        "## Компоненты\n> Требует уточнения: части\n\n"
        "## Мои вопросы\n- вопрос\n"
    )
    states = [(s.heading, s.state) for s in applied.sections]
    assert states == [
        ("Назначение", "added"),
        ("контекст", "matched"),
        ("Компоненты", "added"),
        ("Мои вопросы", "kept"),
        ("Связанное", "optional_missing"),
    ]
    # every original line survives in order: the result only gains lines
    original = body.split("\n")
    result = iter(applied.body.split("\n"))
    assert all(any(line == r for r in result) for line in original)


def test_apply_ignores_headings_in_code_and_appends_to_a_document_without_sections() -> None:
    body = "Текст.\n\n```\n## Назначение\n```\n"
    applied = apply_template_to_body(body, template())
    assert applied.body.startswith("Текст.\n\n```\n## Назначение\n```\n\n## Назначение\n> Требует уточнения")
    assert [s.state for s in applied.sections][:3] == ["added", "added", "added"]
    assert apply_template_to_body("", template()).body.startswith("## Назначение\n")
    # applying again changes nothing
    assert apply_template_to_body(applied.body, template()).body == applied.body


def test_apply_rewrites_only_type_and_template_lines_of_the_front_matter() -> None:
    content = (
        "---\nid: SEM-DOC-001\ntitle: Х\ntype: guide\nstatus: approved\nowner: a\ntags: [x]\n"
        "relations:\n  depends_on: [SEM-ARCH-001]\nreviewed_at: 2026-01-01\n---\n\n## Контекст\nТекст.\n"
    )
    applied = apply_template_to_content(content, template())
    assert applied.previous == {"type": "guide", "template": None, "template_version": None}
    yaml_text, body = split_frontmatter(applied.content)
    assert yaml_text.split("\n") == [
        "id: SEM-DOC-001",
        "title: Х",
        "type: architecture",
        "status: approved",
        "owner: a",
        "tags: [x]",
        "relations:",
        "  depends_on: [SEM-ARCH-001]",
        "reviewed_at: 2026-01-01",
        "template: architecture",
        "template_version: 3",
    ]
    assert body.startswith("## Назначение\n> Требует уточнения: зачем\n\n## Контекст\nТекст.\n")


# --- applying a template: drafts ----------------------------------------------------------------------------------


def test_apply_template_to_a_blank_draft_after_a_diff_preview(client: TestClient) -> None:
    draft = blank(client).json()
    preview = client.post(
        f"/api/drafts/{draft['id']}/apply-template/preview", json={"template_id": "architecture"}
    )
    assert preview.status_code == 200, preview.text
    p = preview.json()
    assert p["target"] == "draft" and p["expected_version"] == 1 and p["changed"]
    assert p["template_version"] == 1 and p["type_before"] == "guide" and p["type_after"] == "architecture"
    assert p["previous_template_id"] is None
    states = {s["heading"]: s["state"] for s in p["sections"]}
    assert states["Контекст"] == "matched" and states["Мои вопросы"] == "kept"
    assert states["Назначение"] == "added" and states["Компоненты"] == "added"
    body_removals = [
        ln for ln in p["diff"]["lines"] if ln["kind"] == "remove" and not ln["text"].startswith("type:")
    ]
    assert body_removals == []  # nothing of the text is removed
    assert client.get(f"/api/drafts/{draft['id']}").json()["edit_version"] == 1  # a preview stores nothing

    applied = client.post(
        f"/api/drafts/{draft['id']}/apply-template",
        json={"template_id": "architecture", "template_version": 1, "expected_version": 1},
    )
    assert applied.status_code == 200, applied.text
    detail = applied.json()
    assert detail["template_id"] == "architecture" and detail["template_version"] == 1
    assert detail["edit_version"] == 2 and detail["document_id"] == "SEM-DOC-001"  # the ID never changes
    meta = front(detail["proposed_content"])
    assert (
        meta["template"] == "architecture"
        and meta["template_version"] == 1
        and meta["type"] == "architecture"
    )
    body = detail["new_document"]["body"]
    for kept in (
        "Свободный текст без шаблона",
        "[[SEM-ARCH-001]]",
        "## Мои вопросы",
        "Витрина собирается ночью",
    ):
        assert kept in body
    assert "## Компоненты\n> Требует уточнения" in body
    assert detail["history"][-1]["action"] == "template_applied"
    # the draft is now validated by the template (the remaining sections are a warning, not a block)
    assert "template_section_missing" not in codes(detail["validation"])
    # later saves keep the pinned template
    saved = client.put(
        f"/api/drafts/{draft['id']}",
        json={"expected_version": 2, "metadata": {"title": "Заметки"}, "body": body + "\nЕщё строка.\n"},
    )
    assert saved.status_code == 200, saved.text
    assert front(saved.json()["proposed_content"])["template"] == "architecture"


def test_apply_template_is_guarded_against_stale_drafts_and_templates(client: TestClient) -> None:
    draft = blank(client).json()
    stale = client.post(
        f"/api/drafts/{draft['id']}/apply-template",
        json={"template_id": "architecture", "template_version": 1, "expected_version": 7},
    )
    assert stale.status_code == 409 and stale.json()["code"] == "draft_modified"
    moved_on = client.post(
        f"/api/drafts/{draft['id']}/apply-template",
        json={"template_id": "integration", "template_version": 1, "expected_version": 1},
    )
    assert moved_on.status_code == 409 and moved_on.json()["code"] == "template_version_changed"
    assert client.get(f"/api/drafts/{draft['id']}").json()["template_id"] is None  # nothing applied
    ok = client.post(
        f"/api/drafts/{draft['id']}/apply-template",
        json={"template_id": "architecture", "template_version": 1, "expected_version": 1},
    )
    assert ok.status_code == 200
    again = client.post(
        f"/api/drafts/{draft['id']}/apply-template",
        json={"template_id": "architecture", "template_version": 1, "expected_version": 2},
    )
    assert again.status_code == 409 and again.json()["code"] == "template_apply_no_change"
    client.post(f"/api/drafts/{draft['id']}/mark-ready")
    closed = client.post(f"/api/drafts/{draft['id']}/apply-template/preview", json={"template_id": "adr"})
    assert closed.status_code == 409 and closed.json()["code"] == "draft_not_editable"


@pytest.mark.parametrize(
    ("template_id", "status", "code"),
    [
        ("meeting_decision", 409, "template_not_active"),  # deprecated
        ("external_import", 409, "template_not_active"),  # hidden, only for external pages
        ("no_such_template", 404, "template_not_found"),
    ],
)
def test_only_an_active_template_can_be_applied(
    client: TestClient, template_id: str, status: int, code: str
) -> None:
    draft = blank(client).json()
    preview = client.post(
        f"/api/drafts/{draft['id']}/apply-template/preview", json={"template_id": template_id}
    )
    assert preview.status_code == status and preview.json()["code"] == code
    confirm = client.post(
        "/api/documents/SEM-ARCH-001/apply-template",
        json={"template_id": template_id, "template_version": 1, "base_revision": "x"},
    )
    assert confirm.status_code == status and confirm.json()["code"] == code


# --- applying a template: indexed (approved) documents ------------------------------------------------------------


def test_apply_template_to_an_approved_document_creates_a_change_proposal(client: TestClient) -> None:
    before = client.get("/api/documents/SEM-ARCH-001").json()
    preview = client.post(
        "/api/documents/SEM-ARCH-001/apply-template/preview", json={"template_id": "architecture"}
    ).json()
    assert preview["target"] == "document" and preview["base_revision"] == before["revision"]
    assert preview["type_before"] == "architecture" == preview["type_after"]
    assert preview["content_before"] == before["raw"]
    assert {s["heading"]: s["state"] for s in preview["sections"]}["Principles"] == "kept"

    stale = client.post(
        "/api/documents/SEM-ARCH-001/apply-template",
        json={"template_id": "architecture", "template_version": 1, "base_revision": "0" * 12},
    )
    assert stale.status_code == 409 and stale.json()["code"] == "revision_conflict"
    created = client.post(
        "/api/documents/SEM-ARCH-001/apply-template",
        json={"template_id": "architecture", "template_version": 1, "base_revision": before["revision"]},
    )
    assert created.status_code == 201, created.text
    proposal = created.json()
    assert proposal["operation"] == "update" and proposal["status"] == "draft"
    assert (
        proposal["base_revision"] == before["revision"]
        and proposal["proposed_content"] == preview["content_after"]
    )
    assert proposal["reason"] == "Применить шаблон «Архитектура» v1" and proposal["error_count"] == 0
    meta = front(proposal["proposed_content"])
    assert (
        meta["template"] == "architecture" and meta["status"] == "approved" and meta["id"] == "SEM-ARCH-001"
    )
    # the approved original is untouched until review and merge
    after = client.get("/api/documents/SEM-ARCH-001").json()
    assert after["revision"] == before["revision"] and after["raw"] == before["raw"]
    assert after.get("template_id") is None
    # an update draft can take another template the same way
    other = client.post(
        f"/api/drafts/{proposal['id']}/apply-template/preview", json={"template_id": "knowledge_article"}
    ).json()
    assert other["previous_template_id"] == "architecture" and other["type_after"] == "guide"
    switched = client.post(
        f"/api/drafts/{proposal['id']}/apply-template",
        json={"template_id": "knowledge_article", "template_version": 2, "expected_version": 1},
    )
    assert switched.status_code == 200, switched.text
    assert front(switched.json()["proposed_content"])["template"] == "knowledge_article"


# --- AI on a blank draft ----------------------------------------------------------------------------------------


def test_ai_actions_work_on_a_blank_draft_and_completeness_waits_for_a_template(client: TestClient) -> None:
    draft = blank(client).json()
    meta = client.post("/api/ai/proposals", json={"kind": "suggest_metadata", "draft_id": draft["id"]})
    assert meta.status_code == 201, meta.text
    assert any(i["kind"] == "template" for i in meta.json()["items"])  # a template is only suggested
    complete = client.post("/api/ai/proposals", json={"kind": "check_completeness", "draft_id": draft["id"]})
    assert [i["id"] for i in complete.json()["items"]][:1] == ["no_template"]
    summary = client.post("/api/ai/proposals", json={"kind": "summarize", "draft_id": draft["id"]})
    assert summary.status_code == 201, summary.text
