"""Default connector: Confluence is not connected and no network calls are ever made."""

from __future__ import annotations

from app.adapters.corporate.base import ConnectorUnavailableError, CorporatePage
from app.domain.models import IntegrationStatus, UserContext

DISABLED_MESSAGE = (
    "Корпоративные источники (Confluence Data Center через MCP) не подключены. "
    "Ответы и поиск основаны только на документах команды."
)


class DisabledCorporateConnector:
    name = "confluence_mcp"
    enabled = False

    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        raise ConnectorUnavailableError("corporate_source_disabled", DISABLED_MESSAGE)

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage:
        raise ConnectorUnavailableError("corporate_source_disabled", DISABLED_MESSAGE)

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name=self.name,
            title="Confluence Data Center (MCP, только чтение)",
            kind="corporate_knowledge",
            state="disabled",
            capabilities=[],
            human_readable_message="Не подключено (CONFLUENCE_CONNECTOR=disabled). Сетевые запросы не выполняются.",
        )
