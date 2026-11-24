"""Health, session and integration status."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import __version__
from app.adapters.knowledge.base import RepositoryUnavailableError
from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import IntegrationsResponse, SyncStatus, UserContext
from app.errors import ApiError

router = APIRouter(prefix="/api", tags=["system"])


class HealthResponse(BaseModel):
    status: str
    mode: str
    version: str


class SessionFeatures(BaseModel):
    ai_mode: str
    ai_provider: str
    ai_edit_suggestions: bool
    ai_authoring: bool
    corporate_search: str
    gitlab_proposals: bool
    confluence_publish: bool
    # M6: local_operator | read_only | membership | disabled (details: GET /api/work/capabilities)
    work_management: str = "disabled"


class SessionResponse(BaseModel):
    user: UserContext
    auth_mode: str
    demo_content: bool
    knowledge_backend: str
    authorization_policy: str
    features: SessionFeatures


@router.get("/health", response_model=HealthResponse)
async def health(container: Annotated[Container, Depends(get_container)]) -> HealthResponse:
    return HealthResponse(status="ok", mode=container.settings.auth_mode, version=__version__)


@router.get("/session", response_model=SessionResponse)
async def session(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_system))],
) -> SessionResponse:
    settings = container.settings
    corporate_status = await container.corporate.status()
    return SessionResponse(
        user=user,
        auth_mode=settings.auth_mode,
        demo_content=settings.knowledge_backend == "local" and settings.local_content_is_demo,
        knowledge_backend=settings.knowledge_backend,
        authorization_policy=container.policy.name,
        features=SessionFeatures(
            ai_mode=container.ai.mode,
            ai_provider=container.settings.ai_provider,
            ai_edit_suggestions=container.ai.supports_edit_suggestions,
            ai_authoring=container.ai.mode != "disabled" and container.ai.supports_authoring,
            corporate_search=corporate_status.state,
            gitlab_proposals=container.proposal_publisher.enabled,
            confluence_publish=container.confluence_publisher.enabled,
            work_management=container.work.gate.mode.value,
        ),
    )


@router.get("/integrations/status", response_model=IntegrationsResponse)
async def integrations_status(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_system))],
) -> IntegrationsResponse:
    await container.knowledge.snapshot(user)  # make document counts current
    return await container.integrations.status()


@router.get("/index/status", response_model=SyncStatus)
async def index_status(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_system))],
) -> SyncStatus:
    return await container.knowledge.sync_status(user)


@router.post("/index/sync", response_model=SyncStatus)
async def index_sync(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.sync_knowledge))],
    rebuild: bool = False,
) -> SyncStatus:
    """Manual re-synchronisation of the knowledge source and the search index (`rebuild`: repair by a full
    index rebuild). The response carries the structured result: added / updated / renamed / deleted /
    rejected, generation, checksum, elapsed time."""
    try:
        await container.knowledge.refresh(full=True, rebuild_index=rebuild)
    except RepositoryUnavailableError as exc:
        raise ApiError(exc.status_code, exc.code, exc.message) from exc
    return await container.knowledge.sync_status(user)
