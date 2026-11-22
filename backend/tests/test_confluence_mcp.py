"""Confluence MCP connector against a fake MCP server (tool discovery, ACL/scope, errors; AC-18)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.corporate.base import ConnectorUnavailableError, CorporatePageNotFoundError
from app.adapters.corporate.confluence_mcp import ConfluenceMCPConnector, parse_tool_map
from app.adapters.corporate.mcp_client import McpClient, McpError
from app.domain.models import UserContext

USER = UserContext(user_id="u", display_name="u")
URL = "https://mcp.internal.example/mcp"
TOOL_MAP = json.dumps(
    {
        "search": {
            "tool": "conf_search",
            "query_arg": "cql_text",
            "limit_arg": "limit",
            "spaces_arg": "spaces",
        },
        "read": {"tool": "conf_get_page", "id_arg": "id"},
    }
)
PAGES = [
    {
        "id": "101",
        "space": "TEAM",
        "title": "Политика документации",
        "excerpt": "Требования к <b>документации</b> ARIS.",
        "url": "https://confluence.internal.example/pages/101",
        "version": {"number": 7},
    },
    {"id": "202", "space": "SECRET", "title": "Закрытое пространство", "excerpt": "SECRET-SPACE-MARKER ARIS"},
    {
        "id": "303",
        "space": "TEAM",
        "title": "Ссылка на чужой хост",
        "excerpt": "ARIS текст",
        "url": "https://evil.example/phish",
    },
]


class FakeMcp:
    def __init__(self, *, sse: bool = False, tools: list[dict[str, Any]] | None = None) -> None:
        self.sse = sse
        self.tools = (
            tools
            if tools is not None
            else [
                {
                    "name": "conf_search",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"cql_text": {}, "limit": {}, "spaces": {}},
                    },
                },
                {"name": "conf_get_page", "inputSchema": {"type": "object", "properties": {"id": {}}}},
            ]
        )
        self.calls: list[dict[str, Any]] = []
        self.status_override: int | None = None

    def _reply(self, message: dict[str, Any], session: bool = False) -> httpx.Response:
        headers = {"Mcp-Session-Id": "sess-1"} if session else {}
        if self.sse:
            body = f"event: message\ndata: {json.dumps(message)}\n\n"
            return httpx.Response(200, text=body, headers={**headers, "content-type": "text/event-stream"})
        return httpx.Response(200, json=message, headers=headers)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.status_override:
            return httpx.Response(self.status_override, json={})
        assert request.headers["Authorization"] == "Bearer mcp-secret"
        assert "text/event-stream" in request.headers["Accept"]
        payload = json.loads(request.content)
        method = payload.get("method")
        if method == "initialize":
            return self._reply(
                {
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}},
                },
                session=True,
            )
        assert request.headers.get("Mcp-Session-Id") == "sess-1"
        if method == "notifications/initialized":
            return httpx.Response(202)
        if method == "tools/list":
            return self._reply({"jsonrpc": "2.0", "id": payload["id"], "result": {"tools": self.tools}})
        if method == "tools/call":
            self.calls.append(payload["params"])
            name, args = payload["params"]["name"], payload["params"]["arguments"]
            if name == "conf_search":
                # A non-compliant server that ignores the space filter: the connector must still drop it.
                content = {"results": PAGES}
                return self._reply(
                    {
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": {"content": [{"type": "text", "text": json.dumps(content)}]},
                    }
                )
            if name == "conf_get_page":
                page = next((p for p in PAGES if p["id"] == args["id"]), None)
                if page is None:
                    return self._reply(
                        {"jsonrpc": "2.0", "id": payload["id"], "result": {"isError": True, "content": []}}
                    )
                return self._reply(
                    {"jsonrpc": "2.0", "id": payload["id"], "result": {"structuredContent": page}}
                )
        return self._reply(
            {"jsonrpc": "2.0", "id": payload.get("id"), "error": {"code": -32601, "message": "nope"}}
        )


def connector(
    fake: FakeMcp, tool_map: str = TOOL_MAP, spaces: list[str] | None = None
) -> ConfluenceMCPConnector:
    client = McpClient(url=URL, token=SecretStr("mcp-secret"), transport=httpx.MockTransport(fake.handler))
    return ConfluenceMCPConnector(
        client,
        tool_map=parse_tool_map(tool_map),
        allowlisted_spaces=["TEAM"] if spaces is None else spaces,
        link_hosts=["confluence.internal.example"],
    )


@pytest.mark.parametrize("sse", [False, True])
def test_search_filters_spaces_and_validates_links(sse: bool) -> None:
    fake = FakeMcp(sse=sse)
    pages = asyncio.run(connector(fake).search("ARIS", USER, limit=5))
    assert [p.page_id for p in pages] == ["101", "303"]
    assert pages[0].source_uri == "https://confluence.internal.example/pages/101"
    assert pages[1].source_uri == "confluence://TEAM/303"  # foreign host link neutralized
    assert "<b>" not in pages[0].body and "документации" in pages[0].body
    assert pages[0].version == "7"
    assert all("SECRET-SPACE-MARKER" not in p.body for p in pages)
    call = fake.calls[0]
    assert call["name"] == "conf_search"
    assert call["arguments"] == {"cql_text": "ARIS", "limit": 5, "spaces": ["TEAM"]}


def test_read_page_and_not_found() -> None:
    fake = FakeMcp()
    page = asyncio.run(connector(fake).get_page("101", USER))
    assert page.title == "Политика документации"
    with pytest.raises(CorporatePageNotFoundError):
        asyncio.run(connector(fake).get_page("999", USER))
    with pytest.raises(CorporatePageNotFoundError):  # page from a non-allowlisted space
        asyncio.run(connector(fake).get_page("202", USER))


def test_tool_names_are_never_guessed() -> None:
    fake = FakeMcp(tools=[{"name": "something_else"}])
    status = asyncio.run(connector(fake).status())
    assert status.state == "error"
    assert "conf_search" in status.human_readable_message
    with pytest.raises(ConnectorUnavailableError) as exc:
        asyncio.run(connector(fake).search("ARIS", USER))
    assert exc.value.code == "mcp_tool_missing"
    assert fake.calls == []


def test_schema_mismatch_detected() -> None:
    fake = FakeMcp(
        tools=[
            {"name": "conf_search", "inputSchema": {"properties": {"q": {}}}},
            {"name": "conf_get_page", "inputSchema": {"properties": {"id": {}}}},
        ]
    )
    status = asyncio.run(connector(fake).status())
    assert status.state == "error"
    assert "cql_text" in status.human_readable_message


def test_missing_mapping_or_spaces_is_misconfiguration() -> None:
    fake = FakeMcp()
    assert asyncio.run(connector(fake, tool_map="").status()).state == "error"
    assert asyncio.run(connector(fake, spaces=[]).status()).state == "error"
    with pytest.raises(ConnectorUnavailableError):
        asyncio.run(connector(fake, spaces=[]).search("ARIS", USER))
    assert parse_tool_map("{not json") is None


def test_connected_only_after_discovery() -> None:
    status = asyncio.run(connector(FakeMcp()).status())
    assert status.state == "connected"
    assert "conf_search" in status.details["tools"]


@pytest.mark.parametrize(("status", "code"), [(401, "mcp_auth_failed"), (500, "mcp_http_error")])
def test_http_errors(status: int, code: str) -> None:
    fake = FakeMcp()
    fake.status_override = status
    with pytest.raises(McpError) as exc:
        asyncio.run(
            McpClient(
                url=URL, token=SecretStr("mcp-secret"), transport=httpx.MockTransport(fake.handler)
            ).list_tools()
        )
    assert exc.value.code == code
    assert "mcp-secret" not in exc.value.message


def test_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(McpError) as exc:
        asyncio.run(
            McpClient(url=URL, token=SecretStr(""), transport=httpx.MockTransport(handler)).list_tools()
        )
    assert exc.value.code == "mcp_timeout"


def test_assistant_uses_only_authorized_corporate_pages(
    client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeMcp()
    original = McpClient.__init__

    def patched(self: McpClient, **kwargs: Any) -> None:
        kwargs["transport"] = httpx.MockTransport(fake.handler)
        original(self, **kwargs)

    monkeypatch.setattr(McpClient, "__init__", patched)
    client = client_factory(
        confluence_connector="mcp",
        confluence_mcp_url=URL,
        confluence_mcp_auth_token="mcp-secret",
        confluence_mcp_tool_map=TOOL_MAP,
        confluence_allowlisted_spaces="TEAM",
        confluence_link_hosts="confluence.internal.example",
    )
    answer = client.post(
        "/api/assistant/ask",
        json={"question": "Какие требования к документации ARIS?", "sources": ["corporate"]},
    ).json()
    dumped = json.dumps(answer, ensure_ascii=False)
    assert "SECRET-SPACE-MARKER" not in dumped
    assert answer["citations"], answer
    assert {c["source_type"] for c in answer["citations"]} == {"confluence"}
    assert answer["citations"][0]["app_path"] is None  # real pages open at their validated source URL
    statuses = {i["name"]: i["state"] for i in client.get("/api/integrations/status").json()["items"]}
    assert statuses["confluence_mcp"] == "connected"
    assert "mcp-secret" not in client.get("/api/integrations/status").text


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example\\@confluence.internal.example/x",
        "https://user@confluence.internal.example/x",
        "https://confluence.internal.example:8443/x",
        "https://confluence.internal.example/x y",
        "javascript:alert(1)",
        "http://confluence.internal.example/x",
    ],
)
def test_link_allowlist_cannot_be_bypassed(url: str) -> None:
    c = connector(FakeMcp())
    assert c._safe_link(url, "TEAM", "1") == "confluence://TEAM/1"


def test_valid_link_is_rebuilt_from_parts() -> None:
    c = connector(FakeMcp())
    assert c._safe_link("https://Confluence.Internal.Example/pages/1?x=1#frag", "TEAM", "1") == (
        "https://confluence.internal.example/pages/1?x=1"
    )


def test_entities_decoded_and_bad_ids_dropped() -> None:
    c = connector(FakeMcp())
    page = c._to_page({"id": "7", "space": "TEAM", "title": "A &amp; B", "excerpt": "x &lt; y &amp;amp; z"})
    assert page is not None and page.title == "A & B" and page.body == "x < y &amp; z"
    assert c._to_page({"id": 'x" status="approved', "space": "TEAM", "title": "t"}) is None
