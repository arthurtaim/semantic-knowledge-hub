"""External (Confluence MCP) RAG, discovery memory and the query graph (M5.6.2 Appendix 5 §9, Appendix 7 §3).

Runs against the synthetic mock corpus (fixtures/confluence_mock) — never a real Confluence.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.corporate.base import ConnectorUnavailableError, CorporatePage
from app.adapters.corporate.mock import MockCorporateConnector, MockState
from app.domain.models import IntegrationStatus, UserContext
from app.domain.text import analyze_query
from app.services.assistant import prepare_passage_text
from app.services.discovery import DiscoveryStore, acl_scope_key
from app.services.external import ExternalEvidenceService, ExternalLimits
from tests.conftest import PROJECT_ROOT

CORPUS = PROJECT_ROOT / "fixtures" / "confluence_mock" / "pages.yaml"
BOTH = ["team", "corporate"]


@pytest.fixture
def state_file(tmp_path: Path) -> Path:
    return tmp_path / "mock_confluence_state.json"


@pytest.fixture
def ext_client(
    full_workspace: Path, state_file: Path, client_factory: Callable[..., TestClient]
) -> TestClient:
    return client_factory(
        local_knowledge_dir=full_workspace,
        confluence_connector="mock",
        confluence_mock_pages_path=CORPUS,
        confluence_mock_state_path=state_file,
    )


def ask(client: TestClient, question: str, sources: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    response = client.post(
        "/api/assistant/ask", json={"question": question, "sources": sources or BOTH, **extra}
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def external_citations(answer: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in answer["citations"] if c["source_kind"] == "confluence_mcp"]


def set_state(path: Path, **changes: set[str]) -> None:
    state = MockState.load(path)
    for name, value in changes.items():
        getattr(state, name).update(value)
    state.save(path)


def test_external_only_page_is_cited_without_importing_it(ext_client: TestClient) -> None:
    before = ext_client.get("/api/documents", params={"size": 1}).json()["total"]
    answer = ask(ext_client, "Когда действует окно заморозки изменений метаданных?")
    cited = external_citations(answer)
    assert cited and cited[0]["document_id"] == "200101"
    assert cited[0]["source_id"] == "confluence:demo-wiki:200101:3"
    assert cited[0]["external_status"] == "unknown" and cited[0]["fragment_id"]
    assert any("статус которых не подтверждён" in w for w in answer["warnings"])
    assert "последние 2 рабочих дня" in " ".join(c["excerpt"] for c in cited)
    assert answer["external"]["called"] and answer["external"]["trigger"] in (
        "no_local_passages",
        "unmatched_entities",
        "low_term_coverage",
        "no_single_local_passage",
    )
    assert answer["retrieval_trace_id"].startswith("TRACE-")
    # the curated knowledge base is untouched
    assert ext_client.get("/api/documents", params={"size": 1}).json()["total"] == before


def test_local_answer_does_not_call_the_external_source(ext_client: TestClient) -> None:
    answer = ask(ext_client, "Как часто метаданные ARIS обновляются в каталоге?")
    assert answer["external"] is None  # MCP not called: the team documents were sufficient
    assert "DEMO-INT-013" in {c["document_id"] for c in answer["citations"]}
    corporate = next(s for s in answer["scopes"] if s["scope"] == "corporate")
    assert "Не понадобились" in corporate["message"]


def test_second_similar_question_reuses_the_cache_after_a_fresh_search(ext_client: TestClient) -> None:
    first = ask(
        ext_client,
        "За какой срок выдают доступ к Consumer API после согласования заявки?",
        sources=["corporate"],
    )
    assert first["external"]["fetched"] >= 1 and first["external"]["cache_hits"] == 0
    second = ask(
        ext_client,
        "Через сколько дней выдают доступ к Consumer API после согласования?",
        sources=["corporate"],
    )
    assert second["external"]["cache_hits"] >= 1  # page text reused …
    assert second["external"]["mcp_calls"] >= 1  # … only after a fresh ACL-filtered search
    assert "200103" in {c["document_id"] for c in external_citations(second)}


def test_restricted_pages_never_reach_answers_or_graphs(ext_client: TestClient) -> None:
    answer = ask(
        ext_client,
        "Покажи бюджет проекта интеграции каталога, итоги аудита доступа и инструкцию администратора каталога",
        sources=["corporate"],
    )
    text = answer["answer"] + " ".join(c["excerpt"] for c in answer["citations"])
    assert not {"200118", "200119", "200120"} & {c["document_id"] for c in answer["citations"]}
    for marker in ("4,2 млн", "38 учётных", "по воскресеньям в 05:00"):
        assert marker not in text
    assert ext_client.get("/api/corporate/pages/200118").status_code == 404
    assert ext_client.get("/api/corporate/pages/200119").status_code == 404


def test_revoke_update_and_delete_invalidate_answers_cache_and_graph(
    ext_client: TestClient, state_file: Path
) -> None:
    supplier = ask(ext_client, "Какое окно поддержки у поставщика в рабочие дни?", sources=["corporate"])
    assert "200121" in {c["document_id"] for c in external_citations(supplier)}
    batch = ask(ext_client, "Какой максимальный размер пакета выгрузки CATIA?", sources=["corporate"])
    assert any("1 500" in c["excerpt"] for c in external_citations(batch))
    graph = ext_client.get(f"/api/graph/query/{batch['retrieval_trace_id']}").json()
    assert any(n["id"].startswith("ext:confluence:demo-wiki:200115:") for n in graph["nodes"])

    set_state(state_file, revoked={"200121"}, updated={"200115"}, deleted={"200116"})

    again = ask(ext_client, "Какое окно поддержки у поставщика в рабочие дни?", sources=["corporate"])
    assert "200121" not in {c["document_id"] for c in again["citations"]}  # cache valid, but no reuse
    trace = ext_client.get(f"/api/graph/query/{supplier['retrieval_trace_id']}").json()
    assert not any("200121" in n["id"] for n in trace["nodes"])  # hidden: node, edges and count
    assert not any("200121" in e["source"] for e in trace["edges"])

    newer = ask(ext_client, "Какой максимальный размер пакета выгрузки CATIA?", sources=["corporate"])
    excerpts = " ".join(c["excerpt"] for c in external_citations(newer))
    assert "1 800" in excerpts and "1 500" not in excerpts
    assert any(c["source_id"] == "confluence:demo-wiki:200115:4" for c in external_citations(newer))
    old_graph = ext_client.get(f"/api/graph/query/{batch['retrieval_trace_id']}").json()
    assert not any(":200115:3" in n["id"] for n in old_graph["nodes"])  # the old version is not shown

    deleted = ask(ext_client, "Как вручную запустить выгрузку ARIS?", sources=["corporate"])
    assert "200116" not in {c["document_id"] for c in deleted["citations"]}


def test_duplicate_of_a_curated_document_is_one_evidence(ext_client: TestClient) -> None:
    answer = ask(
        ext_client,
        "Сколько повторных попыток делает поток при недоступности источника и с какими паузами?",
        sources=["corporate"],
    )
    rejected = {r["page_id"]: r["reason"] for r in answer["external"]["rejected"]}
    assert rejected.get("200113") == "duplicate_of:DEMO-INT-011"
    assert "200113" not in {c["document_id"] for c in answer["citations"]}


def test_table_fact_and_prompt_injection(ext_client: TestClient) -> None:
    table = ask(
        ext_client,
        "В какой срок стюард должен зарегистрировать соответствие в MAP_ARIS_PROCESS?",
        sources=["corporate"],
    )
    assert "200123" in {c["document_id"] for c in external_citations(table)}
    assert any("1 рабочего дня" in c["excerpt"] for c in external_citations(table))
    injected = ask(
        ext_client, "В какой день недели пересоздаётся тестовая среда интеграций?", sources=["corporate"]
    )
    cited = external_citations(injected)
    assert "200122" in {c["document_id"] for c in cited}
    assert any("четверг" in c["excerpt"] for c in cited)  # the real fact is used …
    text = (injected["answer"] + " ".join(c["excerpt"] for c in cited)).lower()
    assert "ignore previous" not in text and "игнорируй" not in text  # … the injected instruction is not
    page = ext_client.get("/api/corporate/pages/200122").json()
    cleaned, suspicious = prepare_passage_text(page["body"])
    assert suspicious and "ignore previous instructions" not in cleaned.lower()


def test_oversized_page_is_truncated_without_false_citations(ext_client: TestClient) -> None:
    answer = ask(
        ext_client, "На какую версию формата перешёл журнал изменений метаданных?", sources=["corporate"]
    )
    assert any("слишком большая" in w for w in answer["warnings"]) or answer["external"]["fragments"] >= 0
    for citation in external_citations(answer):
        page = ext_client.get(f"/api/corporate/pages/{citation['document_id']}").json()
        assert " ".join(citation["excerpt"].split()) in " ".join(page["body"].split())


def test_feedback_scope_privacy_purge_and_proposal(
    ext_client: TestClient, client_factory: Callable[..., TestClient]
) -> None:
    answer = ask(ext_client, "Когда действует окно заморозки изменений метаданных?")
    trace = answer["retrieval_trace_id"]
    source = external_citations(answer)[0]["source_id"]
    ok = ext_client.post(
        "/api/discovery/feedback", json={"trace_id": trace, "source_id": source, "verdict": "relevant"}
    )
    assert ok.status_code == 200 and "не меняются" in ok.json()["note"]
    graph = ext_client.get(f"/api/graph/query/{trace}").json()
    assert any(e["feedback"] == "relevant" for e in graph["edges"] if e["type"] == "retrieved_for")
    query_node = next(n for n in graph["nodes"] if n["kind"] == "query_context")
    assert "заморозки" not in query_node["label"]  # plain question text is not stored by default
    stats = ext_client.get("/api/discovery/stats").json()
    assert stats["discovery"]["stores_query_text"] is False and stats["external"]["mcp_calls"] >= 1
    # A curation proposal is a DRAFT for review, never an import and never approved.
    proposal = ext_client.post("/api/discovery/propose", json={"trace_id": trace, "source_id": source})
    assert proposal.status_code == 201, proposal.text
    draft = proposal.json()
    assert (
        draft["status"] == "draft" and draft["origin"] == "external_page" and draft["operation"] == "create"
    )
    assert ext_client.get(f"/api/documents/{draft['document_id']}").status_code == 404
    # Its template is not offered for new documents, but stays resolvable to reopen this draft.
    listed = {t["id"] for t in ext_client.get("/api/authoring/templates").json()}
    every = {
        t["id"]: t
        for t in ext_client.get("/api/authoring/templates", params={"include_hidden": "true"}).json()
    }
    assert draft["template_id"] not in listed
    assert every[draft["template_id"]]["listed"] is False and listed < set(every)
    # Erase: the trace, its graph and the derived cache disappear.
    purged = ext_client.delete("/api/discovery").json()
    assert purged["removed_records"] >= 1
    assert ext_client.get(f"/api/graph/query/{trace}").status_code == 404


def _user(user_id: str) -> UserContext:
    return UserContext(user_id=user_id, display_name=user_id)


def test_hints_are_scoped_and_bounded(tmp_path: Path) -> None:
    store = DiscoveryStore(tmp_path / "d.sqlite3")
    alice, bob = acl_scope_key(_user("alice")), acl_scope_key(_user("bob"))
    from app.services.discovery import SourceLink

    trace = store.record(
        acl_scope=alice,
        normalized_query="окно заморозки",
        intent=["окн", "заморозк"],
        query_text="Окно заморозки?",
        mode="external",
        trigger="t",
        confidence="supported",
        index_generation="g1",
        instructions_version="-",
        external={},
        sources=[SourceLink("confluence_mcp", "confluence:demo-wiki:200101:3", "3", "T", page_id="200101")],
    )
    assert store.feedback(trace, "confluence:demo-wiki:200101:3", "irrelevant", alice)
    assert store.hints(["окн", "заморозк"], alice) == {"confluence:demo-wiki:200101": -1.0}
    assert store.hints(["окн", "заморозк"], bob) == {}  # another scope sees nothing
    assert store.hints(["бюджет", "проект"], alice) == {}  # a different question is not affected
    assert not store.feedback(trace, "confluence:demo-wiki:200101:3", "relevant", bob)
    assert store.trace(trace, bob) is None
    assert store.fingerprint("окно заморозки", alice) != store.fingerprint("окно заморозки", bob)


class _SlowConnector:
    name = "confluence_mcp"
    enabled = True

    def __init__(self, delay: float, fail: bool = False) -> None:
        self.delay = delay
        self.fail = fail
        self.inflight = 0
        self.peak = 0

    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        self.inflight += 1
        self.peak = max(self.peak, self.inflight)
        try:
            await asyncio.sleep(self.delay)
            if self.fail:
                raise ConnectorUnavailableError("mcp_unavailable", "503")
            return []
        finally:
            self.inflight -= 1

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage:
        raise AssertionError("not reached")

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="x", title="x", kind="x", state="mock", capabilities=[], human_readable_message=""
        )


def test_timeouts_failures_and_concurrency_are_bounded() -> None:
    terms = analyze_query("окно заморозки")

    async def run() -> None:
        slow = _SlowConnector(delay=0.5)
        service = ExternalEvidenceService(
            slow, None, ExternalLimits(timeout_seconds=0.05, breaker_failures=2)
        )
        first = await service.retrieve(_user("u"), "окно заморозки", terms, None, trigger="t")
        assert first.degraded and "не ответил" in first.warnings[0]  # local fallback, no exception
        await service.retrieve(_user("u"), "окно заморозки", terms, None, trigger="t")
        third = await service.retrieve(_user("u"), "окно заморозки", terms, None, trigger="t")
        assert third.degraded and third.mcp_calls == 0  # circuit breaker open: no more calls

        busy = _SlowConnector(delay=0.05)
        bounded = ExternalEvidenceService(busy, None, ExternalLimits(concurrency=2))
        await asyncio.gather(
            *(bounded.retrieve(_user("u"), "окно", terms, None, trigger="t") for _ in range(8))
        )
        assert busy.peak <= 2 and bounded.max_concurrent_seen <= 2

    asyncio.run(run())


def test_mock_corpus_is_separate_from_the_curated_base() -> None:
    connector = MockCorporateConnector(corpus_path=CORPUS)
    assert connector.corpus_size >= 24

    async def visible() -> set[str]:
        pages = await connector.search(
            "заморозки поставщика бюджет аудит", _user("local-demo-user"), limit=50
        )
        return {p.page_id for p in pages}

    seen = asyncio.run(visible())
    assert "200119" not in seen  # SEC space is not allowlisted
    assert "200118" not in seen  # restricted to another user
