"""`make work-eval` stays green: every deterministic M6 acceptance oracle passes (no network, no AI)."""

from __future__ import annotations

from pathlib import Path

from app.evaluation.work_eval import main


def test_work_eval_passes_every_case(tmp_path: Path) -> None:
    assert main(["--out", str(tmp_path)]) == 0
    report = (tmp_path / "work-eval.json").read_text(encoding="utf-8")
    assert '"failed": 0' in report and '"M6-33"' in report
