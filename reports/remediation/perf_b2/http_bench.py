"""B2 sequential HTTP latency per planner endpoint (one client, no concurrency): 5 warm-up + R timed requests each.
Usage: http_bench.py BASE LABEL OUT.json [R]"""
import json
import os
import statistics
import sys
import time

import httpx

base, label, out = sys.argv[1], sys.argv[2], sys.argv[3]
R = int(sys.argv[4]) if len(sys.argv) > 4 else 40
c = httpx.Client(base_url=base, timeout=60, headers={"X-SKH-Client": "b2-bench"})
tasks: list = []
while True:
    page = c.get("/api/projects/LD/tasks", params={"limit": 500, "offset": len(tasks), "sort": "key"}).json()
    tasks += page["items"]
    if len(tasks) >= page["total"] or not page["items"]:
        break
mid = tasks[len(tasks) // 2]
head = next(t for t in tasks if t["number"] % 10 == 1 and t["start_date"])
state = {"i": 0}
PRIOS = ["low", "medium", "high", "critical"]


def patch():
    v = c.get(f"/api/tasks/{mid['key']}").json()["version"]
    state["i"] += 1
    t0 = time.perf_counter()
    r = c.patch(f"/api/tasks/{mid['key']}", json={"expected_version": v, "priority": PRIOS[state["i"] % 4]})
    dt = (time.perf_counter() - t0) * 1000
    assert r.status_code == 200, r.text
    return dt


def req(method, path, **kw):
    def run():
        t0 = time.perf_counter()
        r = c.request(method, path, **kw)
        dt = (time.perf_counter() - t0) * 1000
        assert r.status_code == 200, (path, r.status_code, r.text[:300])
        return dt
    return run


ops = {
    "projects_list": req("GET", "/api/projects"),
    "project": req("GET", "/api/projects/LD"),
    "list200": req("GET", "/api/projects/LD/tasks", params={"limit": 200}),
    "gantt": req("GET", "/api/projects/LD/gantt"),
    "task_get": req("GET", f"/api/tasks/{mid['key']}"),
    "task_patch": patch,
    "schedule_preview": req("POST", "/api/projects/LD/schedule/preview",
                            json={"mode": "shift_successors", "changes": [
                                {"task_id": head["key"], "start_date": head["start_date"], "duration_workdays": 2}]}),
    "task_activity": req("GET", f"/api/tasks/{mid['key']}/activity"),
}
res = {"label": label, "base": base, "tasks": len(tasks), "loadavg_start": os.getloadavg(), "endpoints": {}}
for name, fn in ops.items():
    for _ in range(5):
        fn()
    xs = sorted(fn() for _ in range(R))
    res["endpoints"][name] = {"n": R, "p50": round(statistics.median(xs), 2),
                              "p95": round(xs[min(R - 1, round(0.95 * (R - 1)))], 2), "max": round(xs[-1], 2)}
res["loadavg_end"] = os.getloadavg()
json.dump(res, open(out, "w"), ensure_ascii=False, indent=1)
print(label, len(tasks), json.dumps(res["endpoints"]))
