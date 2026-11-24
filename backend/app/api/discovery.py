"""Discovery memory API (M5.6.2 Appendix 5 §4, §8): relevance feedback, erase, operator stats, curation
proposal. Everything is scoped to the requester; nothing here changes a document's status or access.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.proposals import NewDocumentDraftCreate, NewDocumentMetadata, ProposalDetail
from app.errors import ApiError
from app.services.discovery import DiscoveryStore, acl_scope_key

router = APIRouter(prefix="/api/discovery", tags=["discovery"])

TraceId = Annotated[str, Path(pattern=r"^TRACE-[0-9a-f]{16}$")]
SOURCE_ID_RE = r"^[a-z_]+:[A-Za-z0-9_.:@-]{1,180}$"


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trace_id: str = Field(pattern=r"^TRACE-[0-9a-f]{16}$")
    source_id: str = Field(pattern=SOURCE_ID_RE, max_length=200)
    verdict: Literal["relevant", "irrelevant", "unsure"]


class FeedbackOut(BaseModel):
    recorded: bool
    note: str


class PurgeOut(BaseModel):
    removed_records: int
    removed_cache_pages: int


class ProposeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trace_id: str = Field(pattern=r"^TRACE-[0-9a-f]{16}$")
    source_id: str = Field(pattern=SOURCE_ID_RE, max_length=200)


def _store(container: Container) -> DiscoveryStore:
    if container.discovery is None:
        raise ApiError(
            503, "discovery_disabled", "Память поиска отключена конфигурацией (DISCOVERY_ENABLED=false)."
        )
    return container.discovery


@router.post("/feedback", response_model=FeedbackOut)
async def feedback(
    payload: FeedbackIn,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> FeedbackOut:
    """«Подошёл / Не подошёл» for ONE source of ONE answer. Optional; it only changes how candidates are
    prioritised for similar questions of the same user scope — never status, access or authority."""
    store = _store(container)
    recorded = store.feedback(payload.trace_id, payload.source_id, payload.verdict, acl_scope_key(user))
    if not recorded:
        raise ApiError(
            404, "discovery_link_not_found", "Источник этого ответа не найден или срок хранения истёк."
        )
    return FeedbackOut(
        recorded=True,
        note="Отзыв учтён для похожих вопросов. Статус и права доступа документа не меняются.",
    )


@router.delete("/traces/{trace_id}", response_model=PurgeOut)
async def purge_trace(
    trace_id: TraceId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> PurgeOut:
    removed = _store(container).purge(acl_scope_key(user), trace_id)
    if not removed:
        raise ApiError(404, "trace_not_found", "След запроса не найден.")
    return PurgeOut(removed_records=removed, removed_cache_pages=0)


@router.delete("", response_model=PurgeOut)
async def purge_all(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> PurgeOut:
    """Erase the requester's discovery data AND the external cache derived from it."""
    removed = _store(container).purge(acl_scope_key(user))
    cache = container.external.purge_all() if container.external else 0
    return PurgeOut(removed_records=removed, removed_cache_pages=cache)


@router.get("/stats")
async def stats(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.view_system))],
) -> dict[str, Any]:
    """Operator view: cache, MCP calls, latency, limits, feedback counts — no query text, no secrets."""
    store = container.discovery
    if store is not None:
        store.expire()
    return {
        "discovery": store.stats(acl_scope_key(user)) if store else {"enabled": False},
        "external": container.external.stats() if container.external else {"enabled": False},
    }


def _safe_id(page_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", page_id)[:12] or "PAGE"


@router.post("/propose", response_model=ProposalDetail, status_code=201)
async def propose(
    payload: ProposeIn,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    """«Предложить в базу»: a DRAFT of a new curated document that quotes the external page with its
    provenance. It never imports, never approves; the normal review decides."""
    store = _store(container)
    trace = store.trace(payload.trace_id, acl_scope_key(user))
    if trace is None:
        raise ApiError(404, "trace_not_found", "След запроса не найден или срок хранения истёк.")
    link = next((s for s in trace.sources if s["source_id"] == payload.source_id), None)
    if link is None or link["source_kind"] != "confluence_mcp" or not link["page_id"]:
        raise ApiError(404, "discovery_link_not_found", "Внешний источник не найден в этом ответе.")
    if container.external is None or not await container.external.revalidate(
        user, link["page_id"], link["version"]
    ):
        raise ApiError(
            409,
            "external_source_changed",
            "Страница изменилась или больше недоступна — предложение не создано.",
        )
    page = await container.corporate.get_page(link["page_id"], user)
    excerpt = page.body[:3000]
    doc_id = f"SEM-EXT-{_safe_id(page.page_id)}"
    body = (
        f"# {page.title}\n\n"
        "## Источник\n"
        f"Предложено включить в базу знаний страницу Confluence `{payload.source_id}` (статус в источнике: "
        f"{page.status or 'unknown'}). Текст ниже — выдержка из страницы на момент предложения; права на "
        "перенос и актуальность должны подтвердить владелец и ревьюер.\n\n"
        "## Содержание\n"
        f"{excerpt}\n\n"
        "## Проверка прав\n> Требует уточнения: разрешено ли переносить содержимое страницы в базу команды.\n\n"
        "## Решение о включении\n> Требует уточнения: решение владельца и ревьюера.\n"
    )
    draft = NewDocumentDraftCreate(
        template_id="external_import",
        metadata=NewDocumentMetadata(
            id=doc_id,
            title=page.title[:300],
            owner="unassigned",
            tags=["external", "confluence"],
            source_refs=[payload.source_id],
            summary=f"Черновик из внешней страницы {payload.source_id}; требует ревью.",
        ),
        body=body,
        reason=f"Предложение включить внешнюю страницу {payload.source_id} в базу знаний (из ответа {payload.trace_id}).",
        origin="external_page",
    )
    return await container.proposals.create_new_document(user, draft)
