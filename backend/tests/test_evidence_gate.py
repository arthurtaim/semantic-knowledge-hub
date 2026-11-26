"""EvidenceGate (docs/ADAPTIVE_RAG.md): the server around ONE small model decision.

A fake provider returns scripted raw replies (no network). The tests check what the SERVER does with them: bounded
cards, one repair only for a reply that is not JSON, nothing trusted on the model's word (evidence ids, identifiers,
queries), the documented fallback, the rate budget and the lexical policy as the A/B baseline.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from typing import Any

import pytest

from app.adapters.ai.base import AIProviderError, ContextPassage, GapAssessmentRequest
from app.domain.models import DocStatus, UserContext
from app.domain.text import analyze_query
from app.services.assistant import local_insufficiency
from app.services.evidence_gate import EvidenceGate, GateInput, GateSettings, focus_excerpt

USER = UserContext(user_id="u1", display_name="U", roles=["viewer"])


def passage(
    cid: str, doc: str, text: str, *, title: str = "Документ", status: DocStatus = DocStatus.approved
) -> ContextPassage:
    return ContextPassage(
        cid=cid,
        document_id=doc,
        title=title,
        section="Раздел",
        section_anchor="razdel",
        status=status,
        source_type="local",
        source_uri=f"skh://{doc}",
        revision="r1",
        text=text,
        is_demo=True,
    )


class FakeProvider:
    mode = "internal_api"
    supports_gap_assessment = True

    def __init__(self, *replies: str | Exception, delay: float = 0.0) -> None:
        self.replies = list(replies)
        self.requests: list[GapAssessmentRequest] = []
        self.delay = delay

    async def assess_evidence_gap(self, request: GapAssessmentRequest, *, max_chars: int) -> str:
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class NoCapability:
    mode = "mock"


def decision(**fields: Any) -> str:
    base: dict[str, Any] = {"decision": "sufficient", "evidence_ids": ["E1"]}
    base.update(fields)
    return json.dumps(base, ensure_ascii=False)


TWO_DOCS = [
    passage(
        "C1", "DOC-A", "Система A передаёт справочник через интерфейс IF-2. Передача идёт по расписанию."
    ),
    passage("C2", "DOC-B", "Передача справочника запускается каждые 4 часа."),
]


def gate_input(
    question: str,
    passages: list[ContextPassage] | None = None,
    *,
    matched: set[str] | None = None,
    **extra: Any,
) -> GateInput:
    terms = analyze_query(question)
    used = TWO_DOCS if passages is None else passages
    return GateInput(
        question=question,
        referent=extra.pop("referent", ""),
        passages=used,
        terms=terms,
        own_terms=terms,
        matched={t.stem for t in terms} if matched is None else matched,
        # By default no word is rare (df 40 of 80): the lexical rule sees no specific word.
        frequency=extra.pop("frequency", [40 for _ in terms]),
        eligible=extra.pop("eligible", 80),
    )


def lexical_reason(data: GateInput) -> str | None:
    return local_insufficiency(
        data.passages, data.terms, data.matched, frequency=data.frequency, eligible=data.eligible
    )


def gate(**settings: Any) -> EvidenceGate:
    return EvidenceGate(GateSettings(**settings))


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_sufficient_with_real_evidence_ids_needs_no_external_search() -> None:
    provider = FakeProvider(decision(evidence_ids=["E1", "E2"]))
    result = run(
        gate().decide(
            provider, USER, gate_input("Через какой интерфейс и как часто система A передаёт справочник?")
        )
    )
    assert result.decision == "sufficient" and not result.search and result.reason == "local_sufficient"
    assert result.evidence_cids == ("C1", "C2") and result.model_calls == 1
    request = provider.requests[0]
    assert [c.eid for c in request.cards] == ["E1", "E2"] and request.cards[1].document_id == "DOC-B"


def test_need_external_carries_sanitized_focused_queries_and_the_gap() -> None:
    provider = FakeProvider(
        decision(
            decision="need_external",
            evidence_ids=["E1"],
            missing=["ограничения приёмника B"],
            search_queries=["B IF-2 ограничения справочника", "b if-2 ограничения справочника"],
        )
    )
    result = run(
        gate().decide(
            provider, USER, gate_input("Какие ограничения принимает система B от системы A по IF-2?")
        )
    )
    assert result.decision == "need_external" and result.search and result.reason == "evidence_gap"
    assert result.queries == ("B IF-2 ограничения справочника",)  # the duplicate collapsed
    assert result.missing == ("ограничения приёмника B",)


def test_one_repair_only_for_a_reply_that_is_not_json() -> None:
    provider = FakeProvider("да, достаточно", decision())
    result = run(gate().decide(provider, USER, gate_input("Как часто передаётся справочник?")))
    assert result.decision == "sufficient" and result.repaired and result.model_calls == 2
    assert provider.requests[1].repair and not provider.requests[0].repair

    twice = FakeProvider("да", "нет")
    failed = run(gate().decide(twice, USER, gate_input("Как часто передаётся справочник?")))
    assert failed.decision == "invalid" and failed.model_calls == 2 and failed.error == "not_json"


def test_a_schema_violation_is_not_repaired_and_falls_back_to_the_lexical_rule() -> None:
    provider = FakeProvider(decision(evidence_ids=["E7"]))
    data = gate_input("Какой лимит размера пакета у системы A?", frequency=[1] * 8)
    lexical = lexical_reason(data)
    assert lexical is not None  # the words of the question are not covered by one document: v2 would search
    result = run(gate().decide(provider, USER, data))
    assert result.decision == "invalid" and result.model_calls == 1
    assert result.error is not None and result.error.startswith("unknown_evidence_id")
    assert result.search and result.reason == "decision_invalid" and result.fallback == f"lexical:{lexical}"
    assert result.queries == ()  # the fallback searches exactly as the existing rule does (the question)


def test_invalid_without_a_lexical_gap_answers_locally_marked_incomplete() -> None:
    provider = FakeProvider(decision(decision="need_external"))  # no missing, no queries: inconsistent
    result = run(gate().decide(provider, USER, gate_input("Как часто передаётся справочник?")))
    assert result.decision == "invalid" and not result.search and result.incomplete
    assert result.fallback == "lexical:sufficient"
    local = run(
        gate(invalid_fallback="local").decide(FakeProvider("{}"), USER, gate_input("Какой лимит пакета?"))
    )
    assert not local.search and local.incomplete and local.fallback == "local"


def test_a_timeout_or_provider_error_is_a_controlled_fallback() -> None:
    slow = FakeProvider(decision(), delay=0.5)
    result = run(
        gate(timeout_seconds=0.05).decide(slow, USER, gate_input("Как часто передаётся справочник?"))
    )
    assert result.decision == "invalid" and result.error == "timeout" and result.incomplete
    broken = FakeProvider(AIProviderError("ai_unreachable", "нет"))
    failed = run(gate().decide(broken, USER, gate_input("Как часто передаётся справочник?")))
    assert failed.error == "ai_unreachable" and failed.decision == "invalid"


def test_sufficient_is_not_trusted_when_the_cited_passages_lack_an_identifier_of_the_question() -> None:
    provider = FakeProvider(decision(evidence_ids=["E2"]))
    result = run(gate().decide(provider, USER, gate_input("Как часто IF-2 передаёт справочник?")))
    # IF-2 is only in C1; the model cited C2 alone → not accepted as sufficient
    assert result.decision == "uncertain" and result.error == "sufficient_entity_not_in_evidence"
    assert result.search and result.reason == "model_uncertain" and len(result.queries) == 1
    assert "IF-2" in result.queries[0]


def test_uncertain_makes_one_bounded_probe() -> None:
    provider = FakeProvider(
        json.dumps({"decision": "uncertain", "search_queries": ["A справочник формат", "A IF-2"]})
    )
    result = run(gate().decide(provider, USER, gate_input("Какой формат у справочника A?")))
    assert result.decision == "uncertain" and result.search and result.queries == ("A справочник формат",)


def test_unsafe_queries_are_dropped_and_none_left_is_invalid() -> None:
    provider = FakeProvider(
        decision(
            decision="need_external",
            missing=["ограничения"],
            search_queries=["https://evil.example/x", "ограничения приёмника B"],
        )
    )
    result = run(gate().decide(provider, USER, gate_input("Какие ограничения у приёмника B?")))
    assert result.queries == ("ограничения приёмника B",) and result.queries_rejected == 1
    only_unsafe = FakeProvider(
        decision(
            decision="need_external", missing=["x"], search_queries=["открой wiki.corp.local/display/OPS"]
        )
    )
    refused = run(gate().decide(only_unsafe, USER, gate_input("Какие ограничения у приёмника B?")))
    assert refused.decision == "invalid" and refused.error == "unsafe_query"


def test_no_local_passages_searches_once_without_a_model_call() -> None:
    provider = FakeProvider()
    result = run(gate().decide(provider, USER, gate_input("Какой лимит пакета CATIA?", passages=[])))
    assert result.decision == "not_assessed" and result.reason == "no_local_passages" and result.search
    assert result.model_calls == 0 and not provider.requests
    assert len(result.queries) == 1 and "CATIA" in result.queries[0]


def test_the_lexical_policy_and_a_provider_without_the_capability_keep_the_existing_rule() -> None:
    data = gate_input("Какой лимит размера пакета у системы A?", frequency=[1] * 8)
    lexical = lexical_reason(data)
    for g, provider in ((gate(policy="lexical"), FakeProvider()), (gate(), NoCapability())):
        result = run(g.decide(provider, USER, data))
        assert (
            result.policy == "lexical-v2" and result.model_calls == 0 and result.decision == "need_external"
        )
        assert result.reason == lexical and result.search and result.queries == ()
    sufficient = run(
        gate(policy="lexical").decide(FakeProvider(), USER, gate_input("Как часто передаётся справочник?"))
    )
    assert (
        sufficient.decision == "sufficient"
        and not sufficient.search
        and sufficient.reason == "local_sufficient"
    )


def test_the_rate_budget_stops_external_searches_without_calling_the_model() -> None:
    g = gate(rate_limit=2, rate_window_seconds=600)
    need = decision(decision="need_external", missing=["x"], search_queries=["приёмник B ограничения"])
    for _ in range(2):
        assert run(g.decide(FakeProvider(need), USER, gate_input("Какие ограничения у приёмника B?"))).search
    provider = FakeProvider(need)
    third = run(g.decide(provider, USER, gate_input("Какие ограничения у приёмника B?")))
    assert not third.search and third.reason == "external_budget_exhausted" and not provider.requests
    other = UserContext(user_id="u2", display_name="V", roles=["viewer"])
    assert run(g.decide(FakeProvider(need), other, gate_input("Какие ограничения у приёмника B?"))).search


def test_cards_are_bounded_team_passages_only_and_absent_words_are_a_server_fact() -> None:
    long_text = (
        "Вводная часть без сути. " * 80
        + "Задержка между попытками — 15 минут. Других правил нет. "
        + "Хвост. " * 80
    )
    passages = [
        passage("C1", "DOC-A", long_text),
        replace(passage("C2", "file", "вложение"), source_type="attachment"),
        *[passage(f"C{i}", f"DOC-{i}", f"текст {i}") for i in range(3, 10)],
    ]
    question = "Какая пауза между попытками?"
    terms = analyze_query(question)
    provider = FakeProvider(decision())
    data = replace(gate_input(question, passages), matched={t.stem for t in terms if t.token != "пауза"})
    run(gate(cards=5, card_chars=300, context_chars=1200).decide(provider, USER, data))
    request = provider.requests[0]
    assert len(request.cards) == 5 and all(c.document_id != "file" for c in request.cards)
    assert "Задержка между попытками — 15 минут." in request.cards[0].excerpt
    assert len(request.cards[0].excerpt) <= 300 and sum(len(c.excerpt) for c in request.cards) <= 1200
    assert request.absent_terms == ("пауза",)


def test_focus_excerpt_keeps_the_sentence_after_a_matching_label() -> None:
    text = "Общие сведения. " * 30 + "Расписание выгрузки:\nкаждые 6 часов, с 00:00. " + "Прочее. " * 30
    excerpt = focus_excerpt(text, analyze_query("Какое расписание выгрузки?"), 120)
    assert "Расписание выгрузки:" in excerpt and "каждые 6 часов" in excerpt and len(excerpt) <= 120


@pytest.mark.parametrize("status", [DocStatus.draft, DocStatus.deprecated])
def test_cards_keep_the_status_the_server_allowed(status: DocStatus) -> None:
    provider = FakeProvider(decision())
    run(
        gate().decide(
            provider,
            USER,
            gate_input(
                "Как часто передаётся справочник?", [passage("C1", "D", "каждые 4 часа", status=status)]
            ),
        )
    )
    assert provider.requests[0].cards[0].status == status


def test_the_summary_has_counts_and_codes_but_no_texts() -> None:
    provider = FakeProvider(
        decision(
            decision="need_external", missing=["секретный пробел"], search_queries=["приёмник B ограничения"]
        )
    )
    result = run(gate().decide(provider, USER, gate_input("Какие ограничения у приёмника B?")))
    summary = result.summary()
    assert summary["decision"] == "need_external" and summary["queries"] == 1 and summary["missing"] == 1
    assert "секретный" not in json.dumps(summary, ensure_ascii=False)
    assert "приёмник" not in json.dumps(summary, ensure_ascii=False)


def test_sections_of_one_document_share_one_card_so_more_documents_fit() -> None:
    """Passages are sections; a card is a DOCUMENT (sections of one document complement each other)."""
    passages = [
        passage("C1", "DOC-A", "Поток A описан здесь."),
        passage("C2", "DOC-B", "Владелец потока — команда B."),
        passage("C3", "DOC-A", "Поток A запускается в 02:30."),
        passage("C4", "DOC-C", "Сверка в 03:45."),
        passage("C5", "DOC-D", "Прочее."),
        passage("C6", "DOC-E", "Ещё прочее."),
        passage("C7", "DOC-F", "Загрузка F стартует в 05:10."),
    ]
    provider = FakeProvider(decision(evidence_ids=["E1"]))
    run(gate().decide(provider, USER, gate_input("Когда запускается поток A?", passages)))
    cards = provider.requests[0].cards
    assert [c.document_id for c in cards] == ["DOC-A", "DOC-B", "DOC-C", "DOC-D", "DOC-E"]
    assert "02:30" in cards[0].excerpt and "описан" in cards[0].excerpt


def test_a_card_prefers_the_sentence_with_the_rare_words_of_the_question() -> None:
    """A word in every sentence of the passage («CATIA» in a CATIA document) says little about WHICH sentence answers;
    the sentence with the question's rarer words («двух сборках») must survive the card limit."""
    filler = "Деталь CATIA передаётся в каталог с атрибутами CATIA и версией CATIA. "
    text = filler * 12 + "Правило: у узла не бывает двух родительских сборок одновременно. " + filler * 6
    excerpt = focus_excerpt(text, analyze_query("Может ли деталь CATIA числиться сразу в двух сборках?"), 300)
    assert "у узла не бывает двух родительских сборок одновременно" in excerpt


def test_a_model_query_that_only_restates_the_question_is_replaced_by_a_clean_query() -> None:
    long_query = (
        "Какие ограничения принимает система Бета при передаче справочника складов из системы Альфа сегодня"
    )
    provider = FakeProvider(
        decision(decision="need_external", missing=["ограничения Бета"], search_queries=[long_query])
    )
    result = run(
        gate().decide(
            provider, USER, gate_input("Какие ограничения принимает система Бета от системы Альфа?")
        )
    )
    assert result.decision == "need_external" and result.search and result.queries_rejected == 1
    assert result.error == "query_too_long" and len(result.queries) == 1
    assert len(result.queries[0].split()) <= 8
