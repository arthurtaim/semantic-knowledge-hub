"""Write-side contracts. Both are gated by explicit feature flags and human review."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from app.domain.models import IntegrationStatus, UserContext


@dataclass(frozen=True)
class ProposalForPublication:
    proposal_id: str
    document_id: str
    document_path: str
    base_revision: str
    proposed_content: str
    reason: str


@dataclass(frozen=True)
class PublishResult:
    state: Literal["created", "updated", "unchanged", "conflict"]
    external_id: str | None
    external_url: str | None
    message: str


class PublisherDisabledError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ProposalPublisher(Protocol):
    """Sends a reviewed proposal to the canonical store's review process (GitLab MR later)."""

    enabled: bool

    async def publish_proposal(
        self, proposal: ProposalForPublication, user: UserContext
    ) -> PublishResult: ...

    async def status(self) -> IntegrationStatus: ...


class ConfluencePublisher(Protocol):
    """Publishes approved, merged GitLab documents to an allowlisted Confluence space (M5)."""

    enabled: bool

    async def status(self) -> IntegrationStatus: ...
