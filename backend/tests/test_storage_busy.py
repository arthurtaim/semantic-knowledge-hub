"""Post-M6 remediation A5 (audit SYS-006): a SQLite database held by another connection is a controlled, retryable
503 `storage_busy` (with Retry-After), not an unhandled 500. Only SQLITE_BUSY / SQLITE_LOCKED are mapped; every other
SQLite error still surfaces as the 500 it is. A refused write leaves nothing behind, and a retry with the same
idempotency key runs exactly once. `busy_timeout` is the bounded wait: a lock released in time is simply waited for."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.errors import is_storage_busy
from app.work import db as work_db
from app.work import store

Client = Callable[..., TestClient]


@pytest.fixture
def wc(client_factory: Client, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    client = client_factory(work_seed_demo=False)
    assert client.post("/api/projects", json={"key": "BSY", "title": "Занятая база"}).status_code == 201
    monkeypatch.setattr(work_db, "BUSY_TIMEOUT_MS", 200)  # keep the test fast; production waits 10 s
    return client


def db_path(client: TestClient) -> Path:
    return Path(client.app.state.container.work.db.path)  # type: ignore[attr-defined]


@contextmanager
def held(path: Path) -> Iterator[sqlite3.Connection]:
    """Another process/connection holding the write lock (a backup, a manual sqlite3 session…)."""
    other = sqlite3.connect(str(path), isolation_level=None, timeout=0)
    other.execute("BEGIN EXCLUSIVE")
    try:
        yield other
    finally:
        other.execute("ROLLBACK")
        other.close()


def counts(client: TestClient) -> tuple[int, int, int]:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        tasks = conn.execute("SELECT COUNT(*) FROM work_tasks").fetchone()[0]
        revision = conn.execute("SELECT plan_revision FROM work_projects WHERE key = 'BSY'").fetchone()[0]
        return int(tasks), int(revision), store.count_audit(conn)


def create(client: TestClient, key: str = "busy-create-0001") -> object:
    return client.post(
        "/api/projects/BSY/tasks", json={"title": "Во время блокировки", "client_request_id": key}
    )


def test_a_locked_database_is_a_retryable_503_and_nothing_is_written(wc: TestClient) -> None:
    before = counts(wc)
    with held(db_path(wc)):
        # the default TestClient re-raises unhandled server exceptions: a response here proves it was handled
        refused = create(wc)
        assert wc.get("/api/projects/BSY").status_code == 200  # WAL readers keep working meanwhile

    assert refused.status_code == 503, refused.text
    assert refused.headers["Retry-After"] == "2"
    body = refused.json()
    assert body["code"] == "storage_busy" and body["details"] == {"retryable": True}
    assert body["request_id"] and "повтор" in body["message"].lower()
    assert counts(wc) == before
    with wc.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_the_retry_with_the_same_idempotency_key_writes_exactly_once(wc: TestClient) -> None:
    tasks, revision, audit = counts(wc)
    with held(db_path(wc)):
        assert create(wc).status_code == 503

    first = create(wc)
    again = create(wc)

    assert first.status_code == 201, first.text
    assert (
        again.status_code == 201 and again.json()["id"] == first.json()["id"]
    )  # replayed, not a second task
    assert counts(wc) == (tasks + 1, revision + 1, audit + 1)


def test_a_lock_released_within_busy_timeout_is_waited_for(
    wc: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(work_db, "BUSY_TIMEOUT_MS", 5000)
    other = sqlite3.connect(str(db_path(wc)), isolation_level=None, timeout=0, check_same_thread=False)
    other.execute("BEGIN EXCLUSIVE")
    release = threading.Timer(0.3, lambda: (other.execute("ROLLBACK"), other.close()))
    release.start()
    try:
        response = create(wc, "busy-wait-0001")
    finally:
        release.join()
    assert response.status_code == 201, response.text


def test_other_sqlite_errors_are_not_masked_as_busy(wc: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_args: object, **_kwargs: object) -> None:
        raise sqlite3.OperationalError("no such table: work_tasks")

    monkeypatch.setattr(store, "insert_task", broken)
    lenient = TestClient(
        wc.app, base_url="http://localhost", headers=dict(wc.headers), raise_server_exceptions=False
    )
    response = lenient.post("/api/projects/BSY/tasks", json={"title": "x"})
    assert response.status_code == 500 and response.json()["code"] == "internal_error"


@pytest.mark.parametrize(
    "exc,busy",
    [
        (sqlite3.OperationalError("database is locked"), True),
        (sqlite3.OperationalError("database table is locked"), True),
        (sqlite3.OperationalError("disk I/O error"), False),
        (sqlite3.IntegrityError("UNIQUE constraint failed"), False),
        (ValueError("database is locked"), False),
    ],
)
def test_only_busy_and_locked_are_storage_busy(exc: BaseException, busy: bool) -> None:
    assert is_storage_busy(exc) is busy
