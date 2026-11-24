"""`work.sqlite3`: connections, versioned migrations, consistent backups (M6).

Why a separate database file (not tables in `app_state.sqlite3`): the work schema has its own migration history,
backup and restore cycle; a failed or rolled-back M6 migration can never touch proposals, discovery memory or the
template registry, and the precedent exists (`publications.sqlite3`). Decision: docs/WORK_MANAGEMENT.md «Хранение».

Concurrency model: one short-lived connection per unit of work (never one connection shared by parallel HTTP
requests). Writes run in `BEGIN IMMEDIATE` (one writer at a time, others wait up to `busy_timeout`); reads run in a
deferred transaction, which in WAL mode is a consistent snapshot — a Gantt is never assembled from two states.
`PRAGMA foreign_keys=ON` on every connection. WAL is a concurrency aid, not a substitute for transactions.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from app.work.migrations import LATEST_VERSION, MIGRATIONS, REQUIRED_TABLES

logger = logging.getLogger("skh.work.db")

BUSY_TIMEOUT_MS = 10_000


class WorkSchemaError(RuntimeError):
    """The database cannot be used by this application version (fail closed at start)."""


def _utc_stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(
        str(path), timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    return conn


def backup_database(source: Path, target: Path) -> Path:
    """A consistent copy (SQLite online backup API: committed WAL content included, writers may continue)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    src = _connect(source)
    try:
        dst = sqlite3.connect(str(target))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return target


def schema_version(path: Path) -> int:
    conn = _connect(path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def verify_database(path: Path) -> list[str]:
    """Problems that make a database (e.g. a backup before restore) unusable; empty = fine."""
    if not path.is_file():
        return [f"файл не найден: {path}"]
    problems: list[str] = []
    conn = _connect(path)
    try:
        integrity = [row[0] for row in conn.execute("PRAGMA integrity_check").fetchall()]
        if integrity != ["ok"]:
            problems.append("integrity_check: " + "; ".join(integrity[:5]))
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if version > LATEST_VERSION:
            problems.append(f"схема v{version} новее, чем знает приложение (v{LATEST_VERSION})")
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if version >= 1:
            missing = sorted(REQUIRED_TABLES - tables)
            if missing:
                problems.append("нет таблиц: " + ", ".join(missing))
            if conn.execute("PRAGMA foreign_key_check").fetchall():
                problems.append("нарушены внешние ключи (foreign_key_check)")
    finally:
        conn.close()
    return problems


class WorkDatabase:
    """Opens (and migrates) `work.sqlite3`; hands out one connection per unit of work."""

    def __init__(self, path: Path, *, backup_before_migrate: bool = True) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.backups: list[Path] = []
        self._migrate(backup_before_migrate)

    # --- units of work -------------------------------------------------------------------------------------------
    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """A consistent read snapshot (deferred transaction; WAL readers do not block the writer)."""
        conn = _connect(self.path)
        try:
            conn.execute("BEGIN")
            yield conn
        finally:
            try:
                conn.execute("ROLLBACK")
            finally:
                conn.close()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """One atomic write transaction: commit on success, roll EVERYTHING back on any exception."""
        conn = _connect(self.path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    # --- migrations ----------------------------------------------------------------------------------------------
    def _migrate(self, backup_before_migrate: bool) -> None:
        conn = _connect(self.path)
        try:
            mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            if str(mode).lower() != "wal":
                logger.warning("work db: journal_mode=%s (WAL unavailable on this filesystem)", mode)
            current = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if current > LATEST_VERSION:
                raise WorkSchemaError(
                    f"work.sqlite3 has schema v{current}, newer than this application (v{LATEST_VERSION}); "
                    "restore the backup that matches this version or upgrade the application."
                )
            self._verify_applied_checksums(conn, current)
            pending = [m for m in MIGRATIONS if m.version > current]
            if pending and current > 0 and backup_before_migrate:
                target = self.path.with_name(
                    f"{self.path.name}.pre-v{pending[-1].version}-{_utc_stamp()}.bak"
                )
                conn.close()
                self.backups.append(backup_database(self.path, target))
                logger.info("work db: backup before migration → %s", target.name)
                conn = _connect(self.path)
            for migration in pending:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    # Another process may have migrated meanwhile: re-read inside the write lock.
                    if int(conn.execute("PRAGMA user_version").fetchone()[0]) >= migration.version:
                        conn.execute("ROLLBACK")
                        continue
                    for statement in migration.statements:
                        conn.execute(statement)
                    conn.execute(
                        "INSERT INTO work_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
                        (
                            migration.version,
                            migration.name,
                            migration.checksum,
                            datetime.now(UTC).isoformat(),
                        ),
                    )
                    conn.execute(f"PRAGMA user_version = {int(migration.version)}")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                logger.info("work db: applied migration v%s %s", migration.version, migration.name)
            problems = self._schema_problems(conn)
            if problems:
                raise WorkSchemaError("work.sqlite3 schema check failed: " + "; ".join(problems))
        finally:
            conn.close()

    @staticmethod
    def _verify_applied_checksums(conn: sqlite3.Connection, current: int) -> None:
        if current == 0:
            return
        known = {m.version: m for m in MIGRATIONS}
        for row in conn.execute(
            "SELECT version, name, checksum FROM work_schema_migrations ORDER BY version"
        ):
            migration = known.get(int(row["version"]))
            if migration is None or migration.checksum != row["checksum"]:
                raise WorkSchemaError(
                    f"work.sqlite3 migration v{row['version']} ({row['name']}) differs from this application's "
                    "definition: released migrations must never be edited."
                )

    @staticmethod
    def _schema_problems(conn: sqlite3.Connection) -> list[str]:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        problems = [f"missing table {name}" for name in sorted(REQUIRED_TABLES - tables)]
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            problems.append("foreign_key_check reported violations")
        return problems
