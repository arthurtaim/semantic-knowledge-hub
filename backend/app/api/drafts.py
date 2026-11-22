"""Reviewable change proposals ("drafts"). None of these routes modify the source document."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_container, get_user
from app.container import Container
from app.domain.models import UserContext
from app.domain.proposals import (
    DraftCreate,
    ProposalDetail,
    ProposalList,
    ProposalStatus,
    RejectRequest,
    SuggestRequest,
    SuggestResponse,
)

router = APIRouter(prefix="/api/drafts", tags=["drafts"])
DraftId = Annotated[str, Path(min_length=1, max_length=64)]


@router.post("", response_model=ProposalDetail, status_code=201)
async def create_draft(
    payload: DraftCreate,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> ProposalDetail:
    return await container.proposals.create(user, payload)


@router.get("", response_model=ProposalList)
async def list_drafts(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
    status: ProposalStatus | None = None,
    document_id: Annotated[str | None, Query(max_length=128)] = None,
) -> ProposalList:
    return await container.proposals.list_proposals(user, status, document_id)


@router.post("/suggest", response_model=SuggestResponse)
async def suggest_draft(
    payload: SuggestRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> SuggestResponse:
    return await container.proposals.suggest(user, payload)


@router.get("/{draft_id}", response_model=ProposalDetail)
async def get_draft(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> ProposalDetail:
    return await container.proposals.get(user, draft_id)


@router.post("/{draft_id}/reject", response_model=ProposalDetail)
async def reject_draft(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
    payload: RejectRequest | None = None,
) -> ProposalDetail:
    return await container.proposals.reject(user, draft_id, payload.comment if payload else None)


@router.post("/{draft_id}/mark-ready", response_model=ProposalDetail)
async def mark_ready(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> ProposalDetail:
    return await container.proposals.mark_ready(user, draft_id)


@router.post("/{draft_id}/open-mr", response_model=ProposalDetail)
async def open_merge_request(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> ProposalDetail:
    return await container.proposals.open_merge_request(user, draft_id)
