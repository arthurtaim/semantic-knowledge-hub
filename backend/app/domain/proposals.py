"""Models for reviewable change proposals (drafts)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.models import SourceType, ValidationIssue

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
SourceDocumentState = Literal["unchanged", "changed_since_base", "updated_by_this_proposal", "missing"]


ProposalOrigin = Literal["manual", "ai_suggestion"]


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


class ProposalList(BaseModel):
    items: list[ProposalSummary]
    total: int
