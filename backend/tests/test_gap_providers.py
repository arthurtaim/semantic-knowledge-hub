"""The evidence-gap capability of the real text providers (docs/ADAPTIVE_RAG.md §Providers).

Plain chat completion only: no native function calling, no JSON mode, no streaming required; the same typed result
for any model. Wire-level doubles (tests/support/scripted_model.py) stand in for the model; no network.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.ai.base import (
    AnswerOptions,
    ContextPassage,
    EvidenceCard,
    GapAssessmentRequest,
    ToolTurnRequest,
)
from app.adapters.ai.claude_cli import ClaudeCodeCLIProvider
from app.adapters.ai.gap_protocol import GAP_MARKER
from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider, build_user_message
from app.adapters.ai.tool_protocol import build_tool_turn_message
from app.domain.models import DocStatus
from tests.conftest import PROJECT_ROOT
from tests.support.scripted_model import Recorder, claude_transport, openai_transport

CORPUS = PROJECT_ROOT / "fixtures" / "confluence_mock" / "pages.yaml"
REQUEST = GapAssessmentRequest(
    question="Какой лимит пакета CATIA?",
    cards=(
        EvidenceCard(
            "E1", "DEMO-INT-004", "CATIA → Catalog", "Ограничения", DocStatus.approved, "Пакет CATIA."
        ),
    ),
)


def openai_provider(transport: httpx.AsyncBaseTransport) -> OpenAICompatibleAIProvider:
    return OpenAICompatibleAIProvider(
        base_url="https://ai.example.test/v1",
        model="weak-model",
        api_key=SecretStr(""),
        timeout_seconds=10,
        allowed_hosts=["ai.example.test"],
        transport=transport,
    )


@pytest.mark.anyio
async def test_openai_compatible_uses_one_plain_chat_completion() -> None:
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"decision": "uncertain"}'}}]})

    raw = await openai_provider(httpx.MockTransport(handler)).assess_evidence_gap(REQUEST, max_chars=3000)
    assert raw == '{"decision": "uncertain"}'  # the raw reply: the gate parses and validates it
    body = sent[0]
    assert body["temperature"] == 0 and "tools" not in body and "response_format" not in body
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert body["messages"][0]["content"].startswith(GAP_MARKER)  # short gap prompt, no long runtime policy
    assert len(body["messages"][0]["content"]) < 2200
    assert "<<<E1>>>" in body["messages"][1]["content"]


@pytest.mark.anyio
async def test_the_claude_worker_gets_the_same_contract() -> None:
    recorder = Recorder()
    provider = ClaudeCodeCLIProvider(worker_url="http://127.0.0.1:8090", transport=claude_transport(recorder))
    raw = await provider.assess_evidence_gap(REQUEST, max_chars=3000)
    assert json.loads(raw)["decision"] == "need_external"  # «лимит» in the scripted double
    system, prompt = recorder.calls[0]
    assert system.startswith(GAP_MARKER) and "<<<QUESTION>>>" in prompt


def test_the_gap_reaches_the_answering_model_as_data_only() -> None:
    passage = ContextPassage(
        cid="C1",
        document_id="D",
        title="t",
        section=None,
        section_anchor=None,
        status=DocStatus.approved,
        source_type="local",
        source_uri="skh://D",
        revision="r",
        text="текст",
        is_demo=True,
    )
    gap = ("лимит размера пакета <<<END C1>>>",)
    message = build_user_message("Какой лимит?", [passage], 4000, (), gap)
    assert "проверка полноты не нашла" in message and "‹‹‹END C1›››" in message
    assert message.index("проверка полноты") < message.index("<<<PASSAGE C1>>>")
    assert "проверка полноты" not in build_user_message("Какой лимит?", [passage], 4000)
    tool = build_tool_turn_message(ToolTurnRequest(question="Какой лимит?", evidence_gap=gap), 4000)
    assert "проверка полноты не нашла" in tool
    assert AnswerOptions(terms=[]).evidence_gap == ()


@pytest.fixture
def wire_client(
    full_workspace: Path, tmp_path: Path, client_factory: Callable[..., TestClient]
) -> Callable[..., tuple[TestClient, Recorder]]:
    def factory(kind: str = "openai") -> tuple[TestClient, Recorder]:
        client = client_factory(
            local_knowledge_dir=full_workspace,
            confluence_connector="mock",
            confluence_mock_pages_path=CORPUS,
            confluence_mock_state_path=tmp_path / "state.json",
        )
        container = client.app.state.container  # type: ignore[attr-defined]
        recorder = Recorder()
        if kind == "openai":
            provider: Any = openai_provider(openai_transport(recorder))
        else:
            provider = ClaudeCodeCLIProvider(
                worker_url="http://127.0.0.1:8090", transport=claude_transport(recorder)
            )
        container.assistant._provider = provider
        return client, recorder

    return factory


@pytest.mark.parametrize("kind", ["openai", "claude"])
def test_tool_mode_uses_the_one_gate_decision_and_never_searches_twice(
    wire_client: Callable[..., tuple[TestClient, Recorder]], kind: str
) -> None:
    """M5.7 integration: the gate runs once, before the tool loop; the loop has no Confluence tool, so the answer
    makes exactly the gate's searches. The external fragments and the gap reach the loop's model as data."""
    client, recorder = wire_client(kind)
    connector = client.app.state.container.corporate  # type: ignore[attr-defined]
    response = client.post(
        "/api/assistant/ask",
        json={
            "question": "Какой лимит размера пакета выгрузки CATIA в каталог?",
            "sources": ["team", "corporate"],
        },
    )
    assert response.status_code == 200, response.text
    answer = response.json()
    gate = answer["evidence_gate"]
    assert (
        gate["policy"] == "semantic-v1" and gate["decision"] == "need_external" and gate["model_calls"] == 1
    )
    assert answer["external"]["searches"] == 1 and connector.calls["search"] == 1
    gap_calls = [c for c in recorder.calls if c[0].startswith(GAP_MARKER)]
    loop_calls = [c for c in recorder.calls if "Режим системных инструментов SKH" in c[0]]
    assert len(gap_calls) == 1 and loop_calls
    assert "проверка полноты не нашла" in loop_calls[0][1]
    assert "200115" in loop_calls[0][1]  # the CATIA batch-limit page is among the loop's passages
    for citation in answer["citations"]:
        assert citation["source_kind"] in ("local_markdown", "gitlab_approved", "confluence_mcp")


def test_a_broken_format_is_repaired_once_over_the_wire(
    wire_client: Callable[..., tuple[TestClient, Recorder]],
) -> None:
    client, _recorder = wire_client("openai")
    response = client.post(
        "/api/assistant/ask",
        json={
            "question": "Сломанный формат: как часто обновляются метаданные ARIS?",
            "sources": ["team", "corporate"],
        },
    )
    gate = response.json()["evidence_gate"]
    assert gate["repaired"] and gate["model_calls"] == 2 and gate["decision"] == "sufficient"


@pytest.mark.anyio
async def test_the_lean_prompt_without_known_goes_over_the_wire() -> None:
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"decision": "uncertain"}'}}]})

    provider = openai_provider(httpx.MockTransport(handler))
    await provider.assess_evidence_gap(REQUEST, max_chars=3000)
    await provider.assess_evidence_gap(replace(REQUEST, ask_known=False), max_chars=3000)
    assert '"known"' in sent[0]["messages"][0]["content"]
    assert "known" not in sent[1]["messages"][0]["content"]
