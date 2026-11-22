"""M5 publication models. Publication is a lifecycle of its own: independent of the proposal status
and of the GitLab MR state (docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.domain.models import ValidationIssue

PublicationJobState = Literal[
    "pending",  # created (after a confirmed merge + sync, or on request); nothing checked yet
    "validating",  # dry-run in progress (read-only)
    "dry_run_ready",  # preview ready; a human may publish
    "publishing",  # a write to Confluence is in progress
    "published",  # Confluence confirmed the page/version (or no change was needed)
    "conflict",  # the page was edited manually / belongs to someone else; nothing overwritten
    "failed",  # blocked by validation or a definite error; safe to retry after the cause is fixed
    "result_unknown",  # a write may have happened; the next step inspects Confluence first
    "superseded",  # replaced by a job for a newer revision
]
ACTIVE_JOB_STATES = ("pending", "validating", "dry_run_ready", "publishing", "result_unknown")
PublicationAction = Literal["create", "update", "noop", "conflict"]
DocumentPublicationState = Literal[
    "disabled",
    "not_published",
    "pending",
    "validating",
    "dry_run_ready",
    "publishing",
    "published",
    "outdated",
    "conflict",
    "failed",
    "result_unknown",
]
PublisherMode = Literal["disabled", "dry_run_only", "write"]
TargetKind = Literal["none", "local", "mock", "real"]


class PublicationTarget(BaseModel):
    space_key: str
    parent_id: str
    page_id: str | None
    title: str
    url: str | None


class MergeEvidence(BaseModel):
    iid: str
    url: str | None
    merged_at: str | None


class PublicationPlan(BaseModel):
    """Result of a dry-run. Produced with read requests only."""

    action: PublicationAction
    revision: str
    target: PublicationTarget
    storage: str  # exact storage-format body that would be written
    diff: str  # unified diff: current page → new body (or manual edit → last published)
    diff_kind: Literal["new_page", "page_update", "manual_edit", "none"]
    warnings: list[ValidationIssue]
    problems: list[ValidationIssue]  # blocking
    remote_version: int | None
    rendered_hash: str
    merge_request: MergeEvidence | None
    checked_at: datetime


class PublicationEvent(BaseModel):
    at: datetime
    actor: str
    action: str
    state: str | None
    revision: str | None


class PublicationJobSummary(BaseModel):
    id: str
    document_id: str
    document_path: str
    revision: str
    state: PublicationJobState
    action: PublicationAction | None
    proposal_id: str | None
    created_at: datetime
    updated_at: datetime
    attempts: int
    error_code: str | None
    error_message: str | None
    uncertain: bool
    page_id: str | None
    version_after: int | None
    published_at: datetime | None


class PublicationJobDetail(PublicationJobSummary):
    plan: PublicationPlan | None
    history: list[PublicationEvent]
    can_dry_run: bool
    can_publish: bool
    can_reconcile: bool
    publish_enabled: bool
    publish_disabled_reason: str | None


class PublicationJobList(BaseModel):
    items: list[PublicationJobSummary]
    total: int


class PublicationMappingInfo(BaseModel):
    page_id: str
    space_key: str
    parent_id: str
    page_title: str
    page_version: int
    published_revision: str
    last_published_at: datetime
    url: str | None


class PublisherInfo(BaseModel):
    mode: PublisherMode
    target_kind: TargetKind
    space_key: str | None
    parent_id: str | None
    message: str


class DocumentPublicationStatus(BaseModel):
    document_id: str
    current_revision: str | None
    state: DocumentPublicationState
    message: str
    publisher: PublisherInfo
    mapping: PublicationMappingInfo | None
    latest_job: PublicationJobSummary | None
    can_prepare: bool
