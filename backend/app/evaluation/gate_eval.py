"""Adaptive RAG evaluation (docs/ADAPTIVE_RAG.md, reports/adaptive-rag/): the external-search DECISION and what it
brings, per case, on the same synthetic corpus, for different code versions and model doubles. Offline, no LLM.

    cd backend
    ../.venv/bin/python -m app.evaluation.gate_eval --cases ../fixtures/eval_adaptive/cases.yaml \\
        --variant oracle --split dev --out ../reports/adaptive-rag/eval --label oracle_dev
    ../.venv/bin/python -m app.evaluation.gate_eval --validate --cases ../fixtures/eval_adaptive/cases.yaml
    ../.venv/bin/python -m app.evaluation.gate_eval --table ../reports/adaptive-rag/eval/*.json

Variants:
- `lexical` — the configured provider (the offline mock): LOCAL_SUFFICIENCY v1 on main `f4ea26e`, v2 on
  `fix/skh-retrieval-quality`, v2 again on this branch (the mock has no gap capability). Uses only stable imports,
  so this file can be copied into an old worktree to measure the old code on the same cases.
- `oracle`, `weak`, `always_external`, `always_sufficient` — scripted doubles (app/evaluation/gap_doubles.py). The
  oracle is a perfect reader of the cards it is shown (an upper bound of the pipeline), NOT a model measurement.
`--noise N` adds N synthetic distractor pages to the mock Confluence corpus (a large, noisy wiki).

Every number comes from the API response, the discovery trace and the passages the assistant actually prepared
(captured by wrapping `_record`; nothing is re-run, so no extra model or MCP call is made). TARGET_MODEL_NOT_VALIDATED.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import statistics
import sys
import tempfile
import time
import warnings
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[3]
KB = PROJECT_ROOT / "fixtures" / "knowledge"
MOCK_CORPUS = PROJECT_ROOT / "fixtures" / "confluence_mock" / "pages.yaml"
HEADERS = {"X-SKH-Client": "eval"}
BOTH = ["team", "corporate"]
# Pages and markers no reader of this evaluation may ever see (ACL / space allowlist of the mock).
INVISIBLE_PAGES = {"200118", "200119", "200120", "MOCK-1003", "MOCK-9001"}
INVISIBLE_MARKERS = ("RESTRICTED-MOCK-MARKER", "PRIVATE-SPACE-MOCK-MARKER", "4,2 млн", "38 учётных")
NON_AUTHORITATIVE = {"draft", "in_review", "deprecated"}
# `configured` = the provider the settings configure, unchanged (the sign-off run on the target model, --set ai_*=…);
# `lexical` is the same code path, named for the offline mock where it means LOCAL_SUFFICIENCY.
VARIANTS = ("lexical", "configured", "oracle", "weak", "always_external", "always_sufficient")


def norm(text: str) -> str:
    return " ".join(text.replace("ё", "е").replace("Ё", "Е").split()).casefold()


def load_cases(path: Path, split: str) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("cases") or []
    return [c for c in cases if split == "all" or c.get("split") == split]


# --- label validation ------------------------------------------------------------------------------------------------
def _corpus() -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    docs: dict[str, tuple[str, str]] = {}
    for path in KB.rglob("*.md"):
        _, front, body = path.read_text(encoding="utf-8").split("---", 2)
        meta = yaml.safe_load(front)
        docs[str(meta["id"])] = (str(meta.get("status")), norm(body))
    pages = {
        str(p["page_id"]): norm(re.sub(r"<[^>]+>", " ", str(p.get("body") or "")))
        for p in (yaml.safe_load(MOCK_CORPUS.read_text(encoding="utf-8")) or {}).get("pages") or []
    }
    return docs, pages


def validate(cases: list[dict[str, Any]]) -> list[str]:
    """Every labelled fact is verbatim in its source; team sources are approved; the schema is complete."""
    docs, pages = _corpus()
    problems: list[str] = []
    for case in cases:
        cid = case.get("id", "?")
        if case.get("expected") not in ("sufficient", "need_external"):
            problems.append(f"{cid}: expected must be sufficient | need_external")
        if case.get("split") not in ("dev", "holdout"):
            problems.append(f"{cid}: split must be dev | holdout")
        for fact in case.get("facts") or []:
            source, text = str(fact.get("source")), norm(str(fact.get("text")))
            if source.startswith("confluence:"):
                if text not in pages.get(source.split(":", 1)[1], ""):
                    problems.append(f"{cid}: fact not verbatim in {source}: {fact.get('text')}")
            elif source not in docs:
                problems.append(f"{cid}: unknown team document {source}")
            elif docs[source][0] != "approved":
                problems.append(f"{cid}: team source {source} is {docs[source][0]}, not approved")
            elif text not in docs[source][1]:
                problems.append(f"{cid}: fact not verbatim in {source}: {fact.get('text')}")
        if case.get("expected") == "need_external" and not case.get("queries"):
            problems.append(f"{cid}: need_external without labelled queries")
    return problems


# --- the isolated app ------------------------------------------------------------------------------------------------
def noise_pages(count: int, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Distractors of a large wiki: near-duplicates of the visible pages (meeting notes with the SAME title words)
    that state no fact — what a big Confluence returns for any question on a topic. Deterministic."""
    visible = [
        p for p in pages if p.get("space") in ("DEMO", "ARCH", "OPS") and not p.get("allowed_users")
    ] or [{"title": "Обсуждение"}]
    noise = []
    for i in range(count):
        title = str(visible[i % len(visible)]["title"])
        noise.append(
            {
                "page_id": str(290000 + i),
                "space": ("DEMO", "OPS", "ARCH")[i % 3],
                "title": f"Обсуждение: {title} — встреча №{i}",
                "status": "unknown",
                "body": (
                    f"<p>На встрече №{i} обсуждали страницу «{title}»: расписание, владельца, ограничения, лимиты, "
                    "сроки, исключения, ошибки и доступ. Решения не приняты; протокол будет опубликован позже.</p>"
                ),
            }
        )
    return noise


@contextmanager
def eval_client(noise: int, overrides: dict[str, Any]) -> Iterator[TestClient]:
    with tempfile.TemporaryDirectory(prefix="skh-gate-eval-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace" / "knowledge"
        shutil.copytree(KB, workspace)
        corpus = MOCK_CORPUS
        if noise:
            data = yaml.safe_load(MOCK_CORPUS.read_text(encoding="utf-8"))
            data["pages"] = list(data["pages"]) + noise_pages(noise, list(data["pages"]))
            corpus = root / "pages_with_noise.yaml"
            corpus.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
        values: dict[str, Any] = {
            "app_env": "test",
            "project_root": root,
            "local_knowledge_dir": workspace,
            "fixtures_dir": KB,
            "seed_fixtures": False,
            "search_index_path": root / "workspace" / "search.sqlite3",
            "app_state_path": root / "workspace" / "app_state.sqlite3",
            "publication_state_path": root / "workspace" / "publications.sqlite3",
            "repository_refresh_seconds": 0.0,
            "ai_provider": "mock",
            "confluence_connector": "mock",
            "confluence_mock_pages_path": corpus,
            "confluence_mock_state_path": root / "mock_confluence_state.json",
            **overrides,
        }
        app = create_app(Settings(_env_file=None, **values))
        with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
            yield client


def install_double(client: TestClient, variant: str, cases: list[dict[str, Any]], seed: int) -> Any:
    if variant in ("lexical", "configured"):
        return None
    from app.evaluation import gap_doubles as d

    labels = [
        d.GapLabel(
            question=str(c["question"]),
            facts=tuple(str(f["text"]) for f in c.get("facts") or []),
            missing=tuple(str(m) for m in c.get("missing") or []),
            queries=tuple(str(q) for q in c.get("queries") or []),
        )
        for c in cases
    ]
    scripts = {
        "oracle": d.oracle_script(labels),
        "weak": d.weak_script(labels, seed),
        "always_external": d.always_external_script,
        "always_sufficient": d.always_sufficient_script,
    }
    provider = d.ScriptedGapProvider(scripts[variant])
    client.app.state.container.assistant._provider = provider  # type: ignore[attr-defined]
    return provider


def capture_prepared(client: TestClient) -> dict[str, Any]:
    """Wrap `_record` (called once per answer with the prepared context) — nothing is re-run."""
    assistant = client.app.state.container.assistant  # type: ignore[attr-defined]
    box: dict[str, Any] = {}
    original = assistant._record

    def record(*args: Any, **kwargs: Any) -> Any:
        for value in (*args, *kwargs.values()):
            if hasattr(value, "passages") and hasattr(value, "terms"):
                box["prepared"] = value
        return original(*args, **kwargs)

    assistant._record = record
    return box


# --- one case ----------------------------------------------------------------------------------------------------------
def model_calls(provider: Any, before: int, gate: dict[str, Any]) -> int:
    """Doubles record their gap calls; a configured (real) provider is counted by the server's own trace."""
    if provider is not None:
        return len(provider.calls) - before
    return int(gate.get("model_calls") or 0)


def gap_prompt_chars(provider: Any, start: int) -> int:
    if provider is None:
        return 0
    from app.adapters.ai.gap_protocol import build_gap_message, gap_system_prompt

    return sum(
        len(gap_system_prompt()) + len(build_gap_message(request, 3500)) for request in provider.calls[start:]
    )


def run_case(client: TestClient, case: dict[str, Any], provider: Any, box: dict[str, Any]) -> dict[str, Any]:
    connector = client.app.state.container.corporate  # type: ignore[attr-defined]
    before_calls = dict(getattr(connector, "calls", {}))
    model_before = len(provider.calls) if provider is not None else 0
    box.clear()
    started = time.perf_counter()
    response = client.post("/api/assistant/ask", json={"question": case["question"], "sources": BOTH})
    latency = round((time.perf_counter() - started) * 1000, 2)
    row: dict[str, Any] = {
        "id": case["id"],
        "split": case.get("split"),
        "category": case.get("category"),
        "expected": case["expected"],
        "status": response.status_code,
        "latency_ms": latency,
    }
    if response.status_code != 200:
        row["error"] = response.text[:300]
        return row
    body = response.json()
    external = body.get("external") or {}
    gate = body.get("evidence_gate") or {}
    called = bool(external.get("called"))
    after_calls = dict(getattr(connector, "calls", {}))
    prepared = box.get("prepared")
    passages = list(getattr(prepared, "passages", []) or [])
    context = norm(" ".join(f"{p.title} {p.section or ''} {p.text}" for p in passages))
    facts = [str(f["text"]) for f in case.get("facts") or []]
    in_context = [f for f in facts if norm(f) in context]
    answer_text = norm(body.get("answer") or "")
    by_doc: dict[str, str] = {}
    for p in passages:
        by_doc[p.document_id] = by_doc.get(p.document_id, "") + " " + norm(p.text)
    invalid = [
        c["document_id"]
        for c in body.get("citations") or []
        if not all(
            norm(part.strip(" …")) in by_doc.get(c["document_id"], "") for part in c["excerpt"].split(" … ")
        )
    ]
    leaks = sorted(
        {p.document_id for p in passages if getattr(p.status, "value", p.status) in NON_AUTHORITATIVE}
        | {p.document_id for p in passages if p.document_id in INVISIBLE_PAGES}
        | {c["document_id"] for c in body.get("citations") or [] if c["document_id"] in INVISIBLE_PAGES}
        | {m for m in INVISIBLE_MARKERS if m in json.dumps(body, ensure_ascii=False)}
    )
    page = str(case.get("external_page") or "")
    external_ids = {p.document_id for p in passages if p.source_type == "confluence"}
    row.update(
        {
            "called": called,
            "decision_ok": called == (case["expected"] == "need_external"),
            # The right call for the evidence the assistant actually had: a «sufficient» question whose facts the
            # local retrieval did not bring into context IS a gap for the gate (a retrieval miss, not a gate error).
            "expected_given_context": "sufficient"
            if case["expected"] == "sufficient" and all(norm(f) in context for f in facts)
            else "need_external",
            "decision": gate.get("decision") or ("need_external" if called else "sufficient"),
            "reason": gate.get("reason") or external.get("trigger") or "local_sufficient",
            "policy": gate.get("policy") or "lexical-legacy",
            "model_calls": model_calls(provider, model_before, gate),
            "repaired": bool(gate.get("repaired")),
            "fallback": gate.get("fallback"),
            "gate_error": gate.get("error"),
            "queries": gate.get("queries", 0),
            "queries_rejected": gate.get("queries_rejected", 0),
            "incomplete": bool(gate.get("incomplete")),
            "mcp_search": after_calls.get("search", 0) - before_calls.get("search", 0),
            "mcp_get": after_calls.get("get_page", 0) - before_calls.get("get_page", 0),
            "fetched": external.get("fetched", 0),
            "cache_hits": external.get("cache_hits", 0),
            "outcome": external.get("outcome"),
            "facts": len(facts),
            "facts_in_context": len(in_context),
            "context_ok": len(in_context) == len(facts) if facts else None,
            "external_page": page or None,
            "external_page_in_context": (page in external_ids) if page else None,
            "facts_in_answer": sum(1 for f in facts if norm(f) in answer_text),
            "citations": len(body.get("citations") or []),
            "external_citations": sum(
                1 for c in body.get("citations") or [] if c.get("source_kind") == "confluence_mcp"
            ),
            "invalid_citations": invalid,
            "leaks": leaks,
            "confidence": body.get("confidence"),
            "unconfirmed_warning": any("не удалось подтвердить" in w for w in body.get("warnings") or []),
            "gap_prompt_chars": gap_prompt_chars(provider, model_before),
        }
    )
    return row


# --- aggregates --------------------------------------------------------------------------------------------------------
def pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, math.ceil(p / 100 * len(ordered)) - 1)], 2)


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [r for r in rows if r.get("status") == 200]
    suff = [r for r in ok if r["expected"] == "sufficient"]
    need = [r for r in ok if r["expected"] == "need_external"]
    with_facts = [r for r in ok if r.get("context_ok") is not None]
    with_page = [r for r in ok if r.get("external_page")]
    confusion: Counter[str] = Counter(f"{r['expected']}→{r['decision']}" for r in ok)
    local = [r["latency_ms"] for r in ok if not r["called"]]
    ext = [r["latency_ms"] for r in ok if r["called"]]
    return {
        "cases": len(rows),
        "errors": len(rows) - len(ok),
        "decision_accuracy": round(sum(r["decision_ok"] for r in ok) / len(ok), 4) if ok else None,
        "decision_accuracy_given_context": round(
            sum(
                r["called"] == (r.get("expected_given_context", r["expected"]) == "need_external") for r in ok
            )
            / len(ok),
            4,
        )
        if ok
        else None,
        "false_external": sum(r["called"] for r in suff),
        "missed_external": sum(not r["called"] for r in need),
        "sufficient_cases": len(suff),
        "need_external_cases": len(need),
        "confusion": dict(sorted(confusion.items())),
        "context_ok": round(sum(bool(r["context_ok"]) for r in with_facts) / len(with_facts), 4)
        if with_facts
        else None,
        "context_ok_n": f"{sum(bool(r['context_ok']) for r in with_facts)}/{len(with_facts)}",
        "fact_coverage": round(
            sum(r["facts_in_context"] for r in with_facts) / max(1, sum(r["facts"] for r in with_facts)), 4
        ),
        "answer_fact_coverage": round(
            sum(r["facts_in_answer"] for r in with_facts) / max(1, sum(r["facts"] for r in with_facts)), 4
        ),
        "external_page_recall": f"{sum(bool(r['external_page_in_context']) for r in with_page)}/{len(with_page)}",
        "invalid_citations": sum(len(r["invalid_citations"]) for r in ok),
        "leaks": sum(len(r["leaks"]) for r in ok),
        "model_calls": sum(r["model_calls"] for r in ok),
        "repairs": sum(r["repaired"] for r in ok),
        "invalid_decisions": sum(r["decision"] == "invalid" for r in ok),
        "queries_rejected": sum(r["queries_rejected"] for r in ok),
        "mcp_search": sum(r["mcp_search"] for r in ok),
        "mcp_get": sum(r["mcp_get"] for r in ok),
        "fetched": sum(r["fetched"] for r in ok),
        "gap_prompt_chars_mean": round(
            statistics.mean([r["gap_prompt_chars"] for r in ok if r["model_calls"]]), 1
        )
        if any(r["model_calls"] for r in ok)
        else 0,
        "latency_local_p50": pct(local, 50),
        "latency_local_p95": pct(local, 95),
        "latency_external_p50": pct(ext, 50),
        "latency_external_p95": pct(ext, 95),
        "unconfirmed_warning_when_nothing_found": f"{sum(r['unconfirmed_warning'] for r in ok if r.get('outcome') in ('no_match', 'insufficient_evidence'))}/{sum(1 for r in ok if r.get('outcome') in ('no_match', 'insufficient_evidence'))}",
    }


def table(paths: list[Path]) -> str:
    keys = (
        "decision_accuracy",
        "decision_accuracy_given_context",
        "false_external",
        "missed_external",
        "context_ok_n",
        "fact_coverage",
        "answer_fact_coverage",
        "external_page_recall",
        "invalid_citations",
        "leaks",
        "model_calls",
        "invalid_decisions",
        "mcp_search",
        "mcp_get",
        "latency_local_p95",
        "latency_external_p95",
    )
    runs = [json.loads(p.read_text(encoding="utf-8")) for p in paths]
    lines = ["| run | " + " | ".join(keys) + " |", "|---|" + "---:|" * len(keys)]
    for run in runs:
        agg = run["aggregate"]
        lines.append(f"| {run['label']} | " + " | ".join(str(agg.get(k)) for k in keys) + " |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else "")
    parser.add_argument(
        "--cases", type=Path, default=PROJECT_ROOT / "fixtures" / "eval_adaptive" / "cases.yaml"
    )
    parser.add_argument("--split", choices=("dev", "holdout", "all"), default="dev")
    parser.add_argument("--variant", choices=VARIANTS, default="lexical")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--noise", type=int, default=0)
    parser.add_argument(
        "--set", action="append", default=[], help="Settings override key=value (new code only)"
    )
    parser.add_argument("--out", type=Path)
    parser.add_argument("--label")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--table", nargs="*", type=Path)
    args = parser.parse_args(argv)

    if args.table:
        print(table(args.table))
        return 0
    cases = load_cases(args.cases, args.split)
    if args.validate:
        problems = validate(load_cases(args.cases, "all"))
        for problem in problems:
            print(problem)
        split = Counter(c.get("split") for c in load_cases(args.cases, "all"))
        print(
            f"cases={sum(split.values())} dev={split['dev']} holdout={split['holdout']} problems={len(problems)}"
        )
        return 1 if problems else 0
    if not cases:
        print("no cases selected", file=sys.stderr)
        return 1
    overrides: dict[str, Any] = {}
    for item in args.set:
        key, _, value = item.partition("=")
        overrides[key] = value
    with eval_client(args.noise, overrides) as client:
        provider = install_double(client, args.variant, cases, args.seed)
        box = capture_prepared(client)
        rows = [run_case(client, case, provider, box) for case in cases]
    label = args.label or f"{args.variant}_{args.split}_n{args.noise}"
    result = {
        "label": label,
        "variant": args.variant,
        "split": args.split,
        "noise": args.noise,
        "seed": args.seed if args.variant == "weak" else None,
        "settings": overrides,
        "cases_file": str(args.cases.name),
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "aggregate": aggregate(rows),
        "rows": rows,
    }
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / f"{label}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    agg = result["aggregate"]
    print(
        f"[{label}] cases={agg['cases']} decision_accuracy={agg['decision_accuracy']} "
        f"given_context={agg['decision_accuracy_given_context']} "
        f"false_external={agg['false_external']} missed_external={agg['missed_external']} "
        f"context_ok={agg['context_ok_n']} ext_page={agg['external_page_recall']} invalid_citations="
        f"{agg['invalid_citations']} leaks={agg['leaks']} model_calls={agg['model_calls']} mcp_search="
        f"{agg['mcp_search']} mcp_get={agg['mcp_get']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
