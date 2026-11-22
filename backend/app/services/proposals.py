"""Reviewable change proposals. The canonical document is NEVER modified here.

Proposals live in local derived state (SQLite under the ignored workspace). "Ready for review"
is a status only; GitLab MR creation is a separate, feature-gated action.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.adapters.ai.base import AIProvider, AIProviderError
from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeRepository,
)
from app.adapters.publishers.base import ProposalForPublication, ProposalPublisher, PublisherDisabledError
from app.domain.models import DocStatus, DocumentRecord, UserContext, ValidationIssue
from app.domain.proposals import (
    DiffLine,
    DiffResult,
    DraftCreate,
    ProposalDetail,
    ProposalEvent,
    ProposalList,
    ProposalStatus,
    ProposalSummary,
    PublicationState,
    SuggestRequest,
    SuggestResponse,
)
from app.domain.schema import is_valid_document_id, parse_document
from app.errors import ApiError

logger = logging.getLogger("skh.proposals")

PROPOSAL_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _now() -> datetime:
    return datetime.now(UTC)


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def compute_diff(before: str, after: str, path: str) -> DiffResult:
    old_lines = _normalize_newlines(before).split("\n")
    new_lines = _normalize_newlines(after).split("\n")
    unified = list(
        difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=3)
    )
    lines: list[DiffLine] = []
    additions = deletions = 0
    old_no = new_no = 0
    for raw in unified[2:]:
        match = _HUNK_RE.match(raw)
        if match:
            old_no, new_no = int(match.group(1)), int(match.group(3))
            lines.append(DiffLine(kind="hunk", text=raw))
        elif raw.startswith("+"):
            lines.append(DiffLine(kind="add", new_no=new_no, text=raw[1:]))
            new_no += 1
            additions += 1
        elif raw.startswith("-"):
            lines.append(DiffLine(kind="remove", old_no=old_no, text=raw[1:]))
            old_no += 1
            deletions += 1
        else:
            lines.append(DiffLine(kind="context", old_no=old_no, new_no=new_no, text=raw[1:] if raw else ""))
            old_no += 1
            new_no += 1
    return DiffResult(
        unified="\n".join(unified),
        lines=lines,
        additions=additions,
        deletions=deletions,
        changed=bool(unified),
    )


def validate_proposal(doc: DocumentRecord, proposed: str, origin: str) -> list[ValidationIssue]:
    parsed = parse_document(proposed, expected_id=doc.id)
    issues = list(parsed.issues)
    if _normalize_newlines(proposed).strip() == _normalize_newlines(doc.raw).strip():
        issues.append(
            ValidationIssue(severity="error", code="no_changes", message="Предложение не содержит изменений.")
        )
    new_status = parsed.metadata.get("status")
    if new_status is not None and new_status != doc.status:
        if new_status == DocStatus.approved:
            if origin == "ai_suggestion":
                issues.append(
                    ValidationIssue(
                        severity="error",
                        code="ai_cannot_approve",
                        message="ИИ-предложение не может переводить документ в статус approved.",
                        field="status",
                    )
                )
            else:
                issues.append(
                    ValidationIssue(
                        severity="warning",
                        code="status_to_approved",
                        message="Перевод в approved вступит в силу только после ревью и merge в GitLab.",
                        field="status",
                    )
                )
        else:
            issues.append(
                ValidationIssue(
                    severity="warning",
                    code="status_changed",
                    message=f"Статус меняется: {doc.status.value} → {new_status.value}.",
                    field="status",
                )
            )
    return issues


class ProposalStore:
    """SQLite store for proposal records and a content-free audit trail."""

    def __init__(self, path: Path | str) -> None:
        self._path = str(path)
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._conn:
            self._conn.execute(
                """CREATE TABLE IF NOT EXISTS proposals (
                    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, document_title TEXT NOT NULL,
                    document_path TEXT NOT NULL, source TEXT NOT NULL, base_revision TEXT NOT NULL,
                    base_content TEXT NOT NULL, proposed_content TEXT NOT NULL, reason TEXT NOT NULL,
                    origin TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL,
                    validation_json TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
                    review_comment TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
            )
            columns = {row[1] for row in self._conn.execute("PRAGMA table_info(proposals)")}
            if "external_url" not in columns:  # additive migration for stores created by older builds
                self._conn.execute("ALTER TABLE proposals ADD COLUMN external_url TEXT")
            self._conn.execute(
                """CREATE TABLE IF NOT EXISTS audit_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
                    action TEXT NOT NULL, proposal_id TEXT, document_id TEXT, revision TEXT, status TEXT)"""
            )

    def insert(self, row: dict[str, Any]) -> None:
        columns = ", ".join(row)
        placeholders = ", ".join(f":{k}" for k in row)
        with self._lock, self._conn:
            self._conn.execute(f"INSERT INTO proposals ({columns}) VALUES ({placeholders})", row)

    def get(self, proposal_id: str) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                "SELECT * FROM proposals WHERE id = ?", (proposal_id,)
            ).fetchone()
            return row

    def list_rows(self, status: str | None, document_id: str | None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM proposals WHERE 1=1"
        params: list[str] = []
        if status:
            sql += " AND status = ?"
            params.append(status)
        if document_id:
            sql += " AND lower(document_id) = lower(?)"
            params.append(document_id)
        sql += " ORDER BY created_at DESC, id"
        with self._lock:
            return list(self._conn.execute(sql, params).fetchall())

    def transition(
        self, proposal_id: str, allowed_from: set[str], new_status: str, comment: str | None = None
    ) -> bool:
        placeholders = ", ".join("?" for _ in allowed_from)
        with self._lock, self._conn:
            cursor = self._conn.execute(
                f"UPDATE proposals SET status = ?, updated_at = ?, review_comment = COALESCE(?, review_comment) "
                f"WHERE id = ? AND status IN ({placeholders})",
                (new_status, _now().isoformat(), comment, proposal_id, *sorted(allowed_from)),
            )
            return cursor.rowcount == 1

    def set_external_url(self, proposal_id: str, url: str | None) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE proposals SET external_url = ?, updated_at = ? WHERE id = ?",
                (url, _now().isoformat(), proposal_id),
            )

    def audit(
        self,
        actor: str,
        action: str,
        proposal_id: str | None,
        document_id: str | None,
        revision: str | None,
        status: str | None,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO audit_events (at, actor, action, proposal_id, document_id, revision, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (_now().isoformat(), actor, action, proposal_id, document_id, revision, status),
            )

    def history(self, proposal_id: str) -> list[sqlite3.Row]:
        with self._lock:
            return list(
                self._conn.execute(
                    "SELECT * FROM audit_events WHERE proposal_id = ? ORDER BY seq", (proposal_id,)
                ).fetchall()
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class ProposalService:
    def __init__(
        self,
        store: ProposalStore,
        repository: KnowledgeRepository,
        publisher: ProposalPublisher,
        ai: AIProvider,
    ) -> None:
        self._store = store
        self._repository = repository
        self._publisher = publisher
        self._ai = ai

    # --- helpers ---------------------------------------------------------------------------------
    async def _document(self, document_id: str, user: UserContext) -> DocumentRecord:
        if not is_valid_document_id(document_id):
            raise ApiError(400, "invalid_document_id", "Некорректный идентификатор документа.")
        try:
            return await self._repository.get_document(document_id, user)
        except DocumentNotFoundError as exc:
            raise ApiError(404, "document_not_found", f"Документ {document_id} не найден.") from exc
        except DuplicateDocumentIdError as exc:
            raise ApiError(
                422, "duplicate_document_id", f"Идентификатор {document_id} неоднозначен: несколько файлов."
            ) from exc

    async def _current_revision(self, document_id: str, user: UserContext) -> str | None:
        try:
            return (await self._repository.get_document(document_id, user)).revision
        except (DocumentNotFoundError, DuplicateDocumentIdError):
            return None

    def _row(self, proposal_id: str) -> Any:
        if not PROPOSAL_ID_RE.fullmatch(proposal_id):
            raise ApiError(404, "proposal_not_found", "Предложение не найдено.")
        row = self._store.get(proposal_id)
        if row is None:
            raise ApiError(404, "proposal_not_found", "Предложение не найдено.")
        return row

    @staticmethod
    def _issues(row: Any) -> list[ValidationIssue]:
        return [ValidationIssue(**i) for i in json.loads(row["validation_json"])]

    def _summary(self, row: Any) -> ProposalSummary:
        issues = self._issues(row)
        return ProposalSummary(
            id=row["id"],
            document_id=row["document_id"],
            document_title=row["document_title"],
            source=row["source"],
            status=ProposalStatus(row["status"]),
            reason=row["reason"],
            origin=row["origin"],
            author=row["author"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            base_revision=row["base_revision"],
            additions=row["additions"],
            deletions=row["deletions"],
            error_count=sum(1 for i in issues if i.severity == "error"),
            warning_count=sum(1 for i in issues if i.severity == "warning"),
        )

    async def _detail(self, row: Any, user: UserContext) -> ProposalDetail:
        summary = self._summary(row)
        current = await self._current_revision(row["document_id"], user)
        is_stale = current != row["base_revision"]
        status = ProposalStatus(row["status"])
        history = [
            ProposalEvent(
                at=datetime.fromisoformat(e["at"]),
                actor=e["actor"],
                action=e["action"],
                status=ProposalStatus(e["status"]) if e["status"] else None,
            )
            for e in self._store.history(row["id"])
        ]
        external_url = row["external_url"] if "external_url" in row.keys() else None  # noqa: SIM118
        if external_url:
            publication = PublicationState(
                state="submitted",
                message="Merge Request открыт в GitLab; решение о merge принимают ревьюеры.",
                external_url=external_url if str(external_url).startswith("https://") else None,
            )
        elif self._publisher.enabled:
            publication = PublicationState(
                state="local_only", message="Можно отправить в GitLab MR после статуса «Готово к ревью»."
            )
        else:
            publication = PublicationState(
                state="disabled",
                message="GitLab MR отключён: предложение хранится локально, исходный документ не меняется.",
            )
        return ProposalDetail(
            **summary.model_dump(),
            document_path=row["document_path"],
            current_revision=current,
            is_stale=is_stale,
            base_content=row["base_content"],
            proposed_content=row["proposed_content"],
            validation=self._issues(row),
            diff=compute_diff(row["base_content"], row["proposed_content"], row["document_path"]),
            history=history,
            review_comment=row["review_comment"],
            can_mark_ready=status == ProposalStatus.open and summary.error_count == 0 and not is_stale,
            can_reject=status in (ProposalStatus.open, ProposalStatus.ready_for_review),
            publication=publication,
        )

    # --- commands ----------------------------------------------------------------------------------
    async def create(self, user: UserContext, payload: DraftCreate) -> ProposalDetail:
        doc = await self._document(payload.document_id, user)
        if payload.base_revision != doc.revision:
            raise ApiError(
                409,
                "revision_conflict",
                "Документ изменился после начала редактирования. Обновите страницу и повторите правку.",
                {"current_revision": doc.revision, "base_revision": payload.base_revision},
            )
        proposed = _normalize_newlines(payload.proposed_content)
        issues = validate_proposal(doc, proposed, payload.origin)
        diff = compute_diff(doc.raw, proposed, doc.path)
        proposal_id = uuid.uuid4().hex
        now = _now().isoformat()
        self._store.insert(
            {
                "id": proposal_id,
                "document_id": doc.id,
                "document_title": doc.title,
                "document_path": doc.path,
                "source": doc.source,
                "base_revision": doc.revision,
                "base_content": doc.raw,
                "proposed_content": proposed,
                "reason": payload.reason.strip(),
                "origin": payload.origin,
                "author": user.user_id,
                "status": ProposalStatus.open.value,
                "validation_json": json.dumps([i.model_dump() for i in issues], ensure_ascii=False),
                "additions": diff.additions,
                "deletions": diff.deletions,
                "review_comment": None,
                "created_at": now,
                "updated_at": now,
            }
        )
        self._store.audit(
            user.user_id, "created", proposal_id, doc.id, doc.revision, ProposalStatus.open.value
        )
        logger.info(
            "proposal created id=%s document=%s errors=%d",
            proposal_id,
            doc.id,
            sum(1 for i in issues if i.severity == "error"),
        )
        return await self._detail(self._row(proposal_id), user)

    async def get(self, user: UserContext, proposal_id: str) -> ProposalDetail:
        return await self._detail(self._row(proposal_id), user)

    async def list_proposals(
        self, user: UserContext, status: ProposalStatus | None, document_id: str | None
    ) -> ProposalList:
        rows = self._store.list_rows(status.value if status else None, document_id)
        items = [self._summary(r) for r in rows]
        return ProposalList(items=items, total=len(items))

    async def reject(self, user: UserContext, proposal_id: str, comment: str | None) -> ProposalDetail:
        row = self._row(proposal_id)
        allowed = {ProposalStatus.open.value, ProposalStatus.ready_for_review.value}
        if not self._store.transition(proposal_id, allowed, ProposalStatus.rejected.value, comment):
            if self._row(proposal_id)["status"] == ProposalStatus.submitted.value:
                raise ApiError(
                    409,
                    "invalid_transition",
                    "Предложение уже отправлено в GitLab MR: отклонить или закрыть его можно только в GitLab.",
                )
            raise ApiError(409, "invalid_transition", "Предложение уже закрыто и не может быть отклонено.")
        self._store.audit(
            user.user_id,
            "rejected",
            proposal_id,
            row["document_id"],
            row["base_revision"],
            ProposalStatus.rejected.value,
        )
        return await self._detail(self._row(proposal_id), user)

    async def mark_ready(self, user: UserContext, proposal_id: str) -> ProposalDetail:
        row = self._row(proposal_id)
        if row["status"] != ProposalStatus.open.value:
            raise ApiError(
                409, "invalid_transition", "Отметить «Готово к ревью» можно только открытое предложение."
            )
        if any(i.severity == "error" for i in self._issues(row)):
            raise ApiError(422, "validation_failed", "Исправьте ошибки валидации перед отправкой на ревью.")
        current = await self._current_revision(row["document_id"], user)
        if current != row["base_revision"]:
            raise ApiError(
                409,
                "revision_conflict",
                "Исходный документ изменился после создания предложения. Создайте новое предложение.",
                {"current_revision": current or "", "base_revision": row["base_revision"]},
            )
        if not self._store.transition(
            proposal_id, {ProposalStatus.open.value}, ProposalStatus.ready_for_review.value
        ):
            raise ApiError(409, "invalid_transition", "Статус предложения изменился параллельно.")
        self._store.audit(
            user.user_id,
            "marked_ready_for_review",
            proposal_id,
            row["document_id"],
            row["base_revision"],
            ProposalStatus.ready_for_review.value,
        )
        return await self._detail(self._row(proposal_id), user)

    async def open_merge_request(self, user: UserContext, proposal_id: str) -> ProposalDetail:
        row = self._row(proposal_id)
        if not self._publisher.enabled:
            raise ApiError(
                503,
                "gitlab_proposals_disabled",
                "Создание Merge Request в GitLab отключено (GITLAB_PROPOSALS_ENABLED=false). "
                "Предложение остаётся локальным.",
            )
        if row["status"] != ProposalStatus.ready_for_review.value:
            raise ApiError(
                409, "invalid_transition", "MR можно открыть только для предложения «Готово к ревью»."
            )
        current = await self._current_revision(row["document_id"], user)
        if current != row["base_revision"]:
            raise ApiError(409, "revision_conflict", "Исходный документ изменился; MR не создан.")
        try:
            result = await self._publisher.publish_proposal(
                ProposalForPublication(
                    proposal_id=row["id"],
                    document_id=row["document_id"],
                    document_path=row["document_path"],
                    base_revision=row["base_revision"],
                    proposed_content=row["proposed_content"],
                    reason=row["reason"],
                ),
                user,
            )
        except PublisherDisabledError as exc:
            raise ApiError(503, exc.code, exc.message) from exc
        if result.state == "conflict":
            raise ApiError(409, "revision_conflict", result.message)
        self._store.set_external_url(proposal_id, result.external_url)
        self._store.transition(
            proposal_id, {ProposalStatus.ready_for_review.value}, ProposalStatus.submitted.value
        )
        self._store.audit(
            user.user_id,
            "merge_request_opened",
            proposal_id,
            row["document_id"],
            row["base_revision"],
            ProposalStatus.submitted.value,
        )
        return await self._detail(self._row(proposal_id), user)

    async def suggest(self, user: UserContext, payload: SuggestRequest) -> SuggestResponse:
        doc = await self._document(payload.document_id, user)
        if payload.base_revision != doc.revision:
            raise ApiError(
                409,
                "revision_conflict",
                "Документ изменился; обновите страницу.",
                {"current_revision": doc.revision},
            )
        try:
            proposed = await self._ai.suggest_edit(payload.instruction, doc.raw)
        except AIProviderError as exc:
            status = (
                503 if exc.code in ("ai_edit_unsupported", "assistant_disabled", "ai_misconfigured") else 502
            )
            raise ApiError(status, exc.code, exc.message) from exc
        warnings = ["Черновик сгенерирован ИИ: проверьте каждое изменение перед созданием предложения."]
        return SuggestResponse(
            document_id=doc.id,
            base_revision=doc.revision,
            proposed_content=proposed,
            mode=self._ai.mode,
            warnings=warnings,
        )
