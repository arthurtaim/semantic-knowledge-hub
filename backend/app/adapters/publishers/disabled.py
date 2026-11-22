"""Default publishers: nothing leaves the machine. Proposals stay in local derived state."""

from __future__ import annotations

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
    enabled = False

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="confluence_publisher",
            title="Публикация в Confluence",
            kind="confluence_publisher",
            state="disabled",
            capabilities=[],
            human_readable_message=(
                "Публикация выключена (CONFLUENCE_PUBLISH_ENABLED=false). Включается только после "
                "отдельного согласования и только для утверждённых документов из GitLab."
            ),
        )
