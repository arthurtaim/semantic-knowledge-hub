"""Grounded assistant routes (+ UI v2: skills and attachments, docs/ui-v2/specs/02_ASSISTANT.md §5)."""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.adapters.ai.base import AIProviderError, ai_error_status
from app.api.deps import get_container
from app.api.multipart import MultipartError, read_form
from app.authz import Action, ensure_allowed, require
from app.container import Container
from app.domain.models import ATTACHMENT_ID_PATTERN, AskRequest, AskResponse, UserContext
from app.domain.skills import SkillInfo
from app.errors import ApiError
from app.services.attachments import AttachmentInfo, valid_conversation_id
from app.services.skills import AskPlan

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

FORM_OVERHEAD_BYTES = 64 * 1024  # multipart headers and the small conversation_id field


async def _plan(container: Container, user: UserContext, payload: AskRequest) -> AskPlan:
    """Permission and input checks that must fail as HTTP errors (also before a stream starts)."""
    if "corporate" in payload.sources:
        ensure_allowed(container.policy, user, Action.read_corporate)
    plan = await container.skills.plan(user, payload)
    if plan.creates_proposal:  # a skill built on the AI workflows stores a proposal
        ensure_allowed(container.policy, user, Action.create_proposal)
    return plan


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> AskResponse:
    """Without the UI v2 fields this is the plain grounded answer, exactly as before. With `skill_id` the
    skill runs on top of the existing pipelines; draft skills return a proposal reference, never apply."""
    plan = await _plan(container, user, payload)
    try:
        return await container.skills.run(user, plan)
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
    connection cancels the generation (the CLI worker kills the process). Input errors (unknown or unavailable
    skill, foreign attachment, …) are HTTP errors before the stream starts."""
    plan = await _plan(container, user, payload)

    async def body() -> AsyncIterator[bytes]:
        # aclosing: a client disconnect closes the whole chain down to the worker (which kills the CLI).
        async with contextlib.aclosing(container.skills.run_stream(user, plan)) as events:
            async for event in events:
                yield (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")

    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/skills", response_model=list[SkillInfo])
async def skills(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> list[SkillInfo]:
    """The skill registry with availability in the current AI mode (the UI never hard-codes the list)."""
    return container.skills.catalog()


def _invalid(field: str) -> ApiError:
    return ApiError(
        422,
        "invalid_request",
        "Некорректные параметры запроса.",
        {"fields": [{"loc": ["body", field], "type": "invalid"}]},
    )


@router.post(
    "/attachments",
    response_model=AttachmentInfo,
    status_code=201,
    responses={
        200: {"model": AttachmentInfo, "description": "Файл не принят: `status: error` и `error_code`."},
        201: {"description": "Файл прочитан и сохранён: `status: ready`."},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["conversation_id", "file"],
                        "properties": {
                            "conversation_id": {
                                "type": "string",
                                "pattern": r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$",
                            },
                            "file": {"type": "string", "format": "binary"},
                        },
                    }
                }
            },
        }
    },
)
async def upload_attachment(
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> JSONResponse:
    """multipart/form-data: `conversation_id` (send it BEFORE `file`), `file`. A rejected file is an attachment
    object with `status: "error"` and `error_code` (HTTP 200, nothing stored); a read file is `status: "ready"`
    (HTTP 201). Malformed requests are 422; with AI disabled — 503 `assistant_disabled`."""
    if container.assistant.provider.mode == "disabled":
        raise ApiError(503, "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled).")
    service = container.attachments
    try:
        form = await read_form(request, max_bytes=service.limits.file_bytes + FORM_OVERHEAD_BYTES)
    except MultipartError as exc:
        raise ApiError(
            422, "invalid_multipart", str(exc) or "Некорректное тело multipart/form-data."
        ) from exc
    conversation_id = form.field("conversation_id")
    if conversation_id is None or not valid_conversation_id(conversation_id):
        raise _invalid("conversation_id")
    if form.truncated:
        cut = form.file("file") or form.partial
        size = form.declared_length or service.limits.file_bytes + 1
        info = service.too_large(
            conversation_id, cut.filename if cut else None, cut.content_type if cut else "", size
        )
    else:
        part = form.file("file")
        if part is None:
            raise _invalid("file")
        info = await service.upload(user, conversation_id, part.filename, part.content_type, part.data)
    return JSONResponse(info.model_dump(mode="json"), status_code=201 if info.status == "ready" else 200)


@router.delete("/attachments/{attachment_id}", status_code=204)
async def delete_attachment(
    attachment_id: Annotated[str, Path(pattern=ATTACHMENT_ID_PATTERN)],
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> Response:
    """Idempotent: 204 also when the attachment was already deleted, expired or never stored (an error result)."""
    container.attachments.delete(user, attachment_id)
    return Response(status_code=204)


@router.get("/instructions")
async def instructions(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> dict[str, object]:
    """Which runtime policy the assistant uses now (version, files, fallback) — never the prompt text."""
    loaded = container.instructions
    return loaded.describe() if loaded is not None else {"version": "-", "fallback": True, "files": []}
