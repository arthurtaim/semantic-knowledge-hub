"""M4.6 authoring of new documents: templates, generated frontmatter, validation, persistent drafts,
uniqueness of ID/path, safe preview and the honest demo AI (offline, local workspace)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from app.domain.schema import split_frontmatter

TEMPLATE_SECTIONS = {
    "architecture": [
        "Назначение",
        "Контекст",
        "Компоненты",
        "Взаимодействия",
        "Зависимости",
        "Ограничения",
        "Решения",
        "Связанные документы",
    ],
    "integration": [
        "Назначение",
        "Источник и получатель",
        "Передаваемые данные и метаданные",
        "Маппинг",
        "Бизнес-правила",
        "Ограничения",
        "Ошибки",
        "Требования",
        # v2 (M5.6.2): v1 with these four sections stays readable in document_templates/history/
        "Правила качества данных (Data Quality Rules)",
        "Происхождение данных (Data Lineage)",
        "Частота обновления (Update Frequency)",
        "Валидационные ограничения (Validation Constraints)",
    ],
    "dataset_spec": [
        "Обзор (Overview)",
        "Системы-источники (Source Systems)",
        "Бизнес-сущности (Business Entities)",
        "Атрибуты (Attributes)",
        "Правила маппинга (Mapping Rules)",
        "Качество данных (Data Quality)",
        "Политика обновления (Refresh Policy)",
        "Ограничения доступа (Access Restrictions)",
        "Связанные документы (Related Docs)",
    ],
    "business_entity": [
        "Определение",
        "Назначение",
        "Атрибуты",
        "Связи",
        "Бизнес-правила",
        "Источники",
        "Ограничения",
    ],
    "adr": ["Контекст", "Проблема", "Альтернативы", "Решение", "Обоснование", "Последствия", "Статус"],
    "team_process": [
        "Назначение",
        "Участники",
        "Входы",
        "Шаги",
        "Ответственные",
        "Результаты",
        "Исключения",
        "Связи",
    ],
}


def templates(client: TestClient) -> dict[str, dict[str, Any]]:
    response = client.get("/api/authoring/templates")
    assert response.status_code == 200, response.text
    return {t["id"]: t for t in response.json()}


def new_doc_payload(
    client: TestClient,
    template_id: str = "architecture",
    *,
    doc_id: str | None = None,
    title: str = "Контур метаданных",
    body: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    template = templates(client)[template_id]
    metadata = {
        "id": doc_id or template["suggested_id"],
        "title": title,
        "owner": "semantic-team",
        "tags": ["demo"],
    }
    metadata.update(extra.pop("metadata", {}))
    return {
        "template_id": template_id,
        "metadata": metadata,
        "body": body if body is not None else f"# {title}\n\n{template['skeleton']}",
        "reason": "Новый документ для проверки авторинга",
        **extra,
    }


def check(client: TestClient, payload: dict[str, Any]) -> dict[str, Any]:
    payload = {k: v for k, v in payload.items() if k != "reason"}
    response = client.post("/api/authoring/check", json=payload)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def create_draft(client: TestClient, **kwargs: Any) -> dict[str, Any]:
    response = client.post("/api/authoring/drafts", json=new_doc_payload(client, **kwargs))
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


def test_templates_with_required_structure_and_free_ids(client: TestClient) -> None:
    found = templates(client)
    assert set(found) == set(TEMPLATE_SECTIONS)
    for template_id, sections in TEMPLATE_SECTIONS.items():
        assert found[template_id]["sections"] == sections
    # SEM-ARCH-001 exists in the fixtures: the suggestion never collides with a document
    assert found["architecture"]["suggested_id"] == "SEM-ARCH-002"
    assert found["architecture"]["suggested_path"] == "SEM-ARCH-002.md"
    assert found["business_entity"]["doc_type"] == "domain"
    assert found["adr"]["doc_type"] == "decision"


def test_check_generates_frontmatter_and_safe_preview(client: TestClient) -> None:
    payload = new_doc_payload(
        client,
        body="# Контур\n\n## Назначение\n\nТекст <script>alert(1)</script> и [ссылка](javascript:alert(1)).\n",
        metadata={
            "title": 'Опасный "заголовок"\nstatus: approved',
            "related_ids": ["SEM-ARCH-001", "NO-SUCH-1"],
        },
    )
    data = check(client, payload)
    meta = yaml.safe_load(split_frontmatter(data["content"])[0])
    # values are serialized by YAML, never concatenated: the title cannot inject a status
    assert meta["status"] == "draft" and meta["type"] == "architecture"
    assert meta["title"].startswith('Опасный "заголовок"') and meta["id"] == "SEM-ARCH-002"
    assert "<script" not in data["preview_html"] and 'href="javascript' not in data["preview_html"]
    codes = {i["code"] for i in data["validation"]}
    assert {"template_section_missing", "unresolved_related"} <= codes
    assert data["id_available"] and data["path_available"]


def test_new_document_draft_is_persistent_and_not_in_the_catalog(
    client_factory: Callable[..., TestClient],
) -> None:
    client = client_factory()
    draft = create_draft(client)
    assert draft["operation"] == "create" and draft["status"] == "draft"
    assert draft["base_revision"] == "" and draft["source_document_state"] == "new_document"
    assert draft["can_edit"] and draft["can_delete"] and draft["can_mark_ready"]
    # the diff of a new file adds the whole content
    diff = draft["diff"]
    assert diff["deletions"] == 0 and diff["additions"] == len(draft["proposed_content"].split("\n"))
    assert diff["lines"][0]["kind"] == "hunk" and diff["lines"][0]["text"].startswith("@@ -0,0 +1,")
    assert draft["new_document"]["metadata"]["id"] == "SEM-ARCH-002"
    assert "## Назначение" in draft["new_document"]["body"]
    # a draft is not knowledge: not listed, not searchable, not citable
    assert client.get("/api/documents/SEM-ARCH-002").status_code == 404
    assert client.get("/api/search", params={"q": "Контур метаданных"}).json()["items"] == []
    # survives a restart (same workspace, new process)
    restarted = client_factory()
    again = restarted.get(f"/api/drafts/{draft['id']}")
    assert again.status_code == 200 and again.json()["proposed_content"] == draft["proposed_content"]


def test_duplicate_id_or_path_is_blocked(client: TestClient) -> None:
    existing = client.post("/api/authoring/drafts", json=new_doc_payload(client, doc_id="SEM-ARCH-001"))
    assert existing.status_code == 409 and existing.json()["code"] == "document_id_taken"
    assert existing.json()["details"]["field"] == "id"
    first = create_draft(client, doc_id="SEM-NEW-777")
    second = client.post("/api/authoring/drafts", json=new_doc_payload(client, doc_id="sem-new-777"))
    assert second.status_code == 409 and "незавершённым предложением" in second.json()["message"]
    # the suggestion skips IDs held by unfinished proposals
    create_draft(client)  # takes SEM-ARCH-002
    assert templates(client)["architecture"]["suggested_id"] == "SEM-ARCH-003"
    assert first["document_id"] == "SEM-NEW-777"


def test_unsafe_path_and_mismatched_filename_are_errors(client: TestClient) -> None:
    for path, code in (("../outside/SEM-ARCH-002.md", "unsafe_path"), ("other-name.md", "path_id_mismatch")):
        data = check(client, new_doc_payload(client, path=path))
        assert code in {i["code"] for i in data["validation"]}, path


def test_save_draft_with_optimistic_versioning(client: TestClient) -> None:
    draft = create_draft(client)
    payload = new_doc_payload(client, doc_id="SEM-ARCH-010", title="Новое имя")
    saved = client.put(
        f"/api/drafts/{draft['id']}",
        json={
            "expected_version": 1,
            "metadata": payload["metadata"],
            "body": payload["body"],
            "reason": "Причина",
        },
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["edit_version"] == 2 and body["document_id"] == "SEM-ARCH-010"
    assert body["document_path"] == "SEM-ARCH-010.md" and body["document_title"] == "Новое имя"
    stale = client.put(
        f"/api/drafts/{draft['id']}",
        json={"expected_version": 1, "metadata": payload["metadata"], "body": payload["body"]},
    )
    assert stale.status_code == 409 and stale.json()["code"] == "draft_modified"
    history = [e["action"] for e in body["history"]]
    assert history == ["created_new_document", "draft_saved"]


def test_ready_draft_is_no_longer_editable_and_errors_block_review(client: TestClient) -> None:
    broken = create_draft(client, body="коротко")  # body too short, no headings
    assert broken["error_count"] > 0 and not broken["can_mark_ready"]
    assert client.post(f"/api/drafts/{broken['id']}/mark-ready").status_code == 422
    draft = create_draft(client, doc_id="SEM-ARCH-020")
    ready = client.post(f"/api/drafts/{draft['id']}/mark-ready")
    assert ready.status_code == 200 and ready.json()["status"] == "ready_for_review"
    assert not ready.json()["can_edit"]
    payload = new_doc_payload(client, doc_id="SEM-ARCH-020")
    locked = client.put(
        f"/api/drafts/{draft['id']}",
        json={"expected_version": 1, "metadata": payload["metadata"], "body": payload["body"]},
    )
    assert locked.status_code == 409 and locked.json()["code"] == "draft_not_editable"
    assert client.delete(f"/api/drafts/{draft['id']}").status_code == 409


def test_delete_draft(client: TestClient) -> None:
    draft = create_draft(client)
    assert client.delete(f"/api/drafts/{draft['id']}").status_code == 204
    assert client.get(f"/api/drafts/{draft['id']}").status_code == 404
    # the ID is free again
    assert templates(client)["architecture"]["suggested_id"] == "SEM-ARCH-002"


def test_update_proposal_draft_can_be_edited_too(client: TestClient) -> None:
    doc = client.get("/api/documents/SEM-STD-001").json()
    created = client.post(
        "/api/drafts",
        json={
            "document_id": doc["id"],
            "base_revision": doc["revision"],
            "proposed_content": doc["raw"] + "\nПервая правка.\n",
            "reason": "Правка стандарта",
        },
    ).json()
    assert created["operation"] == "update" and created["can_edit"]
    saved = client.put(
        f"/api/drafts/{created['id']}",
        json={"expected_version": 1, "proposed_content": doc["raw"] + "\nВторая правка.\n"},
    )
    assert saved.status_code == 200 and "Вторая правка" in saved.json()["proposed_content"]
    assert saved.json()["base_revision"] == doc["revision"]


def test_ai_draft_follows_template_and_quotes_only_verified_sources(client: TestClient) -> None:
    response = client.post(
        "/api/authoring/ai-draft",
        json={
            "template_id": "adr",
            "title": "Решение о хранении базы знаний",
            "request": "Опиши решение о хранении канонической базы знаний в GitLab",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["mode"] == "mock" and data["access_scope"] == "team"
    for section in TEMPLATE_SECTIONS["adr"]:
        assert f"## {section}" in data["body"]
    assert "Требует уточнения" in data["body"]
    assert data["references"] and all(r["status"] == "approved" for r in data["references"])
    assert data["citations"], "the fixtures contain matching sections (Контекст/Решение/Последствия)"
    for citation in data["citations"]:
        doc = client.get(f"/api/documents/{citation['document_id']}").json()
        assert " ".join(citation["quote"].split()) in " ".join(doc["raw"].split())
        assert citation["revision"] == doc["revision"]
    assert any("Демо-режим" in w for w in data["warnings"])
    assert data["unverified_claims"] == []


def test_ai_draft_admits_insufficient_data(client: TestClient) -> None:
    data = client.post(
        "/api/authoring/ai-draft",
        json={
            "template_id": "integration",
            "title": "Квазизвёздный шлюз",
            "request": "Опиши квазизвёздный шлюз",
        },
    ).json()
    assert data["insufficient_data"] is True and data["citations"] == [] and data["references"] == []
    assert any("Недостаточно данных" in w for w in data["warnings"])
    assert data["body"].count("Требует уточнения") == len(TEMPLATE_SECTIONS["integration"])


def test_ai_draft_cannot_be_approved(client: TestClient) -> None:
    draft = create_draft(client, metadata={"status": "approved"}, origin="ai_suggestion")
    assert "ai_cannot_approve" in {i["code"] for i in draft["validation"]}
    manual = create_draft(client, doc_id="SEM-ARCH-030", metadata={"status": "approved"})
    assert "status_to_approved" in {i["code"] for i in manual["validation"] if i["severity"] == "warning"}


@pytest.mark.parametrize("provider", ["disabled"])
def test_ai_draft_unavailable_when_ai_is_disabled(
    client_factory: Callable[..., TestClient], provider: str
) -> None:
    client = client_factory(ai_provider=provider)
    response = client.post(
        "/api/authoring/ai-draft", json={"template_id": "adr", "title": "Т", "request": "Опиши решение"}
    )
    assert response.status_code == 503 and response.json()["code"] == "ai_authoring_unavailable"
    assert client.get("/api/session").json()["features"]["ai_authoring"] is False


def test_unknown_template(client: TestClient) -> None:
    payload = new_doc_payload(client)
    payload["template_id"] = "nope"
    assert client.post("/api/authoring/drafts", json=payload).status_code == 404
