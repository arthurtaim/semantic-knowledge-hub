"""Opt-in smoke test of the REAL Claude Code CLI integration through the deployed personal-test stack.

Skipped unless SKH_LIVE_TESTS=1 and SKH_CLAUDE_LIVE_URL is set to the UI address reachable from this machine
(normally an SSH tunnel to the Hetzner test stack, docs/CLAUDE_CODE_CLI_INTEGRATION.md §8):

    ssh -N -L 5180:127.0.0.1:5180 root@<hetzner-host> &
    SKH_LIVE_TESTS=1 SKH_CLAUDE_LIVE_URL=http://127.0.0.1:5180 \
      ../.venv/bin/python -m pytest -m live tests/live/test_claude_cli_live.py -v

Each test sends a real request to Claude with the owner's subscription (synthetic fixtures only). The tests
print nothing but outcomes; they never print tokens, prompts or full model output.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

BASE_URL = os.environ.get("SKH_CLAUDE_LIVE_URL", "")
pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.environ.get("SKH_LIVE_TESTS") != "1" or not BASE_URL,
        reason="needs SKH_LIVE_TESTS=1 and SKH_CLAUDE_LIVE_URL (SSH tunnel to the personal test stack)",
    ),
]
HEADERS = {"X-SKH-Client": "live-smoke"}


@pytest.fixture(scope="module")
def client() -> httpx.Client:
    with httpx.Client(base_url=BASE_URL, headers=HEADERS, timeout=300, trust_env=False) as c:
        yield c


def stream(client: httpx.Client, payload: dict[str, Any]) -> list[dict[str, Any]]:
    with client.stream("POST", "/api/assistant/ask/stream", json=payload) as resp:
        assert resp.status_code == 200
        return [json.loads(line) for line in resp.iter_lines() if line.strip()]


def test_provider_is_claude_cli(client: httpx.Client) -> None:
    features = client.get("/api/session").json()["features"]
    assert features["ai_mode"] == "claude_cli"


def test_grounded_answer_with_verified_citations(client: httpx.Client) -> None:
    events = stream(
        client, {"question": "Где хранится каноническая база знаний команды?", "sources": ["team"]}
    )
    final = events[-1]
    assert final["type"] == "final", final
    response = final["response"]
    assert response["mode"] == "claude_cli"
    assert response["confidence"] in ("supported", "partial")
    assert response["citations"], "Claude must cite a passage verbatim; the server verified it"
    assert any(e["type"] == "delta" for e in events), "preliminary text is streamed"


def test_unknown_topic_is_insufficient(client: httpx.Client) -> None:
    events = stream(client, {"question": "Какой SLA у интеграции с ЦФТ?", "sources": ["team"]})
    response = events[-1]["response"]
    assert response["confidence"] == "insufficient_evidence" and response["citations"] == []


def test_ai_draft_is_a_suggestion(client: httpx.Client) -> None:
    resp = client.post(
        "/api/authoring/ai-draft",
        json={
            "template_id": "integration",
            "title": "Интеграция ARIS (live smoke)",
            "request": "Подготовь техническое описание интеграции ARIS по документам команды",
        },
    )
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert draft["mode"] == "claude_cli" and draft["body"].lstrip().startswith("#")
    assert "Требует уточнения" in draft["body"] or draft["citations"]
