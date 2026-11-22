"""GitLab as the primary knowledge store: synchronisation, revisions, index updates and the full
proposal lifecycle (branch → commit → MR → merge → knowledge update) against the stateful GitLab
TEST DOUBLE (tests/support/gitlab_mock.py). No network; nothing here proves real-GitLab behaviour."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.gitlab.client import GitLabClient
from app.adapters.gitlab.repository import GitLabKnowledgeRepository
from app.adapters.knowledge.base import RevisionNotAvailableError
from app.domain.models import UserContext
from tests.support.gitlab_env import BASE_URL, DOC, DOC_PATH, Env, MockTransport
from tests.support.gitlab_mock import DEFAULT_TOKEN, PROJECT_ID, GitLabMock, MockState

USER = UserContext(user_id="u", display_name="u")


# --- reading & synchronisation --------------------------------------------------------------------
def test_documents_come_from_gitlab_with_commit_revisions_dates_and_links(gitlab: Env) -> None:
    items = gitlab.client.get("/api/documents", params={"size": 100}).json()["items"]
    assert len(items) == 9 and {i["source"] for i in items} == {"gitlab"}
    assert all(len(i["revision"]) == 40 for i in items)  # commit SHA reported by GitLab, not a local hash
    assert all(i["updated_at"] for i in items)  # commit date of that revision
    doc = gitlab.doc()
    assert doc["web_url"] == f"{BASE_URL}/skh-test/knowledge-base-MOCK/-/blob/{doc['revision']}/{DOC_PATH}"
    assert doc["path"] == DOC_PATH and doc["index_state"] == "current"
    assert gitlab.requests("GET", "/repository/tree") > 1  # paginated walk
    assert not any("README.md" in p for _, p in gitlab.state.requests if "/files/" in p)  # outside docs/


def test_unchanged_head_skips_the_tree_walk(gitlab: Env) -> None:
    gitlab.client.get("/api/documents")
    trees = gitlab.requests("GET", "/repository/tree")
    gitlab.client.get("/api/documents")
    assert gitlab.requests("GET", "/repository/tree") == trees


def test_changed_document_is_reread_and_reindexed_alone(gitlab: Env) -> None:
    before = gitlab.doc()
    reads = gitlab.requests("GET", "/repository/files/")
    gitlab.mock.state.commit_on(
        "main", "Edit by another author", {DOC_PATH: before["raw"] + "\nУникальныйМаркерСинхронизации\n"}
    )
    after = gitlab.doc()
    assert after["revision"] != before["revision"]
    assert gitlab.requests("GET", "/repository/files/") - reads == 1  # only the changed file
    hits = gitlab.client.get("/api/search", params={"q": "УникальныйМаркерСинхронизации"}).json()["items"]
    assert [h["id"] for h in hits] == [DOC] and hits[0]["revision"] == after["revision"]


def test_deleted_document_disappears_from_catalog_and_index(gitlab: Env) -> None:
    assert gitlab.client.get("/api/search", params={"q": "ARIS"}).json()["items"]
    gitlab.mock.state.commit_on("main", "Remove ARIS doc", {"docs/SEM-INT-ARIS-001.md": None})
    assert gitlab.client.get("/api/documents/SEM-INT-ARIS-001").status_code == 404
    ids = [h["id"] for h in gitlab.client.get("/api/search", params={"q": "ARIS"}).json()["items"]]
    assert "SEM-INT-ARIS-001" not in ids


def test_specific_revision_is_read_from_gitlab_history() -> None:
    mock = GitLabMock(MockState(base_url=BASE_URL))
    client = GitLabClient(
        base_url=BASE_URL,
        project_id=PROJECT_ID,
        token=SecretStr(DEFAULT_TOKEN),
        transport=MockTransport(mock, timeout=1),
    )
    repo = GitLabKnowledgeRepository(
        client, project_id=PROJECT_ID, branch="main", knowledge_path="docs", refresh_seconds=0
    )
    old = asyncio.run(repo.get_document(DOC, USER))
    mock.state.commit_on("main", "edit", {DOC_PATH: old.raw + "\nНовая строка\n"})
    current = asyncio.run(repo.get_document(DOC, USER))
    assert current.revision != old.revision and "Новая строка" in current.raw
    historic = asyncio.run(repo.get_document_at_revision(DOC, old.revision, USER))
    assert historic.revision == old.revision and "Новая строка" not in historic.raw
    with pytest.raises(RevisionNotAvailableError):
        asyncio.run(repo.get_document_at_revision(DOC, "0" * 40, USER))
    with pytest.raises(RevisionNotAvailableError):
        asyncio.run(repo.get_document_at_revision(DOC, "main", USER))  # refs are not revisions


def test_partial_sync_failure_keeps_last_version_and_flags_it(gitlab: Env) -> None:
    before = gitlab.doc()
    gitlab.mock.state.commit_on("main", "edit", {DOC_PATH: before["raw"] + "\nСвежая правка\n"})
    gitlab.fault("GET", f"/repository/files/{DOC_PATH}", status=500, times=10)
    stale = gitlab.doc()
    assert stale["revision"] == before["revision"] and stale["index_state"] == "stale"
    status = gitlab.client.get("/api/index/status").json()
    assert status["state"] == "stale" and status["failed_paths"] == [DOC_PATH]
    issues = gitlab.client.get("/api/knowledge/issues").json()
    assert any(i["code"] == "sync_failed" and i["path"] == DOC_PATH for i in issues)
    gitlab.state.faults.clear()
    fresh = gitlab.client.post("/api/index/sync").json()
    assert fresh["state"] == "fresh" and fresh["failed_paths"] == []
    assert "Свежая правка" in gitlab.doc()["raw"]


def test_outage_serves_last_snapshot_marked_stale(gitlab: Env) -> None:
    gitlab.client.get("/api/documents")
    gitlab.fault("GET", "/repository/branches/main", status=503, times=50)
    items = gitlab.client.get("/api/documents").json()["items"]
    assert items and all(i["index_state"] == "stale" for i in items)
    status = gitlab.client.get("/api/index/status").json()
    assert status["state"] == "stale" and "недоступен" in status["message"]


def test_revoked_access_drops_cached_documents(gitlab: Env) -> None:
    assert gitlab.client.get("/api/documents").status_code == 200
    gitlab.state.token = "rotated-elsewhere"  # the app's token no longer works
    response = gitlab.client.get("/api/documents")
    assert response.status_code == 503 and response.json()["code"] == "gitlab_auth_failed"
    assert gitlab.client.get("/api/index/status").json()["state"] == "error"


def test_manual_sync_requires_the_client_header(gitlab: Env) -> None:
    raw = TestClient(gitlab.client.app, base_url="http://localhost")
    assert raw.post("/api/index/sync").status_code == 403  # CSRF guard
    assert gitlab.client.post("/api/index/sync").status_code == 200


# --- proposal lifecycle ---------------------------------------------------------------------------
def test_full_lifecycle_branch_commit_mr_merge_and_knowledge_update(gitlab: Env) -> None:
    base = gitlab.doc()
    proposal = gitlab.new_proposal(marker="МаркерПослеMerge")
    assert proposal["status"] == "draft" and proposal["source_document_state"] == "unchanged"
    assert proposal["branch_name"] == f"kb/update/{DOC}-{proposal['id'][:8]}"
    assert gitlab.doc()["revision"] == base["revision"]  # creating a proposal changes nothing
    assert gitlab.requests("POST", "/repository/") == 0
    gitlab.ready(proposal["id"])
    main_before = gitlab.state.branches["main"]
    submitted = gitlab.submit(proposal["id"])
    assert submitted.status_code == 200, submitted.text
    body = submitted.json()
    assert body["status"] == "submitted_to_gitlab"
    mr = body["merge_request"]
    assert mr["state"] == "opened" and mr["url"].startswith(f"{BASE_URL}/")
    assert mr["source_branch"] == proposal["branch_name"] and mr["target_branch"] == "main"
    # MR description: document, reason, base revision, link to the proposal
    description = gitlab.state.mrs[0]["description"]
    for expected in (DOC, DOC_PATH, base["revision"], "Уточнение раздела", f"/proposals/{proposal['id']}"):
        assert expected in description
    # the knowledge branch is untouched until a reviewer merges
    assert gitlab.state.branches["main"] == main_before
    assert "МаркерПослеMerge" not in gitlab.doc()["raw"]
    assert body["source_document_state"] == "unchanged"
    # MR state is read from GitLab; nothing is assumed
    checked = gitlab.client.post(f"/api/drafts/{proposal['id']}/refresh-status").json()
    assert checked["status"] == "submitted_to_gitlab" and checked["merge_request"]["state"] == "opened"
    _merge(gitlab, 1)
    merged = gitlab.client.post(f"/api/drafts/{proposal['id']}/refresh-status").json()
    assert merged["status"] == "merged" and merged["merge_request"]["state"] == "merged"
    assert merged["source_document_state"] == "updated_by_this_proposal"
    updated = gitlab.doc()
    assert "МаркерПослеMerge" in updated["raw"] and updated["revision"] != base["revision"]
    hits = gitlab.client.get("/api/search", params={"q": "МаркерПослеMerge"}).json()["items"]
    assert [h["id"] for h in hits] == [DOC]
    actions = [e["action"] for e in merged["history"]]
    assert actions == [
        "created",
        "marked_ready_for_review",
        "submission_started",
        "merge_request_opened",
        "merge_request_checked",
        "merged_in_gitlab",
        "knowledge_synced",
    ]
    assert merged["merged_revision"] == updated["revision"] and merged["synced_at"]


def _merge(env: Env, iid: int) -> None:
    response = TestClient(env.mock, base_url=BASE_URL).post(f"/__mock__/merge-requests/{iid}/merge")
    assert response.status_code == 200, response.text


def test_resubmission_never_creates_a_second_mr(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    assert gitlab.submit(proposal["id"]).status_code == 200
    again = gitlab.submit(proposal["id"])
    assert again.status_code == 409 and again.json()["code"] == "invalid_transition"
    assert len(gitlab.state.mrs) == 1 and gitlab.requests("POST", "/merge_requests") == 1


def test_commit_applied_but_answer_lost_is_detected_not_repeated(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.fault("POST", "/repository/commits", mode="apply_then_timeout", delay=2)
    response = gitlab.submit(proposal["id"])
    assert response.status_code == 200, response.text  # branch inspected: our commit is there
    assert gitlab.requests("POST", "/repository/commits") == 1
    assert len(gitlab.state.mrs) == 1


def test_commit_timeout_without_write_fails_safely_and_retry_succeeds(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.fault("POST", "/repository/commits", mode="timeout", delay=2)
    failed = gitlab.submit(proposal["id"])
    assert failed.status_code == 502 and failed.json()["code"] == "gitlab_timeout"
    assert failed.json()["details"]["proposal_preserved"] == "true"
    detail = gitlab.detail(proposal["id"])
    assert detail["status"] == "submission_failed" and detail["submission"]["uncertain"] is False
    assert detail["proposed_content"] == proposal["proposed_content"]  # nothing lost locally
    assert detail["can_submit"] is True and gitlab.state.mrs == []
    retried = gitlab.submit(proposal["id"])
    assert retried.status_code == 200, retried.text
    assert retried.json()["submission"]["attempts"] == 2
    branch = proposal["branch_name"]
    ours = [
        c
        for c in gitlab.state.ancestry(gitlab.state.branches[branch])
        if proposal["id"] in gitlab.state.commits[c].message
    ]
    assert len(ours) == 1 and len(gitlab.state.mrs) == 1


def test_mr_created_but_answer_lost_is_adopted(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.fault("POST", "/merge_requests", mode="apply_then_status", status=502)
    response = gitlab.submit(proposal["id"])
    assert response.status_code == 200, response.text
    assert response.json()["merge_request"]["iid"] == "1" and len(gitlab.state.mrs) == 1
    assert [e["action"] for e in response.json()["history"]][-1] == "merge_request_found"


def test_uncertain_mr_outcome_blocks_reject_until_checked(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.fault("POST", "/merge_requests", mode="timeout", delay=2)
    # the idempotency lookup before the POST works; the follow-up lookup after it fails too
    gitlab.fault("GET", "/merge_requests", status=503, times=3, skip=1)
    failed = gitlab.submit(proposal["id"])
    assert failed.status_code == 502 and failed.json()["code"] == "gitlab_write_uncertain"
    detail = gitlab.detail(proposal["id"])
    assert detail["submission"]["uncertain"] is True and detail["can_reject"] is False
    assert detail["can_refresh_status"] is True
    assert gitlab.client.post(f"/api/drafts/{proposal['id']}/reject").json()["code"] == "submission_uncertain"
    checked = gitlab.client.post(f"/api/drafts/{proposal['id']}/refresh-status").json()
    assert checked["status"] == "submission_failed" and checked["submission"]["uncertain"] is False
    assert gitlab.submit(proposal["id"]).status_code == 200
    assert len(gitlab.state.mrs) == 1


def test_source_changed_after_proposal_is_a_conflict_without_writes(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    current = gitlab.doc()
    gitlab.mock.state.commit_on("main", "Concurrent edit", {DOC_PATH: current["raw"] + "\nЧужая правка\n"})
    response = gitlab.submit(proposal["id"])
    assert response.status_code == 409 and response.json()["code"] == "revision_conflict"
    detail = gitlab.detail(proposal["id"])
    assert detail["status"] == "conflict" and detail["source_document_state"] == "changed_since_base"
    assert detail["proposed_content"] == proposal["proposed_content"]
    assert proposal["branch_name"] not in gitlab.state.branches and gitlab.state.mrs == []
    assert "Чужая правка" in gitlab.doc()["raw"]  # the other author's change is intact


def test_conflict_detected_when_marking_ready(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    current = gitlab.doc()
    gitlab.mock.state.commit_on("main", "Concurrent edit", {DOC_PATH: current["raw"] + "\nЧужая правка\n"})
    response = gitlab.client.post(f"/api/drafts/{proposal['id']}/mark-ready")
    assert response.status_code == 409
    assert gitlab.detail(proposal["id"])["status"] == "conflict"


def test_gitlab_rejects_stale_commit_even_after_our_check(
    gitlab: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Race: the file changes between our revision check and the commit — GitLab's last_commit_id
    precondition refuses the write and the proposal becomes a conflict."""
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    original = GitLabKnowledgeRepository.current_file_revision
    calls = {"n": 0}

    async def racing(self: GitLabKnowledgeRepository, path: str) -> str | None:
        calls["n"] += 1
        revision = await original(self, path)
        if calls["n"] == 2:  # right after the publisher's own check, someone pushes to main
            head = gitlab.state.commits[gitlab.state.branches["main"]]
            gitlab.state.commit_on("main", "race", {DOC_PATH: head.files[DOC_PATH] + "\nrace\n"})
        return revision

    monkeypatch.setattr(GitLabKnowledgeRepository, "current_file_revision", racing)
    response = gitlab.submit(proposal["id"])
    assert response.status_code == 409, response.text
    assert gitlab.detail(proposal["id"])["status"] == "conflict" and gitlab.state.mrs == []


def test_permission_error_is_reported_and_proposal_kept(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.fault("POST", "/repository/branches", status=403)
    response = gitlab.submit(proposal["id"])
    assert response.status_code == 503 and response.json()["code"] == "gitlab_forbidden"
    detail = gitlab.detail(proposal["id"])
    assert (
        detail["status"] == "submission_failed" and detail["submission"]["error_code"] == "gitlab_forbidden"
    )
    assert detail["can_reject"] is True  # a definite failure: nothing was written


def test_foreign_branch_with_the_same_name_is_never_overwritten(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    state = gitlab.state
    state.branches[proposal["branch_name"]] = state.branches["main"]
    state.commit_on(proposal["branch_name"], "Someone else's work", {"docs/SEM-GLOSS-001.md": "foreign"})
    head_before = state.branches[proposal["branch_name"]]
    response = gitlab.submit(proposal["id"])
    assert response.status_code == 409 and response.json()["code"] == "gitlab_branch_conflict"
    assert state.branches[proposal["branch_name"]] == head_before and state.mrs == []


def test_mr_closed_in_gitlab_marks_proposal_rejected(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.submit(proposal["id"])
    TestClient(gitlab.mock, base_url=BASE_URL).post("/__mock__/merge-requests/1/close")
    checked = gitlab.client.post(f"/api/drafts/{proposal['id']}/refresh-status").json()
    assert checked["status"] == "rejected" and checked["merge_request"]["state"] == "closed"
    assert "без merge" in checked["review_comment"]
    assert gitlab.submit(proposal["id"]).status_code == 409  # closed is a decision, not re-opened


def test_every_write_targets_a_review_branch(gitlab: Env) -> None:
    proposal = gitlab.new_proposal()
    gitlab.ready(proposal["id"])
    gitlab.submit(proposal["id"])
    commits = [c for c in gitlab.state.commits.values() if proposal["id"] in c.message]
    assert commits and all(gitlab.state.branches["main"] not in [c.id] for c in commits)
    main_history = gitlab.state.ancestry(gitlab.state.branches["main"])
    assert all(c.id not in main_history for c in commits)
