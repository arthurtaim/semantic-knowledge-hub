"""Template Hub API (M5.6.3): the versioned template registry as a catalogue for people."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.errors import ApiError
from app.services.template_hub import TemplateComparison, TemplateDetail, TemplateSummary

router = APIRouter(prefix="/api/templates", tags=["templates"])
TemplateId = Annotated[str, Path(min_length=2, max_length=41, pattern=r"^[a-z][a-z0-9_]{1,40}$")]


@router.get("", response_model=list[TemplateSummary])
async def catalogue(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
    q: Annotated[str, Query(max_length=100)] = "",
    status: Annotated[str | None, Query(pattern=r"^(draft|active|deprecated|archived)$")] = None,
    type: Annotated[str | None, Query(max_length=40)] = None,
    category: Annotated[str | None, Query(max_length=80)] = None,
    label: Annotated[str | None, Query(max_length=80)] = None,
    include_hidden: bool = False,
) -> list[TemplateSummary]:
    """Templates with status, version, category, labels and how many visible documents use them."""
    return await container.template_hub.catalogue(
        user,
        q=q,
        status=status,
        doc_type=type,
        category=category,
        label=label,
        include_hidden=include_hidden,
    )


@router.get("/{template_id}", response_model=TemplateDetail)
async def template_detail(
    template_id: TemplateId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
) -> TemplateDetail:
    """The current version: sections (required/optional), fields, rules, guidance, example, history, usage."""
    detail = await container.template_hub.detail(user, template_id)
    if detail is None:
        raise ApiError(404, "template_not_found", "Шаблон не найден.")
    return detail


@router.get("/{template_id}/versions/{version}", response_model=TemplateDetail)
async def template_version(
    template_id: TemplateId,
    version: Annotated[int, Path(ge=1, le=1000)],
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
) -> TemplateDetail:
    """An exact version (also older ones that drafts are pinned to)."""
    detail = await container.template_hub.detail(user, template_id, version)
    if detail is None:
        raise ApiError(404, "template_version_not_found", "Такой версии шаблона нет.")
    return detail


@router.get("/{template_id}/compare", response_model=TemplateComparison)
async def compare_versions(
    template_id: TemplateId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_templates))],
    from_version: Annotated[int, Query(alias="from", ge=1, le=1000)],
    to_version: Annotated[int, Query(alias="to", ge=1, le=1000)],
) -> TemplateComparison:
    """What changed between two versions: sections, required fields, rules, status, breaking + migration."""
    result = container.template_hub.compare(template_id, from_version, to_version)
    if result is None:
        raise ApiError(404, "template_version_not_found", "Такой версии шаблона нет.")
    return result
