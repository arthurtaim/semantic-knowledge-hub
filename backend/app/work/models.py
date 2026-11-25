"""Typed request/response models of the Work Management API (M6, docs/API_CONTRACTS.md «v0.7»).

Requests are strict (`extra="forbid"`): a client cannot set the audit actor, versions, keys, `is_demo`, plan
revisions, roles or any server-owned field — such a body is rejected with 422, never silently ignored.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TITLE_MAX = 200
DESCRIPTION_MAX = 20_000
PROJECT_KEY_PATTERN = r"^[A-Z][A-Z0-9]{1,9}$"
CLIENT_REQUEST_ID_PATTERN = r"^[A-Za-z0-9._:-]{8,80}$"
MAX_DEPTH = 4
MAX_ESTIMATE_WORKDAYS = 1000
MAX_DURATION_WORKDAYS = 2000
PAGE_MAX = 500
PREVIEW_CHANGES_MAX = 100
PREVIEW_DEPENDENCIES_MAX = 20
MAX_TASKS_PER_PROJECT = 5000
MAX_DEPENDENCIES_PER_PROJECT = 20_000


class TaskStatus(StrEnum):
    """Workflow status (Kanban columns). Any transition between the four is allowed (free Kanban moves);
    «blocked» is COMPUTED from dependencies (`blocked_by`), «archived» is a separate state (`archived_at`)."""

    todo = "todo"
    in_progress = "in_progress"
    review = "review"
    done = "done"


class TaskPriority(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class ProjectStatus(StrEnum):
    active = "active"
    on_hold = "on_hold"
    completed = "completed"
    archived = "archived"


class ProjectRole(StrEnum):
    admin = "admin"
    member = "member"
    viewer = "viewer"


class ScheduleMode(StrEnum):
    """`only_this_task`: change only the requested tasks — any FS violation is a conflict.
    `shift_successors`: also push every reachable successor forward (durations kept, independent branches untouched).
    `resolve_violations`: no requested change; push forward every task that violates an FS constraint today."""

    only_this_task = "only_this_task"
    shift_successors = "shift_successors"
    resolve_violations = "resolve_violations"


TaskTitle = Annotated[str, Field(min_length=1, max_length=TITLE_MAX)]
Description = Annotated[str, Field(max_length=DESCRIPTION_MAX)]
EntityId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
ClientRequestId = Annotated[str, Field(pattern=CLIENT_REQUEST_ID_PATTERN)]
AssigneeId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._@-]+$")]


def _clean_text(value: str) -> str:
    # Control characters (except newline/tab in descriptions) are never stored.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- projects --------------------------------------------------------------------------------------------------
class ProjectCreate(_Request):
    key: Annotated[str, Field(pattern=PROJECT_KEY_PATTERN)]
    title: TaskTitle
    description: Description = ""
    status: ProjectStatus = ProjectStatus.active
    timezone: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    start_date: date | None = None
    target_date: date | None = None
    client_request_id: ClientRequestId | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        value = _clean_text(value).strip()
        if not value:
            raise ValueError("title must not be blank")
        return value

    @field_validator("description")
    @classmethod
    def _description(cls, value: str) -> str:
        return _clean_text(value)


class ProjectUpdate(_Request):
    """PATCH: only the fields present in the body change; `expected_version` is mandatory (409 `stale_project`)."""

    expected_version: Annotated[int, Field(ge=1)]
    title: TaskTitle | None = None
    description: Description | None = None
    status: ProjectStatus | None = None
    timezone: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    start_date: date | None = None
    target_date: date | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = _clean_text(value).strip()
        if not value:
            raise ValueError("title must not be blank")
        return value

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return None if value is None else _clean_text(value)

    @model_validator(mode="after")
    def _not_nullable(self) -> ProjectUpdate:
        for name in ("title", "description", "status", "timezone"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class ProjectStats(BaseModel):
    total: int
    by_status: dict[str, int]
    open: int
    blocked: int
    overdue: int
    milestones: int
    unscheduled: int
    next_milestone: MilestoneRef | None = None


class MilestoneRef(BaseModel):
    task_id: str
    key: str
    title: str
    date: date


class ProjectOut(BaseModel):
    id: str
    key: str
    title: str
    description: str
    status: ProjectStatus
    timezone: str
    calendar: str
    start_date: date | None
    target_date: date | None
    is_demo: bool
    version: int
    plan_revision: int
    created_by: str
    created_at: datetime
    updated_by: str
    updated_at: datetime
    archived_at: datetime | None
    stats: ProjectStats | None = None
    my_role: str  # local_operator | admin | member | viewer | read_only


class ProjectList(BaseModel):
    items: list[ProjectOut]
    total: int


class ProjectMemberOut(BaseModel):
    user_id: str
    display_name: str
    role: ProjectRole
    active: bool


class ProjectMembers(BaseModel):
    project_id: str
    mode: str
    # In local_operator mode there are NO team members: one server-defined operator; roles are not claimed.
    members: list[ProjectMemberOut]
    note: str


# --- tasks -----------------------------------------------------------------------------------------------------
class _TaskFields(_Request):
    @field_validator("title", check_fields=False)
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = _clean_text(value).strip()
        if not value:
            raise ValueError("title must not be blank")
        return value

    @field_validator("description", check_fields=False)
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return None if value is None else _clean_text(value)


class TaskCreate(_TaskFields):
    title: TaskTitle
    description: Description = ""
    parent_task_id: EntityId | None = None
    status: TaskStatus = TaskStatus.todo
    priority: TaskPriority = TaskPriority.medium
    assignee_id: AssigneeId | None = None
    estimate_workdays: Annotated[int, Field(ge=0, le=MAX_ESTIMATE_WORKDAYS)] | None = None
    # Schedule: both dates or none (unscheduled). `duration_workdays` may replace `end_exclusive`.
    start_date: date | None = None
    end_exclusive: date | None = None
    duration_workdays: Annotated[int, Field(ge=0, le=MAX_DURATION_WORKDAYS)] | None = None
    due_date: date | None = None
    is_milestone: bool = False
    date_locked: bool = False
    sort_order: Annotated[int, Field(ge=-(10**9), le=10**9)] | None = None
    expected_plan_revision: Annotated[int, Field(ge=1)] | None = None
    client_request_id: ClientRequestId | None = None


class TaskUpdate(_TaskFields):
    """PATCH: only fields present in the body change (an explicit null clears a nullable field);
    `expected_version` is mandatory → 409 `stale_task` with `details.current_version`."""

    expected_version: Annotated[int, Field(ge=1)]
    title: TaskTitle | None = None
    description: Description | None = None
    parent_task_id: EntityId | None = None
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    assignee_id: AssigneeId | None = None
    estimate_workdays: Annotated[int, Field(ge=0, le=MAX_ESTIMATE_WORKDAYS)] | None = None
    start_date: date | None = None
    end_exclusive: date | None = None
    duration_workdays: Annotated[int, Field(ge=0, le=MAX_DURATION_WORKDAYS)] | None = None
    due_date: date | None = None
    is_milestone: bool | None = None
    date_locked: bool | None = None
    sort_order: Annotated[int, Field(ge=-(10**9), le=10**9)] | None = None

    @model_validator(mode="after")
    def _not_nullable(self) -> TaskUpdate:
        for name in (
            "title",
            "description",
            "status",
            "priority",
            "is_milestone",
            "date_locked",
            "sort_order",
        ):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        if "duration_workdays" in self.model_fields_set and self.duration_workdays is None:
            raise ValueError("duration_workdays cannot be null (clear start_date and end_exclusive instead)")
        return self


class AssigneeRef(BaseModel):
    id: str
    display_name: str
    # operator: the server-defined local operator · fixture: a synthetic demo person (NOT an account, NOT a security
    # subject) · member: a project member of a real identity provider · unknown: an id no longer in the directory
    kind: Literal["operator", "fixture", "member", "unknown"]
    # The person's role in the synthetic demo team («Аналитик», «Разработчик», …); None when unknown. Descriptive
    # only: it grants nothing.
    role: str | None = None


class TaskOut(BaseModel):
    id: str
    project_id: str
    key: str
    number: int
    parent_task_id: str | None
    depth: int
    title: str
    description: str
    status: TaskStatus
    priority: TaskPriority
    assignee_id: str | None
    assignee: AssigneeRef | None
    reporter_id: str | None
    estimate_workdays: int | None
    start_date: date | None
    end_exclusive: date | None
    # Derived for display: the last OCCUPIED working day (inclusive) — show this, not `end_exclusive`.
    last_day: date | None
    duration_workdays: int | None
    due_date: date | None
    is_milestone: bool
    date_locked: bool
    scheduled: bool
    sort_order: int
    is_demo: bool
    version: int
    created_by: str
    created_at: datetime
    updated_by: str
    updated_at: datetime
    archived_at: datetime | None
    # Computed: unfinished FS predecessors; never a stored status.
    blocked_by: list[str]
    is_blocked: bool
    # due_date passed (project-local today) and not done
    overdue: bool
    # planned end passed and not done
    late: bool
    child_count: int
    # Active document links whose document THIS reader can see now (the reader's knowledge snapshot); null when the
    # knowledge source cannot be read right now — never a count of documents the reader cannot see (M6-12/M6-34).
    link_count: int | None
    # The canonical ids of those documents (the document filter of List / Board / Gantt uses them).
    document_ids: list[str] | None


class TaskPage(BaseModel):
    project_id: str
    plan_revision: int
    items: list[TaskOut]
    total: int
    limit: int
    offset: int
    today: date


class TaskArchiveResult(BaseModel):
    archived: list[TaskOut]
    removed_dependency_ids: list[str]
    plan_revision: int


class DependencyCreate(_Request):
    """The path task is one end; give exactly ONE of `predecessor_task_id` / `successor_task_id`."""

    predecessor_task_id: EntityId | None = None
    successor_task_id: EntityId | None = None
    kind: Literal["FS"] = "FS"
    lag_workdays: Annotated[int, Field(ge=0, le=0)] = 0  # P0: lag 0 only (see docs/WORK_MANAGEMENT.md)
    expected_plan_revision: Annotated[int, Field(ge=1)] | None = None

    @model_validator(mode="after")
    def _one_end(self) -> DependencyCreate:
        if (self.predecessor_task_id is None) == (self.successor_task_id is None):
            raise ValueError("exactly one of predecessor_task_id / successor_task_id is required")
        return self


class TaskBrief(BaseModel):
    id: str
    key: str
    title: str
    status: TaskStatus
    start_date: date | None
    end_exclusive: date | None
    is_milestone: bool


class DependencyOut(BaseModel):
    id: str
    project_id: str
    predecessor_id: str
    successor_id: str
    kind: Literal["FS"]
    lag_workdays: int
    created_by: str
    created_at: datetime
    # FS currently satisfied by the stored dates (None when one end is unscheduled)
    satisfied: bool | None


class TaskDependencies(BaseModel):
    task_id: str
    plan_revision: int
    predecessors: list[DependencyWithTask]
    successors: list[DependencyWithTask]


class DependencyWithTask(BaseModel):
    dependency: DependencyOut
    task: TaskBrief


class DependencyMutation(BaseModel):
    dependency: DependencyOut
    plan_revision: int


class DependencyRemoved(BaseModel):
    dependency_id: str
    plan_revision: int


# --- gantt / schedule ------------------------------------------------------------------------------------------
class CalendarInfo(BaseModel):
    id: str
    kind: Literal["mon_fri"] = "mon_fri"
    workdays: list[int]  # ISO weekday numbers (1 = Monday)
    holidays: list[date]  # P0: none (no invented holidays)
    timezone: str
    interval: Literal["[start_date, end_exclusive)"] = "[start_date, end_exclusive)"


class Violation(BaseModel):
    dependency_id: str
    predecessor_id: str
    successor_id: str
    earliest_start: date
    actual_start: date


class GanttFeatures(BaseModel):
    critical_path: bool = False  # CPM is P1: no critical path is returned rather than a fake one
    dependency_kinds: list[str] = Field(default_factory=lambda: ["FS"])
    lag: bool = False


class GanttOut(BaseModel):
    project_id: str
    project_key: str
    plan_revision: int
    snapshot_at: datetime
    today: date
    calendar: CalendarInfo
    tasks: list[TaskOut]
    dependencies: list[DependencyOut]
    unscheduled_task_ids: list[str]
    violations: list[Violation]
    range_start: date | None
    range_end_exclusive: date | None
    critical_path: list[str] | None = None
    features: GanttFeatures = Field(default_factory=GanttFeatures)


class TaskDateChange(_Request):
    """A requested drag/resize: the new interval (both dates, or `start_date` + `duration_workdays`)."""

    task_id: EntityId
    start_date: date
    end_exclusive: date | None = None
    duration_workdays: Annotated[int, Field(ge=0, le=MAX_DURATION_WORKDAYS)] | None = None

    @model_validator(mode="after")
    def _end(self) -> TaskDateChange:
        if (self.end_exclusive is None) == (self.duration_workdays is None):
            raise ValueError("give exactly one of end_exclusive / duration_workdays")
        return self


class DependencyAdd(_Request):
    predecessor_task_id: EntityId
    successor_task_id: EntityId
    kind: Literal["FS"] = "FS"
    lag_workdays: Annotated[int, Field(ge=0, le=0)] = 0


class SchedulePreviewRequest(_Request):
    mode: ScheduleMode = ScheduleMode.shift_successors
    changes: Annotated[list[TaskDateChange], Field(max_length=PREVIEW_CHANGES_MAX)] = Field(
        default_factory=list
    )
    add_dependencies: Annotated[list[DependencyAdd], Field(max_length=PREVIEW_DEPENDENCIES_MAX)] = Field(
        default_factory=list
    )
    base_plan_revision: Annotated[int, Field(ge=1)] | None = None

    @model_validator(mode="after")
    def _something(self) -> SchedulePreviewRequest:
        if self.mode == ScheduleMode.resolve_violations:
            if self.changes or self.add_dependencies:
                raise ValueError("resolve_violations takes no changes")
        elif not self.changes and not self.add_dependencies:
            raise ValueError("nothing to preview: give changes and/or add_dependencies")
        ids = [c.task_id for c in self.changes]
        if len(ids) != len(set(ids)):
            raise ValueError("a task may appear only once in changes")
        return self


class IntervalOut(BaseModel):
    start_date: date | None
    end_exclusive: date | None
    last_day: date | None
    duration_workdays: int | None


class ScheduleOperation(BaseModel):
    task_id: str
    key: str
    title: str
    change: Literal["requested", "shifted"]
    before: IntervalOut
    after: IntervalOut
    shift_workdays: int  # working days the start moved (positive = later)
    reason: str  # requested | fs_predecessor
    because_of: list[str]  # predecessor task ids that bound the new start
    version: int  # the task version this operation was computed from


class ScheduleConflict(BaseModel):
    # task_locked · locked_successor · successor_violation · requested_violates_predecessor · invalid_interval
    code: str
    task_id: str
    key: str
    related_task_ids: list[str]
    message: str


class ScheduleWarning(BaseModel):
    code: str  # due_date_exceeded
    task_id: str
    key: str
    due_date: date | None
    last_day: date | None
    message: str


class BlockedTask(BaseModel):
    task_id: str
    key: str
    reason: Literal["unscheduled", "predecessor_unscheduled"]
    related_task_ids: list[str]
    message: str


class SchedulePreview(BaseModel):
    preview_id: str
    project_id: str
    mode: ScheduleMode
    base_plan_revision: int
    calendar: str
    input_hash: str
    operations: list[ScheduleOperation]
    added_dependencies: list[DependencyAdd]
    conflicts: list[ScheduleConflict]
    warnings: list[ScheduleWarning]
    blocked_tasks: list[BlockedTask]
    unchanged: list[str]  # affected (checked) task ids that keep their dates, sorted by key
    can_apply: bool
    critical_path: list[str] | None = None  # P1: never a fake critical path
    created_at: datetime
    expires_at: datetime


class ScheduleApplyRequest(_Request):
    preview_id: EntityId
    expected_plan_revision: Annotated[int, Field(ge=1)]
    client_request_id: ClientRequestId
    accept_warnings: bool = False


class ScheduleApplyResult(BaseModel):
    preview_id: str
    project_id: str
    applied: bool
    plan_revision: int
    changed_tasks: list[TaskOut]
    added_dependencies: list[DependencyOut]
    correlation_id: str
    replayed: bool = False


# --- activity --------------------------------------------------------------------------------------------------
class ActivityEvent(BaseModel):
    seq: int
    id: str
    at: datetime
    actor_id: str
    actor_display: str
    operation: str
    entity_type: str
    entity_id: str
    project_id: str
    task_id: str | None
    task_key: str | None
    correlation_id: str | None
    changes: dict[str, Any]


class ActivityPage(BaseModel):
    items: list[ActivityEvent]
    next_before_seq: int | None


# --- task ↔ document links (Step 4) ----------------------------------------------------------------------------
class LinkRelation(StrEnum):
    """What a task does with a document. A task link is NOT a knowledge-graph relation: typed relations between
    documents are declared by people in YAML; a link lives in the work module and never writes a document."""

    implements = "implements"  # the task implements what the document specifies
    requires = "requires"  # the task needs the document (an input, a requirement)
    documents = "documents"  # the task writes / updates the document
    verifies = "verifies"  # the task checks what the document states
    blocks = "blocks"  # the task blocks the document (e.g. its approval waits for the task)


DocumentIdField = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")]


class TaskLinkCreate(_Request):
    """Link a task to a document of the knowledge base. The document must be visible to the reader NOW; the server
    records its canonical id and the revision it sees (`revision_at_link`) — the client never supplies them."""

    document_id: DocumentIdField
    relation: LinkRelation = LinkRelation.implements
    client_request_id: ClientRequestId | None = None


# current          — visible; the revision equals the one seen when linking (or acknowledged later)
# revision_changed — visible; the document changed after linking (a person should check the task)
# revision_unknown — visible; no revision was recorded at linking (e.g. imported data)
# unavailable      — the reader cannot see it now: deleted, renamed away or no access (indistinguishable on purpose)
# unverified       — the knowledge source cannot be read right now: nothing about the document is shown
LinkState = Literal["current", "revision_changed", "revision_unknown", "unavailable", "unverified"]


class LinkedDocumentRef(BaseModel):
    """The document as the reader's CURRENT knowledge snapshot shows it — never copied into the work database."""

    document_id: str
    title: str
    type: str
    status: str  # draft | in_review | approved | deprecated — as the document states it now
    version: str | None
    revision: str
    is_demo: bool
    app_path: str


class TaskLinkOut(BaseModel):
    id: str
    task_id: str
    relation: LinkRelation
    source_system: Literal["skh"]
    state: LinkState
    # Present only when the reader can see the document now; an unavailable link shows no id, title or revision.
    document: LinkedDocumentRef | None
    revision_at_link: str | None
    deprecated: bool  # the document is `deprecated` now (shown, never hidden)
    approved: bool  # the document is `approved` now (drafts and reviews are not authoritative)
    created_by: str
    created_at: datetime


class TaskLinks(BaseModel):
    task_id: str
    task_key: str
    knowledge_available: bool
    generation: str | None  # knowledge index generation the states were computed from
    items: list[TaskLinkOut]


class TaskLinkRemoved(BaseModel):
    link_id: str
    task_id: str


class DocumentTaskRef(BaseModel):
    """One ACTIVE task linked to a document (the document page's back-links), only from projects the reader can see
    (archived tasks keep their links as history but are not listed)."""

    link_id: str
    relation: LinkRelation
    state: LinkState
    revision_at_link: str | None
    task_id: str
    task_key: str
    title: str
    status: TaskStatus
    project_id: str
    project_key: str
    project_title: str
    app_path: str


class DocumentTasks(BaseModel):
    document_id: str
    revision: str
    items: list[DocumentTaskRef]
    total: int


class ProjectDocumentRef(BaseModel):
    """A document linked to tasks of a project (visible ones only) — the document filter of the work views."""

    document: LinkedDocumentRef
    task_count: int
    changed_count: int  # links whose document changed after linking


class ProjectDocuments(BaseModel):
    project_id: str
    knowledge_available: bool
    items: list[ProjectDocumentRef]


# --- capabilities ----------------------------------------------------------------------------------------------
class WorkIdentity(BaseModel):
    user_id: str
    display_name: str
    kind: Literal["local_operator", "member", "anonymous"]


class WorkLimits(BaseModel):
    max_depth: int = MAX_DEPTH
    title_max: int = TITLE_MAX
    description_max: int = DESCRIPTION_MAX
    page_max: int = PAGE_MAX
    preview_changes_max: int = PREVIEW_CHANGES_MAX
    preview_dependencies_max: int = PREVIEW_DEPENDENCIES_MAX
    max_tasks_per_project: int = MAX_TASKS_PER_PROJECT
    preview_ttl_seconds: int


class WorkFeatures(BaseModel):
    critical_path: bool = False
    comments: bool = False
    document_links: bool = False  # task ↔ document links (Step 4): on whenever the module is enabled
    ai_proposals: bool = False  # Step 5 turns it on together with the proposal API
    lag: bool = False


class WorkCapabilities(BaseModel):
    enabled: bool
    mode: Literal["local_operator", "read_only", "membership", "disabled"]
    label: str
    can_write: bool
    can_view_audit: bool
    read_only_reason: str | None
    # Always false until a real identity provider + ProjectMember RBAC are integrated and verified.
    team_ready: bool
    identity: WorkIdentity
    calendar: CalendarInfo
    statuses: list[str]
    priorities: list[str]
    project_statuses: list[str]
    schedule_modes: list[str]
    link_relations: list[str]
    limits: WorkLimits
    features: WorkFeatures


ProjectStats.model_rebuild()
TaskDependencies.model_rebuild()


# --- AI task-plan proposals (Step 5) ---------------------------------------------------------------------------
PLAN_TASKS_MAX = 30
PLAN_DEPENDENCIES_MAX = 60
PLAN_DOCUMENTS_MAX = 5
PLAN_REQUEST_MAX = 2000
PLAN_ESTIMATE_MAX = 60
LocalId = Annotated[str, Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")]


class WorkPlanCreate(_Request):
    """«AI план»: decompose documents of the knowledge base into a task PROPOSAL. Nothing is written to tasks. The
    documents must be visible to the reader; without any, the server picks approved documents matching the request."""

    project_id: EntityId
    request: Annotated[str, Field(min_length=3, max_length=PLAN_REQUEST_MAX)]
    document_ids: Annotated[list[DocumentIdField], Field(max_length=PLAN_DOCUMENTS_MAX)] = Field(
        default_factory=list
    )
    start_date: date | None = (
        None  # dates are computed by the server from this start, or the tasks stay unscheduled
    )
    parent_task_id: EntityId | None = None  # all top-level proposed tasks go under this task

    @field_validator("request")
    @classmethod
    def _request(cls, value: str) -> str:
        value = _clean_text(value).strip()
        if len(value) < 3:
            raise ValueError("request is too short")
        return value


class ProposalSourceRef(BaseModel):
    """A document a proposed task relies on. `quote` is kept only when the server found it VERBATIM in that
    document; `title`/`status`/`state` are read from the reader's current snapshot (null when not visible now)."""

    document_id: str | None  # null when the reader cannot see the document now (no id is revealed)
    revision: str | None
    quote: str | None
    verified: bool
    title: str | None = None
    status: str | None = None
    state: LinkState = "current"


class ProposalIssue(BaseModel):
    # assignee_ignored · dates_ignored · task_id_ignored · unknown_source · quote_not_verified · estimate_missing ·
    # estimate_clamped · priority_defaulted · duplicate_of_existing · duplicate_dependency · not_approved_source ·
    # predecessor_unscheduled · truncated
    code: str
    message: str
    local_id: str | None = None
    severity: Literal["info", "warning"] = "warning"


class ProposedTask(BaseModel):
    local_id: str
    title: str
    description: str
    priority: TaskPriority
    estimate_workdays: int | None  # null: no estimate → the task stays unscheduled (dates are never invented)
    is_milestone: bool
    parent_local_id: str | None
    assignee_id: str | None = None  # only ever set by a person while reviewing (the model cannot)
    sources: list[ProposalSourceRef]
    duplicate_of: str | None = None  # the key of an existing task with the same title
    # Computed by the server from `start_date` and the FS dependencies (Mon–Fri); null when unscheduled.
    start_date: date | None = None
    end_exclusive: date | None = None
    last_day: date | None = None
    included: bool = True


class ProposedDependency(BaseModel):
    predecessor: str
    successor: str
    kind: Literal["FS"] = "FS"


class WorkProposalOut(BaseModel):
    id: str
    project_id: str
    project_key: str
    kind: Literal["task_plan"] = "task_plan"
    schema_version: str
    status: Literal["suggested", "applied", "rejected"]
    # ready: may be applied · stale: the base changed (see stale_reasons) — regenerate, never applied silently
    state: Literal["ready", "stale", "applied", "rejected"]
    stale_reasons: list[
        str
    ]  # plan_changed · source_changed · source_unavailable · expired · knowledge_unavailable
    provider: str
    request: str
    goal: str
    start_date: date | None
    parent_task_id: str | None
    parent_task_key: str | None
    base_plan_revision: int
    current_plan_revision: int
    created_at: datetime
    expires_at: datetime
    decided_at: datetime | None
    tasks: list[ProposedTask]
    dependencies: list[ProposedDependency]
    sources: list[ProposalSourceRef]
    assumptions: list[str]
    issues: list[ProposalIssue]
    can_apply: bool
    applied_task_keys: list[str]


class ProposalTaskEdit(_Request):
    """A person's edit of ONE proposed task (only these fields; a proposal is never replaced by an arbitrary plan)."""

    local_id: LocalId
    include: bool = True
    title: TaskTitle | None = None
    description: Annotated[str, Field(max_length=DESCRIPTION_MAX)] | None = None
    priority: TaskPriority | None = None
    estimate_workdays: Annotated[int, Field(ge=0, le=PLAN_ESTIMATE_MAX)] | None = None
    assignee_id: AssigneeId | None = None  # chosen from the directory; validated like any assignment

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = _clean_text(value).strip()
        if not value:
            raise ValueError("title must not be blank")
        return value


class DependencyRef(_Request):
    predecessor: LocalId
    successor: LocalId


class WorkProposalEdits(_Request):
    """The reviewed version of a stored proposal: per-task edits, dependencies to DROP, the planned start. Tasks and
    dependencies can only be kept, edited or dropped — never added."""

    tasks: Annotated[list[ProposalTaskEdit], Field(max_length=PLAN_TASKS_MAX)] = Field(default_factory=list)
    excluded_dependencies: Annotated[list[DependencyRef], Field(max_length=PLAN_DEPENDENCIES_MAX)] = Field(
        default_factory=list
    )
    start_date: date | None = None  # when present (also null) it replaces the proposal's start

    @model_validator(mode="after")
    def _unique(self) -> WorkProposalEdits:
        ids = [t.local_id for t in self.tasks]
        if len(ids) != len(set(ids)):
            raise ValueError("a task may appear only once in tasks")
        return self


class WorkProposalApply(WorkProposalEdits):
    expected_plan_revision: Annotated[int, Field(ge=1)]
    client_request_id: ClientRequestId


class WorkProposalApplyResult(BaseModel):
    proposal_id: str
    project_id: str
    applied: bool
    plan_revision: int
    created_tasks: list[TaskOut]
    created_dependencies: int
    created_links: int
    replayed: bool = False
