"""Latency and external (MCP) calls of /api/assistant/ask: same KB, same questions, same machine, warm-up + 5 rounds.

Runs every `method: assistant` case of the given case directory through a fresh in-process app (mock AI, mock
Confluence, temporary workspace — nothing is written to ./workspace). Run it with the backend of the code under test
on PYTHONPATH, so the same script measures the code before and after a change:

    PYTHONPATH=<backend> .venv/bin/python reports/retrieval-quality/tools/bench_assistant.py \
        fixtures/knowledge fixtures/eval <label> > reports/retrieval-quality/evidence/bench_assistant_<label>.json

External calls are counted in the FIRST round (a cold discovery cache, as a fresh question would be); `expected_no_call`
counts calls on cases whose gold says the external source must not be consulted.
"""

from __future__ import annotations

import json
import sys
import time
import warnings
from pathlib import Path
from typing import Any

import yaml

warnings.filterwarnings("ignore")
from app.evaluation.knowledge_eval import eval_client  # noqa: E402

KB = Path(sys.argv[1]).resolve()
CASES = Path(sys.argv[2]).resolve()
LABEL = sys.argv[3]
ROUNDS = 5


def body(case: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "question": case["question"],
        "include_drafts": bool(case.get("include_drafts", False)),
        "include_deprecated": bool(case.get("include_deprecated", False)),
        "sources": case.get("sources", ["team"]),
    }
    if case.get("history"):
        out["history"] = [{"question": str(q), "answer": ""} for q in case["history"]]
    return out


def pct(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, round(p * (len(ordered) - 1)))], 2)


cases = [
    c
    for f in sorted(CASES.glob("*.yaml"))
    for c in (yaml.safe_load(f.read_text(encoding="utf-8")) or [])
    if c.get("method") == "assistant" and c.get("question")
]
result: dict[str, Any] = {"label": LABEL, "questions": len(cases), "rounds": ROUNDS}
with eval_client(KB) as client:
    first: list[dict[str, Any]] = []
    for case in cases:  # round 0: warm-up AND the external-call census
        answer = client.post("/api/assistant/ask", json=body(case)).json()
        ext = answer.get("external") or {}
        first.append(
            {
                "case_id": case["case_id"],
                "corporate": "corporate" in body(case)["sources"],
                "called": bool(ext.get("called")),
                "trigger": ext.get("trigger"),
                "mcp_calls": int(ext.get("mcp_calls") or 0),
                "fetched": int(ext.get("fetched") or 0),
                "expect": case.get("expect_external_called"),
            }
        )
    timings: list[float] = []
    errors = 0
    for _ in range(ROUNDS):
        for case in cases:
            started = time.perf_counter()
            response = client.post("/api/assistant/ask", json=body(case))
            timings.append((time.perf_counter() - started) * 1000)
            errors += response.status_code != 200
corporate = [r for r in first if r["corporate"]]
result["ask"] = {
    "p50_ms": pct(timings, 0.5),
    "p95_ms": pct(timings, 0.95),
    "max_ms": round(max(timings), 2),
    "errors": errors,
}
result["external"] = {
    "questions_with_corporate_scope": len(corporate),
    "called": sum(r["called"] for r in corporate),
    "mcp_calls": sum(r["mcp_calls"] for r in corporate),
    "pages_fetched": sum(r["fetched"] for r in corporate),
    "expected_no_call_but_called": [
        r["case_id"] for r in corporate if r["expect"] is False and r["called"]
    ],
    "expected_call_but_not_called": [
        r["case_id"] for r in corporate if r["expect"] is True and not r["called"]
    ],
    "per_case": corporate,
}
print(json.dumps(result, ensure_ascii=False, indent=1))
