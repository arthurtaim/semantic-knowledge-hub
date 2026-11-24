"""Grounded Q&A: retrieve authorized passages → provider → validate every citation."""

from __future__ import annotations

import contextlib
import logging
import re
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field, replace
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
from app.domain.excerpts import citation_excerpt_parts
from app.domain.markdown import truncate
from app.domain.models import (
    AskRequest,
    AskResponse,
    Citation,
    DocStatus,
    ExcerptPart,
    ExcludedSource,
    ScopeStatus,
    SkillRef,
    UserContext,
)
from app.domain.safety import neutralize_citation_markers, redact_prompt_injection
from app.domain.text import QueryTerm, term_matches_text, tokenize
from app.services.attachments import Unit, format_locator
from app.services.discovery import DiscoveryStore, SourceLink, acl_scope_key
from app.services.external import ExternalEvidenceService, ExternalRetrieval
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
ATTACHMENT_ONLY_WARNING = (
    "Ответ опирается только на вложение этого диалога: это не утверждённый документ базы знаний."
)


@dataclass(frozen=True)
class AskExtras:
    """Inputs the user chose explicitly (UI v2), already resolved and verified by the skill layer.

    `context`: passages of documents the user picked («@документ») or selected — handed to the provider FIRST.
    `attachments`: fragments of files attached to the conversation — a separate evidence group, last.
    `retrieval_text`: replaces the question for knowledge-base retrieval (e.g. the question + a file header).
    Cids are assigned by the service; the placeholders in these passages are ignored."""

    context: tuple[ContextPassage, ...] = ()
    attachments: tuple[ContextPassage, ...] = ()
    retrieval_text: str | None = None
    skill: SkillRef | None = None
    compare_terms: bool = False  # compare_with_file: see AnswerOptions.compare_terms
    # What the discovery memory records as the query when attachments are involved: the user's own question
    # only — never words of a file (a header line in `retrieval_text`) or its name. None: the question as is.
    trace_text: str | None = None


NO_EXTRAS = AskExtras()


def _normalize(text: str) -> str:
    return " ".join(text.split()).casefold()


def locate_quote(passage: ContextPassage, quote: str) -> str | None:
    """Human locator of the lines of an attachment fragment that contain the (verified) quote."""
    lines = passage.text.split("\n")
    if not passage.locators or len(passage.locators) != len(lines):
        return passage.locator or None
    normalized = [_normalize(line) for line in lines]
    parts = [p.strip().rstrip("…").strip() for p in quote.split(" … ")]
    parts = [_normalize(p) for p in parts if p.strip()]
    if not parts:
        return passage.locator or None

    def span(needle: str, start: int) -> tuple[int, int] | None:
        for end in range(start, len(lines)):
            for begin in range(end, start - 1, -1):
                if needle in " ".join(n for n in normalized[begin : end + 1] if n):
                    return begin, end
        return None

    first = span(parts[0], 0)
    if first is None:
        return passage.locator or None
    last = span(parts[-1], first[0]) if len(parts) > 1 else first
    end = last[1] if last else first[1]
    a, b = passage.locators[first[0]], passage.locators[end]
    return format_locator(Unit(a[0], a[1], a[2], ""), Unit(b[0], b[1], b[2], ""))  # type: ignore[arg-type]


def quote_is_verbatim(quote: str, source_text: str) -> bool:
    haystack = _normalize(source_text)
    parts = [p.strip().rstrip("…").strip() for p in quote.split(" … ")]
    parts = [p for p in parts if p]
    return bool(parts) and all(_normalize(p) in haystack for p in parts)


def prepare_passage_text(text: str) -> tuple[str, bool]:
    """Untrusted source text → text safe to hand to a provider (and to quote back to the user)."""
    return redact_prompt_injection(neutralize_citation_markers(text))


def excerpt_display(source: tuple[str, str | None] | None, quote: str) -> list[ExcerptPart] | None:
    """`Citation.excerpt_parts` of a VERIFIED quote from (Markdown body, section anchor) of a team document: tables
    shown as rows. A display aid only: any failure leaves the plain excerpt, never fails the answer."""
    if source is None:
        return None
    try:
        return citation_excerpt_parts(source[0], source[1], quote)
    except Exception:
        logger.exception("excerpt layout failed")
        return None


@dataclass
class _Prepared:
    terms: list[QueryTerm]
    unmatched: list[QueryTerm]
    passages: list[ContextPassage]
    warnings: list[str]
    excluded: list[ExcludedSource]
    scopes: list[ScopeStatus]
    options: AnswerOptions
    normalized_query: str = ""
    mode: str = "local_only"
    external: ExternalRetrieval | None = None
    index_generation: str = ""
    # cid → (Markdown body, section anchor) of a team passage: display of table excerpts only.
    sources: dict[str, tuple[str, str | None]] = field(default_factory=dict)


def local_insufficiency(
    passages: list[ContextPassage], terms: list[QueryTerm], matched: set[str]
) -> str | None:
    """Why the team documents alone do not look sufficient (policy LOCAL_SUFFICIENCY v1), or None.
    Deterministic and explainable: it decides whether the external source is consulted at all."""
    if not terms:
        return None
    if not passages:
        return "no_local_passages"
    unmatched = [t for t in terms if t.stem not in matched]
    if any(t.is_entity_like for t in unmatched):
        return "unmatched_entities"
    if len(unmatched) * 3 > len(terms):
        return "low_term_coverage"
    # Words scattered over several documents are not an answer: one passage must cover ≥ 2/3 of the question.
    best = max(
        sum(1 for t in terms if term_matches_text(t, tokenize(f"{p.title} {p.section or ''} {p.text}")))
        for p in passages
    )
    if best * 3 < len(terms) * 2:
        return "no_single_local_passage"
    return None


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
        external: ExternalEvidenceService | None = None,
        discovery: DiscoveryStore | None = None,
        instructions_version: Callable[[], str] = lambda: "-",
    ) -> None:
        self._knowledge = knowledge
        self._connector = connector
        self._provider = provider
        self._max_context_chars = max_context_chars
        self._external = external
        self._discovery = discovery
        self._instructions_version = instructions_version

    @property
    def provider(self) -> AIProvider:
        return self._provider

    @property
    def instructions_version(self) -> str:
        return self._instructions_version()

    async def ask(self, user: UserContext, req: AskRequest, extras: AskExtras = NO_EXTRAS) -> AskResponse:
        prepared = await self._prepare(user, req, extras)
        if prepared.passages:
            result = await self._provider.answer(req.question, prepared.passages, prepared.options)
        else:
            result = self._no_passages_result(prepared)
        return self._record(user, req, prepared, self._finish(req, prepared, result), extras)

    async def ask_stream(
        self, user: UserContext, req: AskRequest, extras: AskExtras = NO_EXTRAS
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Same pipeline as `ask`, as events: status stages, PRELIMINARY text deltas (only from providers
        that stream; never validated, the UI labels them as such) and one `final` validated AskResponse.
        Provider errors become an `error` event. Closing the iterator cancels the generation."""
        yield {"type": "status", "stage": "retrieving"}
        try:
            prepared = await self._prepare(user, req, extras)
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
            response = self._record(user, req, prepared, self._finish(req, prepared, result), extras)
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

    async def _prepare(self, user: UserContext, req: AskRequest, extras: AskExtras = NO_EXTRAS) -> _Prepared:
        if self._provider.mode == "disabled":
            raise AIProviderError(
                "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled)."
            )
        # A follow-up ("а какие у неё ограничения?") is retrieved together with the previous question.
        base_text = extras.retrieval_text or req.question
        retrieval_text = base_text if not req.history else f"{base_text} {req.history[-1].question}"
        analysis = self._knowledge.retrieval.analyze(retrieval_text)
        terms = analysis.terms
        allowed = _allowed_statuses(req)
        excluded_statuses = set(DocStatus) - allowed
        warnings: list[str] = [*analysis.notes]
        scopes: list[ScopeStatus] = []
        passages: list[ContextPassage] = []
        excluded: list[ExcludedSource] = []
        matched_terms: set[str] = set()
        # Attachments have their own (already bounded) budget: they never crowd out the team documents.
        budget = self._max_context_chars - sum(len(p.text) for p in extras.attachments)
        seen: set[tuple[str, str]] = set()
        snapshot: KnowledgeSnapshot | None = None

        def next_cid() -> str:
            return f"C{len(passages) + 1}"

        # Context the user chose explicitly comes first, so it is cited first when relevant.
        for chosen in extras.context:
            passages.append(replace(chosen, cid=next_cid()))
            seen.add((chosen.document_id, chosen.section_anchor or ""))
            budget -= len(chosen.text)
            words = tokenize(f"{chosen.title} {chosen.section or ''} {chosen.text}")
            matched_terms |= {t.stem for t in terms if term_matches_text(t, words)}

        if "team" in req.sources:
            snapshot = await self._knowledge.snapshot(user)
            search = self._knowledge.search_provider
            team_filters = SearchFilters(statuses=frozenset(s.value for s in allowed))
            selected, _ranked = self._knowledge.retrieval.passages(
                snapshot, analysis, team_filters, max_passages=MAX_PASSAGES
            )
            team_count = 0
            for passage in selected:
                doc = passage.document
                key = (doc.id, passage.section_anchor or "")
                if key in seen or team_count >= MAX_PASSAGES or budget <= 0:
                    continue
                seen.add(key)
                team_count += 1
                text, suspicious = prepare_passage_text(
                    truncate(passage.text, min(MAX_PASSAGE_CHARS, budget))
                )
                budget -= len(text)
                passages.append(
                    ContextPassage(
                        cid=next_cid(),
                        document_id=doc.id,
                        title=doc.title,
                        section=passage.section if passage.section_anchor else None,
                        section_anchor=passage.section_anchor or None,
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

        mode = "local_only"
        external_result: ExternalRetrieval | None = None
        if "corporate" in req.sources and self._external is not None and self._external.enabled:
            connector_status = await self._connector.status()
            mode = "external" if "team" not in req.sources else "local_then_external"
            reason = (
                "external_scope_selected"
                if mode == "external"
                else "explicit_request"
                if req.search_external
                else local_insufficiency(passages, terms, matched_terms)
            )
            if reason is None:
                scopes.append(
                    ScopeStatus(
                        scope="corporate",
                        state=connector_status.state,
                        message="Не понадобились: в документах команды найдено достаточно подтверждений.",
                    )
                )
            else:
                snapshot_for_dedup = await self._knowledge.snapshot(user)
                external_result = await self._external.retrieve(
                    user, req.question, terms, snapshot_for_dedup, trigger=reason
                )
                warnings.extend(external_result.warnings)
                scopes.append(
                    ScopeStatus(
                        scope="corporate",
                        state="error" if external_result.degraded else connector_status.state,
                        message=(
                            "Корпоративный источник недоступен — использованы только документы команды."
                            if external_result.degraded
                            else "Mock-коннектор: синтетические страницы, не настоящий Confluence."
                            if connector_status.state == "mock"
                            else "Корпоративные источники подключены."
                        ),
                    )
                )
                ext_budget = max(budget, 0) if mode == "local_then_external" else self._max_context_chars
                ext_budget = min(
                    ext_budget or self._external.limits.context_chars, self._external.limits.context_chars
                )
                for fragment in external_result.fragments:
                    if ext_budget <= 0:
                        break
                    text, suspicious = prepare_passage_text(
                        truncate(fragment.text, min(MAX_PASSAGE_CHARS, ext_budget))
                    )
                    ext_budget -= len(text)
                    words = tokenize(f"{fragment.title} {fragment.heading or ''} {fragment.text}")
                    matched_terms |= {t.stem for t in terms if term_matches_text(t, words)}
                    passages.append(
                        ContextPassage(
                            cid=next_cid(),
                            document_id=fragment.page_id,
                            title=fragment.title,
                            section=fragment.heading,
                            section_anchor=fragment.anchor,
                            status=None,
                            source_type="confluence",
                            source_uri=fragment.uri,
                            revision=fragment.version,
                            text=text,
                            is_demo=fragment.is_mock,
                            suspicious=suspicious,
                            source_key=fragment.source_id,
                            external_status=fragment.status,
                            fragment_id=fragment.fragment_id,
                            content_hash=fragment.content_hash,
                        )
                    )
        elif "corporate" in req.sources:
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

        # Files of this conversation: a separate group after the knowledge sources. Their words do not count as
        # matched by the knowledge base (an attachment is not evidence of what the team documents say).
        for attached in extras.attachments:
            passages.append(replace(attached, cid=next_cid()))

        # The Markdown a team passage comes from (same revision): only for DISPLAY of a cited excerpt that touches a
        # table (Citation.excerpt_parts). The provider and the quote verification never see it.
        sources: dict[str, tuple[str, str | None]] = {}
        team_passages = [p for p in passages if p.source_type in ("local", "gitlab")]
        if team_passages:
            snapshot = snapshot if snapshot is not None else await self._knowledge.snapshot(user)
            for p in team_passages:
                origin = snapshot.get(p.document_id)
                if origin is not None and origin.revision == p.revision:
                    sources[p.cid] = (origin.body, p.section_anchor)

        unmatched = [t for t in terms if t.stem not in matched_terms]
        history = tuple(ConversationTurn(question=t.question, answer=t.answer) for t in req.history)
        return _Prepared(
            terms=terms,
            unmatched=unmatched,
            passages=passages,
            warnings=warnings,
            excluded=excluded,
            scopes=scopes,
            options=AnswerOptions(
                terms=terms, unmatched_terms=unmatched, history=history, compare_terms=extras.compare_terms
            ),
            normalized_query=analysis.normalized,
            mode=mode,
            external=external_result,
            index_generation=f"g{self._knowledge.generation}",
            sources=sources,
        )

    def _record(
        self,
        user: UserContext,
        req: AskRequest,
        prepared: _Prepared,
        response: AskResponse,
        extras: AskExtras = NO_EXTRAS,
    ) -> AskResponse:
        """Attach provenance (generation, instructions) and, when allowed, store the retrieval trace:
        which fragments were in context and which were cited — never the answer text. Attachments of a
        conversation are never written to the discovery memory."""
        response.index_generation = prepared.index_generation
        response.instructions_version = self._instructions_version()
        response.external = prepared.external.summary() if prepared.external else None
        response.skill = extras.skill
        if self._discovery is None:
            return response
        cited = {c.source_id for c in response.citations if c.source_id}
        links: dict[str, SourceLink] = {}
        for passage in prepared.passages:
            if passage.source_type == "attachment":
                continue
            if passage.source_type == "confluence":
                key = passage.source_key or f"confluence:-:{passage.document_id}:{passage.revision}"
                kind = "confluence_mcp"
            else:
                key = f"{passage.source_type}:{passage.document_id}"
                kind = "gitlab_approved" if passage.source_type == "gitlab" else "local_markdown"
            link = links.setdefault(
                key,
                SourceLink(
                    source_kind=kind,
                    source_id=key,
                    version=passage.revision,
                    title=passage.title,
                    page_id=passage.document_id if kind == "confluence_mcp" else None,
                    status=passage.external_status
                    if kind == "confluence_mcp"
                    else (passage.status.value if passage.status else None),
                    uri=passage.source_uri,
                ),
            )
            link.fragment_ids.append(passage.fragment_id or passage.section_anchor or passage.cid)
            link.cited = link.cited or key in cited
        query_text, normalized, intent = (
            req.question,
            prepared.normalized_query,
            [t.stem for t in prepared.terms],
        )
        if extras.trace_text is not None:
            own = self._knowledge.retrieval.analyze(extras.trace_text) if extras.trace_text.strip() else None
            query_text = extras.trace_text
            normalized, intent = (own.normalized, [t.stem for t in own.terms]) if own else ("", [])
        try:
            response.retrieval_trace_id = self._discovery.record(
                acl_scope=acl_scope_key(user),
                normalized_query=normalized,
                intent=intent,
                query_text=query_text,
                mode=prepared.mode,
                trigger=prepared.external.trigger if prepared.external else "-",
                confidence=response.confidence,
                index_generation=prepared.index_generation,
                instructions_version=response.instructions_version or "-",
                external=response.external or {},
                sources=list(links.values()),
            )
        except Exception:
            logger.exception("retrieval trace not recorded")
        return response

    def _finish(self, req: AskRequest, prepared: _Prepared, result: ProviderAnswer) -> AskResponse:
        passages = prepared.passages
        warnings = [*prepared.warnings, *result.warnings]
        # Server-composed text (no passages, or the extractive mock) may be shown even when insufficient.
        trusted_text = not passages or self._provider.mode == "mock"
        response = self._validated_response(
            result,
            passages,
            warnings,
            prepared.excluded,
            prepared.scopes,
            prepared.unmatched,
            trusted_text,
            sources=prepared.sources,
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
        sources: dict[str, tuple[str, str | None]] | None = None,
    ) -> AskResponse:
        by_cid = {p.cid: p for p in passages}
        sources = sources or {}
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
            if passage.source_type == "attachment":
                # The fragment is a verbatim window of the file's extracted text, so a verified quote really
                # exists in the attachment; the locator is computed here, never taken from a model.
                citations.append(
                    Citation(
                        ref=ref,
                        source_type="attachment",
                        document_id=passage.document_id,
                        title=passage.title,
                        source_uri=passage.source_uri,
                        revision=passage.revision,
                        status=None,
                        section=None,
                        section_anchor=None,
                        excerpt=text,
                        retrieved_at=retrieved_at,
                        is_demo=False,
                        app_path=None,
                        source_id=f"attachment:{passage.document_id}",
                        content_hash=passage.content_hash,
                        attachment_id=passage.attachment_id,
                        attachment_name=passage.title,
                        locator=locate_quote(passage, text),
                    )
                )
                return
            app_path = None
            if passage.source_type in ("local", "gitlab"):
                app_path = f"/documents/{passage.document_id}" + (
                    f"#{passage.section_anchor}" if passage.section_anchor else ""
                )
            elif passage.is_demo:
                app_path = f"/corporate/{passage.document_id}"
            external = passage.source_type == "confluence"
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
                    source_kind="confluence_mcp"
                    if external
                    else "gitlab_approved"
                    if passage.source_type == "gitlab"
                    else "local_markdown",
                    source_id=(passage.source_key or f"confluence:-:{passage.document_id}:{passage.revision}")
                    if external
                    else f"{passage.source_type}:{passage.document_id}",
                    external_status=(passage.external_status or "unknown") if external else None,
                    fragment_id=passage.fragment_id or passage.section_anchor,
                    content_hash=passage.content_hash,
                    excerpt_parts=excerpt_display(sources.get(cid), text),
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
        if (
            confidence != "insufficient_evidence"
            and citations
            and all(c.source_type == "attachment" for c in citations)
        ):
            # A file the user attached is not an approved source: it can never make an answer "supported".
            confidence = "partial" if confidence == "supported" else confidence
            warnings.append(ATTACHMENT_ONLY_WARNING)
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
        unconfirmed = sorted(
            {
                c.title
                for c in citations
                if c.source_kind == "confluence_mcp" and c.external_status != "approved"
            }
        )
        if unconfirmed:
            warnings.append(
                "Сведения со страниц Confluence, статус которых не подтверждён (это не утверждённые документы "
                "команды): " + "; ".join(unconfirmed) + "."
            )
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
