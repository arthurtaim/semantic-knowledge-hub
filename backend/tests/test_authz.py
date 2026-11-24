"""Authorization enforcement points (docs/SSO_RBAC_REQUIREMENTS.md): every API route declares an
action, and a deny policy refuses all of them. There is no "open to everyone" mode."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.authz import Action, DenyAllPolicy, LocalDemoPolicy
from app.config import InsecureConfigurationError, security_violations
from app.domain.models import UserContext
from app.main import create_app

PUBLIC_ROUTES = {"/api/health"}
PROBE_ID = "0" * 32


def _actions(dependant: Any) -> set[Action]:
    found: set[Action] = set()
    for dep in dependant.dependencies:
        action = getattr(dep.call, "__skh_action__", None)
        if action is not None:
            found.add(action)
        found |= _actions(dep)
    return found


def _flatten(routes: list[Any]) -> list[APIRoute]:
    found: list[APIRoute] = []
    for route in routes:
        if isinstance(route, APIRoute):
            found.append(route)
        inner = getattr(route, "original_router", None)  # FastAPI wraps included routers
        if inner is not None:
            found.extend(_flatten(inner.routes))
    return found


def api_routes(client: TestClient) -> list[APIRoute]:
    return [r for r in _flatten(client.app.routes) if r.path.startswith("/api/")]  # type: ignore[attr-defined]


def test_every_api_route_declares_exactly_one_action(client: TestClient) -> None:
    routes = api_routes(client)
    assert len(routes) >= 20
    for route in routes:
        actions = _actions(route.dependant)
        if route.path in PUBLIC_ROUTES:
            assert actions == set(), route.path
        else:
            assert len(actions) == 1, (route.path, route.methods, actions)


def test_write_routes_require_write_actions(client: TestClient) -> None:
    expected = {
        ("POST", "/api/drafts"): Action.create_proposal,
        ("POST", "/api/drafts/{draft_id}/mark-ready"): Action.review_proposal,
        ("POST", "/api/drafts/{draft_id}/reject"): Action.review_proposal,
        ("POST", "/api/drafts/{draft_id}/submit"): Action.submit_proposal,
        ("POST", "/api/drafts/{draft_id}/open-mr"): Action.submit_proposal,
        ("POST", "/api/drafts/{draft_id}/refresh-status"): Action.submit_proposal,
        ("POST", "/api/index/sync"): Action.sync_knowledge,
        ("GET", "/api/corporate/pages/{page_id}"): Action.read_corporate,
        ("PUT", "/api/drafts/{draft_id}"): Action.create_proposal,
        ("DELETE", "/api/drafts/{draft_id}"): Action.create_proposal,
        ("POST", "/api/authoring/drafts"): Action.create_proposal,
        ("POST", "/api/authoring/check"): Action.create_proposal,
        ("POST", "/api/authoring/ai-draft"): Action.create_proposal,
        ("POST", "/api/drafts/{draft_id}/apply-template/preview"): Action.create_proposal,
        ("POST", "/api/drafts/{draft_id}/apply-template"): Action.create_proposal,
        ("POST", "/api/documents/{document_id}/apply-template/preview"): Action.create_proposal,
        ("POST", "/api/documents/{document_id}/apply-template"): Action.create_proposal,
        ("POST", "/api/documents/{document_id}/publication/prepare"): Action.prepare_publication,
        ("POST", "/api/publications/jobs/{job_id}/dry-run"): Action.prepare_publication,
        ("POST", "/api/publications/jobs/{job_id}/reconcile"): Action.prepare_publication,
        ("POST", "/api/publications/jobs/{job_id}/publish"): Action.publish_confluence,
        ("POST", "/api/publications/jobs/{job_id}/acknowledge-manual-edit"): Action.publish_confluence,
        ("POST", "/api/publications/jobs/{job_id}/release-missing-page"): Action.publish_confluence,
        ("GET", "/api/assistant/skills"): Action.ask_assistant,
        ("POST", "/api/assistant/attachments"): Action.ask_assistant,
        ("DELETE", "/api/assistant/attachments/{attachment_id}"): Action.ask_assistant,
    }
    seen = {(m, r.path): _actions(r.dependant) for r in api_routes(client) for m in r.methods}
    for key, action in expected.items():
        assert seen[key] == {action}, key


def _call(client: TestClient, route: APIRoute) -> int:
    path = route.path.replace("{draft_id}", PROBE_ID).replace("{document_id}", "SEM-ARCH-001")
    path = path.replace("{page_id}", "1001")
    method = sorted(route.methods)[0]
    params = {"q": "ARIS"} if path == "/api/search" else None
    body: dict[str, Any] | None = None
    if method == "POST":
        body = {"question": "Что такое ARIS?"} if path.endswith("/ask") else {}
    return client.request(method, path, params=params, json=body).status_code


def test_deny_policy_refuses_every_route(client: TestClient) -> None:
    client.app.state.container.policy = DenyAllPolicy()  # type: ignore[attr-defined]
    for route in api_routes(client):
        if route.path in PUBLIC_ROUTES:
            continue
        status = _call(client, route)
        assert status in (403, 422), (route.path, status)  # 422 only where the body is invalid first
    assert client.get("/api/documents").json()["code"] == "forbidden"
    assert client.get("/api/health").status_code == 200


def test_corporate_scope_needs_its_own_permission(client: TestClient) -> None:
    class TeamOnly:
        name = "team_only"

        def allows(self, user: UserContext, action: Action) -> bool:
            return action != Action.read_corporate

    client.app.state.container.policy = TeamOnly()  # type: ignore[attr-defined]
    assert client.get("/api/search", params={"q": "ARIS"}).status_code == 200
    assert client.get("/api/search", params={"q": "ARIS", "source": "team,corporate"}).status_code == 403
    denied = client.post("/api/assistant/ask", json={"question": "Что такое ARIS?", "sources": ["corporate"]})
    assert denied.status_code == 403


def test_local_demo_policy_is_single_operator_only(settings_factory: Callable[..., Any]) -> None:
    demo = UserContext(user_id="local-demo-user", display_name="demo", is_demo=True)
    other = UserContext(user_id="someone", display_name="x", is_demo=False)
    assert LocalDemoPolicy().allows(demo, Action.submit_proposal)
    assert not LocalDemoPolicy().allows(other, Action.read_knowledge)
    # the demo policy is only reachable on loopback; a shared bind refuses to start
    problems = security_violations(settings_factory(app_host="0.0.0.0"), in_container=False)
    assert any("loopback" in p for p in problems)
    # SSO mode is refused until a real identity provider and RBAC exist
    assert any("sso" in p.lower() for p in security_violations(settings_factory(auth_mode="sso")))


@pytest.mark.parametrize("mode", ["local_demo"])
def test_session_reports_the_active_policy(client_factory: Callable[..., TestClient], mode: str) -> None:
    session = client_factory(auth_mode=mode).get("/api/session").json()
    assert session["authorization_policy"] == "local_demo_single_operator"


def test_sso_mode_has_no_open_fallback(settings_factory: Callable[..., Any]) -> None:
    with pytest.raises(InsecureConfigurationError, match="AUTH_MODE=sso"):
        create_app(settings_factory(auth_mode="sso"))
