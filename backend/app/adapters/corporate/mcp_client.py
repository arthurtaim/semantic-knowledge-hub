"""Minimal MCP client for the Streamable HTTP transport (JSON-RPC 2.0 over POST, JSON or SSE replies).

Only what the read-only connector needs: initialize, tools/list, tools/call. Every operation runs
in its own short session with strict timeouts and a response-size cap.
"""

from __future__ import annotations

import itertools
import json
import logging
import ssl
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from pydantic import SecretStr

logger = logging.getLogger("skh.mcp")

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "semantic-knowledge-hub", "version": "0.1.0"}
MAX_TOOL_PAGES = 10


class McpError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _parse_sse(text: str, request_id: int) -> dict[str, Any] | None:
    data_lines: list[str] = []
    for line in [*text.splitlines(), ""]:
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif line == "" and data_lines:
            try:
                message = json.loads("\n".join(data_lines))
            except json.JSONDecodeError:
                message = None
            data_lines = []
            if isinstance(message, dict) and message.get("id") == request_id:
                return message
    return None


class McpClient:
    def __init__(
        self,
        *,
        url: str,
        token: SecretStr,
        timeout_seconds: float = 15.0,
        max_response_bytes: int = 1024 * 1024,
        transport: httpx.AsyncBaseTransport | None = None,
        verify: ssl.SSLContext | bool = True,
    ) -> None:
        self._url = url
        self._verify = verify
        self._token = token
        self._timeout = timeout_seconds
        self._max_bytes = max_response_bytes
        self._transport = transport

    def _http(self) -> httpx.AsyncClient:
        headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if self._token.get_secret_value():
            headers["Authorization"] = f"Bearer {self._token.get_secret_value()}"
        return httpx.AsyncClient(
            headers=headers,
            timeout=httpx.Timeout(self._timeout),
            follow_redirects=False,
            transport=self._transport,
            trust_env=False,
            verify=self._verify,
        )

    async def _post(
        self, client: httpx.AsyncClient, payload: dict[str, Any], session_id: str | None
    ) -> tuple[httpx.Response, bytes]:
        headers = {"MCP-Protocol-Version": PROTOCOL_VERSION}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        try:
            async with client.stream("POST", self._url, json=payload, headers=headers) as response:
                if response.status_code in (401, 403):
                    raise McpError("mcp_auth_failed", "MCP-сервер Confluence отклонил авторизацию.")
                if response.status_code == 404 and session_id:
                    raise McpError(
                        "mcp_session_expired", "Сессия MCP истекла; запрос будет выполнен в новой сессии."
                    )
                if response.status_code >= 300:
                    raise McpError("mcp_http_error", f"MCP-сервер вернул HTTP {response.status_code}.")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > self._max_bytes:
                        raise McpError("mcp_response_too_large", "Ответ MCP-сервера превышает лимит.")
                return response, bytes(body)
        except httpx.TimeoutException as exc:
            raise McpError("mcp_timeout", "MCP-сервер Confluence не ответил вовремя.") from exc
        except httpx.HTTPError as exc:
            raise McpError("mcp_unreachable", "MCP-сервер Confluence недоступен.") from exc

    async def _rpc(
        self,
        client: httpx.AsyncClient,
        request_id: int,
        method: str,
        params: dict[str, Any],
        session_id: str | None,
    ) -> tuple[dict[str, Any], str | None]:
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        response, body = await self._post(client, payload, session_id)
        content_type = response.headers.get("content-type", "")
        text = body.decode("utf-8", errors="replace")
        message: dict[str, Any] | None
        if "text/event-stream" in content_type:
            message = _parse_sse(text, request_id)
        else:
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise McpError("mcp_invalid_response", "MCP-сервер вернул не JSON.") from exc
            message = parsed if isinstance(parsed, dict) else None
        if message is None or message.get("id") != request_id:
            raise McpError("mcp_invalid_response", "MCP-сервер не вернул ответ на запрос.")
        if "error" in message:
            error = message["error"] if isinstance(message["error"], dict) else {}
            raise McpError(
                "mcp_rpc_error", f"MCP-сервер вернул ошибку: {str(error.get('message', ''))[:200]}"
            )
        result = message.get("result")
        if not isinstance(result, dict):
            raise McpError("mcp_invalid_response", "MCP-сервер вернул пустой результат.")
        return result, response.headers.get("Mcp-Session-Id") or session_id

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]]:
        """initialize → notifications/initialized → caller's requests → DELETE (spec: client SHOULD end
        the session explicitly; servers may answer 405, which is fine)."""
        async with self._http() as client:
            _, session_id = await self._rpc(
                client,
                1,
                "initialize",
                {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO},
                None,
            )
            headers = {"MCP-Protocol-Version": PROTOCOL_VERSION}
            if session_id:
                headers["Mcp-Session-Id"] = session_id
            try:
                await client.post(
                    self._url, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=headers
                )
            except httpx.HTTPError as exc:
                raise McpError("mcp_unreachable", "MCP-сервер Confluence недоступен.") from exc
            counter = itertools.count(2)

            async def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
                result, _ = await self._rpc(client, next(counter), method, params, session_id)
                return result

            try:
                yield call
            finally:
                if session_id:
                    try:
                        await client.delete(self._url, headers=headers)
                    except httpx.HTTPError:
                        logger.debug("mcp session close failed (ignored)")

    async def list_tools(self) -> list[dict[str, Any]]:
        """All tools, following `nextCursor` pagination (bounded)."""
        tools: list[dict[str, Any]] = []
        async with self._session() as call:
            cursor: str | None = None
            for _ in range(MAX_TOOL_PAGES):
                result = await call("tools/list", {"cursor": cursor} if cursor else {})
                page = result.get("tools")
                if isinstance(page, list):
                    tools.extend(t for t in page if isinstance(t, dict))
                next_cursor = result.get("nextCursor")
                if not isinstance(next_cursor, str) or not next_cursor:
                    break
                cursor = next_cursor
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        async with self._session() as call:
            result = await call("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise McpError("mcp_tool_error", "Инструмент MCP вернул ошибку.")
        return result
