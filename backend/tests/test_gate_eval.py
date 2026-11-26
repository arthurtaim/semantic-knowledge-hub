"""The adaptive-RAG evaluation tool itself (app/evaluation/gate_eval.py): labels are checked against the corpus, and
the aggregates count false and missed external searches the way the report reads them."""

from __future__ import annotations

from app.evaluation import gate_eval


def case(**fields: object) -> dict[str, object]:
    base: dict[str, object] = {"id": "T-1", "split": "dev", "expected": "sufficient", "facts": []}
    base.update(fields)
    return base


def test_labels_must_quote_their_source_verbatim_and_use_approved_team_documents() -> None:
    good = case(
        facts=[{"text": "1 500", "source": "confluence:200115"}], expected="need_external", queries=["q"]
    )
    assert gate_eval.validate([good]) == []
    invented = case(facts=[{"text": "лимит 9 999 записей", "source": "confluence:200115"}])
    draft = case(facts=[{"text": "ARIS", "source": "SEM-INT-ARIS-001"}])
    unknown = case(facts=[{"text": "x", "source": "DEMO-NOPE-1"}])
    no_query = case(expected="need_external")
    problems = gate_eval.validate([invented, draft, unknown, no_query])
    assert any("not verbatim" in p for p in problems)
    assert any("is draft, not approved" in p for p in problems)
    assert any("unknown team document" in p for p in problems)
    assert any("without labelled queries" in p for p in problems)


def row(expected: str, called: bool, decision: str, **extra: object) -> dict[str, object]:
    base: dict[str, object] = {
        "status": 200,
        "expected": expected,
        "called": called,
        "decision": decision,
        "decision_ok": called == (expected == "need_external"),
        "context_ok": True,
        "facts": 1,
        "facts_in_context": 1,
        "facts_in_answer": 0,
        "external_page": None,
        "external_page_in_context": None,
        "invalid_citations": [],
        "leaks": [],
        "model_calls": 1,
        "repaired": False,
        "queries_rejected": 0,
        "mcp_search": 1 if called else 0,
        "mcp_get": 0,
        "fetched": 0,
        "gap_prompt_chars": 1000,
        "latency_ms": 10.0,
        "outcome": None,
        "unconfirmed_warning": False,
    }
    base.update(extra)
    return base


def test_aggregates_count_false_and_missed_external_searches() -> None:
    rows = [
        row("sufficient", False, "sufficient"),
        row("sufficient", True, "need_external"),  # a needless external call
        row("need_external", False, "sufficient", context_ok=False, facts_in_context=0),  # a missed one
        row("need_external", True, "need_external", external_page="200115", external_page_in_context=True),
    ]
    agg = gate_eval.aggregate(rows)
    assert agg["decision_accuracy"] == 0.5
    assert agg["false_external"] == 1 and agg["missed_external"] == 1
    assert agg["context_ok_n"] == "3/4" and agg["external_page_recall"] == "1/1"
    assert agg["confusion"] == {
        "need_external→need_external": 1,
        "need_external→sufficient": 1,
        "sufficient→need_external": 1,
        "sufficient→sufficient": 1,
    }
