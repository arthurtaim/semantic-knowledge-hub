"""Links of documents (M5.6.3): outgoing / backlinks / unresolved WikiLinks and `[[` autocomplete."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.errors import ApiError
from app.services.links import DocumentLinks, LinkSuggestion, UnresolvedLink

router = APIRouter(prefix="/api", tags=["links"])


class LinkDiagnostic(BaseModel):
    document_id: str
    problem: UnresolvedLink


@router.get("/documents/{document_id}/links", response_model=DocumentLinks)
async def document_links(
    document_id: Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")],
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> DocumentLinks:
    """Outgoing links, backlinks and unresolved WikiLinks — only among documents this reader can see."""
    links = await container.links.links(user, document_id)
    if links is None:
        raise ApiError(404, "document_not_found", "Документ не найден.")
    return links


@router.get("/links/suggest", response_model=list[LinkSuggestion])
async def suggest_links(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    q: Annotated[str, Query(max_length=120)] = "",
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
) -> list[LinkSuggestion]:
    """`[[` autocomplete: matching IDs, titles and aliases; the editor inserts `[[ID|Title]]`."""
    return await container.links.suggest(user, q, limit)


@router.get("/links/diagnostics", response_model=list[LinkDiagnostic])
async def link_diagnostics(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> list[LinkDiagnostic]:
    """Unresolved WikiLinks across the visible base (missing target, title link, ambiguous title)."""
    return [LinkDiagnostic(document_id=d, problem=u) for d, u in await container.links.diagnostics(user)]
