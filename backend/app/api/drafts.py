"""Reviewable change proposals ("drafts"). None of these routes modify the source document."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.proposals import (
    DraftCreate,
    DraftUpdate,
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
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    return await container.proposals.create(user, payload)


@router.get("", response_model=ProposalList)
async def list_drafts(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    status: ProposalStatus | None = None,
    document_id: Annotated[str | None, Query(max_length=128)] = None,
) -> ProposalList:
    return await container.proposals.list_proposals(user, status, document_id)


@router.post("/suggest", response_model=SuggestResponse)
async def suggest_draft(
    payload: SuggestRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> SuggestResponse:
    return await container.proposals.suggest(user, payload)


@router.get("/{draft_id}", response_model=ProposalDetail)
async def get_draft(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> ProposalDetail:
    return await container.proposals.get(user, draft_id)


@router.put("/{draft_id}", response_model=ProposalDetail)
async def save_draft(
    draft_id: DraftId,
    payload: DraftUpdate,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    """Save an editable draft (status `draft` only; optimistic `expected_version`)."""
    return await container.proposals.save_draft(user, draft_id, payload)


@router.delete("/{draft_id}", status_code=204)
async def delete_draft(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> Response:
    """Delete a draft that never reached GitLab. The content-free audit trail is kept."""
    await container.proposals.delete_draft(user, draft_id)
    return Response(status_code=204)


@router.post("/{draft_id}/reject", response_model=ProposalDetail)
async def reject_draft(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.review_proposal))],
    payload: RejectRequest | None = None,
) -> ProposalDetail:
    return await container.proposals.reject(user, draft_id, payload.comment if payload else None)


@router.post("/{draft_id}/mark-ready", response_model=ProposalDetail)
async def mark_ready(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.review_proposal))],
) -> ProposalDetail:
    return await container.proposals.mark_ready(user, draft_id)


@router.post("/{draft_id}/submit", response_model=ProposalDetail)
async def submit_draft(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.submit_proposal))],
) -> ProposalDetail:
    """Create (or reuse) the GitLab branch, commit and Merge Request. Idempotent and retry-safe."""
    return await container.proposals.submit(user, draft_id)


@router.post("/{draft_id}/open-mr", response_model=ProposalDetail, deprecated=True)
async def open_merge_request(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.submit_proposal))],
) -> ProposalDetail:
    """Alias of /submit kept for earlier clients."""
    return await container.proposals.submit(user, draft_id)


@router.post("/{draft_id}/refresh-status", response_model=ProposalDetail)
async def refresh_draft_status(
    draft_id: DraftId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.submit_proposal))],
) -> ProposalDetail:
    """Read the MR state from GitLab; `merged` is recorded only when GitLab reports it."""
    return await container.proposals.refresh_status(user, draft_id)
