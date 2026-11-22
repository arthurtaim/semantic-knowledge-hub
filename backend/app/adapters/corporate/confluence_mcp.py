"""ConfluenceMCPConnector: read-only corporate knowledge through an approved internal MCP server.

Tool names are never guessed: the operator maps business capabilities to discovered tools via
CONFLUENCE_MCP_TOOL_MAP, and the mapping is verified against `tools/list` before use.
Page content is untrusted data; spaces are allowlisted; links are validated against allowlisted hosts.
"""

from __future__ import annotations

import html
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import nh3

from app.adapters.corporate.base import (
    ConnectorUnavailableError,
    CorporatePage,
    CorporatePageNotFoundError,
)
from app.adapters.corporate.mcp_client import McpClient, McpError
from app.domain.models import IntegrationStatus, UserContext
from app.domain.text import strip_control

logger = logging.getLogger("skh.confluence.mcp")

STATUS_TTL_SECONDS = 60.0
PAGE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


@dataclass(frozen=True)
class ToolMapping:
    search_tool: str
    query_arg: str
    limit_arg: str | None
    spaces_arg: str | None
    read_tool: str
    id_arg: str


def parse_tool_map(raw: str) -> ToolMapping | None:
    """Parse CONFLUENCE_MCP_TOOL_MAP (JSON). Returns None when not configured or invalid."""
    if not raw.strip():
        return None
    try:
        data = json.loads(raw)
        search, read = data["search"], data["read"]
        return ToolMapping(
            search_tool=str(search["tool"]),
            query_arg=str(search.get("query_arg", "query")),
            limit_arg=str(search["limit_arg"]) if search.get("limit_arg") else None,
            spaces_arg=str(search["spaces_arg"]) if search.get("spaces_arg") else None,
            read_tool=str(read["tool"]),
            id_arg=str(read.get("id_arg", "page_id")),
        )
    except (ValueError, KeyError, TypeError):
        return None


DEFAULT_RESULT_MAP: dict[str, tuple[str, ...]] = {
    "items": ("results", "pages", "items"),
    "id": ("id", "page_id", "pageId", "content_id", "content.id"),
    "space": ("space", "space_key", "spaceKey", "space.key", "content.space.key"),
    "title": ("title", "name", "content.title"),
    "body": ("excerpt", "body", "text", "content", "body.storage.value", "content.body.storage.value"),
    "url": ("url", "link", "_links.webui", "content._links.webui"),
    "version": ("version.number", "version", "content.version.number"),
    "updated": ("updated_at", "lastModified", "version.when", "content.version.when"),
}


def parse_result_map(raw: str) -> dict[str, tuple[str, ...]] | None:
    """Merge CONFLUENCE_MCP_RESULT_MAP overrides (path or list of paths per field) into defaults.
    Returns None if the JSON is invalid."""
    mapping = dict(DEFAULT_RESULT_MAP)
    if not raw.strip():
        return mapping
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    for key, value in data.items():
        if key not in DEFAULT_RESULT_MAP:
            return None
        paths = (value,) if isinstance(value, str) else tuple(value) if isinstance(value, list) else None
        if not paths or not all(isinstance(p, str) and p for p in paths):
            return None
        mapping[key] = paths + tuple(p for p in DEFAULT_RESULT_MAP[key] if p not in paths)
    return mapping


def _resolve(item: Any, path: str) -> Any:
    value = item
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _first(item: dict[str, Any], *keys: str) -> Any:
    """First scalar found under the given dotted paths (dicts/lists are never stringified)."""
    for key in keys:
        value = _resolve(item, key)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool) and value != "":
            return value
    return None


def _payload(result: dict[str, Any]) -> Any:
    structured = result.get("structuredContent")
    if structured is not None:
        return structured
    for block in result.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            try:
                return json.loads(str(block.get("text", "")))
            except json.JSONDecodeError:
                continue
    raise McpError("mcp_unrecognized_result", "Ответ инструмента MCP не удалось разобрать как JSON.")


class ConfluenceMCPConnector:
    name = "confluence_mcp"
    enabled = True

    def __init__(
        self,
        client: McpClient,
        *,
        tool_map: ToolMapping | None,
        allowlisted_spaces: list[str],
        link_hosts: list[str],
        max_body_chars: int = 4000,
        result_map: dict[str, tuple[str, ...]] | None = None,
        web_base_url: str = "",
        result_map_valid: bool = True,
    ) -> None:
        self._client = client
        self._map = tool_map
        self._spaces = frozenset(allowlisted_spaces)
        self._link_hosts = frozenset(h.lower() for h in link_hosts)
        self._max_body_chars = max_body_chars
        self._fields = result_map or dict(DEFAULT_RESULT_MAP)
        self._result_map_valid = result_map_valid
        self._web_base = web_base_url.rstrip("/")
        self._verified_at = 0.0
        self._status_cache: tuple[float, IntegrationStatus] | None = None

    # --- configuration checks ----------------------------------------------------------------------
    def _config_problem(self) -> str | None:
        if not self._result_map_valid:
            return "некорректный CONFLUENCE_MCP_RESULT_MAP."
        if self._map is None:
            return "не задано сопоставление инструментов CONFLUENCE_MCP_TOOL_MAP."
        if not self._spaces:
            return "не задан список разрешённых пространств CONFLUENCE_ALLOWLISTED_SPACES."
        return None

    async def _verify_tools(self) -> list[str]:
        """Discover tools and check that mapped tools and arguments exist. Returns tool names."""
        if self._map is None:
            raise McpError("mcp_not_configured", "Сопоставление инструментов MCP не задано.")
        tools = await self._client.list_tools()
        by_name = {str(t.get("name")): t for t in tools}
        for tool, args in (
            (self._map.search_tool, [self._map.query_arg, self._map.limit_arg, self._map.spaces_arg]),
            (self._map.read_tool, [self._map.id_arg]),
        ):
            if tool not in by_name:
                raise McpError("mcp_tool_missing", f"Инструмент «{tool}» не найден на MCP-сервере.")
            schema = by_name[tool].get("inputSchema") or {}
            properties = schema.get("properties") if isinstance(schema, dict) else None
            if isinstance(properties, dict):
                missing = [a for a in args if a and a not in properties]
                if missing:
                    raise McpError(
                        "mcp_tool_schema_mismatch",
                        f"У инструмента «{tool}» нет аргументов: {', '.join(missing)}.",
                    )
        self._verified_at = time.monotonic()
        return sorted(by_name)

    async def _ready_mapping(self) -> ToolMapping:
        problem = self._config_problem()
        if problem or self._map is None:
            raise ConnectorUnavailableError("corporate_source_misconfigured", f"Confluence MCP: {problem}")
        if time.monotonic() - self._verified_at > STATUS_TTL_SECONDS:
            try:
                await self._verify_tools()
            except McpError as exc:
                raise ConnectorUnavailableError(exc.code, exc.message) from exc
        return self._map

    # --- mapping of untrusted results ----------------------------------------------------------------
    def _safe_link(self, url: Any, space: str, page_id: str) -> str:
        """Only https links to allowlisted hosts survive, rebuilt from parsed parts. Backslashes,
        whitespace, userinfo and explicit ports are rejected (browsers parse those differently)."""
        fallback = f"confluence://{space}/{page_id}"
        if isinstance(url, str) and url.startswith("/") and not url.startswith("//") and self._web_base:
            url = self._web_base + url  # relative Confluence link (e.g. _links.webui)
        if not isinstance(url, str) or len(url) > 2048 or any(c in url for c in "\\ \t\r\n"):
            return fallback
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError:
            return fallback
        host = (parts.hostname or "").lower()
        if parts.scheme != "https" or parts.username or parts.password or port is not None:
            return fallback
        if host not in self._link_hosts:
            return fallback
        return urlunsplit(("https", host, parts.path or "/", parts.query, ""))

    def _to_page(self, item: Any) -> CorporatePage | None:
        if not isinstance(item, dict):
            return None
        f = self._fields
        page_id = _first(item, *f["id"])
        space = _first(item, *f["space"])
        title = _first(item, *f["title"])
        if page_id is None or space is None or title is None:
            return None
        if not PAGE_ID_RE.fullmatch(str(page_id)):  # IDs end up in URLs and model context
            return None
        space = str(space)
        if space not in self._spaces:  # defence in depth: never surface non-allowlisted spaces
            return None
        raw_body = _first(item, *f["body"])
        # Strip markup, then decode entities: the body is only ever rendered as plain text.
        body = strip_control(html.unescape(nh3.clean(str(raw_body or ""), tags=set())))[
            : self._max_body_chars
        ]
        version = _first(item, *f["version"])
        updated = _first(item, *f["updated"])
        updated_at = None
        if isinstance(updated, str):
            try:
                updated_at = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            except ValueError:
                updated_at = None
        return CorporatePage(
            page_id=str(page_id)[:64],
            space=space,
            title=strip_control(html.unescape(nh3.clean(str(title), tags=set())))[:300],
            body=body,
            source_uri=self._safe_link(_first(item, *f["url"]), space, str(page_id)),
            version=str(version) if version is not None else "",
            updated_at=updated_at,
            is_mock=False,
        )

    # --- CorporateKnowledgeConnector -------------------------------------------------------------------
    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        mapping = await self._ready_mapping()
        arguments: dict[str, Any] = {mapping.query_arg: query[:500]}
        if mapping.limit_arg:
            arguments[mapping.limit_arg] = max(1, min(limit, 20))
        if mapping.spaces_arg:
            arguments[mapping.spaces_arg] = sorted(self._spaces)  # filter before retrieval
        try:
            payload = _payload(await self._client.call_tool(mapping.search_tool, arguments))
        except McpError as exc:
            raise ConnectorUnavailableError(exc.code, exc.message) from exc
        items: Any = payload
        if isinstance(payload, dict):
            items = next(
                (v for v in (_resolve(payload, p) for p in self._fields["items"]) if isinstance(v, list)), []
            )
        pages = [p for p in (self._to_page(i) for i in (items if isinstance(items, list) else [])) if p]
        return pages[:limit]

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage:
        mapping = await self._ready_mapping()
        try:
            payload = _payload(await self._client.call_tool(mapping.read_tool, {mapping.id_arg: page_id}))
        except McpError as exc:
            if exc.code == "mcp_tool_error":
                raise CorporatePageNotFoundError(page_id) from exc
            raise ConnectorUnavailableError(exc.code, exc.message) from exc
        page = self._to_page(payload.get("page", payload) if isinstance(payload, dict) else None)
        if page is None:
            raise CorporatePageNotFoundError(page_id)
        return page

    async def status(self) -> IntegrationStatus:
        base = {
            "name": self.name,
            "title": "Confluence Data Center (MCP, только чтение)",
            "kind": "corporate_knowledge",
        }
        now = time.monotonic()
        if self._status_cache and now - self._status_cache[0] < STATUS_TTL_SECONDS:
            return self._status_cache[1]
        problem = self._config_problem()
        if problem:
            status = IntegrationStatus(
                **base, state="error", capabilities=[], human_readable_message=f"Не настроено: {problem}"
            )
        else:
            try:
                tools = await self._verify_tools()
                status = IntegrationStatus(
                    **base,
                    state="connected",
                    capabilities=["search_pages", "read_page"],
                    details={
                        "tools": ", ".join(tools[:20]),
                        "spaces": ",".join(sorted(self._spaces)),
                        "auth_model": "service_account",
                    },
                    human_readable_message=(
                        "Подключено: инструменты MCP обнаружены и сопоставлены. Общий сервисный токен: права "
                        "пользователей Confluence не проверяются — допустим только однопользовательский "
                        "тестовый контур."
                    ),
                )
            except McpError as exc:
                status = IntegrationStatus(
                    **base,
                    state="error",
                    capabilities=[],
                    human_readable_message=f"MCP недоступен: {exc.message}",
                )
        self._status_cache = (now, status)
        return status
