"""M8 knowledge onboarding — API shapes (docs/KNOWLEDGE_ONBOARDING.md).

A batch is a STAGED, reviewable set of uploaded files. Nothing here is knowledge: an item becomes an ordinary DRAFT
proposal only when the person confirms it, and canonical (approved, searchable, cited) only through the existing
review → GitLab merge → sync. Every suggested value carries its origin and evidence; a model suggestion is never
verified by itself, and a relation candidate is never a graph fact (M9/M10 bind them later, `bound_to_entity_graph`).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

BatchState = Literal[
    "uploaded", "parsed", "review", "confirmed", "partially_confirmed", "rejected", "expired"
]
ParseStatus = Literal["pending", "parsed", "invalid", "unsupported", "duplicate", "conflict"]
ItemStatus = Literal[
    "pending",
    "parsed",
    "invalid",
    "unsupported",
    "duplicate",
    "conflict",
    "reviewed",
    "skipped",
    "draft_created",
    "draft_failed",
]
Operation = Literal["create", "update", "skip"]
FieldOrigin = Literal["frontmatter", "parser", "heuristic", "model", "user", "system"]
LinkKind = Literal["wikilink", "related_id", "mention", "similar"]
ResolveState = Literal["resolved", "in_batch", "missing", "ambiguous"]
AiState = Literal["none", "done", "failed", "unavailable", "skipped"]
EDITABLE_FIELDS = ("title", "type", "owner", "tags", "summary", "template_id", "related_ids")

_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"


class Evidence(BaseModel):
    """Where a value comes from: the uploaded file and line (a snippet of the person's text), or a document of the
    reader's snapshot. A future `EvidenceReference` (M9) adds document_id / revision / span."""

    file: str
    line: int | None = None
    snippet: str = ""
    document_id: str | None = None


class FieldSuggestion(BaseModel):
    field: str
    value: Any = None
    origin: FieldOrigin
    confidence: float | None = None  # only a model states one; heuristics are rules, not probabilities
    evidence: list[Evidence] = Field(default_factory=list)
    needs_review: bool = True
    note: str = ""


class CandidateLink(BaseModel):
    """A relation CANDIDATE found in an uploaded file. Selected by the person, it enters `related_ids` of the draft;
    it is never a canonical edge before the document is approved and synced, and never a typed entity fact (M10)."""

    link_id: str
    link_kind: LinkKind
    target_document_id: str
    target_title: str | None = None
    target_item_id: str | None = None  # another file of this batch
    resolve_state: ResolveState
    evidence: Evidence
    selected_by_user: bool = False
    status: Literal["candidate"] = "candidate"
    bound_to_entity_graph: Literal[False] = False


class Diagnostic(BaseModel):
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    field: str | None = None


class ExistingDocRef(BaseModel):
    document_id: str
    title: str
    revision: str
    status: str


class DuplicateRef(BaseModel):
    kind: Literal["exact_hash", "same_id", "same_path", "existing_content", "similar_title", "open_draft"]
    item_id: str | None = None  # another file of this batch
    document_id: str | None = None  # a document of the reader's snapshot
    message: str


class ItemDecisions(BaseModel):
    """What the person decided for one file; empty = the suggestions as shown."""

    excluded: bool = False
    operation: Operation | None = None
    fields: dict[str, Any] = Field(default_factory=dict)  # EDITABLE_FIELDS only
    selected_links: list[str] | None = None  # CandidateLink.link_id; None = the defaults of the analysis
    reviewed: bool = False


class DraftOutcome(BaseModel):
    state: Literal["draft_created", "draft_failed"]
    proposal_id: str | None = None
    document_id: str | None = None
    operation: Literal["create", "update"] | None = None
    code: str | None = None
    message: str | None = None


class ItemSummary(BaseModel):
    item_id: str
    path: str
    display_name: str
    size: int
    media_type: str
    parser: str
    parse_status: ParseStatus
    status: ItemStatus
    proposed_operation: Operation
    document_id: str | None = (
        None  # from YAML or the existing document of an UPDATE (else allocated at creation)
    )
    title: str = ""
    template_id: str | None = None
    doc_type: str | None = None
    existing_doc: ExistingDocRef | None = None
    duplicates: list[DuplicateRef] = Field(default_factory=list)
    errors: int = 0
    warnings: int = 0
    links: int = 0
    needs_review: bool = True
    excluded: bool = False
    ai_state: AiState = "none"
    revision: int
    outcome: DraftOutcome | None = None


class ItemDetail(ItemSummary):
    checksum_sha256: str
    diagnostics: list[Diagnostic] = Field(default_factory=list)
    fields: list[FieldSuggestion] = Field(default_factory=list)
    candidate_links: list[CandidateLink] = Field(default_factory=list)
    decisions: ItemDecisions = Field(default_factory=ItemDecisions)
    body_preview: str = ""  # the extracted text (plain), capped
    preview_html: str = ""  # sanitized HTML rendered by the server; raw bytes are never rendered
    diff: list[dict[str, Any]] | None = None  # UPDATE: the change against the reader's current revision
    diff_stats: dict[str, int] | None = None
    ai_note: str | None = None


class BatchCounts(BaseModel):
    total: int = 0
    parsed: int = 0
    invalid: int = 0
    unsupported: int = 0
    duplicate: int = 0
    conflict: int = 0
    updates: int = 0
    excluded: int = 0
    draft_created: int = 0
    draft_failed: int = 0


class BatchOut(BaseModel):
    batch_id: str
    state: BatchState
    source_kind: Literal["zip", "files", "folder"]
    created_at: datetime
    expires_at: datetime
    file_count: int
    bytes_total: int
    revision: int
    counts: BatchCounts
    items: list[ItemSummary] = Field(default_factory=list)
    ai_available: bool = False
    index_unchanged: bool = True  # staging never touches the index, the graph or the knowledge base


class BatchListItem(BaseModel):
    batch_id: str
    state: BatchState
    created_at: datetime
    expires_at: datetime
    file_count: int
    counts: BatchCounts


class OnboardingCapabilities(BaseModel):
    formats: list[str]
    parsers: dict[str, Literal["available", "unavailable"]]
    upload_mb: int
    expanded_mb: int
    max_files: int
    file_mb: int
    ttl_hours: int
    ai_available: bool
    ai_items_per_batch: int


class ItemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)
    excluded: bool | None = None
    operation: Operation | None = None
    fields: dict[str, Any] | None = None
    selected_links: list[str] | None = Field(default=None, max_length=200)
    reviewed: bool | None = None

    @field_validator("fields")
    @classmethod
    def _fields(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        unknown = set(value) - set(EDITABLE_FIELDS)
        if unknown:
            raise ValueError(f"not editable: {sorted(unknown)}")
        return value


class SelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_ids: list[str] = Field(min_length=1, max_length=2000)


class PlannedItem(BaseModel):
    item_id: str
    path: str
    operation: Literal["create", "update"]
    document_id: str | None
    title: str
    template_id: str | None
    related_ids: list[str]
    errors: list[Diagnostic] = Field(default_factory=list)


class BatchPreview(BaseModel):
    batch_id: str
    revision: int
    fingerprint: str
    planned: list[PlannedItem]
    blocked: list[PlannedItem]  # selected but not creatable as is (errors listed)
    skipped: list[ItemSummary]  # not selected, with their state
    creates: int
    updates: int
    index_unchanged: bool = True


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)
    fingerprint: str = Field(min_length=16, max_length=128)
    item_ids: list[str] = Field(min_length=1, max_length=2000)
    idempotency_key: str = Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")


class ConfirmResult(BaseModel):
    batch_id: str
    state: BatchState
    outcomes: dict[str, DraftOutcome]  # item_id → outcome
    created: int
    failed: int
    replayed: bool = False


class SuggestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_ids: list[str] = Field(min_length=1, max_length=10)


class SuggestResult(BaseModel):
    batch_id: str
    revision: int
    states: dict[str, AiState]
    note: str | None = None


__all__ = [
    "EDITABLE_FIELDS",
    "_ID_RE",
    "BatchCounts",
    "BatchListItem",
    "BatchOut",
    "BatchPreview",
    "CandidateLink",
    "ConfirmRequest",
    "ConfirmResult",
    "Diagnostic",
    "DraftOutcome",
    "DuplicateRef",
    "Evidence",
    "ExistingDocRef",
    "FieldSuggestion",
    "ItemDecisions",
    "ItemDetail",
    "ItemPatch",
    "ItemSummary",
    "OnboardingCapabilities",
    "PlannedItem",
    "SelectionRequest",
    "SuggestRequest",
    "SuggestResult",
]
