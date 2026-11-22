"""Minimal MCP client for the Streamable HTTP transport (JSON-RPC 2.0 over POST, JSON or SSE replies).

Only what the read-only connector needs: initialize, tools/list, tools/call. Every operation runs
in its own short session with strict timeouts and a response-size cap.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from pydantic import SecretStr

logger = logging.getLogger("skh.mcp")

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "semantic-knowledge-hub", "version": "0.1.0"}


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
    ) -> None:
        self._url = url
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

    async def _run(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
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
            result, _ = await self._rpc(client, 2, method, params, session_id)
            return result

    async def list_tools(self) -> list[dict[str, Any]]:
        result = await self._run("tools/list", {})
        tools = result.get("tools")
        return [t for t in tools if isinstance(t, dict)] if isinstance(tools, list) else []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self._run("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise McpError("mcp_tool_error", "Инструмент MCP вернул ошибку.")
        return result
