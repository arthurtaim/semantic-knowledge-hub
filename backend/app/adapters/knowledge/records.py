"""Shared document-building logic for every KnowledgeRepository adapter (local, GitLab, …).

Keeping parsing, validation and duplicate handling in one place guarantees that all adapters
return consistent metadata and provenance (docs/ARCHITECTURE.md §8).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.markdown import first_meaningful_paragraph
from app.domain.models import (
    DeclaredRelation,
    DocStatus,
    DocType,
    DocumentRecord,
    LoadIssue,
    RelationType,
    SourceType,
    WikiLinkRef,
)
from app.domain.schema import parse_document


def build_record(
    data: bytes,
    *,
    path: str,
    source: SourceType,
    source_uri_for: str,
    revision: str,
    updated_at: datetime | None,
    is_demo: bool,
    issues: list[LoadIssue],
) -> DocumentRecord | None:
    """Decode, parse and validate one document. Problems are appended to `issues`.

    `source_uri_for` is a template where `{id}` is replaced with the document ID.
    """
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        issues.append(LoadIssue(path=path, code="invalid_encoding", message="Файл не в кодировке UTF-8."))
        return None
    parsed = parse_document(text)
    if not parsed.is_valid or parsed.markdown is None:
        for error in parsed.errors:
            issues.append(
                LoadIssue(path=path, code=error.code, message=error.message, document_id=parsed.document_id)
            )
        return None
    meta = parsed.metadata
    doc_id: str = meta["id"]
    tags: list[str] = meta.get("tags", [])
    relations = [
        DeclaredRelation(type=RelationType(rel_type), target=target, field=f"relations.{rel_type}")
        for rel_type, target in meta.get("relations", [])
    ]
    typed_targets = {r.target.lower() for r in relations}
    relations += [
        DeclaredRelation(type=RelationType.references, target=target, field="related_ids")
        for target in meta.get("related_ids", [])
        if target.lower() not in typed_targets  # a typed edge already states the link more precisely
    ]
    wikilinks = tuple(
        WikiLinkRef(
            target=w.target, anchor=w.anchor, label=w.label, line=w.line, excerpt=w.excerpt, id_like=w.id_like
        )
        for w in parsed.markdown.wikilinks
    )
    # An inline WikiLink to an ID is a `references` edge (never a typed business dependency). Several
    # links to one target from the same body are one edge; the graph merges it with `related_ids`.
    seen_inline: set[str] = set()
    for link in wikilinks:
        if link.id_like and link.target.lower() != doc_id.lower() and link.target.lower() not in seen_inline:
            seen_inline.add(link.target.lower())
            relations.append(
                DeclaredRelation(
                    type=RelationType.references, target=link.target, field="body", line=link.line
                )
            )
    return DocumentRecord(
        id=doc_id,
        title=meta["title"],
        type=DocType(meta["type"]),
        status=DocStatus(meta["status"]),
        owner=meta["owner"],
        tags=tuple(tags),
        related_ids=tuple(meta.get("related_ids", [])),
        relations=tuple(relations),
        wikilinks=wikilinks,
        aliases=tuple(meta.get("aliases", [])),
        version=meta.get("version"),
        synthetic=bool(meta.get("synthetic", False)),
        template_id=meta.get("template"),
        template_version=meta.get("template_version"),
        source_refs=tuple(meta.get("source_refs", [])),
        reviewed_at=meta.get("reviewed_at"),
        summary=meta.get("summary") or first_meaningful_paragraph(parsed.markdown.paragraphs) or None,
        body=parsed.body,
        raw=text,
        sections=tuple(parsed.markdown.sections),
        source=source,
        source_uri=source_uri_for.replace("{id}", doc_id),
        revision=revision,
        path=path,
        updated_at=updated_at,
        is_demo=is_demo or "demo" in tags or bool(meta.get("synthetic", False)),
        extra_metadata=parsed.extra_metadata,
        warnings=tuple(parsed.warnings),
    )


def assemble_snapshot(
    records: Iterable[DocumentRecord], version: str, issues: list[LoadIssue]
) -> KnowledgeSnapshot:
    """Index records by case-insensitive ID; duplicated IDs are quarantined, never guessed."""
    by_id: dict[str, list[DocumentRecord]] = {}
    for record in records:
        by_id.setdefault(record.id.lower(), []).append(record)
    documents: dict[str, DocumentRecord] = {}
    duplicates: dict[str, list[str]] = {}
    for key, group in by_id.items():
        if len(group) == 1:
            documents[key] = group[0]
            continue
        paths = sorted(r.path for r in group)
        duplicates[key] = paths
        for record in group:
            issues.append(
                LoadIssue(
                    path=record.path,
                    code="duplicate_id",
                    message=f"Идентификатор {record.id} используется в нескольких файлах: {', '.join(paths)}.",
                    document_id=record.id,
                )
            )
    return KnowledgeSnapshot(version=version, documents=documents, issues=issues, duplicates=duplicates)
