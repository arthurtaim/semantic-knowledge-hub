"""Shared pytest plumbing for scenarios against the stateful GitLab TEST DOUBLE (in-process, no
network). Registered from conftest.py via `pytest_plugins`."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters.gitlab.client import GitLabClient
from tests.support.gitlab_mock import DEFAULT_TOKEN, PROJECT_ID, Fault, GitLabMock, MockState

BASE_URL = "https://gitlab.mock.example"
DOC = "SEM-ARCH-001"
DOC_PATH = "docs/SEM-ARCH-001.md"


class MockTransport(httpx.AsyncBaseTransport):
    """In-process transport to the mock that still enforces a client-side timeout."""

    def __init__(self, app: GitLabMock, timeout: float) -> None:
        self._inner = httpx.ASGITransport(app=app)
        self._timeout = timeout

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await asyncio.wait_for(self._inner.handle_async_request(request), self._timeout)
        except TimeoutError as exc:
            raise httpx.ReadTimeout("simulated client timeout", request=request) from exc


@dataclass
class Env:
    client: TestClient
    mock: GitLabMock
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def state(self) -> MockState:
        return self.mock.state

    def fault(self, method: str, path_contains: str, **kwargs: Any) -> None:
        self.state.faults.append(Fault(method=method, path_contains=path_contains, **kwargs))

    def requests(self, method: str, fragment: str) -> int:
        return sum(1 for m, p in self.state.requests if m == method and fragment in p)

    def doc(self, doc_id: str = DOC) -> dict[str, Any]:
        response = self.client.get(f"/api/documents/{doc_id}")
        assert response.status_code == 200, response.text
        data: dict[str, Any] = response.json()
        return data

    def new_proposal(self, doc_id: str = DOC, marker: str = "Новый абзац из предложения.") -> dict[str, Any]:
        doc = self.doc(doc_id)
        response = self.client.post(
            "/api/drafts",
            json={
                "document_id": doc_id,
                "base_revision": doc["revision"],
                "proposed_content": doc["raw"].rstrip("\n") + f"\n\n{marker}\n",
                "reason": "Уточнение раздела для проверки жизненного цикла",
            },
        )
        assert response.status_code == 201, response.text
        data: dict[str, Any] = response.json()
        return data

    def ready(self, proposal_id: str) -> None:
        response = self.client.post(f"/api/drafts/{proposal_id}/mark-ready")
        assert response.status_code == 200, response.text

    def submit(self, proposal_id: str) -> httpx.Response:
        return self.client.post(f"/api/drafts/{proposal_id}/submit")

    def detail(self, proposal_id: str) -> dict[str, Any]:
        data: dict[str, Any] = self.client.get(f"/api/drafts/{proposal_id}").json()
        return data


def patch_gitlab_transport(monkeypatch: pytest.MonkeyPatch, mock: GitLabMock) -> None:
    original = GitLabClient.__init__

    def patched(self: GitLabClient, **kwargs: Any) -> None:
        kwargs["transport"] = MockTransport(mock, timeout=0.3)

        async def no_sleep(_: float) -> None:
            return None

        kwargs["sleep"] = no_sleep
        original(self, **kwargs)

    monkeypatch.setattr(GitLabClient, "__init__", patched)


GITLAB_SETTINGS: dict[str, Any] = {
    "integration_profile": "integration_mock",
    "mock_service_hosts": "gitlab.mock.example",
    "knowledge_backend": "gitlab",
    "gitlab_url": BASE_URL,
    "gitlab_project_id": PROJECT_ID,
    "gitlab_token": DEFAULT_TOKEN,
    "gitlab_knowledge_path": "docs",
    "gitlab_proposals_enabled": True,
    "gitlab_refresh_seconds": 0,
    "app_public_url": "http://127.0.0.1:5173",
}


@pytest.fixture
def gitlab_mock() -> GitLabMock:
    return GitLabMock(MockState(base_url=BASE_URL))


@pytest.fixture
def gitlab(
    client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch, gitlab_mock: GitLabMock
) -> Iterator[Env]:
    mock = gitlab_mock
    patch_gitlab_transport(monkeypatch, mock)
    client = client_factory(**GITLAB_SETTINGS)
    yield Env(client, mock)
    # Global invariant of every scenario: nothing was ever written to the protected branch.
    assert mock.state.protected_write_attempts == 0
