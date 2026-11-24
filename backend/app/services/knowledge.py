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
from app.domain.doc_tree import (
    SystemIndex,
    build_layout,
    build_system_index,
    document_systems,
    needs_attention,
)
from app.domain.markdown import render_html, truncate
from app.domain.models import (
    DocStatus,
    DocumentDetail,
    DocumentFacets,
    DocumentPage,
    DocumentRecord,
    DocumentSummary,
    DocumentTree,
    DocumentTreeEntry,
    DocumentTreeGroup,
    DocumentTreeSection,
    FacetCount,
    LoadIssue,
    RelatedLink,
    ReviewState,
    SyncStatus,
    UserContext,
)
from app.domain.schema import UNASSIGNED_OWNERS, is_valid_document_id
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
        # The document's own date (front matter `updated_at`), the one the catalog shows — never the time the
        # file was written or indexed. Newest first; undated documents last, by title.
        dated = sorted(
            (d for d in docs if d.metadata_updated_at),
            key=lambda d: (d.metadata_updated_at, d.id),
            reverse=True,
        )
        undated = (d for d in docs if not d.metadata_updated_at)
        return dated + sorted(undated, key=lambda d: (d.title.lower(), d.id))
    if order == "status":
        return sorted(docs, key=lambda d: (_STATUS_RANK[d.status], d.title.lower(), d.id))
    return docs  # relevance / default: keep the incoming order


def linked_document_counts(snapshot: KnowledgeSnapshot) -> dict[str, int]:
    """Distinct linked documents per document of THIS snapshot (lower-cased id -> count), in one pass over its
    declared, `related_ids` and inline relations: the targets of a document's own relations plus the documents
    whose relations point at it. Same meaning as the document page's «Связи» (`GET /api/documents/{id}/links`:
    outgoing targets ∪ backlink sources). A target or a source outside the reader's snapshot does not count."""
    linked: dict[str, set[str]] = {key: set() for key in snapshot.documents}
    for key, doc in snapshot.documents.items():
        for rel in doc.relations:
            target = snapshot.get(rel.target)
            if target is None:
                continue
            target_key = target.id.lower()
            linked[key].add(target_key)
            if target_key != key:  # a backlink never comes from the document itself
                linked[target_key].add(key)
    return {key: len(ids) for key, ids in linked.items()}


def owner_missing(doc: DocumentRecord) -> bool:
    """The owner is a placeholder («unassigned», «tbd», «-», …): the document has nobody responsible."""
    return doc.owner.strip().lower() in UNASSIGNED_OWNERS


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
        self._link_counts: tuple[KnowledgeSnapshot, dict[str, int]] | None = None
        self._systems: tuple[KnowledgeSnapshot, SystemIndex] | None = None
        # «Today» for `review_state` (stale after `review_stale_days`); replaceable so tests can pin the date.
        self.today: Callable[[], date] = lambda: datetime.now(UTC).date()
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

    def link_counts(self, snapshot: KnowledgeSnapshot) -> dict[str, int]:
        """`linked_document_counts` of this reader's snapshot, computed once per snapshot object."""
        cached = self._link_counts
        if cached is not None and cached[0] is snapshot:
            return cached[1]
        counts = linked_document_counts(snapshot)
        self._link_counts = (snapshot, counts)
        return counts

    def system_index(self, snapshot: KnowledgeSnapshot) -> SystemIndex:
        """The source systems of this reader's snapshot (app/domain/doc_tree.py), built once per snapshot object."""
        cached = self._systems
        if cached is not None and cached[0] is snapshot:
            return cached[1]
        index = build_system_index(snapshot.documents.values())
        self._systems = (snapshot, index)
        return index

    def stale_ids(self, snapshot: KnowledgeSnapshot) -> frozenset[str]:
        """Documents that must not be presented as current: individual failed refreshes, or all of
        them while the source itself is unreachable and the last synchronised snapshot is served."""
        info = self._repository.sync_info()
        if info.state == "stale" and not info.failed_paths:
            return frozenset(snapshot.documents)
        return snapshot.stale_ids

    # --- presentation helpers ------------------------------------------------------------------
    def review_state(self, doc: DocumentRecord, today: date | None = None) -> ReviewState:
        today = today or self.today()
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
        link_count: int | None = None,
        systems: list[str] | None = None,
        with_summary: bool = False,
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
            metadata_updated_at=doc.metadata_updated_at,
            review_state=self.review_state(doc),
            owner_missing=owner_missing(doc),
            web_url=doc.web_url,
            index_state="stale" if stale else "current",
            highlights=hit.segments if hit and hit.segments else None,
            match_reasons=ranked.reasons if ranked else None,
            related_via=ranked.via if ranked else None,
            version=doc.version,
            link_count=link_count,
            summary=doc.summary if with_summary else None,
            systems=systems,
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
        links = self.link_counts(snapshot)
        systems = self.system_index(snapshot)
        items = [
            self.summarize(
                d,
                ranked[d.id].hit if d.id in ranked else None,
                stale=d.id.lower() in stale,
                ranked=ranked.get(d.id),
                link_count=links.get(d.id.lower(), 0),
                systems=document_systems(d, systems),
                with_summary=True,
            )
            for d in page
        ]
        return DocumentPage(items=items, total=len(ordered), page=q.page, size=q.size, notes=notes)

    @staticmethod
    def wikilink_resolver(snapshot: KnowledgeSnapshot) -> Callable[[str], tuple[str, str] | None]:
        """WikiLink target -> (ID, title) among documents of THIS reader's snapshot; anything else stays text."""

        def resolve(target: str) -> tuple[str, str] | None:
            doc = snapshot.get(target) if is_valid_document_id(target) else None
            return (doc.id, doc.title) if doc is not None else None

        return resolve

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
        summary = self.summarize(
            doc,
            stale=doc.id.lower() in self.stale_ids(snapshot),
            systems=document_systems(doc, self.system_index(snapshot)),
        )
        return DocumentDetail(
            **summary.model_dump(exclude={"summary"}),
            summary=doc.summary,
            related=related,
            source_refs=list(doc.source_refs),
            content_markdown=doc.body,
            content_html=render_html(doc.body, self.wikilink_resolver(snapshot)),
            template_id=doc.template_id,
            template_version=doc.template_version,
            wikilink_count=len(doc.wikilinks),
            raw=doc.raw,
            path=doc.path,
            sections=list(doc.sections),
            warnings=list(doc.warnings),
            extra_metadata=dict(doc.extra_metadata),
        )

    async def document_tree(self, user: UserContext) -> DocumentTree:
        """Sections → groups → documents of the reader's snapshot (the same visibility as `list_documents`), with
        attention counts. The group rule and the ordering live in app/domain/doc_tree.py."""
        snapshot = await self.snapshot(user)
        today = self.today()
        docs = list(snapshot.documents.values())
        states = {doc.id: self.review_state(doc, today) for doc in docs}
        flagged = {doc.id: needs_attention(doc.status, states[doc.id], owner_missing(doc)) for doc in docs}
        layout = build_layout(docs, lambda doc: flagged[doc.id])
        links = self.link_counts(snapshot)
        stale = self.stale_ids(snapshot)
        documents = {
            doc.id: DocumentTreeEntry(
                title=doc.title,
                type=doc.type,
                status=doc.status,
                review_state=states[doc.id],
                reviewed_at=doc.reviewed_at,
                owner=doc.owner,
                owner_missing=owner_missing(doc),
                summary=doc.summary,
                systems=layout.systems[doc.id],
                link_count=links.get(doc.id.lower(), 0),
                is_demo=doc.is_demo,
                source=doc.source,
                index_state="stale" if doc.id.lower() in stale else "current",
                group=layout.group_of[doc.id],
                attention=flagged[doc.id],
            )
            for doc in docs
        }
        sections = [
            DocumentTreeSection(
                key=section.key,
                label=section.label,
                count=section.count,
                attention=section.attention,
                groups=[
                    DocumentTreeGroup(
                        key=group.key,
                        label=group.label,
                        count=len(group.doc_ids),
                        attention=group.attention,
                        doc_ids=list(group.doc_ids),
                    )
                    for group in section.groups
                ],
                doc_ids=list(section.doc_ids),
            )
            for section in layout.sections
        ]
        return DocumentTree(
            total=layout.total, attention_total=layout.attention_total, sections=sections, documents=documents
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
