"""M5 publication against the stateful GitLab and Confluence Data Center TEST DOUBLES (in-process, no
network): merged + synced document → durable job → read-only dry-run → create → update → idempotency
→ manual-edit conflict → auth/outage/lost-answer handling → restart. Nothing here proves real-DC
behaviour; see docs/M4_M5_INTEGRATION_READINESS.md for the live-validation items."""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters.confluence_rest.client import ConfluenceDCClient
from tests.support.confluence_mock import (
    DEFAULT_TOKEN as CONF_TOKEN,
)
from tests.support.confluence_mock import (
    FOREIGN_PAGE_ID,
    PARENT_PAGE_ID,
    TEST_SPACE,
    ConfluenceFault,
    ConfluenceMock,
    ConfluenceMockState,
)
from tests.support.gitlab_env import BASE_URL, GITLAB_SETTINGS, Env, patch_gitlab_transport
from tests.support.gitlab_mock import GitLabMock, MockState

CONF_URL = "https://confluence.mock.example/confluence"
NEW_ID = "SEM-ARCH-002"
PUBLISH_SETTINGS: dict[str, Any] = {
    **GITLAB_SETTINGS,
    "mock_service_hosts": "gitlab.mock.example,confluence.mock.example",
    "confluence_rest_url": CONF_URL,
    "confluence_rest_token": CONF_TOKEN,
    "confluence_target_space": TEST_SPACE,
    "confluence_parent_page_id": PARENT_PAGE_ID,
    "confluence_publish_enabled": True,
}


class AsgiWithTimeout(httpx.AsyncBaseTransport):
    def __init__(self, app: ConfluenceMock, timeout: float) -> None:
        self._inner = httpx.ASGITransport(app=app)
        self._timeout = timeout

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await asyncio.wait_for(self._inner.handle_async_request(request), self._timeout)
        except TimeoutError as exc:
            raise httpx.ReadTimeout("simulated client timeout", request=request) from exc


@dataclass
class PubEnv:
    gitlab: Env
    confluence: ConfluenceMock
    factory: Callable[..., TestClient]

    @property
    def client(self) -> TestClient:
        return self.gitlab.client

    @property
    def pages(self) -> dict[str, dict[str, Any]]:
        return self.confluence.state.pages

    def writes(self) -> int:
        return self.confluence.state.write_count()

    def fault(self, method: str, path_contains: str, **kwargs: Any) -> None:
        self.confluence.state.faults.append(
            ConfluenceFault(method=method, path_contains=path_contains, **kwargs)
        )

    def restart(self, **overrides: Any) -> TestClient:
        client = self.factory(**{**PUBLISH_SETTINGS, **overrides})
        self.gitlab.client = client
        return client

    # --- helpers that drive the whole workflow through the API -----------------------------------
    def merged_document(
        self, doc_id: str = NEW_ID, title: str = "Новый контур публикации", body_extra: str = ""
    ) -> dict[str, Any]:
        template = {t["id"]: t for t in self.client.get("/api/authoring/templates").json()}["architecture"]
        created = self.client.post(
            "/api/authoring/drafts",
            json={
                "template_id": "architecture",
                "metadata": {"id": doc_id, "title": title, "owner": "semantic-team", "status": "approved"},
                "body": f"# {title}\n\nТекст для публикации. **Важно** и *курсив*.{body_extra}\n\n{template['skeleton']}",
                "reason": "Новый документ для публикации",
            },
        )
        assert created.status_code == 201, created.text
        return self.merge_proposal(created.json()["id"])

    def merge_proposal(self, proposal_id: str) -> dict[str, Any]:
        assert self.client.post(f"/api/drafts/{proposal_id}/mark-ready").status_code == 200
        submitted = self.client.post(f"/api/drafts/{proposal_id}/submit")
        assert submitted.status_code == 200, submitted.text
        iid = submitted.json()["merge_request"]["iid"]
        merged = TestClient(self.gitlab.mock, base_url=BASE_URL).post(f"/__mock__/merge-requests/{iid}/merge")
        assert merged.status_code == 200, merged.text
        detail = self.client.post(f"/api/drafts/{proposal_id}/refresh-status").json()
        assert detail["status"] == "merged" and detail["merged_revision"], detail
        return detail

    def update_document(self, doc_id: str, extra: str) -> dict[str, Any]:
        doc = self.client.get(f"/api/documents/{doc_id}").json()
        created = self.client.post(
            "/api/drafts",
            json={
                "document_id": doc_id,
                "base_revision": doc["revision"],
                "proposed_content": doc["raw"].rstrip("\n") + f"\n\n{extra}\n",
                "reason": "Утверждённое изменение для публикации",
            },
        )
        assert created.status_code == 201, created.text
        return self.merge_proposal(created.json()["id"])

    def status(self, doc_id: str = NEW_ID) -> dict[str, Any]:
        data: dict[str, Any] = self.client.get(f"/api/documents/{doc_id}/publication").json()
        return data

    def latest_job(self, doc_id: str = NEW_ID) -> dict[str, Any]:
        job_id = self.status(doc_id)["latest_job"]["id"]
        data: dict[str, Any] = self.client.get(f"/api/publications/jobs/{job_id}").json()
        return data

    def publish(self, job_id: str) -> httpx.Response:
        return self.client.post(f"/api/publications/jobs/{job_id}/publish")


@pytest.fixture
def pub(client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch) -> Iterator[PubEnv]:
    gitlab_mock = GitLabMock(MockState(base_url=BASE_URL))
    patch_gitlab_transport(monkeypatch, gitlab_mock)
    confluence = ConfluenceMock(ConfluenceMockState(base_url=CONF_URL))
    original = ConfluenceDCClient.__init__

    def patched(self: ConfluenceDCClient, **kwargs: Any) -> None:
        kwargs["transport"] = AsgiWithTimeout(confluence, timeout=0.3)

        async def no_sleep(_: float) -> None:
            return None

        kwargs["sleep"] = no_sleep
        original(self, **kwargs)

    monkeypatch.setattr(ConfluenceDCClient, "__init__", patched)
    client = client_factory(**PUBLISH_SETTINGS)
    env = PubEnv(Env(client, gitlab_mock), confluence, client_factory)
    yield env
    assert gitlab_mock.state.protected_write_attempts == 0


# --- E2E-23/24/25: merged document → job → read-only dry-run → one new page -------------------------
def test_merge_creates_durable_job_with_read_only_dry_run_then_one_page(pub: PubEnv) -> None:
    pages_before = len(pub.pages)
    pub.merged_document()
    status = pub.status()
    assert status["publisher"]["mode"] == "write" and status["publisher"]["target_kind"] == "mock"
    assert status["state"] == "dry_run_ready" and status["mapping"] is None
    job = pub.latest_job()
    plan = job["plan"]
    assert job["state"] == "dry_run_ready" and job["can_publish"]
    assert plan["action"] == "create" and plan["diff_kind"] == "new_page"
    assert plan["target"] == {
        "space_key": TEST_SPACE,
        "parent_id": PARENT_PAGE_ID,
        "page_id": None,
        "title": "Новый контур публикации",
        "url": None,
    }
    assert plan["merge_request"]["iid"] == "1" and plan["problems"] == []
    assert "<strong>Важно</strong>" in plan["storage"] and "<em>курсив</em>" in plan["storage"]
    assert pub.writes() == 0, "a dry-run must not send any write request"
    assert all(m == "GET" for m, _ in pub.confluence.state.requests)

    published = pub.publish(job["id"])
    assert published.status_code == 200, published.text
    body = published.json()
    assert body["state"] == "published" and body["action"] == "create" and body["version_after"] == 1
    assert len(pub.pages) == pages_before + 1
    page = pub.pages[body["page_id"]]
    assert page["parent"] == PARENT_PAGE_ID and page["space"] == TEST_SPACE
    assert page["properties"]["skh-managed-document"]["value"]["document_id"] == NEW_ID
    status = pub.status()
    assert status["state"] == "published" and status["mapping"]["page_id"] == body["page_id"]
    assert status["mapping"]["published_revision"] == status["current_revision"]
    assert status["mapping"]["url"].endswith(f"pageId={body['page_id']}")


# --- E2E-26/27: an approved change updates the same page; repeating changes nothing ---------------------
def test_next_change_updates_same_page_and_repeat_is_idempotent(pub: PubEnv) -> None:
    pub.merged_document()
    first = pub.publish(pub.latest_job()["id"]).json()
    pub.update_document(NEW_ID, "Добавленный абзац второй ревизии.")
    status = pub.status()
    assert status["state"] == "dry_run_ready"  # a new job for the new revision, prepared automatically
    job = pub.latest_job()
    assert job["plan"]["action"] == "update" and "Добавленный абзац второй ревизии." in job["plan"]["diff"]
    second = pub.publish(job["id"]).json()
    assert second["page_id"] == first["page_id"] and second["version_after"] == 2
    assert pub.pages[first["page_id"]]["version"] == 2
    writes = pub.writes()
    # repeat for the same revision: noop, no new version, no write
    again = pub.client.post(f"/api/documents/{NEW_ID}/publication/prepare").json()
    assert again["plan"]["action"] == "noop" and again["plan"]["diff_kind"] == "none"
    noop = pub.publish(again["id"]).json()
    assert noop["state"] == "published" and noop["action"] == "noop"
    assert pub.pages[first["page_id"]]["version"] == 2 and pub.writes() == writes
    pages = [p for p in pub.pages.values() if p["title"] == "Новый контур публикации"]
    assert len(pages) == 1


# --- E2E-28: manual edit in Confluence → conflict, nothing overwritten -----------------------------------
def test_manual_edit_is_a_conflict_and_never_overwritten(pub: PubEnv) -> None:
    pub.merged_document()
    page_id = pub.publish(pub.latest_job()["id"]).json()["page_id"]
    TestClient(pub.confluence).post(f"/__mock__/pages/{page_id}/edit", json={})
    pub.update_document(NEW_ID, "Изменение после ручной правки.")
    job = pub.latest_job()
    assert job["state"] == "conflict" and job["plan"]["diff_kind"] == "manual_edit"
    assert "Ручная правка" in job["plan"]["diff"] and not job["can_publish"]
    assert pub.status()["state"] == "conflict"
    assert pub.publish(job["id"]).status_code == 409
    assert pub.pages[page_id]["version"] == 2 and "Ручная правка" in pub.pages[page_id]["storage"]
    # explicit human decision: acknowledge, review the overwrite diff, then publish
    acknowledged = pub.client.post(f"/api/publications/jobs/{job['id']}/acknowledge-manual-edit").json()
    assert acknowledged["state"] == "dry_run_ready" and acknowledged["plan"]["action"] == "update"
    assert "Ручная правка" in acknowledged["plan"]["diff"]  # what would be replaced is shown
    done = pub.publish(job["id"]).json()
    assert done["state"] == "published" and pub.pages[page_id]["version"] == 3


# --- E2E-29: auth errors keep a consistent state ------------------------------------------------------
def test_forbidden_write_fails_clearly_and_keeps_gitlab_merge(pub: PubEnv) -> None:
    merged = pub.merged_document()
    job = pub.latest_job()
    pub.fault("POST", "/rest/api/content", status=403)
    failed = pub.publish(job["id"]).json()
    assert failed["state"] == "failed" and failed["error_code"] == "confluence_forbidden"
    assert "403" in failed["error_message"] and failed["can_reconcile"]
    assert pub.status()["mapping"] is None
    assert pub.client.get(f"/api/drafts/{merged['id']}").json()["status"] == "merged"
    assert pub.client.get(f"/api/documents/{NEW_ID}").status_code == 200
    retried = pub.client.post(f"/api/publications/jobs/{job['id']}/reconcile").json()
    assert retried["state"] == "dry_run_ready"
    assert pub.publish(job["id"]).json()["state"] == "published"


def test_rejected_token_during_dry_run_is_reported(pub: PubEnv) -> None:
    pub.merged_document()
    pub.confluence.state.token = "rotated-elsewhere"
    response = pub.client.post(f"/api/documents/{NEW_ID}/publication/prepare")
    assert response.status_code == 503 and response.json()["code"] == "confluence_auth_failed"
    assert pub.latest_job()["state"] == "pending"  # the job persists; nothing written


# --- E2E-30: Confluence unavailable → job persists, merge intact --------------------------------------
def test_unavailable_confluence_keeps_job_and_merge(pub: PubEnv) -> None:
    merged = pub.merged_document()
    job = pub.latest_job()
    pub.fault("POST", "/rest/api/content", status=503)
    result = pub.publish(job["id"]).json()
    # 5xx after a write is uncertain: Confluence was inspected, no page found → safe failure
    assert result["state"] == "failed" and "можно повторить" in result["error_message"]
    assert pub.client.get(f"/api/drafts/{merged['id']}").json()["status"] == "merged"
    assert [p for p in pub.pages.values() if p["title"] == "Новый контур публикации"] == []


# --- E2E-31: timeout after a successful write → reconciliation, no blind retry, no duplicate -----------
def test_lost_answer_after_create_is_reconciled_without_duplicate(pub: PubEnv) -> None:
    pub.merged_document()
    job = pub.latest_job()
    pub.fault("POST", "/rest/api/content", mode="apply_then_timeout", delay=1.0)
    result = pub.publish(job["id"]).json()
    assert result["state"] == "published" and result["action"] == "create"
    assert [e["action"] for e in result["history"]][-2:] == [
        "write_confirmed_after_lost_answer",
        "published_create",
    ]
    assert len([p for p in pub.pages.values() if p["title"] == "Новый контур публикации"]) == 1
    posts = [r for r in pub.confluence.state.requests if r == ("POST", "/rest/api/content")]
    assert len(posts) == 1


def test_lost_answer_with_failed_inspection_becomes_result_unknown(pub: PubEnv) -> None:
    pub.merged_document()
    page_id = pub.publish(pub.latest_job()["id"]).json()["page_id"]
    pub.update_document(NEW_ID, "Третья ревизия.")
    job = pub.latest_job()
    pub.fault("PUT", f"/rest/api/content/{page_id}", mode="apply_then_timeout", delay=1.0)
    pub.fault("GET", f"/rest/api/content/{page_id}", status=503, times=3, skip=2)  # inspection fails
    unknown = pub.publish(job["id"]).json()
    assert unknown["state"] == "result_unknown" and unknown["uncertain"] and not unknown["can_publish"]
    assert pub.publish(job["id"]).status_code == 409  # no blind retry
    assert pub.client.post(f"/api/documents/{NEW_ID}/publication/prepare").status_code == 409
    checked = pub.client.post(f"/api/publications/jobs/{job['id']}/reconcile").json()
    assert checked["state"] == "published" and pub.pages[page_id]["version"] == 2


# --- E2E-32: restart keeps jobs and mappings; an interrupted write is inspected, not repeated ----------
def test_restart_keeps_jobs_mapping_and_flags_interrupted_writes(pub: PubEnv, tmp_path: Path) -> None:
    pub.merged_document()
    first = pub.publish(pub.latest_job()["id"]).json()
    pub.update_document(NEW_ID, "Ревизия перед перезапуском.")
    job = pub.latest_job()
    with sqlite3.connect(tmp_path / "workspace" / "publications.sqlite3") as db:
        db.execute("UPDATE publication_jobs SET state = 'publishing' WHERE id = ?", (job["id"],))
    restarted = pub.restart()
    status = restarted.get(f"/api/documents/{NEW_ID}/publication").json()
    assert status["mapping"]["page_id"] == first["page_id"]
    recovered = restarted.get(f"/api/publications/jobs/{job['id']}").json()
    assert recovered["state"] == "result_unknown" and recovered["error_code"] == "interrupted"
    checked = restarted.post(f"/api/publications/jobs/{job['id']}/reconcile").json()
    assert checked["state"] == "dry_run_ready" and checked["plan"]["action"] == "update"


# --- E2E-33: a revision without a merged MR is never published ----------------------------------------
def test_unmerged_revision_cannot_be_published(pub: PubEnv) -> None:
    # fixtures were committed directly in the initial (mock) commit: no merged MR proves them
    job = pub.client.post("/api/documents/SEM-ARCH-001/publication/prepare").json()
    assert job["state"] == "failed" and job["error_code"] == "not_merged" and not job["can_publish"]
    assert pub.publish(job["id"]).status_code == 409
    assert pub.writes() == 0


def test_not_publishable_status(pub: PubEnv) -> None:
    template = {t["id"]: t for t in pub.client.get("/api/authoring/templates").json()}["architecture"]
    created = pub.client.post(
        "/api/authoring/drafts",
        json={
            "template_id": "architecture",
            "metadata": {"id": "SEM-ARCH-050", "title": "Черновой документ", "owner": "t", "status": "draft"},
            "body": f"# Черновой документ\n\n{template['skeleton']}",
            "reason": "Черновик",
        },
    ).json()
    pub.merge_proposal(created["id"])
    job = pub.latest_job("SEM-ARCH-050")
    assert job["state"] == "failed" and job["error_code"] == "status_not_publishable"


# --- E2E-34: writes are off unless explicitly enabled for a mock/staging target -------------------------
def test_write_disabled_by_default_allows_only_dry_run(pub: PubEnv) -> None:
    client = pub.restart(confluence_publish_enabled=False)
    pub.merged_document()
    status = client.get(f"/api/documents/{NEW_ID}/publication").json()
    assert status["publisher"]["mode"] == "dry_run_only"
    job = pub.latest_job()
    assert job["state"] == "dry_run_ready" and not job["can_publish"] and job["publish_disabled_reason"]
    response = pub.publish(job["id"])
    assert response.status_code == 503 and response.json()["code"] == "publish_disabled"
    assert pub.writes() == 0
    integrations = {i["name"]: i for i in client.get("/api/integrations/status").json()["items"]}
    assert "create_page" not in integrations["confluence_publisher"]["capabilities"]


# --- E2E-36: an unknown/foreign page is never overwritten ----------------------------------------------
def test_page_with_same_title_but_no_marker_is_a_conflict(pub: PubEnv) -> None:
    pub.merged_document(doc_id="SEM-ARCH-060", title="Чужая страница (MOCK)")
    job = pub.latest_job("SEM-ARCH-060")
    assert job["state"] == "conflict" and job["error_code"] == "title_taken"
    assert pub.pages[FOREIGN_PAGE_ID]["version"] == 1 and pub.writes() == 0


def test_tampered_mapping_to_a_foreign_page_is_refused(pub: PubEnv, tmp_path: Path) -> None:
    pub.merged_document()
    pub.publish(pub.latest_job()["id"])
    with sqlite3.connect(tmp_path / "workspace" / "publications.sqlite3") as db:
        db.execute("UPDATE publication_mappings SET page_id = ?", (FOREIGN_PAGE_ID,))
    pub.update_document(NEW_ID, "Попытка записи в чужую страницу.")
    job = pub.latest_job()
    assert job["state"] == "conflict" and job["error_code"] == "foreign_page"
    assert pub.publish(job["id"]).status_code == 409
    assert pub.pages[FOREIGN_PAGE_ID]["version"] == 1


def test_frontmatter_page_id_is_ignored(pub: PubEnv) -> None:
    doc = pub.client.get("/api/documents/SEM-ARCH-001").json()
    created = pub.client.post(
        "/api/drafts",
        json={
            "document_id": "SEM-ARCH-001",
            "base_revision": doc["revision"],
            "proposed_content": doc["raw"].replace(
                "reviewed_at:", f"confluence_page_id: '{FOREIGN_PAGE_ID}'\nreviewed_at:"
            ),
            "reason": "Попытка указать страницу из документа",
        },
    ).json()
    pub.merge_proposal(created["id"])
    job = pub.latest_job("SEM-ARCH-001")
    codes = {w["code"] for w in job["plan"]["warnings"]}
    assert "frontmatter_page_id_ignored" in codes and job["plan"]["action"] == "create"
    pub.publish(job["id"])
    assert pub.pages[FOREIGN_PAGE_ID]["version"] == 1


def test_no_route_accepts_a_page_id(pub: PubEnv) -> None:
    spec = pub.client.get("/api/openapi.json").json()
    for path, methods in spec["paths"].items():
        if "publication" in path:
            assert "page" not in path.replace("publication", "")
            for operation in methods.values():
                assert "requestBody" not in operation  # nothing to inject a target into


def test_publication_disabled_without_rest_url(client: TestClient) -> None:
    status = client.get("/api/documents/SEM-ARCH-001/publication").json()
    assert status["state"] == "disabled" and status["publisher"]["mode"] == "disabled"
    response = client.post("/api/documents/SEM-ARCH-001/publication/prepare")
    assert response.status_code == 503 and response.json()["code"] == "publication_disabled"


def test_one_active_job_per_document_is_enforced_by_the_store(tmp_path: Path) -> None:
    from app.services.publications import PublicationStore

    store = PublicationStore(tmp_path / "p.sqlite3")
    row = {
        "project_id": "p",
        "document_key": "d",
        "document_id": "D",
        "document_path": "docs/D.md",
        "revision": "r1",
        "state": "dry_run_ready",
        "requested_by": "u",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    }
    store.insert_job({**row, "id": "a" * 32})
    with pytest.raises(sqlite3.IntegrityError):
        store.insert_job({**row, "id": "b" * 32, "revision": "r2", "state": "pending"})
    assert store.transition("a" * 32, {"dry_run_ready"}, "publishing")
    assert not store.transition("a" * 32, {"dry_run_ready"}, "publishing")  # a second publisher loses
    store.close()


def test_integration_statuses_are_labelled_honestly(pub: PubEnv, client: TestClient) -> None:
    items = {i["name"]: i for i in pub.client.get("/api/integrations/status").json()["items"]}
    assert (items["gitlab_knowledge"]["target"], items["gitlab_knowledge"]["access"]) == ("mock", "read")
    assert (items["gitlab_proposals"]["target"], items["gitlab_proposals"]["access"]) == ("mock", "write")
    publisher = items["confluence_publisher"]
    assert (publisher["target"], publisher["access"], publisher["state"]) == (
        "mock",
        "read_write",
        "connected",
    )
    assert publisher["checked_at"]
    offline = {i["name"]: i for i in client.get("/api/integrations/status").json()["items"]}
    assert offline["local_knowledge"]["target"] == "local"
    assert (offline["confluence_publisher"]["target"], offline["confluence_publisher"]["state"]) == (
        "none",
        "disabled",
    )
    assert offline["gitlab_knowledge"]["target"] == "none"


def test_publishing_token_never_logged_or_returned(pub: PubEnv, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG")
    pub.merged_document()
    job = pub.latest_job()
    published = pub.publish(job["id"])
    texts = [
        caplog.text,
        published.text,
        pub.client.get("/api/integrations/status").text,
        pub.client.get(f"/api/documents/{NEW_ID}/publication").text,
    ]
    assert all(CONF_TOKEN not in t for t in texts)


def test_unexpected_error_during_write_never_leaves_job_publishing(
    pub: PubEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    pub.merged_document()
    job = pub.latest_job()
    container = pub.client.app.state.container  # type: ignore[attr-defined]

    async def boom(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(container.confluence_publisher, "create_page", boom)
    with pytest.raises(RuntimeError):
        pub.publish(job["id"])
    assert pub.client.get(f"/api/publications/jobs/{job['id']}").json()["state"] == "result_unknown"
