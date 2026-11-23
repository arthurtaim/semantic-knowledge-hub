"""The synthetic knowledge base (M5.6.2) and the retrieval acceptance targets measured on it."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.evaluation.knowledge_eval import evaluate, load_cases, summarize
from app.tools.kb_validate import validate
from tests.conftest import FIXTURES_DIR, PROJECT_ROOT

CASES_DIR = PROJECT_ROOT / "fixtures" / "eval"


def test_synthetic_base_is_valid_and_connected() -> None:
    report = validate(FIXTURES_DIR, strict_synthetic=True)
    assert report["ok"], report["errors"]
    assert 72 <= report["documents"] <= 90
    assert report["edges"] >= 100
    assert all(chain["ok"] for chain in report["required_chains"])
    assert report["unresolved_references"] == [] and report["invalid_files"] == []
    assert report["not_synthetic"] == [] and report["secrets"] == [] and report["personal_data"] == []
    statuses = report["by_status"]
    assert statuses["approved"] > 0 and statuses["draft"] > 0 and statuses["deprecated"] > 0


@pytest.fixture(scope="module")
def retrieval_report() -> dict[str, object]:
    cases = [
        c
        for c in load_cases(CASES_DIR)
        if c.get("method") in ("search", "catalog", "graph_neighbors", "graph_path")
    ]
    run = evaluate(FIXTURES_DIR, cases)
    return summarize(run["results"])


def test_acceptance_targets_on_the_gold_set(retrieval_report: dict[str, object]) -> None:
    """Appendix 3 §3 targets (deterministic part): exact ids 100 %, Recall@5 ≥ 0.90, filters and relations
    ≥ 95 %, no leaks."""
    by_category = retrieval_report["by_category"]
    assert isinstance(by_category, dict)
    assert by_category["exact_id"]["pass_rate"] == 1.0
    assert by_category["metadata_filter"]["pass_rate"] >= 0.95
    assert by_category["relation"]["pass_rate"] >= 0.95
    overall = retrieval_report["overall"]
    assert isinstance(overall, dict)
    assert overall["recall_at_5"] >= 0.90
    assert overall["leaks"] == 0


def test_exact_id_wins_over_a_near_miss(
    full_workspace: Path, client_factory: Callable[..., TestClient]
) -> None:
    client = client_factory(local_knowledge_dir=full_workspace)
    items = client.get("/api/documents", params={"query": "DEMO-INT-002"}).json()["items"]
    assert items[0]["id"] == "DEMO-INT-002"
    assert "Точное совпадение идентификатора" in items[0]["match_reasons"]
    assert "DEMO-INT-003" not in [i["id"] for i in items[:1]]


def test_synonyms_and_ambiguous_abbreviations(
    full_workspace: Path, client_factory: Callable[..., TestClient]
) -> None:
    client = client_factory(local_knowledge_dir=full_workspace)
    lineage = client.get("/api/search", params={"q": "линейдж датасета", "limit": 5}).json()
    assert lineage["items"], lineage
    assert any(any("Синоним" in r for r in i["match_reasons"]) for i in lineage["items"])
    adr = client.get("/api/documents", params={"query": "ADR"}).json()
    assert any("ADR неоднозначна" in n for n in adr["notes"])


def test_graph_expansion_is_bounded_and_explained(
    full_workspace: Path, client_factory: Callable[..., TestClient]
) -> None:
    client = client_factory(local_knowledge_dir=full_workspace)
    items = client.get("/api/search", params={"q": "маппинг полей ARIS", "limit": 30}).json()["items"]
    expanded = [i for i in items if i["related_via"]]
    assert len(expanded) <= 5
    assert all(any(r.startswith("Связан с") for r in i["match_reasons"]) for i in expanded)
    direct = [i for i in items if not i["related_via"]]
    if expanded and direct:
        assert min(i["score"] for i in direct) > max(i["score"] for i in expanded)
