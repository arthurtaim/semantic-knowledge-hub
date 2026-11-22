"""Integration status: honest states, never `connected` merely because a variable is set."""

from __future__ import annotations

from datetime import UTC, datetime

from app.adapters.ai.base import AIProvider
from app.adapters.corporate.base import CorporateKnowledgeConnector
from app.adapters.knowledge.base import KnowledgeRepository
from app.adapters.publishers.base import ConfluencePublisher, ProposalPublisher
from app.adapters.search.base import SearchProvider
from app.adapters.tasks.base import TaskSystemAdapter
from app.config import Settings
from app.domain.models import IntegrationsResponse, IntegrationStatus


def gitlab_placeholder_status(settings: Settings) -> IntegrationStatus:
    return IntegrationStatus(
        name="gitlab_knowledge",
        title="GitLab (каноническая база знаний)",
        kind="knowledge_repository",
        state="disabled",
        capabilities=[],
        human_readable_message=(
            "Не подключено: используется локальный workspace (KNOWLEDGE_BACKEND=local). Для подключения нужны "
            "GITLAB_URL, GITLAB_PROJECT_ID и токен из утверждённого хранилища секретов."
        ),
    )


class IntegrationService:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: KnowledgeRepository,
        search: SearchProvider,
        ai: AIProvider,
        corporate: CorporateKnowledgeConnector,
        proposal_publisher: ProposalPublisher,
        confluence_publisher: ConfluencePublisher,
        tasks: TaskSystemAdapter,
    ) -> None:
        self._settings = settings
        self._repository = repository
        self._search = search
        self._ai = ai
        self._corporate = corporate
        self._proposal_publisher = proposal_publisher
        self._confluence_publisher = confluence_publisher
        self._tasks = tasks

    async def status(self) -> IntegrationsResponse:
        items: list[IntegrationStatus] = [await self._repository.status()]
        if self._repository.source != "gitlab":
            items.append(gitlab_placeholder_status(self._settings))
        items.extend(
            [
                self._search.status(),
                await self._ai.status(),
                await self._corporate.status(),
                await self._proposal_publisher.status(),
                await self._confluence_publisher.status(),
                await self._tasks.status(),
            ]
        )
        return IntegrationsResponse(items=items, checked_at=datetime.now(UTC))
