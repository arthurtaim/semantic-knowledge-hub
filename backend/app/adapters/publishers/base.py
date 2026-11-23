"""Write-side contracts. Both are gated by explicit feature flags and human review."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from app.domain.models import IntegrationStatus, UserContext
from app.domain.proposals import MergeRequestState


@dataclass(frozen=True)
class ProposalForPublication:
    """Everything a publisher may use. Path and base revision come from the server-side record of
    the document, never from the client."""

    proposal_id: str
    document_id: str
    document_path: str
    base_revision: str  # empty for operation="create"
    proposed_content: str
    reason: str
    document_title: str = ""
    author: str = ""
    additions: int = 0
    deletions: int = 0
    proposal_url: str | None = None  # in-app link for reviewers, when APP_PUBLIC_URL is configured
    operation: Literal["create", "update"] = "update"


@dataclass(frozen=True)
class MergeRequestRef:
    iid: str
    url: str | None
    state: MergeRequestState
    source_branch: str
    target_branch: str


@dataclass(frozen=True)
class PublishResult:
    # created: a new MR; existing: an MR for this proposal already existed (idempotent retry);
    # conflict: the source changed after the base revision, nothing was written.
    state: Literal["created", "existing", "conflict"]
    merge_request: MergeRequestRef | None
    message: str


class PublicationError(RuntimeError):
    """A write to the canonical store did not complete.

    `uncertain`: the outcome is unknown (e.g. a timeout after the request was sent). Callers must
    not repeat the write blindly; the next attempt inspects the server state first.
    """

    def __init__(self, code: str, message: str, *, uncertain: bool = False, retryable: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.uncertain = uncertain
        self.retryable = retryable


# Backwards-compatible name used by earlier code and tests.
PublisherDisabledError = PublicationError


class ProposalPublisher(Protocol):
    """Sends a reviewed proposal to the canonical store's review process (GitLab MR)."""

    enabled: bool

    def branch_for(self, proposal_id: str, document_id: str) -> str | None:
        """Deterministic review branch of a proposal (None when publishing is disabled)."""
        ...

    async def publish_proposal(
        self, proposal: ProposalForPublication, user: UserContext
    ) -> PublishResult: ...

    async def merge_request_state(
        self, proposal_id: str, document_id: str, iid: str | None
    ) -> MergeRequestRef | None:
        """What GitLab reports NOW about the proposal's MR (None if there is none)."""
        ...

    async def status(self) -> IntegrationStatus: ...


class ConfluencePublisher(Protocol):
    """Remote side of M5 publication to ONE allowlisted Confluence Data Center space + parent page.

    The publication service decides; this adapter only reads and (when `write_enabled`) writes pages.
    The target space/parent come from configuration — never from a request or a document."""

    enabled: bool  # REST configured: jobs + dry-run (reads)
    write_enabled: bool  # CONFLUENCE_PUBLISH_ENABLED and an allowed profile: create/update pages
    mode: Literal["disabled", "dry_run_only", "write"]
    target_kind: Literal["none", "local", "mock", "real"]
    space_key: str
    parent_id: str
    property_key: str

    def page_url(self, page_id: str) -> str | None: ...

    async def read_space(self) -> dict[str, Any] | None: ...

    async def read_page(self, page_id: str) -> dict[str, Any] | None: ...

    async def find_pages(self, title: str) -> list[dict[str, Any]]: ...

    async def read_marker(self, page_id: str) -> dict[str, Any] | None: ...

    async def create_page(self, title: str, storage: str, marker: dict[str, Any]) -> dict[str, Any]: ...

    async def update_page(self, page_id: str, title: str, storage: str, version: int) -> dict[str, Any]: ...

    async def write_marker(self, page_id: str, marker: dict[str, Any]) -> None: ...

    async def status(self) -> IntegrationStatus: ...
