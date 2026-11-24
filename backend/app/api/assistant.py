"""Grounded assistant routes."""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.adapters.ai.base import AIProviderError, ai_error_status
from app.api.deps import get_container
from app.authz import Action, ensure_allowed, require
from app.container import Container
from app.domain.models import AskRequest, AskResponse, UserContext
from app.errors import ApiError

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> AskResponse:
    if "corporate" in payload.sources:
        ensure_allowed(container.policy, user, Action.read_corporate)
    try:
        return await container.assistant.ask(user, payload)
    except AIProviderError as exc:
        raise ApiError(ai_error_status(exc.code), exc.code, exc.message) from exc


@router.post(
    "/ask/stream",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/x-ndjson": {}}}},
)
async def ask_stream(
    payload: AskRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> StreamingResponse:
    """NDJSON events: `status` (retrieving → generating → validating), `delta` (PRELIMINARY model text, not
    validated), then exactly one `final` (the validated AskResponse, same as /ask) or `error`. Closing the
    connection cancels the generation (the CLI worker kills the process)."""
    if "corporate" in payload.sources:
        ensure_allowed(container.policy, user, Action.read_corporate)
    if container.assistant.provider.mode == "disabled":
        raise ApiError(503, "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled).")

    async def body() -> AsyncIterator[bytes]:
        # aclosing: a client disconnect closes the whole chain down to the worker (which kills the CLI).
        async with contextlib.aclosing(container.assistant.ask_stream(user, payload)) as events:
            async for event in events:
                yield (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")

    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/instructions")
async def instructions(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> dict[str, object]:
    """Which runtime policy the assistant uses now (version, files, fallback) — never the prompt text."""
    loaded = container.instructions
    return loaded.describe() if loaded is not None else {"version": "-", "fallback": True, "files": []}
