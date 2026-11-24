"""Template Studio API (docs/API_CONTRACTS.md «Template Studio»): create, check, save drafts, compare and activate.

Included BEFORE the Template Hub router: `/api/templates/studio/...` must not be read as a template id (`studio` is a
reserved id). Rights are separate: view / create / edit / activate (app/authz.py). Every write names the
`expected_revision` it was based on; a stale one is 409 `template_conflict`.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.errors import ApiError
from app.services.template_hub import TemplateComparison
from app.services.template_studio import (
    StudioActivateRequest,
    StudioActivation,
    StudioCheck,
    StudioCreateRequest,
    StudioDraftRequest,
    StudioOptions,
    StudioRevisionRequest,
    StudioSaveResult,
    StudioState,
    StudioValidateRequest,
)

router = APIRouter(prefix="/api/templates", tags=["template-studio"])
TemplateId = Annotated[str, Path(min_length=2, max_length=41, pattern=r"^[a-z][a-z0-9_]{1,40}$")]


@router.get("/studio/options", response_model=StudioOptions)
async def studio_options(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
) -> StudioOptions:
    """Allowed document types and metadata fields, patterns, taken prefixes, the caller's rights and AI availability."""
    return container.template_studio.options(user)


@router.post("/studio/validate", response_model=StudioCheck)
async def studio_validate(
    payload: StudioValidateRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
) -> StudioCheck:
    """«Проверить»: issues bound to fields, the activation outcome, the template source and a new document's preview.
    Nothing is stored."""
    return container.template_studio.check(payload.spec, payload.template_id)


@router.post("/studio", response_model=StudioSaveResult, status_code=201)
async def studio_create(
    payload: StudioCreateRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_template))],
) -> StudioSaveResult:
    """A new template as a DRAFT (not offered to documents until activated). With `ai_proposal_id` this is the
    Accept of a `draft_template` AI proposal (the person's edited version is what is saved)."""
    return await container.template_studio.create(user, payload.spec, payload.ai_proposal_id)


@router.get("/{template_id}/studio", response_model=StudioState)
async def studio_state(
    template_id: TemplateId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
) -> StudioState:
    """Current version (as a spec), the open draft with its check, versions with author/time, events, revision."""
    return await container.template_studio.state(user, template_id)


@router.put("/{template_id}/studio/draft", response_model=StudioSaveResult)
async def studio_save_draft(
    template_id: TemplateId,
    payload: StudioDraftRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.edit_template))],
) -> StudioSaveResult:
    """«Сохранить черновик». The current version stays current; a shipped template is adopted by the studio."""
    return await container.template_studio.save_draft(
        user, template_id, payload.spec, payload.expected_revision
    )


@router.delete("/{template_id}/studio/draft", response_model=None)
async def studio_discard_draft(
    template_id: TemplateId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.edit_template))],
    expected_revision: Annotated[int, Query(ge=0)],
) -> StudioState | Response:
    """Drop the open draft (204 when a never-activated template disappears with it)."""
    state = await container.template_studio.discard_draft(user, template_id, expected_revision)
    return state if state is not None else Response(status_code=204)


@router.post("/{template_id}/studio/activate", response_model=StudioActivation)
async def studio_activate(
    template_id: TemplateId,
    payload: StudioActivateRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.activate_template))],
) -> StudioActivation:
    """«Активировать» the draft (a new version, or the catalogue text of the current one in place), or make an
    existing `version` current again. Documents and drafts keep their pinned version."""
    return await container.template_studio.activate(
        user, template_id, payload.expected_revision, payload.version
    )


@router.post("/{template_id}/studio/acknowledge-shipped", response_model=StudioState)
async def studio_acknowledge_shipped(
    template_id: TemplateId,
    payload: StudioRevisionRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.edit_template))],
) -> StudioState:
    """Keep the studio version although a release shipped a newer one (it stays readable in the history)."""
    return await container.template_studio.acknowledge_shipped(user, template_id, payload.expected_revision)


@router.get("/{template_id}/studio/compare", response_model=TemplateComparison)
async def studio_compare(
    template_id: TemplateId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
    from_version: Annotated[int, Query(alias="from", ge=1, le=1000)],
    to: Annotated[str, Query(pattern=r"^(draft|[1-9][0-9]{0,3})$")] = "draft",
) -> TemplateComparison:
    """A version against another version or against the open draft (`to=draft`): structure, fields, source diff."""
    target: int | Literal["draft"] = "draft" if to == "draft" else int(to)
    if target != "draft" and target > 1000:
        raise ApiError(422, "validation_failed", "Версия от 1 до 1000.")
    return container.template_studio.compare(template_id, from_version, target)
