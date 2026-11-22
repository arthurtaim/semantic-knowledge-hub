"""Minimal Confluence **Data Center** REST client (`/rest/api`, not the Cloud v2 API).

Endpoints (Confluence Server/Data Center REST API, see docs/REFERENCES.md): space, content by id,
content by space+title, content properties, create page (with `metadata.properties`), update page
(version + 1). Only GETs are retried; a POST/PUT that timed out may have been applied and is never
repeated here — the publication service inspects the page first. Tokens and bodies are never logged.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import SecretStr

logger = logging.getLogger("skh.confluence.rest")

RETRY_STATUSES = frozenset({429, 502, 503, 504})
PAGE_EXPAND = "body.storage,version,space,ancestors"


class ConfluenceRestError(RuntimeError):
    """`uncertain`: a write may have been applied although no success answer arrived."""

    def __init__(
        self, code: str, message: str, status: int | None = None, *, uncertain: bool = False
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.uncertain = uncertain


def _error_for(status: int, write: bool) -> ConfluenceRestError:
    if status == 401:
        return ConfluenceRestError(
            "confluence_auth_failed", "Confluence отклонил токен публикации (401).", status
        )
    if status == 403:
        return ConfluenceRestError(
            "confluence_forbidden", "Недостаточно прав в Confluence для этой операции (403).", status
        )
    if status == 404:
        return ConfluenceRestError("confluence_not_found", "Объект Confluence не найден (404).", status)
    if status == 409:
        return ConfluenceRestError(
            "confluence_version_conflict", "Страница изменилась в Confluence (конфликт версий, 409).", status
        )
    if status == 429:
        return ConfluenceRestError(
            "confluence_rate_limited", "Confluence ограничил частоту запросов (429).", status
        )
    if status >= 500:
        # A 5xx after a write does not prove the write failed.
        return ConfluenceRestError(
            "confluence_unavailable",
            f"Confluence временно недоступен (HTTP {status}).",
            status,
            uncertain=write,
        )
    return ConfluenceRestError(
        "confluence_bad_request", f"Confluence отклонил запрос (HTTP {status}).", status
    )


class ConfluenceDCClient:
    def __init__(
        self,
        *,
        base_url: str,
        token: SecretStr,
        timeout_seconds: float = 15.0,
        max_retries: int = 2,
        max_response_bytes: int = 4 * 1024 * 1024,
        transport: httpx.AsyncBaseTransport | None = None,
        verify: ssl.SSLContext | bool = True,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._max_bytes = max_response_bytes
        self._transport = transport
        self._verify = verify
        self._sleep = sleep

    @property
    def base_url(self) -> str:
        return self._base_url

    def page_url(self, page_id: str) -> str:
        return f"{self._base_url}/pages/viewpage.action?pageId={quote(page_id, safe='')}"

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        allowed: frozenset[int] = frozenset(),
    ) -> tuple[int, Any]:
        write = method.upper() not in ("GET", "HEAD")
        retries = 0 if write else self._max_retries
        attempt = 0
        headers = {
            "Authorization": f"Bearer {self._token.get_secret_value()}",
            "Accept": "application/json",
            "X-Atlassian-Token": "no-check",
        }
        async with httpx.AsyncClient(
            base_url=self._base_url,
            headers=headers,
            timeout=httpx.Timeout(self._timeout),
            follow_redirects=False,
            trust_env=False,
            transport=self._transport,
            verify=self._verify,
        ) as client:
            while True:
                try:
                    response = await client.request(method, path, params=params, json=json)
                except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                    # Nothing was sent: a definite failure, safe to retry later.
                    raise ConfluenceRestError(
                        "confluence_unreachable", "Confluence недоступен (не удалось подключиться)."
                    ) from exc
                except httpx.TimeoutException as exc:
                    if attempt < retries:
                        attempt += 1
                        await self._sleep(0.5 * attempt)
                        continue
                    raise ConfluenceRestError(
                        "confluence_timeout", "Confluence не ответил вовремя.", uncertain=write
                    ) from exc
                except httpx.HTTPError as exc:
                    # The connection broke after the request may have been sent: a write is uncertain.
                    raise ConfluenceRestError(
                        "confluence_unreachable",
                        "Confluence недоступен (ошибка соединения).",
                        uncertain=write,
                    ) from exc
                if response.status_code in RETRY_STATUSES and attempt < retries:
                    attempt += 1
                    try:
                        delay = float(response.headers.get("Retry-After", ""))
                    except ValueError:
                        delay = 0.5 * 2 ** (attempt - 1)
                    await self._sleep(min(5.0, max(0.0, delay)))
                    continue
                logger.info(
                    "confluence %s %s -> %s",
                    method,
                    path.split("?", 1)[0].rsplit("/property/", 1)[0],
                    response.status_code,
                )
                if len(response.content) > self._max_bytes:
                    raise ConfluenceRestError(
                        "confluence_response_too_large", "Ответ Confluence превышает лимит."
                    )
                if response.status_code >= 300 and response.status_code not in allowed:
                    raise _error_for(response.status_code, write)
                if response.status_code >= 300 or not response.content:
                    return response.status_code, None
                try:
                    return response.status_code, response.json()
                except ValueError as exc:
                    raise ConfluenceRestError(
                        "confluence_invalid_response",
                        "Confluence вернул некорректный ответ (не JSON).",
                        response.status_code,
                        uncertain=write,
                    ) from exc

    # --- reads -----------------------------------------------------------------------------------
    async def get_space(self, key: str) -> dict[str, Any] | None:
        status, body = await self.request(
            "GET", f"/rest/api/space/{quote(key, safe='')}", allowed=frozenset({404})
        )
        return body if status == 200 and isinstance(body, dict) else None

    async def get_page(self, page_id: str) -> dict[str, Any] | None:
        status, body = await self.request(
            "GET",
            f"/rest/api/content/{quote(page_id, safe='')}",
            params={"expand": PAGE_EXPAND},
            allowed=frozenset({404}),
        )
        return body if status == 200 and isinstance(body, dict) else None

    async def find_pages_by_title(self, space: str, title: str) -> list[dict[str, Any]]:
        _, body = await self.request(
            "GET",
            "/rest/api/content",
            params={"spaceKey": space, "title": title, "type": "page", "expand": PAGE_EXPAND, "limit": 5},
        )
        results = body.get("results") if isinstance(body, dict) else None
        if not isinstance(results, list):
            raise ConfluenceRestError(
                "confluence_invalid_response", "Confluence вернул неожиданный список страниц."
            )
        return [r for r in results if isinstance(r, dict)]

    async def get_property(self, page_id: str, key: str) -> dict[str, Any] | None:
        status, body = await self.request(
            "GET",
            f"/rest/api/content/{quote(page_id, safe='')}/property/{quote(key, safe='')}",
            allowed=frozenset({404}),
        )
        return body if status == 200 and isinstance(body, dict) else None

    # --- writes (never retried) ------------------------------------------------------------------
    async def create_page(
        self,
        *,
        space: str,
        parent_id: str,
        title: str,
        storage: str,
        property_key: str,
        property_value: dict[str, Any],
    ) -> dict[str, Any]:
        _, body = await self.request(
            "POST",
            "/rest/api/content",
            json={
                "type": "page",
                "title": title,
                "space": {"key": space},
                "ancestors": [{"id": parent_id}],
                "body": {"storage": {"value": storage, "representation": "storage"}},
                "metadata": {"properties": {property_key: {"key": property_key, "value": property_value}}},
            },
        )
        if not isinstance(body, dict) or not body.get("id"):
            raise ConfluenceRestError(
                "confluence_invalid_response", "Confluence не вернул ID созданной страницы.", uncertain=True
            )
        return body

    async def update_page(
        self, *, page_id: str, space: str, parent_id: str, title: str, storage: str, version: int
    ) -> dict[str, Any]:
        _, body = await self.request(
            "PUT",
            f"/rest/api/content/{quote(page_id, safe='')}",
            json={
                "id": page_id,
                "type": "page",
                "title": title,
                "space": {"key": space},
                "ancestors": [{"id": parent_id}],
                "version": {"number": version},
                "body": {"storage": {"value": storage, "representation": "storage"}},
            },
        )
        if not isinstance(body, dict):
            raise ConfluenceRestError(
                "confluence_invalid_response", "Confluence вернул пустой ответ.", uncertain=True
            )
        return body

    async def create_property(self, page_id: str, key: str, value: dict[str, Any]) -> None:
        await self.request(
            "POST", f"/rest/api/content/{quote(page_id, safe='')}/property", json={"key": key, "value": value}
        )
