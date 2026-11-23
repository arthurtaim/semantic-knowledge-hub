"""Opt-in, READ-ONLY smoke tests against the operator's TEST GitLab / Confluence MCP.

Skipped unless SKH_LIVE_TESTS=1. Configuration comes from the environment exactly as for the app
(see deploy/integration/integration.env.example); secrets via *_FILE variables. These tests never
create branches, commits or merge requests and never write to Confluence.

    SKH_LIVE_TESTS=1 ../.venv/bin/python -m pytest -m live tests/live -v
"""

from __future__ import annotations

import asyncio
import os

import pytest

from app.config import Settings
from app.container import build_corporate, build_repository
from app.domain.models import UserContext

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("SKH_LIVE_TESTS") != "1", reason="live tests need SKH_LIVE_TESTS=1"),
]
USER = UserContext(user_id="live-smoke", display_name="live smoke")


@pytest.fixture(scope="module")
def settings() -> Settings:
    return Settings()


def test_gitlab_read_only(settings: Settings) -> None:
    if settings.knowledge_backend != "gitlab":
        pytest.skip("KNOWLEDGE_BACKEND is not gitlab")
    assert settings.gitlab_proposals_enabled is False, (
        "run live read tests with GITLAB_PROPOSALS_ENABLED=false"
    )
    repository = build_repository(settings)
    status = asyncio.run(repository.status())
    assert status.state == "connected", status.human_readable_message
    snapshot = asyncio.run(repository.snapshot(USER))
    blocking = [i for i in snapshot.issues if i.code not in ("unknown_field",)]
    print(f"documents={len(snapshot.documents)} issues={len(blocking)}")  # counts only, no content
    assert snapshot.documents or blocking, "no documents found: check GITLAB_KNOWLEDGE_PATH / branch"


def test_confluence_mcp_read_only(settings: Settings) -> None:
    if settings.confluence_connector != "mcp":
        pytest.skip("CONFLUENCE_CONNECTOR is not mcp")
    assert settings.confluence_publish_enabled is False
    connector = build_corporate(settings)
    status = asyncio.run(connector.status())
    assert status.state == "connected", status.human_readable_message
    query = os.environ.get("SKH_LIVE_CONFLUENCE_QUERY", "[TEST]")
    pages = asyncio.run(connector.search(query, USER, limit=3))
    allowed = set(settings.confluence_space_list)
    assert all(p.space in allowed for p in pages)
    print(f"pages={len(pages)}")  # counts only, no content
