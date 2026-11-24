"""OPT-IN live evaluation of the assistant on a running deployment (make knowledge-eval-live).

Sends the `assistant` gold cases to an already running stack over HTTP — e.g. the personal test stack with
the Claude Code CLI provider — one independent request per case (a follow-up case replays only its earlier questions), and scores
what is checkable automatically: expected sources cited, required facts present, forbidden facts absent,
no-answer when expected, server-verified citations only (the server drops unverifiable ones). It never
contacts a model directly and never runs by accident: SKH_LIVE_EVAL=1 is required.

The deterministic results (make knowledge-eval) stay the acceptance basis; live results measure the real
generator on the same retrieval and are reported separately with the provider/model/CLI version.

    SKH_LIVE_EVAL=1 python -m app.evaluation.live_eval --base-url http://127.0.0.1:5180 \
        --cases ../fixtures/eval --out ../reports/knowledge-eval --limit 30
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from app.evaluation.knowledge_eval import load_cases

CATEGORIES = (
    "synthesis",
    "status",
    "no_answer",
    "external_rag",
    "synonym",
    "abbreviation",
    "provenance",
    "followup",
)


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


def score(case: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
    cited = [c["document_id"] for c in answer.get("citations", [])]
    text = _norm(
        answer.get("answer", "") + " " + " ".join(c.get("excerpt", "") for c in answer.get("citations", []))
    )
    expected = [str(i) for i in case.get("expected_doc_ids") or []]
    any_of = [str(i) for i in case.get("cited_any") or []]
    no_answer = bool(case.get("expected_no_answer"))
    checks = {
        "no_answer_ok": (answer.get("confidence") == "insufficient_evidence") if no_answer else None,
        "sources_ok": None
        if no_answer
        else (all(e in cited for e in expected) and (not any_of or bool(set(any_of) & set(cited)))),
        "facts_ok": None
        if no_answer
        else all(_norm(str(f)) in text for f in case.get("facts_required") or []),
        "forbidden_ok": not any(_norm(str(f)) in text for f in case.get("facts_forbidden") or []),
        "not_cited_ok": not any(d in cited for d in case.get("not_cited") or []),
        # answer quality: provenance from the validated evidence, no boilerplate warnings on ordinary answers
        "provenance_ok": (answer.get("provenance") or {}).get("overall") == case["expect_provenance"]
        if "expect_provenance" in case
        else None,
        "warnings_ok": len(answer.get("warnings") or []) <= int(case["max_warnings"])
        if "max_warnings" in case
        else None,
    }
    passed = all(v for v in checks.values() if v is not None)
    return {"passed": passed, **checks, "cited": cited, "confidence": answer.get("confidence")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Opt-in live evaluation against a running stack.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args(argv)
    if os.environ.get("SKH_LIVE_EVAL") != "1":
        print("live evaluation is opt-in: set SKH_LIVE_EVAL=1", file=sys.stderr)
        return 2
    cases = [
        c
        for c in load_cases(args.cases)
        if c.get("method") == "assistant" and c.get("category") in CATEGORIES
    ]
    cases = cases[: args.limit]
    headers = {"X-SKH-Client": "live-eval"}
    results: list[dict[str, Any]] = []
    with httpx.Client(base_url=args.base_url.rstrip("/"), headers=headers, timeout=args.timeout) as client:
        session = client.get("/api/session").json()
        for case in cases:
            body = {
                "question": case["question"],
                "sources": case.get("sources", ["team"]),
                "include_drafts": bool(case.get("include_drafts", False)),
                "include_deprecated": bool(case.get("include_deprecated", False)),
            }
            if case.get(
                "history"
            ):  # a follow-up: earlier questions of the same dialog (answers not replayed)
                body["history"] = [{"question": str(q), "answer": ""} for q in case["history"]]
            started = time.perf_counter()
            try:
                response = client.post("/api/assistant/ask", json=body)
                answer = response.json() if response.status_code == 200 else {"error": response.status_code}
            except httpx.HTTPError as exc:
                answer = {"error": type(exc).__name__}
            elapsed = round((time.perf_counter() - started) * 1000)
            row = {"case_id": case["case_id"], "category": case["category"], "latency_ms": elapsed}
            if "error" in answer:
                row.update(passed=False, error=answer["error"])
            else:
                row.update(
                    score(case, answer),
                    mode=answer.get("mode"),
                    instructions=answer.get("instructions_version"),
                )
            results.append(row)
            print(
                f"{row['case_id']:14} {'PASS' if row.get('passed') else 'FAIL'} {elapsed:6d} ms {row.get('confidence', row.get('error'))}"
            )
    latencies = sorted(r["latency_ms"] for r in results)
    report = {
        "label": "live",
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
        "base_url_kind": "loopback"
        if "127.0.0.1" in args.base_url or "localhost" in args.base_url
        else "remote",
        "provider": session.get("features", {}).get("ai_provider"),
        "cases": len(results),
        "passed": sum(1 for r in results if r.get("passed")),
        "latency_p50_ms": latencies[len(latencies) // 2] if latencies else None,
        "latency_p95_ms": latencies[min(len(latencies) - 1, round(0.95 * (len(latencies) - 1)))]
        if latencies
        else None,
        "latency_mean_ms": round(statistics.mean(latencies)) if latencies else None,
        "results": results,
    }
    print(
        f"[live] {report['passed']}/{report['cases']} passed, p50 {report['latency_p50_ms']} ms, p95 {report['latency_p95_ms']} ms"
    )
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "live.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
