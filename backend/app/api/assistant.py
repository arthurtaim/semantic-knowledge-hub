"""Grounded assistant routes (+ UI v2: skills and attachments, docs/ui-v2/specs/02_ASSISTANT.md §5)."""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.adapters.ai.base import AIProviderError, ai_error_status
from app.api.deps import get_container
from app.api.multipart import MultipartError, read_form
from app.api.work import work_principal
from app.authz import Action, ensure_allowed, require
from app.container import Container
from app.domain.models import (
    ATTACHMENT_ID_PATTERN,
    CONVERSATION_ID_PATTERN,
    AskRequest,
    AskResponse,
    UserContext,
)
from app.domain.skills import SKILL_BY_ID, SkillInfo
from app.errors import ApiError
from app.services.attachments import AttachmentInfo, valid_conversation_id
from app.services.conversations import (
    BROWSER_HEADER,
    ConversationClear,
    ConversationDetail,
    ConversationList,
    TurnHandle,
    valid_browser_id,
)
from app.services.skills import AskPlan
from app.services.work_skills import global_actions

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

FORM_OVERHEAD_BYTES = 64 * 1024  # multipart headers and the small conversation_id field


async def _plan(container: Container, user: UserContext, payload: AskRequest, request: Request) -> AskPlan:
    """Permission and input checks that must fail as HTTP errors (also before a stream starts)."""
    if "corporate" in payload.sources:
        ensure_allowed(container.policy, user, Action.read_corporate)
    skill = SKILL_BY_ID.get(payload.skill_id or "")
    principal = None
    if skill is not None and skill.is_work:
        # M7: the global Actions of a work skill BEFORE anything else (view_tasks | propose_work [+ edit_task]), and
        # the work principal from THE builder the work API uses (exposure marker, documents) — the project gate is
        # applied by the skill with the chosen project, before any model call.
        for action in global_actions(skill):
            ensure_allowed(container.policy, user, action)
        principal = await work_principal(request, container, user)
    plan = await container.skills.plan(user, payload, principal)
    if plan.creates_proposal:  # a skill built on the AI workflows stores a proposal
        ensure_allowed(container.policy, user, Action.create_proposal)
    return plan


def browser_id(request: Request) -> str | None:
    """`X-SKH-Browser`: the per-browser id of the chat history; a malformed value counts as absent."""
    return valid_browser_id(request.headers.get(BROWSER_HEADER))


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> AskResponse:
    """Without the UI v2 fields this is the plain grounded answer, exactly as before. With `skill_id` the
    skill runs on top of the existing pipelines; draft skills return a proposal reference, never apply.
    With `conversation_id` and `X-SKH-Browser` the completed turn is stored in the chat history (v0.7)."""
    plan = await _plan(container, user, payload, request)
    history = container.conversations
    turn = history.begin(user, browser_id(request), plan)
    try:
        response = await container.skills.run(user, plan)
    except AIProviderError as exc:
        status = ai_error_status(exc.code)
        history.fail(turn, exc.code, exc.message, status)
        raise ApiError(status, exc.code, exc.message) from exc
    except ApiError as exc:
        history.fail(turn, exc.code, exc.message, exc.status_code)
        raise
    except Exception:
        history.fail(turn, "internal_error", "Не удалось получить ответ ассистента.", 500)
        raise
    except BaseException:  # cancelled: the client went away
        history.interrupt(turn)
        raise
    history.finish(turn, response.model_dump(mode="json"))
    return response


def _record(container: Container, turn: TurnHandle | None, event: dict[str, Any]) -> bool:
    """Stores the outcome of a terminal stream event; True when the event was terminal."""
    kind = event.get("type")
    if kind == "final":
        container.conversations.finish(turn, event["response"])
        return True
    if kind == "error":
        container.conversations.fail(
            turn,
            str(event.get("code") or "ai_upstream_error"),
            str(event.get("message") or ""),
            int(event.get("status") or 502),
        )
        return True
    return False


@router.post(
    "/ask/stream",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/x-ndjson": {}}}},
)
async def ask_stream(
    payload: AskRequest,
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> StreamingResponse:
    """NDJSON events: `status` (retrieving → generating → validating), `delta` (PRELIMINARY model text, not
    validated), then exactly one `final` (the validated AskResponse, same as /ask) or `error`. Closing the
    connection cancels the generation (the CLI worker kills the process). Input errors (unknown or unavailable
    skill, foreign attachment, …) are HTTP errors before the stream starts. The chat history (v0.7) stores the
    `final` answer (or the `error`); a stream closed before either is an interrupted turn."""
    plan = await _plan(container, user, payload, request)
    turn = container.conversations.begin(user, browser_id(request), plan)

    async def body() -> AsyncIterator[bytes]:
        ended = False
        try:
            # aclosing: a client disconnect closes the whole chain down to the worker (which kills the CLI).
            async with contextlib.aclosing(container.skills.run_stream(user, plan)) as events:
                async for event in events:
                    ended = _record(container, turn, event) or ended
                    yield (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
        finally:
            if not ended:
                container.conversations.interrupt(turn)

    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/skills", response_model=list[SkillInfo])
async def skills(
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> list[SkillInfo]:
    """The skill registry with availability in the current AI mode (the UI never hard-codes the list). Work skills
    (M7) also say whether the work module is on and this reader may view / propose at all (read-only exposure → not
    available, with the reason); per-project rights are checked when a project is chosen."""
    principal = await work_principal(request, container, user, with_documents=False)
    return container.skills.catalog(principal)


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


# --- chat history (v0.7): this user's conversations in THIS browser --------------------------------------------


@router.get("/conversations", response_model=ConversationList)
async def conversations(
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
    origin: Annotated[Literal["dialog", "document"] | None, Query()] = None,
    document_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ConversationList:
    """Newest first, bounded. Without a valid `X-SKH-Browser` the list is empty (another browser sees nothing)."""
    return await container.conversations.list_conversations(
        user, browser_id(request), origin=origin, document_id=document_id, limit=limit
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def conversation(
    conversation_id: Annotated[str, Path(pattern=CONVERSATION_ID_PATTERN)],
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> ConversationDetail:
    """The stored turns, re-checked for the reader now: an answer relying on a document the reader can no longer
    see is withheld; a changed index generation is noted. 404 `conversation_not_found` for an unknown id, another
    browser's or user's conversation and a missing browser id alike."""
    return await container.conversations.get(user, browser_id(request), conversation_id)


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: Annotated[str, Path(pattern=CONVERSATION_ID_PATTERN)],
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> Response:
    """Idempotent 204; deletes the conversation (with its files) only when it is this browser's."""
    container.conversations.delete(user, browser_id(request), conversation_id)
    return Response(status_code=204)


@router.delete("/conversations", response_model=ConversationClear)
async def clear_conversations(
    request: Request,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.ask_assistant))],
) -> ConversationClear:
    """«Очистить историю»: every conversation of this user in this browser (other browsers keep theirs)."""
    return ConversationClear(deleted=container.conversations.clear(user, browser_id(request)))


@router.get("/instructions")
async def instructions(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> dict[str, object]:
    """Which runtime policy the assistant uses now (version, files, fallback) — never the prompt text."""
    loaded = container.instructions
    return loaded.describe() if loaded is not None else {"version": "-", "fallback": True, "files": []}
