"""M5: publication of merged GitLab documents to Confluence Data Center (docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md).

    pending ─dry-run─▶ validating ─▶ dry_run_ready ─publish─▶ publishing ─▶ published
                          │   └──▶ failed (blocked: not merged, invalid, missing space…)
                          └──────▶ conflict (manual edit, foreign page, title taken; nothing written)
    publishing ─timeout / lost answer─▶ (inspect Confluence) ─▶ published | failed | result_unknown

Rules:
- only a revision that GitLab reports as merged into the knowledge branch is published;
- a dry-run issues read requests only; the human publishes explicitly (opt-in, write gated by config);
- a page is ours only through the durable mapping AND the ownership content property; a page with the
  same title but without our marker, or a page edited manually since our last publication, is never
  overwritten automatically;
- a write whose answer was lost is never repeated blindly: Confluence is inspected first;
- one active job per document; jobs and mappings survive restarts (SQLite in the workspace volume);
- publication never changes GitLab, the proposal or the knowledge base.
"""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import sqlite3
import threading
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeRepository,
    RepositoryUnavailableError,
)
from app.adapters.publishers.base import ConfluencePublisher, PublicationError
from app.domain.confluence_storage import render_storage, storage_signature
from app.domain.models import DocumentRecord, UserContext, ValidationIssue
from app.domain.publications import (
    ACTIVE_JOB_STATES,
    DocumentPublicationState,
    DocumentPublicationStatus,
    MergeEvidence,
    PublicationEvent,
    PublicationJobDetail,
    PublicationJobList,
    PublicationJobSummary,
    PublicationMappingInfo,
    PublicationPlan,
    PublicationTarget,
    PublisherInfo,
)
from app.domain.schema import is_valid_document_id
from app.errors import ApiError
from app.services.knowledge import KnowledgeService

logger = logging.getLogger("skh.publications")

JOB_ID_LENGTH = 32
MAX_DIFF_CHARS = 200_000
CONFLICT_CODES = frozenset(
    {"mapped_page_missing", "foreign_page", "page_moved", "manual_edit", "title_taken"}
)
MergeEvidenceLookup = Callable[[str], Awaitable[dict[str, str] | None]]


def _now() -> datetime:
    return datetime.now(UTC)


def _dt(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _issue(severity: str, code: str, message: str) -> ValidationIssue:
    return ValidationIssue.model_validate({"severity": severity, "code": code, "message": message})


def _diff(before: str, after: str, before_name: str, after_name: str) -> str:
    lines = difflib.unified_diff(
        before.splitlines(), after.splitlines(), fromfile=before_name, tofile=after_name, lineterm="", n=2
    )
    text = "\n".join(lines)
    return text if len(text) <= MAX_DIFF_CHARS else text[:MAX_DIFF_CHARS] + "\n… (diff сокращён)"


_JOB_FIELDS = frozenset(
    {
        "action",
        "plan_json",
        "attempts",
        "error_code",
        "error_message",
        "uncertain",
        "page_id",
        "version_before",
        "version_after",
        "published_at",
    }
)


class PublicationStore:
    """Durable jobs, document→page mappings and a content-free event log."""

    def __init__(self, path: Path | str) -> None:
        self._path = str(path)
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self._path, check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        active = ", ".join(f"'{s}'" for s in ACTIVE_JOB_STATES)
        with self._conn:
            self._conn.executescript(
                f"""
                CREATE TABLE IF NOT EXISTS publication_jobs (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_key TEXT NOT NULL,
                    document_id TEXT NOT NULL, document_path TEXT NOT NULL, revision TEXT NOT NULL,
                    proposal_id TEXT, state TEXT NOT NULL, action TEXT, plan_json TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
                    uncertain INTEGER NOT NULL DEFAULT 0, page_id TEXT, version_before INTEGER,
                    version_after INTEGER, requested_by TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, published_at TEXT);
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_document
                    ON publication_jobs(project_id, document_key) WHERE state IN ({active});
                CREATE TABLE IF NOT EXISTS publication_mappings (
                    project_id TEXT NOT NULL, document_key TEXT NOT NULL, document_id TEXT NOT NULL,
                    document_path TEXT NOT NULL, page_id TEXT NOT NULL, space_key TEXT NOT NULL,
                    parent_id TEXT NOT NULL, page_title TEXT NOT NULL, page_version INTEGER NOT NULL,
                    published_revision TEXT NOT NULL, published_signature TEXT NOT NULL,
                    published_storage TEXT NOT NULL, rendered_signature TEXT NOT NULL,
                    last_published_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY (project_id, document_key));
                CREATE TABLE IF NOT EXISTS publication_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
                    action TEXT NOT NULL, job_id TEXT, document_id TEXT, revision TEXT, state TEXT);
                """
            )

    def insert_job(self, row: dict[str, Any]) -> None:
        columns = ", ".join(row)
        placeholders = ", ".join(f":{k}" for k in row)
        with self._lock, self._conn:
            self._conn.execute(f"INSERT INTO publication_jobs ({columns}) VALUES ({placeholders})", row)

    def job(self, job_id: str) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                "SELECT * FROM publication_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            return row

    def jobs(self, project_id: str, document_key: str | None, limit: int = 50) -> list[sqlite3.Row]:
        sql = "SELECT * FROM publication_jobs WHERE project_id = ?"
        params: list[Any] = [project_id]
        if document_key:
            sql += " AND document_key = ?"
            params.append(document_key)
        sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        params.append(limit)
        with self._lock:
            return list(self._conn.execute(sql, params).fetchall())

    def active_job(self, project_id: str, document_key: str) -> sqlite3.Row | None:
        placeholders = ", ".join("?" for _ in ACTIVE_JOB_STATES)
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                f"SELECT * FROM publication_jobs WHERE project_id = ? AND document_key = ? AND state IN ({placeholders})",
                (project_id, document_key, *ACTIVE_JOB_STATES),
            ).fetchone()
            return row

    def transition(self, job_id: str, allowed_from: set[str], new_state: str, **fields: Any) -> bool:
        unknown = set(fields) - _JOB_FIELDS
        if unknown:
            raise ValueError(f"not updatable: {sorted(unknown)}")
        placeholders = ", ".join("?" for _ in allowed_from)
        assignments = "".join(f", {name} = ?" for name in fields)
        with self._lock, self._conn:
            cursor = self._conn.execute(
                f"UPDATE publication_jobs SET state = ?, updated_at = ?{assignments} "
                f"WHERE id = ? AND state IN ({placeholders})",
                (new_state, _now().isoformat(), *fields.values(), job_id, *sorted(allowed_from)),
            )
            return cursor.rowcount == 1

    def mapping(self, project_id: str, document_key: str) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(
                "SELECT * FROM publication_mappings WHERE project_id = ? AND document_key = ?",
                (project_id, document_key),
            ).fetchone()
            return row

    def upsert_mapping(self, row: dict[str, Any]) -> None:
        columns = ", ".join(row)
        placeholders = ", ".join(f":{k}" for k in row)
        updates = ", ".join(f"{k} = excluded.{k}" for k in row if k not in ("project_id", "document_key"))
        with self._lock, self._conn:
            self._conn.execute(
                f"INSERT INTO publication_mappings ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(project_id, document_key) DO UPDATE SET {updates}",
                row,
            )

    def event(
        self,
        actor: str,
        action: str,
        job_id: str | None,
        document_id: str,
        revision: str | None,
        state: str | None,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO publication_events (at, actor, action, job_id, document_id, revision, state) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (_now().isoformat(), actor, action, job_id, document_id, revision, state),
            )

    def history(self, job_id: str) -> list[sqlite3.Row]:
        with self._lock:
            return list(
                self._conn.execute(
                    "SELECT * FROM publication_events WHERE job_id = ? ORDER BY seq", (job_id,)
                ).fetchall()
            )

    def recover_interrupted(self) -> tuple[int, int]:
        """After a restart: an interrupted dry-run is simply redone; an interrupted write is
        `result_unknown` — Confluence is inspected before anything is written again."""
        now = _now().isoformat()
        with self._lock, self._conn:
            validating = self._conn.execute(
                "UPDATE publication_jobs SET state = 'pending', updated_at = ? WHERE state = 'validating'",
                (now,),
            ).rowcount
            publishing = self._conn.execute(
                "UPDATE publication_jobs SET state = 'result_unknown', uncertain = 1, updated_at = ?, "
                "error_code = 'interrupted', error_message = 'Публикация прервана перезапуском; результат будет "
                "проверен в Confluence перед повтором.' WHERE state = 'publishing'",
                (now,),
            ).rowcount
        return validating, publishing

    def close(self) -> None:
        with self._lock:
            self._conn.close()


Applied = Literal["applied", "not_applied", "unknown"]


class PublicationService:
    def __init__(
        self,
        *,
        store: PublicationStore,
        publisher: ConfluencePublisher,
        repository: KnowledgeRepository,
        knowledge: KnowledgeService,
        merge_evidence: MergeEvidenceLookup | None,
        project_id: str,
        publish_statuses: list[str],
    ) -> None:
        self._store = store
        self._publisher = publisher
        self._repository = repository
        self._knowledge = knowledge
        self._evidence = merge_evidence
        self._project = project_id
        self._statuses = frozenset(publish_statuses)
        self._locks: dict[str, asyncio.Lock] = {}

    @property
    def publisher(self) -> ConfluencePublisher:
        return self._publisher

    def recover(self) -> None:
        validating, publishing = self._store.recover_interrupted()
        if validating or publishing:
            logger.warning(
                "recovered publication jobs: dry-run=%d, interrupted writes=%d", validating, publishing
            )

    def _lock(self, document_key: str) -> asyncio.Lock:
        return self._locks.setdefault(document_key, asyncio.Lock())

    def _ensure_enabled(self) -> None:
        if not self._publisher.enabled:
            raise ApiError(
                503, "publication_disabled", "Публикация в Confluence не настроена (CONFLUENCE_REST_URL)."
            )

    # --- views -------------------------------------------------------------------------------------
    def _publisher_info(self) -> PublisherInfo:
        pub = self._publisher
        if not pub.enabled:
            message = "Публикация в Confluence не настроена."
        elif pub.write_enabled:
            message = "Публикация включена для тестового пространства" + (
                " (локальный тестовый дубль Confluence)." if pub.target_kind == "mock" else "."
            )
        else:
            message = "Доступен только предпросмотр (dry-run): запись в Confluence выключена."
        return PublisherInfo(
            mode=pub.mode,
            target_kind=pub.target_kind,
            space_key=pub.space_key or None,
            parent_id=pub.parent_id or None,
            message=message,
        )

    @staticmethod
    def _summary(row: Any) -> PublicationJobSummary:
        return PublicationJobSummary(
            id=row["id"],
            document_id=row["document_id"],
            document_path=row["document_path"],
            revision=row["revision"],
            state=row["state"],
            action=row["action"],
            proposal_id=row["proposal_id"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            attempts=row["attempts"],
            error_code=row["error_code"],
            error_message=row["error_message"],
            uncertain=bool(row["uncertain"]),
            page_id=row["page_id"],
            version_after=row["version_after"],
            published_at=_dt(row["published_at"]),
        )

    def _plan_of(self, row: Any) -> PublicationPlan | None:
        return PublicationPlan.model_validate_json(row["plan_json"]) if row["plan_json"] else None

    def _detail(self, row: Any) -> PublicationJobDetail:
        plan = self._plan_of(row)
        state = row["state"]
        write = self._publisher.write_enabled
        return PublicationJobDetail(
            **self._summary(row).model_dump(),
            plan=plan,
            history=[
                PublicationEvent(
                    at=datetime.fromisoformat(e["at"]),
                    actor=e["actor"],
                    action=e["action"],
                    state=e["state"],
                    revision=e["revision"],
                )
                for e in self._store.history(row["id"])
            ],
            can_dry_run=self._publisher.enabled
            and state in ("pending", "dry_run_ready", "failed", "conflict"),
            can_publish=write
            and state == "dry_run_ready"
            and plan is not None
            and not plan.problems
            and plan.action in ("create", "update", "noop"),
            can_reconcile=self._publisher.enabled and state in ("result_unknown", "failed", "conflict"),
            publish_enabled=write,
            publish_disabled_reason=None
            if write
            else "Запись в Confluence выключена (CONFLUENCE_PUBLISH_ENABLED=false): доступен только предпросмотр.",
        )

    def _job_row(self, job_id: str) -> Any:
        if len(job_id) != JOB_ID_LENGTH or not job_id.isalnum():
            raise ApiError(404, "publication_job_not_found", "Задание публикации не найдено.")
        row = self._store.job(job_id)
        if row is None or row["project_id"] != self._project:
            raise ApiError(404, "publication_job_not_found", "Задание публикации не найдено.")
        return row

    def _mapping_info(self, mapping: Any) -> PublicationMappingInfo:
        return PublicationMappingInfo(
            page_id=mapping["page_id"],
            space_key=mapping["space_key"],
            parent_id=mapping["parent_id"],
            page_title=mapping["page_title"],
            page_version=mapping["page_version"],
            published_revision=mapping["published_revision"],
            last_published_at=datetime.fromisoformat(mapping["last_published_at"]),
            url=self._publisher.page_url(mapping["page_id"]),
        )

    async def document_status(self, user: UserContext, document_id: str) -> DocumentPublicationStatus:
        doc = await self._document(user, document_id)
        info = self._publisher_info()
        key = doc.id.lower()
        mapping = self._store.mapping(self._project, key) if self._publisher.enabled else None
        jobs = self._store.jobs(self._project, key, limit=1) if self._publisher.enabled else []
        latest = jobs[0] if jobs else None
        state: DocumentPublicationState
        if not self._publisher.enabled:
            state, message = "disabled", info.message
        elif latest is not None and (
            latest["state"] in ACTIVE_JOB_STATES
            or (
                latest["state"] in ("conflict", "failed")
                and (mapping is None or latest["updated_at"] >= mapping["last_published_at"])
            )
        ):
            state = latest["state"]
            message = {
                "pending": "Задание публикации создано; предпросмотр ещё не выполнен.",
                "validating": "Выполняется предпросмотр публикации.",
                "dry_run_ready": "Предпросмотр готов: проверьте изменения перед публикацией.",
                "publishing": "Идёт публикация в Confluence.",
                "result_unknown": "Результат публикации не подтверждён: перед повтором состояние будет проверено в Confluence.",
                "conflict": latest["error_message"] or "Конфликт публикации: ничего не перезаписано.",
                "failed": latest["error_message"] or "Публикация не выполнена.",
            }[latest["state"]]
        elif mapping is not None:
            if mapping["published_revision"] == doc.revision:
                state, message = "published", "Опубликована актуальная ревизия документа."
            else:
                state, message = "outdated", "В Confluence опубликована более ранняя ревизия документа."
        else:
            state, message = "not_published", "Документ ещё не публиковался в Confluence."
        busy = latest is not None and latest["state"] in ("publishing", "result_unknown")
        return DocumentPublicationStatus(
            document_id=doc.id,
            current_revision=doc.revision,
            state=state,
            message=message,
            publisher=info,
            mapping=self._mapping_info(mapping) if mapping is not None else None,
            latest_job=self._summary(latest) if latest is not None else None,
            can_prepare=self._publisher.enabled and not busy,
        )

    async def get_job(self, job_id: str) -> PublicationJobDetail:
        return self._detail(self._job_row(job_id))

    async def list_jobs(self, document_id: str | None) -> PublicationJobList:
        rows = self._store.jobs(self._project, document_id.lower() if document_id else None)
        return PublicationJobList(items=[self._summary(r) for r in rows], total=len(rows))

    # --- commands ----------------------------------------------------------------------------------
    async def _document(self, user: UserContext, document_id: str) -> DocumentRecord:
        if not is_valid_document_id(document_id):
            raise ApiError(400, "invalid_document_id", "Некорректный идентификатор документа.")
        try:
            return await self._repository.get_document(document_id, user)
        except DocumentNotFoundError as exc:
            raise ApiError(404, "document_not_found", f"Документ {document_id} не найден.") from exc
        except DuplicateDocumentIdError as exc:
            raise ApiError(422, "duplicate_document_id", "Идентификатор документа неоднозначен.") from exc
        except RepositoryUnavailableError as exc:
            raise ApiError(503, exc.code, exc.message) from exc

    async def prepare(
        self, user: UserContext, document_id: str, proposal_id: str | None = None
    ) -> PublicationJobDetail:
        """Create (or reuse) the publication job for the CURRENT revision and run a dry-run."""
        self._ensure_enabled()
        doc = await self._document(user, document_id)
        key = doc.id.lower()
        async with self._lock(key):
            try:
                revision = await self._repository.current_revision(doc.id, user) or doc.revision
            except RepositoryUnavailableError as exc:
                raise ApiError(
                    503, exc.code, f"Не удалось проверить ревизию в GitLab: {exc.message}"
                ) from exc
            active = self._store.active_job(self._project, key)
            if active is not None:
                if active["state"] in ("publishing", "result_unknown"):
                    raise ApiError(
                        409,
                        "publication_in_progress",
                        "Предыдущая публикация не завершена или её результат не подтверждён. Сначала проверьте её.",
                        {"job_id": active["id"]},
                    )
                if active["revision"] == revision:
                    return await self._dry_run_locked(user, active["id"])
                self._store.transition(active["id"], {active["state"]}, "superseded")
                self._store.event(
                    user.user_id, "superseded", active["id"], doc.id, active["revision"], "superseded"
                )
            job_id = uuid.uuid4().hex
            now = _now().isoformat()
            try:
                self._store.insert_job(
                    {
                        "id": job_id,
                        "project_id": self._project,
                        "document_key": key,
                        "document_id": doc.id,
                        "document_path": doc.path,
                        "revision": revision,
                        "proposal_id": proposal_id,
                        "state": "pending",
                        "requested_by": user.user_id,
                        "created_at": now,
                        "updated_at": now,
                    }
                )
            except sqlite3.IntegrityError as exc:
                raise ApiError(
                    409, "publication_in_progress", "Для документа уже есть активное задание публикации."
                ) from exc
            self._store.event(user.user_id, "job_created", job_id, doc.id, revision, "pending")
            logger.info("publication job %s created document=%s", job_id, doc.id)
            return await self._dry_run_locked(user, job_id)

    async def on_document_merged(
        self, user: UserContext, document_id: str, revision: str, proposal_id: str
    ) -> None:
        """Post-merge hook: prepare a job + dry-run. Never publishes by itself (opt-in)."""
        if not self._publisher.enabled:
            return
        try:
            await self.prepare(user, document_id, proposal_id)
        except ApiError as exc:
            logger.warning("publication job after merge not prepared for %s: %s", document_id, exc.code)

    async def dry_run(self, user: UserContext, job_id: str) -> PublicationJobDetail:
        self._ensure_enabled()
        row = self._job_row(job_id)
        async with self._lock(row["document_key"]):
            return await self._dry_run_locked(user, job_id)

    async def _dry_run_locked(self, user: UserContext, job_id: str) -> PublicationJobDetail:
        row = self._job_row(job_id)
        allowed = {"pending", "dry_run_ready", "failed", "conflict"}
        if not self._store.transition(job_id, allowed, "validating"):
            raise ApiError(409, "invalid_transition", "Предпросмотр сейчас недоступен для этого задания.")
        try:
            plan = await self._plan(user, row)
        except Exception:
            self._store.transition(job_id, {"validating"}, "pending")
            raise
        state = self._state_for(plan)
        first = plan.problems[0] if plan.problems else None
        self._store.transition(
            job_id,
            {"validating"},
            state,
            plan_json=plan.model_dump_json(),
            action=plan.action,
            error_code=first.code if first else None,
            error_message=first.message if first else None,
            uncertain=0,
            page_id=plan.target.page_id,
        )
        self._store.event(user.user_id, "dry_run", job_id, row["document_id"], row["revision"], state)
        return self._detail(self._job_row(job_id))

    @staticmethod
    def _state_for(plan: PublicationPlan) -> str:
        if plan.action == "conflict":
            return "conflict"
        return "failed" if plan.problems else "dry_run_ready"

    def _marker(self, doc: DocumentRecord) -> dict[str, Any]:
        return {
            "document_id": doc.id,
            "project_id": self._project,
            "path": doc.path,
            "managed_by": "semantic-knowledge-hub",
        }

    def _marker_matches(self, marker: dict[str, Any] | None, doc: DocumentRecord) -> bool:
        return (
            isinstance(marker, dict)
            and str(marker.get("document_id", "")).lower() == doc.id.lower()
            and str(marker.get("project_id", "")) == self._project
        )

    async def _plan(self, user: UserContext, row: Any) -> PublicationPlan:
        """Everything a publication would do, computed with READ requests only."""
        problems: list[ValidationIssue] = []
        warnings: list[ValidationIssue] = []
        revision = row["revision"]
        doc = await self._document(user, row["document_id"])
        try:
            current = await self._repository.current_revision(doc.id, user)
        except RepositoryUnavailableError as exc:
            raise ApiError(503, exc.code, f"Не удалось проверить ревизию в GitLab: {exc.message}") from exc
        if current != revision:
            problems.append(
                _issue(
                    "error",
                    "revision_superseded",
                    f"Документ в GitLab изменился (ревизия {str(current)[:12]}): подготовьте публикацию заново.",
                )
            )
        elif doc.revision != revision:
            await self._knowledge.refresh()
            doc = await self._document(user, row["document_id"])
        evidence: MergeEvidence | None = None
        if self._evidence is None:
            problems.append(
                _issue("error", "not_merged", "Нет источника подтверждения merge (нужен GitLab).")
            )
        else:
            try:
                found = await self._evidence(revision)
            except RepositoryUnavailableError as exc:
                raise ApiError(503, exc.code, f"Не удалось проверить merge в GitLab: {exc.message}") from exc
            if found is None:
                problems.append(
                    _issue(
                        "error",
                        "not_merged",
                        "GitLab не подтверждает, что эта ревизия попала в основную ветку через merged MR. "
                        "Публикуются только смёрженные изменения.",
                    )
                )
            else:
                evidence = MergeEvidence(
                    iid=found["iid"], url=found.get("url") or None, merged_at=found.get("merged_at") or None
                )
        if doc.status.value not in self._statuses:
            problems.append(
                _issue(
                    "error",
                    "status_not_publishable",
                    f"Статус документа «{doc.status.value}» не допускает публикацию (разрешено: {', '.join(sorted(self._statuses))}).",
                )
            )
        if "confluence_page_id" in doc.extra_metadata:
            warnings.append(
                _issue(
                    "warning",
                    "frontmatter_page_id_ignored",
                    "Поле confluence_page_id в документе игнорируется: страница определяется только привязкой приложения.",
                )
            )
        rendered = render_storage(
            doc.body, title=doc.title, document_id=doc.id, status=doc.status.value, owner=doc.owner
        )
        problems.extend(rendered.errors)
        warnings.extend(rendered.warnings)
        signature = storage_signature(rendered.storage)
        pub = self._publisher
        target = PublicationTarget(
            space_key=pub.space_key, parent_id=pub.parent_id, page_id=None, title=doc.title, url=None
        )
        action: Literal["create", "update", "noop", "conflict"] = "create"
        diff_kind: Literal["new_page", "page_update", "manual_edit", "none"] = "new_page"
        diff = _diff("", rendered.storage, "/dev/null", "new-page")
        remote_version: int | None = None
        try:
            if await pub.read_space() is None:
                problems.append(
                    _issue(
                        "error", "space_not_found", f"Пространство {pub.space_key} не найдено или недоступно."
                    )
                )
            parent = await pub.read_page(pub.parent_id)
            if parent is None or (parent.get("space") or {}).get("key") != pub.space_key:
                problems.append(
                    _issue(
                        "error",
                        "parent_not_found",
                        f"Родительская страница {pub.parent_id} не найдена в {pub.space_key}.",
                    )
                )
            mapping = self._store.mapping(self._project, doc.id.lower())
            page: dict[str, Any] | None = None
            if mapping is not None:
                target.page_id = mapping["page_id"]
                page = await pub.read_page(mapping["page_id"])
                if page is None:
                    action = "conflict"
                    problems.append(
                        _issue(
                            "error",
                            "mapped_page_missing",
                            f"Опубликованная ранее страница {mapping['page_id']} не найдена (удалена или перемещена вручную).",
                        )
                    )
            else:
                for candidate in await pub.find_pages(doc.title):
                    page = candidate
                    target.page_id = str(candidate.get("id"))
                    break
            if page is not None:
                page_id = str(page.get("id"))
                target.page_id = page_id
                target.url = pub.page_url(page_id)
                remote_version = int((page.get("version") or {}).get("number") or 0)
                remote_storage = str(((page.get("body") or {}).get("storage") or {}).get("value", ""))
                marker = await pub.read_marker(page_id)
                if not self._marker_matches(marker, doc):
                    action = "conflict"
                    code = "title_taken" if mapping is None else "foreign_page"
                    problems.append(
                        _issue(
                            "error",
                            code,
                            f"Страница «{page.get('title')}» ({page_id}) не принадлежит этому документу (нет метки "
                            "приложения). Она не будет изменена."
                            if mapping is not None
                            else f"В пространстве уже есть страница «{doc.title}», созданная не приложением. "
                            "Переименуйте документ или страницу.",
                        )
                    )
                elif (page.get("space") or {}).get("key") != pub.space_key:
                    action = "conflict"
                    problems.append(
                        _issue("error", "page_moved", "Страница перенесена в другое пространство вручную.")
                    )
                elif (
                    mapping is not None
                    and remote_version != mapping["page_version"]
                    and (
                        storage_signature(remote_storage) != mapping["published_signature"]
                        or page.get("title") != mapping["page_title"]
                    )
                ):
                    action, diff_kind = "conflict", "manual_edit"
                    diff = _diff(
                        mapping["published_storage"],
                        remote_storage,
                        "published-by-app",
                        "current-in-confluence",
                    )
                    problems.append(
                        _issue(
                            "error",
                            "manual_edit",
                            f"Страница изменена в Confluence вручную (версия {mapping['page_version']} → {remote_version}). "
                            "Автоматическая перезапись запрещена: перенесите правку в GitLab или подтвердите её учёт.",
                        )
                    )
                else:
                    if mapping is None:
                        warnings.append(
                            _issue(
                                "warning",
                                "managed_page_found",
                                "Найдена страница этого документа с меткой приложения (например, после потерянного "
                                "ответа): она будет использована, дубликат не создаётся.",
                            )
                        )
                    elif remote_version != mapping["page_version"]:
                        warnings.append(
                            _issue(
                                "warning",
                                "version_changed",
                                "Версия страницы изменилась без изменения содержимого.",
                            )
                        )
                    if storage_signature(remote_storage) == signature and page.get("title") == doc.title:
                        action, diff_kind, diff = "noop", "none", ""
                    else:
                        action, diff_kind = "update", "page_update"
                        diff = _diff(
                            remote_storage, rendered.storage, "current-in-confluence", "new-revision"
                        )
        except PublicationError as exc:
            raise ApiError(502 if exc.retryable else 503, exc.code, exc.message) from exc
        return PublicationPlan(
            action=action,
            revision=revision,
            target=target,
            storage=rendered.storage,
            diff=diff,
            diff_kind=diff_kind,
            warnings=warnings,
            problems=problems,
            remote_version=remote_version,
            rendered_hash=signature,
            merge_request=evidence,
            checked_at=_now(),
        )

    async def publish(self, user: UserContext, job_id: str) -> PublicationJobDetail:
        """Write the previewed change. Re-checks the remote state first; never writes on a stale preview."""
        self._ensure_enabled()
        if not self._publisher.write_enabled:
            raise ApiError(
                503,
                "publish_disabled",
                "Запись в Confluence выключена (CONFLUENCE_PUBLISH_ENABLED=false): доступен только предпросмотр.",
            )
        row = self._job_row(job_id)
        async with self._lock(row["document_key"]):
            row = self._job_row(job_id)
            if row["state"] != "dry_run_ready":
                raise ApiError(
                    409, "invalid_transition", "Опубликовать можно только задание с готовым предпросмотром."
                )
            stored = self._plan_of(row)
            fresh = await self._plan(user, row)
            if (
                stored is None
                or fresh.problems
                or (fresh.action, fresh.remote_version, fresh.rendered_hash)
                != (
                    stored.action,
                    stored.remote_version,
                    stored.rendered_hash,
                )
            ):
                state = self._state_for(fresh)
                first = fresh.problems[0] if fresh.problems else None
                self._store.transition(
                    job_id,
                    {"dry_run_ready"},
                    state,
                    plan_json=fresh.model_dump_json(),
                    action=fresh.action,
                    error_code=first.code if first else None,
                    error_message=first.message if first else None,
                )
                self._store.event(
                    user.user_id, "plan_changed", job_id, row["document_id"], row["revision"], state
                )
                raise ApiError(
                    409,
                    "plan_changed",
                    "Состояние Confluence или документа изменилось после предпросмотра. Проверьте обновлённый предпросмотр.",
                    {"state": state},
                )
            if not self._store.transition(
                job_id,
                {"dry_run_ready"},
                "publishing",
                attempts=(row["attempts"] or 0) + 1,
                version_before=fresh.remote_version,
            ):
                raise ApiError(409, "publication_in_progress", "Публикация уже выполняется.")
            self._store.event(
                user.user_id, "publish_started", job_id, row["document_id"], row["revision"], "publishing"
            )
            return await self._execute(user, job_id, fresh)

    async def _execute(self, user: UserContext, job_id: str, plan: PublicationPlan) -> PublicationJobDetail:
        row = self._job_row(job_id)
        doc = await self._document(user, row["document_id"])
        pub = self._publisher
        try:
            if plan.action == "noop":
                return self._finalize_noop(user, row, doc, plan)
            if plan.action == "create":
                created = await pub.create_page(doc.title, plan.storage, self._marker(doc))
                page_id = str(created.get("id"))
                if not self._marker_matches(await pub.read_marker(page_id), doc):
                    await pub.write_marker(page_id, self._marker(doc))
            else:
                assert plan.target.page_id is not None and plan.remote_version is not None
                page_id = plan.target.page_id
                await pub.update_page(page_id, doc.title, plan.storage, plan.remote_version + 1)
            page = await pub.read_page(page_id)
            if page is None:
                raise PublicationError(
                    "confluence_invalid_response", "Страница не читается после записи.", uncertain=True
                )
            return self._finalize(user, row, doc, plan, page)
        except PublicationError as exc:
            return await self._after_write_error(user, row, doc, plan, exc)

    async def _after_write_error(
        self, user: UserContext, row: Any, doc: DocumentRecord, plan: PublicationPlan, exc: PublicationError
    ) -> PublicationJobDetail:
        job_id = row["id"]
        if exc.code == "confluence_version_conflict":
            self._store.transition(
                job_id,
                {"publishing"},
                "conflict",
                error_code=exc.code,
                error_message="Страница изменилась в Confluence во время публикации. Ничего не перезаписано.",
            )
            self._store.event(user.user_id, "conflict", job_id, doc.id, row["revision"], "conflict")
            return self._detail(self._job_row(job_id))
        if exc.uncertain:
            outcome, page = await self._inspect(doc, plan)
            if outcome == "applied" and page is not None:
                self._store.event(
                    user.user_id, "write_confirmed_after_lost_answer", job_id, doc.id, row["revision"], None
                )
                return self._finalize(user, row, doc, plan, page)
            if outcome == "unknown":
                self._store.transition(
                    job_id,
                    {"publishing"},
                    "result_unknown",
                    uncertain=1,
                    error_code="confluence_write_uncertain",
                    error_message=(
                        "Confluence не подтвердил запись, и проверить результат не удалось. Повтор без проверки "
                        "запрещён: нажмите «Проверить результат»."
                    ),
                )
                self._store.event(
                    user.user_id, "result_unknown", job_id, doc.id, row["revision"], "result_unknown"
                )
                return self._detail(self._job_row(job_id))
            message = (
                f"{exc.message} Проверка показала, что страница не изменена; публикацию можно повторить."
            )
        else:
            message = exc.message
        self._store.transition(
            job_id, {"publishing"}, "failed", error_code=exc.code, error_message=message[:500], uncertain=0
        )
        self._store.event(user.user_id, "publish_failed", job_id, doc.id, row["revision"], "failed")
        logger.warning("publication job %s failed: %s", job_id, exc.code)
        return self._detail(self._job_row(job_id))

    async def _inspect(
        self, doc: DocumentRecord, plan: PublicationPlan
    ) -> tuple[Applied, dict[str, Any] | None]:
        """Read-only evidence of whether a write with a lost answer was applied."""
        pub = self._publisher
        try:
            if plan.action == "create":
                for page in await pub.find_pages(doc.title):
                    if self._marker_matches(await pub.read_marker(str(page.get("id"))), doc):
                        full = await pub.read_page(str(page.get("id")))
                        return ("applied", full) if full is not None else ("unknown", None)
                return "not_applied", None
            assert plan.target.page_id is not None
            current = await pub.read_page(plan.target.page_id)
            if current is None:
                return "unknown", None
            version = int((current.get("version") or {}).get("number") or 0)
            storage = str(((current.get("body") or {}).get("storage") or {}).get("value", ""))
            if version == plan.remote_version:
                return "not_applied", None
            if version == (plan.remote_version or 0) + 1 and storage_signature(storage) == plan.rendered_hash:
                return "applied", current
            return "unknown", None
        except PublicationError:
            return "unknown", None

    def _finalize(
        self, user: UserContext, row: Any, doc: DocumentRecord, plan: PublicationPlan, page: dict[str, Any]
    ) -> PublicationJobDetail:
        now = _now().isoformat()
        page_id = str(page.get("id"))
        version = int((page.get("version") or {}).get("number") or 0)
        storage = str(((page.get("body") or {}).get("storage") or {}).get("value", ""))
        self._store.upsert_mapping(
            {
                "project_id": self._project,
                "document_key": doc.id.lower(),
                "document_id": doc.id,
                "document_path": doc.path,
                "page_id": page_id,
                "space_key": self._publisher.space_key,
                "parent_id": self._publisher.parent_id,
                "page_title": str(page.get("title") or doc.title),
                "page_version": version,
                "published_revision": row["revision"],
                "published_signature": storage_signature(storage),
                "published_storage": storage,
                "rendered_signature": plan.rendered_hash,
                "last_published_at": now,
                "updated_at": now,
            }
        )
        self._store.transition(
            row["id"],
            {"publishing"},
            "published",
            page_id=page_id,
            version_after=version,
            published_at=now,
            error_code=None,
            error_message=None,
            uncertain=0,
        )
        self._store.event(
            user.user_id, f"published_{plan.action}", row["id"], doc.id, row["revision"], "published"
        )
        logger.info(
            "publication job %s published action=%s page=%s version=%d",
            row["id"],
            plan.action,
            page_id,
            version,
        )
        return self._detail(self._job_row(row["id"]))

    def _finalize_noop(
        self, user: UserContext, row: Any, doc: DocumentRecord, plan: PublicationPlan
    ) -> PublicationJobDetail:
        mapping = self._store.mapping(self._project, doc.id.lower())
        now = _now().isoformat()
        if mapping is not None:
            values = dict(mapping)
            values.update(published_revision=row["revision"], updated_at=now)
            self._store.upsert_mapping(values)
        self._store.transition(
            row["id"],
            {"publishing"},
            "published",
            page_id=plan.target.page_id,
            version_after=plan.remote_version,
            published_at=now,
            error_code=None,
            error_message=None,
        )
        self._store.event(user.user_id, "published_noop", row["id"], doc.id, row["revision"], "published")
        return self._detail(self._job_row(row["id"]))

    async def reconcile(self, user: UserContext, job_id: str) -> PublicationJobDetail:
        """«Проверить результат / повторить»: inspect Confluence before anything else.
        result_unknown → published (write confirmed) or a fresh dry-run; failed/conflict → a fresh dry-run."""
        self._ensure_enabled()
        row = self._job_row(job_id)
        async with self._lock(row["document_key"]):
            row = self._job_row(job_id)
            if row["state"] == "result_unknown":
                plan = self._plan_of(row)
                doc = await self._document(user, row["document_id"])
                if plan is not None:
                    outcome, page = await self._inspect(doc, plan)
                    if outcome == "applied" and page is not None:
                        self._store.transition(job_id, {"result_unknown"}, "publishing")
                        self._store.event(
                            user.user_id, "write_confirmed_on_check", job_id, doc.id, row["revision"], None
                        )
                        return self._finalize(user, self._job_row(job_id), doc, plan, page)
                    if outcome == "unknown":
                        raise ApiError(
                            502,
                            "confluence_write_uncertain",
                            "Проверить результат в Confluence пока не удалось. Повторите проверку позже.",
                        )
                self._store.transition(job_id, {"result_unknown"}, "failed", uncertain=0)
            elif row["state"] not in ("failed", "conflict"):
                raise ApiError(409, "invalid_transition", "Проверка не требуется для этого задания.")
            return await self._dry_run_locked(user, job_id)

    async def acknowledge_manual_edit(self, user: UserContext, job_id: str) -> PublicationJobDetail:
        """Explicit human decision after reviewing the manual-edit diff: take the current page version as
        the new baseline. The next dry-run then shows exactly what publishing would replace."""
        self._ensure_enabled()
        row = self._job_row(job_id)
        async with self._lock(row["document_key"]):
            row = self._job_row(job_id)
            plan = self._plan_of(row)
            if (
                row["state"] != "conflict"
                or plan is None
                or plan.diff_kind != "manual_edit"
                or not plan.target.page_id
            ):
                raise ApiError(
                    409, "invalid_transition", "Подтверждение доступно только для конфликта ручной правки."
                )
            mapping = self._store.mapping(self._project, row["document_key"])
            page = await self._publisher.read_page(plan.target.page_id)
            if mapping is None or page is None:
                raise ApiError(409, "invalid_transition", "Страница или привязка не найдены.")
            storage = str(((page.get("body") or {}).get("storage") or {}).get("value", ""))
            values = dict(mapping)
            values.update(
                page_version=int((page.get("version") or {}).get("number") or 0),
                page_title=str(page.get("title") or mapping["page_title"]),
                published_signature=storage_signature(storage),
                published_storage=storage,
                updated_at=_now().isoformat(),
            )
            self._store.upsert_mapping(values)
            self._store.event(
                user.user_id, "manual_edit_acknowledged", job_id, row["document_id"], row["revision"], None
            )
            return await self._dry_run_locked(user, job_id)

    def _snapshot_marker_json(self, doc: DocumentRecord) -> str:  # for diagnostics/tests
        return json.dumps(self._marker(doc), ensure_ascii=False)
