"""AI-first knowledge workflows (M5.6.3): proposals with evidence; the person accepts or rejects them."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.services.ai_workflows import AcceptRequest, AiProposal, ProposalRequest

router = APIRouter(prefix="/api/ai", tags=["ai"])
ProposalId = Annotated[str, Path(pattern=r"^AIP-[0-9a-f]{16}$")]


@router.post("/proposals", response_model=AiProposal, status_code=201)
async def create_proposal(
    payload: ProposalRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> AiProposal:
    """Draft from a prompt, metadata / related documents / completeness / improve / summarize / explain,
    relation explanation and impact analysis. Returns a proposal; nothing is written."""
    return await container.ai_workflows.propose(user, payload)


@router.get("/proposals", response_model=list[AiProposal])
async def list_proposals(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
    draft_id: Annotated[str | None, Query(max_length=64)] = None,
    document_id: Annotated[str | None, Query(max_length=128)] = None,
) -> list[AiProposal]:
    return container.ai_workflows.list_proposals(user, draft_id, document_id)


@router.get("/proposals/{proposal_id}", response_model=AiProposal)
async def get_proposal(
    proposal_id: ProposalId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> AiProposal:
    return container.ai_workflows.get(user, proposal_id)


@router.post("/proposals/{proposal_id}/accept", response_model=AiProposal)
async def accept_proposal(
    proposal_id: ProposalId,
    payload: AcceptRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> AiProposal:
    """Apply the chosen items to a DRAFT (an approved document gets an update draft). A changed base is 409."""
    return await container.ai_workflows.accept(user, proposal_id, payload)


@router.post("/proposals/{proposal_id}/reject", response_model=AiProposal)
async def reject_proposal(
    proposal_id: ProposalId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> AiProposal:
    """Nothing changes; the decision is recorded."""
    return container.ai_workflows.reject(user, proposal_id)
