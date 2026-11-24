"""Fake-but-SERVER-SIDE identities for the M6 team-ready gate tests (M6-19, M6-37).

The test switches the current user by setting `ServerSideTestIdentity.current` in Python — exactly like a real SSO
provider would resolve a validated session on the server. Nothing is ever read from request headers, query or body:
a request that claims another user (`X-User-ID`, a `role` field …) cannot change who the server thinks it is.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Request
from fastapi.testclient import TestClient

from app.authz import Action
from app.domain.models import UserContext
from app.work.permissions import WorkAccessGate, WorkAccessMode


def team_user(user_id: str) -> UserContext:
    return UserContext(
        user_id=user_id, display_name=f"Тестовый пользователь {user_id}", roles=[], is_demo=False
    )


@dataclass
class ServerSideTestIdentity:
    name: str = "server_side_test_identity"
    current: UserContext = field(default_factory=lambda: team_user("alice"))

    def resolve(self, request: Request) -> UserContext:
        return self.current


class TeamTestPolicy:
    """Global gate for the membership tests: any non-demo identity passes; project roles decide the rest."""

    name = "team_test_policy"

    def allows(self, user: UserContext, action: Action) -> bool:
        return not user.is_demo


def enable_membership(client: TestClient) -> ServerSideTestIdentity:
    container = client.app.state.container  # type: ignore[attr-defined]
    identity = ServerSideTestIdentity()
    container.identity = identity
    container.policy = TeamTestPolicy()
    container.work.gate = WorkAccessGate(WorkAccessMode.membership)
    return identity
