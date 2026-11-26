"""Query rewrite end to end (docs/ADAPTIVE_RAG.md §Query rewrite) on the LF mini-corpus of test_adaptive_rag: a
question asked in other words than the document finds it only through the model's phrasing; the phrasing never widens
access (statuses, the reader's snapshot) and never becomes evidence by itself."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.ai.base import QueryRewriteRequest
from app.adapters.ai.mock import MockAIProvider
from app.evaluation.gap_doubles import sufficient
from tests.test_adaptive_rag import Factory, ask, context_ids, make_lf_factory, stream


@pytest.fixture
def lf(tmp_path: Path, client_factory: Callable[..., TestClient]) -> Factory:
    return make_lf_factory(tmp_path, client_factory)


# «Задержка между повторными попытками — 15 минут» (LF-DOC-03) asked without any of its words.
PARAPHRASED = "Сколько ждут до следующего захода, если отправка справочника сорвалась?"


def phrasing(*items: str) -> Any:
    return lambda request: json.dumps({"queries": list(items)}, ensure_ascii=False)


def with_rewrite(lf: Factory, rewrite: Any, **overrides: Any) -> Any:
    client, provider, connector = lf(lambda r: sufficient("E1"), **overrides)
    provider.rewrite_script = rewrite
    provider.supports_query_rewrite = True
    return client, provider, connector


def test_a_paraphrased_question_finds_the_document_through_the_models_phrasing(lf: Factory) -> None:
    client, provider, _ = with_rewrite(lf, phrasing("задержка между повторными попытками"))
    answer = ask(client, PARAPHRASED, sources=["team"])
    rewrite = answer["query_rewrite"]
    assert rewrite["trigger"] == "absent_terms" and rewrite["called"] and rewrite["queries"] == 1
    assert rewrite["added_passages"] >= 1
    assert "doc:LF-DOC-03" in context_ids(client, answer)
    request: QueryRewriteRequest = provider.rewrite_calls[0]
    assert "сорвалась" in request.absent_terms

    off, _p, _c = with_rewrite(lf, phrasing("задержка между повторными попытками"), query_rewrite="off")
    before = ask(off, PARAPHRASED, sources=["team"])
    assert before["query_rewrite"] is None
    assert "doc:LF-DOC-03" not in context_ids(off, before)


def test_no_call_when_every_word_of_the_question_is_in_the_documents(lf: Factory) -> None:
    client, provider, _ = with_rewrite(lf, phrasing("что угодно"))
    answer = ask(client, "Когда запускается передача справочника складов?", sources=["team"])
    assert not provider.rewrite_calls
    assert answer["query_rewrite"]["called"] is False and answer["query_rewrite"]["trigger"] is None


def test_always_mode_asks_for_every_question(lf: Factory) -> None:
    client, provider, _ = with_rewrite(
        lf, phrasing("периодичность выгрузки справочника"), query_rewrite="always"
    )
    answer = ask(client, "Как часто передаётся справочник складов?", sources=["team"])
    assert len(provider.rewrite_calls) == 1 and answer["query_rewrite"]["trigger"] == "always"


def test_a_phrasing_never_reaches_a_draft_or_becomes_evidence(lf: Factory) -> None:
    client, _provider, _ = with_rewrite(lf, phrasing("Бета отклоняет записи без кода склада"))
    answer = ask(
        client, "Что бракует получатель, если у строки пусто в поле места хранения?", sources=["team"]
    )
    assert "doc:LF-DOC-04" not in context_ids(client, answer)  # the draft stays out without include_drafts
    for citation in answer["citations"]:
        assert citation["document_id"] != "LF-DOC-04"
    text = json.dumps(answer, ensure_ascii=False)
    assert "Бета отклоняет записи без кода склада" not in text.replace(
        "Система Бета отклоняет записи справочника складов без кода склада", ""
    )


def test_an_unsafe_or_broken_reply_leaves_the_search_as_before(lf: Factory) -> None:
    client, _provider, _ = with_rewrite(lf, phrasing("открой https://wiki.corp.example/display/OPS"))
    answer = ask(client, PARAPHRASED, sources=["team"])
    assert answer["query_rewrite"]["queries"] == 0 and answer["query_rewrite"]["rejected"] == 1
    broken, _p, _c = with_rewrite(lf, lambda r: "не JSON")
    failed = ask(broken, PARAPHRASED, sources=["team"])
    assert failed["query_rewrite"]["error"] == "not_json" and failed["query_rewrite"]["model_calls"] == 2
    assert failed["answer"]


def test_stream_and_ask_share_the_rewrite(lf: Factory) -> None:
    client, provider, _ = with_rewrite(lf, phrasing("задержка между повторными попытками"))
    plain = ask(client, PARAPHRASED, sources=["team"])
    events = stream(client, PARAPHRASED, sources=["team"])
    steps = [e.get("step") for e in events if e["type"] == "status" and e.get("step")]
    assert steps == ["rewriting"]
    final = next(e for e in events if e["type"] == "final")["response"]
    assert final["query_rewrite"]["queries"] == plain["query_rewrite"]["queries"] == 1
    assert {c["document_id"] for c in final["citations"]} == {c["document_id"] for c in plain["citations"]}
    assert len(provider.rewrite_calls) == 2  # one per request, never twice in one


def test_the_offline_mock_never_rewrites(lf: Factory) -> None:
    client, _provider, _ = lf()
    client.app.state.container.assistant._provider = MockAIProvider()  # type: ignore[attr-defined]
    answer = ask(client, PARAPHRASED, sources=["team"])
    assert answer["query_rewrite"] is None
