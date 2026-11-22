"""Authorization enforcement points (docs/SSO_RBAC_REQUIREMENTS.md).

Every API route (except /api/health) declares the Action it performs through `require(action)`;
a test enumerates the routes and fails if one is missing. The decision is delegated to an
AuthorizationPolicy.

Only one policy is usable today: LocalDemoPolicy — a single local operator on a loopback-only
deployment (enforced at startup by `security_violations`). It is NOT a multiuser authorization model.
A corporate SSO/RBAC policy must replace it before any shared deployment; AUTH_MODE=sso refuses to
start until then. There is deliberately no "allow everyone" switch for shared deployments.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Protocol

from fastapi import Request

from app.domain.models import UserContext
from app.errors import ApiError


class Action(StrEnum):
    read_knowledge = "read_knowledge"  # catalog, documents, team search, facets, issues
    read_corporate = "read_corporate"  # Confluence pages via MCP (must respect the user's Confluence ACL)
    ask_assistant = "ask_assistant"  # grounded answers over readable sources
    view_system = "view_system"  # session, integration and sync status
    create_proposal = "create_proposal"  # proposals and AI edit suggestions (never modify the source)
    review_proposal = "review_proposal"  # mark ready for review / reject locally
    submit_proposal = "submit_proposal"  # GitLab write: branch, commit, MR (and MR status checks)
    sync_knowledge = "sync_knowledge"  # manual re-synchronisation / re-index


class AuthorizationPolicy(Protocol):
    name: str

    def allows(self, user: UserContext, action: Action) -> bool: ...


class LocalDemoPolicy:
    """Single local operator. Valid only with AUTH_MODE=local_demo bound to loopback."""

    name = "local_demo_single_operator"

    def allows(self, user: UserContext, action: Action) -> bool:
        return user.is_demo


class DenyAllPolicy:
    """Fail-closed policy (used when no identity provider is configured, and in tests)."""

    name = "deny_all"

    def allows(self, user: UserContext, action: Action) -> bool:
        return False


def ensure_allowed(policy: AuthorizationPolicy, user: UserContext, action: Action) -> None:
    """Secondary check inside a route (e.g. a search that also reaches Confluence)."""
    if not policy.allows(user, action):
        raise ApiError(403, "forbidden", "Недостаточно прав для этого действия.", {"action": action.value})


def require(action: Action) -> Callable[[Request], Awaitable[UserContext]]:
    """FastAPI dependency: resolve the user, then check `action` against the container's policy."""
    from app.api.deps import get_container, get_user  # local import: deps imports the container

    async def dependency(request: Request) -> UserContext:
        user = get_user(request)
        ensure_allowed(get_container(request).policy, user, action)
        return user

    dependency.__skh_action__ = action  # type: ignore[attr-defined]
    return dependency
