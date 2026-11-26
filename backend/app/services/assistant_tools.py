"""SystemToolExecutor (M5.7): validated tool calls → existing services, with the SERVER identity only.

Every call reads the reader's own snapshot (`KnowledgeService.snapshot(user)` — the repository is the access
boundary), so counts, lists, links, paths and template usage never include what the reader cannot see, and an
unknown ID and a hidden ID give the same `not_found`. Outputs are compact, bounded and carry provenance: generation,
as_of, source, effective filters and access scope. Document content leaves only as passages prepared exactly like
the assistant's own (`prepare_passage_text`), so quotes are verified by the existing citation gate.

Nothing here writes knowledge. `drafts_propose` delegates to the existing AiWorkflowService, which stores a
PROPOSAL (Accept/Reject stays an explicit user action, stale checks unchanged); it is offered only to users who may
create proposals.

M6: `work_inspect` reads projects, tasks, dependencies and plan summaries of the work module through
`app/work/inspect.py` (read-only, the reader's own projects, bounded); it is offered only when the work module is
enabled and the reader may view tasks. There is no work WRITE tool: AI task plans are typed proposals created and
applied only from the project UI after an explicit Accept (app/work/ai.py).
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from app.adapters.ai.base import ContextPassage
from app.adapters.knowledge.base import KnowledgeSnapshot, RepositoryUnavailableError
from app.adapters.search.base import SearchFilters
from app.domain.assistant_tools import (
    READ_TOOLS,
    WORK_TOOL,
    CatalogFilters,
    CatalogQueryArgs,
    DraftsProposeArgs,
    GraphInspectArgs,
    KnowledgeSearchArgs,
    TemplatesInspectArgs,
    ToolName,
    WorkInspectArgs,
    _Args,
)
from app.domain.doc_tree import ATTENTION_REASON_LABELS, AttentionReason
from app.domain.markdown import truncate
from app.domain.models import (
    DocStatus,
    DocumentRecord,
    ProposalRef,
    SystemFact,
    SystemFactItem,
    SystemFactSource,
    ToolOutcome,
    UserContext,
)
from app.domain.safety import neutralize_citation_markers, redact_prompt_injection
from app.errors import ApiError
from app.services import graph as g
from app.services.knowledge import owner_missing as _owner_missing
from app.services.knowledge import sort_documents
from app.services.retrieval import only_boilerplate
from app.work.links import DocumentScope

if TYPE_CHECKING:
    from app.services.ai_workflows import AiWorkflowService
    from app.services.graph import GraphService
    from app.services.knowledge import KnowledgeService
    from app.services.links import LinkService
    from app.services.template_hub import TemplateHubService
    from app.work.inspect import WorkInspector

logger = logging.getLogger("skh.assistant.tools")

MAX_TEXT_MATCHES = 5000
PASSAGE_CHARS = 900
READ_SECTION_CHARS = 1200
READ_TOTAL_CHARS = 3000
FACET_TOP = 15
NOT_COUNTED = (
    "версии и ревизии, фрагменты поиска, шаблоны, предложения ИИ, вложения диалога, страницы Confluence"
)
REFERENCES_NOTE = (
    "references — ссылка (WikiLink [[ID]] или related_ids), а не подтверждённая зависимость; бизнес-связи "
    "(depends_on, consumes, produces, maps_to, …) объявлены людьми в метаданных документа."
)


@dataclass(frozen=True)
class ToolContext:
    """Request context of tool calls: the server identity and what THIS request may use as evidence."""

    user: UserContext
    allowed_statuses: frozenset[DocStatus]
    can_propose: bool = False


@dataclass
class ToolResult:
    tool: str
    operation: str
    outcome: ToolOutcome
    payload: dict[str, Any]  # model-visible JSON (the loop bounds its size)
    fact: SystemFact | None = None
    passages: list[ContextPassage] = field(default_factory=list)
    proposal: ProposalRef | None = None
    result_count: int | None = None
    error_code: str | None = None
    message: str | None = None


class ToolFailure(Exception):
    """A typed, sanitized failure: the model and the user see `message`, never an exception text."""

    def __init__(self, outcome: ToolOutcome, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.outcome = outcome
        self.code = code
        self.message = message
        self.details = details


def failure_result(tool: str, operation: str, failure: ToolFailure) -> ToolResult:
    return ToolResult(
        tool=tool,
        operation=operation,
        outcome=failure.outcome,
        payload={"error": {"code": failure.code, "message": failure.message, **failure.details}},
        error_code=failure.code,
        message=failure.message,
    )


def _prepare(text: str) -> tuple[str, bool]:
    """Exactly `services.assistant.prepare_passage_text` (not imported: the assistant imports this module)."""
    return redact_prompt_injection(neutralize_citation_markers(text))


def _doc_path(doc_id: str) -> str:
    return f"/documents/{doc_id}"


def _doc_item(doc: DocumentRecord, detail: str | None = None) -> SystemFactItem:
    return SystemFactItem(
        id=doc.id,
        title=doc.title,
        kind="document",
        status=doc.status.value,
        detail=detail,
        app_path=_doc_path(doc.id),
        is_demo=doc.is_demo,
    )


def _doc_row(doc: DocumentRecord) -> dict[str, Any]:
    return {
        "id": doc.id,
        "title": doc.title,
        "status": doc.status.value,
        "type": doc.type.value,
        "owner": "unassigned" if _owner_missing(doc) else doc.owner,
        "tags": list(doc.tags[:8]),
        "updated": doc.metadata_updated_at.isoformat() if doc.metadata_updated_at else None,
        # provenance as metadata (synthetic/demo mark of the document), never a claim about its content
        "synthetic": doc.is_demo,
    }


def _doc_detail(doc: DocumentRecord, attention: tuple[AttentionReason, ...] = ()) -> str:
    owner = "владелец не назначен" if _owner_missing(doc) else f"владелец: {doc.owner}"
    updated = f" · обновлён {doc.metadata_updated_at.isoformat()}" if doc.metadata_updated_at else ""
    why = f" · требует внимания: {_attention_words(attention)}" if attention else ""
    return f"{doc.type.value} · {owner}{updated}{why}"


def _attention_words(reasons: tuple[AttentionReason, ...]) -> str:
    return ", ".join(ATTENTION_REASON_LABELS[r] for r in reasons)


class SystemToolExecutor:
    def __init__(
        self,
        *,
        knowledge: KnowledgeService,
        links: LinkService,
        graph: GraphService,
        templates: TemplateHubService,
        workflows: AiWorkflowService | None = None,
        work: WorkInspector | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._knowledge = knowledge
        self._links = links
        self._graph = graph
        self._templates = templates
        self._workflows = workflows
        self._work = work
        self._clock = clock

    def available(self, ctx: ToolContext) -> tuple[ToolName, ...]:
        """Tools offered to the model for this request (a tool the user may not use is not even described)."""
        tools: tuple[ToolName, ...] = READ_TOOLS
        if self._work is not None and self._work.offered(ctx.user):
            tools = (*tools, WORK_TOOL)
        if ctx.can_propose and self._workflows is not None:
            tools = (*tools, "drafts_propose")
        return tools

    async def execute(
        self, ctx: ToolContext, tool: ToolName, args: _Args, *, fact_ref: str, cid_start: int
    ) -> ToolResult:
        operation = str(getattr(args, "operation", None) or getattr(args, "kind", "-"))
        try:
            if isinstance(args, CatalogQueryArgs):
                return await self._catalog(ctx, args, fact_ref)
            if isinstance(args, KnowledgeSearchArgs):
                return await self._knowledge_search(ctx, args, cid_start)
            if isinstance(args, GraphInspectArgs):
                return await self._graph_inspect(ctx, args, fact_ref)
            if isinstance(args, TemplatesInspectArgs):
                return await self._templates_inspect(ctx, args, fact_ref)
            if isinstance(args, DraftsProposeArgs):
                return await self._propose(ctx, args, fact_ref)
            if isinstance(args, WorkInspectArgs):
                return await self._work_inspect(ctx, args, fact_ref)
            raise ToolFailure("unknown_tool", "unknown_tool", "Такого инструмента нет.")
        except ToolFailure as failure:
            return failure_result(tool, operation, failure)
        except RepositoryUnavailableError:
            return failure_result(
                tool,
                operation,
                ToolFailure(
                    "unavailable",
                    "registry_unavailable",
                    "Реестр документов сейчас недоступен: проверить нельзя.",
                ),
            )
        except ApiError as exc:
            outcome: ToolOutcome = (
                "not_found"
                if exc.status_code == 404
                else "denied"
                if exc.status_code == 403
                else "invalid"
                if exc.status_code in (409, 422)
                else "unavailable"
            )
            return failure_result(tool, operation, ToolFailure(outcome, exc.code, exc.message[:300]))

    # --- shared ----------------------------------------------------------------------------------------------
    async def _snapshot(self, ctx: ToolContext) -> tuple[KnowledgeSnapshot, str]:
        snapshot = await self._knowledge.snapshot(ctx.user)
        return snapshot, self._knowledge.generation_label(snapshot)

    def _fact(
        self,
        *,
        ref: str,
        tool: str,
        operation: str,
        label: str,
        source: SystemFactSource,
        generation: str | None,
        **values: Any,
    ) -> SystemFact:
        return SystemFact(
            ref=ref,
            tool=tool,
            operation=operation,
            label=label,
            source=source,
            generation=generation,
            as_of=self._clock(),
            **values,
        )

    @staticmethod
    def _provenance(fact: SystemFact) -> dict[str, Any]:
        return {
            "fact_id": fact.ref,
            "scope": fact.access_scope,
            "source": fact.source,
            "generation": fact.generation,
            "as_of": fact.as_of.isoformat(timespec="seconds"),
        }

    # --- catalog_query ---------------------------------------------------------------------------------------
    def _select(
        self, snapshot: KnowledgeSnapshot, args: CatalogQueryArgs, ctx: ToolContext, today: date
    ) -> tuple[list[DocumentRecord], dict[str, Any], list[str]]:
        f: CatalogFilters = args.filters
        docs = list(snapshot.documents.values())
        effective: dict[str, Any] = {}
        definitions: list[str] = []
        if args.document_ids:
            wanted = {i.lower() for i in args.document_ids}
            docs = [d for d in docs if d.id.lower() in wanted]
            effective["document_ids"] = list(args.document_ids)  # as requested: never "which of them exist"
        statuses: set[DocStatus] | None = set(f.status) if f.status else None
        if f.eligible_for_answers:
            eligible = set(ctx.allowed_statuses)
            statuses = eligible if statuses is None else statuses & eligible
            effective["eligible_for_answers"] = True
            definitions.append(
                "eligible_for_answers: документы, которые ассистент может цитировать в этом запросе (по умолчанию "
                "только approved; черновики и устаревшие — только если пользователь их включил)."
            )
        if statuses is not None:
            docs = [d for d in docs if d.status in statuses]
            effective["status"] = sorted(s.value for s in statuses)
        if f.type:
            types = set(f.type)
            docs = [d for d in docs if d.type in types]
            effective["type"] = sorted(t.value for t in types)
        if f.owner:
            owner = f.owner.strip().casefold()
            docs = [d for d in docs if d.owner.strip().casefold() == owner]
            effective["owner"] = f.owner
        if f.owner_missing is not None:
            docs = [d for d in docs if _owner_missing(d) == f.owner_missing]
            effective["owner_missing"] = f.owner_missing
            definitions.append(
                "owner_missing: владелец не назначен (owner: unassigned или пусто) — не угадывается."
            )
        if f.needs_attention is not None:
            # The documents tree's rule on the same inputs (KnowledgeService.attention_reasons), for today.
            docs = [d for d in docs if bool(self._knowledge.attention_reasons(d, today)) == f.needs_attention]
            effective["needs_attention"] = f.needs_attention
            definitions.append(
                f"{self._knowledge.attention_rule()} Проверка — на {today.isoformat()}."
                + ("" if f.needs_attention else " Здесь — документы, которым внимание НЕ требуется.")
            )
        if f.tags:
            tags = {t.casefold() for t in f.tags}
            docs = [d for d in docs if tags <= {t.casefold() for t in d.tags}]
            effective["tags"] = list(f.tags)
            definitions.append("tags: системные теги из метаданных документа (все указанные должны быть).")
        if f.template_id:
            docs = [d for d in docs if (d.template_id or "").casefold() == f.template_id.casefold()]
            effective["template_id"] = f.template_id
        if f.updated_from or f.updated_to:
            low, high = f.updated_from, f.updated_to
            docs = [
                d
                for d in docs
                if d.metadata_updated_at is not None
                and (low is None or d.metadata_updated_at >= low)
                and (high is None or d.metadata_updated_at <= high)
            ]
            if low:
                effective["updated_from"] = low.isoformat()
            if high:
                effective["updated_to"] = high.isoformat()
            definitions.append(
                "updated_*: дата updated_at из метаданных документа; документы без даты не входят."
            )
        if f.text:
            matched = self._text_matches(snapshot, f.text)
            docs = [d for d in docs if d.id.lower() in matched]
            effective["text"] = f.text
            definitions.append(
                f"text «{f.text}»: полнотекстовое совпадение — в документе встречаются все слова запроса (с учётом "
                "словаря синонимов). Это не системный тег и не подтверждённая принадлежность."
            )
        return docs, effective, definitions

    def _text_matches(self, snapshot: KnowledgeSnapshot, text: str) -> set[str]:
        analysis = self._knowledge.retrieval.analyze(text)
        matched = {d.id.lower() for i in analysis.id_candidates if (d := snapshot.get(i)) is not None}
        if not analysis.terms and not matched:
            raise ToolFailure(
                "invalid", "invalid_arguments", "В filters.text нет слов, по которым можно искать."
            )
        if analysis.terms:
            limit = min(MAX_TEXT_MATCHES, len(snapshot.documents) + 1)
            hits = self._knowledge.search_provider.search_documents(
                analysis.terms, SearchFilters(), limit, mode="and", snippets=False
            )
            matched |= {h.document_id.lower() for h in hits if snapshot.get(h.document_id) is not None}
        return matched

    async def _catalog(self, ctx: ToolContext, args: CatalogQueryArgs, ref: str) -> ToolResult:
        snapshot, generation = await self._snapshot(ctx)
        tool, op = "catalog_query", args.operation
        if op == "get_metadata":
            return self._metadata(snapshot, generation, args, ref)
        today = self._knowledge.today()
        docs, effective, definitions = self._select(snapshot, args, ctx, today)
        definition = " ".join(definitions) or None
        # With the attention filter, each document carries WHY it needs attention: list rows and card details, and
        # the number of documents per reason for count and facets.
        with_reasons = args.filters.needs_attention is True
        reasons: dict[str, tuple[AttentionReason, ...]] = (
            {d.id: self._knowledge.attention_reasons(d, today) for d in docs} if with_reasons else {}
        )
        by_reason: dict[str, dict[str, int]] = (
            {
                "attention": dict(
                    sorted(
                        Counter(r for rs in reasons.values() for r in rs).items(), key=lambda i: (-i[1], i[0])
                    )
                )
            }
            if with_reasons
            else {}
        )
        if op == "count":
            fact = self._fact(
                ref=ref,
                tool=tool,
                operation=op,
                label="Документы в доступном каталоге SKH",
                source="skh_document_registry",
                generation=generation,
                value=len(docs),
                unit="documents",
                effective_filters=effective,
                definition=definition,
                breakdown=by_reason or None,
            )
            payload: dict[str, Any] = {
                **self._provenance(fact),
                "count": len(docs),
                "unit": "distinct canonical documents",
                "effective_filters": effective,
                "not_counted": NOT_COUNTED,
            }
            if definition:
                payload["definition"] = definition
            if by_reason:
                payload["documents_per_reason"] = by_reason[
                    "attention"
                ]  # a document may have several reasons
            if not effective and snapshot.issues:
                payload["files_not_loaded"] = len({i.path for i in snapshot.issues})
            return ToolResult(tool, op, "ok", payload, fact=fact, result_count=len(docs))
        if op == "facets":
            breakdown = {**self._facets(docs), **by_reason}
            fact = self._fact(
                ref=ref,
                tool=tool,
                operation=op,
                label="Распределение документов доступного каталога",
                source="skh_document_registry",
                generation=generation,
                value=len(docs),
                unit="documents",
                effective_filters=effective,
                definition=definition,
                breakdown=breakdown,
            )
            payload = {
                **self._provenance(fact),
                "total": len(docs),
                "effective_filters": effective,
                "breakdown": breakdown,
            }
            return ToolResult(tool, op, "ok", payload, fact=fact, result_count=len(docs))
        ordered = (
            sorted(docs, key=lambda d: d.id.casefold())
            if args.sort == "id"
            else sort_documents(docs, args.sort)
        )
        page = ordered[args.offset : args.offset + args.limit]
        more = args.offset + len(page) < len(ordered)
        fact = self._fact(
            ref=ref,
            tool=tool,
            operation=op,
            label="Документы доступного каталога SKH",
            source="skh_document_registry",
            generation=generation,
            value=len(ordered),
            unit="documents",
            effective_filters={**effective, "sort": args.sort},
            definition=definition,
            items=[_doc_item(d, _doc_detail(d, reasons.get(d.id, ()))) for d in page],
            truncated=more,
        )
        payload = {
            **self._provenance(fact),
            "total": len(ordered),
            "effective_filters": {**effective, "sort": args.sort},
            "offset": args.offset,
            "items": [
                {**_doc_row(d), "attention": list(reasons[d.id])} if with_reasons else _doc_row(d)
                for d in page
            ],
            "next_offset": args.offset + len(page) if more else None,
        }
        if definition:
            payload["definition"] = definition
        return ToolResult(tool, op, "ok", payload, fact=fact, result_count=len(ordered))

    @staticmethod
    def _facets(docs: list[DocumentRecord]) -> dict[str, dict[str, int]]:
        def top(values: list[str]) -> dict[str, int]:
            counted = sorted(Counter(values).items(), key=lambda i: (-i[1], i[0]))
            return dict(counted[:FACET_TOP])

        return {
            "status": top([d.status.value for d in docs]),
            "type": top([d.type.value for d in docs]),
            "owner": top(["unassigned" if _owner_missing(d) else d.owner for d in docs]),
            "tag": top([t for d in docs for t in d.tags]),
            # whole-scope provenance: how many of these documents are marked synthetic (an exhaustive check)
            "provenance": top(["synthetic" if d.is_demo else "not_synthetic" for d in docs]),
        }

    def _metadata(
        self, snapshot: KnowledgeSnapshot, generation: str, args: CatalogQueryArgs, ref: str
    ) -> ToolResult:
        found: list[DocumentRecord] = []
        not_found: list[str] = []
        for requested in dict.fromkeys(args.document_ids):
            doc = snapshot.get(requested)
            if doc is None or requested.lower() in snapshot.duplicates:
                not_found.append(requested)  # unknown and not visible are indistinguishable on purpose
            elif doc not in found:
                found.append(doc)
        rows = [
            {
                **_doc_row(doc),
                "version": doc.version,
                "revision": doc.revision,
                "reviewed_at": doc.reviewed_at.isoformat() if doc.reviewed_at else None,
                "template": f"{doc.template_id}@v{doc.template_version}" if doc.template_id else None,
                "aliases": list(doc.aliases[:5]),
                "source": doc.source,
                "summary": truncate(doc.summary or "", 300) or None,
                # «Требуют внимания» reasons (the documents tree's rule, today); [] = no attention needed
                "attention": list(self._knowledge.attention_reasons(doc)),
            }
            for doc in found
        ]
        fact = self._fact(
            ref=ref,
            tool="catalog_query",
            operation="get_metadata",
            label="Метаданные документов",
            source="skh_document_registry",
            generation=generation,
            value=len(found),
            unit="documents",
            effective_filters={"document_ids": list(args.document_ids)},
            items=[_doc_item(d, _doc_detail(d)) for d in found],
        )
        payload = {**self._provenance(fact), "documents": rows, "not_found": not_found}
        if not found:
            payload["note"] = "Документы с такими ID не найдены в доступном каталоге."
        return ToolResult("catalog_query", "get_metadata", "ok", payload, fact=fact, result_count=len(found))

    # --- knowledge_search ------------------------------------------------------------------------------------
    def _passage(
        self, doc: DocumentRecord, section: str | None, anchor: str | None, raw: str, cid: str, chars: int
    ) -> ContextPassage:
        text, suspicious = _prepare(truncate(raw, chars))
        return ContextPassage(
            cid=cid,
            document_id=doc.id,
            title=doc.title,
            section=section if anchor else None,
            section_anchor=anchor or None,
            status=doc.status,
            source_type=doc.source,
            source_uri=doc.source_uri,
            revision=doc.revision,
            text=text,
            is_demo=doc.is_demo,
            suspicious=suspicious,
        )

    @staticmethod
    def _passage_row(p: ContextPassage) -> dict[str, Any]:
        return {
            "id": p.cid,
            "document_id": p.document_id,
            "title": p.title,
            "section": p.section,
            "status": p.status.value if p.status else None,
            "revision": p.revision,
        }

    async def _knowledge_search(
        self, ctx: ToolContext, args: KnowledgeSearchArgs, cid_start: int
    ) -> ToolResult:
        snapshot, generation = await self._snapshot(ctx)
        statuses = frozenset(s.value for s in ctx.allowed_statuses)
        effective: dict[str, Any] = {"status": sorted(statuses)}
        if args.operation == "read":
            return self._read(snapshot, generation, args, ctx, cid_start, effective)
        assert args.query is not None  # validated by the schema
        retrieval = self._knowledge.retrieval
        analysis = retrieval.analyze(args.query)
        if not analysis.terms and not analysis.id_candidates:
            raise ToolFailure("invalid", "invalid_arguments", "В query нет слов, по которым можно искать.")
        filters = SearchFilters(
            statuses=statuses,
            types=frozenset(t.value for t in args.types) if args.types else None,
            tags=frozenset(args.tags) if args.tags else None,
        )
        if args.types:
            effective["type"] = sorted(t.value for t in args.types)
        if args.tags:
            effective["tags"] = list(args.tags)
        selected, ranked = retrieval.passages(
            snapshot, analysis, filters, max_documents=args.limit, max_passages=args.limit
        )
        passages: list[ContextPassage] = []
        for item in selected:
            if snapshot.get(item.document.id) is None:  # defence in depth: the reader's snapshot only
                continue
            passages.append(
                self._passage(
                    item.document,
                    item.section,
                    item.section_anchor,
                    item.text,
                    f"C{cid_start + len(passages)}",
                    PASSAGE_CHARS,
                )
            )
        payload: dict[str, Any] = {
            "query": args.query,
            "effective_filters": effective,
            "scope": "visible_to_request_context",
            "generation": generation,
            "documents_found": len(ranked),
            "passages": [self._passage_row(p) for p in passages],
            "note": "Тексты фрагментов — в блоках PASSAGE (id C…); цитируй их дословно.",
        }
        if not passages:
            payload["note"] = "Подходящих фрагментов в документах, разрешённых для ответа, не найдено."
            others = frozenset(s.value for s in DocStatus) - statuses
            if others:
                hidden_by_status = retrieval.rank_documents(
                    snapshot,
                    analysis,
                    SearchFilters(statuses=others),
                    5,
                    expand_graph=False,
                    catalog=False,
                )
                excluded = [
                    {"document_id": d.id, "status": d.status.value}
                    for h in hidden_by_status
                    if (d := snapshot.get(h.document_id)) is not None
                ]
                if excluded:
                    payload["excluded_by_status"] = excluded
        return ToolResult(
            "knowledge_search", "search", "ok", payload, passages=passages, result_count=len(passages)
        )

    def _read(
        self,
        snapshot: KnowledgeSnapshot,
        generation: str,
        args: KnowledgeSearchArgs,
        ctx: ToolContext,
        cid_start: int,
        effective: dict[str, Any],
    ) -> ToolResult:
        assert args.document_id is not None
        doc = snapshot.get(args.document_id)
        if doc is None or args.document_id.lower() in snapshot.duplicates:
            raise ToolFailure("not_found", "not_found", "Документ с таким ID не найден в доступном каталоге.")
        if doc.status not in ctx.allowed_statuses:
            raise ToolFailure(
                "denied",
                "not_eligible",
                f"Документ {doc.id} в статусе {doc.status.value} не используется как источник ответа в этом "
                "запросе (черновики и устаревшие — только если пользователь их включил).",
                status=doc.status.value,
            )
        sections = [s for s in doc.sections if s.text]
        if args.sections:
            wanted = [w.strip().lstrip("#").casefold() for w in args.sections]
            sections = [
                s for s in sections if s.anchor.casefold() in wanted or s.heading.strip().casefold() in wanted
            ]
            if not sections:
                raise ToolFailure(
                    "not_found",
                    "section_not_found",
                    "Таких разделов в документе нет.",
                    available=[s.heading for s in doc.sections if s.text][:20],
                )
        else:
            # The opening sections, without corpus-wide boilerplate (e.g. a banner repeated in every document).
            common = self._knowledge.retrieval.boilerplate(snapshot)
            sections = [s for s in sections if not only_boilerplate(s.text, common)][:2] or sections[:2]
        passages: list[ContextPassage] = []
        budget = READ_TOTAL_CHARS
        for section in sections:
            if budget <= 100:
                break
            passage = self._passage(
                doc,
                section.heading,
                section.anchor,
                section.text,
                f"C{cid_start + len(passages)}",
                min(READ_SECTION_CHARS, budget),
            )
            budget -= len(passage.text)
            passages.append(passage)
        payload = {
            "document_id": doc.id,
            "title": doc.title,
            "status": doc.status.value,
            "revision": doc.revision,
            "generation": generation,
            "scope": "visible_to_request_context",
            "passages": [self._passage_row(p) for p in passages],
            "sections": [s.heading for s in doc.sections if s.text][:20],
            "note": "Тексты разделов — в блоках PASSAGE (id C…); цитируй их дословно.",
        }
        return ToolResult(
            "knowledge_search", "read", "ok", payload, passages=passages, result_count=len(passages)
        )

    # --- graph_inspect ---------------------------------------------------------------------------------------
    @staticmethod
    def _node_doc_id(node_id: str) -> str:
        return node_id.split(":", 1)[1] if ":" in node_id else node_id

    def _edge_row(self, edge: g.GraphEdge) -> dict[str, Any]:
        return {
            "from": self._node_doc_id(edge.source),
            "to": self._node_doc_id(edge.target),
            "relation": edge.type,
            "origin": edge.origin,
            "confirmed": edge.verified,
            "declared_in": edge.declared_in,
            "provenance": list(edge.provenance) or ([edge.field] if edge.field else []),
        }

    async def _graph_inspect(self, ctx: ToolContext, args: GraphInspectArgs, ref: str) -> ToolResult:
        snapshot, generation = await self._snapshot(ctx)
        doc = snapshot.get(args.document_id)
        if doc is None:
            raise ToolFailure("not_found", "not_found", "Документ с таким ID не найден в доступном каталоге.")
        relations = {r.value for r in args.relations} if args.relations else None
        effective: dict[str, Any] = {"document_id": doc.id}
        if relations:
            effective["relations"] = sorted(relations)
        if args.operation == "links":
            return await self._links_of(ctx, doc, args, relations, effective, generation, ref)
        graph = await self._graph.graph(ctx.user)

        def visible(node_id: str) -> bool:
            node = graph.nodes.get(node_id)
            if node is None:
                return False
            return node.document_id is None or snapshot.get(node.document_id) is not None

        flt = g.GraphFilter(relations=frozenset(relations) if relations else None)
        if args.operation == "path":
            assert args.target_id is not None
            target = snapshot.get(args.target_id)
            if target is None:
                raise ToolFailure(
                    "not_found", "not_found", "Документ с таким ID не найден в доступном каталоге."
                )
            effective["target_id"] = target.id
            chain = g.shortest_path(
                graph, g.doc_node_id(doc.id), g.doc_node_id(target.id), max_depth=4, flt=flt
            )
            if chain is not None and not all(visible(e.source) and visible(e.target) for e in chain):
                chain = None  # never a path through something the reader cannot see
            edges = [self._edge_row(e) for e in chain or []]
            fact = self._fact(
                ref=ref,
                tool="graph_inspect",
                operation="path",
                label=f"Путь связей {doc.id} → {target.id}",
                source="skh_knowledge_graph",
                generation=generation,
                value=len(edges),
                unit="relations",
                effective_filters=effective,
                definition=REFERENCES_NOTE,
                items=[self._relation_item(e, snapshot) for e in chain or []],
            )
            payload = {
                **self._provenance(fact),
                "path_found": chain is not None,
                "edges": edges,
                "note": REFERENCES_NOTE,
            }
            return ToolResult("graph_inspect", "path", "ok", payload, fact=fact, result_count=len(edges))
        sub = g.neighbours(
            graph,
            g.doc_node_id(doc.id),
            depth=args.depth,
            direction=args.direction,
            flt=flt,
            limit=g.NEIGHBOURS_MAX,
        )
        nodes = [n for n in (sub.nodes if sub else []) if visible(n.id) and n.id != g.doc_node_id(doc.id)]
        ids = {g.doc_node_id(doc.id), *(n.id for n in nodes)}
        edges_all = [e for e in (sub.edges if sub else []) if e.source in ids and e.target in ids]
        shown = nodes[: args.limit]
        shown_ids = {g.doc_node_id(doc.id), *(n.id for n in shown)}
        shown_edges = [e for e in edges_all if e.source in shown_ids and e.target in shown_ids]
        effective |= {"depth": args.depth, "direction": args.direction}
        fact = self._fact(
            ref=ref,
            tool="graph_inspect",
            operation="neighbours",
            label=f"Окрестность {doc.id} в графе связей",
            source="skh_knowledge_graph",
            generation=generation,
            value=len(nodes),
            unit="documents",
            effective_filters=effective,
            definition=REFERENCES_NOTE,
            items=[self._relation_item(e, snapshot) for e in shown_edges],
            truncated=len(nodes) > len(shown),
        )
        payload = {
            **self._provenance(fact),
            "neighbours_total": len(nodes),
            "nodes": [
                {"id": self._node_doc_id(n.id), "title": n.label, "kind": n.kind, "status": n.status}
                for n in shown
            ],
            "edges": [self._edge_row(e) for e in shown_edges],
            "note": REFERENCES_NOTE,
        }
        return ToolResult("graph_inspect", "neighbours", "ok", payload, fact=fact, result_count=len(nodes))

    def _relation_item(self, edge: g.GraphEdge, snapshot: KnowledgeSnapshot) -> SystemFactItem:
        source, target = self._node_doc_id(edge.source), self._node_doc_id(edge.target)
        target_doc = snapshot.get(target)
        where = ", ".join(edge.provenance) or (edge.field or "")
        return SystemFactItem(
            id=f"{source}→{target}",
            title=f"{source} → {target}",
            kind="relation",
            status=target_doc.status.value if target_doc else None,
            detail=f"{edge.type} · {where}" if where else edge.type,
            app_path=_doc_path(target) if target_doc else None,
        )

    async def _links_of(
        self,
        ctx: ToolContext,
        doc: DocumentRecord,
        args: GraphInspectArgs,
        relations: set[str] | None,
        effective: dict[str, Any],
        generation: str,
        ref: str,
    ) -> ToolResult:
        links = await self._links.links(ctx.user, doc.id)  # computed from the reader's snapshot only
        if links is None:
            raise ToolFailure("not_found", "not_found", "Документ с таким ID не найден в доступном каталоге.")
        rows: list[dict[str, Any]] = []
        items: list[SystemFactItem] = []
        if args.direction in ("out", "both"):
            for out in links.outgoing:
                if relations and out.relation not in relations:
                    continue
                rows.append(
                    {
                        "direction": "out",
                        "from": doc.id,
                        "to": out.target.document_id,
                        "title": out.target.title,
                        "status": out.target.status.value,
                        "relation": out.relation,
                        "declared_via": list(out.via),
                        "lines": out.lines[:5],
                        "confirmed": True,
                        "origin": "canonical_metadata",
                    }
                )
                items.append(
                    SystemFactItem(
                        id=out.target.document_id,
                        title=out.target.title,
                        kind="relation",
                        status=out.target.status.value,
                        detail=f"{doc.id} → {out.target.document_id} · {out.relation} · {', '.join(out.via)}",
                        app_path=_doc_path(out.target.document_id),
                    )
                )
        if args.direction in ("in", "both"):
            for back in links.backlinks:
                if relations and back.relation not in relations:
                    continue
                rows.append(
                    {
                        "direction": "in",
                        "from": back.source.document_id,
                        "to": doc.id,
                        "title": back.source.title,
                        "status": back.source.status.value,
                        "relation": back.relation,
                        "declared_via": list(back.via),
                        "lines": back.lines[:5],
                        "confirmed": True,
                        "origin": "canonical_metadata",
                    }
                )
                items.append(
                    SystemFactItem(
                        id=back.source.document_id,
                        title=back.source.title,
                        kind="relation",
                        status=back.source.status.value,
                        detail=f"{back.source.document_id} → {doc.id} · {back.relation} · {', '.join(back.via)}",
                        app_path=_doc_path(back.source.document_id),
                    )
                )
        effective["direction"] = args.direction
        fact = self._fact(
            ref=ref,
            tool="graph_inspect",
            operation="links",
            label=(
                f"Обратные ссылки на {doc.id}"
                if args.direction == "in"
                else f"Исходящие связи {doc.id}"
                if args.direction == "out"
                else f"Связи документа {doc.id}"
            ),
            source="skh_knowledge_graph",
            generation=generation,
            value=len(rows),
            unit="relations",
            effective_filters=effective,
            definition=REFERENCES_NOTE,
            items=items[: args.limit],
            truncated=len(items) > args.limit,
        )
        payload = {
            **self._provenance(fact),
            "document": {"id": doc.id, "title": doc.title, "status": doc.status.value},
            "total": len(rows),
            "links": rows[: args.limit],
            "note": REFERENCES_NOTE,
        }
        return ToolResult("graph_inspect", "links", "ok", payload, fact=fact, result_count=len(rows))

    # --- templates_inspect -----------------------------------------------------------------------------------
    async def _templates_inspect(self, ctx: ToolContext, args: TemplatesInspectArgs, ref: str) -> ToolResult:
        generation = self._templates_label()
        if args.operation == "list":
            rows = await self._templates.catalogue(
                ctx.user,
                q=args.text or "",
                status=None if args.status == "any" else args.status,
                doc_type=args.doc_type.value if args.doc_type else None,
            )
            effective: dict[str, Any] = {"status": args.status}
            if args.doc_type:
                effective["doc_type"] = args.doc_type.value
            if args.text:
                effective["text"] = args.text
            fact = self._fact(
                ref=ref,
                tool="templates_inspect",
                operation="list",
                label="Шаблоны документов (Template Hub)",
                source="skh_template_registry",
                generation=generation,
                value=len(rows),
                unit="templates",
                effective_filters=effective,
                items=[
                    SystemFactItem(
                        id=t.id,
                        title=t.title,
                        kind="template",
                        status=t.status,
                        detail=f"v{t.version} · {t.doc_type.value} · версии: {', '.join(f'v{v}' for v in t.versions)}",
                        app_path=f"/templates/{t.id}",
                    )
                    for t in rows[:30]
                ],
                truncated=len(rows) > 30,
            )
            payload = {
                **self._provenance(fact),
                "total": len(rows),
                "effective_filters": effective,
                "templates": [
                    {
                        "template_id": t.id,
                        "title": t.title,
                        "doc_type": t.doc_type.value,
                        "status": t.status,
                        "current_version": t.version,
                        "versions": t.versions,
                        "documents_using": t.documents,
                    }
                    for t in rows[:30]
                ],
            }
            return ToolResult("templates_inspect", "list", "ok", payload, fact=fact, result_count=len(rows))
        assert args.template_id is not None
        detail = await self._templates.detail(ctx.user, args.template_id, args.version)
        if detail is None:
            raise ToolFailure("not_found", "not_found", "Такого шаблона или версии нет в реестре.")
        current = next((h.version for h in detail.history if h.active), None)
        fact = self._fact(
            ref=ref,
            tool="templates_inspect",
            operation="get",
            label=f"Шаблон {detail.id} v{detail.version}",
            source="skh_template_registry",
            generation=generation,
            value=detail.version,
            unit="version",
            effective_filters={"template_id": detail.id, "version": args.version or "current"},
            items=[
                SystemFactItem(
                    id=detail.id,
                    title=detail.title,
                    kind="template",
                    status=detail.status,
                    detail=f"v{detail.version}" + (" · действующая" if detail.version == current else ""),
                    app_path=f"/templates/{detail.id}",
                )
            ],
        )
        payload = {
            **self._provenance(fact),
            "template_id": detail.id,
            "title": detail.title,
            "doc_type": detail.doc_type.value,
            "version": detail.version,
            "status": detail.status,
            "is_current_version": detail.version == current,
            "current_version": current,
            "versions": [
                {"version": h.version, "status": h.status, "active": h.active} for h in detail.history
            ],
            "sections": [{"title": s.title, "required": s.required} for s in detail.sections][:30],
            "required_metadata": detail.required_metadata,
            "optional_metadata": detail.optional_metadata[:20],
            "id_prefix": detail.id_prefix,
            "documents_using": len(detail.used_by),
            "breaking": detail.breaking,
            "changes": truncate(detail.changes, 300),
        }
        return ToolResult("templates_inspect", "get", "ok", payload, fact=fact, result_count=1)

    def _templates_label(self) -> str | None:
        label = self._knowledge.template_registry_label()
        return label if label and label != "-" else None

    # --- work_inspect (M6): read-only work facts -------------------------------------------------------------------
    async def _work_inspect(self, ctx: ToolContext, args: WorkInspectArgs, ref: str) -> ToolResult:
        if self._work is None or not self._work.offered(ctx.user):
            raise ToolFailure("denied", "forbidden", "Модуль задач недоступен для этого запроса.")
        return await work_inspect_result(
            self._work, self._knowledge, ctx.user, args, ref=ref, as_of=self._clock()
        )

    # --- drafts_propose (P1): a proposal through the existing M5.6.3 workflow -----------------------------------
    async def _propose(self, ctx: ToolContext, args: DraftsProposeArgs, ref: str) -> ToolResult:
        if not ctx.can_propose or self._workflows is None:
            raise ToolFailure("denied", "forbidden", "Нет права создавать предложения ИИ.")
        from app.services.ai_workflows import ProposalRequest  # local: ai_workflows imports the assistant

        proposal = await self._workflows.propose(
            ctx.user,
            ProposalRequest(
                kind=args.kind,
                prompt=args.prompt,
                title=args.title,
                template_id=args.template_id,
                document_id=args.document_id,
                section=args.section,
                goal=args.goal,
            ),
        )
        applicable = sum(1 for i in proposal.items if i.applicable)
        fact = self._fact(
            ref=ref,
            tool="drafts_propose",
            operation=args.kind,
            label="Предложение ИИ (требует решения пользователя)",
            source="skh_ai_proposals",
            generation=proposal.base.index_generation or None,
            value=applicable,
            unit="items",
            effective_filters={"kind": args.kind},
            items=[
                SystemFactItem(
                    id=proposal.id,
                    title=truncate(proposal.summary, 160),
                    kind="proposal",
                    status=proposal.status,
                    detail=f"{proposal.kind} · пунктов к решению: {applicable} · ничего не применено",
                )
            ],
        )
        payload = {
            **self._provenance(fact),
            "proposal_id": proposal.id,
            "kind": proposal.kind,
            "status": proposal.status,
            "applicable_items": applicable,
            "summary": truncate(proposal.summary, 500),
            "base": proposal.base.model_dump(exclude_none=True),
            "applied": False,
            "approval_required": True,
            "note": "Предложение сохранено для ревью: пользователь сам откроет его и примет или отклонит пункты.",
        }
        return ToolResult(
            "drafts_propose",
            args.kind,
            "ok",
            payload,
            fact=fact,
            proposal=ProposalRef(
                id=proposal.id, kind=proposal.kind, status=proposal.status, graph_link=proposal.graph_link
            ),
            result_count=applicable,
        )


async def work_inspect_result(
    inspector: WorkInspector,
    knowledge: KnowledgeService,
    user: UserContext,
    args: WorkInspectArgs,
    *,
    ref: str,
    as_of: datetime,
) -> ToolResult:
    """ONE read of work facts → a typed `skh_work` SystemFact + the bounded model-visible payload. Used by the
    `work_inspect` tool of the M5.7 loop AND by the M7 `analyze_project` skill (the server's own inspection of the
    chosen project) — so both produce exactly the same facts. Read-only; the reader's own projects and documents."""
    try:
        snapshot = await knowledge.snapshot(user)
        documents = DocumentScope.from_snapshot(snapshot, knowledge.generation_label(snapshot))
    except RepositoryUnavailableError:
        documents = DocumentScope.unavailable()  # tasks stay readable; linked documents are not named
    result = await asyncio.to_thread(inspector.inspect, user, args, documents)
    fact = SystemFact(
        ref=ref,
        tool=WORK_TOOL,
        operation=result.operation,
        label=result.label,
        source="skh_work",
        generation=None,  # work facts carry their plan revision in the filters, not a knowledge generation
        as_of=as_of,
        value=result.value,
        unit=result.unit,
        effective_filters=result.effective_filters,
        definition=result.definition,
        items=result.items,
        truncated=result.truncated,
    )
    payload: dict[str, Any] = {
        "fact_id": fact.ref,
        "scope": fact.access_scope,
        "source": fact.source,
        "generation": fact.generation,
        "as_of": fact.as_of.isoformat(timespec="seconds"),
        **result.payload,
        "read_only": True,
    }
    if result.definition:
        payload["definition"] = result.definition
    return ToolResult(WORK_TOOL, result.operation, "ok", payload, fact=fact, result_count=result.value)
