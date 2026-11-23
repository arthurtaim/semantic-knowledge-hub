"""Grounded Q&A: retrieve authorized passages → provider → validate every citation."""

from __future__ import annotations

import contextlib
import logging
import re
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from app.adapters.ai.base import (
    AIProvider,
    AIProviderError,
    AnswerComplete,
    AnswerDelta,
    AnswerOptions,
    ContextPassage,
    ConversationTurn,
    ProviderAnswer,
    StreamingAIProvider,
    ai_error_status,
)
from app.adapters.corporate.base import CorporateKnowledgeConnector
from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.search.base import SearchFilters
from app.domain.markdown import truncate
from app.domain.models import (
    AskRequest,
    AskResponse,
    Citation,
    DocStatus,
    ExcludedSource,
    ScopeStatus,
    UserContext,
)
from app.domain.safety import neutralize_citation_markers, redact_prompt_injection
from app.domain.text import QueryTerm, analyze_query, term_matches_text, tokenize
from app.services.knowledge import KnowledgeService
from app.services.search import corporate_scope

logger = logging.getLogger("skh.assistant")

MAX_PASSAGES = 6
MAX_PASSAGE_CHARS = 1500
MAX_EXCLUDED = 5
MIN_QUOTE_CHARS = 12
_MARKER_RE = re.compile(r"\[(C\d{1,3})\]")
FIXED_INSUFFICIENT = (
    "Недостаточно данных: в найденных источниках нет подтверждённого ответа на вопрос. "
    "Ассистент не делает предположений о том, чего нет в документах."
)

DEMO_WARNING = "Используются только демо-документы (синтетические данные) — они не являются фактами о банке."


def _normalize(text: str) -> str:
    return " ".join(text.split()).casefold()


def quote_is_verbatim(quote: str, source_text: str) -> bool:
    haystack = _normalize(source_text)
    parts = [p.strip().rstrip("…").strip() for p in quote.split(" … ")]
    parts = [p for p in parts if p]
    return bool(parts) and all(_normalize(p) in haystack for p in parts)


def prepare_passage_text(text: str) -> tuple[str, bool]:
    """Untrusted source text → text safe to hand to a provider (and to quote back to the user)."""
    return redact_prompt_injection(neutralize_citation_markers(text))


@dataclass
class _Prepared:
    terms: list[QueryTerm]
    unmatched: list[QueryTerm]
    passages: list[ContextPassage]
    warnings: list[str]
    excluded: list[ExcludedSource]
    scopes: list[ScopeStatus]
    options: AnswerOptions


def _allowed_statuses(req: AskRequest) -> set[DocStatus]:
    allowed = {DocStatus.approved}
    if req.include_drafts:
        allowed |= {DocStatus.draft, DocStatus.in_review}
    if req.include_deprecated:
        allowed.add(DocStatus.deprecated)
    return allowed


class AssistantService:
    def __init__(
        self,
        knowledge: KnowledgeService,
        connector: CorporateKnowledgeConnector,
        provider: AIProvider,
        *,
        max_context_chars: int = 12000,
    ) -> None:
        self._knowledge = knowledge
        self._connector = connector
        self._provider = provider
        self._max_context_chars = max_context_chars

    @property
    def provider(self) -> AIProvider:
        return self._provider

    async def ask(self, user: UserContext, req: AskRequest) -> AskResponse:
        prepared = await self._prepare(user, req)
        if prepared.passages:
            result = await self._provider.answer(req.question, prepared.passages, prepared.options)
        else:
            result = self._no_passages_result(prepared)
        return self._finish(req, prepared, result)

    async def ask_stream(self, user: UserContext, req: AskRequest) -> AsyncGenerator[dict[str, Any], None]:
        """Same pipeline as `ask`, as events: status stages, PRELIMINARY text deltas (only from providers
        that stream; never validated, the UI labels them as such) and one `final` validated AskResponse.
        Provider errors become an `error` event. Closing the iterator cancels the generation."""
        yield {"type": "status", "stage": "retrieving"}
        try:
            prepared = await self._prepare(user, req)
            if not prepared.passages:
                result = self._no_passages_result(prepared)
            else:
                yield {
                    "type": "status",
                    "stage": "generating",
                    "passages": len(prepared.passages),
                    "provider": self._provider.mode,
                }
                stream = getattr(self._provider, "stream_answer", None)
                if stream is None:
                    result = await self._provider.answer(req.question, prepared.passages, prepared.options)
                else:
                    final: ProviderAnswer | None = None
                    async with contextlib.aclosing(
                        cast(StreamingAIProvider, self._provider).stream_answer(
                            req.question, prepared.passages, prepared.options
                        )
                    ) as events:
                        async for event in events:
                            if isinstance(event, AnswerDelta):
                                yield {"type": "delta", "text": event.text}
                            elif isinstance(event, AnswerComplete):
                                final = event.answer
                    if final is None:
                        raise AIProviderError("ai_invalid_response", "Провайдер не вернул ответ.")
                    result = final
                yield {"type": "status", "stage": "validating"}
            response = self._finish(req, prepared, result)
        except AIProviderError as exc:
            logger.info("ask_stream failed mode=%s code=%s", self._provider.mode, exc.code)
            yield {
                "type": "error",
                "code": exc.code,
                "message": exc.message,
                "status": ai_error_status(exc.code),
            }
            return
        yield {"type": "final", "response": response.model_dump(mode="json")}

    def _no_passages_result(self, prepared: _Prepared) -> ProviderAnswer:
        return ProviderAnswer(
            answer=self._no_passages_message(prepared.terms, prepared.unmatched),
            confidence="insufficient_evidence",
            evidence=[],
        )

    async def _prepare(self, user: UserContext, req: AskRequest) -> _Prepared:
        if self._provider.mode == "disabled":
            raise AIProviderError(
                "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled)."
            )
        # A follow-up ("а какие у неё ограничения?") is retrieved together with the previous question.
        retrieval_text = req.question if not req.history else f"{req.question} {req.history[-1].question}"
        terms = analyze_query(retrieval_text)
        allowed = _allowed_statuses(req)
        excluded_statuses = set(DocStatus) - allowed
        warnings: list[str] = []
        scopes: list[ScopeStatus] = []
        passages: list[ContextPassage] = []
        excluded: list[ExcludedSource] = []
        matched_terms: set[str] = set()
        budget = self._max_context_chars

        def next_cid() -> str:
            return f"C{len(passages) + 1}"

        if "team" in req.sources:
            snapshot = await self._knowledge.snapshot(user)
            search = self._knowledge.search_provider
            team_filters = SearchFilters(statuses=frozenset(s.value for s in allowed))
            seen: set[tuple[str, str]] = set()
            for chunk in search.search_chunks(terms, team_filters, MAX_PASSAGES * 2):
                doc = snapshot.get(chunk.document_id)
                key = (chunk.document_id, chunk.section_anchor)
                if doc is None or key in seen or len(passages) >= MAX_PASSAGES or budget <= 0:
                    continue
                seen.add(key)
                text, suspicious = prepare_passage_text(truncate(chunk.text, min(MAX_PASSAGE_CHARS, budget)))
                budget -= len(text)
                passages.append(
                    ContextPassage(
                        cid=next_cid(),
                        document_id=doc.id,
                        title=doc.title,
                        section=chunk.section if chunk.section_anchor else None,
                        section_anchor=chunk.section_anchor or None,
                        status=doc.status,
                        source_type=doc.source,
                        source_uri=doc.source_uri,
                        revision=doc.revision,
                        text=text,
                        is_demo=doc.is_demo,
                        suspicious=suspicious,
                    )
                )
            for term in terms:
                if search.matching_document_ids(term, team_filters):
                    matched_terms.add(term.stem)
            excluded = self._excluded_sources(snapshot_docs=snapshot, terms=terms, statuses=excluded_statuses)
            scopes.append(
                ScopeStatus(
                    scope="team", state="connected", message="Локальный workspace с демо-документами."
                )
            )

        if "corporate" in req.sources:
            pages, status = await corporate_scope(self._connector, req.question, user, limit=3)
            scopes.append(status)
            if status.state in ("disabled", "error"):
                warnings.append(status.message)
            for page in pages:
                if len(passages) >= MAX_PASSAGES or budget <= 0:
                    break
                text, suspicious = prepare_passage_text(truncate(page.body, min(MAX_PASSAGE_CHARS, budget)))
                budget -= len(text)
                words = tokenize(f"{page.title} {page.body}")
                matched_terms |= {t.stem for t in terms if term_matches_text(t, words)}
                passages.append(
                    ContextPassage(
                        cid=next_cid(),
                        document_id=page.page_id,
                        title=page.title,
                        section=None,
                        section_anchor=None,
                        status=None,
                        source_type="confluence",
                        source_uri=page.source_uri,
                        revision=page.version,
                        text=text,
                        is_demo=page.is_mock,
                        suspicious=suspicious,
                    )
                )

        unmatched = [t for t in terms if t.stem not in matched_terms]
        history = tuple(ConversationTurn(question=t.question, answer=t.answer) for t in req.history)
        return _Prepared(
            terms=terms,
            unmatched=unmatched,
            passages=passages,
            warnings=warnings,
            excluded=excluded,
            scopes=scopes,
            options=AnswerOptions(terms=terms, unmatched_terms=unmatched, history=history),
        )

    def _finish(self, req: AskRequest, prepared: _Prepared, result: ProviderAnswer) -> AskResponse:
        passages = prepared.passages
        warnings = [*prepared.warnings, *result.warnings]
        # Server-composed text (no passages, or the extractive mock) may be shown even when insufficient.
        trusted_text = not passages or self._provider.mode == "mock"
        response = self._validated_response(
            result, passages, warnings, prepared.excluded, prepared.scopes, prepared.unmatched, trusted_text
        )
        logger.info(
            "ask mode=%s scopes=%s passages=%d citations=%d confidence=%s history=%d",
            self._provider.mode,
            ",".join(req.sources),
            len(passages),
            len(response.citations),
            response.confidence,
            len(req.history),
        )
        return response

    def _excluded_sources(
        self, snapshot_docs: KnowledgeSnapshot, terms: list[QueryTerm], statuses: set[DocStatus]
    ) -> list[ExcludedSource]:
        if not terms or not statuses:
            return []
        search = self._knowledge.search_provider
        filters = SearchFilters(statuses=frozenset(s.value for s in statuses))
        entity_terms = [t for t in terms if t.is_entity_like]
        if entity_terms:
            candidates: set[str] | None = None
            for term in entity_terms:
                ids = search.matching_document_ids(term, filters)
                candidates = ids if candidates is None else candidates & ids
            matched = candidates or set()
        else:
            counts: dict[str, int] = {}
            for term in terms:
                for doc_id in search.matching_document_ids(term, filters):
                    counts[doc_id] = counts.get(doc_id, 0) + 1
            need = max(1, (len(terms) + 1) // 2)
            matched = {d for d, c in counts.items() if c >= need}
        result: list[ExcludedSource] = []
        for doc_id in sorted(matched)[:MAX_EXCLUDED]:
            doc = snapshot_docs.get(doc_id)
            if doc is None:
                continue
            reason = (
                "Устаревший документ исключён из доказательной базы."
                if doc.status == DocStatus.deprecated
                else "Неутверждённый документ исключён: включите «Учитывать черновики», чтобы использовать его."
            )
            result.append(
                ExcludedSource(document_id=doc.id, title=doc.title, status=doc.status, reason=reason)
            )
        return result

    @staticmethod
    def _no_passages_message(terms: list[QueryTerm], unmatched: list[QueryTerm]) -> str:
        if not terms:
            return "Вопрос не содержит значимых слов для поиска. Переформулируйте вопрос."
        missing = [t for t in unmatched if t.is_entity_like] or unmatched
        listed = ", ".join(f"«{t.original}»" for t in missing[:6])
        return (
            "Недостаточно данных: в доступных источниках не найдено подтверждённых сведений по вопросу"
            + (f" (не встречаются: {listed})" if listed else "")
            + ". Ассистент не делает предположений о том, чего нет в документах."
        )

    def _validated_response(
        self,
        result: ProviderAnswer,
        passages: list[ContextPassage],
        warnings: list[str],
        excluded: list[ExcludedSource],
        scopes: list[ScopeStatus],
        unmatched: list[QueryTerm],
        trusted_text: bool,
    ) -> AskResponse:
        by_cid = {p.cid: p for p in passages}
        retrieved_at = datetime.now(UTC)
        citations: list[Citation] = []
        cid_to_ref: dict[str, int] = {}
        rejected: set[str] = set()

        unverified: set[str] = set()

        def add(cid: str, quote: str | None) -> None:
            passage = by_cid.get(cid)
            if passage is None:
                rejected.add(cid)
                return
            if cid in cid_to_ref:
                return
            text = (quote or "").strip()
            # A citation counts only with a verbatim, non-trivial quote from the cited passage.
            if len(text) < MIN_QUOTE_CHARS or not quote_is_verbatim(text, passage.text):
                unverified.add(passage.title)
                return
            ref = len(citations) + 1
            cid_to_ref[cid] = ref
            app_path = None
            if passage.source_type in ("local", "gitlab"):
                app_path = f"/documents/{passage.document_id}" + (
                    f"#{passage.section_anchor}" if passage.section_anchor else ""
                )
            elif passage.is_demo:
                app_path = f"/corporate/{passage.document_id}"
            citations.append(
                Citation(
                    ref=ref,
                    source_type=passage.source_type,
                    document_id=passage.document_id,
                    title=passage.title,
                    source_uri=passage.source_uri,
                    revision=passage.revision,
                    status=passage.status,
                    section=passage.section,
                    section_anchor=passage.section_anchor,
                    excerpt=text,
                    retrieved_at=retrieved_at,
                    is_demo=passage.is_demo,
                    app_path=app_path,
                )
            )

        # Citations come only from the provider's structured evidence list; bare [Cn] markers in the
        # answer text never create citations on their own.
        for ev in result.evidence:
            add(ev.cid, ev.quote)
        if rejected:
            warnings.append(
                "Ответ ссылался на несуществующие источники ("
                + ", ".join(sorted(rejected))
                + ") — эти ссылки отброшены."
            )
        if unverified:
            warnings.append(
                "Ссылки без дословной цитаты из источника отброшены: " + ", ".join(sorted(unverified)) + "."
            )

        answer = _MARKER_RE.sub(
            lambda m: f"[{cid_to_ref[m.group(1)]}]" if m.group(1) in cid_to_ref else "", result.answer
        )
        confidence = result.confidence
        if confidence != "insufficient_evidence" and not citations:
            confidence = "insufficient_evidence"
            warnings.append("Ответ без проверяемых цитат отклонён.")
        if confidence == "supported" and (rejected or unverified):
            confidence = "partial"
        if confidence == "insufficient_evidence":
            citations, cid_to_ref = [], {}
            # Model-written text is not shown when evidence is insufficient: it may contain claims.
            answer = result.answer if trusted_text else FIXED_INSUFFICIENT
            answer = _MARKER_RE.sub("", answer)
        if excluded and confidence != "supported":
            titles = ", ".join(f"{e.document_id} ({e.status.value})" for e in excluded)
            answer += f"\n\nИсключены из доказательной базы по статусу: {titles}."

        used = [by_cid[c] for c in cid_to_ref] if citations else passages
        if any(p.is_demo for p in used) or not passages:
            warnings.insert(0, DEMO_WARNING)
        if any(c.status in (DocStatus.draft, DocStatus.in_review) for c in citations):
            warnings.append("Среди цитируемых источников есть неутверждённые документы (draft / in_review).")
        if any(c.status == DocStatus.deprecated for c in citations):
            warnings.append("Среди цитируемых источников есть устаревшие документы (deprecated).")
        if any(p.suspicious for p in passages):
            warnings.append(
                "В найденном источнике есть текст, похожий на инструкции для ИИ. Он обработан как данные и не "
                "влияет на работу системы."
            )
        deduped = list(dict.fromkeys(warnings))
        return AskResponse(
            answer=answer.strip(),
            mode=self._provider.mode,
            confidence=confidence,
            citations=citations,
            warnings=deduped,
            excluded_sources=excluded,
            scopes=scopes,
            unmatched_terms=[t.original for t in unmatched],
        )
