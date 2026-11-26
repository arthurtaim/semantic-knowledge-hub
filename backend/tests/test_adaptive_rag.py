"""Local-first adaptive RAG end to end (docs/ADAPTIVE_RAG.md; acceptance matrix LF-01…LF-26).

A NEW synthetic mini-corpus (a warehouse reference flow Альфа → Бета over IF-7; nothing from the gold evaluation)
and a synthetic Confluence corpus served by the mock connector. The model is a scripted double
(app/evaluation/gap_doubles.py) whose answers are the extractive mock's — only the gap decision is scripted, so every
assertion is about what the SERVER does with it: sources, statuses, ACL, budgets, queries, citations.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from app.adapters.ai.base import AIProviderError, GapAssessmentRequest
from app.adapters.corporate.mock import MockCorporateConnector, MockState
from app.evaluation.gap_doubles import (
    ScriptedGapProvider,
    always_external_script,
    always_sufficient_script,
    need_external,
    sufficient,
    uncertain,
)
from tests.conftest import make_doc

BOTH = ["team", "corporate"]

LOCAL_DOCS = {
    "LF-DOC-01": (
        "Поток справочника складов из Альфа в Бета",
        "approved",
        "## Назначение\n\nСистема Альфа передаёт справочник складов в систему Бета через интерфейс IF-7.\n\n"
        "## Расписание\n\nПередача справочника складов запускается каждые 4 часа.\n",
    ),
    "LF-DOC-02": (
        "Ответственные за справочник складов",
        "approved",
        "## Роли\n\nВладелец справочника складов — команда логистики. "
        "Ответственный за поток IF-7 — дежурный инженер интеграций.\n",
    ),
    "LF-DOC-03": (
        "Повторы при сбоях потока IF-7",
        "approved",
        "## Повторные попытки\n\nЗадержка между повторными попытками — 15 минут. После трёх неудачных попыток "
        "запись уходит в очередь ошибок.\n",
    ),
    "LF-DOC-04": (
        "Черновые правила проверки справочника складов",
        "draft",
        "## Проверки\n\nСистема Бета отклоняет записи справочника складов без кода склада.\n",
    ),
    "LF-DOC-05": (
        "Глоссарий логистики",
        "approved",
        "## Термины\n\nСклад — место хранения товара. Справочник — список значений, общий для систем.\n",
    ),
}

PAGES: list[dict[str, Any]] = [
    {
        "page_id": "300001",
        "space": "OPS",
        "title": "Требования системы Бета к входным справочникам",
        "status": "unknown",
        "version": 2,
        "body": "<h2>Формат</h2><p>Система Бета принимает справочник складов только в формате CSV в кодировке "
        "UTF-8.</p><h2>Обязательные поля</h2><p>Обязательные поля справочника складов: код склада, адрес и "
        "часовой пояс. Записи без часового пояса отклоняются.</p>",
    },
    {
        "page_id": "300003",
        "space": "ARCH",
        "title": "Расписание потока справочника складов — копия",
        "status": "approved",
        "canonical_document_id": "LF-DOC-01",
        "body": "<p>Копия из базы знаний. Передача справочника складов запускается каждые 4 часа.</p>",
    },
    {
        "page_id": "300004",
        "space": "OPS",
        "title": "Лимиты системы Бета для справочника складов",
        "allowed_users": ["another-user"],
        "body": "<p>RESTRICTED-LF-MARKER: Бета принимает не более 5000 складов за одну передачу.</p>",
    },
    {
        "page_id": "300005",
        "space": "OPS",
        "title": "Заметки дежурного о расписании справочника складов",
        "status": "unknown",
        "body": "<p>По заметкам дежурного передача справочника складов запускается каждые 2 часа.</p>",
    },
    {
        "page_id": "300007",
        "space": "OPS",
        "title": "Окно обслуживания портала Дельта",
        "status": "approved",
        "body": "<p>Портал Дельта недоступен по субботам с 01:00 до 03:00 (окно обслуживания).</p>",
    },
    {
        "page_id": "300006",
        "space": "OPS",
        "title": "Окно обслуживания системы Бета",
        "status": "approved",
        "body": "<p>Окно обслуживания системы Бета — по воскресеньям с 02:00 до 04:00.</p>",
    },
]

QUESTION_GAP = "Какие требования предъявляет система Бета к справочнику складов от системы Альфа по IF-7?"
GAP_REPLY = need_external(
    ["требования Бета к формату и обязательным полям справочника складов"],
    ["Бета справочник складов формат обязательные поля"],
    evidence=["E1"],
)


def noise_pages(count: int) -> list[dict[str, Any]]:
    """A large noisy wiki: pages that repeat the general words of the question, none states a requirement."""
    return [
        {
            "page_id": str(310000 + i),
            "space": "DEMO",
            "title": f"Вопросы по передаче справочника складов Альфа и Бета №{i}",
            "status": "approved",
            "body": f"<p>Система Альфа передаёт справочник складов в систему Бета по IF-7. Требования и вопросы "
            f"обсуждаются на встрече №{i}; протокол встречи будет позже.</p>",
        }
        for i in range(count)
    ]


Factory = Callable[..., tuple[TestClient, ScriptedGapProvider, MockCorporateConnector]]


@pytest.fixture
def lf(tmp_path: Path, client_factory: Callable[..., TestClient]) -> Factory:
    root = tmp_path / "lf-kb"
    root.mkdir()
    for doc_id, (title, status, body) in LOCAL_DOCS.items():
        (root / f"{doc_id}.md").write_text(
            make_doc(doc_id, title=title, status=status, body=f"# {title}\n\n{body}"), encoding="utf-8"
        )

    def factory(
        script: Callable[[GapAssessmentRequest], str | Exception] = always_sufficient_script,
        *,
        noise: int = 0,
        delay: float = 0.0,
        **overrides: Any,
    ) -> tuple[TestClient, ScriptedGapProvider, MockCorporateConnector]:
        corpus = tmp_path / f"lf-confluence-{noise}.yaml"
        corpus.write_text(
            yaml.safe_dump({"pages": PAGES + noise_pages(noise)}, allow_unicode=True), encoding="utf-8"
        )
        client = client_factory(
            local_knowledge_dir=root,
            confluence_connector="mock",
            confluence_mock_pages_path=corpus,
            confluence_mock_state_path=tmp_path / "lf-state.json",
            **overrides,
        )
        container = client.app.state.container  # type: ignore[attr-defined]
        provider = ScriptedGapProvider(script, delay=delay)
        container.assistant._provider = provider
        return client, provider, container.corporate

    return factory


def ask(client: TestClient, question: str, sources: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    response = client.post(
        "/api/assistant/ask", json={"question": question, "sources": sources or BOTH, **extra}
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def stream(
    client: TestClient, question: str, sources: list[str] | None = None, **extra: Any
) -> list[dict[str, Any]]:
    response = client.post(
        "/api/assistant/ask/stream", json={"question": question, "sources": sources or BOTH, **extra}
    )
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def context_ids(client: TestClient, answer: dict[str, Any]) -> list[str]:
    """Sources the answer had in context (the query graph of its trace), team and external."""
    graph = client.get(f"/api/graph/query/{answer['retrieval_trace_id']}").json()
    return [n["id"] for n in graph["nodes"]]


def cited(answer: dict[str, Any]) -> set[str]:
    return {c["document_id"] for c in answer["citations"]}


def by(
    predicate: Callable[[GapAssessmentRequest], bool], yes: str, no: str
) -> Callable[[GapAssessmentRequest], str]:
    return lambda request: yes if predicate(request) else no


# --- LF-01 / LF-04: sufficient local evidence (several documents, other words) -------------------------------------


def test_lf01_facts_in_two_documents_are_sufficient_without_any_external_call(lf: Factory) -> None:
    client, _provider, connector = lf(lambda r: sufficient("E1", "E2"))
    answer = ask(client, "Как часто передаётся справочник складов и кто его владелец?")
    gate = answer["evidence_gate"]
    assert gate["decision"] == "sufficient" and gate["policy"] == "semantic-v1" and gate["model_calls"] == 1
    assert answer["external"] is None and connector.calls == {"search": 0, "get_page": 0}
    assert {"LF-DOC-01", "LF-DOC-02"} <= cited(answer)
    corporate = next(s for s in answer["scopes"] if s["scope"] == "corporate")
    assert "Не понадобились" in corporate["message"]


def test_lf04_a_paraphrase_is_not_a_reason_to_search_externally(lf: Factory) -> None:
    """«пауза» is in no team document (df = 0), the documented word is «задержка»: the lexical rule searches,
    the model reads the meaning — and the server follows it."""
    client, provider, connector = lf(lambda r: sufficient("E1"))
    answer = ask(client, "Какая пауза между повторными попытками в потоке IF-7?")
    gate = answer["evidence_gate"]
    assert gate["lexical"] is not None  # LOCAL_SUFFICIENCY v2 alone would call Confluence here
    assert gate["decision"] == "sufficient" and answer["external"] is None
    assert connector.calls["search"] == 0
    assert provider.calls[0].absent_terms == ("пауза",)  # a server fact the model weighs, not a routing rule
    assert "doc:LF-DOC-03" in context_ids(client, answer)


# --- LF-02 / LF-03 / LF-21 / LF-22: a real gap ------------------------------------------------------------------


def test_lf02_no_local_passage_searches_once_without_a_model_call(lf: Factory) -> None:
    client, provider, _connector = lf()
    answer = ask(client, "Когда окно обслуживания портала Дельта?")
    gate = answer["evidence_gate"]
    assert gate["reason"] == "no_local_passages" and gate["model_calls"] == 0 and not provider.calls
    assert answer["external"]["called"] and answer["external"]["searches"] == 1
    assert "300007" in cited(answer)
    assert "нет в Confluence" not in answer["answer"] and "не существует" not in answer["answer"]


def test_lf03_a_gap_is_searched_with_a_focused_query_and_local_evidence_is_kept(lf: Factory) -> None:
    client, provider, _connector = lf(lambda r: GAP_REPLY)
    answer = ask(client, QUESTION_GAP)
    gate, external = answer["evidence_gate"], answer["external"]
    assert gate["decision"] == "need_external" and gate["reason"] == "evidence_gap" and gate["queries"] == 1
    assert external["trigger"] == "evidence_gap" and external["focused"] and external["searches"] == 1
    assert external["outcome"] == "found"
    nodes = " ".join(context_ids(client, answer))
    assert "300001" in nodes and "LF-DOC-01" in nodes  # the gap page AND the local evidence are in context
    # the model saw the excerpts, not the documents; the gap goes to the answering model as data
    assert provider.calls[0].cards[0].document_id == "LF-DOC-01"


def test_lf21_two_independent_aspects_give_two_focused_searches_at_most(lf: Factory) -> None:
    reply = need_external(
        ["формат справочника складов в Бета", "окно обслуживания Бета"],
        ["Бета справочник складов формат CSV", "Бета окно обслуживания"],
    )
    client, _provider, connector = lf(lambda r: reply)
    answer = ask(
        client,
        "В каком формате Бета принимает справочник складов от Альфа и когда у Бета окно обслуживания? "
        "Also, which encoding is required for the warehouse reference?",
    )
    assert answer["external"]["searches"] == 2 and connector.calls["search"] == 2
    assert connector.calls["get_page"] <= 3  # the fetch budget is shared by both queries
    nodes = " ".join(context_ids(client, answer))
    assert "300001" in nodes and "300006" in nodes


def test_lf22_an_identifier_of_the_question_stays_in_the_query(lf: Factory) -> None:
    reply = need_external(["ограничения приёма"], ["ограничения приёма справочника складов"], evidence=["E1"])
    client, _provider, connector = lf(lambda r: reply)
    seen: list[str] = []
    original = connector.search

    async def spy(query: str, user: Any, limit: int = 5) -> Any:
        seen.append(query)
        return await original(query, user, limit)

    connector.search = spy  # type: ignore[method-assign]
    ask(client, "Какие ограничения приёма у интерфейса IF-7 для справочника складов?")
    assert seen and all("IF-7" in q for q in seen)


# --- LF-05: a large noisy wiki --------------------------------------------------------------------------------------


def test_lf05_a_focused_query_finds_the_requirement_among_many_similar_pages(lf: Factory) -> None:
    client, _provider, _connector = lf(lambda r: GAP_REPLY, noise=120)
    answer = ask(client, QUESTION_GAP)
    external = answer["external"]
    assert external["candidates"] <= 10 and external["fetched"] <= 3 and external["fragments"] <= 6
    assert "300001" in " ".join(context_ids(client, answer))

    # The previous behaviour on the same corpus: LOCAL_SUFFICIENCY v2 finds the question's words in the team
    # documents and calls it sufficient (a false negative: no document states the requirements) …
    lexical, _provider, _connector = lf(lambda r: GAP_REPLY, noise=120, external_gate="lexical")
    old = ask(lexical, QUESTION_GAP)
    assert old["evidence_gate"]["policy"] == "lexical-v2" and old["evidence_gate"]["decision"] == "sufficient"
    assert old["external"] is None
    # … and even a forced search with the whole question fills the bounded shortlist with the similar pages.
    forced = ask(lexical, QUESTION_GAP, search_external=True)
    assert forced["external"]["fetched"] == 3
    assert "300001" not in " ".join(context_ids(lexical, forced))


# --- LF-06 / LF-10: conflicts and duplicates ------------------------------------------------------------------------


def test_lf06_an_external_page_never_replaces_an_approved_local_fact(lf: Factory) -> None:
    reply = need_external(["подтверждение расписания"], ["расписание справочника складов"], evidence=["E1"])
    client, _provider, _connector = lf(lambda r: reply)
    answer = ask(client, "Как часто запускается передача справочника складов по расписанию?")
    team = [c for c in answer["citations"] if c["source_kind"] != "confluence_mcp"]
    external = [c for c in answer["citations"] if c["source_kind"] == "confluence_mcp"]
    assert team and team[0]["document_id"] == "LF-DOC-01" and team[0]["status"] == "approved"
    assert answer["citations"][0]["source_kind"] != "confluence_mcp"  # the team document is cited first
    for citation in external:  # a separate source with its own (unconfirmed) status, never «approved» by us
        assert citation["external_status"] in ("unknown", "approved", "draft") and citation["status"] is None
    if any(c["document_id"] == "300005" for c in external):
        assert any("статус которых не подтверждён" in w for w in answer["warnings"])


def test_lf10_a_confluence_copy_of_an_approved_document_is_not_second_evidence(lf: Factory) -> None:
    reply = need_external(["копия расписания"], ["расписание потока справочника складов копия"])
    client, _provider, _connector = lf(lambda r: reply)
    answer = ask(client, "Как часто запускается передача справочника складов?")
    assert {"page_id": "300003", "version": "1", "reason": "duplicate_of:LF-DOC-01"} in answer["external"][
        "rejected"
    ]
    assert "300003" not in cited(answer)


# --- LF-07 / LF-08 / LF-09 / LF-20: the user's scope is a server policy ---------------------------------------------


def test_lf07_team_scope_never_calls_confluence_or_the_gap_model(lf: Factory) -> None:
    client, provider, connector = lf(always_external_script)
    answer = ask(client, QUESTION_GAP, sources=["team"])
    assert answer["external"] is None and answer["evidence_gate"] is None
    assert connector.calls == {"search": 0, "get_page": 0} and not provider.calls


def test_lf08_corporate_scope_searches_without_a_local_first_decision(lf: Factory) -> None:
    client, provider, _connector = lf(always_sufficient_script)
    answer = ask(client, "Когда окно обслуживания системы Бета?", sources=["corporate"])
    assert answer["evidence_gate"]["reason"] == "external_scope_selected" and not provider.calls
    assert answer["external"]["called"] and "300006" in cited(answer)


def test_lf09_explicit_external_search_is_forced_without_claiming_a_local_gap(lf: Factory) -> None:
    client, provider, _connector = lf(always_sufficient_script)
    answer = ask(client, "Как часто передаётся справочник складов?", search_external=True)
    gate = answer["evidence_gate"]
    assert gate["reason"] == "explicit_request" and gate["decision"] == "not_assessed" and not provider.calls
    assert answer["external"]["trigger"] == "explicit_request"
    assert not any("недостаточн" in w.casefold() for w in answer["warnings"])


def test_lf20_a_follow_up_is_re_scoped_by_the_server(lf: Factory) -> None:
    client, provider, connector = lf(always_external_script)
    first = ask(client, QUESTION_GAP)
    assert first["external"]["called"]
    history = [{"question": QUESTION_GAP, "answer": first["answer"]}]
    before = dict(connector.calls)
    follow_up = ask(client, "А в какой кодировке?", sources=["team"], history=history)
    assert follow_up["external"] is None and connector.calls == before  # history never widens the scope
    calls = len(provider.calls)
    again = ask(client, "А в какой кодировке?", history=history)
    assert len(provider.calls) == calls + 1 and provider.calls[-1].referent == QUESTION_GAP
    assert again["evidence_gate"]["decision"] == "need_external"


# --- LF-11 / LF-12 / LF-19 / LF-26: what the external source can honestly say ---------------------------------------


def test_lf11_lf26_a_revoked_or_changed_page_is_never_cited_from_the_cache(
    lf: Factory, tmp_path: Path
) -> None:
    client, _provider, _connector = lf(lambda r: GAP_REPLY)
    first = ask(client, QUESTION_GAP)
    assert "300001" in " ".join(context_ids(client, first))
    state = MockState.load(tmp_path / "lf-state.json")
    state.revoked.add("300001")
    state.save(tmp_path / "lf-state.json")
    second = ask(client, QUESTION_GAP)
    # other pages may come from the cache after a fresh search; the revoked one never does
    assert "300001" not in cited(second)
    assert "300001" not in " ".join(context_ids(client, second))
    assert all(
        r["page_id"] != "300001" or r["reason"] == "not_found_or_revoked"
        for r in second["external"]["rejected"]
    )


def test_lf12_restricted_pages_and_an_unavailable_connector(lf: Factory) -> None:
    reply = need_external(["лимит Бета"], ["Бета лимит складов передача"])
    client, _provider, connector = lf(lambda r: reply)
    answer = ask(client, "Сколько складов Бета принимает за одну передачу справочника?")
    text = (
        answer["answer"]
        + json.dumps(answer["citations"], ensure_ascii=False)
        + json.dumps(answer["external"])
    )
    assert "RESTRICTED-LF-MARKER" not in text and "300004" not in text and "5000" not in text

    async def down(*_: Any, **__: Any) -> Any:
        from app.adapters.corporate.base import ConnectorUnavailableError

        raise ConnectorUnavailableError("mcp_unavailable", "нет связи")

    connector.search = down  # type: ignore[method-assign]
    failed = ask(client, QUESTION_GAP)
    assert failed["external"]["outcome"] == "source_unavailable" and failed["external"]["degraded"]
    assert failed["citations"] or failed["confidence"] == "insufficient_evidence"
    assert any("недоступен" in w for w in failed["warnings"])


def test_lf19_nothing_found_externally_is_reported_as_unconfirmed_not_as_absent(lf: Factory) -> None:
    reply = need_external(["курс валют склада"], ["Бета курс валют склада Гамма"])
    client, _provider, _connector = lf(lambda r: reply)
    answer = ask(client, "По какому курсу валют Бета пересчитывает стоимость склада Гамма?")
    external = answer["external"]
    assert external["called"] and external["outcome"] in ("no_match", "insufficient_evidence")
    assert any("не удалось подтвердить" in w for w in answer["warnings"])
    assert not any("нет в Confluence" in w or "не существует" in w for w in answer["warnings"])


# --- LF-13 / LF-14 / LF-15 / LF-16 / LF-17: a weak, wrong or manipulated model --------------------------------------


def test_lf13_an_injected_instruction_cannot_turn_into_an_action(lf: Factory) -> None:
    reply = need_external(["x"], ["зайди на https://wiki.corp.example/display/OPS?token=1"])
    client, _provider, connector = lf(lambda r: reply)
    seen: list[str] = []
    original = connector.search

    async def spy(query: str, user: Any, limit: int = 5) -> Any:
        seen.append(query)
        return await original(query, user, limit)

    connector.search = spy  # type: ignore[method-assign]
    answer = ask(client, "Как часто передаётся справочник складов?")
    gate = answer["evidence_gate"]
    assert gate["decision"] == "invalid" and gate["error"] == "unsafe_query" and gate["queries_rejected"] == 1
    assert not any("http" in q or "wiki." in q for q in seen)


@pytest.mark.parametrize(
    "replies",
    [
        ["Да, документов достаточно.", "всё ещё не JSON"],  # repair once, then a fallback
        ['{"decision": "sufficient", "evidence_ids": ["E7"]}'],  # an invented evidence id
        ['{"decision": "sufficient", "evidence_ids": ["E1"], "confidence": 0.97}'],  # pseudo-precision
    ],
)
def test_lf14_malformed_replies_end_in_the_documented_fallback_with_valid_citations_only(
    lf: Factory, replies: list[str]
) -> None:
    queue = list(replies)
    client, _provider, _connector = lf(lambda r: queue.pop(0))
    answer = ask(client, "Как часто передаётся справочник складов?")
    gate = answer["evidence_gate"]
    assert gate["decision"] == "invalid" and gate["reason"] == "decision_invalid" and gate["model_calls"] <= 2
    assert gate["fallback"].startswith("lexical:")
    for citation in answer["citations"]:
        assert citation["document_id"] in LOCAL_DOCS or citation["source_kind"] == "confluence_mcp"
    if not answer["external"]:
        assert gate["incomplete"] and answer["confidence"] != "supported"
        assert any("полноту ответа" in w.casefold() for w in answer["warnings"])


def test_lf15_a_confident_sufficient_without_the_identifier_is_not_accepted(lf: Factory) -> None:
    client, _provider, _connector = lf(lambda r: sufficient("E1"))
    answer = ask(client, "Какой SLA у интерфейса IF-9 для справочника складов?")
    gate = answer["evidence_gate"]
    assert gate["decision"] in ("uncertain", "not_assessed") and gate["external_called"]
    if gate["decision"] == "uncertain":
        assert gate["error"] == "sufficient_entity_not_in_evidence"


def test_lf16_a_model_that_always_asks_for_more_is_bounded_by_the_rate_budget(lf: Factory) -> None:
    client, _provider, connector = lf(always_external_script, external_gate_rate_limit=3)
    gates = [
        ask(client, f"Кто владелец справочника складов, вариант {i}?")["evidence_gate"] for i in range(5)
    ]
    assert [g["external_called"] for g in gates] == [True, True, True, False, False]
    assert gates[-1]["reason"] == "external_budget_exhausted" and gates[-1]["model_calls"] == 0
    assert connector.calls["search"] == 3


def test_lf17_duplicate_queries_are_searched_once(lf: Factory) -> None:
    reply = need_external(["формат"], ["Бета формат справочника складов", "бета  формат справочника складов"])
    client, _provider, connector = lf(lambda r: reply)
    answer = ask(client, QUESTION_GAP)
    assert answer["external"]["searches"] == 1 and connector.calls["search"] == 1


# --- LF-18: the stream and /ask are the same pipeline ---------------------------------------------------------------


def test_lf18_stream_and_ask_give_the_same_decision_sources_and_calls(lf: Factory) -> None:
    client, provider, connector = lf(lambda r: GAP_REPLY)
    plain = ask(client, QUESTION_GAP)
    calls_plain = dict(connector.calls)
    events = stream(client, QUESTION_GAP)
    final = next(e for e in events if e["type"] == "final")["response"]
    steps = [e.get("step") for e in events if e["type"] == "status" and e.get("step")]
    assert steps == ["assessing", "external"]
    for key in ("decision", "reason", "queries", "model_calls"):
        assert final["evidence_gate"][key] == plain["evidence_gate"][key]
    assert cited(final) == cited(plain)
    assert final["external"]["searches"] == plain["external"]["searches"]
    # one preparation per request: the second request made exactly as many MCP calls as the first
    assert connector.calls["search"] == 2 * calls_plain["search"]
    assert len(provider.calls) == 2


# --- LF-23 / LF-24 / LF-25: statuses, providers without the capability, time limits ---------------------------------


def test_lf23_a_draft_never_becomes_evidence_for_the_gap_model(lf: Factory) -> None:
    client, provider, _connector = lf(lambda r: sufficient("E1"))
    answer = ask(client, "Какие записи справочника складов отклоняет система Бета?")
    for request in provider.calls:
        assert all(card.document_id != "LF-DOC-04" for card in request.cards)
    assert "LF-DOC-04" not in cited(answer)
    excluded = {e["document_id"] for e in answer["excluded_sources"]}
    assert "LF-DOC-04" in excluded or not excluded


def test_lf24_the_offline_mock_keeps_the_lexical_rule_and_simulates_nothing(
    tmp_path: Path, client_factory: Callable[..., TestClient], lf: Factory
) -> None:
    client, _provider, _connector = lf()
    container = client.app.state.container  # type: ignore[attr-defined]
    from app.adapters.ai.mock import MockAIProvider

    container.assistant._provider = MockAIProvider()
    answer = ask(client, "Как часто передаётся справочник складов?")
    gate = answer["evidence_gate"]
    assert gate["policy"] == "lexical-v2" and gate["model_calls"] == 0 and gate["cards"] == 0


def test_lf25_a_slow_model_and_a_slow_wiki_degrade_within_the_time_limits(lf: Factory) -> None:
    client, _provider, _connector = lf(
        lambda r: GAP_REPLY, delay=0.5, external_gate_timeout_seconds=0.1, external_deadline_seconds=0.2
    )
    answer = ask(client, "Как часто передаётся справочник складов?")
    gate = answer["evidence_gate"]
    assert gate["decision"] == "invalid" and gate["error"] == "timeout"

    async def slow(query: str, user: Any, limit: int = 5) -> Any:
        import asyncio

        await asyncio.sleep(1.0)
        return []

    fast_model, _p, slow_wiki = lf(lambda r: GAP_REPLY, external_deadline_seconds=0.2)
    slow_wiki.search = slow  # type: ignore[method-assign]
    degraded = ask(fast_model, QUESTION_GAP)
    assert degraded["external"]["outcome"] == "source_unavailable"
    assert any("не ответил вовремя" in w for w in degraded["warnings"])


def test_a_provider_error_of_the_gap_call_is_a_fallback_not_a_failed_answer(lf: Factory) -> None:
    client, _provider, _connector = lf(lambda r: AIProviderError("ai_unreachable", "нет связи"))
    answer = ask(client, "Как часто передаётся справочник складов?")
    assert answer["evidence_gate"]["error"] == "ai_unreachable" and answer["answer"]


def test_uncertain_probes_once_and_never_claims_sufficiency(lf: Factory) -> None:
    client, _provider, connector = lf(lambda r: uncertain())
    answer = ask(client, "Кто отвечает за поток IF-7?")
    gate = answer["evidence_gate"]
    assert gate["decision"] == "uncertain" and gate["external_called"] and gate["queries"] == 1
    assert connector.calls["search"] == 1
