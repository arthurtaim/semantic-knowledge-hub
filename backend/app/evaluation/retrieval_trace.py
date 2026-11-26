"""Retrieval diagnostics (developer tool): where along the pipeline a fact of an evaluation case is lost.

    question → analysis (terms, dictionary) → FTS candidates → ranked documents → chunk candidates
    → selected passages → bounded assistant context → local sufficiency / external → answer → citations

Runs on a fresh temporary copy of a SYNTHETIC knowledge snapshot with the mock provider (no network, no model),
exactly like `knowledge_eval`. Nothing is written to application logs: the trace goes to stdout or `--out` only.

    python -m app.evaluation.retrieval_trace --kb ../fixtures/knowledge --cases ../fixtures/eval \
        --case KE-SEM-011 --out trace.json

Holdout cases are refused unless `--allow-holdout` is given (a final, post-freeze diagnosis only): tracing a blind
case while tuning would turn it into a tuning case. `--question` traces an ad-hoc question (a tuning probe).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from app.adapters.search.base import SearchFilters
from app.domain.models import AskRequest, DocStatus
from app.domain.text import term_matches_text, tokenize
from app.evaluation.knowledge_eval import eval_client, load_cases
from app.services.assistant import local_insufficiency

TOP = 12


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


def _facts_in(text: str, facts: list[str]) -> list[str]:
    haystack = _norm(text)
    return [f for f in facts if _norm(f) in haystack]


def _allowed(include_drafts: bool, include_deprecated: bool) -> frozenset[str]:
    allowed = {DocStatus.approved}
    if include_drafts:
        allowed |= {DocStatus.draft, DocStatus.in_review}
    if include_deprecated:
        allowed.add(DocStatus.deprecated)
    return frozenset(s.value for s in allowed)


def trace(client: Any, case: dict[str, Any]) -> dict[str, Any]:
    container = client.app.state.container
    portal = client.portal
    user = container.demo_user()
    knowledge = container.knowledge
    retrieval = knowledge.retrieval
    search = knowledge.search_provider
    expected = [str(i) for i in case.get("expected_doc_ids") or []]
    facts = [str(f) for f in case.get("facts_required") or []]
    body = {
        "question": case["question"],
        "include_drafts": bool(case.get("include_drafts", False)),
        "include_deprecated": bool(case.get("include_deprecated", False)),
        "sources": case.get("sources", ["team"]),
    }
    if case.get("history"):
        body["history"] = [{"question": str(q), "answer": ""} for q in case["history"]]
    req = AskRequest(**body)
    base = req.question if not req.history else f"{req.question} {req.history[-1].question}"
    analysis = retrieval.analyze(base)
    filters = SearchFilters(statuses=_allowed(req.include_drafts, req.include_deprecated))
    snapshot = portal.call(knowledge.snapshot, user)
    out: dict[str, Any] = {"case_id": case.get("case_id"), "expected": expected, "facts_required": facts}

    out["analysis"] = {
        "normalized": analysis.normalized,
        "notes": analysis.notes,
        "id_candidates": analysis.id_candidates,
        "terms": [
            {
                "original": t.original,
                "stem": t.stem,
                "alternatives": [list(a) for a in t.alternatives],
                "expansion": t.expansion,
                "entity_like": t.is_entity_like,
            }
            for t in analysis.terms
        ],
    }
    # Where the facts live: every section of the expected documents (not limited to what retrieval chose).
    where: dict[str, list[dict[str, Any]]] = {}
    for doc_id in expected:
        doc = snapshot.get(doc_id)
        if doc is None:
            where[doc_id] = [{"error": "not in the reader's snapshot"}]
            continue
        rows = []
        for ordinal, s in enumerate(doc.sections):
            words = tokenize(f"{s.heading} {s.text}")
            rows.append(
                {
                    "ordinal": ordinal,
                    "heading": s.heading,
                    "chars": len(s.text),
                    "terms_matched": [t.original for t in analysis.terms if term_matches_text(t, words)],
                    "facts": _facts_in(s.text, facts),
                }
            )
        where[doc_id] = rows
    out["fact_locations"] = where

    fts_and = search.search_documents(analysis.terms, filters, 200, mode="and", snippets=False)
    fts_or = search.search_documents(analysis.terms, filters, 200, mode="or", snippets=False)
    out["fts"] = {
        "and_count": len(fts_and),
        "and_top": [(h.document_id, h.score) for h in fts_and[:TOP]],
        "or_count": len(fts_or),
        "or_top": [(h.document_id, h.score) for h in fts_or[:TOP]],
        "expected_rank_and": {e: _pos([h.document_id for h in fts_and], e) for e in expected},
        "expected_rank_or": {e: _pos([h.document_id for h in fts_or], e) for e in expected},
    }
    ranked = retrieval.rank_documents(snapshot, analysis, filters, 20, expand_graph=False, catalog=False)
    out["ranked"] = [
        {
            "id": h.document_id,
            "score": round(h.score, 3),
            "fields": h.matched_fields,
            "reasons": h.reasons[:3],
        }
        for h in ranked[:TOP]
    ]
    out["expected_rank"] = {e: _pos([h.document_id for h in ranked], e) for e in expected}
    chunks = search.search_chunks(analysis.terms, filters, 60)
    out["chunk_candidates"] = {
        "count": len(chunks),
        "per_document": {
            doc_id: [(i + 1, c.section) for i, c in enumerate(chunks) if c.document_id == doc_id]
            for doc_id in dict.fromkeys([*expected, *(h.document_id for h in ranked[:4])])
        },
    }
    selected, chosen = retrieval.passages(snapshot, analysis, filters)
    out["selected_documents"] = [h.document_id for h in chosen]
    out["selected_passages"] = [
        {"doc": p.document.id, "section": p.section, "chars": len(p.text), "facts": _facts_in(p.text, facts)}
        for p in selected
    ]
    prepared = portal.call(container.assistant._prepare, user, req)
    context_text = " ".join(p.text for p in prepared.passages)
    matched = {t.stem for t in prepared.terms if t.stem not in {u.stem for u in prepared.unmatched}}
    out["context"] = {
        "passages": [
            {"cid": p.cid, "doc": p.document_id, "section": p.section, "chars": len(p.text)}
            for p in prepared.passages
        ],
        "chars": len(context_text),
        "facts_in_context": _facts_in(context_text, facts),
        "expected_docs_in_context": [e for e in expected if e in {p.document_id for p in prepared.passages}],
        "mode": prepared.mode,
        "local_insufficiency": local_insufficiency(
            [p for p in prepared.passages if p.source_type != "confluence"],
            prepared.terms,
            matched,
            frequency=[len(search.matching_document_ids(t, filters)) for t in prepared.terms],
            eligible=sum(
                1 for d in snapshot.documents.values() if d.status.value in (filters.statuses or ())
            ),
        ),
        "external_called": bool(prepared.external is not None),
    }
    response = client.post("/api/assistant/ask", json=body).json()
    cited_text = " ".join(c["excerpt"] for c in response.get("citations", []))
    out["answer"] = {
        "confidence": response.get("confidence"),
        "cited": [(c["document_id"], c.get("section")) for c in response.get("citations", [])],
        "facts_cited": _facts_in(cited_text, facts),
        "facts_stated": _facts_in(response.get("answer", ""), facts),
        "external": {
            k: (response.get("external") or {}).get(k) for k in ("called", "trigger", "fetched", "searched")
        },
    }
    out["loss_stage"] = _loss_stage(out, expected, facts)
    return out


def _pos(ids: list[str], wanted: str) -> int | None:
    return ids.index(wanted) + 1 if wanted in ids else None


def _loss_stage(out: dict[str, Any], expected: list[str], facts: list[str]) -> str:
    """First stage where an expected document or fact is missing: retrieval → packing → generation."""
    ranked = [r["id"] for r in out["ranked"]]
    if any(e not in ranked[:4] for e in expected):
        return "retrieval (expected document outside the 4 context documents)"
    ctx = out["context"]
    if set(expected) - set(ctx["expected_docs_in_context"]) or set(facts) - set(ctx["facts_in_context"]):
        return "passage packing (document ranked, section/fact not in the bounded context)"
    ans = out["answer"]
    cited_docs = {d for d, _ in ans["cited"]}
    if set(expected) - cited_docs or set(facts) - set(ans["facts_cited"]) - set(ans["facts_stated"]):
        return "generation (everything in context; the provider did not cite/state it)"
    return "none (all expected documents and facts reached the answer)"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Trace one evaluation case through the retrieval pipeline.")
    parser.add_argument("--kb", type=Path, required=True)
    parser.add_argument("--cases", type=Path, default=None)
    parser.add_argument("--case", action="append", default=[], help="case id (repeatable)")
    parser.add_argument("--question", default=None, help="ad-hoc question instead of a case")
    parser.add_argument("--expected", default="", help="comma-separated expected ids for --question")
    parser.add_argument("--sources", default="team")
    parser.add_argument("--allow-holdout", action="store_true", help="final post-freeze diagnosis only")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)

    cases: list[dict[str, Any]] = []
    if args.question:
        cases.append(
            {
                "case_id": "adhoc",
                "question": args.question,
                "expected_doc_ids": [e for e in args.expected.split(",") if e],
                "sources": args.sources.split(","),
            }
        )
    if args.case:
        if args.cases is None:
            parser.error("--case needs --cases")
        by_id = {c["case_id"]: c for c in load_cases(args.cases.resolve())}
        for case_id in args.case:
            case = by_id.get(case_id)
            if case is None:
                parser.error(f"unknown case {case_id}")
            if case.get("holdout") and not args.allow_holdout:
                print(
                    f"{case_id} is a holdout case: refused (use --allow-holdout after the freeze)",
                    file=sys.stderr,
                )
                return 2
            cases.append(case)
    if not cases:
        parser.error("nothing to trace: give --case or --question")
    traces = []
    with eval_client(args.kb.resolve()) as client:
        for case in cases:
            traces.append(trace(client, case))
    text = json.dumps(traces, ensure_ascii=False, indent=1, default=str)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
