"""`create` proposals against the stateful GitLab TEST DOUBLE: new file → branch → `create` commit →
one MR → confirmed merge → knowledge sync + FTS. Conflicts and lost answers never create duplicates.
No network; nothing here proves real-GitLab behaviour."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.support.gitlab_env import BASE_URL, Env

NEW_ID = "SEM-ARCH-002"
NEW_PATH = f"docs/{NEW_ID}.md"


def new_document(
    env: Env, doc_id: str = NEW_ID, marker: str = "УникальныйМаркерНовогоДокумента"
) -> dict[str, Any]:
    template = {t["id"]: t for t in env.client.get("/api/authoring/templates").json()}["architecture"]
    response = env.client.post(
        "/api/authoring/drafts",
        json={
            "template_id": "architecture",
            "metadata": {
                "id": doc_id,
                "title": "Новый контур",
                "owner": "semantic-team",
                "status": "approved",
            },
            "body": f"# Новый контур\n\n{marker}\n\n{template['skeleton']}",
            "reason": "Создание документа о новом контуре",
        },
    )
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


def ready(env: Env, proposal_id: str) -> None:
    response = env.client.post(f"/api/drafts/{proposal_id}/mark-ready")
    assert response.status_code == 200, response.text


def merge(env: Env, iid: int) -> None:
    response = TestClient(env.mock, base_url=BASE_URL).post(f"/__mock__/merge-requests/{iid}/merge")
    assert response.status_code == 200, response.text


def test_create_lifecycle_until_knowledge_sync(gitlab: Env) -> None:
    draft = new_document(gitlab)
    assert draft["document_path"] == NEW_PATH and draft["operation"] == "create"
    assert gitlab.client.get("/api/authoring/templates").json()[0]["suggested_path"].startswith("docs/")
    ready(gitlab, draft["id"])
    submitted = gitlab.client.post(f"/api/drafts/{draft['id']}/submit")
    assert submitted.status_code == 200, submitted.text
    body = submitted.json()
    assert body["status"] == "submitted_to_gitlab" and body["source_document_state"] == "new_document"
    # one branch with one `create` commit, one MR; main untouched
    branch = body["branch_name"]
    assert branch.startswith(f"kb/update/{NEW_ID}-")
    head = gitlab.state.commits[gitlab.state.branches[branch]]
    assert NEW_PATH in head.files and "Operation: create" in head.message
    assert NEW_PATH not in gitlab.state.commits[gitlab.state.branches["main"]].files
    assert len(gitlab.state.mrs) == 1 and gitlab.state.mrs[0]["title"].startswith(f"Draft: [новый] {NEW_ID}")
    assert "создание нового документа" in gitlab.state.mrs[0]["description"]
    # not knowledge yet: no document, no search hit
    assert gitlab.client.get(f"/api/documents/{NEW_ID}").status_code == 404
    assert (
        gitlab.client.get("/api/search", params={"q": "УникальныйМаркерНовогоДокумента"}).json()["items"]
        == []
    )
    # a repeated submit is refused (status), and the MR stays single
    assert gitlab.client.post(f"/api/drafts/{draft['id']}/submit").status_code == 409
    merge(gitlab, 1)
    merged = gitlab.client.post(f"/api/drafts/{draft['id']}/refresh-status").json()
    assert merged["status"] == "merged" and merged["source_document_state"] == "updated_by_this_proposal"
    doc = gitlab.client.get(f"/api/documents/{NEW_ID}").json()
    assert doc["source"] == "gitlab" and doc["path"] == NEW_PATH and doc["status"] == "approved"
    assert merged["merged_revision"] == doc["revision"]
    assert doc["revision"] in gitlab.state.mrs[0]["commit_shas"]  # the merged commit, confirmed by GitLab
    hits = gitlab.client.get("/api/search", params={"q": "УникальныйМаркерНовогоДокумента"}).json()["items"]
    assert [h["id"] for h in hits] == [NEW_ID]
    assert [e["action"] for e in merged["history"]][-2:] == ["merged_in_gitlab", "knowledge_synced"]


def test_create_conflict_when_the_path_appears_before_submit(gitlab: Env) -> None:
    draft = new_document(gitlab)
    ready(gitlab, draft["id"])
    # another author adds the same file to main meanwhile
    TestClient(gitlab.mock, base_url=BASE_URL).post(
        "/__mock__/commit", json={"path": NEW_PATH, "content": "---\nid: X\n---\nчужой файл\n"}
    )
    response = gitlab.client.post(f"/api/drafts/{draft['id']}/submit")
    assert response.status_code == 409 and response.json()["code"] == "document_exists"
    detail = gitlab.client.get(f"/api/drafts/{draft['id']}").json()
    assert detail["status"] == "conflict" and detail["proposed_content"] == draft["proposed_content"]
    assert gitlab.state.mrs == [] and list(gitlab.state.branches) == ["main"]
    # the other author's file is untouched
    assert gitlab.state.commits[gitlab.state.branches["main"]].files[NEW_PATH].endswith("чужой файл\n")


def test_create_conflict_detected_at_mark_ready(gitlab: Env) -> None:
    draft = new_document(gitlab)
    TestClient(gitlab.mock, base_url=BASE_URL).post(
        "/__mock__/commit", json={"path": NEW_PATH, "content": "занято"}
    )
    response = gitlab.client.post(f"/api/drafts/{draft['id']}/mark-ready")
    assert response.status_code == 409 and response.json()["code"] == "document_exists"
    assert gitlab.client.get(f"/api/drafts/{draft['id']}").json()["status"] == "conflict"


def test_lost_answer_of_create_commit_is_reconciled_without_duplicates(gitlab: Env) -> None:
    draft = new_document(gitlab)
    ready(gitlab, draft["id"])
    gitlab.fault("POST", "/repository/commits", mode="apply_then_timeout", delay=1.0)
    first = gitlab.client.post(f"/api/drafts/{draft['id']}/submit")
    # the commit was applied but the answer lost: the adapter inspects the branch and continues
    assert first.status_code == 200, first.text
    assert len(gitlab.state.mrs) == 1
    commits_on_branch = [
        c
        for c in gitlab.state.ancestry(gitlab.state.branches[first.json()["branch_name"]])
        if f"Proposal-Id: {draft['id']}" in gitlab.state.commits[c].message
    ]
    assert len(commits_on_branch) == 1


def test_lost_answer_of_mr_creation_then_retry_creates_exactly_one_mr(gitlab: Env) -> None:
    draft = new_document(gitlab)
    ready(gitlab, draft["id"])
    gitlab.fault("POST", "/merge_requests", mode="apply_then_status", status=502)
    first = gitlab.client.post(f"/api/drafts/{draft['id']}/submit")
    assert first.status_code == 200, first.text  # the existing MR is found by branch
    again = gitlab.client.post(f"/api/drafts/{draft['id']}/refresh-status")
    assert again.status_code == 200 and len(gitlab.state.mrs) == 1


def test_unmerged_new_document_never_enters_the_knowledge_base(gitlab: Env) -> None:
    draft = new_document(gitlab)
    ready(gitlab, draft["id"])
    gitlab.client.post(f"/api/drafts/{draft['id']}/submit")
    TestClient(gitlab.mock, base_url=BASE_URL).post("/__mock__/merge-requests/1/close")
    closed = gitlab.client.post(f"/api/drafts/{draft['id']}/refresh-status").json()
    assert closed["status"] == "rejected" and closed["merged_revision"] is None
    assert gitlab.client.get(f"/api/documents/{NEW_ID}").status_code == 404


def test_merge_without_successful_sync_is_not_reported_as_in_the_knowledge_base(gitlab: Env) -> None:
    draft = new_document(gitlab)
    ready(gitlab, draft["id"])
    gitlab.client.post(f"/api/drafts/{draft['id']}/submit")
    merge(gitlab, 1)
    # the knowledge branch cannot be read right after GitLab confirmed the merge
    gitlab.fault("GET", "/repository/branches/main", status=503, times=10)
    merged = gitlab.client.post(f"/api/drafts/{draft['id']}/refresh-status").json()
    assert merged["status"] == "merged" and merged["merged_revision"] is None
    assert merged["source_document_state"] == "merged_pending_sync" and merged["can_refresh_status"]
    gitlab.state.faults.clear()
    synced = gitlab.client.post(f"/api/drafts/{draft['id']}/refresh-status").json()
    assert synced["source_document_state"] == "updated_by_this_proposal" and synced["merged_revision"]
    assert not synced["can_refresh_status"]
