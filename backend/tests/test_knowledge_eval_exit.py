"""`make knowledge-eval` is honest about red runs: exit 1 when any case does not pass, reports written anyway."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app.evaluation.knowledge_eval import CaseResult, exit_code, main
from tests.conftest import CORE_FIXTURES

PASSING = """- case_id: T-PASS-001
  category: exact_id
  method: search
  question: "SEM-ARCH-001"
  expected_doc_ids: [SEM-ARCH-001]
  k: 1
"""
FAILING = """- case_id: T-FAIL-001
  category: exact_id
  method: search
  question: "SEM-ARCH-001"
  expected_doc_ids: [SEM-DOES-NOT-EXIST-001]
  k: 1
"""


@pytest.fixture
def small_kb(tmp_path: Path) -> Path:
    kb = tmp_path / "kb"
    kb.mkdir()
    for path in CORE_FIXTURES:
        shutil.copyfile(path, kb / path.name)
    return kb


def _run(tmp_path: Path, kb: Path, cases_yaml: str, *extra: str) -> tuple[int, Path]:
    cases = tmp_path / "cases"
    cases.mkdir(exist_ok=True)
    (cases / "cases_test.yaml").write_text(cases_yaml, encoding="utf-8")
    out = tmp_path / "out"
    code = main(["--kb", str(kb), "--cases", str(cases), "--label", "t", "--out", str(out), *extra])
    return code, out


def test_all_cases_pass_exits_zero(tmp_path: Path, small_kb: Path) -> None:
    code, out = _run(tmp_path, small_kb, PASSING)
    assert code == 0
    report = json.loads((out / "t.json").read_text(encoding="utf-8"))
    assert report["summary"]["overall"]["passed"] == 1 and report["summary"]["overall"]["failed"] == 0


def test_a_failing_case_exits_non_zero_and_still_writes_every_report(tmp_path: Path, small_kb: Path) -> None:
    code, out = _run(tmp_path, small_kb, PASSING + "\n" + FAILING)
    assert code == 1
    report = json.loads((out / "t.json").read_text(encoding="utf-8"))
    overall = report["summary"]["overall"]
    assert (overall["cases"], overall["passed"], overall["failed"]) == (2, 1, 1)
    assert "T-FAIL-001" in (out / "t_failures.md").read_text(encoding="utf-8")
    assert (out / "t_metrics.csv").read_text(encoding="utf-8").startswith("scope,cases,passed,failed")


def test_an_empty_selection_is_not_a_green_run(tmp_path: Path, small_kb: Path) -> None:
    code, out = _run(tmp_path, small_kb, PASSING, "--only", "NO-SUCH-CASE")
    assert code == 1
    assert json.loads((out / "t.json").read_text(encoding="utf-8"))["cases"] == 0


@pytest.mark.parametrize("status", ["fail", "error", "unsupported"])
def test_every_non_pass_status_turns_the_exit_code_red(status: str) -> None:
    ok = CaseResult("A", "exact_id", "search", False, "pass")
    bad = CaseResult("B", "exact_id", "search", False, status)
    assert exit_code("t", [ok]) == 0
    assert exit_code("t", [ok, bad]) == 1
