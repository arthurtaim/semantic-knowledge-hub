"""Deterministic M6 performance probe (no network, no AI): `python -m app.evaluation.work_bench [--tasks N]`.

Builds a throw-away work.sqlite3 with one project of N synthetic tasks (chains of 10 with cross edges between
chains, ~1.2 dependencies per task), then times the service operations the UI uses — list (200 rows), Gantt snapshot
(all tasks), schedule preview of the first task (shift_successors through its chain) and its atomic apply, and a
single-task edit. Prints p50/p95 in milliseconds and the machine. Numbers are measurements of THIS machine, not
promises (docs/WORK_MANAGEMENT.md «Производительность»).
"""

from __future__ import annotations

import argparse
import platform
import statistics
import tempfile
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path

from app.domain.models import UserContext
from app.work import store
from app.work.calendar import add_workdays, shift_workdays
from app.work.db import WorkDatabase
from app.work.models import (
    ProjectCreate,
    ScheduleApplyRequest,
    SchedulePreviewRequest,
    TaskDateChange,
    TaskUpdate,
)
from app.work.permissions import WorkAccessGate, WorkAccessMode, WorkPrincipal
from app.work.service import WorkService

OPERATOR = UserContext(user_id="local-demo-user", display_name="bench", is_demo=True)
P = WorkPrincipal(user=OPERATOR, request_id="bench")
START = date(2026, 11, 30)


def _populate(svc: WorkService, n: int) -> str:
    project = svc.create_project(P, ProjectCreate(key="BENCH", title="Benchmark"))
    at = store.now_iso()
    with svc.db.write() as conn:
        ids: list[str] = []
        for i in range(n):
            number = store.allocate_task_number(conn, project.id)
            start = shift_workdays(START, (i % 10) * 2)
            task_id = f"bench{i:06d}"
            ids.append(task_id)
            store.insert_task(
                conn,
                {
                    "id": task_id,
                    "project_id": project.id,
                    "number": number,
                    "title": f"Синтетическая задача {i}",
                    "status": ("todo", "in_progress", "review", "done")[i % 4],
                    "priority": "medium",
                    "start_date": start.isoformat(),
                    "end_exclusive": add_workdays(start, 2).isoformat(),
                    "sort_order": number * 1024,
                    "created_by": "bench",
                    "created_at": at,
                    "updated_by": "bench",
                    "updated_at": at,
                },
            )
        edges = 0
        for i in range(n):
            if i % 10 != 9 and i + 1 < n:  # chains of 10
                store.insert_dependency(conn, _edge(project.id, ids[i], ids[i + 1], at))
                edges += 1
            if i % 10 == 0 and i + 15 < n:  # cross edge into the middle of the next chain
                store.insert_dependency(conn, _edge(project.id, ids[i], ids[i + 15], at))
                edges += 1
        store.bump_plan_revision(conn, project.id)
    return project.id


def _edge(project_id: str, pred: str, succ: str, at: str) -> dict[str, object]:
    return {
        "id": f"{pred}-{succ}",
        "project_id": project_id,
        "predecessor_id": pred,
        "successor_id": succ,
        "kind": "FS",
        "lag_workdays": 0,
        "created_by": "bench",
        "created_at": at,
    }


def _timed(fn: Callable[[], object], repeat: int) -> tuple[float, float]:
    samples = []
    for _ in range(repeat):
        started = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - started) * 1000)
    samples.sort()
    p95 = samples[max(0, round(0.95 * len(samples)) - 1)]
    return statistics.median(samples), p95


def run(tasks: int, repeat: int) -> list[tuple[str, float, float]]:
    with tempfile.TemporaryDirectory() as tmp:
        svc = WorkService(
            WorkDatabase(Path(tmp) / "work.sqlite3"),
            WorkAccessGate(WorkAccessMode.local_operator),
            operator=OPERATOR,
        )
        project_id = _populate(svc, tasks)
        results = [
            ("list 200 tasks", *_timed(lambda: svc.list_tasks(P, project_id, limit=200), repeat)),
            (f"gantt snapshot ({tasks} tasks)", *_timed(lambda: svc.gantt(P, project_id), repeat)),
        ]
        change = SchedulePreviewRequest(
            changes=[TaskDateChange(task_id="bench000000", start_date=START, duration_workdays=6)]
        )
        results.append(
            ("schedule preview (chain shift)", *_timed(lambda: svc.preview(P, project_id, change), repeat))
        )
        counter = iter(range(10**6))

        def preview_apply() -> None:
            # move the first task further each round, so every apply really writes a chain
            n = next(counter)
            pv = svc.preview(
                P,
                project_id,
                SchedulePreviewRequest(
                    changes=[TaskDateChange(task_id="bench000000", start_date=START, duration_workdays=7 + n)]
                ),
            )
            svc.apply(
                P,
                project_id,
                ScheduleApplyRequest(
                    preview_id=pv.preview_id,
                    expected_plan_revision=pv.base_plan_revision,
                    client_request_id=f"bench-apply-{n:06d}",
                    accept_warnings=True,
                ),
            )

        results.append(("preview + apply (chain shift)", *_timed(preview_apply, max(3, repeat // 4))))
        version = svc.get_task(P, "BENCH-500" if tasks >= 500 else "BENCH-1").version
        state = {"v": version}

        def edit() -> None:
            out = svc.update_task(
                P,
                "BENCH-500" if tasks >= 500 else "BENCH-1",
                TaskUpdate(expected_version=state["v"], title=f"t{state['v']}"),
            )
            state["v"] = out.version

        results.append(("edit one task (PATCH)", *_timed(edit, repeat)))
        return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="M6 work module performance probe (synthetic, offline)")
    parser.add_argument("--tasks", type=int, default=1000)
    parser.add_argument("--repeat", type=int, default=20)
    args = parser.parse_args(argv)
    print(
        f"machine: {platform.platform()} · python {platform.python_version()} · tasks={args.tasks} repeat={args.repeat}"
    )
    for name, p50, p95 in run(args.tasks, args.repeat):
        print(f"{name:<36} p50={p50:8.1f} ms   p95={p95:8.1f} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
