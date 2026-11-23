"""Validate a synthetic knowledge base directory (make mock-kb-validate).

Checks: frontmatter validity, duplicate ids/paths, unresolved references, typed relation counts,
required multi-hop chains, `synthetic` marking, secrets/personal data, orphans. Prints a short human
report and (optionally) writes the full result as JSON. Exit code 1 when an error-level problem exists.

    python -m app.tools.kb_validate ../fixtures/knowledge [--json out.json] [--strict-synthetic]
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from app.adapters.knowledge.local import LocalKnowledgeRepository
from app.domain.models import DocumentRecord, RelationType
from app.domain.safety import find_personal_identifiers, find_secrets

# Multi-hop chains the synthetic base must keep (docs/MOCK_KNOWLEDGE_BASE.md §4). Consecutive ids must be
# connected by a declared edge in either direction.
REQUIRED_CHAINS: tuple[tuple[str, ...], ...] = (
    ("DEMO-SRC-002", "DEMO-INT-001", "DEMO-INT-002", "DEMO-SEM-002", "DEMO-SEM-009", "DEMO-INT-015"),
    ("DEMO-SRC-003", "DEMO-INT-004", "DEMO-INT-005", "DEMO-SEM-010"),
    ("DEMO-SRC-005", "DEMO-INT-007", "DEMO-SEM-006", "DEMO-SEM-011"),
    ("DEMO-GOV-003", "DEMO-INT-003", "DEMO-SEM-009"),
    ("DEMO-GOV-009", "DEMO-GOV-001", "DEMO-GOV-011"),
    ("DEMO-PROC-002", "DEMO-PROC-007", "DEMO-SEM-004", "DEMO-SEM-009"),
)
MIN_EDGES = 100


def validate(root: Path, *, strict_synthetic: bool = False) -> dict[str, Any]:
    repo = LocalKnowledgeRepository(root, max_document_bytes=512 * 1024, content_is_demo=False)
    snapshot = repo._refresh_sync(True)
    docs: list[DocumentRecord] = snapshot.ordered()
    ids = {d.id.lower(): d for d in docs}

    edges: list[dict[str, str]] = []
    unresolved: list[dict[str, str]] = []
    for doc in docs:
        for rel in doc.relations:
            edge = {
                "from": doc.id,
                "to": rel.target,
                "type": rel.type.value,
                "field": rel.field,
                "path": doc.path,
            }
            if rel.target.lower() in ids:
                edges.append(edge)
            else:
                unresolved.append(edge)

    connected: set[frozenset[str]] = {frozenset((e["from"].lower(), e["to"].lower())) for e in edges}
    chains = []
    for chain in REQUIRED_CHAINS:
        missing_links = [
            f"{a} — {b}"
            for a, b in itertools.pairwise(chain)
            if frozenset((a.lower(), b.lower())) not in connected
        ]
        chains.append({"chain": list(chain), "ok": not missing_links, "missing_links": missing_links})

    linked = {e["from"].lower() for e in edges} | {e["to"].lower() for e in edges}
    orphans = sorted(d.id for d in docs if d.id.lower() not in linked)
    not_synthetic = sorted(d.id for d in docs if not d.synthetic and d.id.upper().startswith("DEMO-"))
    secrets = sorted(d.id for d in docs if find_secrets(d.raw))
    personal = sorted(d.id for d in docs if find_personal_identifiers(d.raw))
    paths = Counter(d.path.lower() for d in docs)
    warnings_by_doc = {d.id: [w.code for w in d.warnings] for d in docs if d.warnings}

    errors: list[str] = []
    if snapshot.duplicates:
        errors.append(f"duplicate ids: {sorted(snapshot.duplicates)}")
    invalid = [i.model_dump() for i in snapshot.issues if i.code != "duplicate_id"]
    if invalid:
        errors.append(f"{len(invalid)} file(s) failed validation")
    if unresolved:
        errors.append(f"{len(unresolved)} unresolved reference(s)")
    if [p for p, n in paths.items() if n > 1]:
        errors.append("duplicate paths")
    if secrets or personal:
        errors.append("secrets or personal data detected")
    if any(not c["ok"] for c in chains):
        errors.append("required chains are broken")
    if len(edges) < MIN_EDGES:
        errors.append(f"only {len(edges)} resolvable edges (need ≥ {MIN_EDGES})")
    if strict_synthetic and not_synthetic:
        errors.append("DEMO-* documents without `synthetic: true`")

    return {
        "root": str(root),
        "documents": len(docs),
        "by_type": dict(sorted(Counter(d.type.value for d in docs).items())),
        "by_status": dict(sorted(Counter(d.status.value for d in docs).items())),
        "by_owner": dict(sorted(Counter(d.owner for d in docs).items())),
        "edges": len(edges),
        "edges_by_type": dict(sorted(Counter(e["type"] for e in edges).items())),
        "typed_edges": sum(1 for e in edges if e["type"] != RelationType.references.value),
        "unresolved_references": unresolved,
        "required_chains": chains,
        "orphans": orphans,
        "not_synthetic": not_synthetic,
        "secrets": secrets,
        "personal_data": personal,
        "invalid_files": invalid,
        "duplicate_ids": snapshot.duplicates,
        "warnings": warnings_by_doc,
        "errors": errors,
        "ok": not errors,
    }


def human(report: dict[str, Any]) -> str:
    lines = [
        f"documents: {report['documents']}  edges: {report['edges']} (typed {report['typed_edges']})",
        f"by type: {report['by_type']}",
        f"by status: {report['by_status']}",
        f"edges by type: {report['edges_by_type']}",
    ]
    for chain in report["required_chains"]:
        mark = "ok " if chain["ok"] else "BROKEN"
        lines.append(f"chain {mark} {' → '.join(chain['chain'])} {chain['missing_links'] or ''}")
    for key in (
        "unresolved_references",
        "invalid_files",
        "orphans",
        "not_synthetic",
        "secrets",
        "personal_data",
    ):
        if report[key]:
            lines.append(f"{key}: {json.dumps(report[key], ensure_ascii=False)[:2000]}")
    if report["warnings"]:
        lines.append(f"documents with warnings: {len(report['warnings'])}")
    lines.append("RESULT: OK" if report["ok"] else f"RESULT: FAILED — {'; '.join(report['errors'])}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", type=Path)
    parser.add_argument("--json", type=Path, default=None, help="write the full report as JSON")
    parser.add_argument("--strict-synthetic", action="store_true", help="DEMO-* documents must be synthetic")
    args = parser.parse_args(argv)
    report = validate(args.root.resolve(), strict_synthetic=args.strict_synthetic)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(human(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
