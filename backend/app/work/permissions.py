"""The M6 identity gate (docs/WORK_MANAGEMENT.md «Идентичность и права»).

Two layers, both server-side:

1. `AuthorizationPolicy` (app/authz.py) — the global gate every route declares through `require(Action.X)`.
2. `WorkAccessGate` — the work-specific, project-scoped gate:

   - `local_operator`: AUTH_MODE=local_demo on loopback, no public exposure. ONE server-defined operator
     (`Container.demo_user()`) may read and write. No viewer/member/admin split is claimed: membership rows are
     neither required nor consulted.
   - `read_only`: the same single-operator identity, but the backend is reachable through a shared/public link
     (WORK_PUBLIC_EXPOSURE=true, set by docker-compose.claude-public.yml, or the gateway marker header
     `X-SKH-Exposure` on the request) or writes are switched off (WORK_WRITES_ENABLED=false). A shared Basic Auth
     password is NOT an identity: only view actions pass; no writes, no private audit, no AI proposals.
   - `shared_login`: an OWNER-APPROVED deviation for the personal demo stand (2026-11-25, docs/WORK_MANAGEMENT.md
     «Общий вход демо-стенда»): with WORK_PUBLIC_EXPOSURE=true AND WORK_SHARED_LOGIN_WRITES=true, a request the LOGIN
     gateway marks (`X-SKH-Exposure: public-login`, deploy/claude-test/Caddyfile.login) — or a loopback request without
     a marker (SSH tunnel) — acts as the ONE server-defined operator and may write. Everyone behind the shared login
     is that one identity: history does not tell people apart. The open link (`public`) or any other marker stays
     read-only, and WORK_WRITES_ENABLED=false still wins.
   - `membership`: the team-ready gate. Needs a REAL, server-verified identity (a future SSO identity provider in
     `Container.identity`); each request checks the `ProjectMember` role: viewer = read, member = + write/schedule/
     audit/proposals, admin = + project settings. Unreachable in production today (AUTH_MODE=sso refuses to start);
     exercised by tests with a fake-but-server-side identity provider — never with identities from HTTP headers.
   - `disabled`: TASK_SYSTEM=disabled.

Neither layer ever reads a role, actor or user id from a request body, query or header.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING

from app.authz import Action
from app.domain.models import UserContext
from app.errors import ApiError
from app.work.models import ProjectRole

if TYPE_CHECKING:
    from app.work.links import DocumentScope

EXPOSURE_HEADER = "x-skh-exposure"
# The marker the LOGIN gateway sets (Caddyfile.login). The open gateway sets `public`.
EXPOSURE_LOGIN = "public-login"


class WorkAccessMode(StrEnum):
    local_operator = "local_operator"
    read_only = "read_only"
    shared_login = "shared_login"
    membership = "membership"
    disabled = "disabled"


VIEW_ACTIONS = frozenset({Action.view_projects, Action.view_tasks})
WRITE_ACTIONS = frozenset(
    {
        Action.manage_project,
        Action.create_task,
        Action.edit_task,
        Action.schedule_task,
        Action.propose_work,
        Action.apply_work_proposal,
    }
)
WORK_ACTIONS = VIEW_ACTIONS | WRITE_ACTIONS | {Action.view_work_audit}

ROLE_ACTIONS: dict[ProjectRole, frozenset[Action]] = {
    ProjectRole.viewer: VIEW_ACTIONS,
    ProjectRole.member: VIEW_ACTIONS
    | frozenset(
        {
            Action.create_task,
            Action.edit_task,
            Action.schedule_task,
            Action.propose_work,
            Action.apply_work_proposal,
            Action.view_work_audit,
        }
    ),
    ProjectRole.admin: WORK_ACTIONS,
}

LABELS = {
    WorkAccessMode.local_operator: "Локальная демонстрация — один оператор",
    WorkAccessMode.read_only: "Только просмотр — изменения задач отключены",
    WorkAccessMode.shared_login: "Демо-стенд — общий вход, один пользователь",
    WorkAccessMode.membership: "Командный режим — права участников проекта",
    WorkAccessMode.disabled: "Модуль задач отключён",
}


@dataclass(frozen=True)
class WorkPrincipal:
    """Who acts, derived on the server: the resolved identity plus request facts (never client claims)."""

    user: UserContext
    request_id: str
    exposed: bool = False  # the request carries the public-gateway marker
    exposure: str | None = None  # its value (`public` · `public-login`), None without a marker
    # The documents this identity may see NOW (its knowledge snapshot), resolved by the API layer for the request;
    # task ↔ document links are shown and counted only against it. None = not resolved (no document facts shown).
    documents: DocumentScope | None = None


@dataclass(frozen=True)
class WorkAccessGate:
    mode: WorkAccessMode
    read_only_reason: str | None = None

    def effective_mode(self, principal: WorkPrincipal) -> WorkAccessMode:
        if self.mode == WorkAccessMode.local_operator and principal.exposed:
            return WorkAccessMode.read_only
        if (
            self.mode == WorkAccessMode.shared_login
            and principal.exposed
            and principal.exposure != EXPOSURE_LOGIN
        ):
            return WorkAccessMode.read_only
        return self.mode

    def reason(self, principal: WorkPrincipal) -> str | None:
        mode = self.effective_mode(principal)
        if mode != WorkAccessMode.read_only:
            return None
        if self.mode == WorkAccessMode.local_operator and principal.exposed:
            return (
                "Запрос пришёл через общий/публичный шлюз: общий пароль не является идентичностью пользователя, "
                "поэтому изменения задач отключены."
            )
        if self.mode == WorkAccessMode.shared_login:
            return "Запрос пришёл по открытой публичной ссылке без входа: изменения задач доступны только после входа."
        return self.read_only_reason

    def role_based(self) -> bool:
        return self.mode == WorkAccessMode.membership

    def allows(self, principal: WorkPrincipal, action: Action, role: ProjectRole | None) -> bool:
        mode = self.effective_mode(principal)
        if mode == WorkAccessMode.disabled:
            return False
        if mode in (WorkAccessMode.local_operator, WorkAccessMode.shared_login):
            return principal.user.is_demo  # the server-defined operator only; never another actor
        if mode == WorkAccessMode.read_only:
            return principal.user.is_demo and action in VIEW_ACTIONS
        # membership: a real (non-demo) identity with a project role
        if principal.user.is_demo or role is None:
            return False
        return action in ROLE_ACTIONS[role]

    def check(self, principal: WorkPrincipal, action: Action, role: ProjectRole | None) -> None:
        mode = self.effective_mode(principal)
        if mode == WorkAccessMode.disabled:
            raise ApiError(
                503, "feature_unavailable", "Модуль задач отключён конфигурацией (TASK_SYSTEM=disabled)."
            )
        if not self.allows(principal, action, role):
            details: dict[str, str] = {"action": action.value, "mode": mode.value}
            reason = self.reason(principal)
            if reason:
                details["reason"] = reason
            message = (
                "Изменения задач недоступны в режиме только для просмотра."
                if mode == WorkAccessMode.read_only
                else "Недостаточно прав для этого действия."
            )
            raise ApiError(403, "forbidden", message, details)

    def my_role(self, principal: WorkPrincipal, role: ProjectRole | None) -> str:
        mode = self.effective_mode(principal)
        if mode == WorkAccessMode.membership:
            return role.value if role else "none"
        return mode.value


def build_gate(
    *,
    task_system: str,
    auth_mode: str,
    public_exposure: bool,
    writes_enabled: bool,
    shared_login_writes: bool = False,
) -> WorkAccessGate:
    if task_system == "disabled":
        return WorkAccessGate(WorkAccessMode.disabled)
    if auth_mode != "local_demo":
        return WorkAccessGate(WorkAccessMode.membership)
    if public_exposure and shared_login_writes and writes_enabled:
        return WorkAccessGate(WorkAccessMode.shared_login)
    if public_exposure:
        return WorkAccessGate(
            WorkAccessMode.read_only,
            "Приложение доступно по общей/публичной ссылке (WORK_PUBLIC_EXPOSURE=true): без настоящей "
            "идентификации пользователей изменения задач отключены.",
        )
    if not writes_enabled:
        return WorkAccessGate(
            WorkAccessMode.read_only, "Изменения задач отключены конфигурацией (WORK_WRITES_ENABLED=false)."
        )
    return WorkAccessGate(WorkAccessMode.local_operator)
