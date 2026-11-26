"""Remediation B2 (audit CODE-015, SYS-009): the faster read paths of the work module answer EXACTLY what the old,
full-context paths answered — on the demo projects and on a randomized project with every edge case at once
(hierarchy, archived tasks and archived predecessors, done/undone predecessors, milestones, unscheduled tasks, due
dates around «today» in a far time zone, hidden and removed document links, member/unknown assignees).

The oracles are the pre-B2 algorithms, written out here so they do not change with the service:
- project stats are counted over TaskOut of every active task built with the FULL project context;
- a task page is TaskOut of every matching task (full context), filtered and sorted in Python, then sliced;
- one task (GET / after PATCH) is TaskOut built with the full project context;
- a task's activity is the project's audit filtered by `task_id = ? OR related_task_id = ?`, newest first.
"""

from __future__ import annotations

import random
import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.domain.models import UserContext
from app.errors import ApiError
from app.work import store
from app.work.calendar import add_workdays, next_workday
from app.work.db import WorkDatabase
from app.work.links import DocumentScope
from app.work.models import ProjectCreate, ProjectStats, TaskCreate, TaskOut, TaskStatus, TaskUpdate
from app.work.permissions import WorkAccessGate, WorkAccessMode, WorkPrincipal
from app.work.seed import seed_demo
from app.work.service import PRIORITY_ORDER, STATUS_ORDER, WorkService

NOW = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)  # Pacific/Kiritimati (UTC+14): already 26 November there
OPERATOR = UserContext(user_id="local-demo-user", display_name="Оператор", is_demo=True)
ALICE = UserContext(user_id="alice", display_name="Алиса", roles=[], is_demo=False)
STATUSES = ("todo", "in_progress", "review", "done")
PRIORITIES = ("low", "medium", "high", "critical")
TITLES = ("Альфа", "альфа поток", "BETA", "beta", "Гамма-лучи", "дельта", "Ёлка", "zeta")
VISIBLE_DOCS = ("DOC-A", "DOC-B")


@dataclass
class World:
    svc: WorkService
    principal: WorkPrincipal
    keys: list[str]


def _scope() -> DocumentScope:
    docs = {d.lower(): SimpleNamespace(id=d) for d in VISIBLE_DOCS}
    return DocumentScope(available=True, documents=cast(Any, docs), generation="g1")


def _iso_at(rnd: random.Random) -> str:
    moment = NOW - timedelta(days=rnd.randint(0, 30), seconds=rnd.randint(0, 86_400))
    if rnd.random() < 0.4:
        moment = moment.replace(microsecond=0)  # some stored timestamps have no fraction
    else:
        moment = moment.replace(microsecond=rnd.randint(1, 999_999))
    return store.now_iso(moment)


def _random_project(svc: WorkService, principal: WorkPrincipal, key: str, seed: int, tz: str) -> None:
    rnd = random.Random(seed)  # noqa: S311 — a reproducible synthetic test project, not a secret
    project = svc.create_project(principal, ProjectCreate(key=key, title=f"Случайный {key}", timezone=tz))
    today = svc._today(tz)
    ids: list[str] = []
    depth: dict[str, int] = {}
    milestone: dict[str, bool] = {}
    with svc.db.write() as conn:
        for i in range(90):
            number = store.allocate_task_number(conn, project.id)
            tid = f"{key.lower()}-{i:03d}"
            parents = [t for t in ids if depth[t] < 4 and not milestone[t]]
            parent = rnd.choice(parents) if parents and rnd.random() < 0.5 else None
            is_ms = parent is None and rnd.random() < 0.12
            start: date | None = None
            end: date | None = None
            if rnd.random() < 0.8:
                start = next_workday(today + timedelta(days=rnd.randint(-15, 15)))
                end = start if is_ms else add_workdays(start, rnd.randint(1, 5))
            due = None if rnd.random() < 0.4 else today + timedelta(days=rnd.randint(-3, 3))
            store.insert_task(
                conn,
                {
                    "id": tid,
                    "project_id": project.id,
                    "number": number,
                    "parent_task_id": parent,
                    "title": f"{rnd.choice(TITLES)} {rnd.randint(1, 30)}",
                    "description": "",
                    "status": rnd.choice(STATUSES),
                    "priority": rnd.choice(PRIORITIES),
                    "assignee_id": rnd.choice(
                        [None, None, "local-demo-user", "demo-analyst-1", "bob", "carol"]
                    ),
                    "start_date": start.isoformat() if start else None,
                    "end_exclusive": end.isoformat() if end else None,
                    "due_date": due.isoformat() if due else None,
                    "is_milestone": int(is_ms),
                    "date_locked": int(rnd.random() < 0.1 and start is not None),
                    "sort_order": rnd.choice([0, 1024, 2048, number * 1024]),
                    "is_demo": 0,
                    "created_by": "perf",
                    "created_at": _iso_at(rnd),
                    "updated_by": "perf",
                    "updated_at": _iso_at(rnd),
                },
            )
            ids.append(tid)
            depth[tid] = 1 if parent is None else depth[parent] + 1
            milestone[tid] = is_ms
        pairs: set[tuple[str, str]] = set()
        while len(pairs) < 70:
            pred, succ = rnd.sample(ids, 2)
            if (pred, succ) in pairs or (succ, pred) in pairs:
                continue
            pairs.add((pred, succ))
            store.insert_dependency(
                conn,
                {
                    "id": f"d-{pred}-{succ}",
                    "project_id": project.id,
                    "predecessor_id": pred,
                    "successor_id": succ,
                    "kind": "FS",
                    "lag_workdays": 0,
                    "created_by": "perf",
                    "created_at": _iso_at(rnd),
                },
            )
        for tid in rnd.sample(ids, 10):  # archived: also predecessors and children of active tasks
            conn.execute(
                "UPDATE work_tasks SET archived_at = ?, archived_by = 'perf' WHERE id = ?",
                (_iso_at(rnd), tid),
            )
        for n, tid in enumerate(rnd.sample(ids, 30)):
            for doc in rnd.sample(["DOC-A", "doc-b", "DOC-HIDDEN"], rnd.randint(1, 3)):
                store.insert_link(
                    conn,
                    {
                        "id": f"l-{tid}-{doc}",
                        "project_id": project.id,
                        "task_id": tid,
                        "target_type": "document",
                        "source_system": "skh",
                        "document_id": doc,
                        "relation": "implements",
                        "revision_at_link": "r1",
                        "status": "removed" if n % 7 == 0 else "active",
                        "created_by": "perf",
                        "created_at": _iso_at(rnd),
                    },
                )
        for _ in range(400):  # audit: own events, related events, events naming the task twice, other tasks
            task_id = rnd.choice([*ids, None])
            related = rnd.choice([None, None, task_id, *rnd.sample(ids, 2)])
            store.insert_audit(
                conn,
                at=_iso_at(rnd),
                actor_id="perf",
                operation="task_updated",
                entity_type="task",
                entity_id=task_id or ids[0],
                project_id=project.id,
                task_id=task_id,
                related_task_id=related,
                correlation_id=None,
                changes={"priority": {"before": "low", "after": "high"}},
            )


def _world(tmp_path: Path, mode: WorkAccessMode) -> World:
    svc = WorkService(
        WorkDatabase(tmp_path / f"work-{mode.value}.sqlite3"),
        WorkAccessGate(mode),
        operator=OPERATOR,
        now=lambda: NOW,
    )
    user = ALICE if mode == WorkAccessMode.membership else OPERATOR
    principal = WorkPrincipal(user=user, request_id="b2", documents=_scope())
    seed_demo(svc.db, now=NOW, timezone="Europe/Moscow")
    if mode == WorkAccessMode.membership:
        with svc.db.write() as conn:
            for row in store.list_projects(conn, None, True):
                store.put_member(conn, row["id"], "alice", "admin", "alice", store.now_iso(NOW))
    _random_project(svc, principal, "RND", 7, "Pacific/Kiritimati")
    _random_project(svc, principal, "RNE", 11, "Europe/Moscow")
    with svc.db.write() as conn:
        for row in store.list_projects(conn, None, True):
            if mode == WorkAccessMode.membership:
                store.put_member(conn, row["id"], "alice", "admin", "alice", store.now_iso(NOW))
                store.put_member(conn, row["id"], "bob", "member", "alice", store.now_iso(NOW))
        keys = [r["key"] for r in store.list_projects(conn, None, True)]
    return World(svc, principal, keys)


@pytest.fixture(
    params=[WorkAccessMode.local_operator, WorkAccessMode.membership], ids=["local", "membership"]
)
def world(tmp_path: Path, request: pytest.FixtureRequest) -> World:
    return _world(tmp_path, request.param)


# --- the old algorithms (oracles) -----------------------------------------------------------------------------------
def _full_task_outs(w: World, key: str, *, include_archived: bool = False, **filters: Any) -> list[TaskOut]:
    """TaskOut of every task of the project built with the FULL project context (the pre-B2 path)."""
    svc = w.svc
    with svc.db.read() as conn:
        project = store.get_project_by_key(conn, key)
        assert project is not None
        ctx = svc._ctx(conn, project, w.principal)
        rows = store.project_tasks(conn, project["id"], include_archived=include_archived, **filters)
        return [svc._task_out(r, ctx) for r in rows]


def _old_stats(tasks: list[TaskOut]) -> dict[str, Any]:
    by_status = {s.value: 0 for s in TaskStatus}
    for t in tasks:
        by_status[t.status.value] += 1
    upcoming = sorted(
        (t for t in tasks if t.is_milestone and t.start_date and t.status != TaskStatus.done),
        key=lambda t: (t.start_date, t.number),
    )
    first = upcoming[0] if upcoming else None
    return {
        "total": len(tasks),
        "by_status": by_status,
        "open": sum(1 for t in tasks if t.status != TaskStatus.done),
        "blocked": sum(1 for t in tasks if t.is_blocked),
        "overdue": sum(1 for t in tasks if t.overdue),
        "milestones": sum(1 for t in tasks if t.is_milestone),
        "unscheduled": sum(1 for t in tasks if not t.scheduled),
        "next_milestone": None
        if first is None
        else {"task_id": first.id, "key": first.key, "title": first.title, "date": first.start_date},
    }


def _old_sort_key(sort: str) -> Callable[[TaskOut], tuple[Any, ...]]:
    far = date(9999, 12, 31)
    keys: dict[str, Callable[[TaskOut], tuple[Any, ...]]] = {
        "key": lambda t: (t.number,),
        "title": lambda t: (t.title.casefold(), t.number),
        "status": lambda t: (STATUS_ORDER[t.status.value], t.number),
        "priority": lambda t: (PRIORITY_ORDER[t.priority.value], t.number),
        "start_date": lambda t: (t.start_date or far, t.number),
        "due_date": lambda t: (t.due_date or far, t.number),
        "updated_at": lambda t: (t.updated_at, t.number),
    }
    return keys.get(sort, lambda t: (t.sort_order, t.number))


def _old_page(w: World, key: str, **kw: Any) -> list[TaskOut]:
    sql = {k: kw[k] for k in ("statuses", "priorities", "assignee", "parent", "milestone") if k in kw}
    tasks = _full_task_outs(w, key, include_archived=kw.get("include_archived", False), **sql)
    if kw.get("q"):
        needle = kw["q"].casefold().strip()
        tasks = [t for t in tasks if needle in t.title.casefold() or needle in t.key.casefold()]
    for name, attr in (("scheduled", "scheduled"), ("overdue", "overdue"), ("blocked", "is_blocked")):
        if kw.get(name) is not None:
            tasks = [t for t in tasks if getattr(t, attr) == kw[name]]
    if kw.get("document") is not None:
        wanted = kw["document"].casefold()
        tasks = [t for t in tasks if any(d.casefold() == wanted for d in t.document_ids or [])]
    tasks.sort(key=_old_sort_key(kw.get("sort", "sort_order")), reverse=kw.get("order", "asc") == "desc")
    offset, limit = kw.get("offset", 0), kw.get("limit", 200)
    return tasks[offset : offset + limit]


def _old_activity_seqs(w: World, project_id: str, task_id: str, before: int | None, limit: int) -> list[int]:
    sql = "SELECT seq FROM work_audit_events WHERE project_id = ? AND (task_id = ? OR related_task_id = ?)"
    params: list[Any] = [project_id, task_id, task_id]
    if before is not None:
        sql += " AND seq < ?"
        params.append(before)
    sql += " ORDER BY seq DESC LIMIT ?"
    params.append(limit)
    with w.svc.db.read() as conn:
        return [int(r[0]) for r in conn.execute(sql, params).fetchall()]


def _all_task_rows(w: World) -> Iterator[sqlite3.Row]:
    with w.svc.db.read() as conn:
        rows = list(conn.execute("SELECT * FROM work_tasks ORDER BY project_id, number").fetchall())
    yield from rows


# --- project stats (CODE-015: SQL aggregates instead of TaskOut for every task) ---------------------------------------
def test_project_stats_equal_the_old_count_over_every_task(world: World) -> None:
    listed = {p.key: p for p in world.svc.list_projects(world.principal, include_archived=True).items}
    assert set(listed) == set(world.keys)
    for key in world.keys:
        expected = _old_stats(_full_task_outs(world, key))
        one = world.svc.get_project(world.principal, key)
        assert one.stats is not None and listed[key].stats is not None
        assert one.stats.model_dump(mode="python") == ProjectStats.model_validate(expected).model_dump(
            mode="python"
        )
        assert listed[key].stats == one.stats, key


def test_stats_follow_a_change_of_a_predecessor_and_an_archive(world: World) -> None:
    svc, p = world.svc, world.principal
    for row in list(_all_task_rows(world))[:400:7]:
        if row["archived_at"] is not None:
            continue
        current = svc.get_task(p, row["id"])
        svc.update_task(p, row["id"], TaskUpdate(expected_version=current.version, status=TaskStatus.done))
    for key in world.keys:
        assert svc.get_project(p, key).stats == ProjectStats.model_validate(
            _old_stats(_full_task_outs(world, key))
        )


# --- one task (derived fields from the rows that task needs, not the whole project) ---------------------------------
def test_get_task_equals_the_full_context_task_for_every_task(world: World) -> None:
    svc = world.svc
    for row in _all_task_rows(world):
        with svc.db.read() as conn:
            project = store.get_project(conn, row["project_id"])
            assert project is not None
            expected = svc._task_out(row, svc._ctx(conn, project, world.principal))
        assert svc.get_task(world.principal, row["id"]) == expected, row["id"]


def test_a_saved_task_is_returned_with_the_same_derived_fields(world: World) -> None:
    svc, p = world.svc, world.principal
    for n, row in enumerate(_all_task_rows(world)):
        if row["archived_at"] is not None or n % 3:
            continue
        current = svc.get_task(p, row["id"])
        saved = svc.update_task(
            p, row["id"], TaskUpdate(expected_version=current.version, priority="critical", title=f"Т {n}")
        )
        with svc.db.read() as conn:
            project = store.get_project(conn, row["project_id"])
            fresh = store.get_task(conn, row["id"])
            assert project is not None and fresh is not None
            expected = svc._task_out(fresh, svc._ctx(conn, project, p))
        assert saved == expected, row["id"]
        unchanged = svc.update_task(p, row["id"], TaskUpdate(expected_version=saved.version, title=f"Т {n}"))
        assert unchanged == expected  # «nothing changed» answers the same task too


def test_a_created_task_is_returned_with_the_same_derived_fields(world: World) -> None:
    svc, p = world.svc, world.principal
    parents = [r for r in _all_task_rows(world) if r["archived_at"] is None and not r["is_milestone"]][::9]
    for n, parent in enumerate(parents):
        with svc.db.read() as conn:
            project = store.get_project(conn, parent["project_id"])
            assert project is not None
        body = TaskCreate(title=f"Новая {n}", parent_task_id=parent["id"] if n % 3 else None)
        try:
            created = svc.create_task(p, project["key"], body)
        except ApiError as exc:  # too deep under this parent: the same refusal as before, nothing to compare
            assert exc.code == "invalid_hierarchy"
            continue
        with svc.db.read() as conn:
            row = store.get_task(conn, created.id)
            assert row is not None
            expected = svc._task_out(row, svc._ctx(conn, project, p))
        assert created == expected


# --- a task page (TaskOut only for the page; filters and sort on the rows) ------------------------------------------
LIST_CASES: list[dict[str, Any]] = [
    {},
    {"limit": 7},
    {"limit": 7, "offset": 13},
    {"include_archived": True, "limit": 500},
    {"q": "альфа"},
    {"q": "  BETA "},
    {"q": "-1"},
    {"scheduled": True},
    {"scheduled": False},
    {"overdue": True},
    {"overdue": False, "sort": "due_date"},
    {"blocked": True},
    {"blocked": False, "order": "desc"},
    {"document": "doc-a"},
    {"document": "DOC-HIDDEN"},
    {"statuses": frozenset({"todo", "review"}), "priorities": frozenset({"high"})},
    {"assignee": "none"},
    {"assignee": "bob", "include_archived": True},
    {"parent": "root", "milestone": False},
    {"milestone": True, "sort": "start_date"},
]
SORTS = ["sort_order", "key", "title", "status", "priority", "start_date", "due_date", "updated_at"]


@pytest.mark.parametrize(
    "case", LIST_CASES, ids=lambda c: ",".join(f"{k}={v}" for k, v in c.items()) or "default"
)
def test_a_task_page_equals_the_old_filter_sort_and_slice(world: World, case: dict[str, Any]) -> None:
    for key in world.keys:
        page = world.svc.list_tasks(world.principal, key, **case)
        expected = _old_page(world, key, **case)
        assert [t.key for t in page.items] == [t.key for t in expected], (key, case)
        assert page.items == expected
        full = _old_page(world, key, **{**case, "limit": 10_000, "offset": 0})
        assert page.total == len(full)


@pytest.mark.parametrize("sort", SORTS)
@pytest.mark.parametrize("order", ["asc", "desc"])
def test_every_sort_and_order_matches(world: World, sort: str, order: str) -> None:
    for key in ("RND", "RNE", world.keys[0]):
        for offset in (0, 11):
            page = world.svc.list_tasks(world.principal, key, sort=sort, order=order, limit=17, offset=offset)
            expected = _old_page(world, key, sort=sort, order=order, limit=17, offset=offset)
            assert [t.key for t in page.items] == [t.key for t in expected], (key, sort, order, offset)
            assert page.items == expected


# --- a task's activity (CODE-015: the audit read by the task's own indexes, not the whole project) -------------------
def test_task_activity_equals_the_project_scan(world: World) -> None:
    svc, p = world.svc, world.principal
    with svc.db.read() as conn:
        project = store.get_project_by_key(conn, "RND")
        assert project is not None
        ids = [r["id"] for r in store.project_tasks(conn, project["id"], include_archived=True)]
    for task_id in ids:
        for limit in (3, 50):
            page = svc.task_activity(p, task_id, limit=limit)
            seqs = [e.seq for e in page.items]
            assert seqs == _old_activity_seqs(world, project["id"], task_id, None, limit), task_id
            if page.next_before_seq is not None:
                more = svc.task_activity(p, task_id, limit=limit, before_seq=page.next_before_seq)
                assert [e.seq for e in more.items] == _old_activity_seqs(
                    world, project["id"], task_id, page.next_before_seq, limit
                )


def test_task_activity_names_other_tasks_by_their_keys(world: World) -> None:
    svc, p = world.svc, world.principal
    with svc.db.read() as conn:
        project = store.get_project_by_key(conn, "RND")
        assert project is not None
        ctx = svc._ctx(conn, project, p)
        ids = [r["id"] for r in store.project_tasks(conn, project["id"], include_archived=True)]
    for task_id in ids[:40]:
        for event in svc.task_activity(p, task_id, limit=50).items:
            assert event.task_key == (ctx.key(event.task_id) if event.task_id else None)


# --- project-wide reads in one step (B2: no GIL hand-off per row under concurrent requests) --------------------------
def test_one_step_reads_cover_every_column_of_the_schema(tmp_path: Path) -> None:
    db = WorkDatabase(tmp_path / "cols.sqlite3")
    with db.read() as conn:
        for table, columns in (
            ("work_tasks", store.TASK_COLUMNS),
            ("work_dependencies", store.DEPENDENCY_COLUMNS),
        ):
            assert tuple(r[1] for r in conn.execute(f"PRAGMA table_info({table})")) == columns


def test_one_step_reads_equal_the_row_by_row_reads(world: World) -> None:
    """Same keys, values, types and order as `SELECT …` row by row (the pre-B2 store functions)."""
    with world.svc.db.read() as conn:
        for project in store.list_projects(conn, None, True):
            pid = project["id"]
            old_tasks = conn.execute(
                "SELECT * FROM work_tasks WHERE project_id = ? ORDER BY number", (pid,)
            ).fetchall()
            for flag in (False, True):
                active = [dict(r) for r in old_tasks if flag or r["archived_at"] is None]
                assert store.project_tasks(conn, pid, include_archived=flag) == active
            filtered = [
                dict(r)
                for r in old_tasks
                if r["archived_at"] is None
                and r["status"] in ("todo", "review")
                and r["parent_task_id"] is None
            ]
            assert (
                store.project_tasks(conn, pid, statuses=frozenset({"review", "todo"}), parent="root")
                == filtered
            )
            assert store.task_skeleton(conn, pid) == [
                dict(r)
                for r in conn.execute(
                    f"SELECT {store.SKELETON_COLUMNS} FROM work_tasks WHERE project_id = ? ORDER BY number",  # noqa: S608 — fixed column names
                    (pid,),
                ).fetchall()
            ]
            assert store.project_dependencies(conn, pid) == [
                dict(r)
                for r in conn.execute(
                    "SELECT d.* FROM work_dependencies d "
                    "JOIN work_tasks p ON p.id = d.predecessor_id AND p.archived_at IS NULL "
                    "JOIN work_tasks s ON s.id = d.successor_id AND s.archived_at IS NULL "
                    "WHERE d.project_id = ? ORDER BY d.created_at, d.id",
                    (pid,),
                ).fetchall()
            ]
            # `==` would accept 1 == True or 1 == 1.0: the types must be the row's types too.
            new = store.project_tasks(conn, pid, include_archived=True)
            assert [{k: type(v) for k, v in r.items()} for r in new] == [
                {k: type(v) for k, v in dict(r).items()} for r in old_tasks
            ]


def test_task_activity_reads_the_audit_through_the_task_indexes(tmp_path: Path) -> None:
    db = WorkDatabase(tmp_path / "plan.sqlite3")
    with db.read() as conn:
        sql, params = store.audit_page_query(project_id="p", task_id="t", before_seq=10, limit=50)
        plan = " | ".join(str(tuple(r)[-1]) for r in conn.execute("EXPLAIN QUERY PLAN " + sql, params))
    assert "work_audit_by_task" in plan and "work_audit_by_related_task" in plan, plan
    assert "work_audit_by_project" not in plan, plan
