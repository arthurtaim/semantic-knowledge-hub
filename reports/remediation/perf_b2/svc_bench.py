"""B2 service-level planner benchmark (in-process, throw-away SQLite in a temp dir, no network, no AI).

Run with cwd = <checkout>/backend:  ../.venv/bin/python <this> OUT.json [--profile]
Data per size N (25 / 200 / 1000): project LD with N tasks in FS chains of 10 (like the audit's load fixture),
4 more projects with N tasks each (list_projects), 6 audit events per task. Every operation: 3 warm-up calls, then
RUNS timed calls (median / p95 / max). Derived from perf_probe_a.py of the code audit.
"""

from __future__ import annotations

import cProfile
import io
import json
import os
import platform
import pstats
import statistics
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

from app.domain.models import UserContext  # noqa: E402
from app.work import store  # noqa: E402
from app.work.calendar import add_workdays, shift_workdays  # noqa: E402
from app.work.db import WorkDatabase  # noqa: E402
from app.work.links import DocumentScope  # noqa: E402
from app.work.models import ProjectCreate, SchedulePreviewRequest, TaskDateChange, TaskUpdate  # noqa: E402
from app.work.permissions import WorkAccessGate, WorkAccessMode, WorkPrincipal  # noqa: E402
from app.work.service import WorkService  # noqa: E402

OP = UserContext(user_id="local-demo-user", display_name="perf", is_demo=True)
P = WorkPrincipal(user=OP, request_id="perf", documents=DocumentScope(available=True, documents={}))
START = date(2026, 12, 7)
RUNS = int(os.environ.get("RUNS", "30"))
STATUSES = ("todo", "in_progress", "review", "done")
PRIOS = ("low", "medium", "high", "critical")


def populate(svc: WorkService, key: str, n: int, *, chains: bool, audit_per_task: int) -> tuple[str, list[str]]:
    project = svc.create_project(P, ProjectCreate(key=key, title=key))
    at = store.now_iso()
    ids: list[str] = []
    with svc.db.write() as conn:
        prev = None
        for i in range(n):
            number = store.allocate_task_number(conn, project.id)
            pos = i % 10
            start = shift_workdays(START, pos)
            tid = f"{key.lower()}{i:06d}"
            ids.append(tid)
            store.insert_task(conn, {
                "id": tid, "project_id": project.id, "number": number, "title": f"Нагрузка {i}",
                "status": STATUSES[i % 4] if i % 3 else "todo", "priority": PRIOS[i % 4],
                "start_date": start.isoformat(),
                "end_exclusive": start.isoformat() if i % 50 == 49 else add_workdays(start, 1).isoformat(),
                "due_date": START.isoformat() if i % 7 == 0 else None,
                "is_milestone": 1 if i % 50 == 49 else 0, "date_locked": 0, "sort_order": number * 1024,
                "is_demo": 0, "created_by": "perf", "created_at": at, "updated_by": "perf", "updated_at": at,
            })
            if chains and pos > 0 and prev is not None:
                store.insert_dependency(conn, {"id": f"d{tid}", "project_id": project.id, "predecessor_id": prev,
                                               "successor_id": tid, "kind": "FS", "lag_workdays": 0,
                                               "created_by": "perf", "created_at": at})
            for j in range(audit_per_task):
                store.insert_audit(conn, at=at, actor_id="perf", operation="task_updated", entity_type="task",
                                   entity_id=tid, project_id=project.id, task_id=tid, correlation_id=None,
                                   changes={"priority": {"before": "low", "after": PRIOS[j % 4]}},
                                   related_task_id=prev if j == 0 else None)
            prev = tid
    return project.id, ids


def timed(fn, runs: int = RUNS) -> dict[str, float]:
    for _ in range(3):
        fn()
    samples = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    p95 = samples[min(len(samples) - 1, round(0.95 * (len(samples) - 1)))]
    return {"p50": round(statistics.median(samples), 2), "p95": round(p95, 2), "max": round(samples[-1], 2), "n": runs}


def profile(fn, label: str, out: list[str]) -> None:
    pr = cProfile.Profile()
    pr.enable()
    for _ in range(5):
        fn()
    pr.disable()
    s = io.StringIO()
    pstats.Stats(pr, stream=s).sort_stats("cumulative").print_stats(18)
    out.append(f"===== {label} =====\n" + s.getvalue())


def main() -> None:
    out_path = Path(sys.argv[1])
    want_profile = "--profile" in sys.argv
    sizes = [int(x) for x in os.environ.get("SIZES", "25,200,1000").split(",")]
    result: dict[str, object] = {"machine": platform.platform(), "python": platform.python_version(),
                                 "loadavg_start": os.getloadavg(), "runs": RUNS, "sizes": {}}
    profiles: list[str] = []
    for n in sizes:
        with tempfile.TemporaryDirectory() as tmp:
            db = WorkDatabase(Path(tmp) / "work.sqlite3")
            svc = WorkService(db, WorkAccessGate(WorkAccessMode.local_operator), operator=OP)
            _, ids = populate(svc, "LD", n, chains=True, audit_per_task=int(os.environ.get("AUDIT_PER_TASK", "6")))
            for k in ("PB", "PC", "PD", "PE"):
                populate(svc, k, n, chains=False, audit_per_task=1)
            head = ids[0]
            mid = ids[len(ids) // 2]
            state = {"i": 0}

            def patch() -> None:
                t = svc.get_task(P, mid)
                state["i"] += 1
                svc.update_task(P, mid, TaskUpdate(expected_version=t.version, priority=PRIOS[state["i"] % 4]))

            def patch_only() -> None:
                # The PATCH alone: the version is read with a cheap SQL lookup outside the timed service call.
                with svc.db.read() as conn:
                    version = int(store.get_task(conn, mid)["version"])
                state["i"] += 1
                svc.update_task(P, mid, TaskUpdate(expected_version=version, priority=PRIOS[state["i"] % 4]))

            req = SchedulePreviewRequest(changes=[TaskDateChange(task_id=head, start_date=shift_workdays(START, 2),
                                                                 duration_workdays=2)])
            ops = {
                "list_projects": lambda: svc.list_projects(P),
                "get_project": lambda: svc.get_project(P, "LD"),
                "list_tasks_200": lambda: svc.list_tasks(P, "LD", limit=200),
                "gantt": lambda: svc.gantt(P, "LD"),
                "get_task": lambda: svc.get_task(P, mid),
                "update_task": patch_only,
                "preview": lambda: svc.preview(P, "LD", req),
                "task_activity": lambda: svc.task_activity(P, mid),
                "gantt_json": lambda: svc.gantt(P, "LD").model_dump_json(),
            }
            res = {name: timed(fn) for name, fn in ops.items()}
            # Snapshot equality fingerprints (before vs after must agree on the same data).
            proj = svc.get_project(P, "LD")
            res["_fingerprint"] = {
                "stats": proj.stats.model_dump(mode="json") if proj.stats else None,
                "list_projects_stats": [p.stats.model_dump(mode="json") for p in svc.list_projects(P).items if p.stats],
                "activity_seqs": [e.seq for e in svc.task_activity(P, mid).items][:10],
                "activity_len": len(svc.task_activity(P, mid).items),
            }
            result["sizes"][str(n)] = res  # type: ignore[index]
            print(n, json.dumps({k: v for k, v in res.items() if not k.startswith("_")}), flush=True)
            if want_profile and n == max(sizes):
                for name in ("list_projects", "get_project", "gantt", "get_task", "update_task", "list_tasks_200",
                             "preview", "task_activity"):
                    profile(ops[name], f"{name} N={n}", profiles)
                _ = patch
    result["loadavg_end"] = os.getloadavg()
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    if profiles:
        out_path.with_suffix(".prof.txt").write_text("\n".join(profiles))


if __name__ == "__main__":
    main()
