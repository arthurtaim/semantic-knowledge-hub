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
    # «Документы» v2 (additive): the front-matter `summary` and the systems the document is about
    # (app/domain/doc_tree.py `document_systems`). Set by `GET /api/documents` and the document detail; null elsewhere.
    summary: str | None = None
    systems: list[str] | None = None


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


class DocumentTreeEntry(BaseModel):
    """One document of `GET /api/documents/tree`: what the tree, the branch list, the overview and the table show."""

    title: str
    type: DocType
    status: DocStatus
    review_state: ReviewState
    reviewed_at: date | None
    owner: str
    owner_missing: bool
    summary: str | None
    systems: list[str]
    link_count: int
    is_demo: bool
    source: SourceType
    index_state: IndexState = "current"
    group: (
        str | None
    )  # full group key (`integration/aris`); null when the document sits directly in its section
    # status in_review / draft / deprecated, or review_state stale / never_reviewed, or owner_missing
    attention: bool


class DocumentTreeGroup(BaseModel):
    key: str
    label: str
    count: int
    attention: int
    doc_ids: list[str]


class DocumentTreeSection(BaseModel):
    key: str  # the document type
    label: str
    count: int
    attention: int
    groups: list[DocumentTreeGroup]
    doc_ids: list[str]  # documents directly in the section (none when every document is in a group)


class DocumentTree(BaseModel):
    """`GET /api/documents/tree`: the whole visible base in one response (docs/ui-v2/documents/specs §4)."""

    total: int
    attention_total: int
    sections: list[DocumentTreeSection]
    documents: dict[str, DocumentTreeEntry]


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


# Origin of a source as its METADATA states it (docs/API_CONTRACTS.md «Answer provenance»): `synthetic` — marked
# synthetic/demo (front matter `synthetic: true`, a `demo` tag, a demo workspace, the mock Confluence corpus);
# `not_synthetic` — a team document or corporate page without that mark; `unknown` — no provenance metadata at all
# (a file attached to the conversation). Never inferred from text and never a claim that a source is "real".
ProvenanceOrigin = Literal["synthetic", "not_synthetic", "unknown"]


def provenance_origin(source_type: str, is_demo: bool) -> ProvenanceOrigin:
    if source_type == "attachment":
        return "unknown"
    return "synthetic" if is_demo else "not_synthetic"


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
    # Origin of this source from its metadata (derived from `source_type` + `is_demo` unless given): the per-source
    # badge of the UI. `is_demo` alone cannot tell «not synthetic» from «unknown» (an attachment is `is_demo: false`).
    provenance: ProvenanceOrigin | None = None

    @model_validator(mode="after")
    def _derive_provenance(self) -> Citation:
        if self.provenance is None:
            self.provenance = provenance_origin(self.source_type, self.is_demo)
        return self


class ExcludedSource(BaseModel):
    document_id: str
    title: str
    status: DocStatus
    reason: str


def _default_scopes() -> list[SearchScope]:
    return ["team"]


# --- M5.7: system facts of an AI-native answer (docs/AI_NATIVE_TOOLS.md) ---------------------------------------
SystemFactSource = Literal[
    "skh_document_registry", "skh_knowledge_graph", "skh_template_registry", "skh_ai_proposals", "skh_work"
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
    kind: Literal["document", "template", "relation", "proposal", "task", "project"]
    status: str | None = None
    detail: str | None = (
        None  # e.g. "владелец не назначен", "references · WikiLink, строка 12", "v2 · active"
    )
    app_path: str | None = None
    # A document item: whether its metadata marks it synthetic/demo (source metadata, like Citation.is_demo);
    # None for templates, relations and proposals.
    is_demo: bool | None = None


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
    """A previous turn of the same conversation, sent back by the client. The answer never reads the stored chat
    history (v0.7, app/services/conversations.py): the context of a follow-up is what the client sends here."""

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

# --- M7: chat work skills (docs/WORK_CHAT_SKILLS.md) ------------------------------------------------------------
WORK_PROJECT_KEY_PATTERN = r"^[A-Z][A-Z0-9]{1,9}$"
WORK_TASK_KEY_PATTERN = r"^[A-Z][A-Z0-9]{1,9}-\d{1,9}$"
# A task-plan proposal (WAP, M6 «AI план») or a change-set of existing tasks (WCP, M7).
WORK_PROPOSAL_ID_PATTERN = r"^(WAP|WCP)-[0-9a-f]{16}$"
WORK_CLIENT_REQUEST_ID_PATTERN = r"^[A-Za-z0-9._:-]{8,80}$"
MAX_WORK_CONTEXT_TASKS = 20


def _upper_key(value: Any) -> Any:
    return value.strip().upper() if isinstance(value, str) else value


class AskWorkContext(BaseModel):
    """What a work skill acts on, chosen by the person in the composer (M7). Only REFERENCES — never an access grant:
    the server resolves the project and every task in the reader's own scope on every request (an unknown and a hidden
    one are the same 404), and a referenced proposal must be the reader's own. There is no user, role, version or
    `may_write` field: those are the server's."""

    model_config = ConfigDict(extra="forbid")

    project_key: Annotated[str, Field(pattern=WORK_PROJECT_KEY_PATTERN)] | None = None
    task_keys: Annotated[
        list[Annotated[str, Field(pattern=WORK_TASK_KEY_PATTERN)]], Field(max_length=MAX_WORK_CONTEXT_TASKS)
    ] = Field(default_factory=list)
    # A proposal the follow-up refines (a NEW proposal is created; the referenced one is never changed or applied).
    proposal_id: Annotated[str, Field(pattern=WORK_PROPOSAL_ID_PATTERN)] | None = None
    # Idempotency of one send: a retry with the same id returns the proposal already stored, never a second one.
    client_request_id: Annotated[str, Field(pattern=WORK_CLIENT_REQUEST_ID_PATTERN)] | None = None

    @field_validator("project_key", mode="before")
    @classmethod
    def _project(cls, value: Any) -> Any:
        return _upper_key(value)

    @field_validator("task_keys", mode="before")
    @classmethod
    def _tasks(cls, value: Any) -> Any:
        if isinstance(value, list):
            return list(dict.fromkeys(_upper_key(v) for v in value))
        return value


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
    # Chat history (v0.7, additive): where the conversation lives in the UI — the dialog (/ask) or the assistant
    # panel of a document (its document is the selection's or the first chosen one). Labels the stored
    # conversation only; the answer does not depend on it.
    origin: Literal["dialog", "document"] = "dialog"
    # M7 (additive): the project / tasks / proposal a WORK skill acts on. Only with a work skill.
    work_context: AskWorkContext | None = None

    @model_validator(mode="after")
    def _question_and_conversation(self) -> AskRequest:
        skill = SKILL_BY_ID.get(self.skill_id or "")
        if len(self.question) < 3 and not (skill is not None and skill.prompt_optional):
            raise ValueError("question must have at least 3 characters for this skill")
        if self.attachment_ids and not self.conversation_id:
            raise ValueError("attachment_ids require conversation_id")
        if self.work_context is not None and not (skill is not None and skill.is_work):
            raise ValueError("work_context is accepted only with a work skill")
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


class WorkProposalRef(BaseModel):
    """M7: a WORK proposal a chat skill created — a task plan (WAP, GET /api/work-ai/proposals/{id}) or a change-set
    of existing tasks (WCP, GET /api/work-ai/change-proposals/{id}). Separate from `ProposalRef` (document AI
    proposals): a different store, lifecycle and review screen. Counts and state are read from the STORED proposal at
    answer time (the UI re-reads the current state); `app_path` is built by the server. Nothing was applied."""

    kind: Literal["task_plan", "task_changes"]
    id: str
    project_key: str
    state: str  # ready | stale | applied | rejected — at answer time
    app_path: str
    task_count: int = 0  # task_plan: proposed tasks
    dependency_count: int = 0  # task_plan: proposed FS dependencies
    change_count: int = 0  # task_changes: proposed field changes
    revised_from: str | None = None  # the proposal this one refines (that one is unchanged)
    requires_confirmation: bool = True


TaskDraftField = Literal[
    "project", "title", "description", "priority", "assignee", "due_date", "start_date", "end_date"
]
TaskDraftOrigin = Literal["request", "assistant", "composer", "default"]


class TaskDraftIssue(BaseModel):
    """A server remark on a task draft (an unverified date, a past date, an unparsed model reply, …)."""

    field: TaskDraftField | None = None
    code: str
    message: str


class TaskDraftDocument(BaseModel):
    """A document of the request's context the new task will be linked to (visible to the reader; the revision it
    saw — the link itself records the revision the server sees at link time)."""

    document_id: str
    title: str
    revision: str


class TaskDraft(BaseModel):
    """«Создать задачу» (design 2026-11-27): ONE task's fields from the person's phrase, for a card in the chat. Nothing
    was written: the person edits the card and creates the task with the regular task API (`POST
    /api/projects/{key}/tasks`). Every value carries its origin; a date is only ever the server's parse of the phrase."""

    project_key: str | None = None
    title: str = ""
    description: str = ""
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    assignee_id: str | None = None
    assignee_hint: str | None = None  # a name from the phrase that matched no selectable assignee
    due_date: date | None = None
    start_date: date | None = None
    end_date: date | None = None  # the last day, inclusive (the card sends `end_exclusive`)
    origin: dict[TaskDraftField, TaskDraftOrigin] = Field(default_factory=dict)
    missing: list[Literal["project", "title"]] = Field(default_factory=list)
    issues: list[TaskDraftIssue] = Field(default_factory=list)
    documents: list[TaskDraftDocument] = Field(default_factory=list)
    auto_started: bool = False
    client_request_id: str = ""


class AnswerProvenance(BaseModel):
    """Origin of the evidence an answer ACTUALLY relies on: its validated citations and the documents named by its
    system facts — never every retrieved passage, never «some document of the catalog is demo». Counts are distinct
    sources. The UI shows it as one quiet indicator (and per-source badges from `Citation.provenance`) instead of a
    warning on every answer; a server warning is added only when it is material (mixed synthetic and non-synthetic
    evidence). `overall`: `none` — the answer relies on no source (insufficient evidence, general knowledge, a bare
    registry count); `mixed` — more than one origin."""

    overall: Literal["synthetic", "not_synthetic", "unknown", "mixed", "none"] = "none"
    synthetic: int = 0
    not_synthetic: int = 0
    unknown: int = 0
    by_kind: dict[str, int] = Field(default_factory=dict)  # "team" | "corporate" | "attachment" → sources


class EvidenceGateSummary(BaseModel):
    """Adaptive RAG (docs/ADAPTIVE_RAG.md): how the answer decided whether to consult the external source — codes
    and counts only (never the question, the gap the model described or the search queries)."""

    policy: str  # semantic-v1 | lexical-v2
    decision: Literal["sufficient", "need_external", "uncertain", "invalid", "not_assessed"]
    # local_sufficient | evidence_gap | model_uncertain | decision_invalid | no_local_passages | explicit_request |
    # external_scope_selected | external_budget_exhausted | a LOCAL_SUFFICIENCY v2 code (lexical policy)
    reason: str
    external_called: bool
    model_calls: int = 0
    repaired: bool = False
    error: str | None = None  # why a model decision was not used (timeout, not_json, unknown_evidence_id, …)
    fallback: str | None = None  # lexical:<code> | lexical:sufficient | local
    lexical: str | None = (
        None  # what LOCAL_SUFFICIENCY v2 says for the same evidence (A/B), None = sufficient
    )
    cards: int = 0
    evidence: int = 0
    missing: int = 0
    queries: int = 0
    queries_rejected: int = 0
    incomplete: bool = False
    normalized: list[str] = Field(default_factory=list)  # e.g. known_truncated — codes only, never content
    elapsed_ms: float = 0.0


class QueryRewriteSummary(BaseModel):
    """Adaptive RAG, query rewrite: whether the model rephrased the question for the team search — codes and counts
    only (never the question or the phrasings). Null when the provider cannot rewrite or the team scope is off."""

    mode: str  # off | absent_terms | always
    trigger: str | None = None  # absent_terms | no_local_passages | always | null (not needed)
    called: bool = False
    model_calls: int = 0
    repaired: bool = False
    error: str | None = None
    queries: int = 0
    rejected: int = 0
    added_passages: int = 0  # passages in the context that only the phrasings found
    elapsed_ms: float = 0.0


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
    # Adaptive RAG (additive): the local-first decision about the external source; null when it was not in scope.
    evidence_gate: EvidenceGateSummary | None = None
    query_rewrite: QueryRewriteSummary | None = None
    # UI v2: the skill used (null for a plain question) and, for skills built on the AI workflows, the stored
    # proposal the dialog shows as a card with a link (null otherwise). Nothing is ever applied by /ask.
    skill: SkillRef | None = None
    proposal: ProposalRef | None = None
    # M7 (additive): a work proposal (task plan or change-set) a chat work skill stored for review; null otherwise.
    work_proposal: WorkProposalRef | None = None
    # «Создать задачу» (additive): a task draft for a card; nothing was written.
    task_draft: TaskDraft | None = None
    # M5.7 (additive; docs/AI_NATIVE_TOOLS.md): authoritative structured observations the answer relies on
    # ([F1] markers in `answer`), the tool steps that were executed, whether the text relies on the model's general
    # knowledge (never internal evidence), and the referent a follow-up question can use.
    system_facts: list[SystemFact] = Field(default_factory=list)
    tool_steps: list[ToolStepInfo] = Field(default_factory=list)
    general_knowledge: bool = False
    conversation_context: list[TurnFactContext] = Field(default_factory=list)
    # Answer-quality fix (additive): origin of the validated evidence (app/domain/provenance.py).
    provenance: AnswerProvenance = Field(default_factory=AnswerProvenance)


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
