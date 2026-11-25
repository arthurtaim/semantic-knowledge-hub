"""B2 seed (adapted from the audit's load_fixture.py): project LD grows to N tasks in FS chains of 10 through the
PUBLIC API of a sandbox stack (synthetic titles only). Deterministic: priorities from random.Random(N-index seed).
Usage: seed.py BASE_URL N        (idempotent: adds only the missing tasks)"""
import random
import sys
import uuid
from datetime import date, timedelta

import httpx

base, n = sys.argv[1], int(sys.argv[2])
H = {"X-SKH-Client": "b2-seed", "Accept": "application/json"}
c = httpx.Client(base_url=base, timeout=120, headers=H)


def next_workday(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def add_workdays(d: date, k: int) -> date:
    d = next_workday(d)
    while k > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            k -= 1
    return d


r = c.get("/api/projects/LD")
if r.status_code == 404:
    r = c.post("/api/projects", json={"key": "LD", "title": "Нагрузка B2", "client_request_id": uuid.uuid4().hex})
    assert r.status_code == 201, r.text
have = c.get("/api/projects/LD/tasks", params={"limit": 1}).json()["total"]
items: list[dict] = []
off = 0
while len(items) < have:
    page = c.get("/api/projects/LD/tasks", params={"limit": 500, "offset": off, "sort": "key"}).json()["items"]
    items += page
    off += 500
by_num = {t["number"]: t for t in items}
first = date(2026, 12, 7)
for i in range(have + 1, n + 1):
    rnd = random.Random(i)
    chain, pos = divmod(i - 1, 10)
    start = first
    for _ in range(pos):
        start = next_workday(add_workdays(start, 1))
    r = c.post("/api/projects/LD/tasks", json={"title": f"Нагрузка {i}", "start_date": start.isoformat(),
                                               "duration_workdays": 1,
                                               "priority": rnd.choice(["low", "medium", "high"]),
                                               "client_request_id": uuid.uuid4().hex})
    assert r.status_code == 201, (r.status_code, r.text)
    t = r.json()
    by_num[i] = t
    if pos > 0:
        r2 = c.post(f"/api/tasks/{t['id']}/dependencies", json={"predecessor_task_id": by_num[i - 1]["id"]})
        assert r2.status_code == 201, (r2.status_code, r2.text)
print("tasks now", c.get("/api/projects/LD/tasks", params={"limit": 1}).json()["total"])
