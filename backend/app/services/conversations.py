"""Assistant chat history (docs/API_CONTRACTS.md v0.7, docs/SECURITY.md «Chat history»).

    POST /ask, /ask/stream with `conversation_id` + a valid `X-SKH-Browser`
      -> begin: the turn's question and request context (no contents) stored as `pending`
      -> the answer runs exactly as before (nothing here changes it)
      -> finish: the final AskResponse AS SENT, plus the ids of the documents it relies on (`evidence`)
         | fail: the error code and the server's message | interrupt: the client went away before the end
    GET /conversations/{id}
      -> the reader's snapshot: an answer whose evidence the reader can no longer see is WITHHELD (never shown);
         a changed index generation is said («ответ дан по поколению gN…»), never silently re-answered

Ownership is the server's user id AND a random per-browser id the UI keeps in localStorage — a convenience scope so
one shared login (local_demo) does not show every browser's dialogs; it is NOT authentication. Another browser, a
missing or malformed id, another user: nothing listed, 404 like an unknown id.

Never stored: prompts sent to the model, retrieved passages beyond what the response contains, tokens, attachment
contents (only file ids and names). Bodies are never logged. Bounded: turns per conversation, conversations per
browser, size of one answer, retention; the oldest are pruned.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field, ValidationError

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.authz import Action, AuthorizationPolicy
from app.domain.models import CONVERSATION_ID_PATTERN, AskResponse, SearchScope, UserContext
from app.errors import ApiError

if TYPE_CHECKING:
    from app.services.attachments import AttachmentService
    from app.services.external import ExternalEvidenceService
    from app.services.knowledge import KnowledgeService
    from app.services.skills import AskPlan

logger = logging.getLogger("skh.history")

BROWSER_HEADER = "X-SKH-Browser"
BROWSER_ID_PATTERN = r"^[0-9a-f]{32}$"  # 128 random bits, hex — generated once by the UI
_BROWSER_RE = re.compile(BROWSER_ID_PATTERN)
_CONVERSATION_RE = re.compile(CONVERSATION_ID_PATTERN)
# A pending turn nobody finished (the process stopped) reads as interrupted after this long: longer than any
# answer may run (AI_TOOLS_BUDGET_SECONDS ≤ 900 s, the stream's idle timeout 330 s).
STALE_PENDING_SECONDS = 1800.0
# Confluence pages re-checked per conversation read; beyond that they count as unavailable.
MAX_PAGE_CHECKS = 10
TITLE_CHARS = 200

TurnStatus = Literal["done", "failed", "interrupted", "pending"]
Withheld = Literal["sources_unavailable", "too_large", "unreadable"]
Origin = Literal["dialog", "document"]

WITHHELD_NOTES: dict[str, str] = {
    "sources_unavailable": (
        "Ответ скрыт: часть его источников вам сейчас недоступна. Задайте вопрос заново — ответ будет построен "
        "по доступным документам."
    ),
    "too_large": "Ответ не сохранён в истории: он больше допустимого размера.",
    "unreadable": "Ответ не удалось прочитать из истории. Задайте вопрос заново.",
}
ATTACHMENT_GONE_NOTE = "Файл больше недоступен: его фрагменты в этом ответе не показываются."
NOT_FOUND_MESSAGE = "Диалог не найден в истории этого браузера."


def valid_browser_id(value: str | None) -> str | None:
    """The browser id when it is well-formed; anything else counts as absent (nothing stored, nothing listed)."""
    return value if value and _BROWSER_RE.fullmatch(value) else None


def _iso(ts: float | None) -> datetime | None:
    return datetime.fromtimestamp(ts, UTC) if ts is not None else None


# --- API shapes ---------------------------------------------------------------------------------------------------


class StoredSkill(BaseModel):
    id: str
    name: str
    access: Literal["read", "draft"]


class StoredDocumentRef(BaseModel):
    id: str
    title: str


class StoredAttachmentRef(BaseModel):
    """A file attached to the turn: its id and name; size/summary/expiry only while the server still keeps it."""

    id: str
    name: str
    available: bool = False
    size: int | None = None
    mime: str | None = None
    summary: str | None = None
    expires_at: datetime | None = None


class StoredSelection(BaseModel):
    """A reference to the selected fragment (never its text): the document, the section and how many lines."""

    document_id: str
    section_anchor: str | None = None
    section: str | None = None
    lines: int = 0


def _team_scope() -> list[SearchScope]:
    return ["team"]


class StoredTurnRequest(BaseModel):
    question: str
    skill: StoredSkill | None = None
    sources: list[SearchScope] = Field(default_factory=_team_scope)
    include_drafts: bool = False
    include_deprecated: bool = False
    search_external: bool = False
    documents: list[StoredDocumentRef] = Field(default_factory=list)
    attachments: list[StoredAttachmentRef] = Field(default_factory=list)
    selection: StoredSelection | None = None


class StoredTurnError(BaseModel):
    code: str
    message: str
    status: int


class StoredTurn(BaseModel):
    seq: int
    status: TurnStatus
    created_at: datetime
    completed_at: datetime | None = None
    request: StoredTurnRequest
    # The AskResponse as it was sent; null unless `done` and not withheld.
    response: AskResponse | None = None
    error: StoredTurnError | None = None
    withheld: Withheld | None = None
    notes: list[str] = Field(default_factory=list)
    answer_generation: str | None = None
    generation_changed: bool = False


class ConversationSummary(BaseModel):
    id: str
    title: str  # the first question (or the skill's name)
    origin: Origin
    document: StoredDocumentRef | None = None  # origin `document`: the document, while the reader can see it
    turn_count: int
    created_at: datetime
    updated_at: datetime
    last_status: TurnStatus | None = None
    last_skill: StoredSkill | None = None
    last_sources: int | None = None  # verified sources of the last answer
    context: str | None = None  # the last turn's first file name or chosen document title


class ConversationDetail(ConversationSummary):
    index_generation: str | None = None  # the generation the reader's snapshot is at now
    turns: list[StoredTurn]


class ConversationList(BaseModel):
    items: list[ConversationSummary]
    total: int
    enabled: bool
    retention_days: int


class ConversationClear(BaseModel):
    deleted: int


# --- storage ------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ConversationLimits:
    retention_seconds: float = 30 * 86400.0
    max_conversations: int = 100
    max_turns: int = 50
    max_answer_chars: int = 512 * 1024


@dataclass(frozen=True)
class TurnRow:
    seq: int
    status: str
    request: dict[str, Any]
    response_json: str | None
    evidence: dict[str, Any]
    error_code: str | None
    error_message: str | None
    error_status: int | None
    omitted: str | None
    created_ts: float
    completed_ts: float | None


@dataclass(frozen=True)
class ConversationRow:
    id: str
    origin: str
    document_id: str | None
    title: str
    created_ts: float
    updated_ts: float
    turn_count: int
    last_status: str | None
    last_request: dict[str, Any] | None
    last_sources: int | None


def _loads(text: str | None) -> dict[str, Any]:
    if not text:
        return {}
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


_CONVERSATION_COLUMNS = (
    "c.id, c.origin, c.document_id, c.title, c.created_ts, c.updated_ts, "
    "(SELECT COUNT(*) FROM assistant_turns t WHERE t.actor = c.actor AND t.browser = c.browser "
    "AND t.conversation_id = c.id), l.status, l.request_json, l.sources"
)
_LAST_TURN_JOIN = (
    "LEFT JOIN assistant_turns l ON l.actor = c.actor AND l.browser = c.browser AND l.conversation_id = c.id "
    "AND l.seq = (SELECT MAX(m.seq) FROM assistant_turns m WHERE m.actor = c.actor AND m.browser = c.browser "
    "AND m.conversation_id = c.id)"
)


class ConversationStore:
    """Conversations and their turns per (actor, browser) in the app-state SQLite.

    Every write runs in a `BEGIN IMMEDIATE` transaction (one writer at a time, also across processes) and turn
    numbers come from the conversation row, so two tabs appending to one conversation never collide or reorder."""

    def __init__(self, path: Path | str, limits: ConversationLimits | None = None) -> None:
        self.limits = limits or ConversationLimits()
        self._lock = threading.Lock()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False, timeout=10.0, isolation_level=None)
        with self._tx() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS assistant_conversations (actor TEXT NOT NULL, browser TEXT NOT NULL, "
                "id TEXT NOT NULL, origin TEXT NOT NULL, document_id TEXT, title TEXT NOT NULL, "
                "created_ts REAL NOT NULL, updated_ts REAL NOT NULL, next_seq INTEGER NOT NULL, "
                "PRIMARY KEY (actor, browser, id))"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS assistant_conversations_recent "
                "ON assistant_conversations (actor, browser, updated_ts)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS assistant_conversations_age ON assistant_conversations (updated_ts)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS assistant_turns (actor TEXT NOT NULL, browser TEXT NOT NULL, "
                "conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, "
                "request_json TEXT NOT NULL, response_json TEXT, evidence_json TEXT, sources INTEGER, "
                "error_code TEXT, error_message TEXT, error_status INTEGER, omitted TEXT, "
                "created_ts REAL NOT NULL, completed_ts REAL, "
                "PRIMARY KEY (actor, browser, conversation_id, seq))"
            )

    @contextlib.contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    @staticmethod
    def _delete_conversations(conn: sqlite3.Connection, actor: str, browser: str, ids: list[str]) -> None:
        for conversation_id in ids:
            conn.execute(
                "DELETE FROM assistant_turns WHERE actor = ? AND browser = ? AND conversation_id = ?",
                (actor, browser, conversation_id),
            )
            conn.execute(
                "DELETE FROM assistant_conversations WHERE actor = ? AND browser = ? AND id = ?",
                (actor, browser, conversation_id),
            )

    def purge(self, now: float) -> int:
        """Deletes conversations without activity for longer than the retention (all users and browsers)."""
        cutoff = now - self.limits.retention_seconds
        with self._tx() as conn:
            conn.execute(
                "DELETE FROM assistant_turns WHERE EXISTS (SELECT 1 FROM assistant_conversations c "
                "WHERE c.actor = assistant_turns.actor AND c.browser = assistant_turns.browser "
                "AND c.id = assistant_turns.conversation_id AND c.updated_ts < ?)",
                (cutoff,),
            )
            return conn.execute(
                "DELETE FROM assistant_conversations WHERE updated_ts < ?", (cutoff,)
            ).rowcount

    def begin_turn(
        self,
        actor: str,
        browser: str,
        conversation_id: str,
        *,
        origin: str,
        document_id: str | None,
        title: str,
        request: dict[str, Any],
        now: float,
    ) -> int:
        """Appends a `pending` turn and returns its number. A failed or interrupted turn is replaced by the next one
        (the dialog shows it so); the oldest turns and conversations beyond the limits are pruned."""
        limits = self.limits
        key = (actor, browser, conversation_id)
        with self._tx() as conn:
            row = conn.execute(
                "SELECT next_seq FROM assistant_conversations WHERE actor = ? AND browser = ? AND id = ?", key
            ).fetchone()
            if row is None:
                seq = 1
                conn.execute(
                    "INSERT INTO assistant_conversations (actor, browser, id, origin, document_id, title, "
                    "created_ts, updated_ts, next_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (*key, origin, document_id, title, now, now, 1),
                )
            else:
                seq = int(row[0])
            conn.execute(
                "DELETE FROM assistant_turns WHERE actor = ? AND browser = ? AND conversation_id = ? "
                "AND (status IN ('failed', 'interrupted') OR (status = 'pending' AND created_ts < ?))",
                (*key, now - STALE_PENDING_SECONDS),
            )
            conn.execute(
                "INSERT INTO assistant_turns (actor, browser, conversation_id, seq, status, request_json, "
                "created_ts) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
                (*key, seq, json.dumps(request, ensure_ascii=False), now),
            )
            conn.execute(
                "UPDATE assistant_conversations SET next_seq = ?, updated_ts = ? "
                "WHERE actor = ? AND browser = ? AND id = ?",
                (seq + 1, now, *key),
            )
            conn.execute(
                "DELETE FROM assistant_turns WHERE actor = ? AND browser = ? AND conversation_id = ? AND seq NOT IN "
                "(SELECT seq FROM assistant_turns WHERE actor = ? AND browser = ? AND conversation_id = ? "
                "ORDER BY seq DESC LIMIT ?)",
                (*key, *key, limits.max_turns),
            )
            beyond = [
                str(r[0])
                for r in conn.execute(
                    "SELECT id FROM assistant_conversations WHERE actor = ? AND browser = ? "
                    "ORDER BY (id = ?) DESC, updated_ts DESC, created_ts DESC LIMIT -1 OFFSET ?",
                    (actor, browser, conversation_id, limits.max_conversations),
                ).fetchall()
            ]
            self._delete_conversations(conn, actor, browser, beyond)
        return seq

    def _close_turn(
        self,
        actor: str,
        browser: str,
        conversation_id: str,
        seq: int,
        sets: str,
        values: tuple[Any, ...],
        now: float,
    ) -> bool:
        key = (actor, browser, conversation_id)
        with self._tx() as conn:
            changed = conn.execute(
                f"UPDATE assistant_turns SET {sets}, completed_ts = ? "  # noqa: S608 (fixed column lists)
                "WHERE actor = ? AND browser = ? AND conversation_id = ? AND seq = ? AND status = 'pending'",
                (*values, now, *key, seq),
            ).rowcount
            if changed:
                conn.execute(
                    "UPDATE assistant_conversations SET updated_ts = ? WHERE actor = ? AND browser = ? AND id = ?",
                    (now, *key),
                )
        return changed > 0

    def finish_turn(
        self,
        actor: str,
        browser: str,
        conversation_id: str,
        seq: int,
        *,
        response_json: str | None,
        evidence: dict[str, Any],
        sources: int,
        omitted: str | None,
        now: float,
    ) -> bool:
        """Stores the answer of a pending turn. False when the turn is gone (the conversation was deleted)."""
        return self._close_turn(
            actor,
            browser,
            conversation_id,
            seq,
            "status = 'done', response_json = ?, evidence_json = ?, sources = ?, omitted = ?",
            (response_json, json.dumps(evidence, ensure_ascii=False), sources, omitted),
            now,
        )

    def fail_turn(
        self,
        actor: str,
        browser: str,
        conversation_id: str,
        seq: int,
        *,
        code: str,
        message: str,
        status: int,
        now: float,
    ) -> bool:
        return self._close_turn(
            actor,
            browser,
            conversation_id,
            seq,
            "status = 'failed', error_code = ?, error_message = ?, error_status = ?",
            (code, message, status),
            now,
        )

    def interrupt_turn(self, actor: str, browser: str, conversation_id: str, seq: int, *, now: float) -> bool:
        return self._close_turn(actor, browser, conversation_id, seq, "status = 'interrupted'", (), now)

    @staticmethod
    def _conversation_row(r: tuple[Any, ...]) -> ConversationRow:
        return ConversationRow(
            id=r[0],
            origin=r[1],
            document_id=r[2],
            title=r[3],
            created_ts=float(r[4]),
            updated_ts=float(r[5]),
            turn_count=int(r[6]),
            last_status=r[7],
            last_request=_loads(r[8]) if r[8] else None,
            last_sources=int(r[9]) if r[9] is not None else None,
        )

    def conversations(
        self,
        actor: str,
        browser: str,
        *,
        origin: str | None = None,
        document_id: str | None = None,
        limit: int = 20,
    ) -> tuple[list[ConversationRow], int]:
        where = "c.actor = ? AND c.browser = ?"
        params: list[Any] = [actor, browser]
        if origin is not None:
            where += " AND c.origin = ?"
            params.append(origin)
        if document_id is not None:
            where += " AND c.document_id = ?"
            params.append(document_id)
        with self._lock:
            total = int(
                self._conn.execute(
                    f"SELECT COUNT(*) FROM assistant_conversations c WHERE {where}",  # noqa: S608
                    params,
                ).fetchone()[0]
            )
            rows = self._conn.execute(
                f"SELECT {_CONVERSATION_COLUMNS} FROM assistant_conversations c {_LAST_TURN_JOIN} "  # noqa: S608
                f"WHERE {where} ORDER BY c.updated_ts DESC, c.created_ts DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        return [self._conversation_row(r) for r in rows], total

    def conversation(self, actor: str, browser: str, conversation_id: str) -> ConversationRow | None:
        with self._lock:
            r = self._conn.execute(
                f"SELECT {_CONVERSATION_COLUMNS} FROM assistant_conversations c {_LAST_TURN_JOIN} "  # noqa: S608
                "WHERE c.actor = ? AND c.browser = ? AND c.id = ?",
                (actor, browser, conversation_id),
            ).fetchone()
        return self._conversation_row(r) if r is not None else None

    def turns(self, actor: str, browser: str, conversation_id: str) -> list[TurnRow]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT seq, status, request_json, response_json, evidence_json, error_code, error_message, "
                "error_status, omitted, created_ts, completed_ts FROM assistant_turns "
                "WHERE actor = ? AND browser = ? AND conversation_id = ? ORDER BY seq",
                (actor, browser, conversation_id),
            ).fetchall()
        return [
            TurnRow(
                seq=int(r[0]),
                status=r[1],
                request=_loads(r[2]),
                response_json=r[3],
                evidence=_loads(r[4]),
                error_code=r[5],
                error_message=r[6],
                error_status=int(r[7]) if r[7] is not None else None,
                omitted=r[8],
                created_ts=float(r[9]),
                completed_ts=float(r[10]) if r[10] is not None else None,
            )
            for r in rows
        ]

    def delete(self, actor: str, browser: str, conversation_id: str) -> bool:
        with self._tx() as conn:
            found = conn.execute(
                "SELECT 1 FROM assistant_conversations WHERE actor = ? AND browser = ? AND id = ?",
                (actor, browser, conversation_id),
            ).fetchone()
            self._delete_conversations(conn, actor, browser, [conversation_id])
        return found is not None

    def clear(self, actor: str, browser: str) -> list[str]:
        with self._tx() as conn:
            ids = [
                str(r[0])
                for r in conn.execute(
                    "SELECT id FROM assistant_conversations WHERE actor = ? AND browser = ?", (actor, browser)
                ).fetchall()
            ]
            self._delete_conversations(conn, actor, browser, ids)
        return ids

    def close(self) -> None:
        with self._lock:
            self._conn.close()


# --- evidence: which documents an answer relies on --------------------------------------------------------------------

_DOC_PATH_RE = re.compile(r"^/documents/([^/#?]+)")


def _confluence_page(citation: dict[str, Any]) -> tuple[str, str]:
    """(page id, version) of a Confluence citation: `source_id` is `confluence:<instance>:<page>:<version>`."""
    parts = str(citation.get("source_id") or "").split(":")
    page = parts[2] if len(parts) >= 4 and parts[2] else str(citation.get("document_id") or "")
    return page, str(citation.get("revision") or "")


def evidence_of(
    response: dict[str, Any], snapshot: KnowledgeSnapshot | None, chosen: list[str]
) -> dict[str, Any]:
    """The documents, Confluence pages and files the answer relies on: its citations, the documents named by its
    system facts (items, relation ends, links, filters) and the documents the user chose as context. Fact ids are
    kept only when the asker's snapshot knows them as documents (templates, proposals and relations are not)."""
    documents: set[str] = set(chosen)
    pages: dict[str, str] = {}
    files: set[str] = set()
    for citation in response.get("citations") or []:
        kind = citation.get("source_type")
        if kind in ("local", "gitlab"):
            documents.add(str(citation.get("document_id")))
        elif kind == "confluence":
            page, version = _confluence_page(citation)
            pages[page] = version
        elif kind == "attachment":
            files.add(str(citation.get("attachment_id") or citation.get("document_id")))
    candidates: set[str] = set()
    for fact in response.get("system_facts") or []:
        for item in fact.get("items") or []:
            candidates.update(p.strip() for p in str(item.get("id") or "").split("→") if p.strip())
            match = _DOC_PATH_RE.match(str(item.get("app_path") or ""))
            if match:
                candidates.add(match.group(1))
        filters = fact.get("effective_filters") or {}
        for name in ("document_id", "target_id"):
            if isinstance(filters.get(name), str):
                candidates.add(filters[name])
        if isinstance(filters.get("document_ids"), list):
            candidates.update(str(v) for v in filters["document_ids"])
    for candidate in candidates:
        if snapshot is None:
            documents.add(candidate)
        else:
            doc = snapshot.get(candidate)
            if doc is not None:
                documents.add(doc.id)
    return {
        "documents": sorted(d for d in documents if d),
        "pages": [{"page_id": p, "version": v} for p, v in sorted(pages.items())],
        "attachments": sorted(files),
    }


# --- the service --------------------------------------------------------------------------------------------------


@dataclass
class TurnHandle:
    """A turn being answered: where to store its outcome."""

    actor: str
    browser: str
    conversation_id: str
    seq: int
    snapshot: KnowledgeSnapshot | None = None
    chosen: list[str] = field(default_factory=list)


def _request_of(plan: AskPlan) -> dict[str, Any]:
    req = plan.request
    skill = plan.skill_ref
    selection = plan.selection
    return {
        "question": req.question,
        "skill": skill.model_dump() if skill else None,
        "sources": list(req.sources),
        "include_drafts": req.include_drafts,
        "include_deprecated": req.include_deprecated,
        "search_external": req.search_external,
        "documents": [{"id": d.id, "title": d.title} for d in plan.documents],
        "attachments": [{"id": a.id, "name": a.name} for a in plan.attachments],
        "selection": {
            "document_id": selection.document.id,
            "section_anchor": selection.anchor,
            "section": selection.heading,
            "lines": len(selection.text.splitlines()),
        }
        if selection
        else None,
    }


class ConversationService:
    def __init__(
        self,
        store: ConversationStore,
        *,
        knowledge: KnowledgeService,
        attachments: AttachmentService,
        policy: AuthorizationPolicy,
        external: ExternalEvidenceService | None = None,
        enabled: bool = True,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.store = store
        self._knowledge = knowledge
        self._attachments = attachments
        self._policy = policy
        self._external = external
        self.enabled = enabled
        self.clock = clock

    @property
    def limits(self) -> ConversationLimits:
        return self.store.limits

    @property
    def retention_days(self) -> int:
        return round(self.limits.retention_seconds / 86400)

    # --- recording ------------------------------------------------------------------------------------------------
    # The history never breaks an answer: a storage failure (locked or full disk, a broken file) is logged and the
    # answer goes on unrecorded.
    def begin(self, user: UserContext, browser: str | None, plan: AskPlan) -> TurnHandle | None:
        """Starts recording a turn — only with history on, a valid browser id and a conversation id."""
        req = plan.request
        if not self.enabled or browser is None or not req.conversation_id:
            return None
        request = _request_of(plan)
        subject = plan.subject
        chosen = [d.id for d in plan.documents] + ([plan.selection.document.id] if plan.selection else [])
        try:
            handle = self._begin(
                user,
                browser,
                req.conversation_id,
                request,
                origin=req.origin,
                document_id=subject.id if req.origin == "document" and subject is not None else None,
                title=req.question.strip() or (plan.skill.name if plan.explicit_skill else "") or "Диалог",
            )
        except sqlite3.Error as exc:
            logger.warning("history turn not recorded: %s", type(exc).__name__)
            return None
        handle.snapshot = plan.snapshot
        handle.chosen = chosen
        return handle

    def begin_raw(
        self,
        user: UserContext,
        browser: str,
        conversation_id: str,
        *,
        question: str,
        origin: Origin = "dialog",
    ) -> TurnHandle:
        """A turn of a plain question without a plan (tests, tools)."""
        request = StoredTurnRequest(question=question).model_dump(mode="json")
        return self._begin(
            user, browser, conversation_id, request, origin=origin, document_id=None, title=question
        )

    def _begin(
        self,
        user: UserContext,
        browser: str,
        conversation_id: str,
        request: dict[str, Any],
        *,
        origin: str,
        document_id: str | None,
        title: str,
    ) -> TurnHandle:
        now = self.clock()
        self.store.purge(now)
        seq = self.store.begin_turn(
            user.user_id,
            browser,
            conversation_id,
            origin=origin,
            document_id=document_id,
            title=title.strip()[:TITLE_CHARS] or "Диалог",
            request=request,
            now=now,
        )
        return TurnHandle(user.user_id, browser, conversation_id, seq)

    def finish(self, handle: TurnHandle | None, response: dict[str, Any]) -> None:
        """Stores the final AskResponse exactly as it was sent (JSON); too large → only a note is kept."""
        if handle is None:
            return
        text = json.dumps(response, ensure_ascii=False)
        too_large = len(text) > self.limits.max_answer_chars
        try:
            stored = self.store.finish_turn(
                handle.actor,
                handle.browser,
                handle.conversation_id,
                handle.seq,
                response_json=None if too_large else text,
                evidence=evidence_of(response, handle.snapshot, handle.chosen),
                sources=len(response.get("citations") or []),
                omitted="too_large" if too_large else None,
                now=self.clock(),
            )
        except sqlite3.Error as exc:
            logger.warning("history turn seq=%d answer not recorded: %s", handle.seq, type(exc).__name__)
            return
        logger.info("history turn seq=%d done stored=%s chars=%d", handle.seq, stored, len(text))

    def fail(self, handle: TurnHandle | None, code: str, message: str, status: int) -> None:
        if handle is None:
            return
        try:
            self.store.fail_turn(
                handle.actor,
                handle.browser,
                handle.conversation_id,
                handle.seq,
                code=code[:64],
                message=message[:500],
                status=status,
                now=self.clock(),
            )
        except sqlite3.Error as exc:
            logger.warning("history turn seq=%d failure not recorded: %s", handle.seq, type(exc).__name__)
            return
        logger.info("history turn seq=%d failed code=%s", handle.seq, code)

    def interrupt(self, handle: TurnHandle | None) -> None:
        if handle is None:
            return
        try:
            closed = self.store.interrupt_turn(
                handle.actor, handle.browser, handle.conversation_id, handle.seq, now=self.clock()
            )
        except sqlite3.Error as exc:
            logger.warning(
                "history turn seq=%d interruption not recorded: %s", handle.seq, type(exc).__name__
            )
            return
        if closed:
            logger.info("history turn seq=%d interrupted", handle.seq)

    # --- reading ----------------------------------------------------------------------------------------------------
    def _summary(self, row: ConversationRow, snapshot: KnowledgeSnapshot) -> ConversationSummary:
        last = StoredTurnRequest.model_validate(row.last_request) if row.last_request else None
        origin_doc = snapshot.get(row.document_id) if row.document_id else None
        context: str | None = None
        if last is not None:
            if last.attachments:
                context = last.attachments[0].name
            else:
                visible = [d for d in last.documents if snapshot.get(d.id) is not None]
                context = visible[0].title if visible else None
        return ConversationSummary(
            id=row.id,
            title=row.title,
            origin="document" if row.origin == "document" else "dialog",
            document=StoredDocumentRef(id=origin_doc.id, title=origin_doc.title) if origin_doc else None,
            turn_count=row.turn_count,
            created_at=_iso(row.created_ts) or datetime.now(UTC),
            updated_at=_iso(row.updated_ts) or datetime.now(UTC),
            last_status=self._status(row.last_status, row.updated_ts),
            last_skill=last.skill if last else None,
            last_sources=row.last_sources,
            context=context,
        )

    def _status(self, status: str | None, created_ts: float) -> TurnStatus | None:
        if status == "pending" and self.clock() - created_ts > STALE_PENDING_SECONDS:
            return "interrupted"
        if status in ("done", "failed", "interrupted", "pending"):
            return status  # type: ignore[return-value]
        return None

    async def list_conversations(
        self,
        user: UserContext,
        browser: str | None,
        *,
        origin: Origin | None = None,
        document_id: str | None = None,
        limit: int = 20,
    ) -> ConversationList:
        if not self.enabled or browser is None:
            return ConversationList(
                items=[], total=0, enabled=self.enabled, retention_days=self.retention_days
            )
        self.store.purge(self.clock())
        rows, total = self.store.conversations(
            user.user_id, browser, origin=origin, document_id=document_id, limit=limit
        )
        snapshot = await self._knowledge.snapshot(user) if rows else None
        items = [self._summary(row, snapshot) for row in rows] if snapshot is not None else []
        return ConversationList(items=items, total=total, enabled=True, retention_days=self.retention_days)

    def _not_found(self) -> ApiError:
        return ApiError(404, "conversation_not_found", NOT_FOUND_MESSAGE)

    async def get(self, user: UserContext, browser: str | None, conversation_id: str) -> ConversationDetail:
        if not self.enabled or browser is None or not _CONVERSATION_RE.match(conversation_id):
            raise self._not_found()
        self.store.purge(self.clock())
        row = self.store.conversation(user.user_id, browser, conversation_id)
        if row is None:
            raise self._not_found()
        rows = self.store.turns(user.user_id, browser, conversation_id)
        snapshot = await self._knowledge.snapshot(user)
        generation = self._knowledge.generation_label(snapshot)
        files = self._attachments.describe(
            user,
            conversation_id,
            [
                str(f.get("id"))
                for r in rows
                for f in (r.request.get("attachments") or [])
                if isinstance(f, dict)
            ],
        )
        pages = _PageChecks(self._external, user, self._policy.allows(user, Action.read_corporate))
        turns = [await self._turn(r, snapshot, generation, files, pages) for r in rows]
        return ConversationDetail(
            **self._summary(row, snapshot).model_dump(), index_generation=generation, turns=turns
        )

    async def _turn(
        self,
        row: TurnRow,
        snapshot: KnowledgeSnapshot,
        generation: str,
        files: dict[str, Any],
        pages: _PageChecks,
    ) -> StoredTurn:
        try:
            request = StoredTurnRequest.model_validate(row.request)
        except ValidationError:
            request = StoredTurnRequest(question=str(row.request.get("question") or ""))
        # Chips of what was chosen: only documents the reader can still see; files with their current availability.
        request.documents = [d for d in request.documents if snapshot.get(d.id) is not None]
        if request.selection is not None and snapshot.get(request.selection.document_id) is None:
            request.selection = None
        for attachment in request.attachments:
            meta = files.get(attachment.id)
            attachment.available = meta is not None
            if meta is not None:
                attachment.size, attachment.mime, attachment.summary = meta.size, meta.mime, meta.summary
                attachment.expires_at = _iso(meta.expires_at)
        status = self._status(row.status, row.created_ts) or "interrupted"
        turn = StoredTurn(
            seq=row.seq,
            status=status,
            created_at=_iso(row.created_ts) or datetime.now(UTC),
            completed_at=_iso(row.completed_ts),
            request=request,
        )
        if status == "failed":
            turn.error = StoredTurnError(
                code=row.error_code or "ai_upstream_error",
                message=row.error_message or "Не удалось получить ответ ассистента.",
                status=row.error_status or 502,
            )
        if status != "done":
            return turn
        if row.omitted == "too_large" or row.response_json is None:
            return self._withhold(turn, "too_large")
        evidence = row.evidence
        hidden = any(snapshot.get(str(d)) is None for d in evidence.get("documents") or [])
        for page in evidence.get("pages") or []:
            if hidden:
                break
            hidden = not await pages.readable(str(page.get("page_id")), str(page.get("version")))
        if hidden:
            return self._withhold(turn, "sources_unavailable")
        try:
            response = AskResponse.model_validate_json(row.response_json)
        except ValidationError:
            return self._withhold(turn, "unreadable")
        response.excluded_sources = [s for s in response.excluded_sources if snapshot.get(s.document_id)]
        for context in response.conversation_context:
            context.document_ids = [d for d in context.document_ids if snapshot.get(d) is not None]
        gone = False
        for citation in response.citations:
            if (
                citation.source_type == "attachment"
                and (citation.attachment_id or citation.document_id) not in files
            ):
                citation.excerpt, citation.excerpt_parts, gone = "", None, True
        turn.response = response
        turn.answer_generation = response.index_generation
        if response.index_generation and response.index_generation != generation:
            turn.generation_changed = True
            turn.notes.append(
                f"Ответ дан по поколению {response.index_generation}; база с тех пор обновлена (сейчас {generation})."
            )
        if gone:
            turn.notes.append(ATTACHMENT_GONE_NOTE)
        return turn

    @staticmethod
    def _withhold(turn: StoredTurn, reason: Withheld) -> StoredTurn:
        turn.withheld = reason
        turn.response = None
        turn.notes = [WITHHELD_NOTES[reason]]
        return turn

    # --- deleting ---------------------------------------------------------------------------------------------------
    def delete(self, user: UserContext, browser: str | None, conversation_id: str) -> None:
        """Idempotent. The conversation's files go with it (only when it was this browser's conversation)."""
        if browser is None or not _CONVERSATION_RE.match(conversation_id):
            return
        if self.store.delete(user.user_id, browser, conversation_id):
            self._attachments.delete_conversation(user, conversation_id)
            logger.info("history conversation deleted")

    def clear(self, user: UserContext, browser: str | None) -> int:
        if browser is None:
            return 0
        ids = self.store.clear(user.user_id, browser)
        for conversation_id in ids:
            self._attachments.delete_conversation(user, conversation_id)
        logger.info("history cleared conversations=%d", len(ids))
        return len(ids)

    def close(self) -> None:
        self.store.close()


class _PageChecks:
    """Confluence pages of stored answers, re-checked for the reader's access and version (bounded, per read)."""

    def __init__(self, external: ExternalEvidenceService | None, user: UserContext, allowed: bool) -> None:
        self._external = external
        self._user = user
        self._allowed = allowed
        self._seen: dict[tuple[str, str], bool] = {}

    async def readable(self, page_id: str, version: str) -> bool:
        key = (page_id, version)
        if key in self._seen:
            return self._seen[key]
        ok = False
        if self._allowed and self._external is not None and len(self._seen) < MAX_PAGE_CHECKS:
            ok = await self._external.revalidate(self._user, page_id, version)
        self._seen[key] = ok
        return ok
