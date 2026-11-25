"""Deterministic Finish-to-Start scheduling over a DAG (M6 Step 2). Pure functions: no I/O, no clock.

Contract (docs/WORK_MANAGEMENT.md «Планирование»):

1. The dependency graph of one project is a DAG (cycles are rejected before anything is computed).
2. Topological order is Kahn's algorithm with a heap keyed by (task number, task id) → identical input gives an
   identical order, operations list and hashes.
3. Forward pass, push-only: a task in the affected set whose start is before the earliest FS start of its scheduled
   predecessors moves to exactly that earliest start; its working-day duration is kept (a milestone stays a point).
   Tasks are never pulled earlier, independent branches are never touched, and each task is visited once — in a
   diamond A→B, A→C, B→D, C→D the task D moves once, to the max of both constraints.
4. Unscheduled tasks (no dates) are never given invented dates: they and their successors are reported in
   `blocked_tasks` and the constraints that ARE known still apply.
5. A locked task, a requested task that would violate its predecessors, or any violation in `only_this_task` mode is
   a CONFLICT: the preview still shows the computed operations but apply is refused.

Complexity: O((V + E) log V) for the ordering, O(V + E) for the pass — linear in practice for thousands of tasks.
"""

from __future__ import annotations

import hashlib
import heapq
import json
from collections import defaultdict, deque
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date

from app.work.calendar import (
    CALENDAR_ID,
    add_workdays,
    count_workdays,
    fs_earliest_start,
    last_workday,
)
from app.work.models import (
    BlockedTask,
    IntervalOut,
    ScheduleConflict,
    ScheduleMode,
    ScheduleOperation,
    ScheduleWarning,
    Violation,
)


@dataclass(frozen=True)
class SchedTask:
    id: str
    number: int
    key: str
    title: str
    start: date | None
    end: date | None  # exclusive
    milestone: bool = False
    locked: bool = False
    due: date | None = None
    version: int = 1

    @property
    def scheduled(self) -> bool:
        return self.start is not None and self.end is not None


@dataclass(frozen=True)
class SchedEdge:
    id: str
    pred: str
    succ: str
    lag: int = 0


class CycleError(Exception):
    def __init__(self, cycle: list[str]) -> None:
        super().__init__("dependency cycle: " + " -> ".join(cycle))
        self.cycle = cycle


@dataclass
class PlanResult:
    mode: ScheduleMode
    operations: list[ScheduleOperation]
    conflicts: list[ScheduleConflict]
    warnings: list[ScheduleWarning]
    blocked: list[BlockedTask]
    unchanged: list[str]
    input_hash: str
    result_hash: str
    new_intervals: dict[str, tuple[date, date]] = field(default_factory=dict)

    @property
    def can_apply(self) -> bool:
        return not self.conflicts


def interval(start: date | None, end: date | None, milestone: bool) -> IntervalOut:
    if start is None or end is None:
        return IntervalOut(start_date=None, end_exclusive=None, last_day=None, duration_workdays=None)
    if milestone:
        return IntervalOut(start_date=start, end_exclusive=end, last_day=None, duration_workdays=0)
    return IntervalOut(
        start_date=start,
        end_exclusive=end,
        last_day=last_workday(start, end),
        duration_workdays=count_workdays(start, end),
    )


def _adjacency(edges: Iterable[SchedEdge]) -> tuple[dict[str, list[SchedEdge]], dict[str, list[SchedEdge]]]:
    preds: dict[str, list[SchedEdge]] = defaultdict(list)
    succs: dict[str, list[SchedEdge]] = defaultdict(list)
    for edge in edges:
        preds[edge.succ].append(edge)
        succs[edge.pred].append(edge)
    return preds, succs


def topological_order(tasks: Mapping[str, SchedTask], edges: Sequence[SchedEdge]) -> list[str]:
    """Kahn's algorithm, ties broken by (number, id). Raises CycleError with one concrete cycle."""
    indegree = dict.fromkeys(tasks, 0)
    succs: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge.pred not in tasks or edge.succ not in tasks:
            continue
        indegree[edge.succ] += 1
        succs[edge.pred].append(edge.succ)
    heap = [(tasks[t].number, t) for t, d in indegree.items() if d == 0]
    heapq.heapify(heap)
    order: list[str] = []
    while heap:
        _, current = heapq.heappop(heap)
        order.append(current)
        for nxt in succs[current]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                heapq.heappush(heap, (tasks[nxt].number, nxt))
    if len(order) != len(tasks):
        remaining = {t for t, d in indegree.items() if d > 0}
        raise CycleError(_find_cycle(remaining, succs, tasks))
    return order


def _find_cycle(nodes: set[str], succs: Mapping[str, list[str]], tasks: Mapping[str, SchedTask]) -> list[str]:
    """One cycle among `nodes` (iterative DFS, deterministic start), as [a, b, …, a]."""
    color: dict[str, int] = {}
    for root in sorted(nodes, key=lambda t: (tasks[t].number, t)):
        if color.get(root):
            continue
        stack: list[tuple[str, int]] = [(root, 0)]
        path: list[str] = []
        while stack:
            node, index = stack.pop()
            if index == 0:
                color[node] = 1
                path.append(node)
            children = sorted(
                (n for n in succs.get(node, ()) if n in nodes), key=lambda t: (tasks[t].number, t)
            )
            if index < len(children):
                stack.append((node, index + 1))
                child = children[index]
                if color.get(child) == 1:
                    return [*path[path.index(child) :], child]
                if not color.get(child):
                    stack.append((child, 0))
            else:
                color[node] = 2
                path.pop()
    return []


def cycle_if_added(edges: Sequence[SchedEdge], pred: str, succ: str) -> list[str] | None:
    """The cycle the new edge pred→succ would close (a path succ ⇝ pred exists), as [pred, succ, …, pred]."""
    if pred == succ:
        return [pred, pred]
    nexts: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        nexts[edge.pred].append(edge.succ)
    parent: dict[str, str | None] = {succ: None}
    queue = deque([succ])
    while queue:
        node = queue.popleft()
        if node == pred:
            path = [node]
            while parent[path[-1]] is not None:
                path.append(parent[path[-1]])  # type: ignore[arg-type]
            path.reverse()  # succ … pred
            return [pred, *path]
        for nxt in sorted(nexts.get(node, ())):
            if nxt not in parent:
                parent[nxt] = node
                queue.append(nxt)
    return None


def violations(tasks: Mapping[str, SchedTask], edges: Iterable[SchedEdge]) -> list[Violation]:
    """FS constraints broken by the stored dates (both ends scheduled), sorted deterministically."""
    found: list[Violation] = []
    for edge in edges:
        pred, succ = tasks.get(edge.pred), tasks.get(edge.succ)
        if pred is None or succ is None or pred.end is None or succ.start is None:
            continue
        earliest = fs_earliest_start(pred.end, edge.lag)
        if succ.start < earliest:
            found.append(
                Violation(
                    dependency_id=edge.id,
                    predecessor_id=edge.pred,
                    successor_id=edge.succ,
                    earliest_start=earliest,
                    actual_start=succ.start,
                )
            )
    found.sort(key=lambda v: (tasks[v.successor_id].number, tasks[v.predecessor_id].number))
    return found


def input_hash(tasks: Mapping[str, SchedTask], edges: Iterable[SchedEdge]) -> str:
    """Fingerprint of everything the schedule depends on (calendar, dates, flags, versions, edges)."""
    payload = {
        "calendar": CALENDAR_ID,
        "tasks": sorted(
            [
                t.id,
                t.start.isoformat() if t.start else None,
                t.end.isoformat() if t.end else None,
                t.milestone,
                t.locked,
                t.due.isoformat() if t.due else None,
                t.version,
            ]
            for t in tasks.values()
        ),
        "edges": sorted([e.pred, e.succ, e.lag] for e in edges),
    }
    return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode("utf-8")).hexdigest()


def _descendants(seeds: Iterable[str], succs: Mapping[str, list[SchedEdge]]) -> set[str]:
    seen: set[str] = set()
    queue = deque(seeds)
    while queue:
        node = queue.popleft()
        for edge in succs.get(node, ()):
            if edge.succ not in seen:
                seen.add(edge.succ)
                queue.append(edge.succ)
    return seen


def plan(
    tasks: Mapping[str, SchedTask],
    edges: Sequence[SchedEdge],
    *,
    mode: ScheduleMode,
    changes: Mapping[str, tuple[date, date]] | None = None,
    added_edges: Sequence[SchedEdge] = (),
) -> PlanResult:
    """Compute the preview diff. `changes` are already validated, canonical intervals of existing tasks;
    `added_edges` are validated new FS edges. Raises CycleError when the edges are not a DAG."""
    changes = dict(changes or {})
    all_edges = [*edges, *added_edges]
    order = topological_order(tasks, all_edges)
    preds, succs = _adjacency(e for e in all_edges if e.pred in tasks and e.succ in tasks)
    state: dict[str, tuple[date | None, date | None]] = {t.id: (t.start, t.end) for t in tasks.values()}
    conflicts: list[ScheduleConflict] = []
    blocked: list[BlockedTask] = []

    def key(task_id: str) -> str:
        return tasks[task_id].key

    def sort_ids(ids: Iterable[str]) -> list[str]:
        return sorted(set(ids), key=lambda t: (tasks[t].number, t))

    fixed: set[str] = set()
    for task_id, (start, end) in changes.items():
        task = tasks[task_id]
        if task.locked:
            conflicts.append(
                ScheduleConflict(
                    code="task_locked",
                    task_id=task_id,
                    key=key(task_id),
                    related_task_ids=[],
                    message=f"{key(task_id)}: даты закреплены (date_locked) — сначала снимите закрепление.",
                )
            )
            continue
        state[task_id] = (start, end)
        fixed.add(task_id)

    if mode == ScheduleMode.resolve_violations:
        affected = set(tasks)
    else:
        seeds = set(changes) | {e.pred for e in added_edges}
        if mode == ScheduleMode.shift_successors:
            affected = _descendants(seeds, succs) | fixed
        else:  # only_this_task: check the direct neighbours, never move them
            affected = {e.succ for s in seeds for e in succs.get(s, ())} | fixed
        affected |= {e.succ for e in added_edges}
    allow_shift = mode != ScheduleMode.only_this_task
    shifted: dict[str, list[str]] = {}

    for task_id in order:
        if task_id not in affected:
            continue
        task = tasks[task_id]
        cur_start, cur_end = state[task_id]
        incoming = preds.get(task_id, [])
        if cur_start is None or cur_end is None:
            if incoming or succs.get(task_id) or mode != ScheduleMode.resolve_violations:
                blocked.append(
                    BlockedTask(
                        task_id=task_id,
                        key=key(task_id),
                        reason="unscheduled",
                        related_task_ids=[],
                        message=f"{key(task_id)}: нет дат — планировщик не придумывает даты; расчёт для этой задачи остановлен.",
                    )
                )
            continue
        earliest: date | None = None
        binding: list[str] = []
        unknown: list[str] = []
        for edge in incoming:
            _, pred_end = state[edge.pred]
            if pred_end is None:
                unknown.append(edge.pred)
                continue
            candidate = fs_earliest_start(pred_end, edge.lag)
            if earliest is None or candidate > earliest:
                earliest, binding = candidate, [edge.pred]
            elif candidate == earliest:
                binding.append(edge.pred)
        if unknown:
            blocked.append(
                BlockedTask(
                    task_id=task_id,
                    key=key(task_id),
                    reason="predecessor_unscheduled",
                    related_task_ids=sort_ids(unknown),
                    message=f"{key(task_id)}: у предшественников "
                    + ", ".join(key(t) for t in sort_ids(unknown))
                    + " нет дат — их ограничение не учтено.",
                )
            )
        if earliest is None or cur_start >= earliest:
            continue
        related = sort_ids(binding)
        names = ", ".join(key(t) for t in related)
        if task_id in fixed:
            conflicts.append(
                ScheduleConflict(
                    code="requested_violates_predecessor",
                    task_id=task_id,
                    key=key(task_id),
                    related_task_ids=related,
                    message=f"{key(task_id)} не может начаться раньше {earliest.isoformat()}: зависит (FS) от {names}.",
                )
            )
            continue
        if not allow_shift:
            conflicts.append(
                ScheduleConflict(
                    code="successor_violation",
                    task_id=task_id,
                    key=key(task_id),
                    related_task_ids=related,
                    message=f"{key(task_id)} начинается раньше окончания {names}: выберите «сдвинуть зависимые».",
                )
            )
            continue
        if task.locked:
            conflicts.append(
                ScheduleConflict(
                    code="locked_successor",
                    task_id=task_id,
                    key=key(task_id),
                    related_task_ids=related,
                    message=f"{key(task_id)} закреплена (date_locked), но должна сдвинуться на {earliest.isoformat()} "
                    f"из-за {names}.",
                )
            )
            continue
        new_start = earliest
        new_end = (
            new_start
            if task.milestone
            else add_workdays(new_start, max(1, count_workdays(cur_start, cur_end)))
        )
        state[task_id] = (new_start, new_end)
        shifted[task_id] = related

    operations: list[ScheduleOperation] = []
    warnings: list[ScheduleWarning] = []
    new_intervals: dict[str, tuple[date, date]] = {}
    for task_id in sort_ids([*fixed, *shifted]):
        task = tasks[task_id]
        final_start, final_end = state[task_id]
        if final_start is None or final_end is None or (final_start, final_end) == (task.start, task.end):
            continue
        new_intervals[task_id] = (final_start, final_end)
        before = interval(task.start, task.end, task.milestone)
        after = interval(final_start, final_end, task.milestone)
        delta = 0
        if task.start is not None:
            delta = (
                count_workdays(task.start, final_start)
                if final_start >= task.start
                else -count_workdays(final_start, task.start)
            )
        operations.append(
            ScheduleOperation(
                task_id=task_id,
                key=task.key,
                title=task.title,
                change="shifted" if task_id in shifted else "requested",
                before=before,
                after=after,
                shift_workdays=delta,
                reason="fs_predecessor" if task_id in shifted else "requested",
                because_of=shifted.get(task_id, []),
                version=task.version,
            )
        )
        point = final_start if task.milestone else after.last_day
        if task.due is not None and point is not None and point > task.due:
            warnings.append(
                ScheduleWarning(
                    code="due_date_exceeded",
                    task_id=task_id,
                    key=task.key,
                    due_date=task.due,
                    last_day=point,
                    message=f"{task.key}: новый срок {point.isoformat()} позже дедлайна {task.due.isoformat()} "
                    "(дедлайн не меняется автоматически).",
                )
            )
    changed = {op.task_id for op in operations}
    unchanged = [t for t in sort_ids(affected) if t not in changed]
    blocked.sort(key=lambda b: (tasks[b.task_id].number, b.reason))
    conflicts.sort(key=lambda c: (tasks[c.task_id].number, c.code))
    result_payload = {
        "mode": mode.value,
        "operations": [[op.task_id, op.after.model_dump(mode="json"), op.version] for op in operations],
        "conflicts": [[c.task_id, c.code] for c in conflicts],
        "warnings": [[w.task_id, w.code] for w in warnings],
        "added": sorted([e.pred, e.succ, e.lag] for e in added_edges),
    }
    return PlanResult(
        mode=mode,
        operations=operations,
        conflicts=conflicts,
        warnings=warnings,
        blocked=blocked,
        unchanged=unchanged,
        input_hash=input_hash(tasks, edges),
        result_hash=hashlib.sha256(
            json.dumps(result_payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).hexdigest(),
        new_intervals=new_intervals,
    )
