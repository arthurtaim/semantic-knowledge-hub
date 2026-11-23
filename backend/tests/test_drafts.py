"""Reviewable proposals: diff, no silent writes, review states, conflicts (AC-08..AC-10, AC-13)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.services.proposals import compute_diff

DOC_ID = "SEM-INT-ARIS-001"


def current(client: TestClient, doc_id: str = DOC_ID) -> dict[str, Any]:
    return client.get(f"/api/documents/{doc_id}").json()


def create(client: TestClient, content: str | None = None, **overrides: Any) -> Any:
    doc = current(client)
    proposed = (
        content
        if content is not None
        else doc["raw"].replace("## Questions to resolve", "## Open questions to resolve")
    )
    payload = {
        "document_id": DOC_ID,
        "base_revision": doc["revision"],
        "proposed_content": proposed,
        "reason": "Уточнение формулировки",
    }
    payload.update(overrides)
    return client.post("/api/drafts", json=payload)


def test_create_draft_shows_diff_and_keeps_source(client: TestClient, workspace: Path) -> None:
    source = workspace / f"{DOC_ID}.md"
    before = source.read_bytes()
    response = create(client)
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["status"] == "draft"
    assert draft["diff"]["changed"] is True
    assert draft["additions"] == 1 and draft["deletions"] == 1
    kinds = [line["kind"] for line in draft["diff"]["lines"]]
    assert "add" in kinds and "remove" in kinds and kinds[0] == "hunk"
    assert "+## Open questions to resolve" in draft["diff"]["unified"]
    assert draft["validation"] == []
    assert draft["can_mark_ready"] is True
    assert draft["is_stale"] is False
    assert draft["publication"]["state"] == "disabled"
    assert source.read_bytes() == before  # AC-08: original unchanged
    assert current(client)["revision"] == draft["base_revision"]


def test_reject_keeps_source(client: TestClient, workspace: Path) -> None:
    source = workspace / f"{DOC_ID}.md"
    before = source.read_bytes()
    draft_id = create(client).json()["id"]
    response = client.post(f"/api/drafts/{draft_id}/reject", json={"comment": "Не нужно"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "rejected"
    assert body["review_comment"] == "Не нужно"
    assert body["can_reject"] is False and body["can_mark_ready"] is False
    assert source.read_bytes() == before  # AC-09
    assert client.post(f"/api/drafts/{draft_id}/reject").status_code == 409
    assert client.post(f"/api/drafts/{draft_id}/mark-ready").status_code == 409


def test_mark_ready_changes_status_only(client: TestClient, workspace: Path) -> None:
    source = workspace / f"{DOC_ID}.md"
    before = source.read_bytes()
    draft_id = create(client).json()["id"]
    body = client.post(f"/api/drafts/{draft_id}/mark-ready").json()
    assert body["status"] == "ready_for_review"
    assert source.read_bytes() == before  # AC-10: not approved, not merged
    assert current(client)["status"] == "draft"
    assert [e["action"] for e in body["history"]] == ["created", "marked_ready_for_review"]
    # Still rejectable by a reviewer; not re-markable.
    assert client.post(f"/api/drafts/{draft_id}/mark-ready").status_code == 409
    assert client.post(f"/api/drafts/{draft_id}/reject").json()["status"] == "rejected"


def test_stale_base_revision_on_create(client: TestClient) -> None:
    response = create(client, base_revision="sha256:0000000000000000")
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "revision_conflict"
    assert body["details"]["current_revision"] == current(client)["revision"]


def test_source_change_after_draft_blocks_mark_ready(client: TestClient, workspace: Path) -> None:
    draft_id = create(client).json()["id"]
    source = workspace / f"{DOC_ID}.md"
    source.write_text(source.read_text(encoding="utf-8") + "\nКонкурирующая правка.\n", encoding="utf-8")
    detail = client.get(f"/api/drafts/{draft_id}").json()
    assert detail["is_stale"] is True
    assert detail["can_mark_ready"] is False
    response = client.post(f"/api/drafts/{draft_id}/mark-ready")
    assert response.status_code == 409  # AC-13
    assert response.json()["code"] == "revision_conflict"


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda raw: raw.replace("id: SEM-INT-ARIS-001", "id: SEM-INT-ARIS-999"), "id_changed"),
        (lambda raw: raw.replace("status: draft", "status: shipped"), "invalid_status"),
        (lambda raw: raw.replace("title: ARIS", "title: [ARIS"), "frontmatter_invalid_yaml"),
        (lambda raw: raw + "\napi_key = glpat-abcdefghijklmnopqrstuvwxyz\n", "secret_detected"),
        (lambda raw: raw, "no_changes"),
    ],
)
def test_validation_errors_block_review(client: TestClient, mutate: Any, code: str) -> None:
    raw = current(client)["raw"]
    response = create(client, content=mutate(raw))
    assert response.status_code == 201
    draft = response.json()
    assert code in {i["code"] for i in draft["validation"] if i["severity"] == "error"}
    assert draft["can_mark_ready"] is False
    blocked = client.post(f"/api/drafts/{draft['id']}/mark-ready")
    assert blocked.status_code == 422
    assert blocked.json()["code"] == "validation_failed"


def test_status_change_to_approved_is_a_warning_for_humans(client: TestClient) -> None:
    raw = current(client)["raw"]
    draft = create(client, content=raw.replace("status: draft", "status: approved")).json()
    codes = {i["code"]: i["severity"] for i in draft["validation"]}
    assert codes["status_to_approved"] == "warning"
    assert "error" not in codes.values()
    assert current(client)["status"] == "draft"


def test_ai_origin_cannot_approve(client: TestClient) -> None:
    raw = current(client)["raw"]
    draft = create(
        client, content=raw.replace("status: draft", "status: approved"), origin="ai_suggestion"
    ).json()
    assert "ai_cannot_approve" in {i["code"] for i in draft["validation"]}


def test_unknown_document_and_invalid_ids(client: TestClient) -> None:
    assert create(client, document_id="NOPE-404").status_code == 404
    assert create(client, document_id="../etc/passwd").status_code == 400
    assert client.get("/api/drafts/not-a-uuid").status_code == 404
    assert client.get("/api/drafts/" + "0" * 32).status_code == 404


def test_payload_limits(client: TestClient) -> None:
    assert create(client, content="x" * (512 * 1024 + 1)).status_code == 422
    assert create(client, reason="").status_code == 422
    assert create(client, unexpected="field").status_code == 422


def test_open_mr_is_disabled_by_default(client: TestClient) -> None:
    draft_id = create(client).json()["id"]
    client.post(f"/api/drafts/{draft_id}/mark-ready")
    response = client.post(f"/api/drafts/{draft_id}/open-mr")
    assert response.status_code == 503
    assert response.json()["code"] == "gitlab_proposals_disabled"


def test_ai_suggestion_unavailable_in_mock(client: TestClient) -> None:
    doc = current(client)
    response = client.post(
        "/api/drafts/suggest",
        json={"document_id": DOC_ID, "base_revision": doc["revision"], "instruction": "Сделай понятнее"},
    )
    assert response.status_code == 503
    assert response.json()["code"] == "ai_edit_unsupported"


def test_list_and_filter_drafts(client: TestClient) -> None:
    first = create(client).json()["id"]
    second = create(client).json()["id"]
    client.post(f"/api/drafts/{second}/reject")
    everything = client.get("/api/drafts").json()
    assert everything["total"] == 2
    open_only = client.get("/api/drafts", params={"status": "draft"}).json()["items"]
    assert [d["id"] for d in open_only] == [first]
    by_doc = client.get("/api/drafts", params={"document_id": DOC_ID.lower()}).json()
    assert by_doc["total"] == 2


def test_drafts_persist_across_restart(client_factory: Any) -> None:
    client = client_factory()
    draft_id = create(client).json()["id"]
    restarted = client_factory()
    assert restarted.get(f"/api/drafts/{draft_id}").json()["status"] == "draft"


def test_diff_line_numbers() -> None:
    diff = compute_diff("a\nb\nc\n", "a\nB\nc\nd\n", "x.md")
    adds = [(line.new_no, line.text) for line in diff.lines if line.kind == "add"]
    removes = [(line.old_no, line.text) for line in diff.lines if line.kind == "remove"]
    assert removes == [(2, "b")]
    assert adds == [(2, "B"), (4, "d")]
    assert diff.additions == 2 and diff.deletions == 1
