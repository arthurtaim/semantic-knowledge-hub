"""KnowledgeRepository contract (team knowledge: local workspace now, GitLab later)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from app.domain.models import DocumentRecord, IntegrationStatus, LoadIssue, SourceType, UserContext


class DocumentNotFoundError(LookupError):
    def __init__(self, document_id: str) -> None:
        super().__init__(document_id)
        self.document_id = document_id


class DuplicateDocumentIdError(LookupError):
    def __init__(self, document_id: str, paths: list[str]) -> None:
        super().__init__(document_id)
        self.document_id = document_id
        self.paths = paths


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

    def get(self, document_id: str) -> DocumentRecord | None:
        return self.documents.get(document_id.lower())

    def ordered(self) -> list[DocumentRecord]:
        return sorted(self.documents.values(), key=lambda d: (d.type.value, d.title.lower(), d.id))


@runtime_checkable
class KnowledgeRepository(Protocol):
    source: SourceType

    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        """All documents the user may read, plus load/validation issues."""
        ...

    async def get_document(self, document_id: str, user: UserContext) -> DocumentRecord:
        """Raises DocumentNotFoundError or DuplicateDocumentIdError."""
        ...

    async def status(self) -> IntegrationStatus: ...
