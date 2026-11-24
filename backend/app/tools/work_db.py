"""Operator tool for the M6 work database (docs/WORK_MANAGEMENT.md «Резервная копия и откат»).

    python -m app.tools.work_db status                  # schema version, counts, integrity
    python -m app.tools.work_db migrate                 # apply pending migrations (backup first)
    python -m app.tools.work_db backup --out FILE       # consistent online backup (WAL content included)
    python -m app.tools.work_db verify                  # integrity_check + schema + foreign keys
    python -m app.tools.work_db restore --from FILE --yes   # STOP THE BACKEND FIRST; keeps a copy of the current file
    python -m app.tools.work_db seed-demo               # idempotent synthetic demo projects

`--db PATH` overrides WORK_STATE_PATH. Never prints task content. Exit: 0 ok, 1 problems, 2 usage.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from app.work.db import WorkDatabase, backup_database, schema_version, verify_database
from app.work.seed import seed_demo


def _default_db() -> Path:
    from app.config import Settings

    return Settings().work_state_file


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _counts(path: Path) -> dict[str, int]:
    conn = sqlite3.connect(path)
    try:
        return {
            table: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])  # noqa: S608 - fixed names
            for table in ("work_projects", "work_tasks", "work_dependencies", "work_audit_events")
        }
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.tools.work_db", description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=None, help="work.sqlite3 (default: WORK_STATE_PATH)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("migrate")
    sub.add_parser("verify")
    sub.add_parser("seed-demo").add_argument("--timezone", default="Europe/Moscow")
    backup = sub.add_parser("backup")
    backup.add_argument("--out", type=Path, default=None)
    restore = sub.add_parser("restore")
    restore.add_argument("--from", dest="source", type=Path, required=True)
    restore.add_argument("--yes", action="store_true", help="confirm: the backend is stopped")
    args = parser.parse_args(argv)
    path: Path = args.db or _default_db()

    if args.command == "status":
        if not path.is_file():
            print(f"{path}: нет базы (будет создана при запуске)")
            return 0
        problems = verify_database(path)
        print(
            f"{path}: schema v{schema_version(path)}; "
            + ", ".join(f"{k}={v}" for k, v in _counts(path).items())
        )
        for problem in problems:
            print(f"ПРОБЛЕМА: {problem}")
        return 1 if problems else 0
    if args.command == "migrate":
        db = WorkDatabase(path)
        print(f"{path}: schema v{schema_version(path)}" + (f"; backup {db.backups[0]}" if db.backups else ""))
        return 0
    if args.command == "verify":
        problems = verify_database(path)
        print("ok" if not problems else "\n".join(problems))
        return 1 if problems else 0
    if args.command == "backup":
        if not path.is_file():
            print(f"{path}: нет базы")
            return 1
        target = args.out or path.with_name(f"{path.name}.backup-{_stamp()}")
        backup_database(path, target)
        problems = verify_database(target)
        print(f"backup → {target}" + ("" if not problems else "; ПРОБЛЕМЫ: " + "; ".join(problems)))
        return 1 if problems else 0
    if args.command == "restore":
        if not args.yes:
            print("restore заменяет базу: остановите backend и повторите с --yes")
            return 2
        problems = verify_database(args.source)
        if problems:
            print("резервная копия непригодна: " + "; ".join(problems))
            return 1
        if path.is_file():
            keep = path.with_name(f"{path.name}.before-restore-{_stamp()}")
            backup_database(path, keep)
            print(f"текущая база сохранена → {keep}")
        for suffix in ("-wal", "-shm"):
            stale = path.with_name(path.name + suffix)
            if stale.exists():
                stale.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.source, path)
        print(f"restored {args.source} → {path} (schema v{schema_version(path)})")
        return 0
    if args.command == "seed-demo":
        db = WorkDatabase(path)
        report = seed_demo(db, now=datetime.now(UTC), timezone=args.timezone)
        print(
            f"created={report.created} skipped_existing={report.skipped_existing} "
            f"skipped_key_conflict={report.skipped_key_conflict} tasks={report.tasks_created}"
        )
        return 0
    return 2  # pragma: no cover - argparse enforces the choices


if __name__ == "__main__":
    sys.exit(main())
