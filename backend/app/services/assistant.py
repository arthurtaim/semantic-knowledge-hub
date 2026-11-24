"""Grounded Q&A: retrieve authorized passages → provider → validate every citation."""

from __future__ import annotations

import contextlib
import json
import logging
import re
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

from pydantic import ValidationError

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
from app.adapters.knowledge.base import KnowledgeSnapshot, RepositoryUnavailableError
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
    SystemFact,
    TurnFactContext,
    UserContext,
)
from app.domain.safety import neutralize_citation_markers, redact_prompt_injection
from app.domain.skills import DEFAULT_SKILL
from app.domain.text import QueryTerm, reportable_terms, term_matches_text, tokenize
from app.services.assistant_tools import ToolContext
from app.services.attachments import Unit, format_locator
from app.services.discovery import DiscoveryStore, SourceLink, acl_scope_key
from app.services.external import ExternalEvidenceService, ExternalRetrieval
from app.services.knowledge import KnowledgeService
from app.services.search import corporate_scope

if TYPE_CHECKING:
    from app.services.assistant_loop import LoopOutcome, ToolLoop

logger = logging.getLogger("skh.assistant")

MAX_PASSAGES = 6
MAX_PASSAGE_CHARS = 1500
MAX_EXCLUDED = 5
MIN_QUOTE_CHARS = 12
_MARKER_RE = re.compile(r"\[(C\d{1,3})\]")
_FACT_RE = re.compile(r"\[(F\d{1,3})\]")
_NUMBER_RE = re.compile(r"\d(?:[\d\u00a0\u202f ]*\d)?")
FIXED_INSUFFICIENT = (
    "Недостаточно данных: в найденных источниках нет подтверждённого ответа на вопрос. "
    "Ассистент не делает предположений о том, чего нет в документах."
)

DEMO_WARNING = "Используются только демо-документы (синтетические данные) — они не являются фактами о банке."
ATTACHMENT_ONLY_WARNING = (
    "Ответ опирается только на вложение этого диалога: это не утверждённый документ базы знаний."
)
# M5.7 (tool loop): server-composed texts — the model's text is never shown without evidence.
TOOLS_CAPABILITIES = (
    "Системные данные SKH, доступные ассистенту: каталог документов (числа, списки, метаданные), поиск по "
    "содержимому, граф связей и реестр шаблонов."
)
GENERAL_WARNING = "Часть ответа основана на общих знаниях модели, а не на документах и данных SKH: это не внутренний источник."
FACT_NUMBER_WARNING = (
    "Число в тексте ответа не совпадает с данными системы — ориентируйтесь на значение в карточке факта."
)
LIMIT_TEXTS = {
    "round_limit": "достигнут лимит шагов работы с инструментами",
    "budget": "истекло время, отведённое на ответ",
    "invalid_model_response": "модель вернула ответ в неверном формате",
    "provider_error": "модель перестала отвечать",
}


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
        self._tool_loop: ToolLoop | None = None
        self._can_propose: Callable[[UserContext], bool] = lambda user: False

    @property
    def provider(self) -> AIProvider:
        return self._provider

    @property
    def instructions_version(self) -> str:
        return self._instructions_version()

    def attach_tools(self, loop: ToolLoop, can_propose: Callable[[UserContext], bool]) -> None:
        """M5.7: enable the bounded tool loop (wired by the container; the workflows depend on this service)."""
        self._tool_loop = loop
        self._can_propose = can_propose

    def tool_mode(self, extras: AskExtras = NO_EXTRAS) -> bool:
        """The tool loop runs for a plain question (or the default skill) when the provider can take part in it.
        Explicit skills keep their own pipelines; the mock provider keeps the content-only answer."""
        return (
            self._tool_loop is not None
            and bool(getattr(self._provider, "supports_tools", False))
            and (extras.skill is None or extras.skill.id == DEFAULT_SKILL)
            and not extras.compare_terms
        )

    async def ask(self, user: UserContext, req: AskRequest, extras: AskExtras = NO_EXTRAS) -> AskResponse:
        prepared = await self._prepare(user, req, extras)
        if self.tool_mode(extras):
            outcome: LoopOutcome | None = None
            async with contextlib.aclosing(self._tool_events(user, req, prepared)) as loop_events:
                async for item in loop_events:
                    if not isinstance(item, dict):
                        outcome = item
            assert outcome is not None  # the loop always ends with its outcome or raises
            return await self._finish_tools(user, req, prepared, outcome, extras)
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
            if self.tool_mode(extras):
                outcome: LoopOutcome | None = None
                async with contextlib.aclosing(self._tool_events(user, req, prepared)) as loop_events:
                    async for item in loop_events:
                        if isinstance(item, dict):
                            yield item
                        else:
                            outcome = item
                assert outcome is not None
                yield {"type": "status", "stage": "validating"}
                response = await self._finish_tools(user, req, prepared, outcome, extras)
                yield {"type": "final", "response": response.model_dump(mode="json")}
                return
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

    # --- M5.7: the tool loop -------------------------------------------------------------------------------------
    async def _context_note(self, user: UserContext, req: AskRequest) -> str:
        """The previous answer's referent (filters + visible IDs) as DATA for the model. IDs the reader can no
        longer see are dropped here — a referent is never an access grant (and every tool call re-checks)."""
        if not req.history or not req.history[-1].context:
            return ""
        try:
            snapshot = await self._knowledge.snapshot(user)
        except RepositoryUnavailableError:
            return ""  # no referent rather than an unchecked one
        items = [
            {
                "tool": c.tool,
                "operation": c.operation,
                "filters": c.filters,
                "document_ids": [d.id for i in c.document_ids if (d := snapshot.get(i)) is not None],
                "value": c.value,
            }
            for c in req.history[-1].context
        ]
        return json.dumps(items, ensure_ascii=False, default=str)[:3000]

    async def _tool_events(
        self, user: UserContext, req: AskRequest, prepared: _Prepared
    ) -> AsyncGenerator[dict[str, Any] | LoopOutcome, None]:
        assert self._tool_loop is not None
        ctx = ToolContext(
            user=user, allowed_statuses=frozenset(_allowed_statuses(req)), can_propose=self._can_propose(user)
        )
        async with contextlib.aclosing(
            self._tool_loop.run(
                cast(Any, self._provider),
                ctx,
                question=req.question,
                passages=prepared.passages,
                history=prepared.options.history,
                context_note=await self._context_note(user, req),
                mode=self._provider.mode,
            )
        ) as events:
            async for event in events:
                yield event

    async def _excerpt_sources(
        self, user: UserContext, passages: list[ContextPassage], known: dict[str, tuple[str, str | None]]
    ) -> dict[str, tuple[str, str | None]]:
        """(Markdown body, anchor) of every team passage — display of table excerpts only (as in `_prepare`)."""
        missing = [p for p in passages if p.source_type in ("local", "gitlab") and p.cid not in known]
        if not missing:
            return known
        try:
            snapshot = await self._knowledge.snapshot(user)
        except RepositoryUnavailableError:
            return known
        sources = dict(known)
        for p in missing:
            origin = snapshot.get(p.document_id)
            if origin is not None and origin.revision == p.revision:
                sources[p.cid] = (origin.body, p.section_anchor)
        return sources

    @staticmethod
    def _conversation_context(facts: list[SystemFact]) -> list[TurnFactContext]:
        out: list[TurnFactContext] = []
        for fact in facts[:5]:
            ids = [i.id for i in fact.items if i.kind == "document"][:20]
            value = fact.value if fact.value is not None and 0 <= fact.value <= 10_000_000 else None
            try:
                out.append(
                    TurnFactContext(
                        tool=fact.tool,
                        operation=fact.operation[:40],
                        filters=dict(fact.effective_filters),
                        document_ids=ids,
                        value=value,
                    )
                )
            except ValidationError:  # oversized filters: keep the referent without them
                out.append(
                    TurnFactContext(
                        tool=fact.tool, operation=fact.operation[:40], document_ids=ids, value=value
                    )
                )
        return out

    async def _finish_tools(
        self,
        user: UserContext,
        req: AskRequest,
        prepared: _Prepared,
        outcome: LoopOutcome,
        extras: AskExtras,
    ) -> AskResponse:
        passages = outcome.passages
        steps_failed = [s for s in outcome.steps if s.outcome != "ok" and s.message]
        if outcome.final is None:
            response = self._limit_response(prepared, outcome)
        else:
            final = outcome.final
            marked = list(dict.fromkeys(_FACT_RE.findall(final.answer.answer)))
            claimed = list(dict.fromkeys([*final.facts, *marked]))
            used = [outcome.facts[r] for r in claimed if r in outcome.facts]
            warnings = list(prepared.warnings)
            unknown = [r for r in claimed if r not in outcome.facts]
            if unknown:
                warnings.append(
                    "Ответ ссылался на несуществующие факты системы ("
                    + ", ".join(unknown[:5])
                    + ") — ссылки отброшены."
                )
            response = self._validated_response(
                final.answer,
                passages,
                warnings,
                prepared.excluded,
                prepared.scopes,
                prepared.unmatched,
                trusted_text=False,
                sources=await self._excerpt_sources(user, passages, prepared.sources),
                facts=used,
                general_knowledge=final.general_knowledge,
                insufficient_text=self._tools_insufficient_text(steps_failed),
                demo=None if passages else await self._knowledge_is_demo(user),
            )
            response.system_facts = used
            response.general_knowledge = (
                final.general_knowledge and response.confidence != "insufficient_evidence"
            )
            response.conversation_context = self._conversation_context(used)
            if not response.citations and (used or response.general_knowledge):
                # The lexical pre-retrieval did not answer this question: its status exclusions and unmatched words
                # would only be noise next to system facts or a general explanation.
                response.excluded_sources, response.unmatched_terms = [], []
        response.tool_steps = outcome.steps
        response.proposal = outcome.proposal
        generations = {f.generation for f in response.system_facts if f.source != "skh_template_registry"}
        if len(generations - {None}) > 1:
            response.warnings.append(
                "Данные системы получены из разных поколений индекса (синхронизация во время ответа)."
            )
        logger.info(
            "ask tools mode=%s rounds=%d steps=%d facts=%d citations=%d confidence=%s limit=%s",
            self._provider.mode,
            outcome.rounds,
            len(outcome.steps),
            len(response.system_facts),
            len(response.citations),
            response.confidence,
            outcome.limit or "-",
        )
        return self._record(user, req, replace(prepared, passages=passages), response, extras)

    async def _knowledge_is_demo(self, user: UserContext) -> bool | None:
        try:
            snapshot = await self._knowledge.snapshot(user)
        except RepositoryUnavailableError:
            return None
        return any(d.is_demo for d in snapshot.documents.values())

    @staticmethod
    def _tools_insufficient_text(failed: list[Any]) -> str:
        """The server's own text (the model's is never shown without evidence): what could not be checked."""
        reasons = list(dict.fromkeys(s.message for s in failed))[:3]
        checked = "Не удалось проверить: " + " ".join(reasons) + "\n\n" if reasons else ""
        return f"{FIXED_INSUFFICIENT}\n\n{checked}{TOOLS_CAPABILITIES}"

    def _limit_response(self, prepared: _Prepared, outcome: LoopOutcome) -> AskResponse:
        """Honest answer when the loop stopped without a final answer: what was verified (server-composed from
        the facts), what could not be checked — never the model's unvalidated text."""
        reason = LIMIT_TEXTS.get(outcome.limit or "round_limit", "ответ не завершён")
        facts: list[SystemFact] = []
        seen: set[str] = set()
        for fact in outcome.facts.values():  # the same observation twice is listed once
            key = json.dumps(
                [fact.tool, fact.operation, fact.value, fact.effective_filters], sort_keys=True, default=str
            )
            if key not in seen:
                seen.add(key)
                facts.append(fact)
        lines = [] if facts else [FIXED_INSUFFICIENT, ""]
        lines.append(f"Не удалось завершить ответ: {reason}.")
        if facts:
            lines.append("Проверенные данные системы SKH:")
            lines += [
                f"- {f.label}: {f.value} [{f.ref}]" if f.value is not None else f"- {f.label} [{f.ref}]"
                for f in facts
            ]
        failed = list(dict.fromkeys(s.message for s in outcome.steps if s.outcome != "ok" and s.message))
        if failed:
            lines.append("Не удалось проверить: " + " ".join(failed[:3]))
        warnings = [
            *prepared.warnings,
            "Ответ модели не получен полностью: показаны только проверенные данные.",
        ]
        if any(p.is_demo for p in outcome.passages) or not outcome.passages:
            warnings.insert(0, DEMO_WARNING)
        return AskResponse(
            answer="\n".join(lines),
            mode=self._provider.mode,
            confidence="partial" if facts else "insufficient_evidence",
            citations=[],
            warnings=list(dict.fromkeys(warnings)),
            excluded_sources=prepared.excluded,
            scopes=prepared.scopes,
            unmatched_terms=[t.original for t in reportable_terms(prepared.unmatched)],
            system_facts=facts,
            conversation_context=self._conversation_context(facts),
        )

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
        # Function words («через», «который») are never named: their absence says nothing about the topic.
        missing = [t for t in unmatched if t.is_entity_like] or reportable_terms(unmatched)
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
        *,
        facts: list[SystemFact] | None = None,
        general_knowledge: bool = False,
        insufficient_text: str = FIXED_INSUFFICIENT,
        demo: bool
        | None = None,  # tool mode without passages: whether the reader's knowledge is demo content
    ) -> AskResponse:
        """Every citation is verified against the passage it names. M5.7: verified SYSTEM FACTS (`facts`) are the
        evidence of system claims — an answer backed by them is not rejected for lacking a document quote; a
        general-knowledge answer is kept but labelled (never internal evidence). Without either, the existing gate
        applies unchanged."""
        by_cid = {p.cid: p for p in passages}
        sources = sources or {}
        facts = facts or []
        fact_refs = {f.ref for f in facts}
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
        # [Fn] markers survive only for the verified system facts this answer relies on.
        answer = _FACT_RE.sub(lambda m: m.group(0) if m.group(1) in fact_refs else "", answer)
        confidence = result.confidence
        if confidence == "insufficient_evidence" and facts:
            confidence = "partial"  # the model explains its limits around verified system facts
        if confidence != "insufficient_evidence" and not citations and not facts:
            if general_knowledge:
                confidence = "partial"  # shown, labelled as general knowledge — never as internal evidence
            else:
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
            answer = result.answer if trusted_text else insufficient_text
            answer = _FACT_RE.sub("", _MARKER_RE.sub("", answer))
        if excluded and confidence != "supported" and not facts and not general_knowledge:
            titles = ", ".join(f"{e.document_id} ({e.status.value})" for e in excluded)
            answer += f"\n\nИсключены из доказательной базы по статусу: {titles}."
        if general_knowledge and confidence != "insufficient_evidence":
            warnings.append(GENERAL_WARNING)
        if confidence != "insufficient_evidence":
            stated = {re.sub(r"\D", "", n) for n in _NUMBER_RE.findall(re.sub(r"\[[^\]]{1,6}\]", "", answer))}
            for fact in facts:
                if fact.operation == "count" and f"[{fact.ref}]" in answer and str(fact.value) not in stated:
                    warnings.append(FACT_NUMBER_WARNING)

        used = [by_cid[c] for c in cid_to_ref] if citations else passages
        if any(p.is_demo for p in used) or (not passages and demo is not False):
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
            unmatched_terms=[t.original for t in reportable_terms(unmatched)],
        )
