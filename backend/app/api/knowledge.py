"""Knowledge browsing, search and corporate page routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.adapters.corporate.base import ConnectorUnavailableError, CorporatePageNotFoundError
from app.adapters.knowledge.base import DocumentNotFoundError, DuplicateDocumentIdError
from app.adapters.search.base import SearchFilters
from app.api.deps import csv_values, get_container
from app.authz import Action, ensure_allowed, require
from app.container import Container
from app.domain.models import (
    DocStatus,
    DocType,
    DocumentDetail,
    DocumentFacets,
    DocumentPage,
    LoadIssue,
    SearchResponse,
    SearchScope,
    UserContext,
)
from app.domain.schema import is_valid_document_id
from app.errors import ApiError
from app.services.knowledge import DocumentQuery, SortOrder

router = APIRouter(prefix="/api", tags=["knowledge"])

_SOURCES = ("local", "gitlab", "confluence")
_SCOPES: tuple[SearchScope, ...] = ("team", "corporate")
DocumentIdPath = Annotated[str, Path(min_length=1, max_length=128)]


def _filters(
    type_: str | None, status: str | None, owner: str | None, source: str | None, tag: str | None
) -> SearchFilters:
    return SearchFilters(
        types=csv_values(type_, [t.value for t in DocType], name="type"),
        statuses=csv_values(status, [s.value for s in DocStatus], name="status"),
        owners=csv_values(owner, name="owner"),
        sources=csv_values(source, _SOURCES, name="source"),
        tags=frozenset(t.lower() for t in csv_values(tag, name="tag") or ()) or None,
    )


@router.get("/documents", response_model=DocumentPage)
async def list_documents(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    query: Annotated[str, Query(max_length=200)] = "",
    type: Annotated[str | None, Query(max_length=200)] = None,
    status: Annotated[str | None, Query(max_length=200)] = None,
    owner: Annotated[str | None, Query(max_length=200)] = None,
    source: Annotated[str | None, Query(max_length=200)] = None,
    tag: Annotated[str | None, Query(max_length=200)] = None,
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
    size: Annotated[int, Query(ge=1, le=100)] = 20,
    sort: SortOrder | None = None,
) -> DocumentPage:
    filters = _filters(type, status, owner, source, tag)
    return await container.knowledge.list_documents(
        user, DocumentQuery(query=query, filters=filters, page=page, size=size, sort=sort)
    )


@router.get("/documents/{document_id}", response_model=DocumentDetail)
async def get_document(
    document_id: DocumentIdPath,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> DocumentDetail:
    if not is_valid_document_id(document_id):
        raise ApiError(400, "invalid_document_id", "Некорректный идентификатор документа.")
    try:
        return await container.knowledge.get_detail(user, document_id)
    except DocumentNotFoundError as exc:
        raise ApiError(404, "document_not_found", f"Документ {document_id} не найден.") from exc
    except DuplicateDocumentIdError as exc:
        raise ApiError(
            422,
            "duplicate_document_id",
            f"Идентификатор {document_id} используется в нескольких файлах — документ не показан до исправления.",
            {"paths": ", ".join(exc.paths)},
        ) from exc


@router.get("/knowledge/facets", response_model=DocumentFacets)
async def facets(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> DocumentFacets:
    return await container.knowledge.facets(user)


@router.get("/knowledge/issues", response_model=list[LoadIssue])
async def issues(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> list[LoadIssue]:
    return await container.knowledge.issues(user)


@router.get("/search", response_model=SearchResponse)
async def search(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    q: Annotated[str, Query(min_length=1, max_length=200)],
    source: Annotated[str, Query(max_length=40)] = "team",
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    type: Annotated[str | None, Query(max_length=200)] = None,
    status: Annotated[str | None, Query(max_length=200)] = None,
    owner: Annotated[str | None, Query(max_length=200)] = None,
    tag: Annotated[str | None, Query(max_length=200)] = None,
) -> SearchResponse:
    scopes = csv_values(source, _SCOPES, name="source") or frozenset({"team"})
    ordered_scopes: list[SearchScope] = [s for s in _SCOPES if s in scopes]
    if "corporate" in ordered_scopes:
        ensure_allowed(container.policy, user, Action.read_corporate)
    filters = _filters(type, status, owner, None, tag)
    await container.knowledge.snapshot(user)
    return await container.search.search(user, q, ordered_scopes, limit, filters)


@router.get("/corporate/pages/{page_id}")
async def corporate_page(
    page_id: Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")],
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_corporate))],
) -> dict[str, str | bool | None]:
    try:
        page = await container.corporate.get_page(page_id, user)
    except ConnectorUnavailableError as exc:
        raise ApiError(503, exc.code, exc.message) from exc
    except CorporatePageNotFoundError as exc:
        raise ApiError(404, "page_not_found", "Страница не найдена или недоступна.") from exc
    return {
        "page_id": page.page_id,
        "space": page.space,
        "title": page.title,
        "body": page.body,
        "source_uri": page.source_uri,
        "version": page.version,
        "updated_at": page.updated_at.isoformat() if page.updated_at else None,
        "is_mock": page.is_mock,
    }
