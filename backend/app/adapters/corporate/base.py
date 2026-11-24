"""CorporateKnowledgeConnector contract (Confluence Data Center via an approved read-only MCP)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from app.domain.models import IntegrationStatus, UserContext


class ConnectorUnavailableError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class CorporatePageNotFoundError(LookupError):
    """Unknown page OR a page the user may not read — indistinguishable on purpose."""


@dataclass(frozen=True)
class CorporatePage:
    page_id: str
    space: str
    title: str
    body: str  # plain text; untrusted content
    source_uri: str  # validated link to the authorized source page
    version: str
    updated_at: datetime | None
    is_mock: bool
    # M5.6.2: what the source says about authority ("approved" | "draft" | "unknown" — never guessed),
    # the instance the page id belongs to, the raw storage format (bounded) when the source returns it,
    # labels, and — only for synthetic fixtures — the curated document a page duplicates.
    status: str = "unknown"
    instance: str = ""
    storage: str | None = None
    labels: tuple[str, ...] = ()
    canonical_document_id: str | None = None


class CorporateKnowledgeConnector(Protocol):
    name: str
    enabled: bool

    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        """Only pages the user is authorized to read, within allowlisted spaces."""
        ...

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage: ...

    async def status(self) -> IntegrationStatus: ...
