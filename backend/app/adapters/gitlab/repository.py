"""GitLabKnowledgeRepository: read-only access to the team's canonical knowledge in GitLab.

Revision = the file's `last_commit_id`, so proposals can be checked against the commit they
were based on. Writes never happen here (see GitLabMRPublisher).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import logging
import time
from typing import Any
from urllib.parse import quote

from app.adapters.gitlab.client import GitLabClient, GitLabError
from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeSnapshot,
    RepositoryUnavailableError,
)
from app.adapters.knowledge.records import assemble_snapshot, build_record
from app.domain.models import DocumentRecord, IntegrationStatus, LoadIssue, SourceType, UserContext
from app.domain.schema import is_valid_document_id

logger = logging.getLogger("skh.gitlab.repository")

PER_PAGE = 100
MAX_PARALLEL_READS = 8


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
        self._checked_at = 0.0
        self._lock = asyncio.Lock()

    @property
    def client(self) -> GitLabClient:
        return self._client

    @property
    def branch(self) -> str:
        return self._branch

    def source_uri(self, path: str) -> str:
        return f"gitlab://{self._project_id}/{path}@{self._branch}"

    async def _list_markdown_files(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        page = 1
        while True:
            params: dict[str, Any] = {
                "ref": self._branch,
                "recursive": "true",
                "per_page": PER_PAGE,
                "page": page,
            }
            if self._prefix:
                params["path"] = self._prefix
            response = await self._client.request(
                "GET", self._client.project_path("/repository/tree"), params=params
            )
            batch = response.json()
            if not isinstance(batch, list):
                raise GitLabError(
                    "gitlab_invalid_response", "GitLab вернул неожиданный ответ для дерева файлов."
                )
            for item in batch:
                if (
                    isinstance(item, dict)
                    and item.get("type") == "blob"
                    and str(item.get("path", "")).lower().endswith(".md")
                ):
                    entries.append(item)
            next_page = response.headers.get("X-Next-Page", "")
            if not next_page or len(entries) >= self._max_files:
                break
            page = int(next_page)
        return sorted(entries[: self._max_files], key=lambda e: str(e["path"]))

    async def _read_file(self, path: str, issues: list[LoadIssue]) -> DocumentRecord | None:
        response = await self._client.request(
            "GET",
            self._client.project_path(f"/repository/files/{quote(path, safe='')}"),
            params={"ref": self._branch},
        )
        payload = response.json()
        size = int(payload.get("size") or 0)
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
        revision = str(payload.get("last_commit_id") or payload.get("commit_id") or "")
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

    async def _refresh(self) -> KnowledgeSnapshot:
        try:
            entries = await self._list_markdown_files()
            tree_version = hashlib.sha256(
                "\n".join(f"{e['path']}|{e.get('id', '')}" for e in entries).encode()
            ).hexdigest()[:24]
            if self._snapshot is not None and tree_version == self._tree_version:
                return self._snapshot
            issues: list[LoadIssue] = []
            semaphore = asyncio.Semaphore(MAX_PARALLEL_READS)

            async def read(entry: dict[str, Any]) -> DocumentRecord | None:
                async with semaphore:
                    return await self._read_file(str(entry["path"]), issues)

            records = [r for r in await asyncio.gather(*(read(e) for e in entries)) if r is not None]
        except GitLabError as exc:
            raise RepositoryUnavailableError(exc.code, exc.message) from exc
        snapshot = assemble_snapshot(records, tree_version, issues)
        self._snapshot, self._tree_version = snapshot, tree_version
        logger.info(
            "gitlab snapshot loaded: %d document(s), %d issue(s)", len(snapshot.documents), len(issues)
        )
        return snapshot

    # --- KnowledgeRepository -------------------------------------------------------------------
    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        # MVP: one service identity. Multiuser deployments need per-user GitLab authorization first.
        if self._snapshot is not None and time.monotonic() - self._checked_at < self._refresh_seconds:
            return self._snapshot
        async with self._lock:
            if self._snapshot is not None and time.monotonic() - self._checked_at < self._refresh_seconds:
                return self._snapshot
            snapshot = await self._refresh()
            self._checked_at = time.monotonic()
            return snapshot

    async def get_document(self, document_id: str, user: UserContext) -> DocumentRecord:
        if not is_valid_document_id(document_id):
            raise DocumentNotFoundError(document_id)
        snapshot = await self.snapshot(user)
        key = document_id.lower()
        if key in snapshot.duplicates:
            raise DuplicateDocumentIdError(document_id, snapshot.duplicates[key])
        record = snapshot.get(document_id)
        if record is None:
            raise DocumentNotFoundError(document_id)
        return record

    async def current_file_revision(self, path: str) -> str | None:
        """Fresh `last_commit_id` of a file on the default branch (bypasses the snapshot cache)."""
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
        return str(response.json().get("last_commit_id") or "") or None

    async def status(self) -> IntegrationStatus:
        base = {
            "name": "gitlab_knowledge",
            "title": "GitLab (каноническая база знаний)",
            "kind": "knowledge_repository",
        }
        details = {"host": self._client.host, "branch": self._branch}
        try:
            await self._client.request("GET", self._client.project_path())
        except GitLabError as exc:
            return IntegrationStatus(
                **base,
                state="error",
                capabilities=[],
                details=details,
                human_readable_message=f"GitLab настроен, но проверка не прошла: {exc.message}",
            )
        count = len(self._snapshot.documents) if self._snapshot else 0
        return IntegrationStatus(
            **base,
            state="connected",
            capabilities=["read", "list", "revision:commit-sha"],
            details={**details, "documents": str(count)},
            human_readable_message=f"Подключено (проверка проекта прошла), ветка {self._branch}, документов: {count}.",
        )
