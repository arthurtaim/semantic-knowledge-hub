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
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.authz import Action
from app.domain.models import UserContext
from app.errors import ApiError
from app.work import store
from app.work.calendar import (
    CALENDAR_ID,
    WORKDAY_NUMBERS,
    add_workdays,
    canonical_interval,
    count_workdays,
    last_workday,
    next_workday,
)
from app.work.db import WorkDatabase
from app.work.directory import AssigneeDirectory
from app.work.models import (
    MAX_DEPTH,
    MAX_TASKS_PER_PROJECT,
    ActivityEvent,
    ActivityPage,
    AssigneeRef,
    CalendarInfo,
    MilestoneRef,
    ProjectCreate,
    ProjectList,
    ProjectMemberOut,
    ProjectMembers,
    ProjectOut,
    ProjectRole,
    ProjectStats,
    ProjectStatus,
    ProjectUpdate,
    ScheduleMode,
    TaskArchiveResult,
    TaskCreate,
    TaskOut,
    TaskPage,
    TaskPriority,
    TaskStatus,
    TaskUpdate,
    WorkCapabilities,
    WorkFeatures,
    WorkIdentity,
    WorkLimits,
)
from app.work.permissions import LABELS, WorkAccessGate, WorkAccessMode, WorkPrincipal

logger = logging.getLogger("skh.work")

TASK_KEY_RE = re.compile(r"^([A-Z][A-Z0-9]{1,9})-(\d{1,9})$")
PROJECT_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
MIN_YEAR, MAX_YEAR = 2000, 2100
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


def _check_year(value: date | None, name: str) -> None:
    if value is not None and not (MIN_YEAR <= value.year <= MAX_YEAR):
        raise _invalid_dates("out_of_range", f"{name}: дата должна быть между {MIN_YEAR} и {MAX_YEAR} годом.")


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


@dataclass
class _Ctx:
    """Derived facts of one project inside one snapshot (hierarchy, dependencies, link counts, today)."""

    project: sqlite3.Row
    skeleton: dict[str, sqlite3.Row]
    deps: list[sqlite3.Row]
    links: dict[str, int]
    today: date
    members: frozenset[str] | None = None
    preds: dict[str, list[sqlite3.Row]] = field(default_factory=dict)
    succs: dict[str, list[sqlite3.Row]] = field(default_factory=dict)
    children: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        preds: dict[str, list[sqlite3.Row]] = defaultdict(list)
        succs: dict[str, list[sqlite3.Row]] = defaultdict(list)
        for dep in self.deps:
            preds[dep["successor_id"]].append(dep)
            succs[dep["predecessor_id"]].append(dep)
        self.preds, self.succs = dict(preds), dict(succs)
        children: dict[str, int] = defaultdict(int)
        for row in self.skeleton.values():
            if row["parent_task_id"] and row["archived_at"] is None:
                children[row["parent_task_id"]] += 1
        self.children = dict(children)

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

    def _ctx(self, conn: sqlite3.Connection, project: sqlite3.Row) -> _Ctx:
        members = None
        if self.gate.role_based():
            members = frozenset(r["user_id"] for r in store.list_members(conn, project["id"]) if r["active"])
        return _Ctx(
            project=project,
            skeleton={r["id"]: r for r in store.task_skeleton(conn, project["id"])},
            deps=store.project_dependencies(conn, project["id"]),
            links=store.link_counts(conn, project["id"]),
            today=self._today(project["timezone"]),
            members=members,
        )

    def _task_out(self, row: RowLike, ctx: _Ctx) -> TaskOut:
        start, end = _d(row["start_date"]), _d(row["end_exclusive"])
        milestone = bool(row["is_milestone"])
        last_day = last_workday(start, end) if start and end and not milestone else None
        duration = None if start is None or end is None else (0 if milestone else count_workdays(start, end))
        done = row["status"] == TaskStatus.done.value
        active = row["archived_at"] is None
        due = _d(row["due_date"])
        blocked = ctx.blocked_by(row["id"]) if active else []
        point = start if milestone else last_day
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
            overdue=active and not done and due is not None and due < ctx.today,
            late=active and not done and point is not None and point < ctx.today,
            child_count=ctx.children.get(row["id"], 0),
            link_count=ctx.links.get(row["id"], 0),
        )

    def _stats(self, ctx: _Ctx, tasks: list[TaskOut]) -> ProjectStats:
        by_status = {s.value: 0 for s in TaskStatus}
        for task in tasks:
            by_status[task.status.value] += 1
        upcoming = sorted(
            (t for t in tasks if t.is_milestone and t.start_date and t.status != TaskStatus.done),
            key=lambda t: (t.start_date, t.number),
        )
        next_milestone = None
        if upcoming:
            first = upcoming[0]
            assert first.start_date is not None
            next_milestone = MilestoneRef(
                task_id=first.id, key=first.key, title=first.title, date=first.start_date
            )
        return ProjectStats(
            total=len(tasks),
            by_status=by_status,
            open=sum(1 for t in tasks if t.status != TaskStatus.done),
            blocked=sum(1 for t in tasks if t.is_blocked),
            overdue=sum(1 for t in tasks if t.overdue),
            milestones=sum(1 for t in tasks if t.is_milestone),
            unscheduled=sum(1 for t in tasks if not t.scheduled),
            next_milestone=next_milestone,
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
        can_write = mode in (WorkAccessMode.local_operator, WorkAccessMode.membership) and (
            mode == WorkAccessMode.membership or principal.user.is_demo
        )
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
            link_relations=["implements", "requires", "documents", "verifies", "blocks"],
            limits=WorkLimits(preview_ttl_seconds=self.preview_ttl_seconds),
            features=WorkFeatures(),
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
                ctx = self._ctx(conn, row)
                tasks = [self._task_out(r, ctx) for r in store.project_tasks(conn, row["id"])]
                items.append(self._project_out(row, principal, role, self._stats(ctx, tasks)))
        return ProjectList(items=items, total=len(items))

    def get_project(self, principal: WorkPrincipal, ref: str) -> ProjectOut:
        with self.db.read() as conn:
            project, role = self._project_for(conn, principal, ref, Action.view_projects)
            ctx = self._ctx(conn, project)
            tasks = [self._task_out(r, ctx) for r in store.project_tasks(conn, project["id"])]
            return self._project_out(project, principal, role, self._stats(ctx, tasks))

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
            ctx = self._ctx(conn, created)
            out = self._project_out(created, principal, role, self._stats(ctx, []))
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
                ctx = self._ctx(conn, project)
                tasks = [self._task_out(r, ctx) for r in store.project_tasks(conn, project["id"])]
                return self._project_out(project, principal, role, self._stats(ctx, tasks))
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
            ctx = self._ctx(conn, updated)
            tasks = [self._task_out(r, ctx) for r in store.project_tasks(conn, updated["id"])]
            return self._project_out(updated, principal, role, self._stats(ctx, tasks))

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
        sort: str = "sort_order",
        order: str = "asc",
        limit: int = 200,
        offset: int = 0,
    ) -> TaskPage:
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, project_ref, Action.view_tasks)
            ctx = self._ctx(conn, project)
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
            tasks = [self._task_out(r, ctx) for r in rows]
            plan_revision = int(project["plan_revision"])
        if q:
            needle = q.casefold().strip()
            tasks = [t for t in tasks if needle in t.title.casefold() or needle in t.key.casefold()]
        if scheduled is not None:
            tasks = [t for t in tasks if t.scheduled == scheduled]
        if overdue is not None:
            tasks = [t for t in tasks if t.overdue == overdue]
        if blocked is not None:
            tasks = [t for t in tasks if t.is_blocked == blocked]
        tasks.sort(key=_sort_key(sort), reverse=order == "desc")
        total = len(tasks)
        return TaskPage(
            project_id=project["id"],
            plan_revision=plan_revision,
            items=tasks[offset : offset + limit],
            total=total,
            limit=limit,
            offset=offset,
            today=ctx.today,
        )

    def get_task(self, principal: WorkPrincipal, ref: str) -> TaskOut:
        with self.db.read() as conn:
            task, project, _ = self._task_for(conn, principal, ref, Action.view_tasks)
            return self._task_out(task, self._ctx(conn, project))

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
            ctx = self._ctx(conn, project)
            if body.parent_task_id is not None:
                self._validate_parent(conn, ctx, body.parent_task_id)
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
                "parent_task_id": body.parent_task_id,
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
            out = self._task_out(created, self._ctx(conn, project))
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
            ctx = self._ctx(conn, project)
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
            if "parent_task_id" in given and body.parent_task_id != task["parent_task_id"]:
                if body.parent_task_id is not None:
                    self._validate_parent(conn, ctx, body.parent_task_id, moving=task["id"])
                fields["parent_task_id"] = body.parent_task_id

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
            return self._task_out(updated, self._ctx(conn, project))

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
            ctx = self._ctx(conn, project)
            archived = [self._task_out(_must(store.get_task(conn, t)), ctx) for t, _ in targets]
            return TaskArchiveResult(
                archived=archived, removed_dependency_ids=removed, plan_revision=revision
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
            if task["parent_task_id"]:
                parent = store.get_task(conn, task["parent_task_id"])
                if parent is not None and parent["archived_at"] is not None:
                    raise ApiError(
                        409,
                        "conflict",
                        "Родительская задача в архиве — восстановите сначала её.",
                        {"reason": "parent_archived"},
                    )
            # Restore the subtree archived by the same operation (an «undo» of a cascade), nothing else.
            same_op = [
                r for r in store.descendants(conn, task["id"]) if r["archived_at"] == task["archived_at"]
            ]
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
            return self._task_out(restored, self._ctx(conn, project))

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
                changes=json.loads(r["changes_json"]),
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
            ctx = self._ctx(conn, project)
            rows = store.audit_page(
                conn, project_id=project["id"], task_id=task["id"], before_seq=before_seq, limit=limit
            )
            return self._activity(conn, ctx, rows, limit)

    def project_activity(
        self, principal: WorkPrincipal, ref: str, *, limit: int = 50, before_seq: int | None = None
    ) -> ActivityPage:
        with self.db.read() as conn:
            project, _ = self._project_for(conn, principal, ref, Action.view_work_audit)
            ctx = self._ctx(conn, project)
            rows = store.audit_page(
                conn, project_id=project["id"], task_id=None, before_seq=before_seq, limit=limit
            )
            return self._activity(conn, ctx, rows, limit)


# --- module helpers --------------------------------------------------------------------------------------------
def _must(row: sqlite3.Row | None) -> sqlite3.Row:
    if row is None:  # a row written in this very transaction
        raise ApiError(500, "internal_error", "Внутренняя ошибка сервера.")
    return row


def _sort_key(sort: str) -> Callable[[TaskOut], tuple[Any, ...]]:
    far = date(9999, 12, 31)
    match sort:
        case "key":
            return lambda t: (t.number,)
        case "title":
            return lambda t: (t.title.casefold(), t.number)
        case "status":
            return lambda t: (STATUS_ORDER[t.status.value], t.number)
        case "priority":
            return lambda t: (PRIORITY_ORDER[t.priority.value], t.number)
        case "start_date":
            return lambda t: (t.start_date or far, t.number)
        case "due_date":
            return lambda t: (t.due_date or far, t.number)
        case "updated_at":
            return lambda t: (t.updated_at, t.number)
        case _:
            return lambda t: (t.sort_order, t.number)


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
