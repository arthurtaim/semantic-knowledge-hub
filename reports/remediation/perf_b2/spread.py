"""B2: put project LD into one deterministic state through the public API — status by task number
(n % 4 → todo / in_progress / review / done) and priority by number (n % 3 → low / medium / high), so the Board has
~N/4 cards per column on BOTH stacks before a UI measurement. Usage: spread.py BASE_URL"""
import sys

import httpx

base = sys.argv[1]
c = httpx.Client(base_url=base, timeout=120, headers={"X-SKH-Client": "b2-spread"})
STATUS = ["todo", "in_progress", "review", "done"]
PRIO = ["low", "medium", "high"]
tasks: list = []
while True:
    page = c.get("/api/projects/LD/tasks", params={"limit": 500, "offset": len(tasks), "sort": "key"}).json()
    tasks += page["items"]
    if len(tasks) >= page["total"] or not page["items"]:
        break
changed = 0
for t in tasks:
    want = {"status": STATUS[t["number"] % 4], "priority": PRIO[t["number"] % 3]}
    if t["status"] != want["status"] or t["priority"] != want["priority"]:
        r = c.patch(f"/api/tasks/{t['id']}", json={"expected_version": t["version"], **want})
        assert r.status_code == 200, r.text
        changed += 1
counts: dict[str, int] = {}
for t in tasks:
    counts[STATUS[t["number"] % 4]] = counts.get(STATUS[t["number"] % 4], 0) + 1
print("tasks", len(tasks), "changed", changed, "columns", counts)
