"""TEST DOUBLE — a stateful, in-memory imitation of a small subset of the GitLab REST API v4.

THIS IS NOT GITLAB. It exists so the GitLab adapters and the full proposal lifecycle (branch →
commit → MR → merge → knowledge update) can be exercised offline: by pytest (in-process, through
`httpx.ASGITransport`) and by the browser E2E suite (as a loopback HTTP server). Passing tests against
it prove that the adapter honours the documented contract as modelled here — NOT that a real GitLab
instance behaves the same. Live validation is a separate, explicitly approved step
(docs/STAGING_TEST_RUNBOOK.md).

Modelled endpoints (documented GitLab REST v4 shapes, trimmed to the fields the app reads):
  GET  /api/v4/projects/:id
  GET  /api/v4/projects/:id/repository/tree            (keyset via Link header + offset fallback)
  GET  /api/v4/projects/:id/repository/files/:path     (path URL-encoded as ONE segment)
  GET  /api/v4/projects/:id/repository/branches/:name
  POST /api/v4/projects/:id/repository/branches
  GET  /api/v4/projects/:id/repository/commits         GET .../commits/:sha
  GET  /api/v4/projects/:id/repository/commits/:sha/merge_requests   (MRs that contain the commit)
  POST /api/v4/projects/:id/repository/commits         (protected branch → 403, stale last_commit_id → 400,
                                                         `create` of an existing file → 400)
  GET  /api/v4/projects/:id/repository/compare
  GET  /api/v4/projects/:id/merge_requests             GET .../merge_requests/:iid
  POST /api/v4/projects/:id/merge_requests             (duplicate open MR → 409)

Test controls (no GitLab equivalent): /__mock__/reset, /__mock__/state, /__mock__/commit,
/__mock__/merge-requests/:iid/merge|close, /__mock__/faults (status errors, timeouts and
"applied, but the answer was lost").

Run for E2E:  python -m tests.support.gitlab_mock --port 8929   (binds 127.0.0.1 only)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import Receive, Scope, Send

DEFAULT_TOKEN = "mock-gitlab-token-not-a-secret"
PROJECT_ID = "4242"
PROJECT_PATH = "skh-test/knowledge-base-MOCK"
DEFAULT_FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "knowledge"
_EPOCH = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)


def _blob_id(content: str) -> str:
    data = content.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


@dataclass
class Commit:
    id: str
    parents: list[str]
    message: str
    files: dict[str, str]  # full tree snapshot: path -> content
    committed_date: datetime

    def as_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "short_id": self.id[:8],
            "title": self.message.splitlines()[0] if self.message else "",
            "message": self.message,
            "parent_ids": self.parents,
            "committed_date": self.committed_date.isoformat().replace("+00:00", "Z"),
        }


@dataclass
class Fault:
    method: str
    path_contains: str
    mode: str = "status"  # status | apply_then_status | timeout | apply_then_timeout
    status: int = 503
    times: int = 1
    delay: float = 5.0
    skip: int = 0  # let the first `skip` matching requests through untouched


@dataclass
class MockState:
    base_url: str
    token: str = DEFAULT_TOKEN
    fixtures: Path = DEFAULT_FIXTURES
    commits: dict[str, Commit] = field(default_factory=dict)
    branches: dict[str, str] = field(default_factory=dict)
    protected: set[str] = field(default_factory=lambda: {"main"})
    mrs: list[dict[str, Any]] = field(default_factory=list)
    faults: list[Fault] = field(default_factory=list)
    requests: list[tuple[str, str]] = field(default_factory=list)
    protected_write_attempts: int = 0
    _counter: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # --- history --------------------------------------------------------------------------
    def reset(self) -> None:
        self.commits.clear()
        self.branches.clear()
        self.mrs.clear()
        self.faults.clear()
        self.requests.clear()
        self.protected_write_attempts = 0
        self._counter = 0
        files = {"README.md": "# Knowledge base (MOCK)\n\nOutside the knowledge path; never indexed.\n"}
        for path in sorted(self.fixtures.glob("*.md")):
            files[f"docs/{path.name}"] = path.read_text(encoding="utf-8")
        root = self.new_commit([], "Initial synthetic knowledge base (MOCK)", files)
        self.branches["main"] = root.id

    def new_commit(self, parents: list[str], message: str, files: dict[str, str]) -> Commit:
        self._counter += 1
        sha = hashlib.sha1(
            f"{self._counter}|{'|'.join(parents)}|{message}".encode(), usedforsecurity=False
        ).hexdigest()
        commit = Commit(sha, parents, message, dict(files), _EPOCH + timedelta(minutes=self._counter))
        self.commits[sha] = commit
        return commit

    def resolve(self, ref: str) -> Commit | None:
        sha = self.branches.get(ref, ref)
        return self.commits.get(sha)

    def ancestry(self, sha: str) -> list[str]:
        """sha and all its ancestors, newest first (first-parent order is enough here)."""
        seen: list[str] = []
        stack = [sha]
        while stack:
            current = stack.pop(0)
            if current in seen or current not in self.commits:
                continue
            seen.append(current)
            stack.extend(self.commits[current].parents)
        return seen

    def last_commit_for(self, head: str, path: str) -> str | None:
        """Commit that introduced the current content of `path` (git history simplification: follow
        a parent with identical content; the first commit without one changed the file)."""
        commit = self.commits.get(head)
        if commit is None or path not in commit.files:
            return None
        content = commit.files[path]
        while True:
            same = [
                p for p in commit.parents if p in self.commits and self.commits[p].files.get(path) == content
            ]
            if not same:
                return commit.id
            commit = self.commits[same[0]]

    def commit_on(self, branch: str, message: str, changes: dict[str, str | None]) -> Commit:
        """Apply `changes` (path -> new content, or None to delete the file) on top of `branch`."""
        head = self.commits[self.branches[branch]]
        files = {**head.files}
        for path, content in changes.items():
            if content is None:
                files.pop(path, None)
            else:
                files[path] = content
        commit = self.new_commit([head.id], message, files)
        self.branches[branch] = commit.id
        return commit

    def take_fault(self, method: str, path: str) -> Fault | None:
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

    def mr_json(self, mr: dict[str, Any]) -> dict[str, Any]:
        public = {k: v for k, v in mr.items() if k != "commit_shas"}  # internal bookkeeping only
        return {**public, "web_url": f"{self.base_url}/{PROJECT_PATH}/-/merge_requests/{mr['iid']}"}


def _error(status: int, message: Any) -> JSONResponse:
    return JSONResponse({"message": message}, status_code=status)


class GitLabMock:
    """ASGI application. Path parameters are parsed from the RAW path so that `%2F`-encoded file
    paths are checked exactly as GitLab requires."""

    def __init__(self, state: MockState) -> None:
        self.state = state
        if not state.commits:
            state.reset()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        request = Request(scope, receive)
        raw_path = scope.get("raw_path", b"").decode("latin-1").split("?", 1)[0] or scope["path"]
        response = await self.dispatch(request, raw_path)
        await response(scope, receive, send)

    async def dispatch(self, request: Request, raw_path: str) -> Response:
        state = self.state
        method = request.method
        if raw_path.startswith("/__mock__/"):
            return await self.control(request, raw_path)
        state.requests.append((method, unquote(raw_path)))
        if request.headers.get("PRIVATE-TOKEN") != state.token:
            return _error(401, "401 Unauthorized")
        fault = state.take_fault(method, unquote(raw_path))
        if fault and fault.mode in ("status", "timeout"):
            if fault.mode == "timeout":
                await asyncio.sleep(fault.delay)
            return _error(fault.status, f"simulated {fault.mode}")
        body: dict[str, Any] = {}
        if method == "POST":
            try:
                body = json.loads(await request.body() or b"{}")
            except ValueError:
                return _error(400, "invalid JSON")
        with state._lock:
            response = self.route(request, method, raw_path, body)
        if fault:  # apply_then_status / apply_then_timeout: the write happened, the answer is lost
            if fault.mode == "apply_then_timeout":
                await asyncio.sleep(fault.delay)
            return _error(fault.status, f"simulated {fault.mode}")
        return response

    # --- GitLab REST v4 subset ------------------------------------------------------------------
    def route(self, request: Request, method: str, raw_path: str, body: dict[str, Any]) -> Response:
        state = self.state
        prefixes = (f"/api/v4/projects/{PROJECT_ID}", f"/api/v4/projects/{quote(PROJECT_PATH, safe='')}")
        prefix = next((p for p in prefixes if raw_path == p or raw_path.startswith(p + "/")), None)
        if prefix is None:
            return _error(404, "404 Project Not Found")
        rest = raw_path[len(prefix) :]
        q = request.query_params
        if rest == "" and method == "GET":
            return JSONResponse(
                {
                    "id": int(PROJECT_ID),
                    "name": "knowledge-base-MOCK",
                    "path_with_namespace": PROJECT_PATH,
                    "default_branch": "main",
                    "web_url": f"{state.base_url}/{PROJECT_PATH}",
                }
            )
        if rest == "/repository/tree" and method == "GET":
            return self.tree(q.get("ref", "main"), q.get("path", ""), q)
        if rest.startswith("/repository/files/") and method == "GET":
            encoded = rest[len("/repository/files/") :]
            if "/" in encoded:
                return _error(400, "file_path must be URL-encoded")
            return self.file(unquote(encoded), q.get("ref", ""))
        if rest.startswith("/repository/branches/") and method == "GET":
            name = unquote(rest[len("/repository/branches/") :])
            if name not in state.branches:
                return _error(404, "404 Branch Not Found")
            head = state.commits[state.branches[name]]
            return JSONResponse(
                {"name": name, "protected": name in state.protected, "commit": head.as_json()}
            )
        if rest == "/repository/branches" and method == "POST":
            name, ref = q.get("branch", ""), q.get("ref", "")
            if not name or not ref:
                return _error(400, "branch and ref are required")
            if name in state.branches:
                return _error(400, "Branch already exists")
            source = state.resolve(ref)
            if source is None:
                return _error(400, "Invalid reference name")
            state.branches[name] = source.id
            return JSONResponse(
                {"name": name, "protected": False, "commit": source.as_json()}, status_code=201
            )
        if rest == "/repository/commits" and method == "GET":
            head = state.resolve(q.get("ref_name", "main"))
            if head is None:
                return JSONResponse([])
            per_page = int(q.get("per_page", "20"))
            return JSONResponse([state.commits[s].as_json() for s in state.ancestry(head.id)[:per_page]])
        if rest.startswith("/repository/commits/") and rest.endswith("/merge_requests") and method == "GET":
            sha = rest[len("/repository/commits/") : -len("/merge_requests")]
            if sha not in state.commits:
                return _error(404, "404 Commit Not Found")
            found = [
                m for m in state.mrs if sha in m.get("commit_shas", []) or m.get("merge_commit_sha") == sha
            ]
            return JSONResponse([state.mr_json(m) for m in found])
        if rest.startswith("/repository/commits/") and method == "GET":
            commit = state.commits.get(rest[len("/repository/commits/") :])
            return JSONResponse(commit.as_json()) if commit else _error(404, "404 Commit Not Found")
        if rest == "/repository/commits" and method == "POST":
            return self.create_commit(body)
        if rest == "/repository/compare" and method == "GET":
            base, target = state.resolve(q.get("from", "")), state.resolve(q.get("to", ""))
            if base is None or target is None:
                return _error(404, "404 Ref Not Found")
            known = set(state.ancestry(base.id))
            commits = [state.commits[s].as_json() for s in state.ancestry(target.id) if s not in known]
            return JSONResponse({"commits": list(reversed(commits)), "diffs": []})
        if rest == "/merge_requests" and method == "GET":
            found = [m for m in state.mrs if m["source_branch"] == q.get("source_branch", m["source_branch"])]
            wanted = q.get("state", "all")
            return JSONResponse([state.mr_json(m) for m in found if wanted in ("all", m["state"])])
        if rest == "/merge_requests" and method == "POST":
            return self.create_mr(body)
        if rest.startswith("/merge_requests/") and method == "GET":
            iid = rest[len("/merge_requests/") :]
            mr = next((m for m in state.mrs if str(m["iid"]) == iid), None)
            return JSONResponse(state.mr_json(mr)) if mr else _error(404, "404 Not found")
        return _error(404, "404 Not Found (not modelled by the mock)")

    def tree(self, ref: str, path: str, q: Any) -> Response:
        head = self.state.resolve(ref)
        if head is None:
            return _error(404, "404 Tree Not Found")
        prefix = path.strip("/")
        entries: dict[str, dict[str, Any]] = {}
        for file_path, content in head.files.items():
            if prefix and not file_path.startswith(prefix + "/"):
                continue
            parts = file_path.split("/")
            for depth in range(1, len(parts)):
                folder = "/".join(parts[:depth])
                if not prefix or folder.startswith(prefix + "/"):
                    entries[folder] = {
                        "id": hashlib.sha1(folder.encode(), usedforsecurity=False).hexdigest(),
                        "type": "tree",
                        "path": folder,
                        "name": parts[depth - 1],
                        "mode": "040000",
                    }
            entries[file_path] = {
                "id": _blob_id(content),
                "type": "blob",
                "path": file_path,
                "name": parts[-1],
                "mode": "100644",
            }
        items = [entries[k] for k in sorted(entries)]
        per_page = min(int(q.get("per_page", "20")), 100)
        per_page = min(per_page, 4)  # small pages on purpose: pagination is always exercised
        headers: dict[str, str] = {}
        if q.get("pagination") == "keyset":
            token = q.get("page_token")
            start = next((i + 1 for i, e in enumerate(items) if e["path"] == token), 0) if token else 0
            chunk = items[start : start + per_page]
            if start + per_page < len(items):
                next_url = (
                    f"{self.state.base_url}/api/v4/projects/{PROJECT_ID}/repository/tree?"
                    f"pagination=keyset&per_page={per_page}&page_token={quote(chunk[-1]['path'], safe='')}"
                    f"&ref={quote(ref, safe='')}&recursive=true"
                )
                headers["Link"] = f'<{next_url}>; rel="next"'
            return JSONResponse(chunk, headers=headers)
        page = int(q.get("page", "1"))
        chunk = items[(page - 1) * per_page : page * per_page]
        if page * per_page < len(items):
            headers["X-Next-Page"] = str(page + 1)
        return JSONResponse(chunk, headers=headers)

    def file(self, path: str, ref: str) -> Response:
        head = self.state.resolve(ref)
        if head is None or path not in head.files:
            return _error(404, "404 File Not Found")
        content = head.files[path]
        data = content.encode("utf-8")
        return JSONResponse(
            {
                "file_name": path.rsplit("/", 1)[-1],
                "file_path": path,
                "size": len(data),
                "encoding": "base64",
                "content": base64.b64encode(data).decode(),
                "ref": ref,
                "blob_id": _blob_id(content),
                "commit_id": head.id,
                "last_commit_id": self.state.last_commit_for(head.id, path),
            }
        )

    def create_commit(self, body: dict[str, Any]) -> Response:
        state = self.state
        branch = str(body.get("branch", ""))
        if branch not in state.branches:
            return _error(400, "You can only create or edit files when you are on a branch")
        if branch in state.protected:
            state.protected_write_attempts += 1
            return _error(403, "You are not allowed to push into this branch")
        actions = body.get("actions")
        if not isinstance(actions, list) or not actions:
            return _error(400, "actions is missing")
        head = state.commits[state.branches[branch]]
        changes: dict[str, str | None] = {}
        for action in actions:
            kind = action.get("action")
            path = str(action.get("file_path", ""))
            if kind == "create":
                if path in head.files:
                    return _error(400, "A file with this name already exists")
                changes[path] = str(action.get("content", ""))
                continue
            if kind != "update":
                return _error(400, "only `create` and `update` are modelled by the mock")
            if path not in head.files:
                return _error(400, "A file with this name doesn't exist")
            expected = action.get("last_commit_id")
            if expected and expected != state.last_commit_for(head.id, path):
                return _error(
                    400, "You are attempting to update a file that has changed since you started editing it."
                )
            changes[path] = str(action.get("content", ""))
        commit = state.commit_on(branch, str(body.get("commit_message", "")), changes)
        return JSONResponse(commit.as_json(), status_code=201)

    def create_mr(self, body: dict[str, Any]) -> Response:
        state = self.state
        source, target = str(body.get("source_branch", "")), str(body.get("target_branch", ""))
        if source not in state.branches or target not in state.branches:
            return _error(400, "Source or target branch does not exist")
        duplicate = next(
            (
                m
                for m in state.mrs
                if m["source_branch"] == source and m["target_branch"] == target and m["state"] == "opened"
            ),
            None,
        )
        if duplicate:
            return _error(
                409,
                [f"Another open merge request already exists for this source branch: !{duplicate['iid']}"],
            )
        mr = {
            "id": 9000 + len(state.mrs) + 1,
            "iid": len(state.mrs) + 1,
            "title": str(body.get("title", ""))[:255],
            "description": str(body.get("description", "")),
            "state": "opened",
            "source_branch": source,
            "target_branch": target,
            "merge_commit_sha": None,
            "remove_source_branch": bool(body.get("remove_source_branch")),
        }
        state.mrs.append(mr)
        return JSONResponse(state.mr_json(mr), status_code=201)

    # --- test controls --------------------------------------------------------------------------
    async def control(self, request: Request, raw_path: str) -> Response:
        state = self.state
        body: dict[str, Any] = {}
        if request.method == "POST":
            body = json.loads(await request.body() or b"{}")
        with state._lock:
            if raw_path == "/__mock__/reset" and request.method == "POST":
                state.reset()
                return JSONResponse({"ok": True})
            if raw_path == "/__mock__/state":
                return JSONResponse(
                    {
                        "branches": state.branches,
                        "merge_requests": [state.mr_json(m) for m in state.mrs],
                        "commits": len(state.commits),
                        "protected_write_attempts": state.protected_write_attempts,
                        "requests": len(state.requests),
                    }
                )
            if raw_path == "/__mock__/commit" and request.method == "POST":
                branch = str(body.get("branch", "main"))
                path = str(body["path"])
                head = state.commits[state.branches[branch]]
                content = body.get("content")
                if body.get("delete"):
                    content = None
                elif content is None:
                    content = head.files[path] + str(body.get("append", "\nИзменение другого автора.\n"))
                commit = state.commit_on(
                    branch, str(body.get("message", "Change by another author")), {path: content}
                )
                return JSONResponse(commit.as_json())
            if raw_path.startswith("/__mock__/merge-requests/") and request.method == "POST":
                _, _, _, iid, action = raw_path.split("/")
                mr = next((m for m in state.mrs if str(m["iid"]) == iid), None)
                if mr is None:
                    return _error(404, "no such MR")
                if action == "close":
                    mr["state"] = "closed"
                elif action == "merge":
                    if mr["state"] != "opened":
                        return _error(405, "MR is not open")
                    source = state.commits[state.branches[mr["source_branch"]]]
                    target = state.commits[state.branches[mr["target_branch"]]]
                    known = set(state.ancestry(target.id))
                    mr["commit_shas"] = [c for c in state.ancestry(source.id) if c not in known]
                    merged = state.new_commit(
                        [target.id, source.id],
                        f"Merge branch '{mr['source_branch']}' into '{mr['target_branch']}'",
                        {
                            **target.files,
                            **{p: c for p, c in source.files.items() if target.files.get(p) != c},
                        },
                    )
                    state.branches[mr["target_branch"]] = merged.id
                    mr["state"], mr["merge_commit_sha"] = "merged", merged.id
                    mr["merged_at"] = merged.committed_date.isoformat().replace("+00:00", "Z")
                    if mr.get("remove_source_branch"):
                        state.branches.pop(mr["source_branch"], None)
                return JSONResponse(state.mr_json(mr))
            if raw_path == "/__mock__/faults":
                if request.method == "DELETE":
                    state.faults.clear()
                    return JSONResponse({"ok": True})
                state.faults.append(Fault(**body))
                return JSONResponse({"ok": True, "faults": len(state.faults)})
        return _error(404, "unknown control endpoint")


def create_app(base_url: str, token: str = DEFAULT_TOKEN, fixtures: Path = DEFAULT_FIXTURES) -> GitLabMock:
    return GitLabMock(MockState(base_url=base_url, token=token, fixtures=fixtures))


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="TEST DOUBLE of a GitLab REST v4 subset (not GitLab).")
    parser.add_argument("--port", type=int, default=8929)
    parser.add_argument(
        "--host", default="127.0.0.1", help="0.0.0.0 only inside an isolated Docker test network"
    )
    parser.add_argument(
        "--public-url", default="", help="base URL the app uses (default http://127.0.0.1:<port>)"
    )
    parser.add_argument("--token", default=DEFAULT_TOKEN)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    args = parser.parse_args()
    app = create_app(args.public_url or f"http://127.0.0.1:{args.port}", args.token, args.fixtures)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
