"""M5.6.3 — metadata without YAML: server-owned ID/status/template pin, idempotent creation, import staging."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import make_doc, write_doc

BARE = """# Поток выгрузки справочника регионов

Интеграция переносит справочник регионов из системы-источника в каталог раз в сутки.
Связана с [[SEM-INT-ARIS-001]] и с документом SEM-DOM-001.

## Назначение
Ежедневная загрузка справочника.
"""


def create(client: TestClient, **overrides: Any) -> Any:
    payload: dict[str, Any] = {
        "template_id": "architecture",
        "metadata": {"title": "Документ без YAML", "tags": []},
        "body": "# Документ без YAML\n\n## Контекст\nТекст раздела достаточной длины.\n",
        "reason": "Создать документ из формы",
    }
    payload.update(overrides)
    return client.post("/api/authoring/drafts", json=payload)


def test_create_without_id_owner_or_yaml_allocates_everything_on_the_server(client: TestClient) -> None:
    response = create(client)
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["document_id"].startswith("SEM-ARCH-") and draft["status"] == "draft"
    assert draft["template_id"] == "architecture" and draft["template_version"] == 1
    content = draft["proposed_content"]
    assert content.startswith("---\n") and "owner: unassigned" in content and "status: draft" in content
    assert f"id: {draft['document_id']}" in content and "template: architecture" in content
    codes = {i["code"] for i in draft["validation"]}
    assert "owner_unassigned" in codes
    second = create(client).json()  # another request without an ID: the next free number, never the same
    assert second["document_id"] != draft["document_id"]


def test_repeated_request_with_the_same_key_returns_the_same_draft(client: TestClient) -> None:
    first = create(client, client_request_id="req-abcdef12").json()
    again = create(client, client_request_id="req-abcdef12")
    assert again.status_code == 201 and again.json()["id"] == first["id"]
    assert again.json()["document_id"] == first["document_id"]
    listed = client.get("/api/drafts").json()["items"]
    assert sum(1 for p in listed if p["id"] == first["id"]) == 1


def test_duplicate_title_is_a_warning_and_the_id_is_immutable(client: TestClient) -> None:
    existing = client.get("/api/documents/SEM-ARCH-001").json()["title"]
    draft = create(client, metadata={"title": existing, "owner": "team-a", "tags": []}).json()
    assert "duplicate_title" in {i["code"] for i in draft["validation"]}
    moved = client.put(
        f"/api/drafts/{draft['id']}",
        json={
            "expected_version": 1,
            "metadata": {"id": "SEM-ARCH-777", "title": existing, "owner": "team-a", "tags": []},
            "body": "# Х\n\n## Контекст\nТекст раздела достаточной длины.\n",
        },
    )
    assert moved.status_code == 422 and moved.json()["code"] == "document_id_immutable"


def test_document_types_name_the_server_owned_fields(client: TestClient) -> None:
    types = {t["type"]: t for t in client.get("/api/document-types").json()}
    assert "architecture" in types["architecture"]["templates"]
    assert {"id", "status", "template_version"} <= set(types["integration"]["system_fields"])
    assert "owner" in types["integration"]["human_fields"]


def test_bare_markdown_import_preview_proposes_metadata_and_writes_nothing(client: TestClient) -> None:
    before = client.get("/api/drafts").json()["total"]
    preview = client.post("/api/documents/import/preview", json={"content": BARE, "filename": "regions.md"})
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["state"] == "needs_metadata_review" and not data["has_frontmatter"]
    fields = {f["field"]: f for f in data["fields"]}
    assert fields["id"]["origin"] == "system" and fields["status"]["value"] == "draft"
    assert (
        fields["title"]["value"] == "Поток выгрузки справочника регионов"
        and fields["title"]["origin"] == "parsed"
    )
    assert fields["owner"]["origin"] == "missing" and data["missing"] == ["owner"]
    assert fields["template"]["value"] == "integration" and fields["template"]["origin"] == "suggested"
    assert {"SEM-INT-ARIS-001", "SEM-DOM-001"} <= set(fields["related_ids"]["value"])
    assert data["templates"][0]["template_id"] == "integration" and data["templates"][0]["reasons"]
    assert client.get("/api/drafts").json()["total"] == before  # a preview stores nothing


def test_import_creates_a_draft_that_is_not_in_the_catalog(client: TestClient) -> None:
    preview = client.post("/api/documents/import/preview", json={"content": BARE}).json()
    created = client.post(
        "/api/documents/import",
        json={
            "content": BARE,
            "template_id": "integration",
            "metadata": {
                "title": preview["title"],
                "tags": ["integration"],
                "related_ids": ["SEM-INT-ARIS-001"],
            },
            "reason": "Импорт файла без метаданных",
            "client_request_id": "import-0001",
        },
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    assert draft["origin"] == "import" and draft["status"] == "draft"
    assert (
        draft["document_id"].startswith("SEM-INT-")
        and "related_ids: [SEM-INT-ARIS-001]" in draft["proposed_content"]
    )
    assert client.get(f"/api/documents/{draft['document_id']}").status_code == 404  # not approved knowledge
    assert all(
        i["id"] != draft["document_id"] for i in client.get("/api/documents?query=регионов").json()["items"]
    )


def test_existing_valid_yaml_is_kept_verbatim_and_approved_stays_a_draft(client: TestClient) -> None:
    content = make_doc("SEM-IMP-001", title="Импортированный регламент", status="approved")
    preview = client.post("/api/documents/import/preview", json={"content": content}).json()
    assert preview["state"] == "ready" and preview["document_id"] == "SEM-IMP-001"
    assert preview["keeps_original_metadata"] and {f["origin"] for f in preview["fields"]} == {"existing"}
    assert "imported_approved" in {i["code"] for i in preview["issues"]}
    created = client.post(
        "/api/documents/import",
        json={"content": content, "keep_original_metadata": True, "reason": "Импорт с метаданными"},
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    assert draft["document_id"] == "SEM-IMP-001" and draft["proposed_content"] == content
    assert draft["status"] == "draft" and client.get("/api/documents/SEM-IMP-001").status_code == 404


def test_invalid_yaml_and_id_conflicts_are_reported(client: TestClient) -> None:
    broken = "---\nid: SEM-BAD-001\ntitle: [не закрыт\n---\n\n# Документ\n\nТекст.\n"
    preview = client.post("/api/documents/import/preview", json={"content": broken}).json()
    assert preview["state"] == "invalid_metadata" and preview["issues"][0]["code"].startswith("frontmatter")
    assert {f["field"] for f in preview["fields"]} >= {"id", "title", "owner"}  # generated replacement
    taken = make_doc("SEM-ARCH-001", title="Повтор")
    conflict = client.post("/api/documents/import/preview", json={"content": taken}).json()
    assert conflict["state"] == "conflict"


def test_staged_files_without_metadata_are_listed_and_never_cited(
    client: TestClient, workspace: Path
) -> None:
    write_doc(workspace, "inbox/regions.md", BARE)
    client.post("/api/index/sync")
    staging = client.get("/api/documents/import/staging").json()
    item = next(s for s in staging if s["path"] == "inbox/regions.md")
    assert item["code"] == "frontmatter_missing" and item["readable"]
    preview = client.post("/api/documents/import/preview", json={"path": "inbox/regions.md"}).json()
    assert preview["state"] == "needs_metadata_review" and preview["source_path"] == "inbox/regions.md"
    escape = client.post("/api/documents/import/preview", json={"path": "../outside.md"})
    assert escape.status_code == 404
    answer = client.post(
        "/api/assistant/ask", json={"question": "Как часто выгружают справочник регионов?"}
    ).json()
    assert all("regions" not in c.get("source_uri", "") for c in answer["citations"])
    assert (workspace / "inbox" / "regions.md").read_text(encoding="utf-8") == BARE  # never rewritten


def test_an_oversized_import_is_reported_in_the_preview_and_never_stored(client: TestClient) -> None:
    """Audit SYS-005: the limit is in bytes (max_document_bytes, 512 KB); 300 000 Cyrillic characters ≈ 600 KB fit the
    schema's character limit but not the document limit — the preview says so, the import is refused, nothing stored."""
    big = BARE + "\n" + "Ж" * 300_000 + "\n"
    assert len(big) < 524_288 < len(big.encode("utf-8"))
    preview = client.post("/api/documents/import/preview", json={"content": big})
    assert preview.status_code == 200, preview.text
    issues = {i["code"]: i for i in preview.json()["issues"]}
    assert issues["document_too_large"]["severity"] == "error"
    before = client.get("/api/drafts").json()

    for body in (
        {"content": big, "template_id": "integration", "metadata": {"title": "Большой", "tags": []}},
        {"content": big, "keep_original_metadata": True},
    ):
        refused = client.post("/api/documents/import", json={**body, "reason": "Импорт большого файла"})
        assert refused.status_code == 422, refused.text
        assert refused.json()["code"] == "document_too_large"
    assert client.get("/api/drafts").json() == before


def test_an_import_just_under_the_limit_is_not_flagged(client: TestClient) -> None:
    fits = BARE + "\n" + "Ж" * 200_000 + "\n"  # ≈ 400 KB
    issues = client.post("/api/documents/import/preview", json={"content": fits}).json()["issues"]
    assert "document_too_large" not in {i["code"] for i in issues}
