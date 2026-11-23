"""Default publishers: nothing leaves the machine. Proposals stay in local derived state."""

from __future__ import annotations

from typing import Any, Literal

from app.adapters.publishers.base import (
    MergeRequestRef,
    ProposalForPublication,
    PublicationError,
    PublishResult,
)
from app.domain.models import IntegrationStatus, UserContext


class DisabledProposalPublisher:
    enabled = False

    def branch_for(self, proposal_id: str, document_id: str) -> str | None:
        return None

    async def merge_request_state(
        self, proposal_id: str, document_id: str, iid: str | None
    ) -> MergeRequestRef | None:
        return None

    async def publish_proposal(self, proposal: ProposalForPublication, user: UserContext) -> PublishResult:
        raise PublicationError(
            "gitlab_proposals_disabled",
            "Создание Merge Request в GitLab отключено (GITLAB_PROPOSALS_ENABLED=false). "
            "Предложение хранится локально и ждёт ревью.",
            retryable=False,
        )

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="gitlab_proposals",
            title="GitLab Merge Requests для предложений",
            kind="proposal_publisher",
            state="disabled",
            capabilities=[],
            human_readable_message=(
                "Отключено. Предложения изменений хранятся локально; «Готово к ревью» не создаёт MR "
                "и не меняет исходный документ."
            ),
        )


class DisabledConfluencePublisher:
    """Publication not configured: no Confluence REST URL. Nothing is read or written."""

    enabled = False
    write_enabled = False
    mode: Literal["disabled", "dry_run_only", "write"] = "disabled"
    target_kind: Literal["none", "local", "mock", "real"] = "none"
    space_key = ""
    parent_id = ""
    property_key = ""

    def page_url(self, page_id: str) -> str | None:
        return None

    def _off(self) -> PublicationError:
        return PublicationError(
            "publication_disabled", "Публикация в Confluence не настроена.", retryable=False
        )

    async def read_space(self) -> dict[str, Any] | None:
        raise self._off()

    async def read_page(self, page_id: str) -> dict[str, Any] | None:
        raise self._off()

    async def find_pages(self, title: str) -> list[dict[str, Any]]:
        raise self._off()

    async def read_marker(self, page_id: str) -> dict[str, Any] | None:
        raise self._off()

    async def create_page(self, title: str, storage: str, marker: dict[str, Any]) -> dict[str, Any]:
        raise self._off()

    async def update_page(self, page_id: str, title: str, storage: str, version: int) -> dict[str, Any]:
        raise self._off()

    async def write_marker(self, page_id: str, marker: dict[str, Any]) -> None:
        raise self._off()

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="confluence_publisher",
            title="Confluence Data Center (REST, публикация)",
            kind="confluence_publisher",
            state="disabled",
            capabilities=[],
            human_readable_message=(
                "Не настроено (CONFLUENCE_REST_URL не задан). Публикация утверждённых документов из GitLab "
                "включается только после отдельного согласования; запись выключена по умолчанию."
            ),
        )
