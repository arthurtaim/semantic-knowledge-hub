"""Pure scheduler (M6 Step 2): DAG ordering, cycle detection, FS forward pass, conflicts, determinism.
Scenario ids: M6-04, M6-05, M6-08, M6-10, M6-27, M6-28, M6-29; plus 02 §8 «обязательные тесты»."""

from __future__ import annotations

import time
from datetime import date

import pytest

from app.work.calendar import add_workdays, shift_workdays
from app.work.models import ScheduleMode
from app.work.scheduler import (
    CycleError,
    SchedEdge,
    SchedTask,
    cycle_if_added,
    plan,
    topological_order,
    violations,
)

MON = date(2026, 11, 30)


def task(n: int, start: date | None, days: int | None = 1, **kw: object) -> SchedTask:
    end = None
    if start is not None and days is not None:
        end = start if kw.get("milestone") else add_workdays(start, days)
    return SchedTask(id=f"t{n}", number=n, key=f"P-{n}", title=f"Задача {n}", start=start, end=end, **kw)  # type: ignore[arg-type]


def edge(a: int, b: int) -> SchedEdge:
    return SchedEdge(id=f"e{a}-{b}", pred=f"t{a}", succ=f"t{b}")


def as_map(*tasks: SchedTask) -> dict[str, SchedTask]:
    return {t.id: t for t in tasks}


def test_topological_order_is_deterministic_by_number() -> None:
    tasks = as_map(task(3, MON), task(1, MON), task(2, MON), task(4, MON))
    assert topological_order(tasks, [edge(3, 1)]) == ["t2", "t3", "t1", "t4"]
    assert topological_order(tasks, []) == ["t1", "t2", "t3", "t4"]


def test_m6_05_cycle_is_detected_with_a_concrete_path() -> None:
    tasks = as_map(task(1, MON), task(2, MON), task(3, MON))
    with pytest.raises(CycleError) as info:
        topological_order(tasks, [edge(1, 2), edge(2, 3), edge(3, 1)])
    assert info.value.cycle[0] == info.value.cycle[-1]
    assert set(info.value.cycle) == {"t1", "t2", "t3"}
    assert cycle_if_added([edge(1, 2), edge(2, 3)], "t3", "t1") == ["t3", "t1", "t2", "t3"]
    assert cycle_if_added([edge(1, 2)], "t1", "t3") is None
    assert cycle_if_added([], "t1", "t1") == ["t1", "t1"]


def test_m6_04_shift_successors_moves_b_to_the_earliest_fs_start() -> None:
    a, b = task(1, MON, 2), task(2, date(2026, 12, 2), 3)
    result = plan(
        as_map(a, b),
        [edge(1, 2)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (MON, date(2026, 12, 4))},
    )
    assert [(o.task_id, o.change) for o in result.operations] == [("t1", "requested"), ("t2", "shifted")]
    shifted = result.operations[1]
    assert shifted.after.start_date == date(2026, 12, 4)  # A ends exclusive Fri 4 → B may start Fri 4
    assert shifted.after.duration_workdays == 3 and shifted.because_of == ["t1"]
    assert result.can_apply


def test_m6_09_friday_predecessor_pushes_successor_to_monday() -> None:
    fri = date(2026, 11, 27)
    a, b = task(1, date(2026, 11, 26), 1), task(2, date(2026, 11, 27), 1)
    result = plan(
        as_map(a, b),
        [edge(1, 2)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (fri, date(2026, 11, 28))},
    )
    assert result.operations[1].after.start_date == MON  # not Saturday 2026-11-28
    assert result.operations[1].after.end_exclusive == date(2026, 12, 1)


def test_m6_28_diamond_shifts_the_join_once_and_leaves_independent_tasks() -> None:
    #   A → B → D,  A → C → D ;  E independent
    a = task(1, MON, 1)
    b = task(2, date(2026, 12, 1), 1)
    c = task(3, date(2026, 12, 1), 3)
    d = task(4, date(2026, 12, 4), 1)
    e = task(5, MON, 2)
    edges = [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4)]
    result = plan(
        as_map(a, b, c, d, e),
        edges,
        mode=ScheduleMode.shift_successors,
        changes={"t1": (date(2026, 12, 1), date(2026, 12, 2))},
    )
    ops = {o.task_id: o for o in result.operations}
    assert set(ops) == {"t1", "t2", "t3", "t4"}  # E untouched
    assert ops["t3"].after.end_exclusive == date(2026, 12, 5)  # C: Wed–Fri → ends Sat
    assert ops["t4"].after.start_date == date(2026, 12, 7)  # max(B end, C end) → Mon, once
    assert sum(1 for o in result.operations if o.task_id == "t4") == 1
    assert "t5" not in result.unchanged  # not even checked: an independent branch


def test_no_pull_back_when_the_predecessor_moves_earlier() -> None:
    a, b = task(1, date(2026, 12, 7), 1), task(2, date(2026, 12, 8), 1)
    result = plan(
        as_map(a, b),
        [edge(1, 2)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (MON, date(2026, 12, 1))},
    )
    assert [o.task_id for o in result.operations] == ["t1"]
    assert result.unchanged == ["t2"]


def test_m6_29_locked_successor_is_a_conflict_and_never_moves() -> None:
    a, b = task(1, MON, 1), task(2, date(2026, 12, 1), 1, locked=True)
    c = task(3, date(2026, 12, 2), 1)
    result = plan(
        as_map(a, b, c),
        [edge(1, 2), edge(2, 3)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (MON, date(2026, 12, 3))},
    )
    assert [c.code for c in result.conflicts] == ["locked_successor"]
    assert result.conflicts[0].task_id == "t2" and result.conflicts[0].related_task_ids == ["t1"]
    assert "t2" not in {o.task_id for o in result.operations}
    assert not result.can_apply


def test_m6_08_requested_task_before_its_predecessor_is_a_conflict() -> None:
    a, b = task(1, MON, 3), task(2, date(2026, 12, 3), 1)
    result = plan(
        as_map(a, b),
        [edge(1, 2)],
        mode=ScheduleMode.shift_successors,
        changes={"t2": (MON, date(2026, 12, 1))},
    )
    assert [c.code for c in result.conflicts] == ["requested_violates_predecessor"]


def test_requested_locked_task_is_a_conflict() -> None:
    a = task(1, MON, 1, locked=True)
    result = plan(
        as_map(a),
        [],
        mode=ScheduleMode.only_this_task,
        changes={"t1": (date(2026, 12, 1), date(2026, 12, 2))},
    )
    assert [c.code for c in result.conflicts] == ["task_locked"]
    assert result.operations == []


def test_only_this_task_refuses_to_break_successors() -> None:
    a, b = task(1, MON, 1), task(2, date(2026, 12, 1), 1)
    result = plan(
        as_map(a, b), [edge(1, 2)], mode=ScheduleMode.only_this_task, changes={"t1": (MON, date(2026, 12, 3))}
    )
    assert [c.code for c in result.conflicts] == ["successor_violation"]
    assert [o.task_id for o in result.operations] == ["t1"]  # shown, but apply is refused
    ok = plan(
        as_map(a, b), [edge(1, 2)], mode=ScheduleMode.only_this_task, changes={"t1": (MON, date(2026, 12, 1))}
    )
    assert ok.conflicts == [] and ok.operations == []  # unchanged dates → nothing to do


def test_m6_10_milestone_stays_a_point_and_passes_fs() -> None:
    a = task(1, MON, 2)
    m = task(2, date(2026, 12, 2), milestone=True)
    b = task(3, date(2026, 12, 2), 1)
    result = plan(
        as_map(a, m, b),
        [edge(1, 2), edge(2, 3)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (MON, date(2026, 12, 4))},
    )
    ops = {o.task_id: o for o in result.operations}
    assert ops["t2"].after.start_date == ops["t2"].after.end_exclusive == date(2026, 12, 4)
    assert ops["t2"].after.duration_workdays == 0
    assert ops["t3"].after.start_date == date(2026, 12, 4)  # may start on the milestone day


def test_m6_27_unscheduled_tasks_get_no_invented_dates() -> None:
    a, u, b = task(1, MON, 1), task(2, None, None), task(3, date(2026, 12, 1), 1)
    c = task(4, MON, 4)
    result = plan(
        as_map(a, u, b, c),
        [edge(1, 2), edge(2, 3), edge(4, 3)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (MON, date(2026, 12, 3))},
    )
    ops = {o.task_id: o for o in result.operations}
    assert "t2" not in ops
    reasons = {(b.task_id, b.reason) for b in result.blocked}
    assert ("t2", "unscheduled") in reasons and ("t3", "predecessor_unscheduled") in reasons
    assert ops["t3"].after.start_date == date(2026, 12, 4)  # the KNOWN constraint C → B still applies
    result2 = plan(as_map(a, u, b, c), [edge(2, 3), edge(4, 3)], mode=ScheduleMode.resolve_violations)
    assert {o.task_id: o.after.start_date for o in result2.operations} == {"t3": date(2026, 12, 4)}


def test_resolve_violations_fixes_existing_breaks_only() -> None:
    a, b, c = task(1, MON, 3), task(2, MON, 1), task(3, date(2026, 12, 10), 1)
    edges = [edge(1, 2), edge(2, 3)]
    assert [v.successor_id for v in violations(as_map(a, b, c), edges)] == ["t2"]
    result = plan(as_map(a, b, c), edges, mode=ScheduleMode.resolve_violations)
    assert [(o.task_id, o.after.start_date) for o in result.operations] == [("t2", date(2026, 12, 3))]


def test_due_date_warning_does_not_move_the_deadline() -> None:
    a = task(1, MON, 1)
    b = task(2, date(2026, 12, 1), 1, due=date(2026, 12, 1))
    result = plan(
        as_map(a, b),
        [edge(1, 2)],
        mode=ScheduleMode.shift_successors,
        changes={"t1": (MON, date(2026, 12, 2))},
    )
    assert [(w.code, w.task_id, w.due_date, w.last_day) for w in result.warnings] == [
        ("due_date_exceeded", "t2", date(2026, 12, 1), date(2026, 12, 2))
    ]
    assert result.can_apply  # a warning needs confirmation, not a conflict


def test_added_edges_take_part_and_disconnected_graphs_are_untouched() -> None:
    a, b, x, y = task(1, MON, 3), task(2, MON, 1), task(3, MON, 1), task(4, date(2026, 12, 1), 1)
    result = plan(
        as_map(a, b, x, y), [edge(3, 4)], mode=ScheduleMode.shift_successors, added_edges=[edge(1, 2)]
    )
    assert [(o.task_id, o.after.start_date) for o in result.operations] == [("t2", date(2026, 12, 3))]


def test_same_input_same_hashes_and_order() -> None:
    tasks = as_map(*(task(i, MON, 1) for i in range(1, 30)))
    edges = [edge(i, i + 1) for i in range(1, 29)]
    first = plan(tasks, edges, mode=ScheduleMode.resolve_violations)
    second = plan(
        dict(reversed(list(tasks.items()))), list(reversed(edges)), mode=ScheduleMode.resolve_violations
    )
    assert first.input_hash == second.input_hash and first.result_hash == second.result_hash
    assert [o.task_id for o in first.operations] == [o.task_id for o in second.operations]
    changed = task(5, MON, 2)
    third = plan({**tasks, "t5": changed}, edges, mode=ScheduleMode.resolve_violations)
    assert third.input_hash != first.input_hash


def test_long_chain_of_1000_tasks_is_linear_and_exact() -> None:
    n = 1000
    tasks = as_map(*(task(i, MON, 1) for i in range(1, n + 1)))
    edges = [edge(i, i + 1) for i in range(1, n)]
    started = time.perf_counter()
    result = plan(tasks, edges, mode=ScheduleMode.resolve_violations)
    elapsed = time.perf_counter() - started
    assert len(result.operations) == n - 1
    assert result.operations[-1].after.start_date == shift_workdays(MON, n - 1)  # one working day each
    assert elapsed < 5.0, elapsed  # generous bound; the measured value is in reports/README.md
