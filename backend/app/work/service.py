"""WorkService (M6): every business invariant of projects, tasks, dependencies and scheduling, on the server.

Each mutating method is ONE write transaction (`WorkDatabase.write()`): server-derived actor, project gate, expected
row version (optimistic locking), idempotency where a retry could duplicate work, append-only audit, plan revision
bump — committed together or not at all. Reads use one consistent snapshot (`WorkDatabase.read()`).

`plan_revision` is the project's monotonic data revision: every task, dependency or schedule mutation increments
it, so List / Board / Gantt can show which state they display and a schedule preview is applied only to the exact
state it was computed from.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.authz import Action
from app.domain.models import UserContext
from app.errors import ApiError
from app.work import scheduler as sched
from app.work import store
from app.work.calendar import (
    CALENDAR_ID,
    MAX_YEAR,
    MIN_YEAR,
    WORKDAY_NUMBERS,
    add_workdays,
    canonical_interval,
    count_workdays,
    fs_earliest_start,
    in_supported_range,
    last_workday,
    next_workday,
)
from app.work.db import WorkDatabase
from app.work.directory import AssigneeDirectory
from app.work.links import DocumentScope, document_ref, is_approved, is_deprecated, link_state
from app.work.models import (
    CHANGE_CONTEXT_TASKS,
    CHANGE_TASKS_MAX,
    MAX_DEPENDENCIES_PER_PROJECT,
    MAX_DEPTH,
    MAX_TASKS_PER_PROJECT,
    ActivityEvent,
    ActivityPage,
    AssigneeRef,
    CalendarInfo,
    DependencyAdd,
    DependencyCreate,
    DependencyMutation,
    DependencyOut,
    DependencyRemoved,
    DependencyWithTask,
    DocumentTaskRef,
    DocumentTasks,
    GanttOut,
    LinkRelation,
    MilestoneRef,
    ProjectCreate,
    ProjectDocumentRef,
    ProjectDocuments,
    ProjectList,
    ProjectMemberOut,
    ProjectMembers,
    ProjectOut,
    ProjectRole,
    ProjectStats,
    ProjectStatus,
    ProjectUpdate,
    ScheduleApplyRequest,
    ScheduleApplyResult,
    ScheduleMode,
    SchedulePreview,
    SchedulePreviewRequest,
    TaskArchiveResult,
    TaskBrief,
    TaskCreate,
    TaskDependencies,
    TaskLinkCreate,
    TaskLinkOut,
    TaskLinkRemoved,
    TaskLinks,
    TaskOut,
    TaskPage,
    TaskPriority,
    TaskStatus,
    TaskUpdate,
    WorkCapabilities,
    WorkChangeApplyResult,
    WorkFeatures,
    WorkIdentity,
    WorkLimits,
    WorkProposalApplyResult,
)
from app.work.permissions import LABELS, WorkAccessGate, WorkAccessMode, WorkPrincipal

logger = logging.getLogger("skh.work")

# How long replay records (client_request_id) and applied schedule previews are kept (audit CODE-014). A client
# retries within seconds; a week is a generous window, and the audit keeps the history for good.
RETENTION_DAYS = 7
TASK_KEY_RE = re.compile(r"^([A-Z][A-Z0-9]{1,9})-(\d{1,9})$")
PROJECT_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
STATUS_ORDER = {s.value: i for i, s in enumerate(TaskStatus)}
PRIORITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
# A database row or a plain mapping with the same column names.
RowLike = sqlite3.Row | Mapping[str, Any]
TASK_SORTS = ("key", "title", "status", "priority", "start_date", "due_date", "updated_at", "sort_order")


# --- small helpers ---------------------------------------------------------------------------------------------
def _d(value: Any) -> date | None:
    return date.fromisoformat(value) if value else None


def _dt(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _iso(value: date | None) -> str | None:
    return value.isoformat() if value else None


def _hash(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _not_found(what: str = "Объект не найден.") -> ApiError:
    # Also for objects the principal may not see: a hidden object is indistinguishable from a missing one.
    return ApiError(404, "not_found", what)


def _invalid_dates(reason: str, message: str, **details: Any) -> ApiError:
    return ApiError(422, "invalid_date_range", message, {"reason": reason, **details})


def _invalid_dependency(reason: str, message: str, **details: Any) -> ApiError:
    return ApiError(422, "invalid_dependency", message, {"reason": reason, **details})


def _invalid_hierarchy(reason: str, message: str) -> ApiError:
    return ApiError(422, "invalid_hierarchy", message, {"reason": reason})


def _stale_schedule(reason: str, message: str, **details: Any) -> ApiError:
    return ApiError(409, "stale_schedule", message, {"reason": reason, **details})


def check_work_date(value: date | None, name: str) -> None:
    """A person's or a derived work date outside the supported range → 422 `invalid_date_range` naming the field."""
    if value is not None and not in_supported_range(value):
        raise _invalid_dates(
            "out_of_range", f"{name}: дата должна быть между {MIN_YEAR} и {MAX_YEAR} годом.", field=name
        )


_check_year = check_work_date


def resolve_interval(
    start: date, end: date | None, duration: int | None, milestone: bool
) -> tuple[date, date]:
    """Validate a requested schedule and return it canonically (same working days, unambiguous form)."""
    _check_year(start, "start_date")
    _check_year(end, "end_exclusive")
    if milestone:
        if duration not in (None, 0):
            raise _invalid_dates("milestone_duration", "У вехи нет длительности: duration_workdays = 0.")
        if end is not None and end != start:
            raise _invalid_dates(
                "milestone_point", "Веха — точка: end_exclusive должна совпадать с start_date."
            )
        return start, start
    if duration is not None:
        if duration < 1:
            raise _invalid_dates("duration_zero", "У задачи (не вехи) длительность не меньше 1 рабочего дня.")
        computed = (next_workday(start), add_workdays(start, duration))
        _check_year(computed[1], "end_exclusive")  # a derived end obeys the same bound as an explicit one
        if end is not None and canonical_interval(start, end) != computed:
            raise _invalid_dates(
                "duration_mismatch", "end_exclusive и duration_workdays противоречат друг другу (Пн–Пт)."
            )
        return computed
    if end is None:
        raise _invalid_dates("partial", "Нужны обе даты (start_date и end_exclusive) или длительность.")
    if end <= start:
        raise _invalid_dates(
            "end_before_start", "end_exclusive должна быть позже start_date (интервал [start, end))."
        )
    canonical = canonical_interval(start, end)
    if canonical is None:
        raise _invalid_dates("no_workdays", "В интервале нет ни одного рабочего дня (Пн–Пт).")
    return canonical


def _sched_task(row: RowLike, key: str) -> sched.SchedTask:
    return sched.SchedTask(
        id=row["id"],
        number=int(row["number"]),
        key=key,
        title=row["title"],
        start=_d(row["start_date"]),
        end=_d(row["end_exclusive"]),
        milestone=bool(row["is_milestone"]),
        locked=bool(row["date_locked"]),
        due=_d(row["due_date"]),
        version=int(row["version"]),
    )


def _sched_edge(row: RowLike) -> sched.SchedEdge:
    return sched.SchedEdge(
        id=row["id"], pred=row["predecessor_id"], succ=row["successor_id"], lag=int(row["lag_workdays"])
    )


@dataclass
class _Ctx:
    """Derived facts of one project inside one snapshot (hierarchy, dependencies, link counts, today)."""

    project: sqlite3.Row
    skeleton: dict[str, RowLike]
    deps: Sequence[RowLike]
    links: dict[str, list[str]]
    today: date
    members: frozenset[str] | None = None
    # The reader's knowledge snapshot (None: not known in this context — e.g. a scheduling computation that returns
    # no task to anyone). Document links are counted only against it.
    docs: DocumentScope | None = None
    preds: dict[str, list[RowLike]] = field(default_factory=dict)
    succs: dict[str, list[RowLike]] = field(default_factory=dict)
    children: dict[str, int] = field(default_factory=dict)
    # A per-task context (`WorkService._task_ctx`, B2) holds only the rows one task needs; its active child count is
    # given here, because the skeleton then does not hold the children. None: counted from the whole skeleton.
    child_counts: dict[str, int] | None = None

    def __post_init__(self) -> None:
        preds: dict[str, list[RowLike]] = defaultdict(list)
        succs: dict[str, list[RowLike]] = defaultdict(list)
        for dep in self.deps:
            preds[dep["successor_id"]].append(dep)
            succs[dep["predecessor_id"]].append(dep)
        self.preds, self.succs = dict(preds), dict(succs)
        if self.child_counts is not None:
            self.children = dict(self.child_counts)
            return
        children: dict[str, int] = defaultdict(int)
        for row in self.skeleton.values():
            if row["parent_task_id"] and row["archived_at"] is None:
                children[row["parent_task_id"]] += 1
        self.children = dict(children)

    def visible_documents(self, task_id: str) -> list[str] | None:
        """Canonical ids of the task's linked documents the reader can see now; None when that cannot be checked."""
        if self.docs is None or not self.docs.available:
            return None
        seen: list[str] = []
        for document_id in self.links.get(task_id, []):
            doc = self.docs.get(document_id)
            if doc is not None and doc.id not in seen:
                seen.append(doc.id)
        return seen

    def key(self, task_id: str) -> str:
        row = self.skeleton.get(task_id)
        return f"{self.project['key']}-{row['number']}" if row else task_id

    def number(self, task_id: str) -> int:
        row = self.skeleton.get(task_id)
        return int(row["number"]) if row else 0

    def depth(self, task_id: str) -> int:
        depth, current, seen = 1, self.skeleton.get(task_id), set()
        while current is not None and current["parent_task_id"] and current["id"] not in seen:
            seen.add(current["id"])
            depth += 1
            current = self.skeleton.get(current["parent_task_id"])
        return depth

    def ancestors(self, task_id: str) -> list[str]:
        chain: list[str] = []
        current = self.skeleton.get(task_id)
        while current is not None and current["parent_task_id"] and current["parent_task_id"] not in chain:
            chain.append(current["parent_task_id"])
            current = self.skeleton.get(current["parent_task_id"])
        return chain

    def blocked_by(self, task_id: str) -> list[str]:
        found = [
            d["predecessor_id"]
            for d in self.preds.get(task_id, [])
            if self.skeleton.get(d["predecessor_id"]) is not None
            and self.skeleton[d["predecessor_id"]]["status"] != TaskStatus.done.value
        ]
        return sorted(set(found), key=self.number)


@dataclass(frozen=True)
class PlanningContext:
    project_id: str
    project_key: str
    project_title: str
    plan_revision: int
    today: date
    existing: list[tuple[str, str]]  # (key, title) of active tasks
    anchor: tuple[str, str, int] | None  # (id, key, depth) of the parent the plan goes under


@dataclass(frozen=True)
class ProposalView:
    project_key: str
    plan_revision: int
    may_apply: bool
    parent_key: str | None


@dataclass(frozen=True)
class ChatTarget:
    """The project (and tasks) a chat work skill acts on, resolved in the reader's scope (M7)."""

    project_id: str
    project_key: str
    project_title: str
    plan_revision: int
    archived: bool
    task_keys: tuple[str, ...] = ()  # canonical keys of the chosen tasks, all in this project
    task_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class ChangeContext:
    """What «Предложить изменения задач» may show the model (M7), after the gate: ONE project's tasks — the named ones,
    or the active ones when none is named (bounded). Server-read values and versions; never another project's data."""

    project_id: str
    project_key: str
    project_title: str
    plan_revision: int
    tasks: tuple[dict[str, Any], ...]  # id, key, title, description, status, priority, due_date, version
    named: bool  # the tasks were named (explicitly or by key in the request)


@dataclass(frozen=True)
class ChangeView:
    """The current state a stored change-set is shown and checked against (after the `propose_work` gate)."""

    project_key: str
    plan_revision: int
    may_apply: bool
    tasks: dict[str, dict[str, Any]]  # task id → the current row (missing: not visible / gone)


@dataclass(frozen=True)
class TaskFieldChanges:
    """The re-validated fields of ONE task to write, with the version they were computed from."""

    task_id: str
    expected_version: int
    fields: dict[str, Any]
    operation_ids: tuple[str, ...]


TASK_KEY_IN_TEXT = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d{1,9})\b")


@dataclass(frozen=True)
class PlannedTask:
    """One task of a reviewed, re-validated AI plan, ready to be written (dates computed by the server)."""

    local_id: str
    title: str
    description: str
    priority: str
    estimate: int | None
    milestone: bool
    parent_local_id: str | None
    assignee_id: str | None
    start: date | None
    end: date | None
    sources: tuple[tuple[str, str], ...]  # (canonical document id, revision) — verified sources to link
    due: date | None = None  # a due date the person named (never moves the Gantt)
    locked: bool = False  # pinned to the dates the person named


@dataclass(frozen=True)
class PlanToApply:
    tasks: tuple[PlannedTask, ...]
    dependencies: tuple[tuple[str, str], ...]  # (predecessor local id, successor local id), FS
    anchor_id: str | None


class WorkService:
    def __init__(
        self,
        db: WorkDatabase | None,
        gate: WorkAccessGate,
        *,
        operator: UserContext,
        default_timezone: str = "Europe/Moscow",
        preview_ttl_seconds: int = 900,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._database = db
        self.gate = gate
        self.directory = AssigneeDirectory(operator)
        self.default_timezone = default_timezone
        self.preview_ttl_seconds = preview_ttl_seconds
        self.now: Callable[[], datetime] = now or (lambda: datetime.now(UTC))
        # Fault-injection seam for tests (M6-18): called inside the apply transaction after each written task.
        self._after_schedule_write: Callable[[str], None] | None = None
        # The same seam for applying an AI task plan (after each created task, inside the transaction).
        self._after_plan_write: Callable[[str], None] | None = None
        # M7: the same seam for applying a change-set (after each updated task, inside the transaction).
        self._after_change_write: Callable[[str], None] | None = None
        # Step 5: whether «AI план» can work at all here (the configured AIProvider supports work planning); set by
        # the container. Shown as `features.ai_proposals`; the server still checks the gate on every request.
        self.ai_planning = False

    # --- infrastructure ----------------------------------------------------------------------------------------
    @property
    def db(self) -> WorkDatabase:
        if self.gate.mode == WorkAccessMode.disabled or self._database is None:
            raise ApiError(
                503, "feature_unavailable", "Модуль задач отключён конфигурацией (TASK_SYSTEM=disabled)."
            )
        return self._database

    def _now_iso(self) -> str:
        return store.now_iso(self.now())

    def _today(self, timezone: str) -> date:
        try:
            zone = ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError):
            zone = ZoneInfo("UTC")
        return self.now().astimezone(zone).date()

    @staticmethod
    def valid_timezone(name: str) -> bool:
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            return False
        return True

    def _role(
        self, conn: sqlite3.Connection, principal: WorkPrincipal, project_id: str
    ) -> ProjectRole | None:
        if not self.gate.role_based():
            return None
        role = store.member_role(conn, project_id, principal.user.user_id)
        return ProjectRole(role) if role else None

    @staticmethod
    def _lookup_project(conn: sqlite3.Connection, ref: str) -> sqlite3.Row | None:
        if PROJECT_KEY_RE.match(ref):
            return store.get_project_by_key(conn, ref)
        return store.get_project(conn, ref)

    @staticmethod
    def _lookup_task(conn: sqlite3.Connection, ref: str) -> sqlite3.Row | None:
        match = TASK_KEY_RE.match(ref)
        if match:
            project = store.get_project_by_key(conn, match.group(1))
            return store.get_task_by_number(conn, project["id"], int(match.group(2))) if project else None
        return store.get_task(conn, ref)

    @classmethod
    def _task_id_of(cls, conn: sqlite3.Connection, ref: str) -> str:
        """A task named by key (PKY-1) or id → its stable id; an unknown ref is returned as is (the caller refuses
        it with its own error). Audit CODE-012: a parent may be named the way every path names a task."""
        row = cls._lookup_task(conn, ref)
        return str(row["id"]) if row is not None else ref

    def _project_for(
        self, conn: sqlite3.Connection, principal: WorkPrincipal, ref: str, action: Action
    ) -> tuple[sqlite3.Row, ProjectRole | None]:
        project = self._lookup_project(conn, ref)
        if project is None:
            raise _not_found("Проект не найден.")
        role = self._role(conn, principal, project["id"])
        if self.gate.role_based() and role is None:
            raise _not_found("Проект не найден.")  # not a member: the project is invisible, not «forbidden»
        self.gate.check(principal, action, role)
        return project, role

    def _task_for(
        self, conn: sqlite3.Connection, principal: WorkPrincipal, ref: str, action: Action
    ) -> tuple[sqlite3.Row, sqlite3.Row, ProjectRole | None]:
        task = self._lookup_task(conn, ref)
        if task is None:
            raise _not_found("Задача не найдена.")
        project = store.get_project(conn, task["project_id"])
        if project is None:
            raise _not_found("Задача не найдена.")
        role = self._role(conn, principal, project["id"])
        if self.gate.role_based() and role is None:
            raise _not_found("Задача не найдена.")
        self.gate.check(principal, action, role)
        return task, project, role

    def _check_global(self, principal: WorkPrincipal, action: Action) -> None:
        """Actions without a project (list, create project, capabilities): in membership mode any real identity the
        global policy admitted; otherwise the single operator (writes only when not read-only)."""
        if self.gate.role_based():
            if principal.user.is_demo:
                raise ApiError(
                    403, "forbidden", "Нужна настоящая идентичность пользователя.", {"action": action.value}
                )
            return
        self.gate.check(principal, action, None)

    @staticmethod
    def _require_open(project: sqlite3.Row) -> None:
        if project["status"] == ProjectStatus.archived.value:
            raise ApiError(
                409, "conflict", "Проект в архиве: задачи только для чтения.", {"reason": "project_archived"}
            )

    def _ctx(
        self, conn: sqlite3.Connection, project: sqlite3.Row, principal: WorkPrincipal | None = None
    ) -> _Ctx:
        return _Ctx(
            project=project,
            skeleton={r["id"]: r for r in store.task_skeleton(conn, project["id"])},
            deps=store.project_dependencies(conn, project["id"]),
            links=store.active_document_links(conn, project["id"]),
            today=self._today(project["timezone"]),
            members=self._members(conn, project),
            docs=principal.documents if principal is not None else None,
        )

    def _members(self, conn: sqlite3.Connection, project: sqlite3.Row) -> frozenset[str] | None:
        if not self.gate.role_based():
            return None
        return frozenset(r["user_id"] for r in store.list_members(conn, project["id"]) if r["active"])

    def _task_ctx(
        self,
        conn: sqlite3.Connection,
        project: sqlite3.Row,
        task_id: str,
        principal: WorkPrincipal | None = None,
    ) -> _Ctx:
        """The context of ONE task (B2, audit CODE-015): its ancestors, its active dependency neighbours, its own
        links and active child count — the same derived fields as `_ctx` for this task (and the neighbour facts a
        date check needs), read without the whole project. Not for hierarchy moves: they need the full context."""
        return _Ctx(
            project=project,
            skeleton={r["id"]: r for r in store.task_skeleton_around(conn, project["id"], task_id)},
            deps=store.task_active_dependencies(conn, project["id"], task_id),
            links=store.active_document_links(conn, project["id"], task_id),
            today=self._today(project["timezone"]),
            members=self._members(conn, project),
            docs=principal.documents if principal is not None else None,
            child_counts={task_id: store.count_active_children(conn, project["id"], task_id)},
        )

    def _project_stats(self, conn: sqlite3.Connection, project: sqlite3.Row) -> ProjectStats:
        """Project counters as SQL aggregates over the active tasks (B2, audit CODE-015) — the same numbers as
        counting the derived fields of every task, without building them."""
        counts = store.project_stats(conn, project["id"], self._today(project["timezone"]).isoformat())
        by_status = {s.value: counts["by_status"].get(s.value, 0) for s in TaskStatus}
        milestone = counts["next_milestone"]
        return ProjectStats(
            total=counts["total"],
            by_status=by_status,
            open=counts["total"] - by_status[TaskStatus.done.value],
            blocked=counts["blocked"],
            overdue=counts["overdue"],
            milestones=counts["milestones"],
            unscheduled=counts["unscheduled"],
            next_milestone=None
            if milestone is None
            else MilestoneRef(
                task_id=milestone["id"],
                key=f"{project['key']}-{milestone['number']}",
                title=milestone["title"],
                date=date.fromisoformat(milestone["start_date"]),
            ),
        )

    def _task_out(self, row: RowLike, ctx: _Ctx) -> TaskOut:
        start, end = _d(row["start_date"]), _d(row["end_exclusive"])
        milestone = bool(row["is_milestone"])
        last_day = last_workday(start, end) if start and end and not milestone else None
        duration = None if start is None or end is None else (0 if milestone else count_workdays(start, end))
        done = row["status"] == TaskStatus.done.value
        active = row["archived_at"] is None
        due = _d(row["due_date"])
        blocked = _blocked_by(row, ctx)
        point = start if milestone else last_day
        documents = ctx.visible_documents(row["id"])
        return TaskOut(
            id=row["id"],
            project_id=row["project_id"],
            key=f"{ctx.project['key']}-{row['number']}",
            number=int(row["number"]),
            parent_task_id=row["parent_task_id"],
            depth=ctx.depth(row["id"]),
            title=row["title"],
            description=row["description"],
            status=TaskStatus(row["status"]),
            priority=TaskPriority(row["priority"]),
            assignee_id=row["assignee_id"],
            assignee=self.directory.ref(row["assignee_id"], members=ctx.members),
            reporter_id=row["reporter_id"],
            estimate_workdays=row["estimate_workdays"],
            start_date=start,
            end_exclusive=end,
            last_day=last_day,
            duration_workdays=duration,
            due_date=due,
            is_milestone=milestone,
            date_locked=bool(row["date_locked"]),
            scheduled=start is not None,
            sort_order=int(row["sort_order"]),
            is_demo=bool(row["is_demo"]),
            version=int(row["version"]),
            created_by=row["created_by"],
            created_at=_dt(row["created_at"]),
            updated_by=row["updated_by"],
            updated_at=_dt(row["updated_at"]),
            archived_at=_dt(row["archived_at"]),
            blocked_by=blocked,
            is_blocked=bool(blocked) and not done,
            overdue=_overdue(row, ctx.today),
            late=active and not done and point is not None and point < ctx.today,
            child_count=ctx.children.get(row["id"], 0),
            link_count=None if documents is None else len(documents),
            document_ids=documents,
        )

    def _project_out(
        self,
        row: RowLike,
        principal: WorkPrincipal,
        role: ProjectRole | None,
        stats: ProjectStats | None,
    ) -> ProjectOut:
        return ProjectOut(
            id=row["id"],
            key=row["key"],
            title=row["title"],
            description=row["description"],
            status=ProjectStatus(row["status"]),
            timezone=row["timezone"],
            calendar=row["calendar"],
            start_date=_d(row["start_date"]),
            target_date=_d(row["target_date"]),
            is_demo=bool(row["is_demo"]),
            version=int(row["version"]),
            plan_revision=int(row["plan_revision"]),
            created_by=row["created_by"],
            created_at=_dt(row["created_at"]),
            updated_by=row["updated_by"],
            updated_at=_dt(row["updated_at"]),
            archived_at=_dt(row["archived_at"]),
            stats=stats,
            my_role=self.gate.my_role(principal, role),
        )

    def _audit(
        self,
        conn: sqlite3.Connection,
        principal: WorkPrincipal,
        *,
        operation: str,
        entity_type: str,
        entity_id: str,
        project_id: str,
        task_id: str | None = None,
        related_task_id: str | None = None,
        changes: Mapping[str, Any] | None = None,
        correlation_id: str | None = None,
        at: str | None = None,
    ) -> None:
        store.insert_audit(
            conn,
            at=at or self._now_iso(),
            actor_id=principal.user.user_id,
            operation=operation,
            entity_type=entity_type,
            entity_id=entity_id,
            project_id=project_id,
            task_id=task_id,
            related_task_id=related_task_id,
            correlation_id=correlation_id or principal.request_id,
            changes=changes or {},
        )

    @staticmethod
    def _replay(
        conn: sqlite3.Connection, scope: str, principal: WorkPrincipal, key: str | None, request_hash: str
    ) -> dict[str, Any] | None:
        if key is None:
            return None
        row = store.get_idempotent(conn, scope, principal.user.user_id, key)
        if row is None:
            return None
        if row["request_hash"] != request_hash:
            raise ApiError(
                409,
                "conflict",
                "client_request_id уже использован для другого запроса.",
                {"reason": "idempotency_key_reused"},
            )
        response: dict[str, Any] = json.loads(row["response_json"])
        return response

    def _remember(
        self,
        conn: sqlite3.Connection,
        scope: str,
        principal: WorkPrincipal,
        key: str | None,
        request_hash: str,
        response: Mapping[str, Any],
        status_code: int = 200,
    ) -> None:
        if key is None:
            return
        store.purge_retained(conn, store.now_iso(self.now() - timedelta(days=RETENTION_DAYS)))
        store.put_idempotent(
            conn,
            scope=scope,
            actor_id=principal.user.user_id,
            key=key,
            request_hash=request_hash,
            status_code=status_code,
            response=response,
            at=self._now_iso(),
        )

    def _check_assignee(self, conn: sqlite3.Connection, project_id: str, assignee_id: str | None) -> None:
        if assignee_id is None:
            return
        if self.gate.role_based():
            valid = store.member_role(conn, project_id, assignee_id) is not None
        else:
            valid = assignee_id in self.directory.local_ids()
        if not valid:
            raise ApiError(
                422,
                "invalid_assignee",
                "Исполнитель не найден среди доступных: в локальной демонстрации — оператор и демо-исполнители, "
                "в командном режиме — участники проекта.",
                {"assignee_id": assignee_id},
            )

    # --- capabilities ------------------------------------------------------------------------------------------
    def capabilities(self, principal: WorkPrincipal) -> WorkCapabilities:
        mode = self.gate.effective_mode(principal)
        can_write = mode in (
            WorkAccessMode.local_operator,
            WorkAccessMode.shared_login,
            WorkAccessMode.membership,
        ) and (mode == WorkAccessMode.membership or principal.user.is_demo)
        kind = "member" if mode == WorkAccessMode.membership else "local_operator"
        return WorkCapabilities(
            enabled=mode != WorkAccessMode.disabled,
            mode=mode.value,
            label=LABELS[mode],
            can_write=can_write,
            can_view_audit=can_write,
            read_only_reason=self.gate.reason(principal),
            team_ready=False,
            identity=WorkIdentity(
                user_id=principal.user.user_id,
                display_name=principal.user.display_name,
                kind=kind,
            ),
            calendar=self._calendar(self.default_timezone),
            statuses=[s.value for s in TaskStatus],
            priorities=[p.value for p in TaskPriority],
            project_statuses=[s.value for s in ProjectStatus],
            schedule_modes=[m.value for m in ScheduleMode],
            link_relations=[r.value for r in LinkRelation],
            limits=WorkLimits(preview_ttl_seconds=self.preview_ttl_seconds),
            features=WorkFeatures(document_links=True, ai_proposals=self.ai_planning),
        )

    @staticmethod
    def _calendar(timezone: str) -> CalendarInfo:
        return CalendarInfo(id=CALENDAR_ID, workdays=list(WORKDAY_NUMBERS), holidays=[], timezone=timezone)

    def assignees(self, principal: WorkPrincipal, project_ref: str | None) -> list[AssigneeRef]:
        if project_ref is None:
            self._check_global(principal, Action.view_projects)
            return [] if self.gate.role_based() else self.directory.local_assignees()
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.view_projects)
            if not self.gate.role_based():
                return self.directory.local_assignees()
            members = frozenset(r["user_id"] for r in store.list_members(conn, project["id"]) if r["active"])
            return [AssigneeRef(id=m, display_name=m, kind="member") for m in sorted(members)]

    # --- projects ----------------------------------------------------------------------------------------------
    def list_projects(
        self,
        principal: WorkPrincipal,
        *,
        include_archived: bool = False,
        statuses: frozenset[str] | None = None,
    ) -> ProjectList:
        self._check_global(principal, Action.view_projects)
        with self.db.read() as conn:
            ids = store.member_project_ids(conn, principal.user.user_id) if self.gate.role_based() else None
            rows = store.list_projects(
                conn, ids, include_archived or bool(statuses and "archived" in statuses)
            )
            if statuses:
                rows = [r for r in rows if r["status"] in statuses]
            items = []
            for row in rows:
                role = self._role(conn, principal, row["id"])
                items.append(self._project_out(row, principal, role, self._project_stats(conn, row)))
        return ProjectList(items=items, total=len(items))

    def get_project(self, principal: WorkPrincipal, ref: str) -> ProjectOut:
        with self.db.read() as conn:
            project, role = self._project_for(conn, principal, ref, Action.view_projects)
            return self._project_out(project, principal, role, self._project_stats(conn, project))

    def members(self, principal: WorkPrincipal, ref: str) -> ProjectMembers:
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, ref, Action.view_projects)
            if not self.gate.role_based():
                return ProjectMembers(
                    project_id=project["id"],
                    mode=self.gate.effective_mode(principal).value,
                    members=[],
                    note="Локальная демонстрация — один оператор: участников и ролей команды нет, пока не "
                    "подключена настоящая идентификация (SSO) и проверка ProjectMember.",
                )
            rows = store.list_members(conn, project["id"])
            return ProjectMembers(
                project_id=project["id"],
                mode=WorkAccessMode.membership.value,
                members=[
                    ProjectMemberOut(
                        user_id=r["user_id"],
                        display_name=r["user_id"],
                        role=ProjectRole(r["role"]),
                        active=bool(r["active"]),
                    )
                    for r in rows
                ],
                note="Права проверяются на сервере по роли участника проекта.",
            )

    def create_project(self, principal: WorkPrincipal, body: ProjectCreate) -> ProjectOut:
        self._check_global(principal, Action.manage_project)
        timezone = body.timezone or self.default_timezone
        if not self.valid_timezone(timezone):
            raise ApiError(
                422, "invalid_request", "Неизвестный часовой пояс (нужно имя IANA).", {"field": "timezone"}
            )
        _check_year(body.start_date, "start_date")
        _check_year(body.target_date, "target_date")
        if body.start_date and body.target_date and body.target_date < body.start_date:
            raise _invalid_dates("target_before_start", "Целевая дата проекта раньше даты начала.")
        request_hash = _hash(body.model_dump(mode="json", exclude={"client_request_id"}))
        with self.db.write() as conn:
            replay = self._replay(conn, "project_create", principal, body.client_request_id, request_hash)
            if replay is not None:
                return ProjectOut.model_validate(replay)
            if store.get_project_by_key(conn, body.key) is not None:
                raise ApiError(
                    409, "conflict", f"Ключ проекта {body.key} уже занят.", {"reason": "key_taken"}
                )
            at = self._now_iso()
            project_id = store.new_id()
            row = {
                "id": project_id,
                "key": body.key,
                "title": body.title,
                "description": body.description,
                "status": body.status.value,
                "timezone": timezone,
                "calendar": CALENDAR_ID,
                "start_date": _iso(body.start_date),
                "target_date": _iso(body.target_date),
                "archived_at": at if body.status == ProjectStatus.archived else None,
                "is_demo": 0,
                "created_by": principal.user.user_id,
                "created_at": at,
                "updated_by": principal.user.user_id,
                "updated_at": at,
            }
            try:
                store.insert_project(conn, row)
            except sqlite3.IntegrityError as exc:
                raise ApiError(
                    409, "conflict", f"Ключ проекта {body.key} уже занят.", {"reason": "key_taken"}
                ) from exc
            role = None
            if self.gate.role_based():
                store.put_member(
                    conn,
                    project_id,
                    principal.user.user_id,
                    ProjectRole.admin.value,
                    principal.user.user_id,
                    at,
                )
                role = ProjectRole.admin
            self._audit(
                conn,
                principal,
                operation="project_created",
                entity_type="project",
                entity_id=project_id,
                project_id=project_id,
                changes={
                    "key": body.key,
                    "title": body.title,
                    "status": body.status.value,
                    "timezone": timezone,
                },
                at=at,
            )
            created = store.get_project(conn, project_id)
            assert created is not None
            out = self._project_out(created, principal, role, self._project_stats(conn, created))
            self._remember(
                conn,
                "project_create",
                principal,
                body.client_request_id,
                request_hash,
                out.model_dump(mode="json"),
                201,
            )
            return out

    def update_project(self, principal: WorkPrincipal, ref: str, body: ProjectUpdate) -> ProjectOut:
        with self.db.write() as conn:
            project, role = self._project_for(conn, principal, ref, Action.manage_project)
            if int(project["version"]) != body.expected_version:
                raise ApiError(
                    409,
                    "stale_project",
                    "Проект уже изменён — обновите данные.",
                    {"current_version": int(project["version"])},
                )
            fields: dict[str, Any] = {}
            changes: dict[str, Any] = {}
            given = body.model_fields_set - {"expected_version"}
            for name in sorted(given):
                value = getattr(body, name)
                if name == "timezone" and not self.valid_timezone(value):
                    raise ApiError(
                        422,
                        "invalid_request",
                        "Неизвестный часовой пояс (нужно имя IANA).",
                        {"field": "timezone"},
                    )
                if name in ("start_date", "target_date"):
                    _check_year(value, name)
                    value = _iso(value)
                elif hasattr(value, "value"):
                    value = value.value
                if project[name] != value:
                    fields[name] = value
                    changes[name] = (
                        {"changed": True}
                        if name == "description"
                        else {"before": project[name], "after": value}
                    )
            start = _d(fields.get("start_date", project["start_date"]))
            target = _d(fields.get("target_date", project["target_date"]))
            if start and target and target < start:
                raise _invalid_dates("target_before_start", "Целевая дата проекта раньше даты начала.")
            if "status" in fields:
                fields["archived_at"] = (
                    self._now_iso() if fields["status"] == ProjectStatus.archived.value else None
                )
            if not fields:
                return self._project_out(project, principal, role, self._project_stats(conn, project))
            at = self._now_iso()
            if not store.update_project(
                conn, project["id"], body.expected_version, fields, principal.user.user_id, at
            ):
                raise ApiError(409, "stale_project", "Проект уже изменён — обновите данные.", {})
            if "timezone" in fields:
                store.bump_plan_revision(conn, project["id"])  # «today» and the calendar context changed
            self._audit(
                conn,
                principal,
                operation="project_updated",
                entity_type="project",
                entity_id=project["id"],
                project_id=project["id"],
                changes=changes,
                at=at,
            )
            updated = store.get_project(conn, project["id"])
            assert updated is not None
            return self._project_out(updated, principal, role, self._project_stats(conn, updated))

    # --- tasks -------------------------------------------------------------------------------------------------
    def list_tasks(
        self,
        principal: WorkPrincipal,
        project_ref: str,
        *,
        statuses: frozenset[str] | None = None,
        priorities: frozenset[str] | None = None,
        assignee: str | None = None,
        parent: str | None = None,
        q: str | None = None,
        milestone: bool | None = None,
        scheduled: bool | None = None,
        overdue: bool | None = None,
        blocked: bool | None = None,
        include_archived: bool = False,
        document: str | None = None,
        sort: str = "sort_order",
        order: str = "asc",
        limit: int = 200,
        offset: int = 0,
    ) -> TaskPage:
        if document is not None and (principal.documents is None or not principal.documents.available):
            raise _knowledge_unavailable("отфильтровать задачи по документу нельзя")
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.view_tasks)
            ctx = self._ctx(conn, project, principal)
            rows = store.project_tasks(
                conn,
                project["id"],
                include_archived=include_archived,
                statuses=statuses,
                priorities=priorities,
                assignee=assignee,
                parent=parent,
                milestone=milestone,
            )
            plan_revision = int(project["plan_revision"])
        # B2 (audit CODE-015): filter and sort the ROWS by the same derived rules as TaskOut, then build TaskOut only
        # for the page — not for every task of the project.
        if q:
            needle = q.casefold().strip()
            rows = [
                r
                for r in rows
                if needle in r["title"].casefold() or needle in f"{project['key']}-{r['number']}".casefold()
            ]
        if scheduled is not None:
            rows = [r for r in rows if (r["start_date"] is not None) == scheduled]
        if overdue is not None:
            rows = [r for r in rows if _overdue(r, ctx.today) == overdue]
        if blocked is not None:
            rows = [r for r in rows if _is_blocked(r, ctx) == blocked]
        if document is not None:
            # Only documents the reader can see count: a hidden id matches nothing (no leak).
            wanted = document.casefold()
            rows = [
                r for r in rows if any(d.casefold() == wanted for d in ctx.visible_documents(r["id"]) or [])
            ]
        rows.sort(key=_row_sort_key(sort), reverse=order == "desc")
        return TaskPage(
            project_id=project["id"],
            plan_revision=plan_revision,
            items=[self._task_out(r, ctx) for r in rows[offset : offset + limit]],
            total=len(rows),
            limit=limit,
            offset=offset,
            today=ctx.today,
        )

    def get_task(self, principal: WorkPrincipal, ref: str) -> TaskOut:
        with self.db.read() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.view_tasks)
            return self._task_out(task, self._task_ctx(conn, project, task["id"], principal))

    def _bump_and_read(self, conn: sqlite3.Connection, project_id: str) -> tuple[int, sqlite3.Row]:
        revision = store.bump_plan_revision(conn, project_id)
        project = store.get_project(conn, project_id)
        assert project is not None
        return revision, project

    def _validate_parent(
        self, conn: sqlite3.Connection, ctx: _Ctx, parent_id: str, *, moving: str | None = None
    ) -> None:
        parent = store.get_task(conn, parent_id)
        if parent is None or parent["project_id"] != ctx.project["id"]:
            raise _invalid_hierarchy(
                "parent_not_in_project", "Родительская задача не найдена в этом проекте."
            )
        if parent["archived_at"] is not None:
            raise _invalid_hierarchy("parent_archived", "Родительская задача в архиве.")
        if parent["is_milestone"]:
            raise _invalid_hierarchy("milestone_parent", "У вехи не может быть подзадач.")
        height = 1
        if moving is not None:
            if parent_id == moving:
                raise _invalid_hierarchy("self_parent", "Задача не может быть своей родительской.")
            subtree = store.descendants(conn, moving)
            if any(r["id"] == parent_id for r in subtree):
                raise _invalid_hierarchy(
                    "parent_cycle", "Нельзя сделать подзадачу родителем её предка (цикл)."
                )
            active = [r for r in subtree if r["archived_at"] is None]
            height = 1 + max((int(r["rel_depth"]) for r in active), default=0)
            # an FS dependency between the moved subtree and its new ancestors would be a hierarchy cycle
            ancestors = {parent_id, *ctx.ancestors(parent_id)}
            members = {moving, *(r["id"] for r in active)}
            for dep in ctx.deps:
                ends = {dep["predecessor_id"], dep["successor_id"]}
                if ends & members and ends & ancestors:
                    raise _invalid_hierarchy(
                        "dependency_with_ancestor", "Между задачей и её будущим предком есть зависимость FS."
                    )
        if ctx.depth(parent_id) + height > MAX_DEPTH:
            raise _invalid_hierarchy("too_deep", f"Допустимо не более {MAX_DEPTH} уровней вложенности.")

    def create_task(self, principal: WorkPrincipal, project_ref: str, body: TaskCreate) -> TaskOut:
        request_hash = _hash(body.model_dump(mode="json", exclude={"client_request_id"}))
        with self.db.write() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.create_task)
            scope = f"task_create:{project['id']}"
            replay = self._replay(conn, scope, principal, body.client_request_id, request_hash)
            if replay is not None:
                return TaskOut.model_validate(replay)
            self._require_open(project)
            if body.expected_plan_revision is not None and body.expected_plan_revision != int(
                project["plan_revision"]
            ):
                raise _stale_schedule(
                    "plan_revision",
                    "План проекта уже изменён — обновите данные.",
                    current=int(project["plan_revision"]),
                )
            if store.count_active_tasks(conn, project["id"]) >= MAX_TASKS_PER_PROJECT:
                raise ApiError(
                    409, "conflict", "Достигнут предел числа задач в проекте.", {"reason": "task_limit"}
                )
            parent_id = None if body.parent_task_id is None else self._task_id_of(conn, body.parent_task_id)
            if parent_id is not None:
                self._validate_parent(conn, self._ctx(conn, project, principal), parent_id)
            self._check_assignee(conn, project["id"], body.assignee_id)
            _check_year(body.due_date, "due_date")
            start = end = None
            if (
                body.start_date is not None
                or body.end_exclusive is not None
                or body.duration_workdays is not None
            ):
                if body.start_date is None:
                    raise _invalid_dates(
                        "partial", "P0 не поддерживает частично заданные даты: нужна start_date."
                    )
                start, end = resolve_interval(
                    body.start_date, body.end_exclusive, body.duration_workdays, body.is_milestone
                )
            if body.date_locked and start is None:
                raise _invalid_dates("lock_requires_dates", "Закрепить можно только запланированную задачу.")
            at = self._now_iso()
            number = store.allocate_task_number(conn, project["id"])
            task_id = store.new_id()
            row = {
                "id": task_id,
                "project_id": project["id"],
                "number": number,
                "parent_task_id": parent_id,
                "title": body.title,
                "description": body.description,
                "status": body.status.value,
                "priority": body.priority.value,
                "assignee_id": body.assignee_id,
                "reporter_id": principal.user.user_id,
                "estimate_workdays": body.estimate_workdays,
                "start_date": _iso(start),
                "end_exclusive": _iso(end),
                "due_date": _iso(body.due_date),
                "is_milestone": int(body.is_milestone),
                "date_locked": int(body.date_locked),
                "sort_order": body.sort_order if body.sort_order is not None else number * 1024,
                "is_demo": 0,
                "created_by": principal.user.user_id,
                "created_at": at,
                "updated_by": principal.user.user_id,
                "updated_at": at,
            }
            store.insert_task(conn, row)
            revision, project = self._bump_and_read(conn, project["id"])
            self._audit(
                conn,
                principal,
                operation="task_created",
                entity_type="task",
                entity_id=task_id,
                project_id=project["id"],
                task_id=task_id,
                changes=_created_changes(row),
                at=at,
            )
            created = store.get_task(conn, task_id)
            assert created is not None
            out = self._task_out(created, self._task_ctx(conn, project, task_id, principal))
            self._remember(
                conn, scope, principal, body.client_request_id, request_hash, out.model_dump(mode="json"), 201
            )
            logger.info(
                "work task created project=%s number=%s plan_revision=%s", project["key"], number, revision
            )
            return out

    def update_task(self, principal: WorkPrincipal, ref: str, body: TaskUpdate) -> TaskOut:
        with self.db.write() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.edit_task)
            if int(task["version"]) != body.expected_version:
                raise ApiError(
                    409,
                    "stale_task",
                    "Задача уже изменена — обновите данные.",
                    {"current_version": int(task["version"])},
                )
            self._require_open(project)
            if task["archived_at"] is not None:
                raise ApiError(
                    409, "conflict", "Задача в архиве — сначала восстановите её.", {"reason": "task_archived"}
                )
            given = body.model_fields_set - {"expected_version"}
            # A hierarchy move checks the whole tree; any other edit needs only this task's neighbourhood (B2).
            ctx = (
                self._ctx(conn, project, principal)
                if "parent_task_id" in given
                else self._task_ctx(conn, project, task["id"], principal)
            )
            fields: dict[str, Any] = {}

            for name in ("title", "description", "status", "priority", "estimate_workdays", "sort_order"):
                if name in given:
                    value = getattr(body, name)
                    fields[name] = value.value if hasattr(value, "value") else value
            if "assignee_id" in given:
                self._check_assignee(conn, project["id"], body.assignee_id)
                fields["assignee_id"] = body.assignee_id
            if "due_date" in given:
                _check_year(body.due_date, "due_date")
                fields["due_date"] = _iso(body.due_date)
            if "parent_task_id" in given:
                new_parent = (
                    None if body.parent_task_id is None else self._task_id_of(conn, body.parent_task_id)
                )
                if new_parent != task["parent_task_id"]:
                    if new_parent is not None:
                        self._validate_parent(conn, ctx, new_parent, moving=task["id"])
                    fields["parent_task_id"] = new_parent

            was_milestone = bool(task["is_milestone"])
            milestone = (
                body.is_milestone
                if "is_milestone" in given and body.is_milestone is not None
                else was_milestone
            )
            if milestone and not was_milestone and ctx.children.get(task["id"]):
                raise ApiError(
                    409, "conflict", "У вехи не может быть подзадач.", {"reason": "milestone_has_children"}
                )
            if milestone != was_milestone:
                fields["is_milestone"] = int(milestone)
            new_start, new_end = self._merge_schedule(task, body, given, milestone)
            cur_start, cur_end = _d(task["start_date"]), _d(task["end_exclusive"])
            dates_changed = (new_start, new_end) != (cur_start, cur_end)
            if dates_changed:
                fields["start_date"], fields["end_exclusive"] = _iso(new_start), _iso(new_end)
            locked = (
                body.date_locked
                if "date_locked" in given and body.date_locked is not None
                else bool(task["date_locked"])
            )
            if locked != bool(task["date_locked"]):
                fields["date_locked"] = int(locked)
            if dates_changed and bool(task["date_locked"]) and locked:
                raise ApiError(
                    422,
                    "schedule_conflict",
                    "Даты задачи закреплены (date_locked) — снимите закрепление, чтобы их изменить.",
                    {"reason": "task_locked"},
                )
            if locked and new_start is None:
                raise _invalid_dates("lock_requires_dates", "Закрепить можно только запланированную задачу.")
            if (dates_changed or milestone != was_milestone) and new_start is not None:
                self._check_fs_after_edit(ctx, task, new_start, new_end, milestone)

            # keep only real changes
            fields = {k: v for k, v in fields.items() if task[k] != v}
            if not fields:
                return self._task_out(task, ctx)
            at = self._now_iso()
            if not store.update_task(
                conn, task["id"], body.expected_version, fields, principal.user.user_id, at
            ):
                raise ApiError(409, "stale_task", "Задача уже изменена — обновите данные.", {})
            _, project = self._bump_and_read(conn, project["id"])
            self._audit(
                conn,
                principal,
                operation="task_updated",
                entity_type="task",
                entity_id=task["id"],
                project_id=project["id"],
                task_id=task["id"],
                changes=_diff(task, fields),
                at=at,
            )
            updated = store.get_task(conn, task["id"])
            assert updated is not None
            return self._task_out(updated, self._task_ctx(conn, project, task["id"], principal))

    @staticmethod
    def _merge_schedule(
        task: RowLike, body: TaskUpdate, given: set[str], milestone: bool
    ) -> tuple[date | None, date | None]:
        cur_start, cur_end = _d(task["start_date"]), _d(task["end_exclusive"])
        was_milestone = bool(task["is_milestone"])
        date_fields = given & {"start_date", "end_exclusive", "duration_workdays"}
        if not date_fields and milestone == was_milestone:
            return cur_start, cur_end
        if "start_date" in given and body.start_date is None:
            if ("end_exclusive" in given and body.end_exclusive is not None) or "duration_workdays" in given:
                raise _invalid_dates("partial", "P0 не поддерживает частично заданные даты.")
            return None, None  # unschedule
        if "end_exclusive" in given and body.end_exclusive is None:
            raise _invalid_dates(
                "partial", "Чтобы снять даты, передайте start_date = null и end_exclusive = null."
            )
        start = body.start_date if "start_date" in given else cur_start
        end = body.end_exclusive if "end_exclusive" in given else None
        duration = body.duration_workdays if "duration_workdays" in given else None
        if start is None:
            if date_fields:
                raise _invalid_dates(
                    "partial", "P0 не поддерживает частично заданные даты: нужна start_date."
                )
            return None, None  # a milestone flag toggled on an unscheduled task
        if end is None and duration is None:
            if milestone:
                end = start
            elif cur_start is not None and cur_end is not None and not was_milestone:
                duration = count_workdays(cur_start, cur_end)  # a move keeps the working-day duration
            else:
                raise _invalid_dates(
                    "duration_required",
                    "Укажите end_exclusive или duration_workdays (у вехи длительности нет).",
                )
        return resolve_interval(start, end, duration, milestone)

    def _check_fs_after_edit(
        self, ctx: _Ctx, task: RowLike, start: date, end: date | None, milestone: bool
    ) -> None:
        """A direct edit may not create an FS violation; the schedule preview is the way to move dependants."""
        edited = dict(task)
        edited.update({"start_date": _iso(start), "end_exclusive": _iso(end), "is_milestone": int(milestone)})
        neighbour_ids = {d["predecessor_id"] for d in ctx.preds.get(task["id"], [])} | {
            d["successor_id"] for d in ctx.succs.get(task["id"], [])
        }
        incident = [*ctx.preds.get(task["id"], []), *ctx.succs.get(task["id"], [])]
        if not incident:
            return
        before = {task["id"]: _sched_task(task, ctx.key(task["id"]))}
        for nid in neighbour_ids:
            before[nid] = _sched_task(_full(ctx, nid), ctx.key(nid))
        after = dict(before)
        after[task["id"]] = _sched_task(edited, ctx.key(task["id"]))
        edges = [_sched_edge(d) for d in incident]
        old = {v.dependency_id for v in sched.violations(before, edges)}
        new = [v for v in sched.violations(after, edges) if v.dependency_id not in old]
        if new:
            raise ApiError(
                422,
                "schedule_conflict",
                "Новые даты нарушают зависимость FS. Используйте предпросмотр расписания «сдвинуть зависимые».",
                {
                    "reason": "fs_violation",
                    "violations": [v.model_dump(mode="json") for v in new],
                    "hint": "POST /api/projects/{project_id}/schedule/preview",
                },
            )

    def archive_task(
        self, principal: WorkPrincipal, ref: str, expected_version: int, cascade: bool
    ) -> TaskArchiveResult:
        with self.db.write() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.edit_task)
            if int(task["version"]) != expected_version:
                raise ApiError(
                    409,
                    "stale_task",
                    "Задача уже изменена — обновите данные.",
                    {"current_version": int(task["version"])},
                )
            self._require_open(project)
            if task["archived_at"] is not None:
                raise ApiError(409, "conflict", "Задача уже в архиве.", {"reason": "task_archived"})
            active_children = [r for r in store.descendants(conn, task["id"]) if r["archived_at"] is None]
            if active_children and not cascade:
                raise ApiError(
                    409,
                    "conflict",
                    "У задачи есть подзадачи: подтвердите архивирование вместе с ними (cascade=true).",
                    {"reason": "has_children", "children": len(active_children)},
                )
            at = self._now_iso()
            targets = [(task["id"], int(task["version"]))] + [
                (r["id"], int(r["version"])) for r in active_children
            ]
            removed: list[str] = []
            archived_ids = {t for t, _ in targets}
            for dep in store.project_dependencies(conn, project["id"]):
                if dep["predecessor_id"] in archived_ids or dep["successor_id"] in archived_ids:
                    store.delete_dependency(conn, dep["id"])
                    removed.append(dep["id"])
                    self._audit(
                        conn,
                        principal,
                        operation="dependency_removed",
                        entity_type="dependency",
                        entity_id=dep["id"],
                        project_id=project["id"],
                        task_id=dep["successor_id"],
                        related_task_id=dep["predecessor_id"],
                        changes={
                            "reason": "task_archived",
                            "predecessor_id": dep["predecessor_id"],
                            "successor_id": dep["successor_id"],
                        },
                        at=at,
                    )
            for task_id, version in targets:
                if not store.update_task(
                    conn,
                    task_id,
                    version,
                    {"archived_at": at, "archived_by": principal.user.user_id},
                    principal.user.user_id,
                    at,
                ):
                    raise ApiError(
                        409, "stale_task", "Задача уже изменена — обновите данные.", {"task_id": task_id}
                    )
                self._audit(
                    conn,
                    principal,
                    operation="task_archived",
                    entity_type="task",
                    entity_id=task_id,
                    project_id=project["id"],
                    task_id=task_id,
                    changes={"cascade_root": task["id"]} if task_id != task["id"] else {},
                    at=at,
                )
            revision, project = self._bump_and_read(conn, project["id"])
            ctx = self._ctx(conn, project, principal)
            archived = [self._task_out(_must(store.get_task(conn, t)), ctx) for t, _ in targets]
            return TaskArchiveResult(
                archived=archived, removed_dependency_ids=removed, plan_revision=revision
            )

    @staticmethod
    def _check_restore_parent(
        conn: sqlite3.Connection, project: RowLike, parent_id: str, height: int
    ) -> None:
        """The hierarchy invariants of create/move, re-checked for a restore (audit CODE-002, CODE-003).

        While a task sat in the archive its parent stayed editable: it may have been archived, turned into a
        milestone or moved deeper. A restore that would break «at most MAX_DEPTH levels» or «a milestone has no
        subtasks» is refused as a conflict before anything is written; the person fixes the parent and retries.
        """
        parent = store.get_task(conn, parent_id)
        if parent is None or parent["project_id"] != project["id"]:
            raise ApiError(
                409,
                "conflict",
                "Родительской задачи нет в этом проекте — восстановить задачу на прежнее место нельзя.",
                {"reason": "parent_not_in_project"},
            )
        if parent["archived_at"] is not None:
            raise ApiError(
                409,
                "conflict",
                "Родительская задача в архиве — восстановите сначала её.",
                {"reason": "parent_archived"},
            )
        if parent["is_milestone"]:
            raise ApiError(
                409,
                "conflict",
                "Родительская задача стала вехой, а у вехи не может быть подзадач. Снимите у неё признак вехи "
                "и повторите восстановление.",
                {"reason": "milestone_parent", "parent_task_id": parent_id},
            )
        parent_depth, seen = 1, {parent["id"]}
        current: sqlite3.Row | None = parent
        while current is not None and current["parent_task_id"] and current["parent_task_id"] not in seen:
            seen.add(current["parent_task_id"])
            parent_depth += 1
            current = store.get_task(conn, current["parent_task_id"])
        if parent_depth + height > MAX_DEPTH:
            raise ApiError(
                409,
                "conflict",
                f"После восстановления вложенность превысит {MAX_DEPTH} уровня: родительскую задачу перенесли "
                "глубже. Перенесите её выше и повторите восстановление.",
                {"reason": "too_deep", "max_depth": MAX_DEPTH, "depth": parent_depth + height},
            )

    def restore_task(self, principal: WorkPrincipal, ref: str, expected_version: int) -> TaskOut:
        with self.db.write() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.edit_task)
            if int(task["version"]) != expected_version:
                raise ApiError(
                    409,
                    "stale_task",
                    "Задача уже изменена — обновите данные.",
                    {"current_version": int(task["version"])},
                )
            self._require_open(project)
            if task["archived_at"] is None:
                raise ApiError(409, "conflict", "Задача не в архиве.", {"reason": "task_active"})
            # Restore the subtree archived by the same operation (an «undo» of a cascade), nothing else: a descendant
            # returns only together with its parent, so nothing comes back under a task that stays archived.
            returning = {task["id"]}
            same_op: list[sqlite3.Row] = []
            for row in store.descendants(conn, task["id"]):  # nearest first
                if row["archived_at"] == task["archived_at"] and row["parent_task_id"] in returning:
                    returning.add(row["id"])
                    same_op.append(row)
            if task["parent_task_id"]:
                height = 1 + max((int(r["rel_depth"]) for r in same_op), default=0)
                self._check_restore_parent(conn, project, task["parent_task_id"], height)
            if store.count_active_tasks(conn, project["id"]) + 1 + len(same_op) > MAX_TASKS_PER_PROJECT:
                raise ApiError(
                    409, "conflict", "Достигнут предел числа задач в проекте.", {"reason": "task_limit"}
                )
            at = self._now_iso()
            for row in [task, *same_op]:
                if not store.update_task(
                    conn,
                    row["id"],
                    int(row["version"]),
                    {"archived_at": None, "archived_by": None},
                    principal.user.user_id,
                    at,
                ):
                    raise ApiError(
                        409, "stale_task", "Задача уже изменена — обновите данные.", {"task_id": row["id"]}
                    )
                self._audit(
                    conn,
                    principal,
                    operation="task_restored",
                    entity_type="task",
                    entity_id=row["id"],
                    project_id=project["id"],
                    task_id=row["id"],
                    changes={"note": "dependencies removed at archiving are not restored"},
                    at=at,
                )
            _, project = self._bump_and_read(conn, project["id"])
            restored = store.get_task(conn, task["id"])
            assert restored is not None
            return self._task_out(restored, self._ctx(conn, project, principal))

    # --- dependencies ------------------------------------------------------------------------------------------
    def _dependency_out(self, row: RowLike, ctx: _Ctx, tasks: Mapping[str, RowLike]) -> DependencyOut:
        pred, succ = tasks.get(row["predecessor_id"]), tasks.get(row["successor_id"])
        satisfied: bool | None = None
        pred_end = _d(pred["end_exclusive"]) if pred is not None else None
        succ_start = _d(succ["start_date"]) if succ is not None else None
        if pred_end is not None and succ_start is not None:
            satisfied = succ_start >= fs_earliest_start(pred_end, int(row["lag_workdays"]))
        return DependencyOut(
            id=row["id"],
            project_id=row["project_id"],
            predecessor_id=row["predecessor_id"],
            successor_id=row["successor_id"],
            kind="FS",
            lag_workdays=int(row["lag_workdays"]),
            created_by=row["created_by"],
            created_at=_dt(row["created_at"]),
            satisfied=satisfied,
        )

    def dependencies(self, principal: WorkPrincipal, ref: str) -> TaskDependencies:
        with self.db.read() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.view_tasks)
            ctx = self._ctx(conn, project, principal)
            rows = {r["id"]: r for r in store.project_tasks(conn, project["id"], include_archived=True)}
            preds: list[DependencyWithTask] = []
            succs: list[DependencyWithTask] = []
            for dep in store.task_dependencies(conn, task["id"]):
                other_id = dep["predecessor_id"] if dep["successor_id"] == task["id"] else dep["successor_id"]
                other = rows.get(other_id)
                if other is None:
                    continue
                item = DependencyWithTask(
                    dependency=self._dependency_out(dep, ctx, rows),
                    task=TaskBrief(
                        id=other["id"],
                        key=ctx.key(other["id"]),
                        title=other["title"],
                        status=TaskStatus(other["status"]),
                        start_date=_d(other["start_date"]),
                        end_exclusive=_d(other["end_exclusive"]),
                        is_milestone=bool(other["is_milestone"]),
                    ),
                )
                (preds if dep["successor_id"] == task["id"] else succs).append(item)
            preds.sort(key=lambda i: ctx.number(i.task.id))
            succs.sort(key=lambda i: ctx.number(i.task.id))
            return TaskDependencies(
                task_id=task["id"],
                plan_revision=int(project["plan_revision"]),
                predecessors=preds,
                successors=succs,
            )

    def _validate_new_edge(
        self,
        conn: sqlite3.Connection,
        project: RowLike,
        ctx: _Ctx,
        pred_id: str,
        succ_id: str,
        existing: Iterable[sched.SchedEdge],
    ) -> tuple[sqlite3.Row, sqlite3.Row]:
        pred = self._lookup_task(conn, pred_id)
        succ = self._lookup_task(conn, succ_id)
        for row in (pred, succ):
            # Never reveal whether an id exists in another project: one answer for «missing» and «elsewhere».
            if row is None or row["project_id"] != project["id"]:
                raise _invalid_dependency(
                    "not_in_project", "Обе задачи зависимости должны быть в этом проекте."
                )
        assert pred is not None and succ is not None
        if pred["id"] == succ["id"]:
            raise _invalid_dependency("self", "Задача не может зависеть от самой себя.")
        if pred["archived_at"] is not None or succ["archived_at"] is not None:
            raise _invalid_dependency("archived", "Задача зависимости в архиве.")
        edges = list(existing)
        if any(e.pred == pred["id"] and e.succ == succ["id"] for e in edges):
            raise _invalid_dependency("duplicate", "Такая зависимость уже есть.")
        if pred["id"] in ctx.ancestors(succ["id"]) or succ["id"] in ctx.ancestors(pred["id"]):
            raise _invalid_dependency(
                "hierarchy",
                "Зависимость между задачей и её родителем/подзадачей не допускается (иерархия уже их связывает).",
            )
        cycle = sched.cycle_if_added(edges, pred["id"], succ["id"])
        if cycle:
            raise ApiError(
                422,
                "dependency_cycle",
                "Зависимость создаёт цикл: " + " → ".join(ctx.key(t) for t in cycle) + ".",
                {"cycle": cycle, "cycle_keys": [ctx.key(t) for t in cycle]},
            )
        return pred, succ

    def add_dependency(
        self, principal: WorkPrincipal, ref: str, body: DependencyCreate
    ) -> DependencyMutation:
        with self.db.write() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.schedule_task)
            self._require_open(project)
            if body.expected_plan_revision is not None and body.expected_plan_revision != int(
                project["plan_revision"]
            ):
                raise _stale_schedule(
                    "plan_revision",
                    "План проекта уже изменён — обновите данные.",
                    current=int(project["plan_revision"]),
                )
            if store.count_dependencies(conn, project["id"]) >= MAX_DEPENDENCIES_PER_PROJECT:
                raise ApiError(
                    409,
                    "conflict",
                    "Достигнут предел числа зависимостей в проекте.",
                    {"reason": "dependency_limit"},
                )
            ctx = self._ctx(conn, project, principal)
            pred_id = body.predecessor_task_id or task["id"]
            succ_id = body.successor_task_id or task["id"]
            pred, succ = self._validate_new_edge(
                conn, project, ctx, pred_id, succ_id, [_sched_edge(d) for d in ctx.deps]
            )
            pred_end, succ_start = _d(pred["end_exclusive"]), _d(succ["start_date"])
            if pred_end is not None and succ_start is not None:
                earliest = fs_earliest_start(pred_end, body.lag_workdays)
                if succ_start < earliest:
                    raise ApiError(
                        422,
                        "schedule_conflict",
                        f"{ctx.key(succ['id'])} начинается раньше окончания {ctx.key(pred['id'])}: добавьте зависимость "
                        "через предпросмотр расписания («сдвинуть зависимые»).",
                        {
                            "reason": "dependency_violated",
                            "earliest_start": earliest.isoformat(),
                            "hint": "POST /api/projects/{project_id}/schedule/preview with add_dependencies",
                        },
                    )
            at = self._now_iso()
            dep_id = store.new_id()
            store.insert_dependency(
                conn,
                {
                    "id": dep_id,
                    "project_id": project["id"],
                    "predecessor_id": pred["id"],
                    "successor_id": succ["id"],
                    "kind": "FS",
                    "lag_workdays": body.lag_workdays,
                    "created_by": principal.user.user_id,
                    "created_at": at,
                },
            )
            revision, project = self._bump_and_read(conn, project["id"])
            self._audit(
                conn,
                principal,
                operation="dependency_added",
                entity_type="dependency",
                entity_id=dep_id,
                project_id=project["id"],
                task_id=succ["id"],
                related_task_id=pred["id"],
                changes={
                    "predecessor_id": pred["id"],
                    "successor_id": succ["id"],
                    "predecessor_key": ctx.key(pred["id"]),
                    "successor_key": ctx.key(succ["id"]),
                    "kind": "FS",
                    "lag_workdays": body.lag_workdays,
                },
                at=at,
            )
            dep = store.get_dependency(conn, dep_id)
            assert dep is not None
            rows = {pred["id"]: pred, succ["id"]: succ}
            return DependencyMutation(dependency=self._dependency_out(dep, ctx, rows), plan_revision=revision)

    def remove_dependency(
        self, principal: WorkPrincipal, ref: str, dependency_id: str, expected_plan_revision: int | None
    ) -> DependencyRemoved:
        with self.db.write() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.schedule_task)
            self._require_open(project)
            dep = store.get_dependency(conn, dependency_id)
            if dep is None or task["id"] not in (dep["predecessor_id"], dep["successor_id"]):
                raise _not_found("Зависимость не найдена.")
            if expected_plan_revision is not None and expected_plan_revision != int(project["plan_revision"]):
                raise _stale_schedule(
                    "plan_revision",
                    "План проекта уже изменён — обновите данные.",
                    current=int(project["plan_revision"]),
                )
            store.delete_dependency(conn, dependency_id)
            revision, project = self._bump_and_read(conn, project["id"])
            ctx = self._ctx(conn, project, principal)
            self._audit(
                conn,
                principal,
                operation="dependency_removed",
                entity_type="dependency",
                entity_id=dependency_id,
                project_id=project["id"],
                task_id=dep["successor_id"],
                related_task_id=dep["predecessor_id"],
                changes={
                    "predecessor_id": dep["predecessor_id"],
                    "successor_id": dep["successor_id"],
                    "predecessor_key": ctx.key(dep["predecessor_id"]),
                    "successor_key": ctx.key(dep["successor_id"]),
                },
            )
            return DependencyRemoved(dependency_id=dependency_id, plan_revision=revision)

    # --- gantt -------------------------------------------------------------------------------------------------
    def gantt(self, principal: WorkPrincipal, project_ref: str) -> GanttOut:
        """One snapshot: project, tasks, dependencies and violations at the same plan_revision."""
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.view_tasks)
            ctx = self._ctx(conn, project, principal)
            rows = store.project_tasks(conn, project["id"])
            snapshot_at = self.now()
        by_id = {r["id"]: r for r in rows}
        tasks = [self._task_out(r, ctx) for r in _hierarchy_order(rows)]
        stasks = {r["id"]: _sched_task(r, ctx.key(r["id"])) for r in rows}
        edges = [_sched_edge(d) for d in ctx.deps]
        scheduled = [t for t in tasks if t.start_date is not None and t.end_exclusive is not None]
        return GanttOut(
            project_id=project["id"],
            project_key=project["key"],
            plan_revision=int(project["plan_revision"]),
            snapshot_at=snapshot_at,
            today=ctx.today,
            calendar=self._calendar(project["timezone"]),
            tasks=tasks,
            dependencies=[self._dependency_out(d, ctx, by_id) for d in ctx.deps],
            unscheduled_task_ids=[t.id for t in tasks if not t.scheduled],
            violations=sched.violations(stasks, edges),
            range_start=min((t.start_date for t in scheduled if t.start_date), default=None),
            range_end_exclusive=max((t.end_exclusive for t in scheduled if t.end_exclusive), default=None),
            critical_path=None,
        )

    # --- schedule preview / apply ------------------------------------------------------------------------------
    def _plan(
        self, conn: sqlite3.Connection, project: sqlite3.Row, request: SchedulePreviewRequest
    ) -> tuple[sched.PlanResult, list[DependencyAdd]]:
        ctx = self._ctx(conn, project)  # scheduling only: no task leaves here, no document scope needed
        rows = store.project_tasks(conn, project["id"])
        stasks = {r["id"]: _sched_task(r, ctx.key(r["id"])) for r in rows}
        edges = [_sched_edge(d) for d in ctx.deps]
        changes: dict[str, tuple[date, date]] = {}
        for change in request.changes:
            row = self._lookup_task(conn, change.task_id)
            if row is None or row["project_id"] != project["id"] or row["archived_at"] is not None:
                raise ApiError(
                    404, "not_found", "Задача из изменения не найдена в проекте.", {"task_id": change.task_id}
                )
            changes[row["id"]] = resolve_interval(
                change.start_date, change.end_exclusive, change.duration_workdays, bool(row["is_milestone"])
            )
        added: list[sched.SchedEdge] = []
        normalized: list[DependencyAdd] = []
        for index, dep in enumerate(request.add_dependencies):
            pred, succ = self._validate_new_edge(
                conn, project, ctx, dep.predecessor_task_id, dep.successor_task_id, [*edges, *added]
            )
            added.append(
                sched.SchedEdge(id=f"new-{index}", pred=pred["id"], succ=succ["id"], lag=dep.lag_workdays)
            )
            normalized.append(
                DependencyAdd(
                    predecessor_task_id=pred["id"],
                    successor_task_id=succ["id"],
                    lag_workdays=dep.lag_workdays,
                )
            )
        try:
            result = sched.plan(stasks, edges, mode=request.mode, changes=changes, added_edges=added)
        except sched.CycleError as exc:  # defensive: stored edges always form a DAG
            raise ApiError(
                422, "dependency_cycle", "Граф зависимостей содержит цикл.", {"cycle": exc.cycle}
            ) from exc
        return result, normalized

    def preview(
        self, principal: WorkPrincipal, project_ref: str, request: SchedulePreviewRequest
    ) -> SchedulePreview:
        """Computes the consequences; writes NO task, project revision or audit event (only the preview record)."""
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.schedule_task)
            self._require_open(project)
            base = int(project["plan_revision"])
            if request.base_plan_revision is not None and request.base_plan_revision != base:
                raise _stale_schedule(
                    "plan_revision", "План проекта уже изменён — обновите данные.", current=base
                )
            result, normalized = self._plan(conn, project, request)
        created = self.now()
        expires = created + timedelta(seconds=self.preview_ttl_seconds)
        preview = SchedulePreview(
            preview_id=store.new_id(),
            project_id=project["id"],
            mode=request.mode,
            base_plan_revision=base,
            calendar=CALENDAR_ID,
            input_hash=result.input_hash,
            operations=result.operations,
            added_dependencies=normalized,
            conflicts=result.conflicts,
            warnings=result.warnings,
            blocked_tasks=result.blocked,
            unchanged=result.unchanged,
            can_apply=result.can_apply,
            critical_path=None,
            created_at=created,
            expires_at=expires,
        )
        with self.db.write() as conn:
            store.purge_previews(conn, store.now_iso(created))
            store.insert_preview(
                conn,
                {
                    "id": preview.preview_id,
                    "project_id": project["id"],
                    "actor_id": principal.user.user_id,
                    "base_plan_revision": base,
                    "calendar": CALENDAR_ID,
                    "input_hash": result.input_hash,
                    "result_hash": result.result_hash,
                    "request_json": request.model_dump_json(exclude={"base_plan_revision"}),
                    "result_json": preview.model_dump_json(),
                    "created_at": store.now_iso(created),
                    "expires_at": store.now_iso(expires),
                },
            )
        return preview

    def apply(
        self, principal: WorkPrincipal, project_ref: str, body: ScheduleApplyRequest
    ) -> ScheduleApplyResult:
        """Re-validates EVERYTHING against the current state and writes the confirmed preview atomically."""
        request_hash = _hash(body.model_dump(mode="json", exclude={"client_request_id"}))
        with self.db.write() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.schedule_task)
            scope = f"schedule_apply:{project['id']}"
            replay = self._replay(conn, scope, principal, body.client_request_id, request_hash)
            if replay is not None:
                return ScheduleApplyResult.model_validate({**replay, "replayed": True})
            self._require_open(project)
            preview_row = store.get_preview(conn, body.preview_id)
            if preview_row is None or preview_row["project_id"] != project["id"]:
                raise _not_found("Предпросмотр расписания не найден.")
            if preview_row["actor_id"] != principal.user.user_id:
                raise _not_found("Предпросмотр расписания не найден.")  # previews are personal
            if preview_row["applied_at"] is not None:
                raise _stale_schedule("already_applied", "Этот предпросмотр уже применён — сделайте новый.")
            if datetime.fromisoformat(preview_row["expires_at"]) < self.now():
                raise _stale_schedule("expired", "Предпросмотр устарел по времени — повторите его.")
            current = int(project["plan_revision"])
            if body.expected_plan_revision != int(preview_row["base_plan_revision"]) or current != int(
                preview_row["base_plan_revision"]
            ):
                raise _stale_schedule(
                    "plan_revision",
                    "План проекта изменился после предпросмотра — повторите предпросмотр.",
                    current=current,
                    preview_base=int(preview_row["base_plan_revision"]),
                )
            request = SchedulePreviewRequest.model_validate_json(preview_row["request_json"])
            try:
                result, normalized = self._plan(conn, project, request)
            except ApiError as exc:
                raise _stale_schedule(
                    "revalidation_failed",
                    "Предпросмотр больше не проходит проверку — повторите его.",
                    error=exc.code,
                ) from exc
            if (
                result.input_hash != preview_row["input_hash"]
                or result.result_hash != preview_row["result_hash"]
            ):
                raise _stale_schedule(
                    "snapshot_changed", "Данные плана изменились после предпросмотра — повторите его."
                )
            if result.conflicts:
                raise ApiError(
                    422,
                    "schedule_conflict",
                    "В предпросмотре есть конфликты — применить нельзя.",
                    {
                        "reason": "conflicts",
                        "conflicts": [c.model_dump(mode="json") for c in result.conflicts],
                    },
                )
            if result.warnings and not body.accept_warnings:
                raise ApiError(
                    422,
                    "schedule_conflict",
                    "Новые сроки выходят за дедлайны — подтвердите предупреждения (accept_warnings).",
                    {
                        "reason": "warnings_not_accepted",
                        "warnings": [w.model_dump(mode="json") for w in result.warnings],
                    },
                )
            at = self._now_iso()
            ctx = self._ctx(conn, project, principal)
            added_out: list[str] = []
            for dep in normalized:
                dep_id = store.new_id()
                store.insert_dependency(
                    conn,
                    {
                        "id": dep_id,
                        "project_id": project["id"],
                        "predecessor_id": dep.predecessor_task_id,
                        "successor_id": dep.successor_task_id,
                        "kind": "FS",
                        "lag_workdays": dep.lag_workdays,
                        "created_by": principal.user.user_id,
                        "created_at": at,
                    },
                )
                added_out.append(dep_id)
                self._audit(
                    conn,
                    principal,
                    operation="dependency_added",
                    entity_type="dependency",
                    entity_id=dep_id,
                    project_id=project["id"],
                    task_id=dep.successor_task_id,
                    related_task_id=dep.predecessor_task_id,
                    changes={
                        "predecessor_id": dep.predecessor_task_id,
                        "successor_id": dep.successor_task_id,
                        "predecessor_key": ctx.key(dep.predecessor_task_id),
                        "successor_key": ctx.key(dep.successor_task_id),
                        "kind": "FS",
                        "lag_workdays": dep.lag_workdays,
                        "via": "schedule_apply",
                    },
                    correlation_id=body.preview_id,
                    at=at,
                )
            for op in result.operations:
                fields = {
                    "start_date": _iso(op.after.start_date),
                    "end_exclusive": _iso(op.after.end_exclusive),
                }
                if not store.update_task(conn, op.task_id, op.version, fields, principal.user.user_id, at):
                    raise _stale_schedule(
                        "task_changed", "Задача изменилась во время применения — повторите предпросмотр."
                    )
                self._audit(
                    conn,
                    principal,
                    operation="schedule_applied",
                    entity_type="task",
                    entity_id=op.task_id,
                    project_id=project["id"],
                    task_id=op.task_id,
                    changes={
                        "start_date": {
                            "before": _iso(op.before.start_date),
                            "after": _iso(op.after.start_date),
                        },
                        "end_exclusive": {
                            "before": _iso(op.before.end_exclusive),
                            "after": _iso(op.after.end_exclusive),
                        },
                        "change": op.change,
                        "because_of": op.because_of,
                        "preview_id": body.preview_id,
                    },
                    correlation_id=body.preview_id,
                    at=at,
                )
                if self._after_schedule_write is not None:
                    self._after_schedule_write(op.task_id)
            if result.operations or normalized:
                revision, project = self._bump_and_read(conn, project["id"])
            else:  # nothing changes: the plan revision stays, so no one else's preview goes stale (audit SYS-003)
                revision = int(project["plan_revision"])
            if not store.mark_preview_applied(conn, body.preview_id, at, revision):
                raise _stale_schedule("already_applied", "Этот предпросмотр уже применён — сделайте новый.")
            ctx = self._ctx(conn, project, principal)
            changed = [
                self._task_out(_must(store.get_task(conn, op.task_id)), ctx) for op in result.operations
            ]
            all_rows = {r["id"]: r for r in store.project_tasks(conn, project["id"])}
            added_deps = [
                self._dependency_out(_must(store.get_dependency(conn, d)), ctx, all_rows) for d in added_out
            ]
            out = ScheduleApplyResult(
                preview_id=body.preview_id,
                project_id=project["id"],
                applied=True,
                plan_revision=revision,
                changed_tasks=changed,
                added_dependencies=added_deps,
                correlation_id=body.preview_id,
            )
            self._remember(
                conn, scope, principal, body.client_request_id, request_hash, out.model_dump(mode="json")
            )
            return out

    # --- task ↔ document links (Step 4) ------------------------------------------------------------------------
    @staticmethod
    def _link_out(row: RowLike, scope: DocumentScope) -> TaskLinkOut:
        state = link_state(scope, row["document_id"], row["revision_at_link"])
        doc = scope.get(row["document_id"]) if state not in ("unavailable", "unverified") else None
        return TaskLinkOut(
            id=row["id"],
            task_id=row["task_id"],
            relation=LinkRelation(row["relation"]),
            source_system="skh",
            state=state,
            # Nothing about a document the reader cannot see: no id, title, status or revision (M6-12/M6-34).
            document=document_ref(doc) if doc is not None else None,
            revision_at_link=row["revision_at_link"] if doc is not None else None,
            deprecated=is_deprecated(doc),
            approved=is_approved(doc),
            created_by=row["created_by"],
            created_at=_dt(row["created_at"]),
        )

    @staticmethod
    def _scope(principal: WorkPrincipal) -> DocumentScope:
        return principal.documents or DocumentScope.unavailable()

    def task_links(self, principal: WorkPrincipal, ref: str) -> TaskLinks:
        scope = self._scope(principal)
        with self.db.read() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.view_tasks)
            rows = [
                r
                for r in store.task_links(conn, task["id"])
                if r["target_type"] == "document" and r["source_system"] == "skh"
            ]
        return TaskLinks(
            task_id=task["id"],
            task_key=f"{project['key']}-{task['number']}",
            knowledge_available=scope.available,
            generation=scope.generation,
            items=[self._link_out(r, scope) for r in rows],
        )

    def _writable_task(self, conn: sqlite3.Connection, principal: WorkPrincipal, ref: str) -> sqlite3.Row:
        task, project, _ = self._task_for(conn, principal, ref, Action.edit_task)
        self._require_open(project)
        if task["archived_at"] is not None:
            raise ApiError(
                409, "conflict", "Задача в архиве — сначала восстановите её.", {"reason": "task_archived"}
            )
        return task

    def link_document(self, principal: WorkPrincipal, ref: str, body: TaskLinkCreate) -> TaskLinkOut:
        """Link a task to a document the reader can see NOW; the server records its canonical id and current
        revision. Does not touch the task (no version bump) or the plan, and never writes the document."""
        scope = self._scope(principal)
        request_hash = _hash(body.model_dump(mode="json", exclude={"client_request_id"}))
        with self.db.write() as conn:
            task = self._writable_task(conn, principal, ref)
            idem = f"link_create:{task['id']}"
            replay = self._replay(conn, idem, principal, body.client_request_id, request_hash)
            if replay is not None:
                return TaskLinkOut.model_validate(replay)
            if not scope.available:
                raise _knowledge_unavailable("связать задачу с документом нельзя")
            doc = scope.get(body.document_id)
            if doc is None:  # missing and not visible are the same answer
                raise ApiError(
                    404, "not_found", "Документ не найден или недоступен.", {"field": "document_id"}
                )
            if store.find_active_link(conn, task["id"], doc.id, body.relation.value) is not None:
                raise ApiError(
                    409,
                    "conflict",
                    f"Задача уже связана с {doc.id} так же.",
                    {"reason": "link_exists"},
                )
            at = self._now_iso()
            link_id = store.new_id()
            store.insert_link(
                conn,
                {
                    "id": link_id,
                    "project_id": task["project_id"],
                    "task_id": task["id"],
                    "target_type": "document",
                    "source_system": "skh",
                    "document_id": doc.id,
                    "relation": body.relation.value,
                    "revision_at_link": doc.revision,
                    "status": "active",
                    "created_by": principal.user.user_id,
                    "created_at": at,
                },
            )
            self._audit(
                conn,
                principal,
                operation="link_added",
                entity_type="link",
                entity_id=link_id,
                project_id=task["project_id"],
                task_id=task["id"],
                changes={
                    "document_id": doc.id,
                    "relation": body.relation.value,
                    "revision_at_link": doc.revision,
                },
                at=at,
            )
            out = self._link_out(_must(store.get_link(conn, link_id)), scope)
            self._remember(
                conn, idem, principal, body.client_request_id, request_hash, out.model_dump(mode="json"), 201
            )
            return out

    def unlink_document(self, principal: WorkPrincipal, ref: str, link_id: str) -> TaskLinkRemoved:
        """Remove a link (also one whose document is unavailable now — by link id). The row stays as history."""
        with self.db.write() as conn:
            task = self._writable_task(conn, principal, ref)
            row = store.get_link(conn, link_id)
            if row is None or row["task_id"] != task["id"] or row["status"] != "active":
                raise _not_found("Связь не найдена.")
            at = self._now_iso()
            if not store.remove_link(conn, link_id, principal.user.user_id, at):
                raise _not_found("Связь не найдена.")
            self._audit(
                conn,
                principal,
                operation="link_removed",
                entity_type="link",
                entity_id=link_id,
                project_id=task["project_id"],
                task_id=task["id"],
                changes={"document_id": row["document_id"], "relation": row["relation"]},
                at=at,
            )
            return TaskLinkRemoved(link_id=link_id, task_id=task["id"])

    def acknowledge_link(self, principal: WorkPrincipal, ref: str, link_id: str) -> TaskLinkOut:
        """A person checked the changed document: the link now records its CURRENT revision. Explicit only —
        the server never does this by itself, and it changes nothing in the task or the document."""
        scope = self._scope(principal)
        with self.db.write() as conn:
            task = self._writable_task(conn, principal, ref)
            row = store.get_link(conn, link_id)
            if row is None or row["task_id"] != task["id"] or row["status"] != "active":
                raise _not_found("Связь не найдена.")
            if not scope.available:
                raise _knowledge_unavailable("подтвердить ревизию документа нельзя")
            doc = scope.get(row["document_id"])
            if doc is None:
                raise ApiError(
                    404,
                    "not_found",
                    "Документ недоступен: подтвердить его ревизию нельзя.",
                    {"field": "link_id"},
                )
            if row["revision_at_link"] == doc.revision:
                return self._link_out(row, scope)
            store.set_link_revision(conn, link_id, doc.revision)
            self._audit(
                conn,
                principal,
                operation="link_revision_acknowledged",
                entity_type="link",
                entity_id=link_id,
                project_id=task["project_id"],
                task_id=task["id"],
                changes={
                    "document_id": doc.id,
                    "revision_at_link": {"before": row["revision_at_link"], "after": doc.revision},
                },
            )
            return self._link_out(_must(store.get_link(conn, link_id)), scope)

    def document_tasks(self, principal: WorkPrincipal, document_id: str) -> DocumentTasks:
        """Back-links of a document: active tasks linked to it, only from projects this principal may view and only
        when the document itself is visible to them (otherwise `404`, exactly like `/api/documents/{id}/links`)."""
        self._check_global(principal, Action.view_tasks)
        scope = self._scope(principal)
        if not scope.available:
            raise _knowledge_unavailable("показать задачи документа нельзя")
        doc = scope.get(document_id)
        if doc is None:
            raise ApiError(404, "document_not_found", "Документ не найден.")
        items: list[DocumentTaskRef] = []
        with self.db.read() as conn:
            allowed: dict[str, bool] = {}
            for row in store.document_links(conn, doc.id):
                if row["archived_at"] is not None:
                    continue
                project_id = row["project_id"]
                if project_id not in allowed:
                    role = self._role(conn, principal, project_id)
                    visible = not self.gate.role_based() or role is not None
                    allowed[project_id] = visible and self.gate.allows(principal, Action.view_tasks, role)
                if not allowed[project_id]:
                    continue  # a project the principal cannot see: not even counted
                key = f"{row['project_key']}-{row['number']}"
                items.append(
                    DocumentTaskRef(
                        link_id=row["link_id"],
                        relation=LinkRelation(row["relation"]),
                        state=link_state(scope, doc.id, row["revision_at_link"]),
                        revision_at_link=row["revision_at_link"],
                        task_id=row["task_id"],
                        task_key=key,
                        title=row["title"],
                        status=TaskStatus(row["status"]),
                        project_id=project_id,
                        project_key=row["project_key"],
                        project_title=row["project_title"],
                        app_path=f"/tasks/{key}",
                    )
                )
        return DocumentTasks(document_id=doc.id, revision=doc.revision, items=items, total=len(items))

    def project_documents(self, principal: WorkPrincipal, ref: str) -> ProjectDocuments:
        """Documents linked to the project's active tasks — visible ones only — with task and «changed» counts."""
        scope = self._scope(principal)
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, ref, Action.view_tasks)
            rows = store.project_link_rows(conn, project["id"])
        if not scope.available:
            return ProjectDocuments(project_id=project["id"], knowledge_available=False, items=[])
        tasks: dict[str, set[str]] = defaultdict(set)
        changed: dict[str, int] = defaultdict(int)
        docs: dict[str, Any] = {}
        for row in rows:
            doc = scope.get(row["document_id"])
            if doc is None:
                continue
            docs[doc.id] = doc
            tasks[doc.id].add(row["task_id"])
            if link_state(scope, doc.id, row["revision_at_link"]) == "revision_changed":
                changed[doc.id] += 1
        return ProjectDocuments(
            project_id=project["id"],
            knowledge_available=True,
            items=[
                ProjectDocumentRef(
                    document=document_ref(docs[doc_id]),
                    task_count=len(tasks[doc_id]),
                    changed_count=changed[doc_id],
                )
                for doc_id in sorted(docs, key=str.casefold)
            ],
        )

    # --- AI task plans (Step 5): context reads and the ONE apply transaction --------------------------------------
    def planning_context(
        self, principal: WorkPrincipal, project_ref: str, parent_ref: str | None
    ) -> PlanningContext:
        """Everything «AI план» may tell the model about the project, after the `propose_work` gate: key, title, plan
        revision and the active tasks' keys/titles (de-duplication only). Never another project's data."""
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.propose_work)
            self._require_open(project)
            ctx = self._ctx(conn, project)
            anchor: tuple[str, str, int] | None = None
            if parent_ref is not None:
                parent = self._lookup_task(conn, parent_ref)
                if parent is None or parent["project_id"] != project["id"]:
                    raise _invalid_hierarchy(
                        "parent_not_in_project", "Родительская задача не найдена в этом проекте."
                    )
                self._validate_parent(conn, ctx, parent["id"])
                anchor = (parent["id"], ctx.key(parent["id"]), ctx.depth(parent["id"]))
            existing = [
                (ctx.key(r["id"]), str(r["title"]))
                for r in sorted(ctx.skeleton.values(), key=lambda r: int(r["number"]))
                if r["archived_at"] is None
            ]
            return PlanningContext(
                project_id=project["id"],
                project_key=project["key"],
                project_title=project["title"],
                plan_revision=int(project["plan_revision"]),
                today=ctx.today,
                existing=existing,
                anchor=anchor,
            )

    def may(self, principal: WorkPrincipal, action: Action) -> bool:
        """Whether the work gate lets this principal do `action` at all, before a project is chosen (the skill catalog,
        M7). Membership mode: any real identity (its project role is checked per request); otherwise the single
        operator outside read-only exposure. Never a grant: every request re-checks with the project."""
        if self.gate.mode == WorkAccessMode.disabled:
            return False
        if self.gate.role_based():
            return not principal.user.is_demo
        return self.gate.allows(principal, action, None)

    def chat_target(
        self,
        principal: WorkPrincipal,
        project_ref: str,
        actions: tuple[Action, ...],
        task_refs: Sequence[str] = (),
        *,
        writable: bool = False,
    ) -> ChatTarget:
        """The project (and tasks) a chat work skill acts on (M7), resolved in the READER's scope BEFORE any model call:
        an unknown and an invisible project are the same 404; each of `actions` passes the project gate (403 in
        read-only exposure); `writable` refuses an archived project (409); every task must be in THIS project (404 —
        never another project's task, never its title)."""
        with self.db.read() as conn:
            project, role = self._project_for(conn, principal, project_ref, actions[0])
            for action in actions[1:]:
                self.gate.check(principal, action, role)
            if writable:
                self._require_open(project)
            keys: list[str] = []
            ids: list[str] = []
            for ref in task_refs:
                task = self._lookup_task(conn, ref)
                if task is None or task["project_id"] != project["id"]:
                    raise _not_found("Задача не найдена в этом проекте.")
                if task["id"] not in ids:
                    keys.append(f"{project['key']}-{task['number']}")
                    ids.append(task["id"])
            return ChatTarget(
                project_id=project["id"],
                project_key=project["key"],
                project_title=project["title"],
                plan_revision=int(project["plan_revision"]),
                archived=project["status"] == ProjectStatus.archived.value,
                task_keys=tuple(keys),
                task_ids=tuple(ids),
            )

    def proposal_view(
        self, principal: WorkPrincipal, project_id: str, parent_task_id: str | None
    ) -> ProposalView:
        """The project facts a stored proposal is shown with (after the `propose_work` gate)."""
        with self.db.read() as conn:
            project, role = self._project_for(conn, principal, project_id, Action.propose_work)
            parent_key = None
            if parent_task_id:
                parent = store.get_task(conn, parent_task_id)
                parent_key = f"{project['key']}-{parent['number']}" if parent is not None else None
            return ProposalView(
                project_key=project["key"],
                plan_revision=int(project["plan_revision"]),
                may_apply=project["status"] != ProjectStatus.archived.value
                and self.gate.allows(principal, Action.apply_work_proposal, role),
                parent_key=parent_key,
            )

    def apply_task_plan(
        self,
        principal: WorkPrincipal,
        proposal_id: str,
        *,
        client_request_id: str,
        request_hash: str,
        prepare: Callable[[sqlite3.Row, sqlite3.Row], PlanToApply],
    ) -> WorkProposalApplyResult:
        """Apply a reviewed AI task plan in ONE write transaction: idempotent replay → proposal visible and still
        `suggested` → `prepare` re-validates it against the CURRENT state (plan revision, expiry, sources, edits;
        raises `409 proposal_stale` / `422 proposal_invalid`) → tasks (real ids and keys replace local ids),
        FS dependencies, document links, audit, one plan-revision bump, the proposal marked `applied`. Any error rolls
        EVERYTHING back (M6-18); a replay with the same `client_request_id` returns the first result."""
        with self.db.write() as conn:
            row = store.get_proposal(conn, proposal_id)
            if row is None or row["actor_id"] != principal.user.user_id:
                raise _not_found("Предложение не найдено.")  # proposals are personal, like schedule previews
            project, _ = self._project_for(conn, principal, row["project_id"], Action.apply_work_proposal)
            scope = f"proposal_apply:{proposal_id}"
            replay = self._replay(conn, scope, principal, client_request_id, request_hash)
            if replay is not None:
                return WorkProposalApplyResult.model_validate({**replay, "replayed": True})
            self._require_open(project)
            if row["status"] != "suggested":
                raise ApiError(
                    409,
                    "proposal_stale",
                    "Предложение уже применено или отклонено — подготовьте новое.",
                    {"reason": f"already_{row['status']}"},
                )
            plan = prepare(row, project)
            for planned in plan.tasks:  # the same bound as a direct create (audit CODE-005), before any write
                check_work_date(planned.start, "start_date")
                check_work_date(planned.end, "end_exclusive")
                check_work_date(planned.due, "due_date")
            ctx = self._ctx(conn, project)
            depth = ctx.depth(plan.anchor_id) if plan.anchor_id else 0
            if plan.anchor_id is not None:
                self._validate_parent(conn, ctx, plan.anchor_id)
            by_local = {t.local_id: t for t in plan.tasks}

            def level(task: PlannedTask) -> int:
                n, current, seen = 1, task, set()
                while (
                    current.parent_local_id
                    and current.parent_local_id in by_local
                    and current.local_id not in seen
                ):
                    seen.add(current.local_id)
                    current = by_local[current.parent_local_id]
                    n += 1
                return n

            if any(depth + level(t) > MAX_DEPTH for t in plan.tasks):
                raise _invalid_hierarchy("too_deep", f"Допустимо не более {MAX_DEPTH} уровней вложенности.")
            if store.count_active_tasks(conn, project["id"]) + len(plan.tasks) > MAX_TASKS_PER_PROJECT:
                raise ApiError(
                    409, "conflict", "Достигнут предел числа задач в проекте.", {"reason": "task_limit"}
                )
            for task in plan.tasks:
                self._check_assignee(conn, project["id"], task.assignee_id)
            at = self._now_iso()
            ids: dict[str, str] = {}
            created: list[str] = []
            for task in sorted(plan.tasks, key=level):  # parents before their subtasks; stable proposal order
                number = store.allocate_task_number(conn, project["id"])
                task_id = store.new_id()
                ids[task.local_id] = task_id
                parent_id = ids.get(task.parent_local_id) if task.parent_local_id else plan.anchor_id
                row_out = {
                    "id": task_id,
                    "project_id": project["id"],
                    "number": number,
                    "parent_task_id": parent_id,
                    "title": task.title,
                    "description": task.description,
                    "status": TaskStatus.todo.value,
                    "priority": task.priority,
                    "assignee_id": task.assignee_id,
                    "reporter_id": principal.user.user_id,
                    "estimate_workdays": task.estimate,
                    "start_date": _iso(task.start),
                    "end_exclusive": _iso(task.end),
                    "due_date": _iso(task.due),
                    "is_milestone": int(task.milestone),
                    "date_locked": 1 if task.locked else 0,
                    "sort_order": number * 1024,
                    "is_demo": 0,
                    "created_by": principal.user.user_id,
                    "created_at": at,
                    "updated_by": principal.user.user_id,
                    "updated_at": at,
                }
                store.insert_task(conn, row_out)
                self._audit(
                    conn,
                    principal,
                    operation="task_created",
                    entity_type="task",
                    entity_id=task_id,
                    project_id=project["id"],
                    task_id=task_id,
                    changes={**_created_changes(row_out), "proposal_id": proposal_id},
                    correlation_id=proposal_id,
                    at=at,
                )
                created.append(task_id)
                if self._after_plan_write is not None:
                    self._after_plan_write(task_id)
            for pred, succ in plan.dependencies:
                dep_id = store.new_id()
                store.insert_dependency(
                    conn,
                    {
                        "id": dep_id,
                        "project_id": project["id"],
                        "predecessor_id": ids[pred],
                        "successor_id": ids[succ],
                        "kind": "FS",
                        "lag_workdays": 0,
                        "created_by": principal.user.user_id,
                        "created_at": at,
                    },
                )
                self._audit(
                    conn,
                    principal,
                    operation="dependency_added",
                    entity_type="dependency",
                    entity_id=dep_id,
                    project_id=project["id"],
                    task_id=ids[succ],
                    related_task_id=ids[pred],
                    changes={
                        "predecessor_id": ids[pred],
                        "successor_id": ids[succ],
                        "kind": "FS",
                        "via": "ai_proposal",
                    },
                    correlation_id=proposal_id,
                    at=at,
                )
            links = 0
            for task in plan.tasks:
                for document_id, revision in dict.fromkeys(task.sources):
                    link_id = store.new_id()
                    store.insert_link(
                        conn,
                        {
                            "id": link_id,
                            "project_id": project["id"],
                            "task_id": ids[task.local_id],
                            "target_type": "document",
                            "source_system": "skh",
                            "document_id": document_id,
                            "relation": "implements",
                            "revision_at_link": revision,
                            "status": "active",
                            "created_by": principal.user.user_id,
                            "created_at": at,
                        },
                    )
                    self._audit(
                        conn,
                        principal,
                        operation="link_added",
                        entity_type="link",
                        entity_id=link_id,
                        project_id=project["id"],
                        task_id=ids[task.local_id],
                        changes={
                            "document_id": document_id,
                            "relation": "implements",
                            "revision_at_link": revision,
                        },
                        correlation_id=proposal_id,
                        at=at,
                    )
                    links += 1
            revision_now, project = self._bump_and_read(conn, project["id"])
            keys = {
                local: f"{project['key']}-{_must(store.get_task(conn, tid))['number']}"
                for local, tid in ids.items()
            }
            if not store.decide_proposal(
                conn,
                proposal_id,
                "applied",
                principal.user.user_id,
                at,
                {"task_ids": ids, "task_keys": keys, "plan_revision": revision_now},
            ):
                raise ApiError(
                    409, "proposal_stale", "Предложение уже применено.", {"reason": "already_applied"}
                )
            self._audit(
                conn,
                principal,
                operation="proposal_applied",
                entity_type="proposal",
                entity_id=proposal_id,
                project_id=project["id"],
                changes={"tasks": len(created), "dependencies": len(plan.dependencies), "links": links},
                correlation_id=proposal_id,
                at=at,
            )
            ctx = self._ctx(conn, project, principal)
            out = WorkProposalApplyResult(
                proposal_id=proposal_id,
                project_id=project["id"],
                applied=True,
                plan_revision=revision_now,
                created_tasks=[self._task_out(_must(store.get_task(conn, t)), ctx) for t in created],
                created_dependencies=len(plan.dependencies),
                created_links=links,
            )
            self._remember(
                conn, scope, principal, client_request_id, request_hash, out.model_dump(mode="json")
            )
            logger.info(
                "work ai plan applied project=%s tasks=%s deps=%s links=%s plan_revision=%s",
                project["key"],
                len(created),
                len(plan.dependencies),
                links,
                revision_now,
            )
            return out

    # --- M7: change-set proposals for existing tasks -------------------------------------------------------------
    def change_context(
        self, principal: WorkPrincipal, project_ref: str, task_refs: Sequence[str], request_text: str
    ) -> ChangeContext:
        """The tasks a change-set may touch, BEFORE any model call: the `propose_work` AND `edit_task` gate (read-only
        → 403), an open project (archived → 409), tasks named explicitly or by key in the request (each must be an
        active task of THIS project: 404 / 409), otherwise the project's active tasks — at most CHANGE_CONTEXT_TASKS
        (more → 422: name the tasks; the model never guesses among hundreds)."""
        with self.db.read() as conn:
            project, role = self._project_for(conn, principal, project_ref, Action.propose_work)
            self.gate.check(principal, Action.edit_task, role)
            self._require_open(project)
            refs = list(task_refs) or [
                key
                for key in TASK_KEY_IN_TEXT.findall(request_text.upper())
                if key.split("-", 1)[0] == project["key"]
            ]
            rows: list[RowLike] = []
            if refs:
                for ref in dict.fromkeys(refs):
                    task = self._lookup_task(conn, ref)
                    if task is None or task["project_id"] != project["id"]:
                        raise _not_found("Задача не найдена в этом проекте.")
                    if task["archived_at"] is not None:
                        raise ApiError(
                            409,
                            "conflict",
                            "Задача в архиве — изменения для неё не предлагаются; сначала восстановите её.",
                            {"reason": "task_archived"},
                        )
                    rows.append(task)
                if len(rows) > CHANGE_TASKS_MAX:
                    raise ApiError(
                        422,
                        "invalid_request",
                        f"Не больше {CHANGE_TASKS_MAX} задач в одном предложении изменений.",
                        {"reason": "too_many_tasks"},
                    )
            else:
                rows = list(store.project_tasks(conn, project["id"]))
                if not rows:
                    raise ApiError(
                        422, "work_tasks_required", "В проекте нет активных задач — изменять нечего."
                    )
                if len(rows) > CHANGE_CONTEXT_TASKS:
                    raise ApiError(
                        422,
                        "work_tasks_required",
                        f"В проекте больше {CHANGE_CONTEXT_TASKS} задач: укажите ключи задач, которые нужно "
                        f"изменить (например, {project['key']}-1).",
                        {"reason": "too_many_tasks"},
                    )
            return ChangeContext(
                project_id=project["id"],
                project_key=project["key"],
                project_title=project["title"],
                plan_revision=int(project["plan_revision"]),
                tasks=tuple(
                    {
                        "id": r["id"],
                        "key": f"{project['key']}-{r['number']}",
                        "title": str(r["title"]),
                        "description": str(r["description"] or ""),
                        "status": str(r["status"]),
                        "priority": str(r["priority"]),
                        "due_date": r["due_date"],
                        "version": int(r["version"]),
                    }
                    for r in rows
                ),
                named=bool(refs),
            )

    def change_view(self, principal: WorkPrincipal, project_id: str, task_ids: Iterable[str]) -> ChangeView:
        """The project and the CURRENT rows of a change-set's tasks, from one snapshot (after the `propose_work` gate)."""
        with self.db.read() as conn:
            project, role = self._project_for(conn, principal, project_id, Action.propose_work)
            tasks: dict[str, dict[str, Any]] = {}
            for task_id in dict.fromkeys(task_ids):
                row = store.get_task(conn, task_id)
                if row is not None and row["project_id"] == project["id"]:
                    tasks[task_id] = {**dict(row), "key": f"{project['key']}-{row['number']}"}
            return ChangeView(
                project_key=project["key"],
                plan_revision=int(project["plan_revision"]),
                may_apply=project["status"] != ProjectStatus.archived.value
                and self.gate.allows(principal, Action.apply_work_proposal, role)
                and self.gate.allows(principal, Action.edit_task, role),
                tasks=tasks,
            )

    def apply_task_change_set(
        self,
        principal: WorkPrincipal,
        proposal_id: str,
        *,
        client_request_id: str,
        request_hash: str,
        prepare: Callable[[sqlite3.Row, sqlite3.Row, dict[str, sqlite3.Row]], list[TaskFieldChanges]],
    ) -> WorkChangeApplyResult:
        """Apply a reviewed change-set in ONE write transaction (M7): owner → `apply_work_proposal` + `edit_task` gate →
        idempotent replay → open project, proposal still `suggested` → `prepare` re-validates it against the CURRENT
        rows (plan revision, every task version, expiry, sources, values; 409 / 422) → each task updated ONCE (one
        version bump, however many of its fields change), one audit event per task, ONE plan-revision bump, the
        proposal marked `applied` with its result. Any error rolls EVERYTHING back (tasks, audit, revision, status);
        a replay with the same `client_request_id` returns the first result and writes nothing."""
        with self.db.write() as conn:
            row = store.get_change_proposal(conn, proposal_id)
            if row is None or row["actor_id"] != principal.user.user_id:
                raise _not_found("Предложение не найдено.")  # proposals are personal
            project, role = self._project_for(conn, principal, row["project_id"], Action.apply_work_proposal)
            self.gate.check(principal, Action.edit_task, role)
            scope = f"change_apply:{proposal_id}"
            replay = self._replay(conn, scope, principal, client_request_id, request_hash)
            if replay is not None:
                return WorkChangeApplyResult.model_validate({**replay, "replayed": True})
            self._require_open(project)
            if row["status"] != "suggested":
                raise ApiError(
                    409,
                    "proposal_stale",
                    "Предложение уже применено или отклонено — подготовьте новое.",
                    {"reason": f"already_{row['status']}"},
                )
            task_ids = [str(op["task_id"]) for op in json.loads(row["operations_json"])]
            current = {
                tid: task
                for tid in dict.fromkeys(task_ids)
                if (task := store.get_task(conn, tid)) is not None and task["project_id"] == project["id"]
            }
            changes = prepare(row, project, current)
            if not changes:
                raise ApiError(
                    422,
                    "proposal_invalid",
                    "Не выбрано ни одного изменения (или все выбранные значения уже стоят).",
                    {"reason": "nothing_to_apply"},
                )
            at = self._now_iso()
            updated: list[str] = []
            for change in changes:
                task = current[change.task_id]
                if not store.update_task(
                    conn, change.task_id, change.expected_version, change.fields, principal.user.user_id, at
                ):
                    raise ApiError(
                        409,
                        "proposal_stale",
                        "Задача изменена после подготовки предложения — подготовьте новое.",
                        {"reason": "task_changed"},
                    )
                self._audit(
                    conn,
                    principal,
                    operation="task_updated",
                    entity_type="task",
                    entity_id=change.task_id,
                    project_id=project["id"],
                    task_id=change.task_id,
                    changes={**_diff(task, change.fields), "proposal_id": proposal_id},
                    correlation_id=proposal_id,
                    at=at,
                )
                updated.append(change.task_id)
                if self._after_change_write is not None:
                    self._after_change_write(change.task_id)
            revision_now, project = self._bump_and_read(conn, project["id"])
            operation_ids = [op for change in changes for op in change.operation_ids]
            keys = [f"{project['key']}-{_must(store.get_task(conn, t))['number']}" for t in updated]
            if not store.decide_change_proposal(
                conn,
                proposal_id,
                "applied",
                principal.user.user_id,
                at,
                {"operation_ids": operation_ids, "task_keys": keys, "plan_revision": revision_now},
            ):
                raise ApiError(
                    409, "proposal_stale", "Предложение уже применено.", {"reason": "already_applied"}
                )
            self._audit(
                conn,
                principal,
                operation="change_proposal_applied",
                entity_type="proposal",
                entity_id=proposal_id,
                project_id=project["id"],
                changes={"tasks": len(updated), "operations": len(operation_ids)},
                correlation_id=proposal_id,
                at=at,
            )
            ctx = self._ctx(conn, project, principal)
            out = WorkChangeApplyResult(
                proposal_id=proposal_id,
                project_id=project["id"],
                applied=True,
                plan_revision=revision_now,
                applied_operations=len(operation_ids),
                updated_tasks=[self._task_out(_must(store.get_task(conn, t)), ctx) for t in updated],
            )
            self._remember(
                conn, scope, principal, client_request_id, request_hash, out.model_dump(mode="json")
            )
            logger.info(
                "work change-set applied project=%s tasks=%d operations=%d plan_revision=%s",
                project["key"],
                len(updated),
                len(operation_ids),
                revision_now,
            )
            return out

    # --- activity ----------------------------------------------------------------------------------------------
    def _activity(
        self, conn: sqlite3.Connection, ctx: _Ctx, rows: list[sqlite3.Row], limit: int
    ) -> ActivityPage:
        items = [
            ActivityEvent(
                seq=int(r["seq"]),
                id=r["id"],
                at=datetime.fromisoformat(r["at"]),
                actor_id=r["actor_id"],
                actor_display=self.directory.actor_display(r["actor_id"]),
                operation=r["operation"],
                entity_type=r["entity_type"],
                entity_id=r["entity_id"],
                project_id=r["project_id"],
                task_id=r["task_id"],
                task_key=ctx.key(r["task_id"]) if r["task_id"] else None,
                correlation_id=r["correlation_id"],
                changes=_visible_changes(r["entity_type"], json.loads(r["changes_json"]), ctx.docs),
            )
            for r in rows
        ]
        next_seq = items[-1].seq if len(items) == limit else None
        return ActivityPage(items=items, next_before_seq=next_seq)

    def task_activity(
        self, principal: WorkPrincipal, ref: str, *, limit: int = 50, before_seq: int | None = None
    ) -> ActivityPage:
        with self.db.read() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.view_work_audit)
            rows = store.audit_page(
                conn, project_id=project["id"], task_id=task["id"], before_seq=before_seq, limit=limit
            )
            # B2: the page names its tasks by key — read only those tasks, not the whole project.
            named = store.task_skeleton_of(conn, project["id"], (r["task_id"] for r in rows if r["task_id"]))
            ctx = _Ctx(
                project=project,
                skeleton={r["id"]: r for r in named},
                deps=[],
                links={},
                today=self._today(project["timezone"]),
                docs=principal.documents,
            )
            return self._activity(conn, ctx, rows, limit)

    def project_activity(
        self, principal: WorkPrincipal, ref: str, *, limit: int = 50, before_seq: int | None = None
    ) -> ActivityPage:
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, ref, Action.view_work_audit)
            ctx = self._ctx(conn, project, principal)
            rows = store.audit_page(
                conn, project_id=project["id"], task_id=None, before_seq=before_seq, limit=limit
            )
            return self._activity(conn, ctx, rows, limit)


# --- module helpers --------------------------------------------------------------------------------------------
def _must(row: sqlite3.Row | None) -> sqlite3.Row:
    if row is None:  # a row written in this very transaction
        raise ApiError(500, "internal_error", "Внутренняя ошибка сервера.")
    return row


def _knowledge_unavailable(what: str) -> ApiError:
    return ApiError(
        503,
        "knowledge_unavailable",
        f"База знаний сейчас недоступна: {what} (документ не проверить). Задачи работают как обычно.",
    )


def _visible_changes(
    entity_type: str, changes: dict[str, Any], scope: DocumentScope | None
) -> dict[str, Any]:
    """Activity of a link names its document only when the reader can see that document now."""
    if entity_type != "link" or not changes.get("document_id"):
        return changes
    if scope is not None and scope.get(str(changes["document_id"])) is not None:
        return changes
    return {
        "document_id": None,
        "document": "недоступен",
        **({"relation": changes["relation"]} if "relation" in changes else {}),
    }


def _full(ctx: _Ctx, task_id: str) -> RowLike:
    """Scheduling fields of a neighbour from the skeleton (lock/due/version are not needed for violations)."""
    row = ctx.skeleton[task_id]
    return {
        "id": row["id"],
        "number": row["number"],
        "title": row["title"],
        "start_date": row["start_date"],
        "end_exclusive": row["end_exclusive"],
        "is_milestone": row["is_milestone"],
        "date_locked": 0,
        "due_date": None,
        "version": 1,
    }


def _hierarchy_order(rows: Sequence[RowLike]) -> list[RowLike]:
    """Depth-first: parents before their children, siblings by (sort_order, number) — the Gantt/tree order."""
    by_parent: dict[str | None, list[RowLike]] = defaultdict(list)
    ids = {r["id"] for r in rows}
    for row in rows:
        parent = row["parent_task_id"] if row["parent_task_id"] in ids else None
        by_parent[parent].append(row)
    for siblings in by_parent.values():
        siblings.sort(key=lambda r: (int(r["sort_order"]), int(r["number"])))
    ordered: list[RowLike] = []
    stack = list(reversed(by_parent[None]))
    seen: set[str] = set()
    while stack:
        row = stack.pop()
        if row["id"] in seen:
            continue
        seen.add(row["id"])
        ordered.append(row)
        stack.extend(reversed(by_parent.get(row["id"], [])))
    return ordered


def _blocked_by(row: RowLike, ctx: _Ctx) -> list[str]:
    """Unfinished active FS predecessors of an ACTIVE task (an archived task waits for nothing)."""
    return ctx.blocked_by(row["id"]) if row["archived_at"] is None else []


def _is_blocked(row: RowLike, ctx: _Ctx) -> bool:
    return row["status"] != TaskStatus.done.value and bool(_blocked_by(row, ctx))


def _overdue(row: RowLike, today: date) -> bool:
    due = _d(row["due_date"])
    return (
        row["archived_at"] is None
        and row["status"] != TaskStatus.done.value
        and due is not None
        and due < today
    )


def _row_sort_key(sort: str) -> Callable[[RowLike], tuple[Any, ...]]:
    """The list order on stored rows — the same keys TaskOut has (dates and timestamps parsed, titles casefolded)."""
    far = date(9999, 12, 31)
    match sort:
        case "key":
            return lambda r: (int(r["number"]),)
        case "title":
            return lambda r: (r["title"].casefold(), int(r["number"]))
        case "status":
            return lambda r: (STATUS_ORDER[r["status"]], int(r["number"]))
        case "priority":
            return lambda r: (PRIORITY_ORDER[r["priority"]], int(r["number"]))
        case "start_date":
            return lambda r: (_d(r["start_date"]) or far, int(r["number"]))
        case "due_date":
            return lambda r: (_d(r["due_date"]) or far, int(r["number"]))
        case "updated_at":
            return lambda r: (_dt(r["updated_at"]), int(r["number"]))
        case _:
            return lambda r: (int(r["sort_order"]), int(r["number"]))


def _created_changes(row: Mapping[str, Any]) -> dict[str, Any]:
    keep = (
        "title",
        "status",
        "priority",
        "assignee_id",
        "parent_task_id",
        "start_date",
        "end_exclusive",
        "due_date",
        "is_milestone",
        "date_locked",
        "estimate_workdays",
    )
    changes: dict[str, Any] = {k: row[k] for k in keep if row.get(k) not in (None, 0, "")}
    changes["status"] = row["status"]
    if row.get("description"):
        changes["description"] = {"changed": True}  # the minimal safe diff: never the body itself
    return changes


def _diff(before: RowLike, fields: Mapping[str, Any]) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    for name, value in fields.items():
        if name == "description":
            changes[name] = {"changed": True}
        else:
            changes[name] = {"before": before[name], "after": value}
    return changes
