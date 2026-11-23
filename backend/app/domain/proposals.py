"""Models for reviewable change proposals (drafts)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.models import DocStatus, DocType, SourceType, ValidationIssue

MAX_PROPOSED_CHARS = 512 * 1024


class ProposalStatus(StrEnum):
    """Local lifecycle of a proposal. It is deliberately separate from the GitLab MR state:
    `ready_for_review` does not mean an MR exists, and `submitted_to_gitlab` does not mean approval."""

    draft = "draft"  # created; editable decision pending
    ready_for_review = "ready_for_review"  # validated against the current revision; not sent anywhere yet
    submitting = "submitting"  # branch/commit/MR creation in progress (guards against double submit)
    submitted_to_gitlab = "submitted_to_gitlab"  # an MR exists; review and merge happen in GitLab
    merged = "merged"  # set ONLY after GitLab confirmed the MR state `merged`
    rejected = "rejected"  # rejected locally or the MR was closed without merge in GitLab
    conflict = "conflict"  # the source document changed after the base revision; nothing was overwritten
    submission_failed = "submission_failed"  # GitLab write failed; the local proposal is preserved


# Legacy values from stores created by earlier builds (migrated on open).
LEGACY_STATUS_MAP = {"open": "draft", "submitted": "submitted_to_gitlab"}
TERMINAL_STATUSES = frozenset({ProposalStatus.merged, ProposalStatus.rejected, ProposalStatus.conflict})
MergeRequestState = Literal["opened", "merged", "closed", "locked", "unknown"]
# new_document: a `create` proposal whose document does not exist yet (expected before merge);
# id_taken: a document with the proposed ID appeared in the knowledge base before this proposal merged.
# merged_pending_sync: GitLab confirmed the merge, but the knowledge base has not been re-synced yet.
SourceDocumentState = Literal[
    "unchanged",
    "changed_since_base",
    "updated_by_this_proposal",
    "merged_pending_sync",
    "missing",
    "new_document",
    "id_taken",
]
# create: a new file in the knowledge base; update: a change of an existing document.
ProposalOperation = Literal["create", "update"]
OPEN_STATUSES = frozenset(
    {
        ProposalStatus.draft,
        ProposalStatus.ready_for_review,
        ProposalStatus.submitting,
        ProposalStatus.submitted_to_gitlab,
        ProposalStatus.submission_failed,
    }
)


# external_page: a curation proposal built from an external (Confluence) page — like an AI draft it can never
# be approved by its author; it is a draft that goes through the normal review.
ProposalOrigin = Literal["manual", "ai_suggestion", "external_page"]


class DiffLine(BaseModel):
    kind: Literal["context", "add", "remove", "hunk"]
    old_no: int | None = None
    new_no: int | None = None
    text: str


class DiffResult(BaseModel):
    unified: str
    lines: list[DiffLine]
    additions: int
    deletions: int
    changed: bool


class ProposalEvent(BaseModel):
    at: datetime
    actor: str
    action: str
    status: ProposalStatus | None


class DraftCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128)
    base_revision: str = Field(min_length=1, max_length=128)
    proposed_content: str = Field(min_length=1, max_length=MAX_PROPOSED_CHARS)
    reason: str = Field(min_length=3, max_length=2000)
    origin: ProposalOrigin = "manual"


class NewDocumentMetadata(BaseModel):
    """Form fields of a new document. The application generates the YAML frontmatter from them."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    status: DocStatus = DocStatus.draft
    owner: str = Field(min_length=1, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=30)
    related_ids: list[str] = Field(default_factory=list, max_length=50)
    source_refs: list[str] = Field(default_factory=list, max_length=50)
    summary: str | None = Field(default=None, max_length=1000)


class NewDocumentDraftCreate(BaseModel):
    """`POST /api/authoring/drafts`: a persistent draft of a NEW document (operation=create)."""

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, max_length=40)
    metadata: NewDocumentMetadata
    body: str = Field(min_length=1, max_length=MAX_PROPOSED_CHARS)
    path: str | None = Field(default=None, max_length=400)
    reason: str = Field(min_length=3, max_length=2000)
    origin: ProposalOrigin = "manual"


class DraftUpdate(BaseModel):
    """`PUT /api/drafts/{id}`: save an editable draft. `expected_version` guards against lost updates
    (two tabs, two people): a stale version is answered with 409 and nothing is overwritten."""

    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)
    reason: str | None = Field(default=None, min_length=3, max_length=2000)
    proposed_content: str | None = Field(default=None, min_length=1, max_length=MAX_PROPOSED_CHARS)  # update
    metadata: NewDocumentMetadata | None = None  # create
    body: str | None = Field(default=None, min_length=1, max_length=MAX_PROPOSED_CHARS)  # create
    path: str | None = Field(default=None, max_length=400)  # create
    origin: ProposalOrigin | None = None


class AuthoringCheckRequest(BaseModel):
    """Stateless validation + preview of a new document (nothing is stored)."""

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, max_length=40)
    metadata: NewDocumentMetadata
    body: str = Field(min_length=1, max_length=MAX_PROPOSED_CHARS)
    path: str | None = Field(default=None, max_length=400)
    origin: ProposalOrigin = "manual"
    exclude_proposal_id: str | None = Field(default=None, max_length=64)
    # An existing draft is checked against the template version it was created with.
    template_version: int | None = Field(default=None, ge=1, le=1000)


class AuthoringCheckResponse(BaseModel):
    content: str  # the full Markdown file that would be proposed (generated frontmatter + body)
    path: str
    validation: list[ValidationIssue]
    preview_html: str
    id_available: bool
    path_available: bool
    error_count: int
    warning_count: int


class DocumentTemplateInfo(BaseModel):
    id: str
    title: str
    description: str
    doc_type: DocType
    id_prefix: str
    default_tags: list[str]
    sections: list[str]
    skeleton: str
    suggested_id: str
    suggested_path: str
    version: int = 1
    previous_versions: list[int] = Field(default_factory=list)


class AiDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=300)
    request: str = Field(min_length=3, max_length=2000)
    related_ids: list[str] = Field(default_factory=list, max_length=10)


class AuthoringReferenceInfo(BaseModel):
    document_id: str
    title: str
    revision: str
    status: DocStatus
    source: SourceType
    is_demo: bool


class AuthoringCitationInfo(BaseModel):
    document_id: str
    title: str
    revision: str
    status: DocStatus
    section: str | None
    quote: str


class AiDraftResponse(BaseModel):
    """Result of AI-assisted authoring. It is only a text suggestion: it is not stored, it is not
    a proposal and it never becomes approved by itself."""

    mode: str
    body: str
    references: list[AuthoringReferenceInfo]
    citations: list[AuthoringCitationInfo]  # verified verbatim excerpts with source ID and revision
    unverified_claims: list[str]
    warnings: list[str]
    insufficient_data: bool
    suggested_related_ids: list[str]
    access_scope: str


class RejectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comment: str | None = Field(default=None, max_length=2000)


class SuggestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128)
    base_revision: str = Field(min_length=1, max_length=128)
    instruction: str = Field(min_length=3, max_length=2000)


class SuggestResponse(BaseModel):
    document_id: str
    base_revision: str
    proposed_content: str
    mode: str
    warnings: list[str]


class PublicationState(BaseModel):
    state: Literal["local_only", "disabled", "submitted"]
    message: str
    external_url: str | None = None


class MergeRequestInfo(BaseModel):
    """What GitLab reported about the proposal's MR (never inferred locally)."""

    iid: str | None
    url: str | None
    state: MergeRequestState | None
    source_branch: str | None
    target_branch: str | None
    checked_at: datetime | None


class SubmissionInfo(BaseModel):
    attempts: int
    last_attempt_at: datetime | None
    error_code: str | None
    error_message: str | None
    # True when GitLab may have applied a write whose answer was lost (timeout). The next attempt
    # inspects GitLab first and never blindly repeats the write.
    uncertain: bool


class ProposalSummary(BaseModel):
    id: str
    operation: ProposalOperation = "update"
    document_id: str
    document_title: str
    source: SourceType
    status: ProposalStatus
    reason: str
    origin: ProposalOrigin
    author: str
    created_at: datetime
    updated_at: datetime
    base_revision: str
    additions: int
    deletions: int
    error_count: int
    warning_count: int
    merge_request_url: str | None = None
    merge_request_state: MergeRequestState | None = None


class NewDocumentView(BaseModel):
    """Form view of a `create` proposal (parsed back from the stored Markdown)."""

    metadata: dict[str, object]
    body: str


class ProposalDetail(ProposalSummary):
    document_path: str
    current_revision: str | None
    is_stale: bool
    base_content: str
    proposed_content: str
    validation: list[ValidationIssue]
    diff: DiffResult
    history: list[ProposalEvent]
    review_comment: str | None
    can_mark_ready: bool
    can_reject: bool
    can_submit: bool
    can_refresh_status: bool
    publication: PublicationState
    source_document_state: SourceDocumentState
    branch_name: str | None
    merge_request: MergeRequestInfo | None
    submission: SubmissionInfo
    template_id: str | None = None
    # Template version the draft was created with, and the registry's current version (for the UI hint).
    template_version: int | None = None
    template_current_version: int | None = None
    edit_version: int = 1
    can_edit: bool = False
    can_delete: bool = False
    new_document: NewDocumentView | None = None
    # Revision of the document in the knowledge base after the confirmed merge and sync.
    merged_revision: str | None = None
    synced_at: datetime | None = None


class ProposalList(BaseModel):
    items: list[ProposalSummary]
    total: int
