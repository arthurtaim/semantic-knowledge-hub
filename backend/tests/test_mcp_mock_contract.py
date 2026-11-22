"""The read-only Confluence MCP connector against the stateful MCP TEST DOUBLE (tests/support/mcp_mock.py):
sessions, tools/list pagination, mapped search/read across spaces, provenance, versions and every
failure mode. In-process (httpx.ASGITransport); this proves the contract as modelled, not a real server."""

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
from app.adapters.corporate.confluence_mcp import ConfluenceMCPConnector, parse_result_map, parse_tool_map
from app.adapters.corporate.mcp_client import McpClient
from app.domain.models import UserContext
from tests.support.mcp_mock import DEFAULT_TOKEN, RESULT_MAP, TOOL_MAP, WEB_BASE, McpFault, McpMock

USER = UserContext(user_id="u", display_name="u")
URL = "https://mcp.mock.example/mcp"


class SlowTransport(httpx.AsyncBaseTransport):
    def __init__(self, app: McpMock, timeout: float) -> None:
        self._inner = httpx.ASGITransport(app=app)
        self._timeout = timeout

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await asyncio.wait_for(self._inner.handle_async_request(request), self._timeout)
        except TimeoutError as exc:
            raise httpx.ReadTimeout("simulated", request=request) from exc


def connector(
    mock: McpMock, *, spaces: str = "TEST,ARCH", tool_map: dict[str, Any] | None = None
) -> ConfluenceMCPConnector:
    return ConfluenceMCPConnector(
        McpClient(url=URL, token=SecretStr(DEFAULT_TOKEN), transport=SlowTransport(mock, 0.5)),
        tool_map=parse_tool_map(json.dumps(tool_map or TOOL_MAP)),
        allowlisted_spaces=spaces.split(","),
        link_hosts=["confluence.mock.example"],
        result_map=parse_result_map(json.dumps(RESULT_MAP)),
        web_base_url=WEB_BASE,
    )


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_discovery_follows_pagination_and_closes_sessions() -> None:
    mock = McpMock()
    status = run(connector(mock).status())
    assert status.state == "connected", status.human_readable_message
    assert "kb_search_pages" in status.details["tools"] and "issue_search" in status.details["tools"]
    assert len([c for c in mock.state.calls if c[0] == "tools/list"]) == 3  # 5 tools, 2 per page
    assert mock.state.sessions == set() and mock.state.closed_sessions >= 1


@pytest.mark.parametrize("reply_mode", ["json", "sse"])
def test_search_maps_results_with_provenance_and_allowlisted_spaces(reply_mode: str) -> None:
    mock = McpMock()
    mock.state.reply_mode = reply_mode
    pages = run(connector(mock).search("публикация тестовых страниц база знаний GitLab", USER))
    assert pages and {p.space for p in pages} <= {"TEST", "ARCH"}
    page = next(p for p in pages if p.page_id == "100001")
    assert page.title.startswith("Регламент публикации")
    assert page.source_uri == f"{WEB_BASE}/display/TEST/100001"
    assert page.version == "1" and page.updated_at is not None
    assert "<p>" not in page.body and "GitLab" in page.body
    # the write tool exposed by the server is never called by the read-only connector
    assert all(name != "kb_write_page" for _, name in mock.state.calls)


def test_non_allowlisted_space_is_dropped_even_if_the_server_returns_it() -> None:
    mock = McpMock()
    tool_map = json.loads(json.dumps(TOOL_MAP))
    tool_map["search"].pop("spaces_arg")  # the server cannot filter: the client must
    pages = run(connector(mock, tool_map=tool_map).search("Сопровождение интеграций синтетическая", USER))
    assert all(p.space != "OPS" for p in pages)


def test_read_reflects_new_versions() -> None:
    mock = McpMock()
    conn = connector(mock)
    assert run(conn.get_page("100002", USER)).version == "1"
    TestClient(mock).post("/__mock__/pages/100002/edit", json={"body": "<p>Новая редакция страницы.</p>"})
    page = run(conn.get_page("100002", USER))
    assert page.version == "2" and "Новая редакция" in page.body
    with pytest.raises(CorporatePageNotFoundError):
        run(conn.get_page("999999", USER))


@pytest.mark.parametrize(
    ("fault", "code"),
    [
        ("missing_tool", "mcp_tool_missing"),
        ("schema_mismatch", "mcp_tool_schema_mismatch"),
        ("auth", "mcp_auth_failed"),
        ("unavailable", "mcp_http_error"),
    ],
)
def test_configuration_and_availability_failures_are_explicit(fault: str, code: str) -> None:
    mock = McpMock()
    mock.state.faults.append(McpFault(mode=fault, times=100))
    conn = connector(mock)
    status = run(conn.status())
    assert status.state == "error"
    with pytest.raises(ConnectorUnavailableError) as info:
        run(conn.search("регламент", USER))
    assert info.value.code == code


@pytest.mark.parametrize(
    ("fault", "code"),
    [("malformed", "mcp_invalid_response"), ("rpc_error", "mcp_rpc_error"), ("timeout", "mcp_timeout")],
)
def test_transport_failures_during_a_call(fault: str, code: str) -> None:
    mock = McpMock()
    conn = connector(mock)
    assert run(conn.status()).state == "connected"  # discovery done; the call itself fails
    mock.state.faults.append(McpFault(mode=fault, method="tools/call", delay=2.0))
    with pytest.raises(ConnectorUnavailableError) as info:
        run(conn.search("регламент", USER))
    assert info.value.code == code


def test_tool_error_on_read_is_not_found_not_a_fake_page() -> None:
    mock = McpMock()
    conn = connector(mock)
    run(conn.status())
    mock.state.faults.append(McpFault(mode="tool_error", method="tools/call"))
    with pytest.raises(CorporatePageNotFoundError):
        run(conn.get_page("100001", USER))


def test_assistant_cites_corporate_pages_with_provenance(
    client_factory: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    mock = McpMock()
    original = McpClient.__init__

    def patched(self: McpClient, **kwargs: Any) -> None:
        kwargs["transport"] = SlowTransport(mock, 0.5)
        original(self, **kwargs)

    monkeypatch.setattr(McpClient, "__init__", patched)
    client = client_factory(
        integration_profile="integration_mock",
        mock_service_hosts="mcp.mock.example",
        confluence_connector="mcp",
        confluence_mcp_url=URL,
        confluence_mcp_auth_token=DEFAULT_TOKEN,
        confluence_mcp_tool_map=json.dumps(TOOL_MAP),
        confluence_mcp_result_map=json.dumps(RESULT_MAP),
        confluence_allowlisted_spaces="TEST,ARCH",
        confluence_link_hosts="confluence.mock.example",
        confluence_web_base_url=WEB_BASE,
    )
    answer = client.post(
        "/api/assistant/ask",
        json={"question": "Где хранится каноническая база знаний команды?", "sources": ["corporate"]},
    ).json()
    corporate = [c for c in answer["citations"] if c["source_type"] == "confluence"]
    assert corporate, answer
    citation = corporate[0]
    assert citation["document_id"] == "100001" and citation["revision"] == "1"
    assert citation["source_uri"] == f"{WEB_BASE}/display/TEST/100001"
    assert (
        " ".join(citation["excerpt"].split())
        in "Синтетическая страница. Публикация в тестовое пространство выполняется только после ревью. Каноническая база знаний команды хранится в отдельном репозитории GitLab."
    )
