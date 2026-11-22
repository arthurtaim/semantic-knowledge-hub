"""Authoring of new documents: templates, validation/preview, AI-assisted drafts and persistent drafts.

Nothing here changes the knowledge base: a new document is a `create` proposal that goes through the
same review → GitLab MR → merge workflow as any change (docs/DOCUMENT_CREATION_WORKFLOW.md).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.proposals import (
    AiDraftRequest,
    AiDraftResponse,
    AuthoringCheckRequest,
    AuthoringCheckResponse,
    DocumentTemplateInfo,
    NewDocumentDraftCreate,
    ProposalDetail,
)

router = APIRouter(prefix="/api/authoring", tags=["authoring"])


@router.get("/templates", response_model=list[DocumentTemplateInfo])
async def list_templates(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> list[DocumentTemplateInfo]:
    """Templates with a suggested free document ID and file path."""
    return await container.authoring.templates(user)


@router.post("/check", response_model=AuthoringCheckResponse)
async def check_new_document(
    payload: AuthoringCheckRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> AuthoringCheckResponse:
    """Validate a new document and render a safe preview. Nothing is stored."""
    return await container.authoring.check(
        user,
        payload.template_id,
        payload.metadata,
        payload.body,
        payload.path,
        payload.origin,
        payload.exclude_proposal_id,
    )


@router.post("/ai-draft", response_model=AiDraftResponse)
async def ai_draft(
    payload: AiDraftRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> AiDraftResponse:
    """A text suggestion from the configured AI provider (demo: template + verbatim excerpts).
    It is not stored and never becomes a proposal by itself."""
    return await container.authoring.ai_draft(user, payload)


@router.post("/drafts", response_model=ProposalDetail, status_code=201)
async def create_new_document_draft(
    payload: NewDocumentDraftCreate,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    """Persist a draft of a new document (proposal with operation=create, status=draft)."""
    return await container.proposals.create_new_document(user, payload)
