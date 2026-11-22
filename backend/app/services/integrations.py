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
from app.domain.models import IntegrationAccess, IntegrationsResponse, IntegrationStatus, IntegrationTarget


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

    def _labels(self, item: IntegrationStatus) -> tuple[IntegrationTarget, IntegrationAccess]:
        """Where a status points and what the app may do there — derived from configuration and the
        adapter in use, never from the mere presence of a URL."""
        s = self._settings
        if item.state == "disabled" and item.name != "confluence_publisher":
            return "none", "none"
        match item.name:
            case "local_knowledge" | "search_index":
                return "local", "read"
            case "gitlab_knowledge":
                return s.target_kind(s.gitlab_url), "read"
            case "gitlab_proposals":
                return s.target_kind(s.gitlab_url), "write"
            case "ai_provider":
                return (
                    ("local", "read") if s.ai_provider == "mock" else (s.target_kind(s.ai_base_url), "read")
                )
            case "confluence_mcp":
                if s.confluence_connector == "mock":
                    return "local", "read"  # built-in synthetic pages
                return s.target_kind(s.confluence_mcp_url), "read"
            case "confluence_publisher":
                pub = self._confluence_publisher
                if not pub.enabled:
                    return "none", "none"
                return pub.target_kind, "read_write" if pub.write_enabled else "read"
        return ("local", "read") if item.state in ("connected", "mock") else ("none", "none")

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
        now = datetime.now(UTC)
        labelled = []
        for item in items:
            target, access = self._labels(item)
            labelled.append(item.model_copy(update={"target": target, "access": access, "checked_at": now}))
        return IntegrationsResponse(items=labelled, checked_at=now)
