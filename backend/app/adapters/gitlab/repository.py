"""GitLabKnowledgeRepository: read-only access to the team's canonical knowledge in GitLab.

Revision = the file's `last_commit_id` as GitLab reports it (never a local timestamp), so proposals
can be checked against the commit they were based on. Writes never happen here (see GitLabMRPublisher).

Synchronisation (docs/GITLAB_KNOWLEDGE_WORKFLOW.md §Синхронизация):
- cheap probe: the head commit of the knowledge branch; unchanged head → nothing to do;
- otherwise the tree is walked and only files whose blob id changed are read again; files that
  disappeared from the tree disappear from the snapshot (and therefore from the search index);
- a file that cannot be re-read keeps its last successfully read version and is flagged stale;
- if GitLab is unreachable, the last snapshot is served and flagged stale; on 401/403/404 the cache
  is dropped instead (access may have been revoked — fail closed).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import httpx

from app.adapters.gitlab.client import GitLabClient, GitLabError, json_body
from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeSnapshot,
    RepositoryUnavailableError,
    RevisionNotAvailableError,
    SyncInfo,
    lookup,
)
from app.adapters.knowledge.records import assemble_snapshot, build_record
from app.domain.models import (
    DocumentRecord,
    IntegrationStatus,
    LoadIssue,
    SourceType,
    SyncState,
    UserContext,
)

logger = logging.getLogger("skh.gitlab.repository")

PER_PAGE = 100  # GitLab maximum for per_page
MAX_PARALLEL_READS = 8
MAX_TREE_PAGES = 500
COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")
# Access problems: cached content must not outlive a revoked permission.
FAIL_CLOSED_CODES = frozenset({"gitlab_auth_failed", "gitlab_forbidden", "gitlab_not_found"})


def _next_page_token(response: httpx.Response) -> str | None:
    """`page_token` of the `Link: <…>; rel="next"` header. The URL itself is never followed: only the
    opaque token is reused against the configured host."""
    link = response.links.get("next", {}).get("url") if response.headers.get("link") else None
    if not link:
        return None
    values = parse_qs(urlsplit(link).query).get("page_token")
    return values[0] if values else None


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


@dataclass
class _CachedFile:
    blob_id: str
    record: DocumentRecord | None
    issues: list[LoadIssue] = field(default_factory=list)


class GitLabKnowledgeRepository:
    source: SourceType = "gitlab"

    def __init__(
        self,
        client: GitLabClient,
        *,
        project_id: str,
        branch: str,
        knowledge_path: str = "",
        max_document_bytes: int = 512 * 1024,
        max_files: int = 2000,
        refresh_seconds: float = 60.0,
    ) -> None:
        self._client = client
        self._project_id = project_id
        self._branch = branch
        self._prefix = knowledge_path.strip("/")
        self._max_bytes = max_document_bytes
        self._max_files = max_files
        self._refresh_seconds = refresh_seconds
        self._snapshot: KnowledgeSnapshot | None = None
        self._tree_version: str | None = None
        self._head: str | None = None
        self._files: dict[str, _CachedFile] = {}
        self._failed_paths: tuple[str, ...] = ()
        self._commit_dates: dict[str, datetime | None] = {}
        self._project_web_url: str | None = None
        self._project_name: str | None = None
        self._checked_at = 0.0
        self._last_attempt: datetime | None = None
        self._last_success: datetime | None = None
        self._last_error: GitLabError | None = None
        self._lock = asyncio.Lock()

    @property
    def client(self) -> GitLabClient:
        return self._client

    @property
    def branch(self) -> str:
        return self._branch

    @property
    def knowledge_path(self) -> str:
        return self._prefix

    def source_uri(self, path: str) -> str:
        return f"gitlab://{self._project_id}/{path}@{self._branch}"

    def web_url(self, path: str, revision: str) -> str | None:
        """Link to the exact revision of a file, only on the configured GitLab host."""
        if not self._project_web_url or not COMMIT_SHA_RE.fullmatch(revision or ""):
            return None
        return f"{self._project_web_url}/-/blob/{revision}/{quote(path, safe='/')}"

    def merge_request_web_url_ok(self, url: Any) -> str | None:
        """Accept a GitLab-provided URL only if it points to the configured host and scheme."""
        if not isinstance(url, str):
            return None
        parts, base = urlsplit(url), urlsplit(self._client.base_url)
        if parts.scheme != base.scheme or (parts.hostname or "").lower() != self._client.host.lower():
            return None
        if parts.username or parts.password or parts.port != base.port:
            return None
        return url

    # --- GitLab reads --------------------------------------------------------------------------
    async def _branch_head(self) -> str | None:
        response = await self._client.request(
            "GET", self._client.project_path(f"/repository/branches/{quote(self._branch, safe='')}")
        )
        payload = json_body(response)
        commit = payload.get("commit") if isinstance(payload, dict) else None
        head = commit.get("id") if isinstance(commit, dict) else None
        return str(head) if isinstance(head, str) and COMMIT_SHA_RE.fullmatch(head) else None

    async def _load_project(self) -> None:
        response = await self._client.request("GET", self._client.project_path())
        payload = json_body(response)
        if not isinstance(payload, dict):
            return
        name = payload.get("path_with_namespace") or payload.get("name")
        self._project_name = str(name)[:200] if name else None
        web_url = self.merge_request_web_url_ok(payload.get("web_url"))
        self._project_web_url = web_url.rstrip("/") if web_url else None

    async def _list_markdown_files(self) -> list[dict[str, Any]]:
        """Walk the repository tree. Uses keyset pagination (recommended by GitLab for the tree
        endpoint: `pagination=keyset`, next page via the `Link` header's `page_token`) and falls back
        to offset pagination (`X-Next-Page`) for instances that ignore keyset."""
        entries: list[dict[str, Any]] = []
        page_token: str | None = None
        page: int | None = None
        for _ in range(MAX_TREE_PAGES):
            params: dict[str, Any] = {"ref": self._branch, "recursive": "true", "per_page": PER_PAGE}
            if self._prefix:
                params["path"] = self._prefix
            if page is not None:
                params["page"] = page
            else:
                params["pagination"] = "keyset"
                if page_token:
                    params["page_token"] = page_token
            response = await self._client.request(
                "GET", self._client.project_path("/repository/tree"), params=params
            )
            batch = json_body(response)
            if not isinstance(batch, list):
                raise GitLabError(
                    "gitlab_invalid_response", "GitLab вернул неожиданный ответ для дерева файлов."
                )
            for item in batch:
                if (
                    isinstance(item, dict)
                    and item.get("type") == "blob"
                    and isinstance(item.get("path"), str)
                    and item["path"].lower().endswith(".md")
                ):
                    entries.append(item)
            if len(entries) >= self._max_files:
                break
            next_token = _next_page_token(response)
            next_offset = response.headers.get("X-Next-Page", "")
            if next_token and page is None:
                page_token = next_token
            elif next_offset.isdigit():
                page = int(next_offset)
            else:
                break
        return sorted(entries[: self._max_files], key=lambda e: str(e["path"]))

    async def _read_file(self, path: str, ref: str, issues: list[LoadIssue]) -> DocumentRecord | None:
        """Read and parse one file at `ref`. HTTP failures raise GitLabError; content problems are
        reported as issues (the file is then not shown)."""
        response = await self._client.request(
            "GET",
            self._client.project_path(f"/repository/files/{quote(path, safe='')}"),
            params={"ref": ref},
        )
        payload = json_body(response)
        if not isinstance(payload, dict):
            issues.append(
                LoadIssue(path=path, code="invalid_response", message="GitLab вернул неожиданный ответ.")
            )
            return None
        try:
            size = int(payload.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        if size > self._max_bytes:
            issues.append(
                LoadIssue(path=path, code="file_too_large", message="Файл превышает допустимый размер.")
            )
            return None
        if payload.get("encoding") != "base64":
            issues.append(
                LoadIssue(
                    path=path, code="unsupported_encoding", message="Неожиданная кодировка файла GitLab."
                )
            )
            return None
        try:
            data = base64.b64decode(str(payload.get("content", "")), validate=True)
        except (binascii.Error, ValueError):
            issues.append(
                LoadIssue(path=path, code="invalid_content", message="Не удалось декодировать файл GitLab.")
            )
            return None
        if len(data) > self._max_bytes:
            issues.append(
                LoadIssue(path=path, code="file_too_large", message="Файл превышает допустимый размер.")
            )
            return None
        revision = str(payload.get("last_commit_id") or "")
        if not COMMIT_SHA_RE.fullmatch(revision):
            issues.append(
                LoadIssue(
                    path=path,
                    code="missing_revision",
                    message="GitLab не сообщил ревизию (last_commit_id) файла; документ не показан.",
                )
            )
            return None
        return build_record(
            data,
            path=path,
            source=self.source,
            source_uri_for=self.source_uri(path),
            revision=revision,
            updated_at=None,
            is_demo=False,
            issues=issues,
        )

    async def _commit_date(self, sha: str) -> datetime | None:
        if sha in self._commit_dates:
            return self._commit_dates[sha]
        try:
            response = await self._client.request(
                "GET",
                self._client.project_path(f"/repository/commits/{sha}"),
                allowed_statuses=frozenset({404}),
            )
        except GitLabError:
            return None  # unknown date is shown as unknown; retried on the next sync
        date = None
        if response.status_code == 200:
            payload = json_body(response)
            if isinstance(payload, dict):
                date = _parse_time(payload.get("committed_date"))
        self._commit_dates[sha] = date  # commits are immutable: cache forever
        return date

    async def _with_dates(self, records: list[DocumentRecord]) -> list[DocumentRecord]:
        semaphore = asyncio.Semaphore(MAX_PARALLEL_READS)

        async def date_for(sha: str) -> tuple[str, datetime | None]:
            async with semaphore:
                return sha, await self._commit_date(sha)

        dates = dict(await asyncio.gather(*(date_for(s) for s in {r.revision for r in records})))
        return [
            r.model_copy(
                update={"updated_at": dates.get(r.revision), "web_url": self.web_url(r.path, r.revision)}
            )
            for r in records
        ]

    # --- synchronisation -----------------------------------------------------------------------
    def _on_failure(self, exc: GitLabError) -> KnowledgeSnapshot:
        self._last_error = exc
        if exc.code in FAIL_CLOSED_CODES:
            self._snapshot, self._tree_version, self._head = None, None, None
            self._files.clear()
            raise RepositoryUnavailableError(exc.code, exc.message)
        if self._snapshot is None:
            raise RepositoryUnavailableError(exc.code, exc.message)
        logger.warning("gitlab sync failed (%s); serving the last synchronised snapshot", exc.code)
        return self._snapshot

    async def _refresh(self, *, full: bool = False) -> KnowledgeSnapshot:
        self._last_attempt = datetime.now(UTC)
        try:
            head = await self._branch_head()
        except GitLabError as exc:
            return self._on_failure(exc)
        if not full and self._snapshot is not None and head and head == self._head and not self._failed_paths:
            self._mark_success()
            return self._snapshot
        try:
            if self._project_web_url is None:
                await self._load_project()
            entries = await self._list_markdown_files()
        except GitLabError as exc:
            return self._on_failure(exc)
        if full:
            self._files.clear()
        tree_version = hashlib.sha256(
            "\n".join(f"{e['path']}|{e.get('id', '')}" for e in entries).encode()
        ).hexdigest()[:24]
        if (
            not full
            and self._snapshot is not None
            and tree_version == self._tree_version
            and not self._failed_paths
        ):
            self._head = head  # commits outside the knowledge path: nothing to re-read
            self._mark_success()
            return self._snapshot

        wanted = {str(e["path"]): str(e.get("id") or "") for e in entries}
        for removed in set(self._files) - set(wanted):
            del self._files[removed]
        to_read = [
            p
            for p, blob in wanted.items()
            if not blob or self._files.get(p, _CachedFile("", None)).blob_id != blob
        ]
        failed: list[str] = []
        semaphore = asyncio.Semaphore(MAX_PARALLEL_READS)

        async def read(path: str) -> None:
            async with semaphore:
                issues: list[LoadIssue] = []
                try:
                    record = await self._read_file(path, self._branch, issues)
                except GitLabError as exc:
                    if exc.code in ("gitlab_auth_failed", "gitlab_forbidden"):
                        raise
                    if exc.status == 404:  # deleted between the tree listing and the read
                        self._files.pop(path, None)
                        return
                    failed.append(path)
                    return
                self._files[path] = _CachedFile(wanted[path], record, issues)

        try:
            await asyncio.gather(*(read(p) for p in to_read))
        except GitLabError as exc:
            return self._on_failure(exc)

        issues: list[LoadIssue] = []
        records: list[DocumentRecord] = []
        stale_paths = set(failed)
        for path in sorted(wanted):
            cached = self._files.get(path)
            if cached is None:
                continue
            issues.extend(cached.issues)
            if cached.record is not None:
                records.append(cached.record)
        for path in sorted(failed):
            issues.append(
                LoadIssue(
                    path=path,
                    code="sync_failed",
                    message=(
                        "Не удалось обновить файл из GitLab; показана последняя успешно прочитанная версия."
                        if path in self._files
                        else "Не удалось прочитать файл из GitLab; документ временно не показан."
                    ),
                )
            )
        records = await self._with_dates(records)
        version = hashlib.sha256(
            "\n".join(
                f"{r.path}|{r.revision}|{r.updated_at}|{r.path in stale_paths}"
                for r in sorted(records, key=lambda r: r.path)
            ).encode()
        ).hexdigest()[:24]
        snapshot = assemble_snapshot(records, version, issues)
        stale_ids = frozenset(r.id.lower() for r in records if r.path in stale_paths)
        snapshot = KnowledgeSnapshot(
            version=snapshot.version,
            documents=snapshot.documents,
            issues=snapshot.issues,
            duplicates=snapshot.duplicates,
            stale_ids=stale_ids,
        )
        self._snapshot, self._tree_version, self._head = snapshot, tree_version, head
        self._failed_paths = tuple(sorted(failed))
        if failed:
            self._last_error = GitLabError(
                "gitlab_partial_sync", f"Не удалось обновить файлов: {len(failed)}."
            )
        else:
            self._mark_success()
        logger.info(
            "gitlab snapshot synced: %d document(s), %d re-read, %d failed, %d issue(s)",
            len(snapshot.documents),
            len(to_read),
            len(failed),
            len(issues),
        )
        return snapshot

    def _mark_success(self) -> None:
        self._last_success = self._last_attempt
        self._last_error = None

    # --- KnowledgeRepository -------------------------------------------------------------------
    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        # MVP: one service identity in a single-user test contour. Multiuser deployments need
        # per-user GitLab authorization first (docs/SSO_RBAC_REQUIREMENTS.md).
        if self._snapshot is not None and time.monotonic() - self._checked_at < self._refresh_seconds:
            return self._snapshot
        async with self._lock:
            if self._snapshot is not None and time.monotonic() - self._checked_at < self._refresh_seconds:
                return self._snapshot
            snapshot = await self._refresh()
            self._checked_at = time.monotonic()
            return snapshot

    async def refresh(self, *, full: bool = False) -> KnowledgeSnapshot:
        async with self._lock:
            snapshot = await self._refresh(full=full)
            self._checked_at = time.monotonic()
            return snapshot

    async def get_document(self, document_id: str, user: UserContext) -> DocumentRecord:
        return lookup(await self.snapshot(user), document_id)

    async def exists(self, document_id: str, user: UserContext) -> bool:
        try:
            await self.get_document(document_id, user)
        except (DocumentNotFoundError, DuplicateDocumentIdError):
            return False
        return True

    async def get_document_at_revision(
        self, document_id: str, revision: str, user: UserContext
    ) -> DocumentRecord:
        current = await self.get_document(document_id, user)
        if revision == current.revision:
            return current
        if not COMMIT_SHA_RE.fullmatch(revision):
            raise RevisionNotAvailableError(document_id, revision, "Некорректная ревизия GitLab.")
        issues: list[LoadIssue] = []
        try:
            record = await self._read_file(current.path, revision, issues)
        except GitLabError as exc:
            if exc.status == 404:
                raise RevisionNotAvailableError(
                    document_id, revision, "Ревизия не найдена в GitLab по текущему пути документа."
                ) from exc
            raise RepositoryUnavailableError(exc.code, exc.message) from exc
        if record is None or record.id.lower() != document_id.lower():
            raise RevisionNotAvailableError(
                document_id, revision, "В этой ревизии файл не является корректным документом."
            )
        return (await self._with_dates([record]))[0]

    async def current_file_revision(self, path: str) -> str | None:
        """Fresh `last_commit_id` of a file on the knowledge branch (bypasses the snapshot cache)."""
        try:
            response = await self._client.request(
                "GET",
                self._client.project_path(f"/repository/files/{quote(path, safe='')}"),
                params={"ref": self._branch},
                allowed_statuses=frozenset({404}),
            )
        except GitLabError as exc:
            raise RepositoryUnavailableError(exc.code, exc.message) from exc
        if response.status_code == 404:
            return None
        payload = json_body(response)
        value = str(payload.get("last_commit_id") or "") if isinstance(payload, dict) else ""
        return value or None

    async def file_exists(self, path: str) -> bool:
        return await self.current_file_revision(path) is not None

    async def current_revision(self, document_id: str, user: UserContext) -> str | None:
        try:
            record = await self.get_document(document_id, user)
        except (DocumentNotFoundError, DuplicateDocumentIdError):
            return None
        revision = await self.current_file_revision(record.path)
        if revision != record.revision:
            self._checked_at = 0.0  # the snapshot is behind GitLab: re-sync on the next read
        return revision

    def sync_info(self) -> SyncInfo:
        def info(state: SyncState, message: str) -> SyncInfo:
            return SyncInfo(
                state=state,
                message=message,
                last_attempt_at=self._last_attempt,
                last_success_at=self._last_success,
                failed_paths=self._failed_paths,
                branch=self._branch,
                head_commit=self._head,
            )

        if self._snapshot is None:
            if self._last_error is not None:
                return info("error", f"GitLab недоступен: {self._last_error.message}")
            return info("never_synced", "Синхронизация с GitLab ещё не выполнялась.")
        if self._failed_paths:
            return info(
                "stale",
                f"Частичная синхронизация: не удалось обновить файлов — {len(self._failed_paths)}. "
                "Для них показана последняя успешно прочитанная версия.",
            )
        if self._last_error is not None:
            return info(
                "stale",
                f"GitLab сейчас недоступен ({self._last_error.message}). Показаны документы последней "
                "успешной синхронизации — они могут быть устаревшими.",
            )
        return info("fresh", f"Синхронизировано с веткой {self._branch}.")

    async def status(self) -> IntegrationStatus:
        base = {
            "name": "gitlab_knowledge",
            "title": "GitLab (каноническая база знаний)",
            "kind": "knowledge_repository",
        }
        details = {"host": self._client.host, "branch": self._branch}
        try:
            # The project endpoint may answer without authentication for public projects, so the
            # knowledge branch is probed too: it proves the token can read this repository.
            await self._load_project()
            await self._client.request(
                "GET", self._client.project_path(f"/repository/branches/{quote(self._branch, safe='')}")
            )
        except GitLabError as exc:
            return IntegrationStatus(
                **base,
                state="error",
                capabilities=[],
                details=details,
                human_readable_message=f"GitLab настроен, но проверка не прошла: {exc.message}",
            )
        count = len(self._snapshot.documents) if self._snapshot else 0
        if self._project_name:
            details["project"] = self._project_name
        return IntegrationStatus(
            **base,
            state="connected",
            capabilities=["read", "list", "revision:commit-sha", "history:read", "incremental-sync"],
            details={**details, "documents": str(count)},
            human_readable_message=(
                f"Подключено (проверка проекта {self._project_name or self._project_id} прошла), "
                f"ветка {self._branch}, документов: {count}."
            ),
        )
