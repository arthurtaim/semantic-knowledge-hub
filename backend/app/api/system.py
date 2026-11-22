"""Health, session and integration status."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import __version__
from app.api.deps import get_container, get_user
from app.container import Container
from app.domain.models import IntegrationsResponse, UserContext

router = APIRouter(prefix="/api", tags=["system"])


class HealthResponse(BaseModel):
    status: str
    mode: str
    version: str


class SessionFeatures(BaseModel):
    ai_mode: str
    ai_edit_suggestions: bool
    corporate_search: str
    gitlab_proposals: bool
    confluence_publish: bool


class SessionResponse(BaseModel):
    user: UserContext
    auth_mode: str
    demo_content: bool
    knowledge_backend: str
    features: SessionFeatures


@router.get("/health", response_model=HealthResponse)
async def health(container: Annotated[Container, Depends(get_container)]) -> HealthResponse:
    return HealthResponse(status="ok", mode=container.settings.auth_mode, version=__version__)


@router.get("/session", response_model=SessionResponse)
async def session(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> SessionResponse:
    settings = container.settings
    corporate_status = await container.corporate.status()
    return SessionResponse(
        user=user,
        auth_mode=settings.auth_mode,
        demo_content=settings.knowledge_backend == "local" and settings.local_content_is_demo,
        knowledge_backend=settings.knowledge_backend,
        features=SessionFeatures(
            ai_mode=container.ai.mode,
            ai_edit_suggestions=container.ai.supports_edit_suggestions,
            corporate_search=corporate_status.state,
            gitlab_proposals=container.proposal_publisher.enabled,
            confluence_publish=container.confluence_publisher.enabled,
        ),
    )


@router.get("/integrations/status", response_model=IntegrationsResponse)
async def integrations_status(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(get_user)],
) -> IntegrationsResponse:
    await container.knowledge.snapshot(user)  # make document counts current
    return await container.integrations.status()
