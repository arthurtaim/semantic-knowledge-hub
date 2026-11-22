"""Replay tests for the Confluence MCP connector.

Every scenario in fixtures/integration/confluence_mcp/*.json describes what an MCP server announces
and answers; ReplayMcpServer serves exactly that over the Streamable HTTP transport (JSON or SSE),
so recorded (sanitized, synthetic) responses from the future test server can be dropped in without
changing code. No network is used.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.corporate.base import ConnectorUnavailableError, CorporatePageNotFoundError
from app.adapters.corporate.confluence_mcp import ConfluenceMCPConnector, parse_result_map, parse_tool_map
from app.adapters.corporate.mcp_client import PROTOCOL_VERSION, McpClient
from app.domain.models import UserContext
from tests.conftest import PROJECT_ROOT

SCENARIO_DIR = PROJECT_ROOT / "fixtures" / "integration" / "confluence_mcp"
SCENARIOS = sorted(SCENARIO_DIR.glob("*.json"))
URL = "https://mcp.test.example/mcp"
TOKEN = "replay-token"
USER = UserContext(user_id="replay", display_name="replay")


def load(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


class ReplayMcpServer:
    """Serves a recorded scenario and checks the client's protocol behaviour on the way."""

    def __init__(self, scenario: dict[str, Any]) -> None:
        self.scenario = scenario
        self.session_id = scenario.get("session_id", "replay")
        self.sse = scenario.get("transport") == "sse"
        self.tool_calls: list[dict[str, Any]] = []
        self.closed_sessions: list[str] = []

    def _reply(self, message: dict[str, Any], *, initialize: bool = False) -> httpx.Response:
        headers = {"Mcp-Session-Id": self.session_id} if initialize else {}
        if self.sse:
            body = f"event: message\ndata: {json.dumps(message, ensure_ascii=False)}\n\n"
            return httpx.Response(200, text=body, headers={**headers, "content-type": "text/event-stream"})
        return httpx.Response(200, json=message, headers=headers)

    def _call_result(self, name: str, arguments: dict[str, Any]) -> dict[str, Any] | None:
        for call in self.scenario["server"]["calls"]:
            if call["tool"] != name:
                continue
            if all(arguments.get(k) == v for k, v in call.get("match", {}).items()):
                result: dict[str, Any] = call["result"]
                return result
        return None

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == URL
        assert request.headers.get("Authorization") == f"Bearer {TOKEN}"
        if request.method == "DELETE":
            self.closed_sessions.append(request.headers.get("Mcp-Session-Id", ""))
            return httpx.Response(204)
        assert request.method == "POST"
        assert (
            "application/json" in request.headers["Accept"]
            and "text/event-stream" in request.headers["Accept"]
        )
        payload = json.loads(request.content)
        method = payload.get("method")
        if method == "initialize":
            params = payload["params"]
            assert params["protocolVersion"] == PROTOCOL_VERSION and params["clientInfo"]["name"]
            result = {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "replay"},
            }
            return self._reply({"jsonrpc": "2.0", "id": payload["id"], "result": result}, initialize=True)
        assert request.headers.get("Mcp-Session-Id") == self.session_id
        assert request.headers.get("MCP-Protocol-Version") == PROTOCOL_VERSION
        if method == "notifications/initialized":
            return httpx.Response(202)
        if method == "tools/list":
            pages = self.scenario["server"]["tools_pages"]
            cursor = (payload.get("params") or {}).get("cursor")
            index = int(cursor) if cursor else 0
            body: dict[str, Any] = {"tools": pages[index]}
            if index + 1 < len(pages):
                body["nextCursor"] = str(index + 1)
            return self._reply({"jsonrpc": "2.0", "id": payload["id"], "result": body})
        if method == "tools/call":
            name, arguments = payload["params"]["name"], payload["params"]["arguments"]
            self.tool_calls.append({"name": name, "arguments": arguments})
            found = self._call_result(name, arguments)
            if found is None:
                error = {"code": -32602, "message": f"Unknown tool or arguments: {name}"}
                return self._reply({"jsonrpc": "2.0", "id": payload["id"], "error": error})
            return self._reply({"jsonrpc": "2.0", "id": payload["id"], "result": found})
        return self._reply(
            {"jsonrpc": "2.0", "id": payload.get("id"), "error": {"code": -32601, "message": "nope"}}
        )


def build_connector(scenario: dict[str, Any], server: ReplayMcpServer) -> ConfluenceMCPConnector:
    config = scenario["config"]
    result_map = parse_result_map(json.dumps(config["result_map"]) if config.get("result_map") else "")
    return ConfluenceMCPConnector(
        McpClient(url=URL, token=SecretStr(TOKEN), transport=httpx.MockTransport(server.handler)),
        tool_map=parse_tool_map(json.dumps(config["tool_map"])),
        allowlisted_spaces=config["allowlisted_spaces"],
        link_hosts=config["link_hosts"],
        result_map=result_map,
        result_map_valid=result_map is not None,
        web_base_url=config.get("web_base_url", ""),
    )


def test_scenarios_exist_and_are_synthetic() -> None:
    assert len(SCENARIOS) >= 4
    for path in SCENARIOS:
        text = path.read_text(encoding="utf-8")
        assert "test.example" in text or "SKHTEST" in text, path.name
        assert ".ru" not in text and "sber" not in text.lower(), path.name


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
def test_replay_scenario(path: Path) -> None:
    scenario = load(path)
    expect = scenario["expect"]
    server = ReplayMcpServer(scenario)
    connector = build_connector(scenario, server)

    status = asyncio.run(connector.status())
    assert status.state == expect["status"], status.human_readable_message
    if "status_message_contains" in expect:
        assert expect["status_message_contains"] in status.human_readable_message

    if "search_error" in expect:
        with pytest.raises(ConnectorUnavailableError) as exc:
            asyncio.run(connector.search("anything", USER))
        assert exc.value.code == expect["search_error"]
        assert server.tool_calls == []  # nothing is called when the mapping does not match
    if "search" in expect:
        spec = expect["search"]
        pages = asyncio.run(connector.search(spec["query"], USER, limit=5))
        assert [p.page_id for p in pages] == spec["page_ids"]
        for page_id, link in spec.get("links", {}).items():
            assert next(p for p in pages if p.page_id == page_id).source_uri == link
        for page_id, title in spec.get("titles", {}).items():
            assert next(p for p in pages if p.page_id == page_id).title == title
        dumped = json.dumps([p.__dict__ for p in pages], default=str, ensure_ascii=False)
        for marker in spec.get("absent_text", []):
            assert marker not in dumped
        assert all(p.space in scenario["config"]["allowlisted_spaces"] for p in pages)
        search_call = next(
            c for c in server.tool_calls if c["name"] == scenario["config"]["tool_map"]["search"]["tool"]
        )
        spaces_arg = scenario["config"]["tool_map"]["search"].get("spaces_arg")
        if spaces_arg:  # the space filter is sent to the server, not only applied afterwards
            assert search_call["arguments"][spaces_arg] == sorted(scenario["config"]["allowlisted_spaces"])
    if "read" in expect:
        spec = expect["read"]
        page = asyncio.run(connector.get_page(spec["page_id"], USER))
        assert page.title == spec["title"]
        assert spec["body_contains"] in page.body
        assert "<" not in page.body  # markup stripped; body is plain text
    for missing in expect.get("read_not_found", []):
        with pytest.raises(CorporatePageNotFoundError):
            asyncio.run(connector.get_page(missing, USER))
    assert server.closed_sessions and set(server.closed_sessions) == {server.session_id}


def test_replayed_pages_flow_into_grounded_answers(
    client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    scenario = load(SCENARIO_DIR / "01_flat_results_json.json")
    server = ReplayMcpServer(scenario)
    original = McpClient.__init__

    def patched(self: McpClient, **kwargs: Any) -> None:
        kwargs["transport"] = httpx.MockTransport(server.handler)
        original(self, **kwargs)

    monkeypatch.setattr(McpClient, "__init__", patched)
    config = scenario["config"]
    client = client_factory(
        confluence_connector="mcp",
        confluence_mcp_url=URL,
        confluence_mcp_auth_token=TOKEN,
        confluence_mcp_tool_map=json.dumps(config["tool_map"]),
        confluence_allowlisted_spaces=",".join(config["allowlisted_spaces"]),
        confluence_link_hosts=",".join(config["link_hosts"]),
    )
    answer = client.post(
        "/api/assistant/ask",
        json={"question": "Что указывает описание интеграции?", "sources": ["corporate"]},
    ).json()
    assert answer["citations"], answer
    citation = answer["citations"][0]
    assert citation["source_type"] == "confluence"
    assert citation["document_id"] == "1001"
    assert citation["source_uri"] == "https://confluence.test.example/pages/1001"
    assert TOKEN not in json.dumps(answer, ensure_ascii=False)
