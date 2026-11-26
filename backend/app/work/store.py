"""SQL of the work module (M6). Every function runs inside a unit of work owned by the caller
(`WorkDatabase.read()` / `.write()`), so a service method composes several of them atomically.

SQL text is assembled only from fixed column names; every value is a bound parameter. Compare-and-set updates
(`WHERE id = ? AND version = ?`) implement optimistic locking: 0 affected rows = a stale write.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

Row = sqlite3.Row
# A row of a project-wide read fetched in one step (`_rows_in_one_step`): the same keys and values as `sqlite3.Row`.
RowDict = dict[str, Any]

# Every column of `work_tasks` / `work_dependencies` (schema v3; tests/test_work_perf_equivalence.py checks the list).
TASK_COLUMNS = (
    "id",
    "project_id",
    "number",
    "parent_task_id",
    "title",
    "description",
    "status",
    "priority",
    "assignee_id",
    "reporter_id",
    "estimate_workdays",
    "start_date",
    "end_exclusive",
    "due_date",
    "is_milestone",
    "date_locked",
    "sort_order",
    "is_demo",
    "version",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "archived_at",
    "archived_by",
)
DEPENDENCY_COLUMNS = (
    "id",
    "project_id",
    "predecessor_id",
    "successor_id",
    "kind",
    "lag_workdays",
    "created_by",
    "created_at",
)


def _rows_in_one_step(
    conn: sqlite3.Connection, columns: Iterable[str], alias: str, from_where: str, params: Iterable[Any]
) -> list[RowDict]:
    """A whole result set in ONE sqlite3 step: `json_group_array(json_object(...))`, decoded by `json.loads`.

    Why (B2, measured): the sqlite3 module releases and re-takes the GIL for every row it steps. A project-wide read
    (a Gantt, a list, a preview: ~3 000 rows at 1000 tasks) under concurrent requests spent most of its time waiting
    to re-take the GIL row by row (macOS `sample`: `pysqlite_cursor_iternext > PyEval_RestoreThread > take_gil`).
    TEXT/INTEGER/NULL come back as str/int/None, as from a row. The caller orders the rows (aggregate order is not
    guaranteed by older SQLite)."""
    pairs = ", ".join(f"'{c}', {alias}.{c}" for c in columns)
    text = conn.execute(
        f"SELECT COALESCE(json_group_array(json_object({pairs})), '[]') {from_where}", tuple(params)
    ).fetchone()[0]
    rows: list[RowDict] = json.loads(text)
    return rows


PROJECT_FIELDS = frozenset(
    {"title", "description", "status", "timezone", "start_date", "target_date", "archived_at"}
)
TASK_FIELDS = frozenset(
    {
        "parent_task_id",
        "title",
        "description",
        "status",
        "priority",
        "assignee_id",
        "estimate_workdays",
        "start_date",
        "end_exclusive",
        "due_date",
        "is_milestone",
        "date_locked",
        "sort_order",
        "archived_at",
        "archived_by",
    }
)


def new_id() -> str:
    return uuid.uuid4().hex


def now_iso(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(UTC).isoformat()


# --- projects --------------------------------------------------------------------------------------------------
def insert_project(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_projects ({columns}) VALUES ({placeholders})", dict(row))


def get_project(conn: sqlite3.Connection, project_id: str) -> Row | None:
    row: Row | None = conn.execute("SELECT * FROM work_projects WHERE id = ?", (project_id,)).fetchone()
    return row


def get_project_by_key(conn: sqlite3.Connection, key: str) -> Row | None:
    row: Row | None = conn.execute("SELECT * FROM work_projects WHERE key = ?", (key,)).fetchone()
    return row


def get_project_by_seed(conn: sqlite3.Connection, seed_key: str) -> Row | None:
    row: Row | None = conn.execute("SELECT * FROM work_projects WHERE seed_key = ?", (seed_key,)).fetchone()
    return row


def list_projects(conn: sqlite3.Connection, ids: Iterable[str] | None, include_archived: bool) -> list[Row]:
    sql = "SELECT * FROM work_projects WHERE 1 = 1"
    params: list[Any] = []
    if ids is not None:
        id_list = sorted(set(ids))
        if not id_list:
            return []
        sql += f" AND id IN ({', '.join('?' for _ in id_list)})"
        params.extend(id_list)
    if not include_archived:
        sql += " AND status <> 'archived'"
    sql += " ORDER BY key"
    return list(conn.execute(sql, params).fetchall())


def update_project(
    conn: sqlite3.Connection,
    project_id: str,
    expected_version: int,
    fields: Mapping[str, Any],
    actor: str,
    at: str,
) -> bool:
    unknown = set(fields) - PROJECT_FIELDS
    if unknown:
        raise ValueError(f"not updatable: {sorted(unknown)}")
    assignments = "".join(f", {name} = ?" for name in fields)
    cursor = conn.execute(
        f"UPDATE work_projects SET version = version + 1, updated_by = ?, updated_at = ?{assignments} "
        "WHERE id = ? AND version = ?",
        (actor, at, *fields.values(), project_id, expected_version),
    )
    return cursor.rowcount == 1


def bump_plan_revision(conn: sqlite3.Connection, project_id: str) -> int:
    row = conn.execute(
        "UPDATE work_projects SET plan_revision = plan_revision + 1 WHERE id = ? RETURNING plan_revision",
        (project_id,),
    ).fetchone()
    return int(row[0])


def allocate_task_number(conn: sqlite3.Connection, project_id: str) -> int:
    """Atomic per-project counter (inside the write transaction): human keys PROJ-N never repeat."""
    row = conn.execute(
        "UPDATE work_projects SET next_task_number = next_task_number + 1 WHERE id = ? RETURNING next_task_number",
        (project_id,),
    ).fetchone()
    return int(row[0]) - 1


# --- membership (team-ready gate) -----------------------------------------------------------------------------
def member_role(conn: sqlite3.Connection, project_id: str, user_id: str) -> str | None:
    row = conn.execute(
        "SELECT role FROM work_project_members WHERE project_id = ? AND user_id = ? AND active = 1",
        (project_id, user_id),
    ).fetchone()
    return str(row[0]) if row else None


def member_project_ids(conn: sqlite3.Connection, user_id: str) -> list[str]:
    return [
        str(r[0])
        for r in conn.execute(
            "SELECT project_id FROM work_project_members WHERE user_id = ? AND active = 1", (user_id,)
        ).fetchall()
    ]


def list_members(conn: sqlite3.Connection, project_id: str) -> list[Row]:
    return list(
        conn.execute(
            "SELECT * FROM work_project_members WHERE project_id = ? ORDER BY role, user_id", (project_id,)
        ).fetchall()
    )


def put_member(
    conn: sqlite3.Connection, project_id: str, user_id: str, role: str, added_by: str, at: str
) -> None:
    conn.execute(
        "INSERT INTO work_project_members (project_id, user_id, role, active, added_by, added_at) "
        "VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, active = 1",
        (project_id, user_id, role, added_by, at),
    )


# --- tasks -----------------------------------------------------------------------------------------------------
def insert_task(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_tasks ({columns}) VALUES ({placeholders})", dict(row))


def get_task(conn: sqlite3.Connection, task_id: str) -> Row | None:
    row: Row | None = conn.execute("SELECT * FROM work_tasks WHERE id = ?", (task_id,)).fetchone()
    return row


def get_task_by_number(conn: sqlite3.Connection, project_id: str, number: int) -> Row | None:
    row: Row | None = conn.execute(
        "SELECT * FROM work_tasks WHERE project_id = ? AND number = ?", (project_id, number)
    ).fetchone()
    return row


def project_tasks(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    include_archived: bool = False,
    statuses: Iterable[str] | None = None,
    priorities: Iterable[str] | None = None,
    assignee: str | None = None,
    parent: str | None = None,
    milestone: bool | None = None,
) -> list[RowDict]:
    """Tasks of one project with the indexed structured filters applied in SQL (project, status, assignee …), every
    column, ordered by number — read in one step (`_rows_in_one_step`)."""
    sql = "FROM work_tasks t WHERE project_id = ?"
    params: list[Any] = [project_id]
    if not include_archived:
        sql += " AND archived_at IS NULL"
    for column, values in (("status", statuses), ("priority", priorities)):
        if values is not None:
            items = sorted(set(values))
            sql += f" AND {column} IN ({', '.join('?' for _ in items)})"
            params.extend(items)
    if assignee == "none":
        sql += " AND assignee_id IS NULL"
    elif assignee is not None:
        sql += " AND assignee_id = ?"
        params.append(assignee)
    if parent == "root":
        sql += " AND parent_task_id IS NULL"
    elif parent is not None:
        sql += " AND parent_task_id = ?"
        params.append(parent)
    if milestone is not None:
        sql += " AND is_milestone = ?"
        params.append(1 if milestone else 0)
    rows = _rows_in_one_step(conn, TASK_COLUMNS, "t", sql, params)
    rows.sort(key=lambda r: int(r["number"]))
    return rows


SKELETON_FIELDS = (
    "id",
    "number",
    "parent_task_id",
    "status",
    "archived_at",
    "title",
    "start_date",
    "end_exclusive",
    "is_milestone",
)
SKELETON_COLUMNS = ", ".join(SKELETON_FIELDS)


def task_skeleton(conn: sqlite3.Connection, project_id: str) -> list[RowDict]:
    """Light rows of EVERY task of a project (also archived): hierarchy, status, keys — for derived fields. One step
    (`_rows_in_one_step`), ordered by number."""
    rows = _rows_in_one_step(
        conn, SKELETON_FIELDS, "t", "FROM work_tasks t WHERE project_id = ?", (project_id,)
    )
    rows.sort(key=lambda r: int(r["number"]))
    return rows


def task_skeleton_around(conn: sqlite3.Connection, project_id: str, task_id: str) -> list[Row]:
    """Light rows (the `task_skeleton` columns) of ONE task, its ancestors in the project and its active dependency
    neighbours — everything that task's derived fields need, without reading the whole project (B2, CODE-015)."""
    return list(
        conn.execute(
            "WITH RECURSIVE up(id, hops) AS ("
            "  SELECT ?, 0"
            "  UNION SELECT t.parent_task_id, up.hops + 1 FROM work_tasks t JOIN up ON t.id = up.id"
            "  WHERE t.project_id = ? AND t.parent_task_id IS NOT NULL AND up.hops < 64"
            "), near(id) AS ("
            "  SELECT id FROM up"
            "  UNION SELECT predecessor_id FROM work_dependencies WHERE successor_id = ?"
            "  UNION SELECT successor_id FROM work_dependencies WHERE predecessor_id = ?"
            f") SELECT {SKELETON_COLUMNS} FROM work_tasks WHERE project_id = ? AND id IN (SELECT id FROM near) "
            "ORDER BY number",
            (task_id, project_id, task_id, task_id, project_id),
        ).fetchall()
    )


def task_skeleton_of(conn: sqlite3.Connection, project_id: str, task_ids: Iterable[str]) -> list[Row]:
    """Light rows of the named tasks of one project (e.g. the tasks an activity page mentions)."""
    ids = sorted(set(task_ids))
    if not ids:
        return []
    return list(
        conn.execute(
            f"SELECT {SKELETON_COLUMNS} FROM work_tasks WHERE project_id = ? "
            f"AND id IN ({', '.join('?' for _ in ids)}) ORDER BY number",
            (project_id, *ids),
        ).fetchall()
    )


def count_active_children(conn: sqlite3.Connection, project_id: str, task_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM work_tasks WHERE parent_task_id = ? AND project_id = ? AND archived_at IS NULL",
        (task_id, project_id),
    ).fetchone()
    return int(row[0])


def project_stats(conn: sqlite3.Connection, project_id: str, today: str) -> dict[str, Any]:
    """The counters of a project's ACTIVE tasks as SQL aggregates (B2, audit CODE-015: no TaskOut per task).

    The same rules as the derived task fields: overdue = not done and `due_date < today` (ISO dates compare as
    text); blocked = not done with an FS predecessor in the project that is active and not done (`project_dependencies`
    keeps only edges with both ends active); the next milestone = the earliest dated milestone that is not done."""
    by_status = {
        str(r[0]): int(r[1])
        for r in conn.execute(
            "SELECT status, COUNT(*) FROM work_tasks WHERE project_id = ? AND archived_at IS NULL GROUP BY status",
            (project_id,),
        ).fetchall()
    }
    row = conn.execute(
        "SELECT COUNT(*), "
        "COALESCE(SUM(is_milestone = 1), 0), "
        "COALESCE(SUM(start_date IS NULL), 0), "
        "COALESCE(SUM(status <> 'done' AND due_date IS NOT NULL AND due_date < ?), 0) "
        "FROM work_tasks WHERE project_id = ? AND archived_at IS NULL",
        (today, project_id),
    ).fetchone()
    blocked = conn.execute(
        "SELECT COUNT(*) FROM work_tasks s WHERE s.project_id = ? AND s.archived_at IS NULL AND s.status <> 'done' "
        "AND EXISTS (SELECT 1 FROM work_dependencies d JOIN work_tasks p ON p.id = d.predecessor_id "
        "  WHERE d.successor_id = s.id AND d.project_id = s.project_id AND p.project_id = s.project_id "
        "  AND p.archived_at IS NULL AND p.status <> 'done')",
        (project_id,),
    ).fetchone()
    milestone = conn.execute(
        "SELECT id, number, title, start_date FROM work_tasks WHERE project_id = ? AND archived_at IS NULL "
        "AND is_milestone = 1 AND start_date IS NOT NULL AND status <> 'done' ORDER BY start_date, number LIMIT 1",
        (project_id,),
    ).fetchone()
    return {
        "by_status": by_status,
        "total": int(row[0]),
        "milestones": int(row[1]),
        "unscheduled": int(row[2]),
        "overdue": int(row[3]),
        "blocked": int(blocked[0]),
        "next_milestone": milestone,
    }


def count_active_tasks(conn: sqlite3.Connection, project_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM work_tasks WHERE project_id = ? AND archived_at IS NULL", (project_id,)
    ).fetchone()
    return int(row[0])


def update_task(
    conn: sqlite3.Connection,
    task_id: str,
    expected_version: int,
    fields: Mapping[str, Any],
    actor: str,
    at: str,
) -> bool:
    unknown = set(fields) - TASK_FIELDS
    if unknown:
        raise ValueError(f"not updatable: {sorted(unknown)}")
    assignments = "".join(f", {name} = ?" for name in fields)
    cursor = conn.execute(
        f"UPDATE work_tasks SET version = version + 1, updated_by = ?, updated_at = ?{assignments} "
        "WHERE id = ? AND version = ?",
        (actor, at, *fields.values(), task_id, expected_version),
    )
    return cursor.rowcount == 1


def descendants(conn: sqlite3.Connection, task_id: str) -> list[Row]:
    """All descendants (any depth, also archived), nearest first — a recursive CTE (SQLite and PostgreSQL)."""
    return list(
        conn.execute(
            "WITH RECURSIVE sub(id, depth) AS ("
            "  SELECT id, 1 FROM work_tasks WHERE parent_task_id = ?"
            "  UNION ALL SELECT t.id, sub.depth + 1 FROM work_tasks t JOIN sub ON t.parent_task_id = sub.id"
            ") SELECT work_tasks.*, sub.depth AS rel_depth FROM work_tasks JOIN sub ON work_tasks.id = sub.id "
            "ORDER BY sub.depth, work_tasks.number",
            (task_id,),
        ).fetchall()
    )


# --- dependencies ----------------------------------------------------------------------------------------------
def insert_dependency(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_dependencies ({columns}) VALUES ({placeholders})", dict(row))


def get_dependency(conn: sqlite3.Connection, dependency_id: str) -> Row | None:
    row: Row | None = conn.execute(
        "SELECT * FROM work_dependencies WHERE id = ?", (dependency_id,)
    ).fetchone()
    return row


def project_dependencies(conn: sqlite3.Connection, project_id: str) -> list[RowDict]:
    """Edges whose both ends are active tasks (archiving removes a task's edges; this is defence in depth). One step
    (`_rows_in_one_step`), ordered by (created_at, id) — text compares by code point, as SQLite's BINARY collation."""
    rows = _rows_in_one_step(
        conn,
        DEPENDENCY_COLUMNS,
        "d",
        "FROM work_dependencies d "
        "JOIN work_tasks p ON p.id = d.predecessor_id AND p.archived_at IS NULL "
        "JOIN work_tasks s ON s.id = d.successor_id AND s.archived_at IS NULL "
        "WHERE d.project_id = ?",
        (project_id,),
    )
    rows.sort(key=lambda r: (r["created_at"], r["id"]))
    return rows


def task_active_dependencies(conn: sqlite3.Connection, project_id: str, task_id: str) -> list[Row]:
    """`project_dependencies` restricted to the edges of ONE task (both ends active), in the same order."""
    return list(
        conn.execute(
            "SELECT d.* FROM work_dependencies d "
            "JOIN work_tasks p ON p.id = d.predecessor_id AND p.archived_at IS NULL "
            "JOIN work_tasks s ON s.id = d.successor_id AND s.archived_at IS NULL "
            "WHERE d.project_id = ? AND (d.predecessor_id = ? OR d.successor_id = ?) ORDER BY d.created_at, d.id",
            (project_id, task_id, task_id),
        ).fetchall()
    )


def task_dependencies(conn: sqlite3.Connection, task_id: str) -> list[Row]:
    return list(
        conn.execute(
            "SELECT * FROM work_dependencies WHERE predecessor_id = ? OR successor_id = ? ORDER BY created_at, id",
            (task_id, task_id),
        ).fetchall()
    )


def delete_dependency(conn: sqlite3.Connection, dependency_id: str) -> bool:
    return conn.execute("DELETE FROM work_dependencies WHERE id = ?", (dependency_id,)).rowcount == 1


def count_dependencies(conn: sqlite3.Connection, project_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM work_dependencies WHERE project_id = ?", (project_id,)
    ).fetchone()
    return int(row[0])


# --- task ↔ document links (Step 4) ----------------------------------------------------------------------------
def active_document_links(
    conn: sqlite3.Connection, project_id: str, task_id: str | None = None
) -> dict[str, list[str]]:
    """Active SKH document links of a project (or of one of its tasks): task id → linked document ids (stored
    canonical ids, link order). Visibility is decided by the caller against the reader's knowledge snapshot."""
    sql = (
        "SELECT task_id, document_id FROM work_task_links WHERE project_id = ? AND status = 'active' "
        "AND target_type = 'document' AND source_system = 'skh'"
    )
    params: list[Any] = [project_id]
    if task_id is not None:
        sql += " AND task_id = ?"
        params.append(task_id)
    links: dict[str, list[str]] = {}
    for row in conn.execute(sql + " ORDER BY created_at, id", params).fetchall():
        links.setdefault(str(row[0]), []).append(str(row[1]))
    return links


def insert_link(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_task_links ({columns}) VALUES ({placeholders})", dict(row))


def get_link(conn: sqlite3.Connection, link_id: str) -> Row | None:
    row: Row | None = conn.execute("SELECT * FROM work_task_links WHERE id = ?", (link_id,)).fetchone()
    return row


def task_links(conn: sqlite3.Connection, task_id: str) -> list[Row]:
    return list(
        conn.execute(
            "SELECT * FROM work_task_links WHERE task_id = ? AND status = 'active' ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
    )


def find_active_link(conn: sqlite3.Connection, task_id: str, document_id: str, relation: str) -> Row | None:
    row: Row | None = conn.execute(
        "SELECT * FROM work_task_links WHERE task_id = ? AND source_system = 'skh' AND document_id = ? "
        "AND relation = ? AND status = 'active'",
        (task_id, document_id, relation),
    ).fetchone()
    return row


def document_links(conn: sqlite3.Connection, document_id: str) -> list[Row]:
    """Active links to one document across projects, with the task and project rows the caller needs."""
    return list(
        conn.execute(
            "SELECT l.id AS link_id, l.relation, l.revision_at_link, l.project_id, l.task_id, t.number, t.title, "
            "t.status, t.archived_at, p.key AS project_key, p.title AS project_title, p.status AS project_status "
            "FROM work_task_links l JOIN work_tasks t ON t.id = l.task_id JOIN work_projects p ON p.id = l.project_id "
            "WHERE l.source_system = 'skh' AND l.document_id = ? AND l.status = 'active' "
            "ORDER BY p.key, t.number, l.created_at",
            (document_id,),
        ).fetchall()
    )


def project_link_rows(conn: sqlite3.Connection, project_id: str) -> list[Row]:
    """Active document links of a project with the task's archive state (the project's linked documents)."""
    return list(
        conn.execute(
            "SELECT l.id, l.task_id, l.document_id, l.revision_at_link FROM work_task_links l "
            "JOIN work_tasks t ON t.id = l.task_id AND t.archived_at IS NULL "
            "WHERE l.project_id = ? AND l.status = 'active' AND l.source_system = 'skh' ORDER BY l.created_at",
            (project_id,),
        ).fetchall()
    )


def remove_link(conn: sqlite3.Connection, link_id: str, actor: str, at: str) -> bool:
    cursor = conn.execute(
        "UPDATE work_task_links SET status = 'removed', removed_by = ?, removed_at = ? "
        "WHERE id = ? AND status = 'active'",
        (actor, at, link_id),
    )
    return cursor.rowcount == 1


def set_link_revision(conn: sqlite3.Connection, link_id: str, revision: str) -> bool:
    cursor = conn.execute(
        "UPDATE work_task_links SET revision_at_link = ? WHERE id = ? AND status = 'active'",
        (revision, link_id),
    )
    return cursor.rowcount == 1


# --- audit (append-only: UPDATE/DELETE are refused by triggers) ------------------------------------------------
def insert_audit(
    conn: sqlite3.Connection,
    *,
    at: str,
    actor_id: str,
    operation: str,
    entity_type: str,
    entity_id: str,
    project_id: str,
    task_id: str | None,
    correlation_id: str | None,
    changes: Mapping[str, Any],
    related_task_id: str | None = None,
) -> None:
    payload = dict(changes)
    if related_task_id is not None:
        payload.setdefault("related_task_id", related_task_id)
    conn.execute(
        "INSERT INTO work_audit_events (id, at, actor_id, operation, entity_type, entity_id, project_id, task_id, "
        "related_task_id, correlation_id, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            new_id(),
            at,
            actor_id,
            operation,
            entity_type,
            entity_id,
            project_id,
            task_id,
            related_task_id,
            correlation_id,
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str),
        ),
    )


def audit_page_query(
    *, project_id: str, task_id: str | None, before_seq: int | None, limit: int
) -> tuple[str, list[Any]]:
    """The SQL of one activity page, newest first.

    A task's page (B2, audit CODE-015) reads its own events through `work_audit_by_task` and the events that name it
    as the related task through `work_audit_by_related_task` — each side at most `limit` rows from its index — instead
    of filtering the whole audit of the project. An event that names the task twice is taken once (from the first
    side). The project condition is applied to the merged rows (in a branch it would steer SQLite to the project
    index); a task's events are written with its own project, so this is the same rows and order as
    `project_id = ? AND (task_id = ? OR related_task_id = ?) ORDER BY seq DESC`, and the filter stays as a guard."""
    before = " AND seq < ?" if before_seq is not None else ""
    tail: list[Any] = [before_seq] if before_seq is not None else []
    if task_id is None:
        return (
            f"SELECT * FROM work_audit_events WHERE project_id = ?{before} ORDER BY seq DESC LIMIT ?",
            [project_id, *tail, limit],
        )
    own = f"SELECT * FROM work_audit_events WHERE task_id = ?{before} ORDER BY seq DESC LIMIT ?"
    related = (
        f"SELECT * FROM work_audit_events WHERE related_task_id = ? AND task_id IS NOT ?{before} "
        "ORDER BY seq DESC LIMIT ?"
    )
    return (
        f"SELECT * FROM (SELECT * FROM ({own}) UNION ALL SELECT * FROM ({related})) WHERE project_id = ? "
        "ORDER BY seq DESC LIMIT ?",
        [task_id, *tail, limit, task_id, task_id, *tail, limit, project_id, limit],
    )


def audit_page(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    task_id: str | None,
    before_seq: int | None,
    limit: int,
) -> list[Row]:
    sql, params = audit_page_query(project_id=project_id, task_id=task_id, before_seq=before_seq, limit=limit)
    return list(conn.execute(sql, params).fetchall())


def count_audit(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT COUNT(*) FROM work_audit_events").fetchone()[0])


# --- idempotency -----------------------------------------------------------------------------------------------
def get_idempotent(conn: sqlite3.Connection, scope: str, actor_id: str, key: str) -> Row | None:
    row: Row | None = conn.execute(
        "SELECT * FROM work_idempotency WHERE scope = ? AND actor_id = ? AND key = ?", (scope, actor_id, key)
    ).fetchone()
    return row


def put_idempotent(
    conn: sqlite3.Connection,
    *,
    scope: str,
    actor_id: str,
    key: str,
    request_hash: str,
    status_code: int,
    response: Mapping[str, Any],
    at: str,
) -> None:
    conn.execute(
        "INSERT INTO work_idempotency (scope, actor_id, key, request_hash, status_code, response_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (scope, actor_id, key, request_hash, status_code, json.dumps(response, ensure_ascii=False), at),
    )


# --- schedule previews -----------------------------------------------------------------------------------------
def insert_preview(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_schedule_previews ({columns}) VALUES ({placeholders})", dict(row))


def get_preview(conn: sqlite3.Connection, preview_id: str) -> Row | None:
    row: Row | None = conn.execute(
        "SELECT * FROM work_schedule_previews WHERE id = ?", (preview_id,)
    ).fetchone()
    return row


def mark_preview_applied(conn: sqlite3.Connection, preview_id: str, at: str, plan_revision: int) -> bool:
    cursor = conn.execute(
        "UPDATE work_schedule_previews SET applied_at = ?, applied_plan_revision = ? "
        "WHERE id = ? AND applied_at IS NULL",
        (at, plan_revision, preview_id),
    )
    return cursor.rowcount == 1


def purge_retained(conn: sqlite3.Connection, older_than: str) -> int:
    """Technical records past their retention window (audit CODE-014): idempotency replays created before
    `older_than` and previews applied before it. The history of what happened is the audit, which is never deleted."""
    replays = conn.execute("DELETE FROM work_idempotency WHERE created_at < ?", (older_than,)).rowcount
    applied = conn.execute(
        "DELETE FROM work_schedule_previews WHERE applied_at IS NOT NULL AND applied_at < ?", (older_than,)
    ).rowcount
    return int(replays) + int(applied)


def purge_previews(conn: sqlite3.Connection, older_than: str) -> int:
    """Drop unapplied previews that expired before `older_than` (applied ones stay as the apply record)."""
    return conn.execute(
        "DELETE FROM work_schedule_previews WHERE applied_at IS NULL AND expires_at < ?", (older_than,)
    ).rowcount


# --- AI task-plan proposals (Step 5) ---------------------------------------------------------------------------
def insert_proposal(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_ai_proposals ({columns}) VALUES ({placeholders})", dict(row))


def get_proposal(conn: sqlite3.Connection, proposal_id: str) -> Row | None:
    row: Row | None = conn.execute("SELECT * FROM work_ai_proposals WHERE id = ?", (proposal_id,)).fetchone()
    return row


def decide_proposal(
    conn: sqlite3.Connection,
    proposal_id: str,
    status: str,
    actor: str,
    at: str,
    result: Mapping[str, Any] | None,
) -> bool:
    """suggested → applied | rejected, once (compare-and-set on the status)."""
    cursor = conn.execute(
        "UPDATE work_ai_proposals SET status = ?, decided_by = ?, decided_at = ?, result_json = ? "
        "WHERE id = ? AND status = 'suggested'",
        (
            status,
            actor,
            at,
            json.dumps(result, ensure_ascii=False) if result is not None else None,
            proposal_id,
        ),
    )
    return cursor.rowcount == 1


# --- M7: change-set proposals for existing tasks ------------------------------------------------------------------
def insert_change_proposal(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join(f":{k}" for k in row)
    conn.execute(f"INSERT INTO work_task_change_proposals ({columns}) VALUES ({placeholders})", dict(row))


def get_change_proposal(conn: sqlite3.Connection, proposal_id: str) -> Row | None:
    row: Row | None = conn.execute(
        "SELECT * FROM work_task_change_proposals WHERE id = ?", (proposal_id,)
    ).fetchone()
    return row


def decide_change_proposal(
    conn: sqlite3.Connection,
    proposal_id: str,
    status: str,
    actor: str,
    at: str,
    result: Mapping[str, Any] | None,
) -> bool:
    """suggested → applied | rejected, once (compare-and-set on the status)."""
    cursor = conn.execute(
        "UPDATE work_task_change_proposals SET status = ?, decided_by = ?, decided_at = ?, result_json = ? "
        "WHERE id = ? AND status = 'suggested'",
        (
            status,
            actor,
            at,
            json.dumps(result, ensure_ascii=False) if result is not None else None,
            proposal_id,
        ),
    )
    return cursor.rowcount == 1
