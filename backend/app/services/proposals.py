"""Reviewable change proposals. The canonical document is NEVER modified here.

Lifecycle (docs/GITLAB_KNOWLEDGE_WORKFLOW.md):

    draft ──mark-ready──▶ ready_for_review ──submit──▶ submitting ──▶ submitted_to_gitlab ──GitLab merge──▶ merged
      │                        │                          │  └──▶ submission_failed ──retry──▶ submitting
      └──reject──▶ rejected ◀──┘                          └──▶ conflict (source changed; nothing overwritten)
                                     submitted_to_gitlab ──MR closed in GitLab──▶ rejected

The local status and the GitLab MR state are stored separately; `merged` is set only after GitLab
reported the MR as merged. Proposals live in local derived state (SQLite under the ignored workspace).
"""

from __future__ import annotations

import difflib
import json
import logging
import re
import sqlite3
import threading
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from app.adapters.ai.base import AIProvider, AIProviderError
from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeRepository,
    RepositoryUnavailableError,
)
from app.adapters.publishers.base import (
    MergeRequestRef,
    ProposalForPublication,
    ProposalPublisher,
    PublicationError,
)
from app.domain.models import DocStatus, DocumentRecord, UserContext, ValidationIssue
from app.domain.proposals import (
    LEGACY_STATUS_MAP,
    DiffLine,
    DiffResult,
    DraftCreate,
    MergeRequestInfo,
    ProposalDetail,
    ProposalEvent,
    ProposalList,
    ProposalStatus,
    ProposalSummary,
    PublicationState,
    SourceDocumentState,
    SubmissionInfo,
    SuggestRequest,
    SuggestResponse,
)
from app.domain.schema import is_valid_document_id, parse_document
from app.errors import ApiError

logger = logging.getLogger("skh.proposals")

PROPOSAL_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
# A submission that is still "submitting" after this long was interrupted (e.g. a restart): it may
# be retried, and the retry inspects GitLab before writing anything.
SUBMITTING_STALE_AFTER = timedelta(minutes=5)
_ALLOWED_SUFFIXES = (".md",)
S = ProposalStatus


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


def repository_path_problem(path: str, knowledge_prefix: str = "") -> str | None:
    """Reject anything but a plain relative Markdown path inside the knowledge directory."""
    if not path or len(path) > 400:
        return "Путь файла пуст или слишком длинный."
    if "\\" in path or any(ord(c) < 32 for c in path) or path.startswith("/") or ":" in path.split("/")[0]:
        return "Путь файла должен быть относительным POSIX-путём."
    parts = PurePosixPath(path).parts
    if any(part in ("", ".", "..") for part in parts) or "//" in path:
        return "Путь файла не должен содержать `.`/`..` или пустые сегменты."
    if not path.lower().endswith(_ALLOWED_SUFFIXES):
        return "Изменять можно только Markdown-файлы базы знаний (.md)."
    prefix = knowledge_prefix.strip("/")
    if prefix and not path.startswith(prefix + "/"):
        return "Файл находится вне каталога базы знаний."
    return None


def validate_proposal(
    doc: DocumentRecord,
    proposed: str,
    origin: str,
    *,
    max_bytes: int | None = None,
    knowledge_prefix: str = "",
) -> list[ValidationIssue]:
    """Markdown + YAML front matter + required fields + unchanged id + path + size + no-op check."""
    parsed = parse_document(proposed, expected_id=doc.id)
    issues = list(parsed.issues)
    if max_bytes is not None and len(proposed.encode("utf-8")) > max_bytes:
        issues.append(
            ValidationIssue(
                severity="error",
                code="document_too_large",
                message=f"Документ превышает допустимый размер ({max_bytes // 1024} КБ).",
            )
        )
    path_problem = repository_path_problem(doc.path, knowledge_prefix)
    if path_problem:
        issues.append(ValidationIssue(severity="error", code="unsafe_path", message=path_problem))
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


_NEW_COLUMNS = {
    "external_url": "TEXT",  # MR web URL (name kept for stores created by earlier builds)
    "branch_name": "TEXT",
    "mr_iid": "TEXT",
    "mr_state": "TEXT",
    "mr_source_branch": "TEXT",
    "mr_target_branch": "TEXT",
    "mr_checked_at": "TEXT",
    "submit_attempts": "INTEGER NOT NULL DEFAULT 0",
    "last_attempt_at": "TEXT",
    "error_code": "TEXT",
    "error_message": "TEXT",
    "uncertain": "INTEGER NOT NULL DEFAULT 0",
}
_UPDATABLE = frozenset(_NEW_COLUMNS) | {"review_comment"}


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
            for name, ddl in _NEW_COLUMNS.items():  # additive migrations for older stores
                if name not in columns:
                    self._conn.execute(f"ALTER TABLE proposals ADD COLUMN {name} {ddl}")
            self._conn.execute(
                """CREATE TABLE IF NOT EXISTS audit_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
                    action TEXT NOT NULL, proposal_id TEXT, document_id TEXT, revision TEXT, status TEXT)"""
            )
            for old, new in LEGACY_STATUS_MAP.items():
                self._conn.execute("UPDATE proposals SET status = ? WHERE status = ?", (new, old))
                self._conn.execute("UPDATE audit_events SET status = ? WHERE status = ?", (new, old))

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
        self,
        proposal_id: str,
        allowed_from: set[str],
        new_status: str,
        comment: str | None = None,
        **fields: Any,
    ) -> bool:
        """Atomic compare-and-set of the status (guards against double submit and races)."""
        unknown = set(fields) - _UPDATABLE
        if unknown:
            raise ValueError(f"not updatable: {sorted(unknown)}")
        placeholders = ", ".join("?" for _ in allowed_from)
        assignments = "".join(f", {name} = ?" for name in fields)
        with self._lock, self._conn:
            cursor = self._conn.execute(
                f"UPDATE proposals SET status = ?, updated_at = ?, review_comment = COALESCE(?, review_comment)"
                f"{assignments} WHERE id = ? AND status IN ({placeholders})",
                (
                    new_status,
                    _now().isoformat(),
                    comment,
                    *fields.values(),
                    proposal_id,
                    *sorted(allowed_from),
                ),
            )
            return cursor.rowcount == 1

    def update(self, proposal_id: str, **fields: Any) -> None:
        unknown = set(fields) - _UPDATABLE
        if unknown or not fields:
            raise ValueError(f"not updatable: {sorted(unknown)}")
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._lock, self._conn:
            self._conn.execute(
                f"UPDATE proposals SET {assignments}, updated_at = ? WHERE id = ?",
                (*fields.values(), _now().isoformat(), proposal_id),
            )

    def set_external_url(self, proposal_id: str, url: str | None) -> None:
        self.update(proposal_id, external_url=url)

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


def _status(value: str) -> ProposalStatus:
    return ProposalStatus(LEGACY_STATUS_MAP.get(value, value))


def _dt(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class ProposalService:
    def __init__(
        self,
        store: ProposalStore,
        repository: KnowledgeRepository,
        publisher: ProposalPublisher,
        ai: AIProvider,
        *,
        max_document_bytes: int | None = None,
        knowledge_prefix: str = "",
        app_public_url: str = "",
        on_merged: Callable[[], Awaitable[object]] | None = None,
    ) -> None:
        self._store = store
        self._repository = repository
        self._publisher = publisher
        self._ai = ai
        self._max_bytes = max_document_bytes
        self._prefix = knowledge_prefix
        self._app_url = app_public_url.rstrip("/")
        self._on_merged = on_merged

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

    async def _snapshot_revision(self, document_id: str, user: UserContext) -> str | None:
        try:
            return (await self._repository.get_document(document_id, user)).revision
        except (DocumentNotFoundError, DuplicateDocumentIdError, RepositoryUnavailableError):
            return None

    async def _fresh_revision(self, document_id: str, user: UserContext) -> str | None:
        """Revision as the source reports it now — the only acceptable basis for a write decision."""
        try:
            return await self._repository.current_revision(document_id, user)
        except RepositoryUnavailableError as exc:
            raise ApiError(
                503, exc.code, f"Не удалось проверить актуальную ревизию документа: {exc.message}"
            ) from exc

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
            status=_status(row["status"]),
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
            merge_request_url=row["external_url"],
            merge_request_state=row["mr_state"],
        )

    def _submitting_is_stale(self, row: Any) -> bool:
        updated = _dt(row["updated_at"])
        return _status(row["status"]) == S.submitting and (
            updated is None or _now() - updated > SUBMITTING_STALE_AFTER
        )

    async def _detail(self, row: Any, user: UserContext) -> ProposalDetail:
        summary = self._summary(row)
        status = summary.status
        current = await self._snapshot_revision(row["document_id"], user)
        is_stale = current != row["base_revision"]
        history = [
            ProposalEvent(
                at=datetime.fromisoformat(e["at"]),
                actor=e["actor"],
                action=e["action"],
                status=_status(e["status"]) if e["status"] else None,
            )
            for e in self._store.history(row["id"])
        ]
        merge_request = None
        if row["mr_iid"] or row["external_url"]:
            merge_request = MergeRequestInfo(
                iid=row["mr_iid"],
                url=row["external_url"],
                state=row["mr_state"],
                source_branch=row["mr_source_branch"],
                target_branch=row["mr_target_branch"],
                checked_at=_dt(row["mr_checked_at"]),
            )
        if merge_request is not None:
            publication = PublicationState(
                state="submitted",
                message="Merge Request открыт в GitLab; решение о merge принимают ревьюеры.",
                external_url=merge_request.url,
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
        source_state: SourceDocumentState
        if status == S.merged:
            source_state = "updated_by_this_proposal"
        elif current is None:
            source_state = "missing"
        elif is_stale:
            source_state = "changed_since_base"
        else:
            source_state = "unchanged"
        uncertain = bool(row["uncertain"])
        submittable = status in (S.ready_for_review, S.submission_failed) or self._submitting_is_stale(row)
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
            can_mark_ready=status == S.draft and summary.error_count == 0 and not is_stale,
            can_reject=status in (S.draft, S.ready_for_review)
            or (status == S.submission_failed and not uncertain),
            can_submit=self._publisher.enabled and submittable and summary.error_count == 0,
            can_refresh_status=self._publisher.enabled
            and (status == S.submitted_to_gitlab or (status == S.submission_failed and uncertain)),
            publication=publication,
            source_document_state=source_state,
            branch_name=row["branch_name"] or self._publisher.branch_for(row["id"], row["document_id"]),
            merge_request=merge_request,
            submission=SubmissionInfo(
                attempts=row["submit_attempts"] or 0,
                last_attempt_at=_dt(row["last_attempt_at"]),
                error_code=row["error_code"],
                error_message=row["error_message"],
                uncertain=uncertain,
            ),
        )

    def _mark_conflict(
        self, user: UserContext, row: Any, allowed_from: set[str], current: str | None
    ) -> ApiError:
        if self._store.transition(row["id"], allowed_from, S.conflict.value):
            self._store.audit(
                user.user_id, "conflict_detected", row["id"], row["document_id"], current, S.conflict.value
            )
        return ApiError(
            409,
            "revision_conflict",
            "Исходный документ изменился после создания предложения. Ничего не перезаписано; "
            "создайте новое предложение на основе актуальной версии.",
            {"current_revision": current or "", "base_revision": row["base_revision"]},
        )

    def _store_mr(self, proposal_id: str, mr: MergeRequestRef) -> dict[str, Any]:
        return {
            "mr_iid": mr.iid or None,
            "external_url": mr.url,
            "mr_state": mr.state,
            "mr_source_branch": mr.source_branch,
            "mr_target_branch": mr.target_branch,
            "mr_checked_at": _now().isoformat(),
        }

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
        issues = validate_proposal(
            doc, proposed, payload.origin, max_bytes=self._max_bytes, knowledge_prefix=self._prefix
        )
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
                "status": S.draft.value,
                "validation_json": json.dumps([i.model_dump() for i in issues], ensure_ascii=False),
                "additions": diff.additions,
                "deletions": diff.deletions,
                "review_comment": None,
                "created_at": now,
                "updated_at": now,
                "branch_name": self._publisher.branch_for(proposal_id, doc.id),
            }
        )
        self._store.audit(user.user_id, "created", proposal_id, doc.id, doc.revision, S.draft.value)
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
        status = _status(row["status"])
        if status == S.submission_failed and row["uncertain"]:
            raise ApiError(
                409,
                "submission_uncertain",
                "Результат записи в GitLab не подтверждён: сначала проверьте статус в GitLab или повторите отправку.",
            )
        allowed = {S.draft.value, S.ready_for_review.value, S.submission_failed.value}
        if not self._store.transition(proposal_id, allowed, S.rejected.value, comment):
            if _status(self._row(proposal_id)["status"]) in (S.submitted_to_gitlab, S.submitting):
                raise ApiError(
                    409,
                    "invalid_transition",
                    "Предложение уже отправлено в GitLab MR: отклонить или закрыть его можно только в GitLab.",
                )
            raise ApiError(409, "invalid_transition", "Предложение уже закрыто и не может быть отклонено.")
        self._store.audit(
            user.user_id, "rejected", proposal_id, row["document_id"], row["base_revision"], S.rejected.value
        )
        return await self._detail(self._row(proposal_id), user)

    async def mark_ready(self, user: UserContext, proposal_id: str) -> ProposalDetail:
        row = self._row(proposal_id)
        if _status(row["status"]) != S.draft:
            raise ApiError(
                409, "invalid_transition", "Отметить «Готово к ревью» можно только новое предложение."
            )
        if any(i.severity == "error" for i in self._issues(row)):
            raise ApiError(422, "validation_failed", "Исправьте ошибки валидации перед отправкой на ревью.")
        current = await self._fresh_revision(row["document_id"], user)
        if current != row["base_revision"]:
            raise self._mark_conflict(user, row, {S.draft.value}, current)
        if not self._store.transition(proposal_id, {S.draft.value}, S.ready_for_review.value):
            raise ApiError(409, "invalid_transition", "Статус предложения изменился параллельно.")
        self._store.audit(
            user.user_id,
            "marked_ready_for_review",
            proposal_id,
            row["document_id"],
            row["base_revision"],
            S.ready_for_review.value,
        )
        return await self._detail(self._row(proposal_id), user)

    async def submit(self, user: UserContext, proposal_id: str) -> ProposalDetail:
        """Create (or find) the GitLab branch, commit and MR for a reviewed proposal."""
        row = self._row(proposal_id)
        if not self._publisher.enabled:
            raise ApiError(
                503,
                "gitlab_proposals_disabled",
                "Создание Merge Request в GitLab отключено (GITLAB_PROPOSALS_ENABLED=false). "
                "Предложение остаётся локальным.",
            )
        status = _status(row["status"])
        allowed = {S.ready_for_review.value, S.submission_failed.value}
        if self._submitting_is_stale(row):
            allowed.add(S.submitting.value)
        elif status not in (S.ready_for_review, S.submission_failed):
            raise ApiError(
                409,
                "invalid_transition",
                "Отправить в GitLab можно только предложение «Готово к ревью» или после ошибки отправки.",
            )
        # Re-validate the stored content against the current rules before anything is written.
        doc = await self._document(row["document_id"], user)
        issues = validate_proposal(
            doc.model_copy(update={"raw": row["base_content"], "path": row["document_path"]}),
            row["proposed_content"],
            row["origin"],
            max_bytes=self._max_bytes,
            knowledge_prefix=self._prefix,
        )
        if any(i.severity == "error" for i in issues):
            raise ApiError(422, "validation_failed", "Предложение не проходит валидацию; отправка отменена.")
        uncertain_before = bool(row["uncertain"])
        current = await self._fresh_revision(row["document_id"], user)
        if current != row["base_revision"] and not (uncertain_before or row["mr_iid"]):
            # With an uncertain earlier attempt the commit may be ours: the publisher decides by state.
            raise self._mark_conflict(user, row, allowed, current)
        attempts = (row["submit_attempts"] or 0) + 1
        if not self._store.transition(
            proposal_id,
            allowed,
            S.submitting.value,
            submit_attempts=attempts,
            last_attempt_at=_now().isoformat(),
        ):
            raise ApiError(409, "submission_in_progress", "Предложение уже отправляется в GitLab.")
        self._store.audit(
            user.user_id,
            "submission_started",
            proposal_id,
            row["document_id"],
            row["base_revision"],
            S.submitting.value,
        )
        publication = ProposalForPublication(
            proposal_id=row["id"],
            document_id=row["document_id"],
            document_path=row["document_path"],
            base_revision=row["base_revision"],
            proposed_content=row["proposed_content"],
            reason=row["reason"],
            document_title=row["document_title"],
            author=row["author"],
            additions=row["additions"],
            deletions=row["deletions"],
            proposal_url=f"{self._app_url}/proposals/{row['id']}" if self._app_url else None,
        )
        try:
            result = await self._publisher.publish_proposal(publication, user)
        except PublicationError as exc:
            self._fail(user, row, exc.code, exc.message, uncertain=exc.uncertain)
            status_code = 409 if exc.code == "gitlab_branch_conflict" else (503 if not exc.retryable else 502)
            raise ApiError(
                status_code,
                exc.code,
                exc.message,
                {"proposal_status": S.submission_failed.value, "proposal_preserved": "true"},
            ) from exc
        except Exception:
            # Unknown outcome: never leave the proposal stuck in "submitting".
            self._fail(
                user, row, "submission_error", "Непредвиденная ошибка при отправке в GitLab.", uncertain=True
            )
            raise
        if result.state == "conflict" or result.merge_request is None:
            raise self._mark_conflict(user, row, {S.submitting.value}, current)
        mr = result.merge_request
        self._store.transition(
            proposal_id,
            {S.submitting.value},
            S.submitted_to_gitlab.value,
            branch_name=mr.source_branch,
            error_code=None,
            error_message=None,
            uncertain=0,
            **self._store_mr(proposal_id, mr),
        )
        self._store.audit(
            user.user_id,
            "merge_request_opened" if result.state == "created" else "merge_request_found",
            proposal_id,
            row["document_id"],
            row["base_revision"],
            S.submitted_to_gitlab.value,
        )
        detail = await self._detail(self._row(proposal_id), user)
        if mr.state in ("merged", "closed"):  # an existing MR may already be decided
            return await self.refresh_status(user, proposal_id)
        return detail

    def _fail(self, user: UserContext, row: Any, code: str, message: str, *, uncertain: bool) -> None:
        self._store.transition(
            row["id"],
            {S.submitting.value},
            S.submission_failed.value,
            error_code=code,
            error_message=message[:500],
            uncertain=1 if uncertain else 0,
        )
        self._store.audit(
            user.user_id,
            "submission_failed",
            row["id"],
            row["document_id"],
            row["base_revision"],
            S.submission_failed.value,
        )
        logger.warning("proposal %s submission failed: %s (uncertain=%s)", row["id"], code, uncertain)

    async def refresh_status(self, user: UserContext, proposal_id: str) -> ProposalDetail:
        """Ask GitLab for the MR state. `merged` is recorded only when GitLab reports it."""
        row = self._row(proposal_id)
        status = _status(row["status"])
        if not self._publisher.enabled:
            raise ApiError(503, "gitlab_proposals_disabled", "Интеграция с GitLab MR отключена.")
        if status not in (S.submitted_to_gitlab, S.submission_failed, S.merged, S.rejected):
            raise ApiError(409, "invalid_transition", "Предложение ещё не отправлялось в GitLab.")
        try:
            mr = await self._publisher.merge_request_state(row["id"], row["document_id"], row["mr_iid"])
        except PublicationError as exc:
            raise ApiError(502, exc.code, exc.message) from exc
        if mr is None:
            if status == S.submission_failed:
                # Uncertain earlier attempt and no MR in GitLab: the next submit will inspect the branch.
                self._store.update(proposal_id, uncertain=0, mr_checked_at=_now().isoformat())
                return await self._detail(self._row(proposal_id), user)
            raise ApiError(
                502,
                "merge_request_missing",
                "GitLab не нашёл Merge Request этого предложения (возможно, удалён).",
            )
        fields = self._store_mr(proposal_id, mr)
        if status == S.submission_failed:
            # The lost answer hid a created MR: adopt it instead of creating another one.
            self._store.transition(
                proposal_id,
                {S.submission_failed.value},
                S.submitted_to_gitlab.value,
                error_code=None,
                error_message=None,
                uncertain=0,
                **fields,
            )
            self._store.audit(
                user.user_id,
                "merge_request_found",
                proposal_id,
                row["document_id"],
                row["base_revision"],
                S.submitted_to_gitlab.value,
            )
            status = S.submitted_to_gitlab
        else:
            self._store.update(proposal_id, **fields)
        if status == S.submitted_to_gitlab and mr.state == "merged":
            if self._store.transition(proposal_id, {S.submitted_to_gitlab.value}, S.merged.value):
                self._store.audit(
                    user.user_id,
                    "merged_in_gitlab",
                    proposal_id,
                    row["document_id"],
                    row["base_revision"],
                    S.merged.value,
                )
                if self._on_merged is not None:
                    try:
                        await self._on_merged()  # pull the merged revision into the knowledge base
                    except RepositoryUnavailableError:
                        logger.warning("knowledge refresh after merge failed; next sync will retry")
        elif status == S.submitted_to_gitlab and mr.state == "closed":
            if self._store.transition(
                proposal_id,
                {S.submitted_to_gitlab.value},
                S.rejected.value,
                comment="Merge Request закрыт в GitLab без merge.",
            ):
                self._store.audit(
                    user.user_id,
                    "merge_request_closed",
                    proposal_id,
                    row["document_id"],
                    row["base_revision"],
                    S.rejected.value,
                )
        else:
            self._store.audit(
                user.user_id,
                "merge_request_checked",
                proposal_id,
                row["document_id"],
                row["base_revision"],
                _status(self._row(proposal_id)["status"]).value,
            )
        return await self._detail(self._row(proposal_id), user)

    # Backwards-compatible name (POST /api/drafts/{id}/open-mr).
    open_merge_request = submit

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
