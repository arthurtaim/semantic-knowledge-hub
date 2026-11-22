"""Knowledge browsing: listing, filters, facets and document detail with provenance."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from app.adapters.knowledge.base import KnowledgeRepository, KnowledgeSnapshot
from app.adapters.search.base import DocumentHit, SearchFilters, SearchProvider
from app.domain.markdown import render_html, truncate
from app.domain.models import (
    DocStatus,
    DocumentDetail,
    DocumentFacets,
    DocumentPage,
    DocumentRecord,
    DocumentSummary,
    FacetCount,
    LoadIssue,
    RelatedLink,
    ReviewState,
    UserContext,
)
from app.domain.schema import UNASSIGNED_OWNERS
from app.domain.text import analyze_query

MAX_LIST_MATCHES = 1000


@dataclass(frozen=True)
class DocumentQuery:
    query: str = ""
    filters: SearchFilters = field(default_factory=SearchFilters)
    page: int = 1
    size: int = 20


class KnowledgeService:
    def __init__(
        self, repository: KnowledgeRepository, search: SearchProvider, *, review_stale_days: int
    ) -> None:
        self._repository = repository
        self._search = search
        self._stale_days = review_stale_days

    @property
    def repository(self) -> KnowledgeRepository:
        return self._repository

    @property
    def search_provider(self) -> SearchProvider:
        return self._search

    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        snapshot = await self._repository.snapshot(user)
        self._search.sync(snapshot)
        return snapshot

    # --- presentation helpers ------------------------------------------------------------------
    def review_state(self, doc: DocumentRecord, today: date | None = None) -> ReviewState:
        today = today or datetime.now(UTC).date()
        if doc.reviewed_at is None:
            return (
                "never_reviewed"
                if doc.status in (DocStatus.approved, DocStatus.in_review)
                else "not_required"
            )
        if today - doc.reviewed_at > timedelta(days=self._stale_days):
            return "stale"
        return "ok"

    def summarize(self, doc: DocumentRecord, hit: DocumentHit | None = None) -> DocumentSummary:
        excerpt = hit.excerpt if hit and hit.excerpt else (doc.summary or "")
        return DocumentSummary(
            id=doc.id,
            title=doc.title,
            type=doc.type,
            status=doc.status,
            owner=doc.owner,
            source=doc.source,
            source_uri=doc.source_uri,
            revision=doc.revision,
            tags=list(doc.tags),
            excerpt=truncate(excerpt, 320),
            is_demo=doc.is_demo,
            reviewed_at=doc.reviewed_at,
            updated_at=doc.updated_at,
            review_state=self.review_state(doc),
            owner_missing=doc.owner.strip().lower() in UNASSIGNED_OWNERS,
            highlights=hit.segments if hit and hit.segments else None,
        )

    @staticmethod
    def _matches(doc: DocumentRecord, filters: SearchFilters) -> bool:
        checks = (
            (filters.statuses, doc.status.value),
            (filters.types, doc.type.value),
            (filters.owners, doc.owner),
            (filters.sources, doc.source),
        )
        if any(values is not None and value not in values for values, value in checks):
            return False
        return not filters.tags or filters.tags.issubset(set(doc.tags))

    # --- queries ---------------------------------------------------------------------------------
    async def list_documents(self, user: UserContext, q: DocumentQuery) -> DocumentPage:
        snapshot = await self.snapshot(user)
        hits: dict[str, DocumentHit] = {}
        if q.query.strip():
            terms = analyze_query(q.query)
            ordered: list[DocumentRecord] = []
            for hit in self._search.search_documents(terms, q.filters, MAX_LIST_MATCHES):
                doc = snapshot.get(hit.document_id)
                if doc is not None:
                    hits[doc.id] = hit
                    ordered.append(doc)
        else:
            ordered = [d for d in snapshot.ordered() if self._matches(d, q.filters)]
        start = (q.page - 1) * q.size
        items = [self.summarize(d, hits.get(d.id)) for d in ordered[start : start + q.size]]
        return DocumentPage(items=items, total=len(ordered), page=q.page, size=q.size)

    async def get_detail(self, user: UserContext, document_id: str) -> DocumentDetail:
        doc = await self._repository.get_document(document_id, user)
        snapshot = await self.snapshot(user)
        related = []
        for rid in doc.related_ids:
            target = snapshot.get(rid)
            related.append(
                RelatedLink(
                    id=target.id if target else rid,
                    title=target.title if target else None,
                    status=target.status if target else None,
                    resolved=target is not None,
                )
            )
        summary = self.summarize(doc)
        return DocumentDetail(
            **summary.model_dump(),
            summary=doc.summary,
            related=related,
            source_refs=list(doc.source_refs),
            content_markdown=doc.body,
            content_html=render_html(doc.body),
            raw=doc.raw,
            path=doc.path,
            sections=list(doc.sections),
            warnings=list(doc.warnings),
            extra_metadata=dict(doc.extra_metadata),
        )

    async def facets(self, user: UserContext) -> DocumentFacets:
        snapshot = await self.snapshot(user)
        docs = list(snapshot.documents.values())

        def counted(values: list[str]) -> list[FacetCount]:
            return [
                FacetCount(value=v, count=c)
                for v, c in sorted(Counter(values).items(), key=lambda i: (-i[1], i[0]))
            ]

        return DocumentFacets(
            types=counted([d.type.value for d in docs]),
            statuses=counted([d.status.value for d in docs]),
            owners=counted([d.owner for d in docs]),
            sources=counted([d.source for d in docs]),
            tags=counted([t for d in docs for t in d.tags]),
            total=len(docs),
        )

    async def issues(self, user: UserContext) -> list[LoadIssue]:
        snapshot = await self.snapshot(user)
        return list(snapshot.issues)
