"""Deterministic knowledge evaluation (make knowledge-eval): no external model, no network, no tokens.

Runs the gold cases (fixtures/eval/*.yaml) against a fresh copy of a knowledge snapshot through the real
HTTP API (FastAPI TestClient, mock AI provider) and reports retrieval / grounding / graph / lifecycle
metrics. Every report records the code commit, the snapshot hash, the case-set hash and the index
generation, so a baseline and an "after" run are comparable only when they used the same inputs.

    python -m app.evaluation.knowledge_eval --kb ../fixtures/knowledge --cases ../fixtures/eval \
        --label after --out ../reports/knowledge-eval

Exit code: 0 only when every selected case passed; 1 when any case did not pass (fail, error or unsupported) or
no case was selected. The JSON / CSV / Markdown reports are written first in either case, so a red run still
leaves its full evidence in --out.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import warnings
from collections import defaultdict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

HEADERS = {"X-SKH-Client": "eval"}
PROJECT_ROOT = Path(__file__).resolve().parents[3]
MOCK_CORPUS = PROJECT_ROOT / "fixtures" / "confluence_mock" / "pages.yaml"
SEARCH_PAGE = 10
NON_AUTHORITATIVE = {"draft", "in_review", "deprecated"}
EXIT_OK = 0
EXIT_CASES_NOT_PASSED = 1  # any case fail / error / unsupported, or an empty selection


@dataclass
class CaseResult:
    case_id: str
    category: str
    method: str
    holdout: bool
    status: str  # pass | fail | unsupported | error
    detail: str = ""
    rank: int | None = None  # 1-based rank of the first expected document (search)
    recall_at_1: float | None = None
    recall_at_5: float | None = None
    leaks: int = 0
    latency_ms: float = 0.0
    returned: list[str] = field(default_factory=list)
    # assistant cases: were the expected documents / facts in the CONTEXT given to the model?
    # (retrieval grounding, measured separately from what the deterministic mock chose to quote)
    context_ok: bool | None = None


def _sha256_dir(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def _git(*args: str) -> str | None:
    try:
        return subprocess.run(  # noqa: S603 - fixed argument list, no shell
            ["git", *args],  # noqa: S607 - git from PATH, read-only metadata
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def load_cases(path: Path) -> list[dict[str, Any]]:
    files = sorted(path.glob("*.yaml")) if path.is_dir() else [path]
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()
    for file in files:
        data = yaml.safe_load(file.read_text(encoding="utf-8")) or []
        for case in data:
            case_id = str(case["case_id"])
            if case_id in seen:
                raise ValueError(f"duplicate case_id {case_id} in {file.name}")
            seen.add(case_id)
            case["_file"] = file.name
            cases.append(case)
    return cases


@contextmanager
def eval_client(
    kb: Path, *, connector: str = "mock", extra: dict[str, Any] | None = None
) -> Iterator[TestClient]:
    with tempfile.TemporaryDirectory(prefix="skh-eval-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace" / "knowledge"
        shutil.copytree(kb, workspace)
        values: dict[str, Any] = {
            "app_env": "test",
            "project_root": root,
            "local_knowledge_dir": workspace,
            "fixtures_dir": kb,
            "seed_fixtures": False,
            "search_index_path": root / "workspace" / "search.sqlite3",
            "app_state_path": root / "workspace" / "app_state.sqlite3",
            "publication_state_path": root / "workspace" / "publications.sqlite3",
            "repository_refresh_seconds": 0.0,
            "ai_provider": "mock",
            "confluence_connector": connector,
            # the synthetic Confluence corpus (separate from the curated base) and its scenario state
            "confluence_mock_pages_path": MOCK_CORPUS,
            "confluence_mock_state_path": root / "mock_confluence_state.json",
        }
        values.update(extra or {})
        app = create_app(Settings(_env_file=None, **values))
        with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
            yield client


def _filter_params(filters: dict[str, Any] | None) -> dict[str, str]:
    params: dict[str, str] = {}
    for key, value in (filters or {}).items():
        if key in ("type", "status", "owner", "tag", "source"):
            params[key] = ",".join(value) if isinstance(value, list) else str(value)
    return params


def _expected(case: dict[str, Any]) -> list[str]:
    return [str(i) for i in case.get("expected_doc_ids") or []]


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


def run_search(client: TestClient, case: dict[str, Any], r: CaseResult) -> None:
    params = {"query": case["question"], "size": str(SEARCH_PAGE), **_filter_params(case.get("filters"))}
    response = client.get("/api/documents", params=params)
    if response.status_code != 200:
        r.status, r.detail = "error", f"HTTP {response.status_code}"
        return
    ids = [item["id"] for item in response.json()["items"]]
    r.returned = ids
    expected = _expected(case)
    k = int(case.get("k", 5))
    lowered = [i.lower() for i in ids]
    ranks = [lowered.index(e.lower()) + 1 for e in expected if e.lower() in lowered]
    r.rank = min(ranks) if ranks else None
    if expected:
        r.recall_at_1 = sum(1 for e in expected if e.lower() in lowered[:1]) / len(expected)
        r.recall_at_5 = sum(1 for e in expected if e.lower() in lowered[:5]) / len(expected)
    if case.get("expected_no_answer"):
        r.status = "pass" if not ids else "fail"
        r.detail = "" if not ids else f"expected no results, got {ids[:3]}"
        return
    ok = all(e.lower() in lowered[:k] for e in expected)
    leaked = [n for n in case.get("not_returned") or [] if n.lower() in lowered]
    r.status = "pass" if ok and not leaked else "fail"
    if not ok:
        r.detail = f"expected {expected} within top {k}, got {ids[:k]}"
    if leaked:
        r.detail = (r.detail + "; " if r.detail else "") + f"must not be returned: {leaked}"


def run_catalog(client: TestClient, case: dict[str, Any], r: CaseResult) -> None:
    params = {"size": "100", **_filter_params(case.get("filters"))}
    if case.get("question") and case.get("use_query"):
        params["query"] = case["question"]
    response = client.get("/api/documents", params=params)
    if response.status_code != 200:
        r.status, r.detail = "error", f"HTTP {response.status_code}"
        return
    ids = sorted(item["id"] for item in response.json()["items"])
    r.returned = ids
    expected = sorted(_expected(case))
    r.status = "pass" if ids == expected else "fail"
    if ids != expected:
        r.detail = f"missing {sorted(set(expected) - set(ids))}, extra {sorted(set(ids) - set(expected))}"


def run_assistant(client: TestClient, case: dict[str, Any], r: CaseResult) -> None:
    body = {
        "question": case["question"],
        "include_drafts": bool(case.get("include_drafts", False)),
        "include_deprecated": bool(case.get("include_deprecated", False)),
        "sources": case.get("sources", ["team"]),
    }
    if case.get("history"):  # a follow-up: earlier questions of the same dialog (oldest first)
        body["history"] = [{"question": str(q), "answer": ""} for q in case["history"]]
    response = client.post("/api/assistant/ask", json=body)
    if response.status_code != 200:
        r.status, r.detail = "error", f"HTTP {response.status_code}"
        return
    answer = response.json()
    r.context_ok = _context_ok(client, case, body)
    cited = [c["document_id"] for c in answer["citations"]]
    r.returned = cited
    if not body["include_drafts"] and not body["include_deprecated"]:
        r.leaks = sum(1 for c in answer["citations"] if (c.get("status") or "") in NON_AUTHORITATIVE)
    text = _norm(answer["answer"] + " " + " ".join(c["excerpt"] for c in answer["citations"]))
    problems: list[str] = []
    if case.get("expected_no_answer"):
        if answer["confidence"] != "insufficient_evidence":
            problems.append(f"expected no answer, got {answer['confidence']} citing {cited}")
    else:
        any_of = [str(i) for i in case.get("cited_any") or []]
        if any_of and not set(any_of) & set(cited):
            problems.append(f"none of {any_of} cited (cited {cited}, confidence {answer['confidence']})")
        missing = [e for e in _expected(case) if e not in cited]
        if missing:
            problems.append(f"not cited: {missing} (cited {cited}, confidence {answer['confidence']})")
        lost = [f for f in case.get("facts_required") or [] if _norm(str(f)) not in text]
        if lost:
            problems.append(f"facts missing from the grounded answer: {lost}")
    wrongly_cited = [d for d in case.get("not_cited") or [] if d in cited]
    if wrongly_cited:
        problems.append(f"must not be cited: {wrongly_cited}")
    excluded = {e["document_id"] for e in answer.get("excluded_sources") or []}
    not_excluded = [d for d in case.get("expected_excluded") or [] if d not in excluded]
    if not_excluded:
        problems.append(f"expected among excluded sources: {not_excluded} (excluded {sorted(excluded)})")
    external = answer.get("external") or {}
    if "expect_external_called" in case and bool(external.get("called")) != bool(
        case["expect_external_called"]
    ):
        problems.append(
            f"external called={bool(external.get('called'))}, expected {case['expect_external_called']}"
        )
    rejected = {x["page_id"]: x["reason"] for x in external.get("rejected") or []}
    for page, reason in (case.get("expected_rejected") or {}).items():
        if not str(rejected.get(str(page), "")).startswith(str(reason)):
            problems.append(f"page {page} not rejected as {reason} (rejected {rejected})")
    for needle in case.get("warning_contains") or []:
        if not any(needle in w for w in answer.get("warnings") or []):
            problems.append(f"no warning containing «{needle}»")
    # Answer quality: provenance is metadata of the validated evidence; an ordinary answer carries no boilerplate
    # warning; words of an earlier question are never reported as «not found» for this one.
    if "expect_provenance" in case:
        overall = (answer.get("provenance") or {}).get("overall")
        if overall != case["expect_provenance"]:
            problems.append(f"provenance {overall}, expected {case['expect_provenance']}")
    if "max_warnings" in case and len(answer.get("warnings") or []) > int(case["max_warnings"]):
        problems.append(f"warnings {answer.get('warnings')} (at most {case['max_warnings']})")
    if case.get("unmatched_only_current"):
        own = _norm(case["question"])
        foreign = [t for t in answer.get("unmatched_terms") or [] if _norm(t) not in own]
        if foreign:
            problems.append(f"unmatched terms not in this question: {foreign}")
    if case.get("context_any") and r.context_ok is not True:
        problems.append(f"none of {case['context_any']} in the context given to the model")
    limits = case.get("max_external") or {}
    for key, bound in limits.items():
        if int(external.get(key, 0)) > int(bound):
            problems.append(f"external {key}={external.get(key)} > {bound}")
    forbidden = [f for f in case.get("facts_forbidden") or [] if _norm(str(f)) in text]
    if forbidden:
        problems.append(f"forbidden facts present: {forbidden}")
    if r.leaks:
        problems.append(f"{r.leaks} non-authoritative citation(s)")
    r.status = "fail" if problems else "pass"
    r.detail = "; ".join(problems)


def _context_ok(client: TestClient, case: dict[str, Any], body: dict[str, Any]) -> bool | None:
    """Expected documents and facts present in the passages the assistant hands to the provider."""
    if case.get("expected_no_answer"):
        return None
    container: Any = getattr(getattr(client.app, "state", None), "container", None)
    prepare = getattr(getattr(container, "assistant", None), "_prepare", None)
    portal = getattr(client, "portal", None)
    if container is None or prepare is None or portal is None:
        return None
    from app.domain.models import AskRequest

    try:
        prepared = portal.call(prepare, container.demo_user(), AskRequest(**body))
    except Exception:
        return None
    docs = {p.document_id for p in prepared.passages}
    text = _norm(" ".join(p.text for p in prepared.passages))
    wanted_docs = _expected(case) or [str(i) for i in case.get("cited_any") or case.get("context_any") or []]
    any_of = bool(case.get("cited_any") or case.get("context_any"))
    docs_ok = not wanted_docs or (set(wanted_docs) & docs if any_of else set(wanted_docs) <= docs)
    facts_ok = all(_norm(str(f)) in text for f in case.get("facts_required") or [])
    return bool(docs_ok) and facts_ok


def _graph_unsupported(response: Any) -> bool:
    return response.status_code in (404, 405) and "graph" not in response.text.lower()


def run_graph_neighbors(client: TestClient, case: dict[str, Any], r: CaseResult) -> None:
    params = {"depth": str(case.get("max_depth", 1)), "direction": case.get("direction", "both")}
    if case.get("relation"):
        params["relation"] = case["relation"]
    response = client.get(f"/api/graph/nodes/doc:{case['start']}/neighbors", params=params)
    if _graph_unsupported(response):
        r.status, r.detail = "unsupported", "graph API not available"
        return
    if response.status_code != 200:
        r.status, r.detail = "error", f"HTTP {response.status_code}"
        return
    ids = sorted(
        {n["document_id"] for n in response.json()["nodes"] if n.get("document_id")} - {case["start"]}
    )
    r.returned = ids
    missing = [e for e in _expected(case) if e not in ids]
    r.status = "fail" if missing else "pass"
    r.detail = f"missing neighbours {missing}" if missing else ""


def run_graph_path(client: TestClient, case: dict[str, Any], r: CaseResult) -> None:
    expected_path = [str(p) for p in case.get("expected_path") or []]
    start = case.get("start") or (expected_path[0] if expected_path else None)
    end = case.get("end") or (expected_path[-1] if expected_path else None)
    params = {"source": f"doc:{start}", "target": f"doc:{end}", "max_depth": str(case.get("max_depth", 6))}
    response = client.get("/api/graph/path", params=params)
    if _graph_unsupported(response):
        r.status, r.detail = "unsupported", "graph API not available"
        return
    if response.status_code != 200:
        r.status, r.detail = "error", f"HTTP {response.status_code}"
        return
    path = [n["document_id"] for n in response.json().get("nodes", [])]
    r.returned = path
    if expected_path:
        ok = path == expected_path or (
            bool(path)
            and path[0] == expected_path[0]
            and path[-1] == expected_path[-1]
            and len(path) <= len(expected_path)
        )
    else:
        ok = bool(path)
    r.status = "pass" if ok else "fail"
    r.detail = "" if ok else f"expected {expected_path}, got {path}"


METHODS: dict[str, Callable[[TestClient, dict[str, Any], CaseResult], None]] = {
    "search": run_search,
    "catalog": run_catalog,
    "assistant": run_assistant,
    "graph_neighbors": run_graph_neighbors,
    "graph_path": run_graph_path,
}
# Lifecycle methods need their own snapshots; they are registered by app.evaluation.scenarios.
SCENARIO_METHODS: dict[str, Callable[[Path, dict[str, Any], CaseResult], None]] = {}


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct / 100 * (len(ordered) - 1))))
    return round(ordered[index], 2)


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    def block(items: list[CaseResult]) -> dict[str, Any]:
        executed = [r for r in items if r.status != "unsupported"]
        searches = [r for r in items if r.method == "search" and r.recall_at_5 is not None]
        mrr_values = [1 / r.rank if r.rank else 0.0 for r in searches]
        return {
            "cases": len(items),
            "passed": sum(1 for r in items if r.status == "pass"),
            "failed": sum(1 for r in items if r.status == "fail"),
            "errors": sum(1 for r in items if r.status == "error"),
            "unsupported": sum(1 for r in items if r.status == "unsupported"),
            "pass_rate": round(sum(1 for r in items if r.status == "pass") / len(items), 4)
            if items
            else None,
            "pass_rate_executed": (
                round(sum(1 for r in executed if r.status == "pass") / len(executed), 4) if executed else None
            ),
            "recall_at_1": round(statistics.mean(r.recall_at_1 or 0 for r in searches), 4)
            if searches
            else None,
            "recall_at_5": round(statistics.mean(r.recall_at_5 or 0 for r in searches), 4)
            if searches
            else None,
            "mrr": round(statistics.mean(mrr_values), 4) if mrr_values else None,
            "leaks": sum(r.leaks for r in items),
            "context_ok": (
                round(sum(1 for r in items if r.context_ok) / n, 4)
                if (n := sum(1 for r in items if r.context_ok is not None))
                else None
            ),
            "latency_p50_ms": _percentile([r.latency_ms for r in items], 50),
            "latency_p95_ms": _percentile([r.latency_ms for r in items], 95),
        }

    by_category: dict[str, list[CaseResult]] = defaultdict(list)
    for r in results:
        by_category[r.category].append(r)
    return {
        "overall": block(results),
        "tuning_set": block([r for r in results if not r.holdout]),
        "holdout": block([r for r in results if r.holdout]),
        "by_category": {c: block(items) for c, items in sorted(by_category.items())},
        "by_method": {
            m: block([r for r in results if r.method == m]) for m in sorted({r.method for r in results})
        },
    }


def evaluate(kb: Path, cases: list[dict[str, Any]], *, connector: str = "mock") -> dict[str, Any]:
    results: list[CaseResult] = []
    index_generation: Any = None
    with eval_client(kb, connector=connector) as client:
        status = client.get("/api/index/status").json()
        index_generation = status.get("generation", status.get("indexed_version"))
        for case in cases:
            method = str(case.get("method", "search"))
            r = CaseResult(
                case_id=str(case["case_id"]),
                category=str(case.get("category", "?")),
                method=method,
                holdout=bool(case.get("holdout", False)),
                status="error",
            )
            started = time.perf_counter()
            try:
                if method in METHODS:
                    METHODS[method](client, case, r)
                elif method in SCENARIO_METHODS:
                    SCENARIO_METHODS[method](kb, case, r)
                else:
                    r.status, r.detail = "unsupported", f"method {method} not implemented"
            except Exception as exc:
                r.status, r.detail = "error", f"{type(exc).__name__}: {exc}"
            r.latency_ms = round((time.perf_counter() - started) * 1000, 2)
            results.append(r)
    return {"index_generation": index_generation, "results": results}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deterministic knowledge evaluation (no LLM).")
    parser.add_argument("--kb", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--label", default="run")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--connector", default="mock", choices=["mock", "disabled"])
    parser.add_argument("--only", default="", help="comma-separated categories or case ids")
    args = parser.parse_args(argv)

    with contextlib.suppress(ImportError):  # registers lifecycle scenario methods when that module exists
        import app.evaluation.scenarios
    with contextlib.suppress(ImportError):
        import app.evaluation.scenarios_external
    with contextlib.suppress(ImportError):
        import app.evaluation.scenarios_m563  # noqa: F401
    # Run as `python -m`, this module is `__main__`; the scenarios registered into the importable copy.
    registry = sys.modules.get("app.evaluation.knowledge_eval")
    if registry is not None and registry is not sys.modules[__name__]:
        SCENARIO_METHODS.update(registry.SCENARIO_METHODS)

    kb = args.kb.resolve()
    cases = load_cases(args.cases.resolve())
    if args.only:
        wanted = {w.strip() for w in args.only.split(",") if w.strip()}
        cases = [c for c in cases if c["case_id"] in wanted or c.get("category") in wanted]
    run = evaluate(kb, cases, connector=args.connector)
    results: list[CaseResult] = run["results"]
    report = {
        "label": args.label,
        "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
        "commit": _git("rev-parse", "--short", "HEAD"),
        "worktree_dirty": bool(_git("status", "--porcelain")),
        "kb_snapshot_hash": _sha256_dir(kb),
        "cases_hash": _sha256_dir(args.cases.resolve()) if args.cases.is_dir() else None,
        "cases": len(cases),
        "index_generation": run["index_generation"],
        "provider": "mock (deterministic, no LLM)",
        "summary": summarize(results),
        "results": [r.__dict__ for r in results],
    }
    overall = report["summary"]["overall"]
    print(
        f"[{args.label}] cases={overall['cases']} pass={overall['passed']} fail={overall['failed']} "
        f"error={overall['errors']} unsupported={overall['unsupported']} "
        f"R@1={overall['recall_at_1']} R@5={overall['recall_at_5']} MRR={overall['mrr']} leaks={overall['leaks']}"
    )
    for category, block in report["summary"]["by_category"].items():
        print(f"  {category:16} {block['passed']}/{block['cases']} (unsupported {block['unsupported']})")
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / f"{args.label}.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        with (args.out / f"{args.label}_metrics.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                [
                    "scope",
                    "cases",
                    "passed",
                    "failed",
                    "unsupported",
                    "recall_at_1",
                    "recall_at_5",
                    "mrr",
                    "leaks",
                    "latency_p50_ms",
                    "latency_p95_ms",
                ]
            )
            rows = {
                "overall": report["summary"]["overall"],
                "holdout": report["summary"]["holdout"],
                **{f"category:{k}": v for k, v in report["summary"]["by_category"].items()},
            }
            for scope, b in rows.items():
                writer.writerow(
                    [
                        scope,
                        b["cases"],
                        b["passed"],
                        b["failed"],
                        b["unsupported"],
                        b["recall_at_1"],
                        b["recall_at_5"],
                        b["mrr"],
                        b["leaks"],
                        b["latency_p50_ms"],
                        b["latency_p95_ms"],
                    ]
                )
        failures = [r for r in results if r.status != "pass"]
        lines = [f"# Failures — {args.label}", ""]
        lines += [f"- `{r.case_id}` ({r.category}, {r.method}, {r.status}): {r.detail}" for r in failures]
        (args.out / f"{args.label}_failures.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return exit_code(args.label, results)


def exit_code(label: str, results: list[CaseResult]) -> int:
    """0 only when every selected case passed. A red run is never reported as green: fail, error and
    unsupported all count, and an empty selection (e.g. a mistyped --only) proves nothing."""
    sys.stdout.flush()  # the per-category summary above stays before the verdict in a combined log
    if not results:
        print(f"[{label}] RESULT: FAILED — no cases selected", file=sys.stderr)
        return EXIT_CASES_NOT_PASSED
    not_passed = [r for r in results if r.status != "pass"]
    if not_passed:
        listed = ", ".join(f"{r.case_id} ({r.status})" for r in not_passed)
        print(
            f"[{label}] RESULT: FAILED — {len(not_passed)} of {len(results)} case(s) did not pass: {listed}",
            file=sys.stderr,
        )
        return EXIT_CASES_NOT_PASSED
    print(f"[{label}] RESULT: OK — all {len(results)} case(s) passed")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
