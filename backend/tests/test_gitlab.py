"""GitLab adapters against a fake GitLab REST API (AC-13, AC-16, AC-17). No real network."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections.abc import Callable
from typing import Any
from urllib.parse import unquote

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.gitlab.client import GitLabClient, GitLabError, validate_gitlab_config
from app.adapters.gitlab.publisher import GitLabMRPublisher, branch_name
from app.adapters.gitlab.repository import GitLabKnowledgeRepository
from app.adapters.knowledge.base import RepositoryUnavailableError
from app.adapters.publishers.base import ProposalForPublication, PublisherDisabledError
from app.domain.models import UserContext
from tests.conftest import FIXTURES_DIR, make_doc

USER = UserContext(user_id="u", display_name="u")
TOKEN = "glpat-test-token-0123456789abcdef"
PROJECT = "/api/v4/projects/42"


class FakeGitLab:
    """In-memory GitLab subset: tree (paginated), files, branches, commits, merge requests."""

    def __init__(self, files: dict[str, str], *, keyset: bool = True) -> None:
        self.keyset = keyset  # older instances ignore `pagination=keyset` and only page by offset
        self.files = {
            path: {"content": text, "commit": f"c0ffee{i:034d}"}
            for i, (path, text) in enumerate(files.items())
        }
        self.branches = {"main"}
        self.commits: list[dict[str, Any]] = []
        self.mrs: list[dict[str, Any]] = []
        self.requests: list[httpx.Request] = []
        self.fail: dict[str, list[int]] = {}

    def _maybe_fail(self, key: str) -> httpx.Response | None:
        queue = self.fail.get(key)
        if queue:
            return httpx.Response(queue.pop(0), json={"message": "simulated"}, headers={"Retry-After": "0"})
        return None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["PRIVATE-TOKEN"] == TOKEN
        path = request.url.path
        params = request.url.params
        if path == PROJECT:
            return self._maybe_fail("project") or httpx.Response(200, json={"id": 42})
        if path == f"{PROJECT}/repository/tree":
            failure = self._maybe_fail("tree")
            if failure:
                return failure
            items = [
                {"type": "blob", "path": p, "id": f"blob-{p}-{len(v['content'])}"}
                for p, v in sorted(self.files.items())
            ]
            items.append({"type": "tree", "path": "docs"})
            size = 2  # tiny pages to exercise pagination
            if self.keyset and params.get("pagination") == "keyset":
                start = int(params.get("page_token", "0"))
                chunk = items[start : start + size]
                headers = {}
                if start + size < len(items):
                    # Documented keyset style: next page in the Link header. The host is deliberately
                    # foreign to prove that only the opaque token is reused, never the URL.
                    headers["Link"] = (
                        f"<https://elsewhere.example{PROJECT}/repository/tree?page_token={start + size}"
                        '&pagination=keyset&per_page=100>; rel="next"'
                    )
                return httpx.Response(200, json=chunk, headers=headers)
            page = int(params.get("page", "1"))
            chunk = items[(page - 1) * size : page * size]
            headers = {"X-Next-Page": str(page + 1)} if page * size < len(items) else {}
            return httpx.Response(200, json=chunk, headers=headers)
        if path.startswith(f"{PROJECT}/repository/files/"):
            raw_path = request.url.raw_path.decode().split("?", 1)[0]
            encoded = raw_path.split("/repository/files/", 1)[1]
            assert "/" not in encoded, "file path must be URL-encoded as one segment (%2F)"
            file_path = unquote(encoded)
            entry = self.files.get(file_path)
            if entry is None:
                return httpx.Response(404, json={"message": "404 File Not Found"})
            data = entry["content"].encode()
            return httpx.Response(
                200,
                json={
                    "file_path": file_path,
                    "size": len(data),
                    "encoding": "base64",
                    "content": base64.b64encode(data).decode(),
                    "last_commit_id": entry["commit"],
                },
            )
        if path.startswith(f"{PROJECT}/repository/branches/") and request.method == "GET":
            name = unquote(request.url.raw_path.decode().split("/repository/branches/", 1)[1].split("?")[0])
            if name in self.branches:
                return httpx.Response(200, json={"name": name})
            return httpx.Response(404, json={"message": "404 Branch Not Found"})
        if path == f"{PROJECT}/repository/branches" and request.method == "POST":
            name = params["branch"]
            if name in self.branches:
                return httpx.Response(400, json={"message": "undocumented wording"})
            self.branches.add(name)
            return httpx.Response(201, json={"name": name})
        if path == f"{PROJECT}/repository/commits" and request.method == "GET":
            return httpx.Response(200, json=[c for c in self.commits if c["branch"] == params["ref_name"]])
        if path == f"{PROJECT}/repository/commits" and request.method == "POST":
            body = json.loads(request.content)
            assert body["branch"] != "main", "never commit to the default branch"
            action = body["actions"][0]
            if self.files[action["file_path"]]["commit"] != action["last_commit_id"]:
                return httpx.Response(
                    400, json={"message": "You are attempting to update a file that has changed"}
                )
            self.commits.append({"branch": body["branch"], "message": body["commit_message"]})
            return httpx.Response(201, json={"id": "new-commit"})
        if path == f"{PROJECT}/repository/compare" and request.method == "GET":
            # commits reachable from `to` but not from `from` (proposal branches fork from main)
            return httpx.Response(
                200, json={"commits": [c for c in self.commits if c["branch"] == params["to"]]}
            )
        if path == f"{PROJECT}/merge_requests" and request.method == "GET":
            state = params.get("state", "all")
            found = [m for m in self.mrs if m["source_branch"] == params["source_branch"]]
            return httpx.Response(200, json=[m for m in found if state == "all" or m["state"] == state])
        if path == f"{PROJECT}/merge_requests" and request.method == "POST":
            body = json.loads(request.content)
            assert body["target_branch"] == "main"
            mr = {
                "iid": len(self.mrs) + 1,
                "web_url": f"https://gitlab.internal.example/kb/-/merge_requests/{len(self.mrs) + 1}",
                "source_branch": body["source_branch"],
                "state": "opened",
            }
            self.mrs.append(mr)
            return httpx.Response(201, json=mr)
        return httpx.Response(404, json={"message": "unexpected"})


def make_repo(fake: FakeGitLab, **kwargs: Any) -> GitLabKnowledgeRepository:
    async def no_sleep(_: float) -> None:
        return None

    client = GitLabClient(
        base_url="https://gitlab.internal.example",
        project_id="42",
        token=SecretStr(TOKEN),
        transport=httpx.MockTransport(fake.handler),
        sleep=no_sleep,
    )
    return GitLabKnowledgeRepository(client, project_id="42", branch="main", refresh_seconds=0, **kwargs)


def fixture_files() -> dict[str, str]:
    return {f"docs/{p.name}": p.read_text(encoding="utf-8") for p in sorted(FIXTURES_DIR.glob("*.md"))[:3]}


def test_reads_documents_with_commit_revisions() -> None:
    fake = FakeGitLab({**fixture_files(), "README.txt": "not markdown"})
    repo = make_repo(fake)
    snapshot = asyncio.run(repo.snapshot(USER))
    assert len(snapshot.documents) == 3
    doc = next(iter(snapshot.documents.values()))
    assert doc.source == "gitlab"
    assert doc.revision.startswith("c0ffee")
    assert doc.source_uri == f"gitlab://42/{doc.path}@main"
    assert not doc.is_demo or "demo" in doc.tags
    # pagination walked every page (keyset tokens)
    tokens = [r.url.params.get("page_token") for r in fake.requests if r.url.path.endswith("/tree")]
    assert tokens == [None, "2", "4"]  # 3 docs + README.txt + a tree entry, 2 per page


def test_unchanged_tree_is_not_refetched() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    asyncio.run(repo.snapshot(USER))
    reads = sum(1 for r in fake.requests if "/repository/files/" in r.url.path)
    asyncio.run(repo.snapshot(USER))
    assert sum(1 for r in fake.requests if "/repository/files/" in r.url.path) == reads


def test_invalid_and_duplicate_documents_are_reported() -> None:
    files = {"a.md": make_doc("DUP-1"), "b.md": make_doc("dup-1"), "bad.md": "---\nid: [x\n---\n"}
    snapshot = asyncio.run(make_repo(FakeGitLab(files)).snapshot(USER))
    assert snapshot.documents == {}
    assert {i.code for i in snapshot.issues} == {"duplicate_id", "frontmatter_invalid_yaml"}


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "gitlab_auth_failed"),
        (403, "gitlab_forbidden"),
        (404, "gitlab_not_found"),
        (429, "gitlab_rate_limited"),
        (503, "gitlab_unavailable"),
    ],
)
def test_http_errors_are_mapped_without_leaking_token(
    status: int, code: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    fake = FakeGitLab(fixture_files())
    fake.fail["tree"] = [status] * 5
    with pytest.raises(RepositoryUnavailableError) as exc:
        asyncio.run(make_repo(fake).snapshot(USER))
    assert exc.value.code == code
    assert TOKEN not in exc.value.message
    assert TOKEN not in caplog.text


def test_transient_errors_are_retried_with_bound() -> None:
    fake = FakeGitLab(fixture_files())
    fake.fail["tree"] = [503, 429]
    snapshot = asyncio.run(make_repo(fake).snapshot(USER))
    assert len(snapshot.documents) == 3
    fake.fail["project"] = [503, 503, 503, 503]
    fake.requests.clear()
    status = asyncio.run(make_repo(fake).status())
    assert status.state == "error"
    assert sum(1 for r in fake.requests if r.url.path == PROJECT) == 3  # 1 try + 2 retries, then give up


def test_status_probe_reports_connected_only_after_check() -> None:
    fake = FakeGitLab(fixture_files())
    status = asyncio.run(make_repo(fake).status())
    assert status.state == "connected"
    assert any(r.url.path == PROJECT for r in fake.requests)


@pytest.mark.parametrize(
    ("url", "project", "token", "fragment"),
    [
        ("", "1", "t", "GITLAB_URL"),
        ("http://gitlab.example", "1", "t", "http"),
        ("https://user:pw@gitlab.example", "1", "t", "учётные"),
        ("https://gitlab.example", "", "t", "PROJECT"),
        ("https://gitlab.example", "1", "", "Токен"),
    ],
)
def test_config_validation(url: str, project: str, token: str, fragment: str) -> None:
    problem = validate_gitlab_config(url, project, SecretStr(token), allow_insecure_http=False)
    assert problem is not None and fragment in problem


# --- merge request publisher ---------------------------------------------------------------------


def proposal_for(repo: GitLabKnowledgeRepository, **overrides: Any) -> ProposalForPublication:
    doc = next(iter(asyncio.run(repo.snapshot(USER)).documents.values()))
    values: dict[str, Any] = {
        "proposal_id": "f" * 32,
        "document_id": doc.id,
        "document_path": doc.path,
        "base_revision": doc.revision,
        "proposed_content": doc.raw + "\nНовая строка.\n",
        "reason": "Уточнение",
    }
    values.update(overrides)
    return ProposalForPublication(**values)


def test_publisher_creates_branch_commit_and_mr_idempotently() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    publisher = GitLabMRPublisher(repo)
    proposal = proposal_for(repo)
    first = asyncio.run(publisher.publish_proposal(proposal, USER))
    assert first.state == "created"
    assert first.merge_request and first.merge_request.url
    assert first.merge_request.url.startswith("https://")
    assert branch_name(proposal.proposal_id, proposal.document_id) in fake.branches
    assert len(fake.commits) == 1 and "Proposal-Id: " + "f" * 32 in fake.commits[0]["message"]
    again = asyncio.run(publisher.publish_proposal(proposal, USER))
    assert again.state == "existing"
    assert len(fake.mrs) == 1 and len(fake.commits) == 1


def test_publisher_refuses_stale_base_revision() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    proposal = proposal_for(repo)
    fake.files[proposal.document_path]["commit"] = "changed-upstream"
    result = asyncio.run(GitLabMRPublisher(repo).publish_proposal(proposal, USER))
    assert result.state == "conflict"
    assert fake.commits == [] and fake.mrs == []


def test_end_to_end_open_mr_through_api(
    client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeGitLab(fixture_files())
    original = GitLabClient.__init__

    def patched(self: GitLabClient, **kwargs: Any) -> None:
        kwargs["transport"] = httpx.MockTransport(fake.handler)
        original(self, **kwargs)

    monkeypatch.setattr(GitLabClient, "__init__", patched)
    client = client_factory(
        knowledge_backend="gitlab",
        gitlab_url="https://gitlab.internal.example",
        gitlab_project_id="42",
        gitlab_token=TOKEN,
        gitlab_proposals_enabled=True,
        gitlab_refresh_seconds=0,
    )
    items = client.get("/api/documents").json()["items"]
    assert items and all(i["source"] == "gitlab" for i in items)
    doc = client.get(f"/api/documents/{items[0]['id']}").json()
    draft = client.post(
        "/api/drafts",
        json={
            "document_id": doc["id"],
            "base_revision": doc["revision"],
            "proposed_content": doc["raw"] + "\nX\n",
            "reason": "MR test",
        },
    ).json()
    assert client.post(f"/api/drafts/{draft['id']}/open-mr").status_code == 409  # must be ready first
    client.post(f"/api/drafts/{draft['id']}/mark-ready")
    opened = client.post(f"/api/drafts/{draft['id']}/open-mr")
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["publication"]["state"] == "submitted"
    assert body["publication"]["external_url"].startswith("https://gitlab.internal.example/")
    assert [e["action"] for e in body["history"]][-1] == "merge_request_opened"
    assert body["status"] == "submitted_to_gitlab"
    assert body["can_reject"] is False
    rejected = client.post(f"/api/drafts/{draft['id']}/reject")
    assert rejected.status_code == 409 and "GitLab" in rejected.json()["message"]
    assert client.post(f"/api/drafts/{draft['id']}/open-mr").status_code == 409  # no second MR
    statuses = {i["name"]: i["state"] for i in client.get("/api/integrations/status").json()["items"]}
    assert statuses["gitlab_knowledge"] == "connected"
    assert statuses["gitlab_proposals"] == "connected"
    assert TOKEN not in client.get("/api/integrations/status").text


def test_gitlab_outage_returns_503(
    client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeGitLab(fixture_files())
    fake.fail["tree"] = [401] * 10
    original = GitLabClient.__init__

    def patched(self: GitLabClient, **kwargs: Any) -> None:
        kwargs["transport"] = httpx.MockTransport(fake.handler)
        original(self, **kwargs)

    monkeypatch.setattr(GitLabClient, "__init__", patched)
    client = client_factory(
        knowledge_backend="gitlab",
        gitlab_url="https://gitlab.internal.example",
        gitlab_project_id="42",
        gitlab_token=TOKEN,
    )
    response = client.get("/api/documents")
    assert response.status_code == 503
    assert response.json()["code"] == "gitlab_auth_failed"
    assert TOKEN not in response.text


def test_gitlab_error_type() -> None:
    err = GitLabError("gitlab_timeout", "msg")
    assert err.code == "gitlab_timeout"


def test_closed_mr_is_not_recreated() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    publisher = GitLabMRPublisher(repo)
    proposal = proposal_for(repo)
    asyncio.run(publisher.publish_proposal(proposal, USER))
    fake.mrs[0]["state"] = "closed"  # reviewers closed it in GitLab
    again = asyncio.run(publisher.publish_proposal(proposal, USER))
    assert again.state == "existing"
    assert len(fake.mrs) == 1


def test_post_requests_are_not_retried() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    proposal = proposal_for(repo)
    calls: list[str] = []

    def flaky(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/merge_requests"):
            calls.append("mr-post")
            return httpx.Response(503, json={"message": "simulated"})
        return fake.handler(request)

    repo.client._transport = httpx.MockTransport(flaky)  # type: ignore[attr-defined]
    with pytest.raises(PublisherDisabledError) as exc:
        asyncio.run(GitLabMRPublisher(repo).publish_proposal(proposal, USER))
    # A 5xx answer to a write is an unknown outcome: GitLab is inspected, never re-posted.
    assert exc.value.code == "gitlab_write_uncertain" and exc.value.uncertain
    assert calls == ["mr-post"]  # a POST is sent exactly once, never retried


def test_keyset_pagination_reuses_only_the_token() -> None:
    fake = FakeGitLab(fixture_files())
    snapshot = asyncio.run(make_repo(fake).snapshot(USER))
    assert len(snapshot.documents) == 3
    tree_calls = [r for r in fake.requests if r.url.path.endswith("/repository/tree")]
    assert all(r.url.params.get("pagination") == "keyset" for r in tree_calls)
    assert [r.url.params.get("page_token") for r in tree_calls] == [None, "2"]
    assert all(r.url.host == "gitlab.internal.example" for r in fake.requests)  # Link host never followed


def test_offset_pagination_fallback() -> None:
    fake = FakeGitLab(fixture_files(), keyset=False)
    snapshot = asyncio.run(make_repo(fake).snapshot(USER))
    assert len(snapshot.documents) == 3
    pages = [r.url.params.get("page") for r in fake.requests if r.url.path.endswith("/repository/tree")]
    assert pages == [None, "2"]


def test_status_requires_readable_default_branch() -> None:
    fake = FakeGitLab(fixture_files())
    fake.branches.discard("main")
    status = asyncio.run(make_repo(fake).status())
    assert status.state == "error"


def test_existing_branch_is_detected_by_state_not_message() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    proposal = proposal_for(repo)
    fake.branches.add(
        branch_name(proposal.proposal_id, proposal.document_id)
    )  # e.g. left over from an interrupted run
    result = asyncio.run(GitLabMRPublisher(repo).publish_proposal(proposal, USER))
    assert result.state == "created"


def test_commit_rejected_without_file_change_is_an_error_not_a_conflict() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    proposal = proposal_for(repo)
    original = fake.handler

    def reject_commits(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/repository/commits"):
            return httpx.Response(400, json={"message": "something else"})
        return original(request)

    repo.client._transport = httpx.MockTransport(reject_commits)  # type: ignore[attr-defined]
    with pytest.raises(PublisherDisabledError) as exc:
        asyncio.run(GitLabMRPublisher(repo).publish_proposal(proposal, USER))
    assert exc.value.code == "gitlab_commit_rejected"


@pytest.mark.parametrize("status", [400, 409, 422])
def test_mr_creation_failure_resolved_by_lookup(status: int) -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    proposal = proposal_for(repo)
    original = fake.handler
    state = {"posted": False}

    def duplicate(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/merge_requests"):
            if not state["posted"]:
                state["posted"] = True
                original(request)  # GitLab created it, but answered with an error
            return httpx.Response(status, json={"message": "undocumented"})
        return original(request)

    repo.client._transport = httpx.MockTransport(duplicate)  # type: ignore[attr-defined]
    result = asyncio.run(GitLabMRPublisher(repo).publish_proposal(proposal, USER))
    assert result.state == "existing" and result.merge_request and result.merge_request.url


def test_mr_creation_failure_without_mr_is_an_error() -> None:
    fake = FakeGitLab(fixture_files())
    repo = make_repo(fake)
    proposal = proposal_for(repo)
    original = fake.handler

    def refuse(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/merge_requests"):
            return httpx.Response(422, json={"message": "nope"})
        return original(request)

    repo.client._transport = httpx.MockTransport(refuse)  # type: ignore[attr-defined]
    with pytest.raises(PublisherDisabledError) as exc:
        asyncio.run(GitLabMRPublisher(repo).publish_proposal(proposal, USER))
    assert exc.value.code == "gitlab_mr_rejected" and not exc.value.uncertain
