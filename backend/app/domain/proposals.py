"""Models for reviewable change proposals (drafts)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.models import SourceType, ValidationIssue

MAX_PROPOSED_CHARS = 512 * 1024


class ProposalStatus(StrEnum):
    open = "open"
    ready_for_review = "ready_for_review"
    submitted = "submitted"  # a GitLab MR exists; review and the decision happen in GitLab
    rejected = "rejected"


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
    publication: PublicationState


class ProposalList(BaseModel):
    items: list[ProposalSummary]
    total: int
