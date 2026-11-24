"""Evaluation scenarios for external Confluence RAG, discovery memory, the graph and resource limits
(M5.6.2 Appendix 7 §2–3). Every scenario runs its own app on a copy of the curated base with the SYNTHETIC
mock Confluence corpus; scenario state (revoke / update / delete) lives in that run's temporary directory.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.adapters.corporate.base import CorporatePage
from app.adapters.corporate.mock import MockState
from app.domain.models import IntegrationStatus, UserContext
from app.domain.text import analyze_query
from app.evaluation.knowledge_eval import SCENARIO_METHODS, CaseResult, eval_client
from app.evaluation.scenarios import Problems
from app.services.external import ExternalEvidenceService, ExternalLimits

BOTH = ["team", "corporate"]


def scenario(name: str) -> Callable[[Callable[[Problems, Path], None]], Callable[[Problems, Path], None]]:
    def register(fn: Callable[[Problems, Path], None]) -> Callable[[Problems, Path], None]:
        def run(kb: Path, _case: dict[str, Any], r: CaseResult) -> None:
            problems = Problems()
            fn(problems, kb)
            r.status = "fail" if problems else "pass"
            r.detail = "; ".join(problems)

        SCENARIO_METHODS[name] = run
        return fn

    return register


def ask(c: TestClient, question: str, sources: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    response = c.post(
        "/api/assistant/ask", json={"question": question, "sources": sources or ["corporate"], **extra}
    )
    response.raise_for_status()
    data: dict[str, Any] = response.json()
    return data


def cited(answer: dict[str, Any]) -> set[str]:
    return {x["document_id"] for x in answer["citations"]}


def excerpts(answer: dict[str, Any]) -> str:
    return " ".join(x["excerpt"] for x in answer["citations"])


def state(c: TestClient, **changes: set[str]) -> None:
    path = c.app.state.container.settings.confluence_mock_state_file  # type: ignore[attr-defined]
    current = MockState.load(path)
    for name, value in changes.items():
        getattr(current, name).update(value)
    current.save(path)


# --- cache / version / ACL -------------------------------------------------------------------------------


@scenario("ext_cache_hit_after_fresh_search")
def _cache_hit(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        first = ask(c, "За какой срок выдают доступ к Consumer API после согласования заявки?")
        second = ask(c, "Через сколько дней выдают доступ к Consumer API после согласования?")
        p.expect(
            first["external"]["cache_hits"] == 0 and first["external"]["fetched"] >= 1,
            "first: fetch expected",
        )
        p.expect(second["external"]["cache_hits"] >= 1, "second: no cache hit")
        p.expect(second["external"]["mcp_calls"] >= 1, "second: no fresh ACL-filtered search")


@scenario("ext_revoke_no_reuse")
def _revoke(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        q = "Какое окно поддержки у поставщика в рабочие дни?"
        p.expect("200121" in cited(ask(c, q)), "before: page not cited")
        state(c, revoked={"200121"})
        after = ask(c, q)
        p.expect("200121" not in cited(after), "revoked page reused from the cache")
        p.expect("09:00–18:00" not in after["answer"] + excerpts(after), "revoked content leaked")


@scenario("ext_version_update")
def _version(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        q = "Какой максимальный размер пакета выгрузки CATIA?"
        before = ask(c, q)
        p.expect("1 500" in excerpts(before), "before: v3 value missing")
        state(c, updated={"200115"})
        after = ask(c, q)
        p.expect(
            "1 800" in excerpts(after) and "1 500" not in excerpts(after), "old version text in a new answer"
        )
        p.expect(
            any(x["source_id"].endswith(":200115:4") for x in after["citations"]), "new version not cited"
        )


@scenario("ext_delete")
def _delete(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        q = "Как часто можно вручную запускать выгрузку ARIS?"
        ask(c, q)
        state(c, deleted={"200116"})
        p.expect("200116" not in cited(ask(c, q)), "deleted page still cited")


@scenario("ext_cross_scope")
def _cross_scope(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Когда действует окно заморозки изменений метаданных?", BOTH)
        trace = answer["retrieval_trace_id"]
        store = c.app.state.container.discovery  # type: ignore[attr-defined]
        from app.services.discovery import acl_scope_key

        other = acl_scope_key(UserContext(user_id="another-user", display_name="x"))
        p.expect(store.trace(trace, other) is None, "another scope can read the trace")
        p.expect(store.hints(answer and ["окн", "заморозк"], other) == {}, "hints leak across scopes")
        p.expect(
            not store.feedback(trace, answer["citations"][0]["source_id"], "relevant", other),
            "foreign feedback",
        )


@scenario("ext_ttl_zero_no_cache")
def _ttl(p: Problems, kb: Path) -> None:
    with eval_client(kb, extra={"external_cache_ttl_seconds": 0}) as c:
        q = "За какой срок выдают доступ к Consumer API после согласования заявки?"
        ask(c, q)
        p.expect(ask(c, q)["external"]["cache_hits"] == 0, "expired cache entry reused")


# --- discovery memory ------------------------------------------------------------------------------------


@scenario("disc_feedback_relevant_boosts_same_intent")
def _boost(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        q = "Какие поля в заявке на доступ к Consumer API и какой срок?"
        answer = ask(c, q)
        target = next((x for x in answer["citations"] if x["document_id"] == "200103"), None)
        p.expect(target is not None, "page 200103 not cited")
        if target:
            c.post(
                "/api/discovery/feedback",
                json={
                    "trace_id": answer["retrieval_trace_id"],
                    "source_id": target["source_id"],
                    "verdict": "relevant",
                },
            )
            hints = c.app.state.container.discovery.hints(  # type: ignore[attr-defined]
                sorted({t.stem for t in analyze_query(q)}), _scope(c)
            )
            p.expect(hints.get("confluence:demo-wiki:200103", 0) > 0, "relevant feedback gave no hint")


def _scope(c: TestClient) -> str:
    from app.services.discovery import acl_scope_key

    return acl_scope_key(c.app.state.container.demo_user())  # type: ignore[attr-defined]


@scenario("disc_feedback_irrelevant_is_local_to_the_intent")
def _irrelevant(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        q = "Когда действует окно заморозки изменений метаданных?"
        answer = ask(c, q)
        source = answer["citations"][0]["source_id"] if answer["citations"] else None
        p.expect(source is not None, "nothing cited")
        if source:
            c.post(
                "/api/discovery/feedback",
                json={"trace_id": answer["retrieval_trace_id"], "source_id": source, "verdict": "irrelevant"},
            )
            store = c.app.state.container.discovery  # type: ignore[attr-defined]
            p.expect(
                store.hints(sorted({t.stem for t in analyze_query(q)}), _scope(c)) != {},
                "no penalty recorded",
            )
            p.expect(
                store.hints(["бюджет", "аудит"], _scope(c)) == {}, "penalty applied to an unrelated question"
            )


@scenario("disc_feedback_changes_no_authority")
def _no_authority(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        total = c.get("/api/documents", params={"size": 1}).json()["total"]
        answer = ask(c, "Когда действует окно заморозки изменений метаданных?")
        for x in answer["citations"]:
            c.post(
                "/api/discovery/feedback",
                json={
                    "trace_id": answer["retrieval_trace_id"],
                    "source_id": x["source_id"],
                    "verdict": "relevant",
                },
            )
        again = ask(c, "Когда действует окно заморозки изменений метаданных?")
        p.expect(
            all(
                x["external_status"] == "unknown" for x in again["citations"] if x["document_id"] == "200101"
            ),
            "status changed by feedback",
        )
        p.expect(
            c.get("/api/documents", params={"size": 1}).json()["total"] == total, "feedback imported a page"
        )


@scenario("disc_query_text_not_stored")
def _privacy(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Окно заморозки для сотрудника Тестов Тест Тестович?", BOTH)
        store = c.app.state.container.discovery  # type: ignore[attr-defined]
        trace = store.trace(answer["retrieval_trace_id"], _scope(c))
        p.expect(trace is not None and trace.query_text is None, "plain query text stored by default")
        p.expect(
            c.get("/api/discovery/stats").json()["discovery"]["stores_query_text"] is False,
            "policy not reported",
        )


@scenario("disc_purge")
def _purge(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Когда действует окно заморозки изменений метаданных?")
        trace = answer["retrieval_trace_id"]
        p.expect(c.get(f"/api/graph/query/{trace}").status_code == 200, "query graph missing before purge")
        purged = c.delete("/api/discovery").json()
        p.expect(purged["removed_records"] >= 1, "nothing purged")
        p.expect(c.get(f"/api/graph/query/{trace}").status_code == 404, "query graph survives purge")
        p.expect(c.get("/api/discovery/stats").json()["external"]["cache_pages"] == 0, "cache survives purge")


@scenario("disc_propose_is_a_draft")
def _propose(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Когда действует окно заморозки изменений метаданных?")
        source = answer["citations"][0]["source_id"]
        response = c.post(
            "/api/discovery/propose", json={"trace_id": answer["retrieval_trace_id"], "source_id": source}
        )
        p.expect(response.status_code == 201, f"propose {response.status_code}")
        draft = response.json()
        p.expect(
            draft.get("status") == "draft" and draft.get("origin") == "external_page", "not a review draft"
        )
        p.expect(
            c.get(f"/api/documents/{draft.get('document_id')}").status_code == 404,
            "page imported into the base",
        )


@scenario("disc_trace_is_reproducible")
def _trace(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Когда действует окно заморозки изменений метаданных?", BOTH)
        trace = c.app.state.container.discovery.trace(answer["retrieval_trace_id"], _scope(c))  # type: ignore[attr-defined]
        cited_ids = {x["source_id"] for x in answer["citations"]}
        recorded = {s["source_id"] for s in trace.sources if s["cited"]} if trace else set()
        p.expect(trace is not None and recorded == cited_ids, f"cited {cited_ids} vs trace {recorded}")
        p.expect(
            bool(trace and all(s["fragment_ids"] and s["version"] for s in trace.sources)),
            "fragments/versions missing",
        )
        p.expect(
            bool(trace and trace.instructions_version.startswith("instr-")), "instructions version missing"
        )


# --- graph -----------------------------------------------------------------------------------------------


@scenario("graph_overview_bounded_and_typed")
def _overview(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        data = c.get("/api/graph/overview", params={"limit": 100000}).json()
        p.expect(len(data["nodes"]) <= 200, "overview not capped")
        ids = {n["id"] for n in data["nodes"]}
        p.expect(
            all(e["source"] in ids and e["target"] in ids for e in data["edges"]), "edge to a hidden node"
        )
        p.expect(
            all(
                e["origin"] in ("canonical_metadata", "verified_registry") and e["declared_in"]
                for e in data["edges"]
            ),
            "edge without provenance",
        )


@scenario("graph_local_depth_bounded")
def _depth(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        d1 = c.get("/api/graph/nodes/doc:DEMO-SRC-002/neighbors", params={"depth": 1}).json()
        d9 = c.get("/api/graph/nodes/doc:DEMO-SRC-002/neighbors", params={"depth": 9}).json()
        p.expect(d9["total_nodes"] > d1["total_nodes"], "depth 2 not larger than depth 1")
        p.expect(d9["limits"]["depth_max"] == 2, "depth not clamped to 2")


@scenario("graph_query_shows_external_evidence")
def _query_graph(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Когда действует окно заморозки изменений метаданных?", BOTH)
        graph = c.get(f"/api/graph/query/{answer['retrieval_trace_id']}").json()
        kinds = {n["kind"] for n in graph["nodes"]}
        p.expect({"query_context", "external_page"} <= kinds, f"kinds {kinds}")
        p.expect(
            any(e["type"] == "cited_in" and e["origin"] == "query_trace" for e in graph["edges"]),
            "no cited_in edge",
        )
        p.expect(
            all(not e["verified"] for e in graph["edges"] if e["type"] == "retrieved_for"),
            "query edge marked as verified",
        )


@scenario("graph_query_hides_revoked")
def _query_revoked(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answer = ask(c, "Какое окно поддержки у поставщика в рабочие дни?")
        trace = answer["retrieval_trace_id"]
        state(c, revoked={"200121"})
        graph = c.get(f"/api/graph/query/{trace}").json()
        p.expect(not any("200121" in n["id"] for n in graph["nodes"]), "revoked node shown")
        p.expect(not any("200121" in e["source"] for e in graph["edges"]), "revoked edge shown")


@scenario("graph_scoped_trace")
def _graph_scope(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        p.expect(c.get("/api/graph/query/TRACE-0000000000000000").status_code == 404, "unknown trace not 404")


@scenario("graph_dangling_after_delete")
def _graph_dangling(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        root = Path(c.app.state.container.settings.local_knowledge_dir)  # type: ignore[attr-defined]
        (root / "semantics" / "DEMO-SEM-007.md").unlink()
        c.post("/api/index/sync")
        dangling = c.get("/api/graph/diagnostics").json()["dangling"]
        p.expect(any(d["target"] == "doc:DEMO-SEM-007" for d in dangling), "dangling edges not reported")
        overview = c.get("/api/graph/overview", params={"limit": 200}).json()
        p.expect("doc:DEMO-SEM-007" not in {n["id"] for n in overview["nodes"]}, "deleted node still active")


# --- resources -------------------------------------------------------------------------------------------


class _Slow:
    name = "confluence_mcp"
    enabled = True

    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.inflight = 0
        self.peak = 0

    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        self.inflight += 1
        self.peak = max(self.peak, self.inflight)
        try:
            await asyncio.sleep(self.delay)
            return []
        finally:
            self.inflight -= 1

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage:
        raise KeyError(page_id)

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="x", title="x", kind="x", state="mock", capabilities=[], human_readable_message=""
        )


@scenario("res_timeout_falls_back")
def _timeout(p: Problems, _kb: Path) -> None:
    service = ExternalEvidenceService(
        _Slow(0.5), None, ExternalLimits(timeout_seconds=0.05, breaker_failures=2)
    )
    user = UserContext(user_id="u", display_name="u")
    terms = analyze_query("окно заморозки")

    async def run() -> None:
        first = await service.retrieve(user, "окно заморозки", terms, None, trigger="t")
        p.expect(first.degraded and bool(first.warnings), "timeout not degraded with a warning")
        await service.retrieve(user, "окно заморозки", terms, None, trigger="t")
        third = await service.retrieve(user, "окно заморозки", terms, None, trigger="t")
        p.expect(third.mcp_calls == 0, "circuit breaker did not open")

    asyncio.run(run())


@scenario("res_concurrency_bounded")
def _concurrency(p: Problems, _kb: Path) -> None:
    slow = _Slow(0.03)
    service = ExternalEvidenceService(slow, None, ExternalLimits(concurrency=2))
    user = UserContext(user_id="u", display_name="u")
    terms = analyze_query("окно")

    async def run() -> None:
        await asyncio.gather(*(service.retrieve(user, "окно", terms, None, trigger="t") for _ in range(10)))

    asyncio.run(run())
    p.expect(slow.peak <= 2, f"{slow.peak} concurrent MCP calls")


@scenario("res_parallel_requests_isolated")
def _parallel(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        answers: list[dict[str, Any]] = []
        questions = [
            "Когда действует окно заморозки изменений метаданных?",
            "Какой класс чувствительности получает новая запись каталога?",
            "Как расшифровывается MTTR в отчётах команды мониторинга?",
        ]

        def run(q: str) -> None:
            answers.append({"q": q, "a": ask(c, q)})

        threads = [threading.Thread(target=run, args=(q,)) for q in questions]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        expected = {questions[0]: "200101", questions[1]: "200104", questions[2]: "200108"}
        for item in answers:
            p.expect(expected[item["q"]] in cited(item["a"]), f"mixed or missing evidence for «{item['q']}»")
        stats = c.get("/api/discovery/stats").json()["external"]
        p.expect(stats["max_concurrent_seen"] <= stats["concurrency_limit"], "concurrency limit exceeded")


@scenario("res_api_limits_clamped")
def _limits(p: Problems, kb: Path) -> None:
    with eval_client(kb) as c:
        p.expect(
            c.get("/api/graph/overview", params={"limit": 99_999_999}).status_code == 422,
            "huge limit accepted",
        )
        p.expect(
            len(c.get("/api/graph/overview", params={"limit": 100000}).json()["nodes"]) <= 200, "not clamped"
        )
