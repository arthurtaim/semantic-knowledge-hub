"""Independent audit of every citation of every `method: assistant` case (does not trust the server's own checks).

For each answer: a team citation must name a document of the reader's snapshot with an ALLOWED status for that request
and a revision equal to the snapshot's, and its excerpt must occur verbatim (whitespace-normalised, «…»-separated
parts) in the text of the cited section; a Confluence citation must name a page of the synthetic mock corpus and its excerpt
words must occur in that order in the page's text (HTML stripped,
letters and digits only). Run with the backend under test on PYTHONPATH:

    PYTHONPATH=<backend> .venv/bin/python reports/retrieval-quality/tools/citation_audit.py \
        fixtures/knowledge fixtures/eval <label>
"""

from __future__ import annotations

import html
import json
import re
import sys
import warnings
from pathlib import Path
from typing import Any

import yaml

warnings.filterwarnings("ignore")
from app.evaluation.knowledge_eval import MOCK_CORPUS, eval_client  # noqa: E402

KB, CASES, LABEL = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]


def norm(text: str) -> str:
    text = re.sub(r"[`*]", "", html.unescape(re.sub(r"<[^>]+>", " ", text)))
    return " ".join(text.split()).casefold()


def words(text: str) -> str:
    """Letters and digits only, in order: the page's HTML → text conversion adds list markers («- », «1. »)."""
    return " ".join(re.findall(r"[^\W_]+", norm(text)))


def same_words(excerpt: str, source_words: str) -> bool:
    parts = [words(p) for p in excerpt.split("…")]
    return all(f" {p} " in f" {source_words} " for p in parts if p)


def verbatim(excerpt: str, source: str) -> bool:
    parts = [p.strip().strip("…").strip() for p in excerpt.split("…")]
    return all(norm(p) in source for p in parts if norm(p))


pages = {
    str(p["page_id"]): p
    for p in yaml.safe_load(MOCK_CORPUS.read_text(encoding="utf-8"))["pages"]
}
page_words = {
    pid: words(p["body"])
    + " | "
    + words((p.get("next_version") or {}).get("body") or "")
    for pid, p in pages.items()
}
cases = [
    c
    for f in sorted(CASES.glob("*.yaml"))
    for c in (yaml.safe_load(f.read_text(encoding="utf-8")) or [])
    if c.get("method") == "assistant" and c.get("question")
]
problems: list[dict[str, Any]] = []
total = 0
with eval_client(KB) as client:
    container = client.app.state.container
    snapshot = client.portal.call(container.knowledge.snapshot, container.demo_user())
    for case in cases:
        allowed = {"approved"}
        if case.get("include_drafts"):
            allowed |= {"draft", "in_review"}
        if case.get("include_deprecated"):
            allowed.add("deprecated")
        body = {
            "question": case["question"],
            "include_drafts": bool(case.get("include_drafts")),
            "include_deprecated": bool(case.get("include_deprecated")),
            "sources": case.get("sources", ["team"]),
        }
        if case.get("history"):
            body["history"] = [
                {"question": str(q), "answer": ""} for q in case["history"]
            ]
        answer = client.post("/api/assistant/ask", json=body).json()
        for c in answer.get("citations", []):
            total += 1
            issue = None
            if c.get("source_kind") == "confluence_mcp":
                pid = str(c["document_id"])
                if pid not in pages:
                    issue = "unknown page"
                elif not same_words(c["excerpt"], page_words[pid]):
                    issue = "excerpt words not in the page"
            else:
                doc = snapshot.get(c["document_id"])
                if doc is None:
                    issue = "document not in the reader's snapshot"
                elif doc.status.value not in allowed:
                    issue = f"status {doc.status.value} not allowed for this request"
                elif c.get("revision") and c["revision"] != doc.revision:
                    issue = "revision differs from the snapshot"
                else:
                    # the unit the model was given: the cited section's text (list markers are not part of it)
                    cited = [
                        x
                        for x in doc.sections
                        if (x.anchor or "") == (c.get("section_anchor") or "")
                    ]
                    text = (
                        cited[0].text
                        if cited
                        else " ".join(x.text for x in doc.sections)
                    )
                    if not verbatim(c["excerpt"], norm(text)):
                        issue = "excerpt not verbatim in the cited section"
            if issue:
                problems.append(
                    {
                        "case_id": case["case_id"],
                        "document_id": c["document_id"],
                        "issue": issue,
                    }
                )
print(
    json.dumps(
        {
            "label": LABEL,
            "cases": len(cases),
            "citations": total,
            "invalid": len(problems),
            "problems": problems,
        },
        ensure_ascii=False,
        indent=1,
    )
)
