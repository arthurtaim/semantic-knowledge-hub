"""Discovery memory and retrieval traces (M5.6.2 Appendix 5 §4).

Stores the MINIMUM needed to (a) reconstruct which fragments a given answer used and (b) let relevance
feedback prioritise candidates for a similar question later:

- a query FINGERPRINT (HMAC-SHA256 with a per-environment key, over the normalised query AND the access
  scope) and the query intent (stems) — the plain query text only when explicitly allowed;
- query → source links with version, fragments, ranking reasons, used/cited flags, feedback;
- invalidations of external sources (revoked / deleted) so stale overlays are hidden.

Nothing here is authoritative: feedback never changes a document's status, version or access. Every
record is scoped (acl_scope) and expires (retention); purge removes traces and links (and the caller
drops the derived cache). Different scopes never see each other's records, counts or hints.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from app.domain.models import UserContext

Feedback = Literal["unrated", "relevant", "irrelevant", "unsure"]
POLICY_VERSION = "discovery-v1"
HINT_MIN_OVERLAP = 0.5


def acl_scope_key(user: UserContext) -> str:
    """Stable, non-reversible key of what the user may read (identity + space restrictions)."""
    spaces = "*" if user.allowed_spaces is None else ",".join(sorted(user.allowed_spaces))
    return hashlib.sha256(f"{user.user_id}|{spaces}".encode()).hexdigest()[:20]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


@dataclass
class SourceLink:
    source_kind: str  # local_markdown | gitlab_approved | confluence_mcp
    source_id: str  # namespaced: local:DEMO-INT-002 · confluence:demo-wiki:200101
    version: str
    title: str
    page_id: str | None = None
    status: str | None = None
    fragment_ids: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    score: float = 0.0
    used_in_context: bool = True
    cited: bool = False
    uri: str | None = None


@dataclass
class TraceRecord:
    trace_id: str
    created_at: str
    expires_at: str
    acl_scope: str
    intent: list[str]
    query_text: str | None
    mode: str
    trigger: str
    confidence: str
    index_generation: str
    instructions_version: str
    sources: list[dict[str, Any]]
    external: dict[str, Any]


class DiscoveryStore:
    def __init__(
        self,
        path: Path | str,
        *,
        retention_hours: int = 24,
        store_query_text: bool = False,
        key_file: Path | None = None,
    ) -> None:
        self._path = str(path)
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._retention = timedelta(hours=retention_hours)
        self._store_query_text = store_query_text
        self._key = self._load_key(key_file)
        with self._conn:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS retrieval_traces (trace_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, "
                "expires_at TEXT NOT NULL, acl_scope TEXT NOT NULL, query_fingerprint TEXT NOT NULL, "
                "intent_json TEXT NOT NULL, query_text TEXT, mode TEXT NOT NULL, trigger TEXT NOT NULL, "
                "confidence TEXT NOT NULL, index_generation TEXT NOT NULL, instructions_version TEXT NOT NULL, "
                "external_json TEXT NOT NULL, policy_version TEXT NOT NULL)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS discovery_links (link_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, "
                "acl_scope TEXT NOT NULL, query_fingerprint TEXT NOT NULL, intent_json TEXT NOT NULL, "
                "source_kind TEXT NOT NULL, source_id TEXT NOT NULL, page_id TEXT, source_version TEXT NOT NULL, "
                "title TEXT NOT NULL, status TEXT, uri TEXT, fragment_ids_json TEXT NOT NULL, reasons_json TEXT NOT NULL, "
                "score REAL NOT NULL, used_in_context INTEGER NOT NULL, cited INTEGER NOT NULL, "
                "feedback TEXT NOT NULL DEFAULT 'unrated', feedback_at TEXT, state TEXT NOT NULL DEFAULT 'active', "
                "created_at TEXT NOT NULL, expires_at TEXT NOT NULL)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS discovery_links_scope ON discovery_links(acl_scope, source_kind)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS source_invalidations (source_key TEXT PRIMARY KEY, reason TEXT NOT NULL, "
                "at TEXT NOT NULL)"
            )

    @staticmethod
    def _load_key(key_file: Path | None) -> bytes:
        if key_file is None:
            return secrets.token_bytes(32)  # process-local: fingerprints do not survive a restart
        try:
            data = key_file.read_bytes().strip()
            if len(data) >= 32:
                return data
        except OSError:
            pass
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_hex(32).encode()
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
        return key

    # --- writing ---------------------------------------------------------------------------------
    def fingerprint(self, normalized_query: str, acl_scope: str) -> str:
        message = f"{acl_scope}\n{normalized_query}".encode()
        return hmac.new(self._key, message, hashlib.sha256).hexdigest()[:32]

    def record(
        self,
        *,
        acl_scope: str,
        normalized_query: str,
        intent: list[str],
        query_text: str,
        mode: str,
        trigger: str,
        confidence: str,
        index_generation: str,
        instructions_version: str,
        external: dict[str, Any],
        sources: list[SourceLink],
    ) -> str:
        trace_id = "TRACE-" + uuid.uuid4().hex[:16]
        now = _now()
        expires = _iso(now + self._retention)
        fingerprint = self.fingerprint(normalized_query, acl_scope)
        intent_json = json.dumps(sorted(set(intent))[:16], ensure_ascii=False)
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO retrieval_traces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    trace_id,
                    _iso(now),
                    expires,
                    acl_scope,
                    fingerprint,
                    intent_json,
                    query_text[:2000] if self._store_query_text else None,
                    mode,
                    trigger,
                    confidence,
                    index_generation,
                    instructions_version,
                    json.dumps(external, ensure_ascii=False),
                    POLICY_VERSION,
                ),
            )
            for link in sources:
                self._conn.execute(
                    "INSERT INTO discovery_links (link_id, trace_id, acl_scope, query_fingerprint, intent_json, "
                    "source_kind, source_id, page_id, source_version, title, status, uri, fragment_ids_json, "
                    "reasons_json, score, used_in_context, cited, created_at, expires_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        uuid.uuid4().hex[:16],
                        trace_id,
                        acl_scope,
                        fingerprint,
                        intent_json,
                        link.source_kind,
                        link.source_id,
                        link.page_id,
                        link.version,
                        link.title[:300],
                        link.status,
                        link.uri,
                        json.dumps(link.fragment_ids),
                        json.dumps(link.reasons[:8], ensure_ascii=False),
                        link.score,
                        int(link.used_in_context),
                        int(link.cited),
                        _iso(now),
                        expires,
                    ),
                )
        return trace_id

    def feedback(self, trace_id: str, source_id: str, verdict: Feedback, acl_scope: str) -> bool:
        """Relevance of ONE source for ONE question. Only within the requester's own scope."""
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "UPDATE discovery_links SET feedback = ?, feedback_at = ? WHERE trace_id = ? AND source_id = ? "
                "AND acl_scope = ? AND state = 'active'",
                (verdict, _iso(_now()), trace_id, source_id, acl_scope),
            )
            return cursor.rowcount > 0

    def invalidate_source(self, source_key: str, reason: str) -> int:
        """External source revoked / deleted: every link to it stops being active (hidden everywhere)."""
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO source_invalidations(source_key, reason, at) VALUES (?, ?, ?)",
                (source_key, reason, _iso(_now())),
            )
            cursor = self._conn.execute(
                "UPDATE discovery_links SET state = ? WHERE (source_id = ? OR source_id LIKE ?) AND state = 'active'",
                (reason, source_key, f"{source_key}:%"),
            )
            return cursor.rowcount

    def clear_invalidation(self, source_key: str) -> None:
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM source_invalidations WHERE source_key = ?", (source_key,))

    def expire(self) -> int:
        now = _iso(_now())
        with self._lock, self._conn:
            removed = self._conn.execute("DELETE FROM discovery_links WHERE expires_at < ?", (now,)).rowcount
            removed += self._conn.execute(
                "DELETE FROM retrieval_traces WHERE expires_at < ?", (now,)
            ).rowcount
        return removed

    def purge(self, acl_scope: str, trace_id: str | None = None) -> int:
        """Erase discovery data of a scope (or one trace). Returns the number of removed rows."""
        with self._lock, self._conn:
            if trace_id:
                removed = self._conn.execute(
                    "DELETE FROM discovery_links WHERE acl_scope = ? AND trace_id = ?", (acl_scope, trace_id)
                ).rowcount
                removed += self._conn.execute(
                    "DELETE FROM retrieval_traces WHERE acl_scope = ? AND trace_id = ?", (acl_scope, trace_id)
                ).rowcount
            else:
                removed = self._conn.execute(
                    "DELETE FROM discovery_links WHERE acl_scope = ?", (acl_scope,)
                ).rowcount
                removed += self._conn.execute(
                    "DELETE FROM retrieval_traces WHERE acl_scope = ?", (acl_scope,)
                ).rowcount
        return removed

    # --- reading ---------------------------------------------------------------------------------
    def hints(self, intent: list[str], acl_scope: str) -> dict[str, float]:
        """source_id (without version) → bounded priority hint from feedback on SIMILAR questions of the
        SAME scope. Never a permission, never authority: candidates are still re-checked."""
        wanted = set(intent)
        now = _iso(_now())
        with self._lock:
            rows = self._conn.execute(
                "SELECT source_id, intent_json, feedback FROM discovery_links WHERE acl_scope = ? AND state = 'active' "
                "AND feedback IN ('relevant', 'irrelevant') AND expires_at >= ?",
                (acl_scope, now),
            ).fetchall()
        result: dict[str, float] = {}
        for row in rows:
            if _jaccard(wanted, set(json.loads(row["intent_json"]))) < HINT_MIN_OVERLAP:
                continue
            base = (
                row["source_id"].rsplit(":", 1)[0] if row["source_id"].count(":") >= 3 else row["source_id"]
            )
            delta = 1.0 if row["feedback"] == "relevant" else -1.0
            result[base] = max(-2.0, min(2.0, result.get(base, 0.0) + delta))
        return result

    def invalidated(self) -> set[str]:
        with self._lock:
            return {r[0] for r in self._conn.execute("SELECT source_key FROM source_invalidations")}

    def trace(self, trace_id: str, acl_scope: str) -> TraceRecord | None:
        now = _iso(_now())
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM retrieval_traces WHERE trace_id = ? AND acl_scope = ? AND expires_at >= ?",
                (trace_id, acl_scope, now),
            ).fetchone()
            if row is None:
                return None
            links = self._conn.execute(
                "SELECT * FROM discovery_links WHERE trace_id = ? AND acl_scope = ? AND state = 'active' "
                "AND expires_at >= ? ORDER BY cited DESC, score DESC",
                (trace_id, acl_scope, now),
            ).fetchall()
        return TraceRecord(
            trace_id=row["trace_id"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            acl_scope=row["acl_scope"],
            intent=json.loads(row["intent_json"]),
            query_text=row["query_text"],
            mode=row["mode"],
            trigger=row["trigger"],
            confidence=row["confidence"],
            index_generation=row["index_generation"],
            instructions_version=row["instructions_version"],
            external=json.loads(row["external_json"]),
            sources=[
                {
                    "source_kind": link["source_kind"],
                    "source_id": link["source_id"],
                    "page_id": link["page_id"],
                    "version": link["source_version"],
                    "title": link["title"],
                    "status": link["status"],
                    "uri": link["uri"],
                    "fragment_ids": json.loads(link["fragment_ids_json"]),
                    "reasons": json.loads(link["reasons_json"]),
                    "score": link["score"],
                    "used_in_context": bool(link["used_in_context"]),
                    "cited": bool(link["cited"]),
                    "feedback": link["feedback"],
                    "expires_at": link["expires_at"],
                }
                for link in links
            ],
        )

    def stats(self, acl_scope: str) -> dict[str, Any]:
        with self._lock:
            traces = self._conn.execute(
                "SELECT COUNT(*) FROM retrieval_traces WHERE acl_scope = ?", (acl_scope,)
            ).fetchone()[0]
            links = self._conn.execute(
                "SELECT feedback, COUNT(*) FROM discovery_links WHERE acl_scope = ? GROUP BY feedback",
                (acl_scope,),
            ).fetchall()
            invalid = self._conn.execute("SELECT COUNT(*) FROM source_invalidations").fetchone()[0]
        return {
            "traces": traces,
            "links_by_feedback": {r[0]: r[1] for r in links},
            "invalidated_sources": invalid,
            "retention_hours": int(self._retention.total_seconds() // 3600),
            "stores_query_text": self._store_query_text,
            "policy_version": POLICY_VERSION,
        }

    def close(self) -> None:
        with self._lock:
            self._conn.close()
