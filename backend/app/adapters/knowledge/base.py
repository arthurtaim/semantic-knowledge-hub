"""KnowledgeRepository contract (team knowledge: local workspace now, GitLab later)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol, runtime_checkable

from app.domain.models import (
    DocumentRecord,
    IntegrationStatus,
    LoadIssue,
    SourceType,
    SyncState,
    UserContext,
)
from app.domain.schema import is_valid_document_id


class DocumentNotFoundError(LookupError):
    def __init__(self, document_id: str) -> None:
        super().__init__(document_id)
        self.document_id = document_id


class DuplicateDocumentIdError(LookupError):
    def __init__(self, document_id: str, paths: list[str]) -> None:
        super().__init__(document_id)
        self.document_id = document_id
        self.paths = paths


class RevisionNotAvailableError(LookupError):
    """The requested revision of a document cannot be read from this store."""

    def __init__(self, document_id: str, revision: str, message: str) -> None:
        super().__init__(message)
        self.document_id = document_id
        self.revision = revision
        self.message = message


class RepositoryUnavailableError(RuntimeError):
    """The backing store cannot be read (disabled, misconfigured, auth or network failure)."""

    def __init__(self, code: str, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class KnowledgeSnapshot:
    """Immutable view of all valid documents at one point in time."""

    version: str
    documents: dict[str, DocumentRecord]  # key: lower-cased document id
    issues: list[LoadIssue] = field(default_factory=list)
    duplicates: dict[str, list[str]] = field(default_factory=dict)  # lower id -> paths
    # Lower-cased ids whose last refresh failed: they carry their last successfully read revision.
    stale_ids: frozenset[str] = frozenset()

    def get(self, document_id: str) -> DocumentRecord | None:
        return self.documents.get(document_id.lower())

    def ordered(self) -> list[DocumentRecord]:
        return sorted(self.documents.values(), key=lambda d: (d.type.value, d.title.lower(), d.id))


@dataclass(frozen=True)
class SyncInfo:
    """Health of the source synchronisation (not of the search index)."""

    state: SyncState
    message: str
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    failed_paths: tuple[str, ...] = ()
    branch: str | None = None
    head_commit: str | None = None


def lookup(snapshot: KnowledgeSnapshot, document_id: str) -> DocumentRecord:
    """Shared id resolution: invalid ids are "not found", ambiguous ids are never guessed."""
    if not is_valid_document_id(document_id):
        raise DocumentNotFoundError(document_id)
    key = document_id.lower()
    if key in snapshot.duplicates:
        raise DuplicateDocumentIdError(document_id, snapshot.duplicates[key])
    record = snapshot.get(document_id)
    if record is None:
        raise DocumentNotFoundError(document_id)
    return record


@runtime_checkable
class KnowledgeRepository(Protocol):
    """Read-side contract of a knowledge store (local workspace, GitLab, …).

    Writes never happen through this interface: changes go through proposals and a
    ProposalPublisher (GitLab branch + commit + MR) so that the source keeps its own review.
    """

    source: SourceType

    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        """All documents the user may read (list + metadata), plus load/validation issues."""
        ...

    async def get_document(self, document_id: str, user: UserContext) -> DocumentRecord:
        """Current revision. Raises DocumentNotFoundError or DuplicateDocumentIdError."""
        ...

    async def get_document_at_revision(
        self, document_id: str, revision: str, user: UserContext
    ) -> DocumentRecord:
        """A specific revision. Raises RevisionNotAvailableError when the store cannot serve it."""
        ...

    async def exists(self, document_id: str, user: UserContext) -> bool: ...

    async def current_revision(self, document_id: str, user: UserContext) -> str | None:
        """Revision as the source reports it NOW (bypasses caches); None if the document is gone.
        Used for conflict detection before any write."""
        ...

    async def refresh(self, *, full: bool = False) -> KnowledgeSnapshot:
        """Re-synchronise with the source now (manual re-index). `full` drops incremental caches."""
        ...

    def sync_info(self) -> SyncInfo: ...

    async def status(self) -> IntegrationStatus: ...
