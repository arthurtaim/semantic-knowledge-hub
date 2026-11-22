"""Provider-independent domain and API models."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DocType(StrEnum):
    overview = "overview"
    architecture = "architecture"
    domain = "domain"
    integration = "integration"
    process = "process"
    decision = "decision"
    standard = "standard"
    glossary = "glossary"


class DocStatus(StrEnum):
    draft = "draft"
    in_review = "in_review"
    approved = "approved"
    deprecated = "deprecated"


SourceType = Literal["local", "gitlab", "confluence"]
SyncState = Literal["fresh", "stale", "error", "never_synced"]
IndexState = Literal["current", "stale"]
IntegrationState = Literal["connected", "disabled", "mock", "error"]
Confidence = Literal["supported", "partial", "insufficient_evidence"]
SearchScope = Literal["team", "corporate"]
ReviewState = Literal["ok", "stale", "never_reviewed", "not_required"]


class UserContext(BaseModel):
    """Identity of the requester. In MVP this is the localhost demo identity only."""

    user_id: str
    display_name: str
    roles: list[str] = Field(default_factory=list)
    allowed_spaces: list[str] | None = None  # None = connector decides; [] = nothing
    is_demo: bool = True


class Section(BaseModel):
    heading: str
    anchor: str
    level: int
    text: str


class ValidationIssue(BaseModel):
    severity: Literal["error", "warning"]
    code: str
    message: str
    field: str | None = None


class DocumentRecord(BaseModel):
    """A parsed knowledge document as returned by a KnowledgeRepository adapter."""

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    type: DocType
    status: DocStatus
    owner: str
    tags: tuple[str, ...]
    related_ids: tuple[str, ...] = ()
    source_refs: tuple[str, ...] = ()
    reviewed_at: date | None = None
    summary: str | None = None
    body: str
    raw: str
    sections: tuple[Section, ...] = ()
    source: SourceType
    source_uri: str
    revision: str
    path: str  # repository-relative path, never absolute
    updated_at: datetime | None = (
        None  # time of the source revision (commit date / file mtime); never guessed
    )
    web_url: str | None = None  # link to this revision in the source system (validated host), if any
    is_demo: bool = False
    extra_metadata: dict[str, str] = Field(default_factory=dict)
    warnings: tuple[ValidationIssue, ...] = ()


class LoadIssue(BaseModel):
    path: str
    code: str
    message: str
    document_id: str | None = None


class HighlightSegment(BaseModel):
    text: str
    highlight: bool = False


class DocumentSummary(BaseModel):
    id: str
    title: str
    type: DocType
    status: DocStatus
    owner: str
    source: SourceType
    source_uri: str
    revision: str
    tags: list[str]
    excerpt: str
    is_demo: bool
    reviewed_at: date | None
    updated_at: datetime | None
    review_state: ReviewState
    owner_missing: bool
    web_url: str | None = None
    # "stale": the last sync could not refresh this document; it is shown with its last known revision.
    index_state: IndexState = "current"
    highlights: list[HighlightSegment] | None = None  # present when listed via a text query


class RelatedLink(BaseModel):
    id: str
    title: str | None
    status: DocStatus | None
    resolved: bool


class DocumentDetail(DocumentSummary):
    summary: str | None
    related: list[RelatedLink]
    source_refs: list[str]
    content_markdown: str
    content_html: str
    raw: str
    path: str
    sections: list[Section]
    warnings: list[ValidationIssue]
    extra_metadata: dict[str, str]


class DocumentPage(BaseModel):
    items: list[DocumentSummary]
    total: int
    page: int
    size: int


class FacetCount(BaseModel):
    value: str
    count: int


class DocumentFacets(BaseModel):
    types: list[FacetCount]
    statuses: list[FacetCount]
    owners: list[FacetCount]
    sources: list[FacetCount]
    tags: list[FacetCount]
    total: int


class SearchResult(BaseModel):
    id: str
    title: str
    type: DocType | None
    status: DocStatus | None
    owner: str | None
    source: SourceType
    source_uri: str
    revision: str
    tags: list[str]
    excerpt: str
    excerpt_segments: list[HighlightSegment]
    section: str | None = None
    section_anchor: str | None = None
    score: float
    is_demo: bool


class ScopeStatus(BaseModel):
    scope: SearchScope
    state: IntegrationState
    message: str


class SearchResponse(BaseModel):
    query: str
    items: list[SearchResult]
    total: int
    scopes: list[ScopeStatus]
    warnings: list[str]


class Citation(BaseModel):
    """Provenance of a cited excerpt. `ref` is the stable number shown in the answer ([1], [2]…)."""

    ref: int
    source_type: SourceType
    document_id: str
    title: str
    source_uri: str
    revision: str
    status: DocStatus | None
    section: str | None
    section_anchor: str | None
    excerpt: str
    retrieved_at: datetime
    is_demo: bool
    app_path: str | None  # in-app link; only for documents the app can open itself


class ExcludedSource(BaseModel):
    document_id: str
    title: str
    status: DocStatus
    reason: str


def _default_scopes() -> list[SearchScope]:
    return ["team"]


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=3, max_length=2000)
    sources: list[SearchScope] = Field(default_factory=_default_scopes, min_length=1, max_length=2)
    include_drafts: bool = False
    include_deprecated: bool = False


class AskResponse(BaseModel):
    answer: str
    mode: Literal["mock", "internal_api", "disabled"]
    confidence: Confidence
    citations: list[Citation]
    warnings: list[str]
    excluded_sources: list[ExcludedSource] = Field(default_factory=list)
    scopes: list[ScopeStatus] = Field(default_factory=list)
    unmatched_terms: list[str] = Field(default_factory=list)


IntegrationTarget = Literal["none", "local", "mock", "real"]
IntegrationAccess = Literal["none", "read", "write", "read_write"]


class IntegrationStatus(BaseModel):
    name: str
    title: str
    kind: str
    state: IntegrationState
    capabilities: list[str]
    human_readable_message: str
    details: dict[str, str] = Field(default_factory=dict)
    # none: not configured · local: built into this app (fixtures, demo) · mock: a declared local TEST
    # DOUBLE · real: a real server (NOT live-validated by this application).
    target: IntegrationTarget = "none"
    access: IntegrationAccess = "none"
    checked_at: datetime | None = None


class SyncStatus(BaseModel):
    """State of the knowledge source synchronisation and of the derived search index."""

    source: SourceType
    state: SyncState
    message: str
    documents: int
    issues: int
    failed_paths: list[str]
    last_attempt_at: datetime | None
    last_success_at: datetime | None
    source_version: str | None
    branch: str | None = None
    head_commit: str | None = None
    indexed_documents: int
    indexed_version: str | None
    indexed_at: datetime | None


class IntegrationsResponse(BaseModel):
    items: list[IntegrationStatus]
    checked_at: datetime
