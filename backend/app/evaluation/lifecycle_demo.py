"""Five lifecycle demonstrations + example answer traces, recorded as a report (M5.6.2 §6).

Runs in TEMPORARY workspaces (the `fixtures/knowledge_updates` snapshot for the lifecycle demos, a copy of
`fixtures/knowledge` with the synthetic Confluence corpus for the traces), with the deterministic mock AI —
no network, no persisted state touched. Every value in the report comes from the API responses.

    cd backend && ../.venv/bin/python -m app.evaluation.lifecycle_demo --out ../reports/knowledge-eval
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.evaluation.knowledge_eval import eval_client
from app.evaluation.scenarios import _ask, _bump, _draft, _env, _overlay, _search, _sync, _templates

Report = dict[str, Any]


def _answer_summary(answer: dict[str, Any]) -> dict[str, Any]:
    return {
        "confidence": answer.get("confidence"),
        "answer_start": " ".join(str(answer.get("answer", "")).split())[:220],
        "citations": [
            {
                "document_id": c.get("document_id"),
                "source_kind": c.get("source_kind"),
                "revision": c.get("revision"),
                "status": c.get("status") or c.get("external_status"),
                "excerpt": " ".join(str(c.get("excerpt", "")).split())[:140],
            }
            for c in answer.get("citations", [])
        ],
        "instructions_version": answer.get("instructions_version"),
        "index_generation": answer.get("index_generation"),
        "retrieval_trace_id": answer.get("retrieval_trace_id"),
    }


def _edges(client: TestClient, node: str) -> list[str]:
    data = client.get(f"/api/graph/nodes/doc:{node}/neighbors").json()
    return sorted(f"{e['source']} -{e['type']}-> {e['target']}" for e in data.get("edges", []))


def _sync_counts(result: dict[str, Any]) -> dict[str, Any]:
    keys = ("added", "updated", "renamed", "deleted", "rejected", "generation", "checksum", "elapsed_ms")
    return {k: result.get(k) for k in keys}


def demo_add() -> Report:
    with _env() as (kb, _, make):
        c = make()
        before = _search(c, "SYNTHETIC_Q7_FIELD")
        _overlay(kb, "add")
        result = _sync(c)
        answer = _ask(c, "Что означает поле SYNTHETIC_Q7_FIELD?")
        return {
            "title": "Добавление утверждённого документа",
            "change": "overlay add/: новый DEMO-TEST-NEW-001 (approved, depends_on DEMO-TEST-SEM-009)",
            "search_before": before,
            "sync": _sync_counts(result),
            "search_after": _search(c, "SYNTHETIC_Q7_FIELD"),
            "graph_after": _edges(c, "DEMO-TEST-NEW-001"),
            "answer_after": _answer_summary(answer),
        }


def demo_update_rule() -> Report:
    with _env() as (kb, _, make):
        c = make()
        question = "Какое значение DEMO_VALIDATION_LIMIT?"
        before = _answer_summary(_ask(c, question))
        old_word = _search(c, "квазиреликт")
        _overlay(kb, "update")
        result = _sync(c)
        return {
            "title": "Изменение правила (7 → 11) с новой версией",
            "change": "overlay update/: DEMO-TEST-REV-001 version 1.0 → 2.0, DEMO_VALIDATION_LIMIT 7 → 11",
            "answer_before": before,
            "old_unique_word_before": old_word,
            "sync": _sync_counts(result),
            "answer_after": _answer_summary(_ask(c, question)),
            "old_unique_word_after": _search(c, "квазиреликт"),
        }


def demo_delete() -> Report:
    with _env() as (kb, _, make):
        c = make()
        before = _search(c, "гелиодор")
        (kb / "DEMO-TEST-DEL-001.md").unlink()
        result = _sync(c)
        diagnostics = c.get("/api/graph/diagnostics").json()
        return {
            "title": "Удаление документа",
            "change": "DEMO-TEST-DEL-001.md удалён; DEMO-TEST-REF-001 продолжает на него ссылаться",
            "search_before": before,
            "sync": _sync_counts(result),
            "search_after": _search(c, "гелиодор"),
            "document_after_status": c.get("/api/documents/DEMO-TEST-DEL-001").status_code,
            "dangling_after": diagnostics.get("dangling"),
        }


def demo_relation() -> Report:
    with _env() as (kb, _, make):
        c = make()
        before = _edges(c, "DEMO-TEST-MAP-001")
        _overlay(kb, "update_relation")
        result = _sync(c)
        return {
            "title": "Изменение связи maps_to",
            "change": "overlay update_relation/: DEMO-TEST-MAP-001 maps_to SEM-009 → SEM-010",
            "graph_before": before,
            "sync": _sync_counts(result),
            "graph_after": _edges(c, "DEMO-TEST-MAP-001"),
        }


def demo_template() -> Report:
    with _env(templates=True) as (_, tdir, make):
        c = make()
        assert tdir is not None
        before = {k: v["version"] for k, v in _templates(c).items()}
        old_draft = _draft(c, "dataset_spec")
        (tdir / "glossary_entry.md").write_text(
            '---\ntemplate_id: glossary_entry\ntitle: Термин глоссария\ndescription: "Новый демо-шаблон."\n'
            "doc_type: glossary\nid_prefix: SEM-GLS\ndefault_tags: [glossary]\norder: 70\nversion: 1\n---\n"
            "## Термин\n> Требует уточнения: термин.\n\n## Определение\n> Требует уточнения: определение.\n",
            encoding="utf-8",
        )
        _bump(tdir, "dataset.md")
        sync = c.post("/api/index/sync").json()
        after = {k: v["version"] for k, v in _templates(c).items()}
        new_draft = _draft(c, "glossary_entry")
        old_detail = c.get(f"/api/drafts/{old_draft['id']}").json()
        return {
            "title": "Новый шаблон и новая версия существующего",
            "change": "добавлен glossary_entry v1; dataset_spec изменён с повышением версии",
            "templates_before": before,
            "template_registry_after": sync.get("template_registry"),
            "templates_after": after,
            "new_draft_template_version": new_draft.get("template_version"),
            "old_draft": {
                "template_version": old_detail.get("template_version"),
                "template_current_version": old_detail.get("template_current_version"),
                "content_unchanged": old_detail.get("proposed_content") == old_draft.get("proposed_content"),
            },
        }


TRACE_QUESTIONS: list[tuple[str, dict[str, Any]]] = [
    ("Какой порог полноты действует для Process Overview?", {"sources": ["team"]}),
    (
        "В какой срок стюард должен зарегистрировать соответствие в MAP_ARIS_PROCESS?",
        {"sources": ["team", "corporate"]},
    ),
    ("Какие правила действуют для черновика DEMO-SEM-012?", {"sources": ["team"]}),
]


def example_traces(kb: Path) -> list[Report]:
    traces: list[Report] = []
    with eval_client(kb) as c:
        for question, extra in TRACE_QUESTIONS:
            answer = _ask(c, question, **extra)
            trace_id = answer.get("retrieval_trace_id")
            graph = c.get(f"/api/graph/query/{trace_id}").json() if trace_id else {}
            search = c.get("/api/search", params={"q": question, "limit": 3}).json()
            traces.append(
                {
                    "question": question,
                    "request": extra,
                    "search_top3": [
                        {"id": i["id"], "status": i.get("status"), "reasons": i.get("match_reasons")}
                        for i in search.get("items", [])
                    ],
                    "external": answer.get("external"),
                    "answer": _answer_summary(answer),
                    "query_graph": {
                        "nodes": len(graph.get("nodes", [])),
                        "edges": len(graph.get("edges", [])),
                        "origins": sorted({e.get("origin") for e in graph.get("edges", [])}),
                    },
                }
            )
    return traces


def _markdown(demos: list[Report]) -> str:
    lines = ["# Lifecycle demonstrations (generated by app.evaluation.lifecycle_demo)", ""]
    for i, demo in enumerate(demos, 1):
        lines.append(f"## {i}. {demo['title']}")
        lines.append("")
        for key, value in demo.items():
            if key == "title":
                continue
            lines.append(f"- **{key}**: `{json.dumps(value, ensure_ascii=False)}`")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lifecycle demos and example traces (synthetic, offline).")
    parser.add_argument(
        "--kb", type=Path, default=Path(__file__).resolve().parents[3] / "fixtures" / "knowledge"
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    demos = [demo_add(), demo_update_rule(), demo_delete(), demo_relation(), demo_template()]
    traces = example_traces(args.kb.resolve())
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "sync_summary.json").write_text(
        json.dumps(demos, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.out / "sync_summary.md").write_text(_markdown(demos), encoding="utf-8")
    (args.out / "example_traces.json").write_text(
        json.dumps(traces, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[lifecycle-demo] {len(demos)} demos, {len(traces)} traces → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
