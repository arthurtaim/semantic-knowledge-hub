"""Grounded assistant route."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.adapters.ai.base import AIProviderError
from app.api.deps import get_container, get_user
from app.container import Container
from app.domain.models import AskRequest, AskResponse, UserContext
from app.errors import ApiError

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

_UNAVAILABLE = {"assistant_disabled", "ai_misconfigured", "ai_unreachable", "ai_timeout", "ai_rate_limited"}


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> AskResponse:
    try:
        return await container.assistant.ask(user, payload)
    except AIProviderError as exc:
        status = 503 if exc.code in _UNAVAILABLE else 502
        raise ApiError(status, exc.code, exc.message) from exc
