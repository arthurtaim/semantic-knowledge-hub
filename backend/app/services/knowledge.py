"""Knowledge browsing: listing, filters, facets and document detail with provenance."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from app.adapters.knowledge.base import (
    KnowledgeRepository,
    KnowledgeSnapshot,
    RepositoryUnavailableError,
)
from app.adapters.search.base import DocumentHit, SearchFilters, SearchProvider
from app.domain.dictionary import SearchDictionary, load_dictionary
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
    SyncStatus,
    UserContext,
)
from app.domain.schema import UNASSIGNED_OWNERS
from app.services.retrieval import RankedHit, RetrievalService

MAX_LIST_MATCHES = 1000


SortOrder = Literal["relevance", "title", "updated", "status"]
_STATUS_RANK = {DocStatus.approved: 0, DocStatus.in_review: 1, DocStatus.draft: 2, DocStatus.deprecated: 3}


@dataclass(frozen=True)
class DocumentQuery:
    query: str = ""
    filters: SearchFilters = field(default_factory=SearchFilters)
    page: int = 1
    size: int = 20
    sort: SortOrder | None = None  # None: relevance with a query, section/title order without


def sort_documents(docs: list[DocumentRecord], order: SortOrder | None) -> list[DocumentRecord]:
    if order == "title":
        return sorted(docs, key=lambda d: (d.title.lower(), d.id))
    if order == "updated":
        dated = sorted((d for d in docs if d.updated_at), key=lambda d: (d.updated_at, d.id), reverse=True)
        return dated + sorted((d for d in docs if not d.updated_at), key=lambda d: (d.title.lower(), d.id))
    if order == "status":
        return sorted(docs, key=lambda d: (_STATUS_RANK[d.status], d.title.lower(), d.id))
    return docs  # relevance / default: keep the incoming order


class KnowledgeService:
    def __init__(
        self,
        repository: KnowledgeRepository,
        search: SearchProvider,
        *,
        review_stale_days: int,
        dictionary: SearchDictionary | None = None,
    ) -> None:
        self._repository = repository
        self._search = search
        self._stale_days = review_stale_days
        self.retrieval = RetrievalService(search, dictionary or load_dictionary())
        self._listeners: list[Callable[[], object]] = []
        self._explicit_sync: Any = None  # result of the last explicit sync (reported even when a no-op)
        self.template_registry_label: Callable[[], str] = lambda: "-"

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

    def generation_label(self, snapshot: KnowledgeSnapshot) -> str:
        """Identifier of the knowledge generation the projections (index, graph) were built from."""
        return f"g{self._search.generation}"

    @property
    def generation(self) -> int:
        return self._search.generation

    def stale_ids(self, snapshot: KnowledgeSnapshot) -> frozenset[str]:
        """Documents that must not be presented as current: individual failed refreshes, or all of
        them while the source itself is unreachable and the last synchronised snapshot is served."""
        info = self._repository.sync_info()
        if info.state == "stale" and not info.failed_paths:
            return frozenset(snapshot.documents)
        return snapshot.stale_ids

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

    def summarize(
        self,
        doc: DocumentRecord,
        hit: DocumentHit | None = None,
        *,
        stale: bool = False,
        ranked: RankedHit | None = None,
    ) -> DocumentSummary:
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
            web_url=doc.web_url,
            index_state="stale" if stale else "current",
            highlights=hit.segments if hit and hit.segments else None,
            match_reasons=ranked.reasons if ranked else None,
            related_via=ranked.via if ranked else None,
            version=doc.version,
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
        ranked: dict[str, RankedHit] = {}
        notes: list[str] = []
        analysis = None
        if q.query.strip():
            analysis = self.retrieval.analyze(q.query)
            notes = analysis.notes
            ordered: list[DocumentRecord] = []
            for hit in self.retrieval.rank_documents(snapshot, analysis, q.filters, MAX_LIST_MATCHES):
                doc = snapshot.get(hit.document_id)
                if doc is not None:
                    ranked[doc.id] = hit
                    ordered.append(doc)
        else:
            ordered = [d for d in snapshot.ordered() if self._matches(d, q.filters)]
        ordered = sort_documents(ordered, q.sort)
        start = (q.page - 1) * q.size
        stale = self.stale_ids(snapshot)
        page = ordered[start : start + q.size]
        if analysis is not None:
            self.retrieval.with_snippets(analysis, [ranked[d.id] for d in page if d.id in ranked])
        items = [
            self.summarize(
                d,
                ranked[d.id].hit if d.id in ranked else None,
                stale=d.id.lower() in stale,
                ranked=ranked.get(d.id),
            )
            for d in page
        ]
        return DocumentPage(items=items, total=len(ordered), page=q.page, size=q.size, notes=notes)

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
        summary = self.summarize(doc, stale=doc.id.lower() in self.stale_ids(snapshot))
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

    async def refresh(self, *, full: bool = False, rebuild_index: bool = False) -> KnowledgeSnapshot:
        """Manual re-synchronisation of the source and the search index. `rebuild_index` drops and rebuilds
        the derived index (repair); the result must equal an incremental sync of the same snapshot."""
        snapshot = await self._repository.refresh(full=full)
        self._explicit_sync = self._search.sync(snapshot, full=rebuild_index)
        for listener in self._listeners:
            listener()
        return snapshot

    def _last_sync(self) -> dict[str, Any] | None:
        """The most recent of: the last explicit sync (even a no-op) and the last applied one."""
        candidates = [r for r in (self._explicit_sync, getattr(self._search, "last_result", None)) if r]
        if not candidates:
            return None
        latest = max(candidates, key=lambda r: r.seq)
        result: dict[str, Any] = latest.as_dict()
        return result

    def on_refresh(self, listener: Callable[[], object]) -> None:
        """Called after every manual sync (e.g. reload the template registry)."""
        self._listeners.append(listener)

    async def sync_status(self, user: UserContext) -> SyncStatus:
        documents = issues = 0
        version: str | None = None
        try:
            snapshot = await self.snapshot(user)
            documents, issues, version = len(snapshot.documents), len(snapshot.issues), snapshot.version
        except RepositoryUnavailableError:
            pass  # reported through sync_info(): state "error"
        info = self._repository.sync_info()
        indexed_version, indexed_documents, indexed_at = self._search.index_info()
        return SyncStatus(
            source=self._repository.source,
            state=info.state,
            message=info.message,
            documents=documents,
            issues=issues,
            failed_paths=list(info.failed_paths[:50]),
            last_attempt_at=info.last_attempt_at,
            last_success_at=info.last_success_at,
            source_version=version,
            branch=info.branch,
            head_commit=info.head_commit,
            indexed_documents=indexed_documents,
            indexed_version=indexed_version,
            indexed_at=indexed_at,
            generation=self._search.generation,
            last_sync=self._last_sync(),
            search_dictionary=self.retrieval.dictionary.label,
            template_registry=self.template_registry_label(),
        )
