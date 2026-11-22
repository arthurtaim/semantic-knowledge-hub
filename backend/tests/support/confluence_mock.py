"""TEST DOUBLE — a stateful, in-memory imitation of a small subset of the Confluence **Data Center**
REST API (`/rest/api`, as documented for Server/DC — not the Cloud v2 API).

THIS IS NOT CONFLUENCE. It lets the M5 publisher be exercised offline (pytest in-process via
httpx.ASGITransport; browser E2E and Docker as an HTTP server). Passing tests prove the adapter honours
the contract as modelled here, not that a real Confluence DC instance behaves identically — differences
(storage normalisation, property limits, permissions, version rules) are live-validation items
(docs/M4_M5_INTEGRATION_READINESS.md).

Modelled endpoints:
  GET  /rest/api/space/:key
  GET  /rest/api/content/:id?expand=body.storage,version,space,ancestors
  GET  /rest/api/content?spaceKey=&title=&type=page&expand=
  POST /rest/api/content            (create; `metadata.properties`; duplicate title in space → 400)
  PUT  /rest/api/content/:id        (update; version must be current + 1 → otherwise 409)
  GET  /rest/api/content/:id/property/:key      POST /rest/api/content/:id/property
Storage bodies are lightly normalised on write (as Confluence re-serialises XHTML), so clients must
hash what they read back, not what they sent.

Test controls: POST /__mock__/reset · GET /__mock__/state · POST /__mock__/pages/:id/edit (manual
edit: new version) · POST /__mock__/faults (status | apply_then_status | timeout | apply_then_timeout
| corrupt) · POST /__mock__/tokens (read_only token for 403 on writes).

Run for E2E:  python -m tests.support.confluence_mock --port 8931
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import unquote, urlsplit

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import Receive, Scope, Send

DEFAULT_TOKEN = "mock-confluence-publish-token-not-a-secret"
READONLY_TOKEN = "mock-confluence-readonly-token-not-a-secret"
TEST_SPACE = "SKHTEST"
PARENT_PAGE_ID = "5000001"
FOREIGN_PAGE_ID = "5000002"
OTHER_SPACE_PAGE_ID = "6000001"
_EPOCH = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)


def normalise(storage: str) -> str:
    """Imitation of Confluence re-serialisation: trimmed body, self-closing tags without a space."""
    return re.sub(r"<(br|hr)\s*/>", r"<\1/>", storage.strip())


@dataclass
class ConfluenceFault:
    method: str
    path_contains: str
    mode: str = "status"
    status: int = 503
    times: int = 1
    delay: float = 5.0
    skip: int = 0


@dataclass
class ConfluenceMockState:
    base_url: str
    token: str = DEFAULT_TOKEN
    readonly_token: str = READONLY_TOKEN
    spaces: dict[str, dict[str, Any]] = field(default_factory=dict)
    pages: dict[str, dict[str, Any]] = field(default_factory=dict)
    faults: list[ConfluenceFault] = field(default_factory=list)
    requests: list[tuple[str, str]] = field(default_factory=list)
    _next_id: int = 7000000
    _clock: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def now(self) -> str:
        self._clock += 1
        return (_EPOCH + timedelta(minutes=self._clock)).isoformat().replace("+00:00", "Z")

    def reset(self) -> None:
        self.spaces = {
            TEST_SPACE: {
                "key": TEST_SPACE,
                "name": "[TEST] База знаний семантического слоя (MOCK)",
                "type": "global",
            },
            "OTHER": {"key": "OTHER", "name": "Чужое пространство (MOCK)", "type": "global"},
        }
        self.pages = {}
        self.faults.clear()
        self.requests.clear()
        self._next_id = 7000000
        self._clock = 0
        self._add(
            PARENT_PAGE_ID, TEST_SPACE, "База знаний команды (MOCK)", "<p>Родительская страница.</p>", None
        )
        self._add(
            FOREIGN_PAGE_ID,
            TEST_SPACE,
            "Чужая страница (MOCK)",
            "<p>Страница, созданная человеком; приложение не должно её менять.</p>",
            PARENT_PAGE_ID,
        )
        self._add(OTHER_SPACE_PAGE_ID, "OTHER", "Страница другого пространства (MOCK)", "<p>Чужое.</p>", None)

    def _add(self, page_id: str, space: str, title: str, storage: str, parent: str | None) -> dict[str, Any]:
        page = {
            "id": page_id,
            "space": space,
            "title": title,
            "storage": normalise(storage),
            "version": 1,
            "when": self.now(),
            "parent": parent,
            "properties": {},
            "history": [],
        }
        self.pages[page_id] = page
        return page

    def take_fault(self, method: str, path: str) -> ConfluenceFault | None:
        for fault in self.faults:
            if fault.method == method and fault.path_contains in path and fault.times > 0:
                if fault.skip > 0:
                    fault.skip -= 1
                    return None
                fault.times -= 1
                if fault.times == 0:
                    self.faults.remove(fault)
                return fault
        return None

    def page_json(self, page: dict[str, Any], *, with_body: bool = True) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": page["id"],
            "type": "page",
            "status": "current",
            "title": page["title"],
            "space": {"key": page["space"], "name": self.spaces.get(page["space"], {}).get("name", "")},
            "version": {"number": page["version"], "when": page["when"]},
            "ancestors": [{"id": page["parent"]}] if page["parent"] else [],
            "_links": {"webui": f"/pages/viewpage.action?pageId={page['id']}", "base": self.base_url},
        }
        if with_body:
            data["body"] = {"storage": {"value": page["storage"], "representation": "storage"}}
        return data

    def write_count(self) -> int:
        return sum(1 for m, _ in self.requests if m in ("POST", "PUT", "DELETE"))


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"statusCode": status, "message": message}, status_code=status)


class ConfluenceMock:
    def __init__(self, state: ConfluenceMockState) -> None:
        self.state = state
        if not state.spaces:
            state.reset()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        request = Request(scope, receive)
        response = await self.dispatch(request)
        await response(scope, receive, send)

    async def dispatch(self, request: Request) -> Response:
        state = self.state
        path = unquote(request.url.path)
        method = request.method
        if path.startswith("/__mock__/"):
            return await self.control(request, path)
        context = urlsplit(state.base_url).path.rstrip("/")  # e.g. /confluence (DC context path)
        if context and path.startswith(context + "/"):
            path = path[len(context) :]
        state.requests.append((method, path))
        auth = request.headers.get("Authorization", "")
        if auth not in (f"Bearer {state.token}", f"Bearer {state.readonly_token}"):
            return _error(401, "Unauthorized")
        if method in ("POST", "PUT") and auth == f"Bearer {state.readonly_token}":
            return _error(403, "User is not permitted to edit this content")
        fault = state.take_fault(method, path)
        if fault and fault.mode in ("status", "timeout"):
            if fault.mode == "timeout":
                await asyncio.sleep(fault.delay)
            return _error(fault.status, f"simulated {fault.mode}")
        body: dict[str, Any] = {}
        if method in ("POST", "PUT"):
            try:
                body = json.loads(await request.body() or b"{}")
            except ValueError:
                return _error(400, "invalid JSON")
        with state._lock:
            response = self.route(request, method, path, body)
        if fault:
            if fault.mode == "apply_then_timeout":
                await asyncio.sleep(fault.delay)
            if fault.mode == "corrupt":
                return Response("<html>gateway</html>", status_code=200, media_type="application/json")
            return _error(fault.status, f"simulated {fault.mode}")
        return response

    def route(self, request: Request, method: str, path: str, body: dict[str, Any]) -> Response:
        state = self.state
        q = request.query_params
        if path.startswith("/rest/api/space/") and method == "GET":
            space = state.spaces.get(path.rsplit("/", 1)[-1])
            return JSONResponse(space) if space else _error(404, "No space with key")
        match = re.fullmatch(r"/rest/api/content/([^/]+)/property/([^/]+)", path)
        if match and method == "GET":
            page = state.pages.get(match.group(1))
            prop = page["properties"].get(match.group(2)) if page else None
            if prop is None:
                return _error(404, "Cannot find content property")
            return JSONResponse(
                {"key": match.group(2), "value": prop["value"], "version": {"number": prop["version"]}}
            )
        match = re.fullmatch(r"/rest/api/content/([^/]+)/property", path)
        if match and method == "POST":
            page = state.pages.get(match.group(1))
            if page is None:
                return _error(404, "No content")
            key = str(body.get("key", ""))
            if key in page["properties"]:
                return _error(409, "Property already exists")
            page["properties"][key] = {"value": body.get("value"), "version": 1}
            return JSONResponse({"key": key, "value": body.get("value"), "version": {"number": 1}})
        if path == "/rest/api/content" and method == "GET":
            found = [
                state.page_json(p)
                for p in state.pages.values()
                if p["space"] == q.get("spaceKey") and p["title"] == q.get("title")
            ]
            return JSONResponse({"results": found, "start": 0, "limit": 25, "size": len(found)})
        if path == "/rest/api/content" and method == "POST":
            return self.create(body)
        match = re.fullmatch(r"/rest/api/content/([^/]+)", path)
        if match and method == "GET":
            page = state.pages.get(match.group(1))
            return JSONResponse(state.page_json(page)) if page else _error(404, "No content found")
        if match and method == "PUT":
            return self.update(match.group(1), body)
        return _error(404, "Not modelled by the mock")

    def create(self, body: dict[str, Any]) -> Response:
        state = self.state
        space = str((body.get("space") or {}).get("key", ""))
        title = str(body.get("title", "")).strip()
        if body.get("type") != "page" or not title:
            return _error(400, "type=page and title are required")
        if space not in state.spaces:
            return _error(404, "No space with key")
        ancestors = body.get("ancestors") or []
        parent = str(ancestors[0].get("id")) if ancestors else None
        if parent and (parent not in state.pages or state.pages[parent]["space"] != space):
            return _error(404, "Parent page not found in space")
        if any(p["space"] == space and p["title"] == title for p in state.pages.values()):
            return _error(400, "A page with this title already exists")
        storage = str(((body.get("body") or {}).get("storage") or {}).get("value", ""))
        state._next_id += 1
        page = state._add(str(state._next_id), space, title, storage, parent)
        for key, prop in ((body.get("metadata") or {}).get("properties") or {}).items():
            page["properties"][str(key)] = {"value": (prop or {}).get("value"), "version": 1}
        return JSONResponse(state.page_json(page))

    def update(self, page_id: str, body: dict[str, Any]) -> Response:
        state = self.state
        page = state.pages.get(page_id)
        if page is None:
            return _error(404, "No content found")
        number = (body.get("version") or {}).get("number")
        if number != page["version"] + 1:
            return _error(409, f"Version must be incremented: current {page['version']}")
        title = str(body.get("title", page["title"])).strip()
        if any(
            p["space"] == page["space"] and p["title"] == title and p["id"] != page_id
            for p in state.pages.values()
        ):
            return _error(400, "A page with this title already exists")
        page["history"].append(
            {"version": page["version"], "storage": page["storage"], "title": page["title"]}
        )
        page["title"] = title
        page["storage"] = normalise(str(((body.get("body") or {}).get("storage") or {}).get("value", "")))
        page["version"] = int(number)
        page["when"] = state.now()
        return JSONResponse(state.page_json(page))

    async def control(self, request: Request, path: str) -> Response:
        state = self.state
        body: dict[str, Any] = {}
        if request.method == "POST":
            body = json.loads(await request.body() or b"{}")
        with state._lock:
            if path == "/__mock__/reset":
                state.reset()
                return JSONResponse({"ok": True})
            if path == "/__mock__/state":
                return JSONResponse(
                    {
                        "pages": [
                            {
                                "id": p["id"],
                                "space": p["space"],
                                "title": p["title"],
                                "version": p["version"],
                                "parent": p["parent"],
                                "properties": {k: v["value"] for k, v in p["properties"].items()},
                                "storage": p["storage"],
                            }
                            for p in state.pages.values()
                        ],
                        "write_requests": state.write_count(),
                        "requests": [list(r) for r in state.requests],
                    }
                )
            match = re.fullmatch(r"/__mock__/pages/([^/]+)/edit", path)
            if match:
                page = state.pages.get(match.group(1))
                if page is None:
                    return _error(404, "no such page")
                page["history"].append(
                    {"version": page["version"], "storage": page["storage"], "title": page["title"]}
                )
                page["storage"] = normalise(
                    str(body.get("storage", page["storage"] + "\n<p>Ручная правка.</p>"))
                )
                page["title"] = str(body.get("title", page["title"]))
                page["version"] += 1
                page["when"] = state.now()
                return JSONResponse({"version": page["version"]})
            if path == "/__mock__/faults":
                if request.method == "DELETE":
                    state.faults.clear()
                    return JSONResponse({"ok": True})
                state.faults.append(ConfluenceFault(**body))
                return JSONResponse({"ok": True})
            if path == "/__mock__/tokens":
                state.token = str(body.get("token", state.token))
                return JSONResponse({"ok": True})
        return _error(404, "unknown control endpoint")


def create_app(base_url: str, token: str = DEFAULT_TOKEN) -> ConfluenceMock:
    return ConfluenceMock(ConfluenceMockState(base_url=base_url, token=token))


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(
        description="TEST DOUBLE of a Confluence Data Center REST subset (not Confluence)."
    )
    parser.add_argument("--port", type=int, default=8931)
    parser.add_argument(
        "--host", default="127.0.0.1", help="0.0.0.0 only inside an isolated Docker test network"
    )
    parser.add_argument(
        "--public-url", default="", help="base URL the app uses (default http://127.0.0.1:<port>)"
    )
    parser.add_argument("--token", default=DEFAULT_TOKEN)
    args = parser.parse_args()
    app = create_app(args.public_url or f"http://127.0.0.1:{args.port}", args.token)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
