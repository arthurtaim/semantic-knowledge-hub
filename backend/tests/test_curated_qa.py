"""Curated synthetic QA set: grounded answers or explicit missing evidence (PRODUCT.md §6)."""

from __future__ import annotations

from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from tests.conftest import QA_FILE
from tests.test_assistant import assert_citations_valid

CASES: list[dict[str, Any]] = yaml.safe_load(QA_FILE.read_text(encoding="utf-8"))


def test_qa_set_has_at_least_ten_questions() -> None:
    assert len(CASES) >= 10
    assert len({c["id"] for c in CASES}) == len(CASES)


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_curated_question(client: TestClient, case: dict[str, Any]) -> None:
    response = client.post(
        "/api/assistant/ask",
        json={
            "question": case["question"],
            "include_drafts": case.get("include_drafts", False),
            "include_deprecated": case.get("include_deprecated", False),
        },
    )
    assert response.status_code == 200
    answer = response.json()
    expect = case["expect"]
    cited = {c["document_id"] for c in answer["citations"]}
    excluded = {e["document_id"] for e in answer["excluded_sources"]}
    if "confidence" in expect:
        assert answer["confidence"] in expect["confidence"], answer
    if "cited_any" in expect:
        assert cited & set(expect["cited_any"]), answer
    if "not_cited" in expect:
        assert not cited & set(expect["not_cited"]), answer
    if "excluded_any" in expect:
        assert excluded & set(expect["excluded_any"]), answer
    if answer["confidence"] == "insufficient_evidence":
        assert answer["citations"] == []
        assert "Недостаточно данных" in answer["answer"]
    else:
        assert answer["citations"], "grounded answers must carry citations"
        assert_citations_valid(client, answer)
