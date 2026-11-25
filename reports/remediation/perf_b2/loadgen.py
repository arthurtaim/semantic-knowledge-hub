"""B2 bounded load generator — the audit's loadgen.py (Auditor B) with the base URL, output dir and warm-up as
arguments; the request mix is UNCHANGED: 70% reads (list 200 / gantt / task / project / search / documents),
20% task writes (GET + PATCH with version, one retry on 409), 10% schedule previews (shift_successors).
N concurrent virtual clients (<=10), think time 0, for D seconds after W seconds of warm-up (same mix, discarded).
Samples backend RSS/CPU and the machine load average every second. Aborts if 5xx > 5% after 50 requests.
Usage: loadgen.py BASE LABEL CLIENTS SECONDS BACKEND_PID OUTDIR [WARMUP_SECONDS]"""
import asyncio
import csv
import json
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

import httpx

B, label, N, DUR, PID, OUTDIR = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5], sys.argv[6]
WARM = float(sys.argv[7]) if len(sys.argv) > 7 else 5.0
OUT = Path(OUTDIR)
OUT.mkdir(parents=True, exist_ok=True)
assert N <= 10
HDR = {"X-SKH-Client": "b2-load"}
rows: list[tuple] = []
samples: list[tuple] = []
stop = False
recording = False
QUERIES = ["лазурит", "Ракушка", "Альфа", "нагрузки", "поток", "датасет"]


async def one(client, name, method, path, **kw):
    t0 = time.perf_counter()
    try:
        r = await client.request(method, path, headers=HDR, **kw)
        st = r.status_code
        body = r
    except Exception:
        st = 599
        body = None
    if recording:
        rows.append((time.time(), name, method, st, round((time.perf_counter() - t0) * 1000, 2)))
    return st, body


async def vclient(i, keys):
    rnd = random.Random(1000 + i)
    async with httpx.AsyncClient(base_url=B, timeout=30) as c:
        while not stop:
            r = rnd.random()
            if r < 0.70:
                k = rnd.random()
                if k < 0.25:
                    await one(c, "list200", "GET", "/api/projects/LD/tasks", params={"limit": 200})
                elif k < 0.45:
                    await one(c, "gantt", "GET", "/api/projects/LD/gantt")
                elif k < 0.60:
                    await one(c, "task_get", "GET", f"/api/tasks/{rnd.choice(keys)}")
                elif k < 0.75:
                    await one(c, "project", "GET", "/api/projects/LD")
                elif k < 0.90:
                    await one(c, "search", "GET", "/api/search", params={"q": rnd.choice(QUERIES)})
                else:
                    await one(c, "documents", "GET", "/api/documents", params={"size": 50})
            elif r < 0.90:
                key = rnd.choice(keys)
                st, b = await one(c, "task_get_for_write", "GET", f"/api/tasks/{key}")
                if st != 200:
                    continue
                v = b.json()["version"]
                body = {"expected_version": v, "priority": rnd.choice(["low", "medium", "high", "critical"]),
                        "status": rnd.choice(["todo", "in_progress", "review"])}
                st2, _ = await one(c, "task_patch", "PATCH", f"/api/tasks/{key}", json=body)
                if st2 == 409:
                    st3, b3 = await one(c, "task_get_for_write", "GET", f"/api/tasks/{key}")
                    if st3 == 200:
                        body["expected_version"] = b3.json()["version"]
                        await one(c, "task_patch_retry", "PATCH", f"/api/tasks/{key}", json=body)
            else:
                key = rnd.choice(keys)
                st, b = await one(c, "task_get_for_write", "GET", f"/api/tasks/{key}")
                if st == 200 and b.json().get("start_date"):
                    await one(c, "schedule_preview", "POST", "/api/projects/LD/schedule/preview",
                              json={"mode": "shift_successors",
                                    "changes": [{"task_id": key, "start_date": b.json()["start_date"],
                                                 "duration_workdays": 2}]})


def sampler():
    out = subprocess.run(["ps", "-o", "rss=,pcpu=", "-p", PID], capture_output=True, text=True).stdout.split()
    la = subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.strip()
    if out:
        samples.append((time.time(), int(out[0]) // 1024, float(out[1]), float(la.strip("{} ").split()[0])))


async def main():
    global stop, recording
    async with httpx.AsyncClient(base_url=B, timeout=60) as c:
        r = await c.get("/api/projects/LD/tasks", params={"limit": 500})
        keys = [t["key"] for t in r.json()["items"]]
    tasks = [asyncio.create_task(vclient(i, keys)) for i in range(N)]
    await asyncio.sleep(WARM)  # warm-up with the same mix; nothing recorded
    recording = True
    t_end = time.time() + DUR
    aborted = None
    while time.time() < t_end:
        await asyncio.sleep(1)
        sampler()
        n5 = sum(1 for r in rows if r[3] >= 500)
        if len(rows) > 50 and n5 / len(rows) > 0.05:
            aborted = f"5xx {n5}/{len(rows)} > 5%"
            break
        if samples and samples[-1][1] > 2048:
            aborted = f"RSS {samples[-1][1]} MB > 2048"
            break
    stop = True
    recording = False
    await asyncio.gather(*tasks, return_exceptions=True)
    return aborted


la0 = subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.strip()
aborted = asyncio.run(main())
with open(OUT / f"{label}.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["ts", "endpoint", "method", "status", "ms"])
    w.writerows(rows)


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else None


summ = {"label": label, "base": B, "clients": N, "seconds": DUR, "warmup_s": WARM, "aborted": aborted,
        "requests": len(rows), "rps": round(len(rows) / DUR, 1), "status": {}, "endpoints": {},
        "rss_mb_max": max((s[1] for s in samples), default=None),
        "rss_mb_first": samples[0][1] if samples else None,
        "cpu_pct_max": max((s[2] for s in samples), default=None),
        "cpu_pct_avg": round(statistics.mean(s[2] for s in samples), 1) if samples else None,
        "loadavg_before": la0,
        "loadavg1_min": min((s[3] for s in samples), default=None),
        "loadavg1_max": max((s[3] for s in samples), default=None),
        "loadavg1_mean": round(statistics.mean(s[3] for s in samples), 2) if samples else None}
for r in rows:
    summ["status"][str(r[3])] = summ["status"].get(str(r[3]), 0) + 1
for ep in sorted({r[1] for r in rows}):
    ms = [r[4] for r in rows if r[1] == ep]
    sts = [r[3] for r in rows if r[1] == ep]
    summ["endpoints"][ep] = {"n": len(ms), "p50": pct(ms, 50), "p95": pct(ms, 95), "max": max(ms),
                             "4xx": sum(1 for s in sts if 400 <= s < 500), "5xx": sum(1 for s in sts if s >= 500)}
writes = summ["endpoints"].get("task_patch", {}).get("n", 0)
summ["retry_rate"] = round(summ["endpoints"].get("task_patch_retry", {}).get("n", 0) / writes, 3) if writes else 0
(OUT / f"{label}.json").write_text(json.dumps(summ, ensure_ascii=False, indent=1))
print(json.dumps({k: summ[k] for k in ("label", "clients", "requests", "rps", "status", "rss_mb_max", "cpu_pct_max",
                                       "retry_rate", "aborted", "loadavg1_mean")}, ensure_ascii=False))
for ep, v in summ["endpoints"].items():
    print(f"  {ep:20s} n={v['n']:5d} p50={v['p50']:8.1f} p95={v['p95']:8.1f} max={v['max']:8.1f} "
          f"4xx={v['4xx']} 5xx={v['5xx']}")
