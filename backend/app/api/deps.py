"""Request-scoped dependencies."""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum
from typing import TypeVar

from fastapi import Request

from app.container import Container
from app.domain.models import UserContext
from app.errors import ApiError

E = TypeVar("E", bound=StrEnum)


def get_container(request: Request) -> Container:
    container: Container = request.app.state.container
    return container


def get_user(request: Request) -> UserContext:
    """Local demo identity, or the configured server-side IdentityProvider (the SSO seam; tests use a fake-but-server-
    side provider). Without either: fail closed."""
    container = get_container(request)
    if container.identity is not None:
        return container.identity.resolve(request)
    if container.settings.auth_mode != "local_demo":
        raise ApiError(401, "unauthenticated", "Требуется корпоративная аутентификация.")
    return container.demo_user()


def csv_values(raw: str | None, allowed: Iterable[str] | None = None, *, name: str) -> frozenset[str] | None:
    if raw is None or not raw.strip():
        return None
    values = frozenset(v.strip() for v in raw.split(",") if v.strip())
    if len(values) > 20:
        raise ApiError(400, "invalid_filter", f"Слишком много значений фильтра `{name}`.")
    if allowed is not None:
        allowed_set = set(allowed)
        unknown = sorted(values - allowed_set)
        if unknown:
            raise ApiError(
                400, "invalid_filter", f"Недопустимое значение фильтра `{name}`: {', '.join(unknown)}."
            )
    return values
