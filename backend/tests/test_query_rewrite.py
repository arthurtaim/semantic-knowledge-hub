"""QueryRewriter (docs/ADAPTIVE_RAG.md §Query rewrite): when the model is asked to rephrase the question, and what the
server keeps from its reply. A fake provider returns scripted raw replies; no network."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from app.adapters.ai.base import AIProviderError, QueryRewriteRequest
from app.domain.text import analyze_query
from app.services.query_rewrite import QueryRewriter, RewriteSettings


class FakeProvider:
    supports_query_rewrite = True

    def __init__(self, *replies: str | Exception, delay: float = 0.0) -> None:
        self.replies = list(replies)
        self.requests: list[QueryRewriteRequest] = []
        self.delay = delay

    async def rewrite_query(self, request: QueryRewriteRequest, *, max_chars: int) -> str:
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def queries(*items: str) -> str:
    return json.dumps({"queries": list(items)}, ensure_ascii=False)


def rewriter(**settings: Any) -> QueryRewriter:
    return QueryRewriter(RewriteSettings(**settings))


def run(coro: Any) -> Any:
    return asyncio.run(coro)


QUESTION = "Какая пауза между перезапусками в потоке IF-7?"
TERMS = analyze_query(QUESTION)
ALL = {t.stem for t in TERMS}
WITHOUT_PAUSE = {t.stem for t in TERMS if t.token not in ("пауза", "перезапусками")}


def test_the_trigger_is_a_word_in_no_document_or_no_local_passage() -> None:
    r = rewriter()
    assert r.trigger(own_terms=TERMS, matched=ALL, has_passages=True) is None
    assert r.trigger(own_terms=TERMS, matched=WITHOUT_PAUSE, has_passages=True) == "absent_terms"
    assert r.trigger(own_terms=TERMS, matched=ALL, has_passages=False) == "no_local_passages"
    assert rewriter(mode="always").trigger(own_terms=TERMS, matched=ALL, has_passages=True) == "always"
    assert rewriter(mode="off").trigger(own_terms=TERMS, matched=set(), has_passages=False) is None
    assert r.trigger(own_terms=[], matched=set(), has_passages=False) is None


def test_only_a_provider_with_the_capability_is_asked() -> None:
    class Mock:
        mode = "mock"

    assert rewriter().enabled_for(FakeProvider()) and not rewriter().enabled_for(Mock())
    assert not rewriter(mode="off").enabled_for(FakeProvider())


def ask(provider: FakeProvider, **kw: Any) -> Any:
    args: dict[str, Any] = {
        "question": QUESTION,
        "referent": "",
        "own_terms": TERMS,
        "matched": WITHOUT_PAUSE,
        "vocabulary": ("Повторы при сбоях потока IF-7",),
        "trigger": "absent_terms",
    }
    args.update(kw)
    return run(rewriter(**args.pop("settings", {})).rewrite(provider, **args))


def test_phrasings_are_sanitized_capped_and_keep_the_identifier() -> None:
    provider = FakeProvider(
        queries(
            "задержка между повторными попытками", "https://wiki.corp.example/x", "интервал повтора при сбое"
        )
    )
    result = ask(provider, settings={"max_queries": 2})
    assert result.queries == ("IF-7 задержка между повторными попытками", "IF-7 интервал повтора при сбое")
    assert result.rejected == 1 and result.model_calls == 1 and result.trigger == "absent_terms"
    request = provider.requests[0]
    assert request.absent_terms == ("пауза", "перезапусками")
    assert request.vocabulary == ("Повторы при сбоях потока IF-7",)


def test_a_phrasing_that_only_repeats_the_question_is_dropped() -> None:
    result = ask(FakeProvider(queries("пауза между перезапусками в потоке IF-7")))
    assert result.queries == () and result.rejected == 1


def test_one_repair_for_prose_then_no_rewrite_on_failure() -> None:
    repaired = ask(FakeProvider("Попробуйте слово задержка", queries("задержка между попытками")))
    assert repaired.repaired and repaired.model_calls == 2 and repaired.queries
    failed = ask(FakeProvider("нет", "всё ещё нет"))
    assert failed.queries == () and failed.error == "not_json" and failed.model_calls == 2
    schema = ask(FakeProvider(json.dumps({"queries": ["a"], "answer": "15 минут"})))
    assert schema.queries == () and schema.model_calls == 1 and schema.error.startswith("schema")


def test_a_slow_or_failing_model_means_the_search_runs_as_before() -> None:
    slow = ask(FakeProvider(queries("задержка"), delay=0.5), settings={"timeout_seconds": 0.05})
    assert slow.queries == () and slow.error == "timeout"
    broken = ask(FakeProvider(AIProviderError("ai_unreachable", "нет")))
    assert broken.queries == () and broken.error == "ai_unreachable"


def test_the_summary_has_codes_and_counts_only() -> None:
    result = ask(FakeProvider(queries("задержка между повторными попытками")))
    result.added_passages = 2
    summary = json.dumps(result.summary(), ensure_ascii=False)
    assert '"queries": 1' in summary and '"added_passages": 2' in summary
    assert "задержка" not in summary and "пауза" not in summary
