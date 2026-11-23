"""Source-aware search across team knowledge and (optionally) corporate knowledge."""

from __future__ import annotations

import logging

from app.adapters.corporate.base import ConnectorUnavailableError, CorporateKnowledgeConnector, CorporatePage
from app.adapters.corporate.disabled import DISABLED_MESSAGE
from app.adapters.search.base import SearchFilters
from app.domain.markdown import truncate
from app.domain.models import (
    HighlightSegment,
    ScopeStatus,
    SearchResponse,
    SearchResult,
    SearchScope,
    UserContext,
)
from app.domain.text import analyze_query, term_matches_text, tokenize
from app.services.knowledge import KnowledgeService

logger = logging.getLogger("skh.search.service")


def corporate_excerpt(page: CorporatePage, query: str, limit: int = 260) -> list[HighlightSegment]:
    terms = analyze_query(query)
    words = page.body.split()
    segments: list[HighlightSegment] = []
    shown = 0
    for word in words:
        if shown + len(word) > limit:
            segments.append(HighlightSegment(text="…"))
            break
        hit = any(term_matches_text(t, tokenize(word)) for t in terms)
        segments.append(HighlightSegment(text=word + " ", highlight=hit))
        shown += len(word) + 1
    return segments


async def corporate_scope(
    connector: CorporateKnowledgeConnector, query: str, user: UserContext, limit: int
) -> tuple[list[CorporatePage], ScopeStatus]:
    if not connector.enabled:
        return [], ScopeStatus(scope="corporate", state="disabled", message=DISABLED_MESSAGE)
    try:
        pages = await connector.search(query, user, limit=limit)
    except ConnectorUnavailableError as exc:
        logger.warning("corporate connector unavailable: %s", exc.code)
        return [], ScopeStatus(scope="corporate", state="error", message=exc.message)
    status = await connector.status()
    message = (
        "Mock-коннектор: синтетические страницы, не настоящий Confluence."
        if status.state == "mock"
        else "Корпоративные источники подключены."
    )
    return pages, ScopeStatus(scope="corporate", state=status.state, message=message)


class SearchService:
    def __init__(self, knowledge: KnowledgeService, connector: CorporateKnowledgeConnector) -> None:
        self._knowledge = knowledge
        self._connector = connector

    async def search(
        self,
        user: UserContext,
        query: str,
        scopes: list[SearchScope],
        limit: int,
        filters: SearchFilters,
    ) -> SearchResponse:
        analysis = self._knowledge.retrieval.analyze(query)
        items: list[SearchResult] = []
        statuses: list[ScopeStatus] = []
        warnings: list[str] = [*analysis.notes]
        if not analysis.terms and not analysis.id_candidates:
            warnings.append("Запрос не содержит значимых слов.")

        if "team" in scopes:
            snapshot = await self._knowledge.snapshot(user)
            for ranked in self._knowledge.retrieval.rank_documents(snapshot, analysis, filters, limit):
                doc = snapshot.get(ranked.document_id)
                if doc is None:
                    continue
                hit = ranked.hit
                excerpt = (hit.excerpt if hit else "") or doc.summary or ""
                segments = (hit.segments if hit else None) or [HighlightSegment(text=truncate(excerpt, 260))]
                items.append(
                    SearchResult(
                        id=doc.id,
                        title=doc.title,
                        type=doc.type,
                        status=doc.status,
                        owner=doc.owner,
                        source=doc.source,
                        source_uri=doc.source_uri,
                        revision=doc.revision,
                        tags=list(doc.tags),
                        excerpt=truncate(excerpt, 320),
                        excerpt_segments=segments,
                        section=hit.section if hit else None,
                        section_anchor=hit.section_anchor if hit else None,
                        score=round(ranked.score, 4),
                        is_demo=doc.is_demo,
                        match_reasons=ranked.reasons,
                        matched_fields=ranked.matched_fields,
                        related_via=ranked.via,
                    )
                )
            statuses.append(
                ScopeStatus(
                    scope="team", state="connected", message="Локальный workspace с демо-документами."
                )
            )

        if "corporate" in scopes:
            pages, status = await corporate_scope(self._connector, query, user, limit)
            statuses.append(status)
            if status.state in ("disabled", "error"):
                warnings.append(status.message)
            seen = {(i.source, i.id) for i in items}
            for rank, page in enumerate(pages):
                if ("confluence", page.page_id) in seen:
                    continue
                items.append(
                    SearchResult(
                        id=page.page_id,
                        title=page.title,
                        type=None,
                        status=None,
                        owner=None,
                        source="confluence",
                        source_uri=page.source_uri,
                        revision=page.version,
                        tags=[f"space:{page.space}"],
                        excerpt=truncate(page.body, 320),
                        excerpt_segments=corporate_excerpt(page, query),
                        score=round(1.0 / (rank + 1), 4),
                        is_demo=page.is_mock,
                    )
                )
        return SearchResponse(query=query, items=items, total=len(items), scopes=statuses, warnings=warnings)
