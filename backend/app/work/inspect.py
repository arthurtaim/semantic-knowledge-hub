"""`work_inspect` (M6 Step 5): read-only work facts for the existing M5.7 tool loop — NOT a second tool runtime.

The loop validates the call (`WorkInspectArgs`, strict, no user/role/scope field) and hands it here with the SERVER
identity. Every read goes through `WorkService` with a principal built on the server:

- `exposed=True` — the most restrictive interpretation of the gate: in the single-operator demo this is the
  read-only mode, so the tool can never be granted anything but view actions, whatever the deployment;
- membership mode — the member's own project roles: a project the reader is not a member of is `not_found`, exactly
  like an unknown key, and never contributes to a list or a count;
- `documents` — the reader's knowledge snapshot: linked documents are named only when the reader can see them.

Results are bounded (limit ≤ 50, the loop's result size), carry provenance (plan revision, project-local today, as_of,
effective filters) and become typed system facts (`skh_work`), so an answer about status or risks cites [F1] facts
computed here — never the model's own numbers. Task titles and descriptions are untrusted DATA: injection-like text
is redacted exactly like document passages, and descriptions are only ever returned truncated.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.domain.assistant_tools import WorkInspectArgs
from app.domain.markdown import truncate
from app.domain.models import SystemFactItem, UserContext
from app.domain.safety import neutralize_citation_markers, redact_prompt_injection
from app.work.links import DocumentScope
from app.work.models import PAGE_MAX, ProjectOut, TaskOut
from app.work.permissions import WorkAccessMode, WorkPrincipal
from app.work.service import WorkService

DESCRIPTION_CHARS = 500
SUMMARY_LIST = 10


def _safe(text: str, chars: int | None = None) -> str:
    """Task text is data from people (and possibly pasted from elsewhere): same treatment as a document passage."""
    value = truncate(text, chars) if chars else text
    return redact_prompt_injection(neutralize_citation_markers(value))[0]


@dataclass
class InspectResult:
    operation: str
    label: str
    payload: dict[str, Any]
    value: int | None = None
    unit: str | None = None
    effective_filters: dict[str, Any] = field(default_factory=dict)
    definition: str | None = None
    items: list[SystemFactItem] = field(default_factory=list)
    truncated: bool = False


class WorkInspector:
    def __init__(self, work: WorkService, *, may_view: Callable[[UserContext], bool]) -> None:
        self._work = work
        self._may_view = may_view

    def offered(self, user: UserContext) -> bool:
        """The tool is described to the model only when the module is on and the global policy lets the user view."""
        return self._work.gate.mode != WorkAccessMode.disabled and self._may_view(user)

    def _principal(self, user: UserContext, documents: DocumentScope) -> WorkPrincipal:
        return WorkPrincipal(
            user=user, request_id="assistant-tool:work_inspect", exposed=True, documents=documents
        )

    def inspect(self, user: UserContext, args: WorkInspectArgs, documents: DocumentScope) -> InspectResult:
        principal = self._principal(user, documents)
        if args.operation == "list_projects":
            return self._projects(principal, args)
        if args.operation == "list_project_tasks":
            return self._tasks(principal, args)
        if args.operation == "get_task":
            return self._task(principal, args)
        if args.operation == "get_dependencies":
            return self._dependencies(principal, args)
        return self._schedule(principal, args)

    # --- rows ------------------------------------------------------------------------------------------------------
    @staticmethod
    def _task_row(task: TaskOut, key_of: Callable[[str], str]) -> dict[str, Any]:
        return {
            "key": task.key,
            "title": _safe(task.title),
            "status": task.status.value,
            "priority": task.priority.value,
            "assignee": task.assignee.display_name if task.assignee else None,
            "start": task.start_date.isoformat() if task.start_date else None,
            "last_day": task.last_day.isoformat() if task.last_day else None,
            "due": task.due_date.isoformat() if task.due_date else None,
            "milestone": task.is_milestone,
            "overdue": task.overdue,
            "late": task.late,
            "waits_for": [key_of(t) for t in task.blocked_by],
            "parent": key_of(task.parent_task_id) if task.parent_task_id else None,
            "documents": task.document_ids,  # only documents the reader can see; null = cannot be checked now
            "synthetic": task.is_demo,
        }

    @staticmethod
    def _task_item(task: TaskOut, detail: str | None = None) -> SystemFactItem:
        return SystemFactItem(
            id=task.key,
            title=_safe(task.title, 160),
            kind="task",
            status=task.status.value,
            detail=detail,
            app_path=f"/tasks/{task.key}",
            is_demo=task.is_demo,
        )

    @staticmethod
    def _task_detail(task: TaskOut) -> str:
        parts: list[str] = []
        if task.is_milestone and task.start_date:
            parts.append(f"веха {task.start_date.isoformat()}")
        elif task.start_date and task.last_day:
            parts.append(f"план {task.start_date.isoformat()} – {task.last_day.isoformat()}")
        else:
            parts.append("без дат")
        if task.due_date:
            parts.append(f"срок {task.due_date.isoformat()}")
        if task.overdue:
            parts.append("просрочена")
        elif task.late:
            parts.append("отстаёт от плана")
        if task.is_blocked:
            parts.append("ждёт предшественников")
        if task.assignee:
            parts.append(task.assignee.display_name)
        return " · ".join(parts)

    @staticmethod
    def _project_row(project: ProjectOut) -> dict[str, Any]:
        stats = project.stats
        return {
            "key": project.key,
            "title": _safe(project.title),
            "status": project.status.value,
            "start": project.start_date.isoformat() if project.start_date else None,
            "target": project.target_date.isoformat() if project.target_date else None,
            "plan_revision": project.plan_revision,
            "tasks": stats.total if stats else None,
            "by_status": stats.by_status if stats else None,
            "open": stats.open if stats else None,
            "waiting_for_predecessors": stats.blocked if stats else None,
            "overdue": stats.overdue if stats else None,
            "unscheduled": stats.unscheduled if stats else None,
            "next_milestone": (
                {"key": stats.next_milestone.key, "date": stats.next_milestone.date.isoformat()}
                if stats and stats.next_milestone
                else None
            ),
            "synthetic": project.is_demo,
        }

    # --- operations ------------------------------------------------------------------------------------------------
    def _projects(self, principal: WorkPrincipal, args: WorkInspectArgs) -> InspectResult:
        listed = self._work.list_projects(principal)
        page = listed.items[args.offset : args.offset + args.limit]
        more = args.offset + len(page) < listed.total
        return InspectResult(
            operation="list_projects",
            label="Проекты, доступные вам в SKH",
            value=listed.total,
            unit="projects",
            effective_filters={"archived": False},
            items=[
                SystemFactItem(
                    id=p.key,
                    title=_safe(p.title, 160),
                    kind="project",
                    status=p.status.value,
                    detail=(
                        f"задач {p.stats.total} · открыто {p.stats.open} · просрочено {p.stats.overdue}"
                        if p.stats
                        else None
                    ),
                    app_path=f"/projects/{p.key}",
                    is_demo=p.is_demo,
                )
                for p in page
            ],
            truncated=more,
            payload={
                "total": listed.total,
                "offset": args.offset,
                "projects": [self._project_row(p) for p in page],
                "next_offset": args.offset + len(page) if more else None,
            },
        )

    def _tasks(self, principal: WorkPrincipal, args: WorkInspectArgs) -> InspectResult:
        assert args.project is not None
        f = args.filters
        page = self._work.list_tasks(
            principal,
            args.project,
            statuses=frozenset(f.status) if f.status else None,
            q=f.text,
            milestone=f.milestone,
            scheduled=f.scheduled,
            overdue=f.overdue,
            blocked=f.blocked,
            sort="key",
            limit=PAGE_MAX,
        )
        tasks = page.items
        if f.late is not None:
            tasks = [t for t in tasks if t.late == f.late]
        total = len(tasks) if f.late is not None else page.total
        chunk = tasks[args.offset : args.offset + args.limit]
        more = args.offset + len(chunk) < total
        keys = {t.id: t.key for t in tasks}
        effective: dict[str, Any] = {"project": args.project, **f.model_dump(exclude_none=True)}
        effective["plan_revision"] = page.plan_revision
        definitions = [
            f"Задачи проекта {args.project}, ревизия плана {page.plan_revision}, «сегодня» {page.today}."
        ]
        if f.overdue:
            definitions.append("overdue: включительный срок (due) прошёл, задача не завершена.")
        if f.late:
            definitions.append("late: последний день плана прошёл, задача не завершена.")
        if f.blocked:
            definitions.append("blocked: есть незавершённые предшественники FS (вычисляется, это не статус).")
        return InspectResult(
            operation="list_project_tasks",
            label=f"Задачи проекта {args.project}",
            value=total,
            unit="tasks",
            effective_filters=effective,
            definition=" ".join(definitions),
            items=[self._task_item(t, self._task_detail(t)) for t in chunk],
            truncated=more,
            payload={
                "project": args.project,
                "plan_revision": page.plan_revision,
                "today": page.today.isoformat(),
                "total": total,
                "offset": args.offset,
                "tasks": [self._task_row(t, lambda i: keys.get(i, "?")) for t in chunk],
                "next_offset": args.offset + len(chunk) if more else None,
            },
        )

    def _task(self, principal: WorkPrincipal, args: WorkInspectArgs) -> InspectResult:
        assert args.task is not None
        task = self._work.get_task(principal, args.task)
        deps = self._work.dependencies(principal, args.task)
        links = self._work.task_links(principal, args.task)
        row = self._task_row(task, lambda i: i)
        row["waits_for"] = [d.task.key for d in deps.predecessors if d.task.status.value != "done"]
        row["parent"] = None if task.parent_task_id is None else self._parent_key(principal, task)
        row["description"] = _safe(task.description, DESCRIPTION_CHARS) or None
        row["predecessors"] = [{"key": d.task.key, "status": d.task.status.value} for d in deps.predecessors]
        row["successors"] = [{"key": d.task.key, "status": d.task.status.value} for d in deps.successors]
        row["documents"] = [
            {
                "id": link.document.document_id,
                "title": _safe(link.document.title, 160),
                "status": link.document.status,
                "relation": link.relation.value,
                "state": link.state,
            }
            for link in links.items
            if link.document is not None
        ]
        row["documents_unavailable"] = sum(1 for link in links.items if link.document is None)
        row["knowledge_available"] = links.knowledge_available
        return InspectResult(
            operation="get_task",
            label=f"Задача {task.key}",
            value=None,
            effective_filters={"task": task.key, "plan_revision": deps.plan_revision},
            items=[self._task_item(task, self._task_detail(task))],
            payload={"plan_revision": deps.plan_revision, "task": row},
        )

    def _parent_key(self, principal: WorkPrincipal, task: TaskOut) -> str | None:
        assert task.parent_task_id is not None
        try:
            return self._work.get_task(principal, task.parent_task_id).key
        except Exception:  # an archived/hidden parent is simply not named
            return None

    def _dependencies(self, principal: WorkPrincipal, args: WorkInspectArgs) -> InspectResult:
        assert args.task is not None
        deps = self._work.dependencies(principal, args.task)

        def row(item: Any) -> dict[str, Any]:
            return {
                "key": item.task.key,
                "title": _safe(item.task.title, 160),
                "status": item.task.status.value,
                "kind": item.dependency.kind,
                "satisfied": item.dependency.satisfied,
            }

        return InspectResult(
            operation="get_dependencies",
            label=f"Зависимости задачи {args.task}",
            value=len(deps.predecessors) + len(deps.successors),
            unit="dependencies",
            effective_filters={"task": args.task, "plan_revision": deps.plan_revision},
            definition="FS (окончание → начало), лаг 0, внутри проекта. satisfied: выполнена ли по текущим датам "
            "(null — у одной из задач нет дат).",
            payload={
                "task": args.task,
                "plan_revision": deps.plan_revision,
                "predecessors": [row(d) for d in deps.predecessors],
                "successors": [row(d) for d in deps.successors],
            },
        )

    def _schedule(self, principal: WorkPrincipal, args: WorkInspectArgs) -> InspectResult:
        assert args.project is not None
        gantt = self._work.gantt(principal, args.project)
        tasks = gantt.tasks
        keys = {t.id: t.key for t in tasks}
        done = [t for t in tasks if t.status.value == "done"]
        overdue = [t for t in tasks if t.overdue]
        late = [t for t in tasks if t.late and not t.overdue]
        blocked = [t for t in tasks if t.is_blocked]
        unscheduled = [t for t in tasks if not t.scheduled]
        milestones = sorted(
            (t for t in tasks if t.is_milestone and t.start_date and t.status.value != "done"),
            key=lambda t: (t.start_date, t.number),
        )
        by_status: dict[str, int] = {}
        for t in tasks:
            by_status[t.status.value] = by_status.get(t.status.value, 0) + 1
        problem_keys = list(dict.fromkeys([t.key for t in [*overdue, *late, *blocked]]))[:SUMMARY_LIST]
        by_key = {t.key: t for t in tasks}
        return InspectResult(
            operation="get_project_schedule",
            label=f"План проекта {gantt.project_key}",
            value=len(tasks),
            unit="tasks",
            effective_filters={"project": gantt.project_key, "plan_revision": gantt.plan_revision},
            definition=(
                f"Ревизия плана {gantt.plan_revision}, «сегодня» {gantt.today.isoformat()} (часовой пояс проекта), "
                "календарь Пн–Пт без праздников. overdue — прошёл включительный срок; late — прошёл последний день "
                "плана; waiting — ждёт незавершённых предшественников FS. Критический путь не рассчитывается."
            ),
            items=[self._task_item(by_key[k], self._task_detail(by_key[k])) for k in problem_keys],
            truncated=len(set(t.key for t in [*overdue, *late, *blocked])) > len(problem_keys),
            payload={
                "project": gantt.project_key,
                "plan_revision": gantt.plan_revision,
                "today": gantt.today.isoformat(),
                "range": {
                    "start": gantt.range_start.isoformat() if gantt.range_start else None,
                    "end_exclusive": gantt.range_end_exclusive.isoformat()
                    if gantt.range_end_exclusive
                    else None,
                },
                "counts": {
                    "tasks": len(tasks),
                    "by_status": by_status,
                    "done": len(done),
                    "overdue": len(overdue),
                    "late": len(late),
                    "waiting_for_predecessors": len(blocked),
                    "unscheduled": len(unscheduled),
                    "milestones_open": len(milestones),
                    "violated_dependencies": len(gantt.violations),
                },
                "overdue": [self._brief(t) for t in overdue[:SUMMARY_LIST]],
                "late": [self._brief(t) for t in late[:SUMMARY_LIST]],
                "waiting": [
                    {**self._brief(t), "waits_for": [keys.get(i, "?") for i in t.blocked_by]}
                    for t in blocked[:SUMMARY_LIST]
                ],
                "unscheduled": [t.key for t in unscheduled[:SUMMARY_LIST]],
                "next_milestones": [
                    {
                        "key": t.key,
                        "title": _safe(t.title, 160),
                        "date": t.start_date.isoformat() if t.start_date else None,
                    }
                    for t in milestones[:5]
                ],
                "violations": [
                    {
                        "predecessor": keys.get(v.predecessor_id, "?"),
                        "successor": keys.get(v.successor_id, "?"),
                    }
                    for v in gantt.violations[:SUMMARY_LIST]
                ],
                "critical_path": None,
            },
        )

    @staticmethod
    def _brief(task: TaskOut) -> dict[str, Any]:
        return {
            "key": task.key,
            "title": _safe(task.title, 160),
            "status": task.status.value,
            "last_day": task.last_day.isoformat() if task.last_day else None,
            "due": task.due_date.isoformat() if task.due_date else None,
            "assignee": task.assignee.display_name if task.assignee else None,
        }
