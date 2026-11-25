"""B2 probe: does fetching many rows with the sqlite3 module (one GIL release per row) starve under CPU-bound
neighbour threads? Run with cwd=<checkout>/backend. Prints per-mode p50/p95 of one 1000-row fetch while N CPU threads
run (pure Python work in short bursts with small queries, like the light requests after B2)."""

from __future__ import annotations

import json
import os
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, os.path.dirname(__file__))

from svc_bench import OP, P, populate  # noqa: E402

from app.work.db import WorkDatabase  # noqa: E402
from app.work.permissions import WorkAccessGate, WorkAccessMode  # noqa: E402
from app.work.service import WorkService  # noqa: E402

COLS = None


def fetch_rows(db: WorkDatabase, pid: str) -> int:
    with db.read() as conn:
        return len(conn.execute("SELECT * FROM work_tasks WHERE project_id = ?", (pid,)).fetchall())


def fetch_json(db: WorkDatabase, pid: str) -> int:
    with db.read() as conn:
        global COLS
        if COLS is None:
            COLS = [r[1] for r in conn.execute("PRAGMA table_info(work_tasks)")]
        obj = ", ".join(f"'{c}', {c}" for c in COLS)
        text = conn.execute(
            f"SELECT json_group_array(json_object({obj})) FROM work_tasks WHERE project_id = ?", (pid,)
        ).fetchone()[0]
        return len(json.loads(text))


def run(mode: str, cpu_threads: int, svc: WorkService, pid: str, seconds: float = 4.0) -> dict[str, float]:
    stop = threading.Event()

    def cpu() -> None:
        while not stop.is_set():
            svc.get_task(P, "ld000500")  # a light request after B2: small queries + pydantic

    threads = [threading.Thread(target=cpu, daemon=True) for _ in range(cpu_threads)]
    for t in threads:
        t.start()
    fn = fetch_rows if mode == "rows" else fetch_json
    samples = []
    end = time.time() + seconds
    while time.time() < end:
        t0 = time.perf_counter()
        fn(svc.db, pid)
        samples.append((time.perf_counter() - t0) * 1000)
    stop.set()
    for t in threads:
        t.join()
    samples.sort()
    return {"n": len(samples), "p50": round(statistics.median(samples), 2),
            "p95": round(samples[min(len(samples) - 1, round(0.95 * (len(samples) - 1)))], 2)}


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db = WorkDatabase(Path(tmp) / "work.sqlite3")
        svc = WorkService(db, WorkAccessGate(WorkAccessMode.local_operator), operator=OP)
        pid, _ = populate(svc, "LD", 1000, chains=True, audit_per_task=1)
        for interval in (0.005, 0.0005):
            sys.setswitchinterval(interval)
            for cpu_threads in (0, 3, 6):
                for mode in ("rows", "json"):
                    print(f"switch={interval * 1000:.1f}ms cpu_threads={cpu_threads} {mode}:",
                          run(mode, cpu_threads, svc, pid), flush=True)


if __name__ == "__main__":
    main()
