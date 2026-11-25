"""work.sqlite3: versioned migrations, backup/restore, append-only audit, FK, and concurrency between independent
connections/services (lost updates, concurrent key allocation). Gate 1 «Stable DB»; M6-17, M6-21."""

from __future__ import annotations

import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.domain.models import UserContext
from app.errors import ApiError
from app.tools import work_db
from app.work import migrations, store
from app.work.db import WorkDatabase, WorkSchemaError, backup_database, schema_version, verify_database
from app.work.models import ProjectCreate, TaskCreate, TaskUpdate
from app.work.permissions import WorkAccessGate, WorkAccessMode, WorkPrincipal
from app.work.seed import seed_demo
from app.work.service import WorkService

OPERATOR = UserContext(user_id="local-demo-user", display_name="demo", is_demo=True)
P = WorkPrincipal(user=OPERATOR, request_id="test")


def service(path: Path) -> WorkService:
    return WorkService(WorkDatabase(path), WorkAccessGate(WorkAccessMode.local_operator), operator=OPERATOR)


def test_fresh_database_is_migrated_with_fk_wal_and_a_migration_record(tmp_path: Path) -> None:
    db = WorkDatabase(tmp_path / "work.sqlite3")
    assert schema_version(db.path) == migrations.LATEST_VERSION
    with db.read() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        rows = conn.execute("SELECT version, name, checksum FROM work_schema_migrations").fetchall()
        assert [(r[0], r[1]) for r in rows] == [(m.version, m.name) for m in migrations.MIGRATIONS]
        assert rows[0][2] == migrations.MIGRATIONS[0].checksum
        indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        assert {"work_tasks_by_status", "work_tasks_by_assignee", "work_tasks_by_start"} <= indexes
    assert db.backups == []  # nothing to back up on a fresh file
    assert verify_database(db.path) == []
    WorkDatabase(db.path)  # re-opening is idempotent
    assert schema_version(db.path) == migrations.LATEST_VERSION


def test_a_newer_schema_or_an_edited_migration_refuses_to_start(tmp_path: Path) -> None:
    path = tmp_path / "work.sqlite3"
    WorkDatabase(path)
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {migrations.LATEST_VERSION + 1}")
    conn.close()
    with pytest.raises(WorkSchemaError, match="newer"):
        WorkDatabase(path)
    other = tmp_path / "other.sqlite3"
    WorkDatabase(other)
    conn = sqlite3.connect(other)
    conn.execute("UPDATE work_schema_migrations SET checksum = 'tampered'")
    conn.commit()
    conn.close()
    with pytest.raises(WorkSchemaError, match="never be edited"):
        WorkDatabase(other)


def test_upgrade_backs_up_first_and_the_backup_restores(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "work.sqlite3"
    svc = service(path)
    project = svc.create_project(P, ProjectCreate(key="BAK", title="До миграции"))
    current = migrations.LATEST_VERSION
    nxt = migrations.Migration(
        current + 1, "test_extra_column", ("ALTER TABLE work_projects ADD COLUMN extra TEXT",)
    )
    monkeypatch.setattr("app.work.db.MIGRATIONS", (*migrations.MIGRATIONS, nxt))
    monkeypatch.setattr("app.work.db.LATEST_VERSION", current + 1)
    upgraded = WorkDatabase(path)
    assert schema_version(path) == current + 1
    assert len(upgraded.backups) == 1
    assert upgraded.backups[0].name.startswith(f"work.sqlite3.pre-v{current + 1}-")
    backup = upgraded.backups[0]
    assert schema_version(backup) == current and verify_database(backup) == []
    # rollback = restore the backup over the database (application stopped); the previous version opens it
    restored = tmp_path / "restored.sqlite3"
    backup_database(backup, restored)
    with sqlite3.connect(restored) as conn:
        assert (
            conn.execute("SELECT key FROM work_projects WHERE id = ?", (project.id,)).fetchone()[0] == "BAK"
        )
        columns = {r[1] for r in conn.execute("PRAGMA table_info(work_projects)")}
        assert "extra" not in columns


def test_audit_is_append_only_and_foreign_keys_hold(tmp_path: Path) -> None:
    svc = service(tmp_path / "work.sqlite3")
    project = svc.create_project(P, ProjectCreate(key="AUD", title="Аудит"))
    svc.create_task(P, project.id, TaskCreate(title="Задача"))
    with svc.db.write() as conn, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("UPDATE work_audit_events SET actor_id = 'someone-else'")
    with svc.db.write() as conn, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("DELETE FROM work_audit_events")
    with svc.db.write() as conn, pytest.raises(sqlite3.IntegrityError):
        store.insert_task(
            conn,
            {
                "id": "x",
                "project_id": "missing-project",
                "number": 1,
                "title": "t",
                "status": "todo",
                "priority": "low",
                "created_by": "a",
                "created_at": "t",
                "updated_by": "a",
                "updated_at": "t",
            },
        )
    with (
        svc.db.write() as conn,
        pytest.raises(sqlite3.IntegrityError),
    ):  # end before start is refused by the schema
        conn.execute(
            "UPDATE work_tasks SET start_date = '2026-12-02', end_exclusive = '2026-12-01' WHERE project_id = ?",
            (project.id,),
        )


def test_write_unit_rolls_back_everything_on_error(tmp_path: Path) -> None:
    svc = service(tmp_path / "work.sqlite3")
    project = svc.create_project(P, ProjectCreate(key="RBK", title="Откат"))
    with pytest.raises(RuntimeError), svc.db.write() as conn:
        store.bump_plan_revision(conn, project.id)
        raise RuntimeError("boom")
    assert svc.get_project(P, project.id).plan_revision == project.plan_revision


def test_m6_17_two_services_on_one_file_cannot_lose_an_update(tmp_path: Path) -> None:
    """Two independent services (two connections — like two processes) edit the same version concurrently:
    exactly one wins, the other gets 409 stale_task; nothing is silently overwritten."""
    path = tmp_path / "work.sqlite3"
    first, second = (
        service(path),
        WorkService(WorkDatabase(path), WorkAccessGate(WorkAccessMode.local_operator), operator=OPERATOR),
    )
    project = first.create_project(P, ProjectCreate(key="LOST", title="Гонка"))
    task = first.create_task(P, project.id, TaskCreate(title="Исходное"))
    barrier = threading.Barrier(2)
    outcomes: list[str] = []

    def edit(svc: WorkService, title: str) -> None:
        barrier.wait()
        try:
            svc.update_task(P, task.id, TaskUpdate(expected_version=task.version, title=title))
            outcomes.append("ok")
        except ApiError as exc:
            outcomes.append(exc.code)

    threads = [threading.Thread(target=edit, args=(s, t)) for s, t in ((first, "Первый"), (second, "Второй"))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(outcomes) == ["ok", "stale_task"]
    final = first.get_task(P, task.id)
    assert final.version == task.version + 1 and final.title in ("Первый", "Второй")


def test_concurrent_task_creation_allocates_unique_keys(tmp_path: Path) -> None:
    path = tmp_path / "work.sqlite3"
    services = [service(path)] + [
        WorkService(WorkDatabase(path), WorkAccessGate(WorkAccessMode.local_operator), operator=OPERATOR)
        for _ in range(3)
    ]
    project = services[0].create_project(P, ProjectCreate(key="KEYS", title="Ключи"))
    keys: list[str] = []
    lock = threading.Lock()

    def create(svc: WorkService, n: int) -> None:
        for i in range(10):
            out = svc.create_task(P, project.id, TaskCreate(title=f"Задача {n}-{i}"))
            with lock:
                keys.append(out.key)

    threads = [threading.Thread(target=create, args=(s, n)) for n, s in enumerate(services)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(keys) == 40 and len(set(keys)) == 40
    assert sorted(int(k.split("-")[1]) for k in keys) == list(range(1, 41))


def test_m6_22_seed_is_idempotent_and_never_touches_user_data(tmp_path: Path) -> None:
    svc = service(tmp_path / "work.sqlite3")
    now = datetime(2026, 11, 24, 9, 0, tzinfo=UTC)
    user_project = svc.create_project(
        P, ProjectCreate(key="RAG", title="Проект пользователя")
    )  # takes a demo key
    first = seed_demo(svc.db, now=now, timezone="Europe/Moscow")
    assert first.created == ["ARIS", "DQI"] and first.skipped_key_conflict == ["RAG"]
    aris = svc.get_project(P, "ARIS")
    mine = svc.create_task(P, aris.id, TaskCreate(title="Моя задача в демо-проекте"))
    edited = svc.update_task(P, "ARIS-1", TaskUpdate(expected_version=1, title="Переименовано оператором"))
    second = seed_demo(svc.db, now=now, timezone="Europe/Moscow")
    assert second.created == [] and second.skipped_existing == ["ARIS", "DQI"] and second.tasks_created == 0
    assert svc.get_task(P, mine.id).title == "Моя задача в демо-проекте"
    assert svc.get_task(P, "ARIS-1").title == edited.title == "Переименовано оператором"
    assert svc.get_project(P, user_project.id).title == "Проект пользователя"
    assert svc.get_project(P, user_project.id).is_demo is False
    assert svc.list_tasks(P, user_project.id).total == 0


def test_work_db_tool_status_backup_verify(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "work.sqlite3"
    svc = service(path)
    svc.create_project(P, ProjectCreate(key="TOOL", title="Инструмент"))
    assert work_db.main(["--db", str(path), "status"]) == 0
    assert f"schema v{migrations.LATEST_VERSION}" in capsys.readouterr().out
    target = tmp_path / "backups" / "copy.sqlite3"
    assert work_db.main(["--db", str(path), "backup", "--out", str(target)]) == 0
    assert work_db.main(["--db", str(target), "verify"]) == 0
    restored = tmp_path / "restored.sqlite3"
    assert work_db.main(["--db", str(restored), "restore", "--from", str(target)]) == 2  # needs --yes
    assert work_db.main(["--db", str(restored), "restore", "--from", str(target), "--yes"]) == 0
    assert service(restored).get_project(P, "TOOL").title == "Инструмент"


def test_v1_database_upgrades_to_task_links_with_a_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real v1 file (Steps 1–3) is upgraded by the released v2 migration: backup first, data kept, the partial
    unique index forbids a second ACTIVE link of the same (task, document, relation) while history rows stay."""
    path = tmp_path / "work.sqlite3"
    monkeypatch.setattr("app.work.db.MIGRATIONS", migrations.MIGRATIONS[:1])
    monkeypatch.setattr("app.work.db.LATEST_VERSION", 1)
    old = service(path)
    project = old.create_project(P, ProjectCreate(key="UPG", title="До v2"))
    created = old.create_task(P, project.id, TaskCreate(title="Задача"))
    assert schema_version(path) == 1
    monkeypatch.setattr("app.work.db.MIGRATIONS", migrations.MIGRATIONS)
    monkeypatch.setattr("app.work.db.LATEST_VERSION", migrations.LATEST_VERSION)
    upgraded = WorkDatabase(path)
    assert schema_version(path) == migrations.LATEST_VERSION
    assert len(upgraded.backups) == 1 and schema_version(upgraded.backups[0]) == 1
    assert (
        verify_database(upgraded.backups[0]) == []
    )  # a v1 backup is checked against v1, so it stays restorable
    row = {
        "project_id": project.id,
        "task_id": created.id,
        "target_type": "document",
        "source_system": "skh",
        "document_id": "SEM-ARCH-001",
        "relation": "implements",
        "revision_at_link": "r1",
        "created_by": "local-demo-user",
        "created_at": "2026-11-25T00:00:00+00:00",
    }
    with upgraded.write() as conn:
        assert conn.execute("SELECT key FROM work_projects").fetchone()[0] == "UPG"
        store.insert_link(conn, {"id": "l1", "status": "removed", **row})
        store.insert_link(conn, {"id": "l2", "status": "active", **row})
    with upgraded.write() as conn, pytest.raises(sqlite3.IntegrityError):
        store.insert_link(conn, {"id": "l3", "status": "active", **row})
