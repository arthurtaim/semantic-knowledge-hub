"""SearchProvider contract: lexical search over a rebuildable, derived index."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.models import HighlightSegment, IntegrationStatus
from app.domain.text import QueryTerm


@dataclass(frozen=True)
class SearchFilters:
    statuses: frozenset[str] | None = None
    types: frozenset[str] | None = None
    owners: frozenset[str] | None = None
    sources: frozenset[str] | None = None
    tags: frozenset[str] | None = None


@dataclass(frozen=True)
class DocumentHit:
    document_id: str
    score: float
    excerpt: str
    segments: list[HighlightSegment] = field(default_factory=list)
    section: str | None = None
    section_anchor: str | None = None


@dataclass(frozen=True)
class ChunkHit:
    document_id: str
    section: str
    section_anchor: str
    text: str
    score: float


class SearchProvider(Protocol):
    def sync(self, snapshot: KnowledgeSnapshot) -> None:
        """Rebuild the index if the snapshot version differs from the indexed one."""
        ...

    def search_documents(
        self, terms: list[QueryTerm], filters: SearchFilters, limit: int, *, mode: str = "and"
    ) -> list[DocumentHit]: ...

    def search_chunks(self, terms: list[QueryTerm], filters: SearchFilters, limit: int) -> list[ChunkHit]: ...

    def matching_document_ids(self, term: QueryTerm, filters: SearchFilters) -> set[str]:
        """Documents (within filters) that contain the term — used to detect unknown topics."""
        ...

    def index_info(self) -> tuple[str | None, int, datetime | None]:
        """(indexed snapshot version, indexed documents, time of the last index update)."""
        ...

    def status(self) -> IntegrationStatus: ...
