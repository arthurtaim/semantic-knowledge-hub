"""Links of a document (M5.6.3): outgoing, backlinks, unresolved WikiLinks, `[[` autocomplete.

Everything is computed from the READER's snapshot (the repository is the access boundary: GitLab returns
only what the user may read). A target or a source the reader cannot see does not exist for them — no
title, no count, no excerpt. Backlinks are the reverse view of the declared/inline edges of the current
index generation (one snapshot), so they never outlive a sync.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.models import DocStatus, DocType, DocumentRecord, UserContext
from app.services.knowledge import KnowledgeService

LinkVia = Literal["inline", "related_ids", "typed"]
MAX_SUGGESTIONS = 20


class LinkedDocument(BaseModel):
    document_id: str
    title: str
    status: DocStatus
    type: DocType


class OutgoingLink(BaseModel):
    target: LinkedDocument
    relation: str  # references | depends_on | …
    via: list[LinkVia]  # inline WikiLink / related_ids / typed relation (a link may be declared twice)
    labels: list[str] = []  # WikiLink labels as written
    lines: list[int] = []  # body lines of WikiLinks


class Backlink(BaseModel):
    source: LinkedDocument
    relation: str
    via: list[LinkVia]
    lines: list[int] = []
    excerpts: list[str] = []  # the linking line(s) of the SOURCE body (inline links only)


class UnresolvedLink(BaseModel):
    raw_target: str  # as the author wrote it (visible in this document's own text)
    label: str
    line: int
    excerpt: str
    reason: Literal["missing", "title_link", "ambiguous_title", "self"]
    candidates: list[LinkedDocument] = []  # visible documents whose title/alias matches (repair chooser)


class DocumentLinks(BaseModel):
    document_id: str
    generation: str
    outgoing: list[OutgoingLink]
    backlinks: list[Backlink]
    unresolved: list[UnresolvedLink]


class LinkSuggestion(BaseModel):
    document_id: str
    title: str
    status: DocStatus
    type: DocType
    matched: Literal["id", "title", "alias"]
    alias: str | None = None
    insert: str  # what the editor inserts: `[[ID|Title]]`


def _norm(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().replace("ё", "е").split())


def _doc(doc: DocumentRecord) -> LinkedDocument:
    return LinkedDocument(document_id=doc.id, title=doc.title, status=doc.status, type=doc.type)


def _via(field_name: str) -> LinkVia:
    if field_name == "body":
        return "inline"
    return "related_ids" if field_name == "related_ids" else "typed"


@dataclass
class _Reverse:
    # target id (lower) -> source id (lower) -> relation -> collected provenance
    by_target: dict[str, dict[str, dict[str, list[tuple[str, int | None]]]]] = field(default_factory=dict)


class LinkService:
    def __init__(self, knowledge: KnowledgeService) -> None:
        self._knowledge = knowledge
        self._reverse_cache: tuple[str, _Reverse] | None = None

    def _reverse(self, snapshot: KnowledgeSnapshot) -> _Reverse:
        if self._reverse_cache and self._reverse_cache[0] == snapshot.version:
            return self._reverse_cache[1]
        rev = _Reverse()
        for doc in snapshot.documents.values():
            for rel in doc.relations:
                slot = rev.by_target.setdefault(rel.target.lower(), {}).setdefault(doc.id.lower(), {})
                slot.setdefault(rel.type.value, []).append((rel.field, rel.line))
        self._reverse_cache = (snapshot.version, rev)
        return rev

    @staticmethod
    def title_candidates(snapshot: KnowledgeSnapshot, text: str) -> list[DocumentRecord]:
        wanted = _norm(text)
        return sorted(
            (
                d
                for d in snapshot.documents.values()
                if _norm(d.title) == wanted or any(_norm(a) == wanted for a in d.aliases)
            ),
            key=lambda d: d.id,
        )

    async def links(self, user: UserContext, document_id: str) -> DocumentLinks | None:
        snapshot = await self._knowledge.snapshot(user)
        doc = snapshot.get(document_id)
        if doc is None:
            return None
        outgoing: dict[tuple[str, str], OutgoingLink] = {}
        for rel in doc.relations:
            target = snapshot.get(rel.target)
            if target is None:
                continue  # reported below (inline) or by graph diagnostics (frontmatter)
            key = (rel.type.value, target.id)
            link = outgoing.get(key) or OutgoingLink(target=_doc(target), relation=rel.type.value, via=[])
            via = _via(rel.field)
            if via not in link.via:
                link.via.append(via)
            if rel.line:
                link.lines.append(rel.line)
            outgoing[key] = link
        for wl in doc.wikilinks:  # labels as written, for the sidebar
            target = snapshot.get(wl.target) if wl.id_like else None
            if target is not None and wl.label:
                key = ("references", target.id)
                if key in outgoing and wl.label not in outgoing[key].labels:
                    outgoing[key].labels.append(wl.label)
        backlinks: list[Backlink] = []
        for source_key, by_type in self._reverse(snapshot).by_target.get(doc.id.lower(), {}).items():
            source = snapshot.documents.get(source_key)
            if source is None or source.id == doc.id:
                continue
            for relation, places in sorted(by_type.items()):
                lines = sorted({line for f, line in places if f == "body" and line})
                excerpts = [
                    w.excerpt
                    for w in source.wikilinks
                    if w.id_like and w.target.lower() == doc.id.lower() and w.line in lines
                ]
                backlinks.append(
                    Backlink(
                        source=_doc(source),
                        relation=relation,
                        via=list(dict.fromkeys(_via(f) for f, _ in places)),
                        lines=lines,
                        excerpts=list(dict.fromkeys(excerpts))[:3],
                    )
                )
        backlinks.sort(key=lambda b: (b.source.document_id, b.relation))
        unresolved: list[UnresolvedLink] = []
        for wl in doc.wikilinks:
            if wl.id_like and wl.target.lower() == doc.id.lower():
                reason: Literal["missing", "title_link", "ambiguous_title", "self"] = "self"
                candidates: list[DocumentRecord] = []
            elif wl.id_like:
                if snapshot.get(wl.target) is not None:
                    continue
                reason, candidates = "missing", self.title_candidates(snapshot, wl.label) if wl.label else []
            else:
                candidates = self.title_candidates(snapshot, wl.target)
                reason = "ambiguous_title" if len(candidates) > 1 else "title_link"
            unresolved.append(
                UnresolvedLink(
                    raw_target=wl.target,
                    label=wl.label,
                    line=wl.line,
                    excerpt=wl.excerpt,
                    reason=reason,
                    candidates=[_doc(c) for c in candidates[:10]],
                )
            )
        return DocumentLinks(
            document_id=doc.id,
            generation=self._knowledge.generation_label(snapshot),
            outgoing=sorted(
                outgoing.values(), key=lambda o: (o.relation != "references", o.target.document_id)
            ),
            backlinks=backlinks,
            unresolved=unresolved,
        )

    async def suggest(self, user: UserContext, query: str, limit: int = 10) -> list[LinkSuggestion]:
        """`[[` autocomplete over IDs, titles and aliases the reader can see. Ranked: exact ID, ID prefix,
        title prefix, title contains, alias. Never resolves a choice by itself."""
        snapshot = await self._knowledge.snapshot(user)
        q = _norm(query.strip().lstrip("[").rstrip("]"))
        scored: list[tuple[int, str, LinkSuggestion]] = []
        for doc in snapshot.documents.values():
            title, did = _norm(doc.title), doc.id.casefold()
            rank: int | None = None
            matched: Literal["id", "title", "alias"] = "title"
            alias: str | None = None
            if not q:
                rank = 5
            elif did == q:
                rank, matched = 0, "id"
            elif did.startswith(q):
                rank, matched = 1, "id"
            elif title.startswith(q):
                rank = 2
            elif q in title:
                rank = 3
            elif q in did:
                rank, matched = 3, "id"
            else:
                for a in doc.aliases:
                    if q in _norm(a):
                        rank, matched, alias = 4, "alias", a
                        break
            if rank is None:
                continue
            if doc.status == DocStatus.deprecated:
                rank += 10  # still linkable, but after current documents
            scored.append(
                (
                    rank,
                    doc.id,
                    LinkSuggestion(
                        document_id=doc.id,
                        title=doc.title,
                        status=doc.status,
                        type=doc.type,
                        matched=matched,
                        alias=alias,
                        insert=f"[[{doc.id}|{doc.title.replace('|', '/').replace(']', ')')}]]",
                    ),
                )
            )
        scored.sort(key=lambda s: (s[0], s[1]))
        return [s[2] for s in scored[: max(1, min(limit, MAX_SUGGESTIONS))]]

    async def diagnostics(self, user: UserContext) -> list[tuple[str, UnresolvedLink]]:
        """Unresolved WikiLinks across the visible base (source document id, problem)."""
        snapshot = await self._knowledge.snapshot(user)
        result: list[tuple[str, UnresolvedLink]] = []
        for doc in sorted(snapshot.documents.values(), key=lambda d: d.id):
            if not doc.wikilinks:
                continue
            links = await self.links(user, doc.id)
            if links:
                result += [(doc.id, u) for u in links.unresolved]
        return result
