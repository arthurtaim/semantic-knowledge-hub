"""«Применить шаблон»: preview, then confirm, for a draft or an indexed document (docs/TEMPLATE_HUB.md).

A preview stores nothing. Confirming on a draft updates the draft (version guard); confirming on a document creates a
change proposal — the document itself is never modified by these routes.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.proposals import (
    DocumentTemplateApply,
    DraftTemplateApply,
    ProposalDetail,
    TemplateApplyPreview,
    TemplateApplyPreviewRequest,
)
from app.services.template_apply import TemplateApplyService

router = APIRouter(prefix="/api", tags=["templates"])
DraftId = Annotated[str, Path(min_length=1, max_length=64)]
DocumentId = Annotated[str, Path(min_length=1, max_length=128)]


def _service(container: Container) -> TemplateApplyService:
    # Stateless: built from the container's services (no extra wiring in the container).
    return TemplateApplyService(
        container.proposals,
        container.authoring,
        container.repository,
        max_document_bytes=container.settings.max_document_bytes,
    )


@router.post("/drafts/{draft_id}/apply-template/preview", response_model=TemplateApplyPreview)
async def preview_draft_template(
    draft_id: DraftId,
    payload: TemplateApplyPreviewRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> TemplateApplyPreview:
    """The draft with the template applied, as a diff. Nothing is stored."""
    return await _service(container).preview_draft(user, draft_id, payload.template_id)


@router.post("/drafts/{draft_id}/apply-template", response_model=ProposalDetail)
async def apply_draft_template(
    draft_id: DraftId,
    payload: DraftTemplateApply,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    """Pin the template (its current active version) and update the draft; `expected_version` guards it."""
    return await _service(container).apply_to_draft(user, draft_id, payload)


@router.post("/documents/{document_id}/apply-template/preview", response_model=TemplateApplyPreview)
async def preview_document_template(
    document_id: DocumentId,
    payload: TemplateApplyPreviewRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> TemplateApplyPreview:
    """The document with the template applied, as a diff. Nothing is stored."""
    return await _service(container).preview_document(user, document_id, payload.template_id)


@router.post("/documents/{document_id}/apply-template", response_model=ProposalDetail, status_code=201)
async def apply_document_template(
    document_id: DocumentId,
    payload: DocumentTemplateApply,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    """A change proposal (status `draft`) based on `base_revision`; the document changes only after review + merge."""
    return await _service(container).apply_to_document(user, document_id, payload)
