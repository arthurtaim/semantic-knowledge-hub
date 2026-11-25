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
    prepare_publication = (
        "prepare_publication"  # publication jobs, dry-run, reconciliation (Confluence reads)
    )
    publish_confluence = "publish_confluence"  # Confluence write: create/update a page of a merged document
    # Template Studio (docs/TEMPLATE_HUB.md): four separate rights, so a future RBAC can give them to different roles.
    view_templates = (
        "view_templates"  # the template catalogue, versions, comparisons, studio state and checks
    )
    create_template = "create_template"  # a new template (its first draft), also from an AI proposal
    edit_template = "edit_template"  # save / discard the draft of a template, acknowledge a shipped update
    activate_template = "activate_template"  # make a draft or an existing version the current one
    # M6 Work Management (docs/WORK_MANAGEMENT.md): the global gate. The project-scoped gate (ProjectMember roles, or
    # the single local operator / read-only exposure) is app/work/permissions.py — it never replaces this one.
    view_projects = "view_projects"  # project list/cards, members, work capabilities, assignee directory
    view_tasks = "view_tasks"  # task lists, task details, dependencies, Gantt snapshot
    manage_project = "manage_project"  # create a project, change its settings
    create_task = "create_task"  # create tasks and subtasks
    edit_task = "edit_task"  # change, archive, restore tasks
    schedule_task = "schedule_task"  # dependencies, schedule preview and apply
    view_work_audit = "view_work_audit"  # task / project activity (who changed what)
    propose_work = "propose_work"  # AI work proposals (Step 5; nothing is written)
    apply_work_proposal = "apply_work_proposal"  # explicit Accept of an AI work proposal (Step 5)


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


class IdentityProvider(Protocol):
    """Server-side identity resolution (the seam for a corporate SSO provider). When `Container.identity` is set,
    `get_user` asks it instead of returning the local demo operator. A provider derives the user from verified
    server state (a validated session/token) — never from a client-supplied user id, role or header claim."""

    name: str

    def resolve(self, request: Request) -> UserContext: ...


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
