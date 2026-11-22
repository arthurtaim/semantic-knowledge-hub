"""ConfluenceRESTPublisher: the remote side of M5 for exactly one configured space + parent page.

Separate from the read-only MCP connector and its credentials. Reads are always allowed once
configured (dry-run); writes require `write_enabled`, which the configuration grants only for a
declared local test double (integration_mock) or an acknowledged staging space (live_write_staging).
"""

from __future__ import annotations

from typing import Any, Literal

from app.adapters.confluence_rest.client import ConfluenceDCClient, ConfluenceRestError
from app.adapters.publishers.base import PublicationError
from app.domain.models import IntegrationStatus

PROPERTY_KEY = "skh-managed-document"


def _wrap(exc: ConfluenceRestError) -> PublicationError:
    return PublicationError(
        exc.code,
        exc.message,
        uncertain=exc.uncertain,
        retryable=exc.code
        not in ("confluence_auth_failed", "confluence_forbidden", "confluence_bad_request"),
    )


class ConfluenceRESTPublisher:
    enabled = True
    property_key = PROPERTY_KEY

    def __init__(
        self,
        client: ConfluenceDCClient,
        *,
        space_key: str,
        parent_id: str,
        write_enabled: bool,
        target_kind: Literal["none", "local", "mock", "real"],
    ) -> None:
        self._client = client
        self.space_key = space_key
        self.parent_id = parent_id
        self.write_enabled = write_enabled
        self.target_kind = target_kind
        self.mode: Literal["disabled", "dry_run_only", "write"] = "write" if write_enabled else "dry_run_only"

    def page_url(self, page_id: str) -> str | None:
        return self._client.page_url(page_id)

    async def _call(self, coro: Any) -> Any:
        try:
            return await coro
        except ConfluenceRestError as exc:
            raise _wrap(exc) from exc

    async def read_space(self) -> dict[str, Any] | None:
        result: dict[str, Any] | None = await self._call(self._client.get_space(self.space_key))
        return result

    async def read_page(self, page_id: str) -> dict[str, Any] | None:
        result: dict[str, Any] | None = await self._call(self._client.get_page(page_id))
        return result

    async def find_pages(self, title: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = await self._call(
            self._client.find_pages_by_title(self.space_key, title)
        )
        return result

    async def read_marker(self, page_id: str) -> dict[str, Any] | None:
        prop = await self._call(self._client.get_property(page_id, PROPERTY_KEY))
        value = prop.get("value") if isinstance(prop, dict) else None
        return value if isinstance(value, dict) else None

    def _ensure_write(self) -> None:
        if not self.write_enabled:
            raise PublicationError(
                "publish_disabled",
                "Запись в Confluence выключена (CONFLUENCE_PUBLISH_ENABLED=false): доступен только предпросмотр.",
                retryable=False,
            )

    async def create_page(self, title: str, storage: str, marker: dict[str, Any]) -> dict[str, Any]:
        self._ensure_write()
        result: dict[str, Any] = await self._call(
            self._client.create_page(
                space=self.space_key,
                parent_id=self.parent_id,
                title=title,
                storage=storage,
                property_key=PROPERTY_KEY,
                property_value=marker,
            )
        )
        return result

    async def update_page(self, page_id: str, title: str, storage: str, version: int) -> dict[str, Any]:
        self._ensure_write()
        result: dict[str, Any] = await self._call(
            self._client.update_page(
                page_id=page_id,
                space=self.space_key,
                parent_id=self.parent_id,
                title=title,
                storage=storage,
                version=version,
            )
        )
        return result

    async def write_marker(self, page_id: str, marker: dict[str, Any]) -> None:
        self._ensure_write()
        await self._call(self._client.create_property(page_id, PROPERTY_KEY, marker))

    async def status(self) -> IntegrationStatus:
        base = {
            "name": "confluence_publisher",
            "title": "Confluence Data Center (REST, публикация)",
            "kind": "confluence_publisher",
        }
        details = {
            "space": self.space_key,
            "parent_page_id": self.parent_id,
            "mode": self.mode,
            "host": self._client.base_url.split("//", 1)[-1].split("/", 1)[0],
        }
        try:
            space = await self._client.get_space(self.space_key)
            parent = await self._client.get_page(self.parent_id) if space else None
        except ConfluenceRestError as exc:
            return IntegrationStatus(
                **base,
                state="error",
                capabilities=[],
                details=details,
                human_readable_message=f"Confluence REST настроен, но проверка не прошла: {exc.message}",
            )
        if space is None or parent is None or (parent.get("space") or {}).get("key") != self.space_key:
            return IntegrationStatus(
                **base,
                state="error",
                capabilities=[],
                details=details,
                human_readable_message="Пространство или родительская страница публикации не найдены в Confluence.",
            )
        capabilities = ["read_pages", "dry_run"] + (
            ["create_page", "update_page"] if self.write_enabled else []
        )
        mode_text = (
            "запись разрешена (только в этот тестовый space)"
            if self.write_enabled
            else "только предпросмотр (запись выключена)"
        )
        return IntegrationStatus(
            **base,
            state="connected",
            capabilities=capabilities,
            details=details,
            human_readable_message=f"Подключено: пространство {self.space_key}, родитель {self.parent_id}; {mode_text}.",
        )
