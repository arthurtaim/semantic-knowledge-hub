"""Provider-independent domain and API models."""

from __future__ import annotations

import json
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.domain.skills import SKILL_BY_ID


class DocType(StrEnum):
    overview = "overview"
    architecture = "architecture"
    source = "source"  # a source system profile
    domain = "domain"  # semantic entities, logical/physical models, mappings
    dataset = "dataset"
    integration = "integration"
    process = "process"
    decision = "decision"
    standard = "standard"
    guide = "guide"
    glossary = "glossary"


class RelationType(StrEnum):
    """Typed, directed relation declared by a document (`relations:` in the frontmatter).

    The edge goes FROM the declaring document TO each listed target (see docs/MOCK_KNOWLEDGE_BASE.md).
    `references` is the implicit type of plain `related_ids`.
    """

    references = "references"
    depends_on = "depends_on"
    consumes = "consumes"
    produces = "produces"
    maps_to = "maps_to"
    derived_from = "derived_from"
    describes = "describes"
    constrains = "constrains"
    supersedes = "supersedes"
    uses_template = "uses_template"


class DocStatus(StrEnum):
    draft = "draft"
    in_review = "in_review"
    approved = "approved"
    deprecated = "deprecated"


SourceType = Literal["local", "gitlab", "confluence"]
# Where a cited excerpt comes from: a knowledge source, or a file attached to the conversation (UI v2). An
# attachment is never a knowledge-base document: a separate evidence group, never indexed.
CitationSourceType = Literal["local", "gitlab", "confluence", "attachment"]
CONVERSATION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$"
ATTACHMENT_ID_PATTERN = r"^ATT-[0-9a-f]{16}$"
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


class DeclaredRelation(BaseModel):
    """One typed edge as written in a document's frontmatter (provenance: the declaring file + field)."""

    model_config = ConfigDict(frozen=True)

    type: RelationType
    target: str
    field: str  # `relations.<type>`, `related_ids`, or `body` (an inline WikiLink)
    line: int | None = None  # body line of a WikiLink


class WikiLinkRef(BaseModel):
    """An inline `[[target#anchor|label]]` of a document body (source location kept for diagnostics)."""

    model_config = ConfigDict(frozen=True)

    target: str
    anchor: str = ""
    label: str = ""
    line: int
    excerpt: str
    id_like: bool


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
    relations: tuple[DeclaredRelation, ...] = ()
    wikilinks: tuple[WikiLinkRef, ...] = ()
    aliases: tuple[str, ...] = ()
    version: str | None = None  # human document version (e.g. "1.2"); `revision` is the content revision
    synthetic: bool = False
    template_id: str | None = None
    template_version: int | None = None
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
    # The document's own date: `updated_at` in its front matter (the catalog's «Обновлён»); None when it has none.
    metadata_updated_at: date | None = None
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
    updated_at: datetime | None  # time of the source revision (commit date / file mtime)
    review_state: ReviewState
    owner_missing: bool
    web_url: str | None = None
    # "stale": the last sync could not refresh this document; it is shown with its last known revision.
    index_state: IndexState = "current"
    highlights: list[HighlightSegment] | None = None  # present when listed via a text query
    match_reasons: list[str] | None = None  # "why matched" (text query only)
    related_via: str | None = None  # found through a declared relation of this document (graph expansion)
    version: str | None = None
    # Distinct documents linked to this one in the READER's snapshot (its links ∪ its backlinks) — the document
    # page's «Связи». Set by `GET /api/documents`; null where a summary is built without it.
    link_count: int | None = None
    # `updated_at` from the document's own front matter (YYYY-MM-DD) — the catalog's «Обновлён»; null without one.
    metadata_updated_at: date | None = None


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
    # M5.6.3 metadata panel: pinned template and the inline links found in the body.
    template_id: str | None = None
    template_version: int | None = None
    wikilink_count: int = 0


class DocumentPage(BaseModel):
    items: list[DocumentSummary]
    total: int
    page: int
    size: int
    notes: list[str] = Field(default_factory=list)  # e.g. an ambiguous abbreviation in the query


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
    match_reasons: list[str] = Field(default_factory=list)
    matched_fields: list[str] = Field(default_factory=list)
    related_via: str | None = None


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


class ExcerptPart(BaseModel):
    """A piece of a cited excerpt: prose of the quote (`text`), or a table (`headers` + the touched `rows`)."""

    kind: Literal["text", "table"]
    text: str | None = None
    headers: list[str] | None = None
    rows: list[list[str]] | None = None


class Citation(BaseModel):
    """Provenance of a cited excerpt. `ref` is the stable number shown in the answer ([1], [2]…)."""

    ref: int
    source_type: CitationSourceType
    document_id: str  # for an attachment: its id (ATT-…)
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
    # M5.6.2 provenance: kind and namespaced id of the source (local:ID / gitlab:ID /
    # confluence:<instance>:<page>:<version>), authority as an EXTERNAL source states it
    # (approved | draft | unknown), the fragment of the retrieved snapshot and its hash.
    source_kind: Literal["local_markdown", "gitlab_approved", "confluence_mcp"] | None = None
    source_id: str | None = None
    external_status: str | None = None
    fragment_id: str | None = None
    content_hash: str | None = None
    # UI v2: an excerpt of a file attached to this conversation (source_type "attachment"). The locator
    # («строка 1», «стр. 4», «лист Fields, строка 12») is computed by the server from the cited fragment.
    attachment_id: str | None = None
    attachment_name: str | None = None
    locator: str | None = None
    # Display of `excerpt` when the verified quote touches a Markdown table: the quote's prose and the table rows
    # it touches, taken by the server from the cited section of the same revision (app/domain/excerpts.py).
    # None: show `excerpt` as is. `excerpt` stays the verbatim quote the server verified.
    excerpt_parts: list[ExcerptPart] | None = None


class ExcludedSource(BaseModel):
    document_id: str
    title: str
    status: DocStatus
    reason: str


def _default_scopes() -> list[SearchScope]:
    return ["team"]


# --- M5.7: system facts of an AI-native answer (docs/AI_NATIVE_TOOLS.md) ---------------------------------------
SystemFactSource = Literal[
    "skh_document_registry", "skh_knowledge_graph", "skh_template_registry", "skh_ai_proposals"
]
ToolOutcome = Literal[
    "ok", "invalid", "unknown_tool", "not_found", "denied", "unavailable", "timeout", "error"
]
MAX_CONTEXT_FILTER_KEYS = 12
MAX_CONTEXT_FILTER_CHARS = 1000


class SystemFactItem(BaseModel):
    """One visible object of a structured observation: a document, a template, a relation or a proposal."""

    id: str
    title: str
    kind: Literal["document", "template", "relation", "proposal"]
    status: str | None = None
    detail: str | None = (
        None  # e.g. "владелец не назначен", "references · WikiLink, строка 12", "v2 · active"
    )
    app_path: str | None = None


class SystemFact(BaseModel):
    """An authoritative, server-computed observation of SKH state (registry, graph, templates, proposals).

    It is the evidence of a system claim the way a verified Citation is the evidence of a document claim: the UI
    renders `value`/`items` from here, never from the model's text. Everything is computed from the reader's own
    snapshot (`access_scope`), so totals never include what the reader cannot see."""

    ref: str  # "F1" — the marker the answer text may use ([F1])
    tool: str
    operation: str
    label: str  # human Russian label, e.g. «Документы в доступном каталоге»
    value: int | None = None  # the authoritative number (count / total); null for lists without a number
    unit: str | None = None  # "documents" | "templates" | "relations" | "versions"
    effective_filters: dict[str, Any] = Field(default_factory=dict)
    definition: str | None = None  # how the number is defined (e.g. a text match is NOT a system tag)
    access_scope: Literal["visible_to_request_context"] = "visible_to_request_context"
    source: SystemFactSource
    generation: str | None = None  # index generation of the snapshot the fact was computed from
    as_of: datetime
    items: list[SystemFactItem] = Field(default_factory=list)  # bounded; `truncated` when more exist
    truncated: bool = False
    breakdown: dict[str, dict[str, int]] | None = None  # facets: {"status": {"approved": 73, …}, …}


class ToolStepInfo(BaseModel):
    """One executed (or refused) tool call of an answer, without payloads: what was checked and how it ended."""

    call_id: str  # T1, T2, … in call order
    round: int
    tool: str
    operation: str | None = None
    outcome: ToolOutcome
    duration_ms: int
    result_count: int | None = None
    fact_ref: str | None = None
    error_code: str | None = None
    message: str | None = None  # sanitized Russian text for a failed step


class TurnFactContext(BaseModel):
    """Minimal referent of an earlier answer («а из них…»): the filters and visible IDs of a system fact. The client
    echoes `AskResponse.conversation_context` back in `history[-1].context`. Context only — never an access grant:
    every ID is re-checked against the reader's snapshot and every tool call re-checks access."""

    model_config = ConfigDict(extra="forbid")

    tool: str = Field(min_length=1, max_length=40)
    operation: str = Field(min_length=1, max_length=40)
    filters: dict[str, Any] = Field(default_factory=dict)
    document_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        default_factory=list, max_length=20
    )
    value: int | None = Field(default=None, ge=0, le=10_000_000)

    @field_validator("filters")
    @classmethod
    def _bounded_filters(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > MAX_CONTEXT_FILTER_KEYS:
            raise ValueError("too many filters")
        if len(json.dumps(value, ensure_ascii=False, default=str)) > MAX_CONTEXT_FILTER_CHARS:
            raise ValueError("filters are too large")
        return value


class ConversationTurnIn(BaseModel):
    """A previous turn of the same conversation, sent back by the client (the server keeps no chat state)."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(max_length=4000)
    # M5.7 (optional): `conversation_context` of that answer, echoed back for follow-ups. Context, not evidence.
    context: list[TurnFactContext] = Field(default_factory=list, max_length=5)


class AskSelection(BaseModel):
    """A fragment the user selected in a document (UI v2). The server verifies that `text` really is in the
    document (in the section of `section_anchor` when given) before it becomes context."""

    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128)
    section_anchor: str | None = Field(default=None, max_length=200)
    text: str = Field(default="", max_length=8000)


AttachmentId = Annotated[str, Field(pattern=ATTACHMENT_ID_PATTERN)]
DocumentRef = Annotated[str, Field(min_length=1, max_length=128)]


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # At least 3 characters, unless the chosen skill has an optional prompt (UI v2: Enter runs the skill).
    question: str = Field(default="", max_length=2000)
    sources: list[SearchScope] = Field(default_factory=_default_scopes, min_length=1, max_length=2)
    include_drafts: bool = False
    include_deprecated: bool = False
    # Force the external (Confluence) search even when the team documents look sufficient.
    search_external: bool = False
    # Earlier turns (oldest first). Context for the model only — never evidence, never stored.
    history: list[ConversationTurnIn] = Field(default_factory=list, max_length=6)
    # --- UI v2 (docs/ui-v2/specs/02_ASSISTANT.md §5); all optional, the defaults behave exactly as before ---
    conversation_id: str | None = Field(default=None, pattern=CONVERSATION_ID_PATTERN)
    skill_id: str | None = Field(default=None, min_length=1, max_length=64)  # GET /api/assistant/skills
    attachment_ids: list[AttachmentId] = Field(default_factory=list, max_length=10)
    # Documents the user chose («@документ»): cited first when relevant.
    context_document_ids: list[DocumentRef] = Field(default_factory=list, max_length=5)
    selection: AskSelection | None = None

    @model_validator(mode="after")
    def _question_and_conversation(self) -> AskRequest:
        skill = SKILL_BY_ID.get(self.skill_id or "")
        if len(self.question) < 3 and not (skill is not None and skill.prompt_optional):
            raise ValueError("question must have at least 3 characters for this skill")
        if self.attachment_ids and not self.conversation_id:
            raise ValueError("attachment_ids require conversation_id")
        return self


class SkillRef(BaseModel):
    """The skill that produced an answer (echoed when the request named one)."""

    id: str
    name: str
    access: Literal["read", "draft"]


class ProposalRef(BaseModel):
    """An AI proposal created by a skill (GET /api/ai/proposals/{id}); nothing was applied."""

    id: str
    kind: str
    status: str
    graph_link: str | None = None


class AskResponse(BaseModel):
    answer: str
    mode: Literal["mock", "internal_api", "claude_cli", "disabled"]
    confidence: Confidence
    citations: list[Citation]
    warnings: list[str]
    excluded_sources: list[ExcludedSource] = Field(default_factory=list)
    scopes: list[ScopeStatus] = Field(default_factory=list)
    unmatched_terms: list[str] = Field(default_factory=list)
    # M5.6.2: what produced this answer — reproducible from the trace (no answer text is stored).
    retrieval_trace_id: str | None = None
    index_generation: str | None = None
    instructions_version: str | None = None
    external: dict[str, Any] | None = None  # external retrieval summary (called, trigger, calls, cache…)
    # UI v2: the skill used (null for a plain question) and, for skills built on the AI workflows, the stored
    # proposal the dialog shows as a card with a link (null otherwise). Nothing is ever applied by /ask.
    skill: SkillRef | None = None
    proposal: ProposalRef | None = None
    # M5.7 (additive; docs/AI_NATIVE_TOOLS.md): authoritative structured observations the answer relies on
    # ([F1] markers in `answer`), the tool steps that were executed, whether the text relies on the model's general
    # knowledge (never internal evidence), and the referent a follow-up question can use.
    system_facts: list[SystemFact] = Field(default_factory=list)
    tool_steps: list[ToolStepInfo] = Field(default_factory=list)
    general_knowledge: bool = False
    conversation_context: list[TurnFactContext] = Field(default_factory=list)


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
    # M5.6.2: generation of the served index (monotonic), the last structured sync outcome, dictionaries.
    generation: int = 0
    last_sync: dict[str, Any] | None = None
    search_dictionary: str | None = None
    template_registry: str | None = None


class IntegrationsResponse(BaseModel):
    items: list[IntegrationStatus]
    checked_at: datetime
