"""Staged onboarding batches in the app-state SQLite (M8). Extracted TEXT only (no raw files, no file names as paths),
bound to the server-side actor, with a TTL; every item has a revision (optimistic concurrency) and a durable outcome."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS onboarding_batches (id TEXT PRIMARY KEY, actor TEXT NOT NULL, source_kind TEXT NOT "
    "NULL, state TEXT NOT NULL, file_count INTEGER NOT NULL, bytes_total INTEGER NOT NULL, upload_hash TEXT NOT NULL, "
    "revision INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, expires_ts REAL NOT NULL)",
    "CREATE INDEX IF NOT EXISTS onboarding_batches_actor ON onboarding_batches (actor, created_at)",
    "CREATE TABLE IF NOT EXISTS onboarding_items (id TEXT NOT NULL, batch_id TEXT NOT NULL, ord INTEGER NOT NULL, "
    "path TEXT NOT NULL, size INTEGER NOT NULL, checksum TEXT NOT NULL, media_type TEXT NOT NULL, parser TEXT NOT "
    "NULL, parse_status TEXT NOT NULL, analysis_json TEXT NOT NULL, content TEXT, decisions_json TEXT NOT NULL, "
    "ai_json TEXT NOT NULL, revision INTEGER NOT NULL, outcome_json TEXT, PRIMARY KEY (batch_id, id))",
    "CREATE TABLE IF NOT EXISTS onboarding_confirmations (batch_id TEXT NOT NULL, key TEXT NOT NULL, request_hash "
    "TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (batch_id, key))",
)


class OnboardingStore:
    def __init__(self, path: Path | str) -> None:
        self._lock = threading.Lock()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._conn:
            for statement in _SCHEMA:
                self._conn.execute(statement)

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock, self._conn:
            yield self._conn

    # --- batches ---------------------------------------------------------------------------------------------
    def insert_batch(self, batch: dict[str, Any], items: list[dict[str, Any]]) -> None:
        """The batch and all its items in ONE transaction: a crash mid-analysis leaves no half batch."""
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO onboarding_batches (id, actor, source_kind, state, file_count, bytes_total, upload_hash, "
                "revision, created_at, expires_at, expires_ts) VALUES (:id, :actor, :source_kind, :state, :file_count, "
                ":bytes_total, :upload_hash, :revision, :created_at, :expires_at, :expires_ts)",
                batch,
            )
            conn.executemany(
                "INSERT INTO onboarding_items (id, batch_id, ord, path, size, checksum, media_type, parser, "
                "parse_status, analysis_json, content, decisions_json, ai_json, revision, outcome_json) VALUES (:id, "
                ":batch_id, :ord, :path, :size, :checksum, :media_type, :parser, :parse_status, :analysis_json, "
                ":content, :decisions_json, :ai_json, :revision, :outcome_json)",
                items,
            )

    def batch(self, batch_id: str) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                "SELECT * FROM onboarding_batches WHERE id = ?", (batch_id,)
            ).fetchone()
            return row

    def batches_of(self, actor: str, limit: int = 20) -> list[sqlite3.Row]:
        with self._lock:
            return list(
                self._conn.execute(
                    "SELECT * FROM onboarding_batches WHERE actor = ? ORDER BY created_at DESC LIMIT ?",
                    (actor, limit),
                )
            )

    def set_batch(self, batch_id: str, *, state: str | None = None, bump: bool = True) -> int:
        """Change the state and/or bump the revision; returns the new revision."""
        with self._tx() as conn:
            if state is not None:
                conn.execute("UPDATE onboarding_batches SET state = ? WHERE id = ?", (state, batch_id))
            if bump:
                conn.execute(
                    "UPDATE onboarding_batches SET revision = revision + 1 WHERE id = ?", (batch_id,)
                )
            row = conn.execute("SELECT revision FROM onboarding_batches WHERE id = ?", (batch_id,)).fetchone()
            return int(row["revision"]) if row else 0

    def expire(self, now_ts: float) -> int:
        """Batches past their TTL become `expired` and lose their staged text (no reads after expiry)."""
        with self._tx() as conn:
            ids = [
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM onboarding_batches WHERE expires_ts <= ? AND state NOT IN ('expired')",
                    (now_ts,),
                )
            ]
            for batch_id in ids:
                conn.execute("UPDATE onboarding_batches SET state = 'expired' WHERE id = ?", (batch_id,))
                conn.execute("UPDATE onboarding_items SET content = NULL WHERE batch_id = ?", (batch_id,))
            return len(ids)

    def drop_content(self, batch_id: str) -> None:
        with self._tx() as conn:
            conn.execute("UPDATE onboarding_items SET content = NULL WHERE batch_id = ?", (batch_id,))

    # --- items -----------------------------------------------------------------------------------------------
    def items(self, batch_id: str) -> list[sqlite3.Row]:
        with self._lock:
            return list(
                self._conn.execute(
                    "SELECT * FROM onboarding_items WHERE batch_id = ? ORDER BY ord", (batch_id,)
                )
            )

    def item(self, batch_id: str, item_id: str) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                "SELECT * FROM onboarding_items WHERE batch_id = ? AND id = ?", (batch_id, item_id)
            ).fetchone()
            return row

    def update_item(self, batch_id: str, item_id: str, expected_revision: int, **fields: Any) -> bool:
        """Compare-and-set on the item revision; bumps the item AND the batch revision. False: stale."""
        sets = ", ".join(f"{k} = ?" for k in fields)
        with self._tx() as conn:
            cursor = conn.execute(
                f"UPDATE onboarding_items SET {sets}{', ' if sets else ''}revision = revision + 1 "  # noqa: S608
                "WHERE batch_id = ? AND id = ? AND revision = ?",
                (*fields.values(), batch_id, item_id, expected_revision),
            )
            if cursor.rowcount != 1:
                return False
            conn.execute("UPDATE onboarding_batches SET revision = revision + 1 WHERE id = ?", (batch_id,))
            return True

    def set_ai(self, batch_id: str, item_id: str, ai: dict[str, Any]) -> None:
        """Model suggestions of an item (never its decisions: the item revision does not move)."""
        with self._tx() as conn:
            conn.execute(
                "UPDATE onboarding_items SET ai_json = ? WHERE batch_id = ? AND id = ?",
                (json.dumps(ai, ensure_ascii=False, default=str), batch_id, item_id),
            )

    def set_outcome(self, batch_id: str, item_id: str, outcome: dict[str, Any]) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE onboarding_items SET outcome_json = ? WHERE batch_id = ? AND id = ?",
                (json.dumps(outcome, ensure_ascii=False), batch_id, item_id),
            )

    # --- confirmations (idempotency) -------------------------------------------------------------------------
    def confirmation(self, batch_id: str, key: str) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                "SELECT * FROM onboarding_confirmations WHERE batch_id = ? AND key = ?", (batch_id, key)
            ).fetchone()
            return row

    def put_confirmation(
        self, batch_id: str, key: str, request_hash: str, result: dict[str, Any], now: str
    ) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO onboarding_confirmations (batch_id, key, request_hash, result_json, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (batch_id, key, request_hash, json.dumps(result, ensure_ascii=False, default=str), now),
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()
