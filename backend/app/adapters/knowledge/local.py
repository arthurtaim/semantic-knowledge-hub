"""LocalKnowledgeRepository: Markdown/YAML files under the configured (git-ignored) workspace."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from stat import S_ISREG

from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeSnapshot,
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
    UserContext,
)

logger = logging.getLogger("skh.knowledge.local")
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)


def content_revision(data: bytes) -> str:
    """Stable content hash used as the local revision (GitLab adapter uses commit SHA)."""
    return "sha256:" + hashlib.sha256(data).hexdigest()[:16]


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


class LocalKnowledgeRepository:
    source: SourceType = "local"

    def __init__(
        self,
        root: Path,
        *,
        max_document_bytes: int,
        content_is_demo: bool = True,
        refresh_seconds: float = 2.0,
    ) -> None:
        self._root = root.resolve()
        self._max_bytes = max_document_bytes
        self._content_is_demo = content_is_demo
        self._refresh_seconds = refresh_seconds
        self._snapshot: KnowledgeSnapshot | None = None
        self._fingerprint: str | None = None
        self._checked_at = 0.0
        self._lock = asyncio.Lock()
        self._last_attempt: datetime | None = None
        self._last_success: datetime | None = None

    @property
    def root(self) -> Path:
        return self._root

    # --- scanning ------------------------------------------------------------------------------
    def _candidate_files(self, issues: list[LoadIssue]) -> list[Path]:
        files: list[Path] = []
        if not self._root.is_dir():
            return files
        for dirpath, dirnames, filenames in os.walk(self._root, followlinks=False):
            current = Path(dirpath)
            kept_dirs = []
            for name in dirnames:
                child = current / name
                if name.startswith("."):
                    continue
                if child.is_symlink():
                    issues.append(
                        LoadIssue(
                            path=self._rel(child),
                            code="symlink_skipped",
                            message="Символическая ссылка на каталог пропущена.",
                        )
                    )
                    continue
                kept_dirs.append(name)
            dirnames[:] = sorted(kept_dirs)
            for name in sorted(filenames):
                if name.startswith(".") or not name.lower().endswith(".md"):
                    continue
                path = current / name
                if path.is_symlink():
                    issues.append(
                        LoadIssue(
                            path=self._rel(path),
                            code="symlink_skipped",
                            message="Символическая ссылка пропущена.",
                        )
                    )
                    continue
                if not _is_within(path.resolve(), self._root):
                    issues.append(
                        LoadIssue(
                            path=self._rel(path), code="outside_root", message="Файл вне корня базы знаний."
                        )
                    )
                    continue
                files.append(path)
        return files

    def _rel(self, path: Path) -> str:
        try:
            return path.relative_to(self._root).as_posix()
        except ValueError:
            return path.name

    def _fingerprint_of(self, files: list[Path]) -> str:
        digest = hashlib.sha256()
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                continue
            digest.update(f"{self._rel(path)}|{stat.st_mtime_ns}|{stat.st_size}\n".encode())
        return digest.hexdigest()[:24]

    def _load_file(self, path: Path, issues: list[LoadIssue]) -> DocumentRecord | None:
        rel = self._rel(path)
        try:
            # O_NOFOLLOW closes the scan→open symlink race; O_NONBLOCK keeps a FIFO from hanging the scan.
            fd = os.open(path, os.O_RDONLY | _O_NOFOLLOW | _O_NONBLOCK)
        except OSError:
            issues.append(LoadIssue(path=rel, code="read_error", message="Не удалось открыть файл."))
            return None
        try:
            stat = os.fstat(fd)
            if not S_ISREG(stat.st_mode):
                issues.append(LoadIssue(path=rel, code="not_a_file", message="Это не обычный файл."))
                return None
            if stat.st_size > self._max_bytes:
                issues.append(
                    LoadIssue(path=rel, code="file_too_large", message="Файл превышает допустимый размер.")
                )
                return None
            chunks: list[bytes] = []
            remaining = self._max_bytes + 1
            while remaining > 0:
                chunk = os.read(fd, min(remaining, 65536))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
        except OSError:
            issues.append(LoadIssue(path=rel, code="read_error", message="Не удалось прочитать файл."))
            return None
        finally:
            os.close(fd)
        if len(data) > self._max_bytes:
            issues.append(
                LoadIssue(path=rel, code="file_too_large", message="Файл превышает допустимый размер.")
            )
            return None
        return build_record(
            data,
            path=rel,
            source=self.source,
            source_uri_for="local://{id}",
            revision=content_revision(data),
            updated_at=datetime.fromtimestamp(stat.st_mtime, tz=UTC),
            is_demo=self._content_is_demo,
            issues=issues,
        )

    def _build_snapshot(
        self, files: list[Path], fingerprint: str, issues: list[LoadIssue]
    ) -> KnowledgeSnapshot:
        records = [r for r in (self._load_file(path, issues) for path in files) if r is not None]
        snapshot = assemble_snapshot(records, fingerprint, issues)
        if issues:
            logger.warning("knowledge load completed with %d issue(s)", len(issues))
        return snapshot

    def _refresh_sync(self, force: bool = False) -> KnowledgeSnapshot:
        issues: list[LoadIssue] = []
        files = self._candidate_files(issues)
        fingerprint = self._fingerprint_of(files)
        if not force and self._snapshot is not None and fingerprint == self._fingerprint:
            return self._snapshot
        snapshot = self._build_snapshot(files, fingerprint, issues)
        self._snapshot, self._fingerprint = snapshot, fingerprint
        return snapshot

    # --- KnowledgeRepository -------------------------------------------------------------------
    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        # Local demo has a single identity with access to the whole workspace.
        now = time.monotonic()
        if self._snapshot is not None and now - self._checked_at < self._refresh_seconds:
            return self._snapshot
        async with self._lock:
            self._last_attempt = datetime.now(UTC)
            snapshot = await asyncio.to_thread(self._refresh_sync)
            self._checked_at = time.monotonic()
            self._last_success = self._last_attempt
            return snapshot

    async def refresh(self, *, full: bool = False) -> KnowledgeSnapshot:
        async with self._lock:
            self._last_attempt = datetime.now(UTC)
            snapshot = await asyncio.to_thread(self._refresh_sync, True)
            self._checked_at = time.monotonic()
            self._last_success = self._last_attempt
            return snapshot

    async def get_document(self, document_id: str, user: UserContext) -> DocumentRecord:
        return lookup(await self.snapshot(user), document_id)

    async def get_document_at_revision(
        self, document_id: str, revision: str, user: UserContext
    ) -> DocumentRecord:
        record = await self.get_document(document_id, user)
        if record.revision != revision:
            raise RevisionNotAvailableError(
                document_id,
                revision,
                "Локальный workspace не хранит историю: доступна только текущая ревизия документа.",
            )
        return record

    async def exists(self, document_id: str, user: UserContext) -> bool:
        try:
            await self.get_document(document_id, user)
        except (DocumentNotFoundError, DuplicateDocumentIdError):
            return False
        return True

    async def current_revision(self, document_id: str, user: UserContext) -> str | None:
        # Re-read the workspace now: a cached snapshot must not hide a concurrent edit.
        snapshot = await self.refresh()
        try:
            return lookup(snapshot, document_id).revision
        except (DocumentNotFoundError, DuplicateDocumentIdError):
            return None

    def sync_info(self) -> SyncInfo:
        if not self._root.is_dir():
            return SyncInfo(
                state="error",
                message="Каталог локальной базы знаний не найден.",
                last_attempt_at=self._last_attempt,
                last_success_at=self._last_success,
            )
        if self._snapshot is None:
            return SyncInfo(state="never_synced", message="Workspace ещё не прочитан.")
        return SyncInfo(
            state="fresh",
            message="Локальный workspace читается напрямую с диска.",
            last_attempt_at=self._last_attempt,
            last_success_at=self._last_success,
        )

    async def status(self) -> IntegrationStatus:
        if not self._root.is_dir():
            return IntegrationStatus(
                name="local_knowledge",
                title="Локальная база знаний",
                kind="knowledge_repository",
                state="error",
                capabilities=["read"],
                human_readable_message="Каталог локальной базы знаний не найден.",
            )
        count = len(self._snapshot.documents) if self._snapshot else 0
        return IntegrationStatus(
            name="local_knowledge",
            title="Локальная база знаний",
            kind="knowledge_repository",
            state="connected",
            capabilities=["read", "list", "revision:content-hash"],
            human_readable_message=(
                f"Локальный workspace (демо-данные), документов: {count}. "
                "Это не GitLab: изменения в нём не являются утверждёнными знаниями команды."
            ),
            details={"documents": str(count), "demo_content": str(self._content_is_demo).lower()},
        )


def seed_from_fixtures(fixtures_root: Path, knowledge_root: Path) -> int:
    """Copy synthetic fixtures into an empty workspace. Never overwrites existing files."""
    knowledge_root.mkdir(parents=True, exist_ok=True)
    if any(knowledge_root.rglob("*.md")):
        return 0
    if not fixtures_root.is_dir():
        logger.warning("fixtures directory not found; workspace left empty")
        return 0
    copied = 0
    fixtures_resolved = fixtures_root.resolve()
    for source in sorted(fixtures_resolved.rglob("*.md")):
        if source.is_symlink() or not _is_within(source.resolve(), fixtures_resolved):
            continue
        target = knowledge_root / source.relative_to(fixtures_resolved)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        copied += 1
    logger.info("seeded %d synthetic fixture document(s) into workspace", copied)
    return copied
