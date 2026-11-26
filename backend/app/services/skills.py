"""Assistant skills orchestration (UI v2, docs/ui-v2/specs/02_ASSISTANT.md §4–§6).

POST /api/assistant/ask {question?, skill_id?, conversation_id?, attachment_ids[], context_document_ids[],
                         selection?}
  -> plan(): server-side checks — the skill exists and is available in this AI mode; the attachments belong
     to this conversation and are not expired; chosen documents are visible; the selection really is in its
     document; the skill's inputs are present
  -> run(): "ask" skills go through AssistantService (chosen documents first, attachments as a SEPARATE
     evidence group, every citation verified); "workflow" skills go through AiWorkflowService (M5.6.3) and
     return the stored proposal as a reference — nothing is ever applied here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.adapters.ai.base import ContextPassage
from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.search.base import SearchFilters
from app.domain.markdown import truncate
from app.domain.models import (
    AskRequest,
    AskResponse,
    AskSelection,
    Citation,
    Confidence,
    DocumentRecord,
    ProposalRef,
    Section,
    SkillRef,
    UserContext,
)
from app.domain.provenance import apply_provenance
from app.domain.skills import (
    DEFAULT_SKILL,
    SKILL_BY_ID,
    SKILLS,
    SkillDefinition,
    SkillInfo,
    WorkSkillState,
    skill_info,
    unavailable_reason,
    work_denied,
)
from app.domain.text import QueryTerm, term_matches_text, tokenize
from app.errors import ApiError
from app.services.ai_workflows import AiProposal, AiWorkflowService, ProposalRequest
from app.services.assistant import (
    MAX_PASSAGE_CHARS,
    MIN_QUOTE_CHARS,
    AskExtras,
    AssistantService,
    excerpt_display,
    prepare_passage_text,
    quote_is_verbatim,
)
from app.services.attachments import (
    AttachmentService,
    StoredAttachment,
    format_locator,
    head_text,
    select_fragments,
)
from app.services.knowledge import KnowledgeService

if TYPE_CHECKING:
    from app.services.work_skills import WorkAsk, WorkChatSkills
    from app.work.permissions import WorkPrincipal

logger = logging.getLogger("skh.skills")

CONTEXT_CHARS = 3_000  # documents / selection the user chose, per answer
CONTEXT_SECTIONS_PER_DOCUMENT = 2
DRAFT_NOTE = (
    "Навык подготовил предложение ИИ: ничего не применено. Откройте его, чтобы принять нужные пункты или "
    "отклонить; черновик уходит на ревью."
)
_MISSING_WORDS = {
    "document": "документ",
    "selection": "выделенный фрагмент раздела",
    "attachment": "вложение",
    "document_or_question": "документ или вопрос",
}
MIN_QUESTION_CHARS = 3  # as AskRequest: a shorter question is no question


@dataclass(frozen=True)
class ResolvedSelection:
    document: DocumentRecord
    heading: str | None
    anchor: str | None
    text: str  # verified verbatim in the document ("" — the whole section)
    section_text: str


@dataclass(frozen=True)
class AskPlan:
    skill: SkillDefinition
    explicit_skill: bool
    request: AskRequest
    snapshot: KnowledgeSnapshot
    attachments: tuple[StoredAttachment, ...]
    documents: tuple[DocumentRecord, ...]
    selection: ResolvedSelection | None
    # M7: the resolved work target of a work skill (project, tasks, referenced proposal); None for other skills.
    work: WorkAsk | None = None

    @property
    def subject(self) -> DocumentRecord | None:
        if self.selection is not None:
            return self.selection.document
        return self.documents[0] if self.documents else None

    @property
    def creates_proposal(self) -> bool:
        """Workflow skills store an AI proposal (the route checks the `create_proposal` permission)."""
        return self.skill.runner == "workflow"

    @property
    def skill_ref(self) -> SkillRef | None:
        s = self.skill
        return SkillRef(id=s.id, name=s.name, access=s.access) if self.explicit_skill else None


def _section_of(document: DocumentRecord, text: str) -> Section | None:
    return next((s for s in document.sections if s.text and quote_is_verbatim(text, s.text)), None)


class AssistantSkillService:
    def __init__(
        self,
        *,
        assistant: AssistantService,
        workflows: AiWorkflowService,
        attachments: AttachmentService,
        knowledge: KnowledgeService,
    ) -> None:
        self._assistant = assistant
        self._workflows = workflows
        self._attachments = attachments
        self._knowledge = knowledge
        self._work: WorkChatSkills | None = None

    def attach_work(self, work: WorkChatSkills) -> None:
        """M7: the chat work skills (wired by the container: the work services are built after this one)."""
        self._work = work

    def _work_state(self, principal: WorkPrincipal | None) -> WorkSkillState:
        return self._work.state(principal) if self._work is not None else WorkSkillState()

    def catalog(self, principal: WorkPrincipal | None = None) -> list[SkillInfo]:
        provider = self._assistant.provider
        work = self._work_state(principal)
        return [skill_info(s, provider.mode, provider.supports_authoring, work) for s in SKILLS]

    # --- server-side checks ------------------------------------------------------------------------------------
    async def plan(
        self, user: UserContext, req: AskRequest, principal: WorkPrincipal | None = None
    ) -> AskPlan:
        provider = self._assistant.provider
        if provider.mode == "disabled":
            raise ApiError(
                503, "assistant_disabled", "Ассистент отключён конфигурацией (AI_PROVIDER=disabled)."
            )
        skill = SKILL_BY_ID.get(req.skill_id or DEFAULT_SKILL)
        if skill is None:
            raise ApiError(422, "skill_unknown", "Такого навыка нет.", {"skill_id": req.skill_id})
        work_state = self._work_state(principal) if skill.is_work else None
        denied = work_denied(skill, work_state) if skill.is_work else None
        if (
            denied is not None
        ):  # M7: the module / the reader's rights before the provider (403 like the work API)
            status, code, message = denied
            raise ApiError(status, code, message, {"skill_id": skill.id})
        reason = unavailable_reason(skill, provider.mode, provider.supports_authoring, work_state)
        if reason is not None:
            raise ApiError(503, "skill_unavailable", reason, {"skill_id": skill.id})
        work: WorkAsk | None = None
        if skill.is_work:  # the project / tasks / proposal BEFORE attachments, documents or any model call
            if self._work is None or principal is None:
                raise ApiError(503, "skill_unavailable", "Модуль задач недоступен.", {"skill_id": skill.id})
            work = await asyncio.to_thread(self._work.resolve, skill, principal, req.work_context)
        attachments = (
            self._attachments.resolve(user, req.conversation_id, req.attachment_ids)
            if req.attachment_ids
            else []
        )
        snapshot = await self._knowledge.snapshot(user)
        documents: list[DocumentRecord] = []
        for document_id in dict.fromkeys(req.context_document_ids):
            doc = snapshot.get(document_id)
            if doc is None:
                raise ApiError(404, "document_not_found", "Документ не найден.", {"document_id": document_id})
            documents.append(doc)
        selection = self._selection(snapshot, req.selection) if req.selection else None
        missing: list[str] = []
        if skill.requires_document and not (documents or selection):
            missing.append("document")
        if skill.requires_selection and (selection is None or not selection.heading):
            missing.append("selection")
        if skill.requires_attachment and not attachments:
            missing.append("attachment")
        if (
            skill.requires_document_or_question
            and not (documents or selection)
            and len(req.question.strip()) < MIN_QUESTION_CHARS
        ):
            missing.append("document_or_question")
        if missing:
            raise ApiError(
                422,
                "skill_input_missing",
                f"Для навыка «{skill.name}» нужно: " + ", ".join(_MISSING_WORDS[m] for m in missing) + ".",
                {"skill_id": skill.id, "missing": missing},
            )
        return AskPlan(
            skill=skill,
            explicit_skill=req.skill_id is not None,
            request=req,
            snapshot=snapshot,
            attachments=tuple(attachments),
            documents=tuple(documents),
            selection=selection,
            work=work,
        )

    @staticmethod
    def _selection(snapshot: KnowledgeSnapshot, chosen: AskSelection) -> ResolvedSelection:
        doc = snapshot.get(chosen.document_id)
        if doc is None:
            raise ApiError(
                404, "document_not_found", "Документ не найден.", {"document_id": chosen.document_id}
            )
        section: Section | None = None
        if chosen.section_anchor:
            section = next((s for s in doc.sections if s.anchor == chosen.section_anchor), None)
            if section is None:
                raise ApiError(
                    422,
                    "selection_not_found",
                    "Раздел не найден в документе (возможно, документ изменился).",
                    {"document_id": doc.id, "section_anchor": chosen.section_anchor},
                )
        text = chosen.text.strip()
        if text:
            source = section.text if section else "\n".join(s.text for s in doc.sections)
            if not (
                quote_is_verbatim(text, source) or (section is None and quote_is_verbatim(text, doc.body))
            ):
                raise ApiError(
                    422,
                    "selection_not_found",
                    "Выделенный текст не найден в документе (возможно, документ изменился).",
                    {"document_id": doc.id},
                )
            section = section or _section_of(doc, text)
        return ResolvedSelection(
            document=doc,
            heading=section.heading if section else None,
            anchor=section.anchor if section else None,
            text=text,
            section_text=section.text if section else "",
        )

    # --- inputs of an "ask" skill ------------------------------------------------------------------------------
    @staticmethod
    def _passage(
        doc: DocumentRecord, section: str | None, anchor: str | None, raw: str, chars: int
    ) -> ContextPassage:
        text, suspicious = prepare_passage_text(truncate(raw, chars))
        return ContextPassage(
            cid="",
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
            chosen=True,
        )

    def _context_passages(self, plan: AskPlan, terms: list[QueryTerm]) -> tuple[ContextPassage, ...]:
        """The selection (verified) and the best sections of the chosen documents, within CONTEXT_CHARS."""
        out: list[ContextPassage] = []
        budget = CONTEXT_CHARS
        used: set[tuple[str, str]] = set()
        sel = plan.selection
        if sel is not None:
            raw = sel.text or sel.section_text
            if not raw:
                first = next((s for s in sel.document.sections if s.text), None)
                raw, heading, anchor = (
                    (first.text, first.heading, first.anchor) if first else ("", None, None)
                )
            else:
                heading, anchor = sel.heading, sel.anchor
            if raw:
                passage = self._passage(sel.document, heading, anchor, raw, min(MAX_PASSAGE_CHARS, budget))
                out.append(passage)
                used.add((sel.document.id, anchor or ""))
                budget -= len(passage.text)
        for doc in plan.documents:
            sections = [s for s in doc.sections if s.text and (doc.id, s.anchor) not in used]
            scored = [
                (sum(1 for t in terms if term_matches_text(t, tokenize(f"{s.heading} {s.text}"))), i, s)
                for i, s in enumerate(sections)
            ]
            best = [s for score, _, s in sorted(scored, key=lambda x: (-x[0], x[1])) if score > 0]
            for section in best[:CONTEXT_SECTIONS_PER_DOCUMENT] or sections[:1]:
                if budget <= 100:
                    break
                passage = self._passage(doc, section.heading, section.anchor, section.text, min(1200, budget))
                out.append(passage)
                used.add((doc.id, section.anchor))
                budget -= len(passage.text)
        return tuple(out)

    def _attachment_passages(self, plan: AskPlan, terms: list[QueryTerm]) -> tuple[ContextPassage, ...]:
        limits = self._attachments.limits
        budget = limits.context_chars
        per_file = max(budget // max(len(plan.attachments), 1), 300)
        out: list[ContextPassage] = []
        for attachment in plan.attachments:
            if budget <= 0:
                break
            fragments = select_fragments(
                attachment,
                terms,
                max_passages=limits.passages_per_file,
                max_chars=min(per_file, budget),
                passage_chars=limits.passage_chars,
            )
            for fragment in fragments:
                lines: list[str] = []
                suspicious = False
                for unit in fragment.units:
                    line, flagged = prepare_passage_text(unit.text)
                    lines.append(" ".join(line.split()))
                    suspicious = suspicious or flagged
                text = "\n".join(lines)
                out.append(
                    ContextPassage(
                        cid="",
                        document_id=attachment.id,
                        title=attachment.name,
                        section=None,
                        section_anchor=None,
                        status=None,
                        source_type="attachment",
                        source_uri=f"attachment://{attachment.id}",
                        revision=attachment.content_hash[:12],
                        text=text,
                        is_demo=False,
                        suspicious=suspicious,
                        content_hash=attachment.content_hash,
                        attachment_id=attachment.id,
                        locators=tuple((u.scope, u.kind, u.n) for u in fragment.units),
                        locator=format_locator(fragment.units[0], fragment.units[-1]),
                    )
                )
                budget -= len(text)
        return tuple(out)

    def _ask_inputs(self, plan: AskPlan) -> tuple[AskRequest, AskExtras]:
        req = plan.request
        question = req.question
        retrieval_text: str | None = None
        if plan.skill.id == "explain":
            parts = [req.question.strip(), plan.selection.text if plan.selection else ""]
            subject = "\n".join(p for p in parts if p) or (plan.subject.title if plan.subject else "")
            question = f"Объясни: {subject[:1500]}"
        elif plan.skill.id == "compare_with_file":
            names = ", ".join(f"«{a.name}»" for a in plan.attachments)
            if len(req.question.strip()) < 3:
                question = (
                    f"Сверь вложение {names} с утверждёнными документами базы знаний: что совпадает и чего в "
                    "документах нет."
                )
            heads = " ".join(head_text(a) for a in plan.attachments)
            retrieval_text = f"{req.question.strip()} {heads}".strip()[:2000]
        terms = self._knowledge.retrieval.analyze(retrieval_text or question).terms
        extras = AskExtras(
            context=self._context_passages(plan, terms),
            attachments=self._attachment_passages(plan, terms),
            retrieval_text=retrieval_text,
            skill=plan.skill_ref,
            compare_terms=plan.skill.id == "compare_with_file",
            trace_text=req.question if plan.attachments else None,
        )
        return req.model_copy(update={"question": question}), extras

    # --- workflow skills ---------------------------------------------------------------------------------------
    def _best_document(self, snapshot: KnowledgeSnapshot, question: str) -> DocumentRecord | None:
        retrieval = self._knowledge.retrieval
        ranked = retrieval.rank_documents(
            snapshot,
            retrieval.analyze(question),
            SearchFilters(statuses=frozenset({"approved"})),
            1,
            expand_graph=False,
            catalog=False,
        )
        return snapshot.get(ranked[0].document_id) if ranked else None

    def _proposal_request(self, plan: AskPlan) -> tuple[ProposalRequest | None, str]:
        """The M5.6.3 request a workflow skill maps to, and a text prefix for the answer."""
        skill, doc, sel = plan.skill.id, plan.subject, plan.selection
        question = plan.request.question.strip()
        if skill == "draft_document":
            return ProposalRequest(kind="draft_from_prompt", prompt=question[:2000]), ""
        if skill == "find_related":
            if len(plan.documents) >= 2:
                first, second = plan.documents[0], plan.documents[1]
                return ProposalRequest(kind="explain_relation", document_id=first.id, target_id=second.id), ""
            if doc is None:
                doc = self._best_document(plan.snapshot, question)
                if doc is None:
                    return None, ""
                return (
                    ProposalRequest(kind="find_related", document_id=doc.id),
                    f"Документ по вопросу: «{doc.title}» ({doc.id}).\n\n",
                )
            return ProposalRequest(kind="find_related", document_id=doc.id), ""
        assert doc is not None  # plan() checked requires_document
        if skill == "summarize":
            return ProposalRequest(
                kind="summarize", document_id=doc.id, selection=(sel.text if sel else "") or None
            ), ""
        if skill == "check_completeness":
            return ProposalRequest(kind="check_completeness", document_id=doc.id), ""
        if skill == "check_freshness":
            return ProposalRequest(kind="impact_analysis", document_id=doc.id), ""
        if skill == "improve_section":
            assert sel is not None and sel.heading
            return (
                ProposalRequest(
                    kind="improve_section",
                    document_id=sel.document.id,
                    section=sel.heading[:300],
                    selection=sel.text or None,
                    goal=question[:300] or None,
                ),
                "",
            )
        return ProposalRequest(kind="suggest_metadata", document_id=doc.id), ""

    @staticmethod
    def _evidence_citations(proposal: AiProposal, snapshot: KnowledgeSnapshot) -> list[Citation]:
        """Quotes of the proposal's evidence, re-verified against the reader's snapshot (only verbatim ones)."""
        citations: list[Citation] = []
        seen: set[tuple[str, str]] = set()
        now = datetime.now(UTC)
        for item in proposal.items:
            for evidence in item.evidence:
                quote = evidence.quote.strip()
                doc = snapshot.get(evidence.document_id)
                if doc is None or len(quote) < MIN_QUOTE_CHARS or (doc.id, quote) in seen:
                    continue
                section = _section_of(doc, quote) or next(
                    (
                        s
                        for s in doc.sections
                        if s.text and quote_is_verbatim(quote, prepare_passage_text(s.text)[0])
                    ),
                    None,
                )
                if section is None and not quote_is_verbatim(quote, doc.body):
                    continue
                seen.add((doc.id, quote))
                anchor = section.anchor if section else None
                citations.append(
                    Citation(
                        ref=len(citations) + 1,
                        source_type=doc.source,
                        document_id=doc.id,
                        title=doc.title,
                        source_uri=doc.source_uri,
                        revision=doc.revision,
                        status=doc.status,
                        section=section.heading if section else None,
                        section_anchor=anchor,
                        excerpt=quote,
                        retrieved_at=now,
                        is_demo=doc.is_demo,
                        app_path=f"/documents/{doc.id}" + (f"#{anchor}" if anchor else ""),
                        source_kind="gitlab_approved" if doc.source == "gitlab" else "local_markdown",
                        source_id=f"{doc.source}:{doc.id}",
                        fragment_id=anchor,
                        excerpt_parts=excerpt_display((doc.body, anchor), quote),
                    )
                )
        return citations

    def _from_proposal(self, plan: AskPlan, proposal: AiProposal, prefix: str) -> AskResponse:
        citations = self._evidence_citations(proposal, plan.snapshot)
        confidence: Confidence = (
            "insufficient_evidence" if proposal.insufficient else "supported" if citations else "partial"
        )
        warnings = list(proposal.warnings)
        if plan.skill.access == "draft":
            warnings.append(DRAFT_NOTE)
        subject = plan.subject
        response = AskResponse(
            answer=(prefix + proposal.summary).strip(),
            mode=self._assistant.provider.mode,
            confidence=confidence,
            citations=citations,
            warnings=list(dict.fromkeys(warnings)),
            index_generation=proposal.base.index_generation or None,
            instructions_version=self._assistant.instructions_version,
            skill=plan.skill_ref,
            proposal=ProposalRef(
                id=proposal.id, kind=proposal.kind, status=proposal.status, graph_link=proposal.graph_link
            ),
        )
        # The chosen document is what the result is about: its origin is part of the provenance (metadata, no
        # fixed «only demo» warning).
        return apply_provenance(response, [(subject.id, subject.is_demo)] if subject is not None else ())

    async def _run_workflow(self, user: UserContext, plan: AskPlan) -> AskResponse:
        request, prefix = self._proposal_request(plan)
        if request is None:
            return AskResponse(
                answer=(
                    "Недостаточно данных: по вопросу не найден утверждённый документ, связи которого можно "
                    "показать. Выберите документ через «@»."
                ),
                mode=self._assistant.provider.mode,
                confidence="insufficient_evidence",
                citations=[],
                warnings=[],
                skill=plan.skill_ref,
            )
        proposal = await self._workflows.propose(user, request)
        return self._from_proposal(plan, proposal, prefix)

    # --- running -----------------------------------------------------------------------------------------------
    def _log(self, plan: AskPlan) -> None:
        logger.info(
            "skill=%s runner=%s attachments=%d documents=%d selection=%s",
            plan.skill.id,
            plan.skill.runner,
            len(plan.attachments),
            len(plan.documents),
            plan.selection is not None,
        )

    async def run(self, user: UserContext, plan: AskPlan) -> AskResponse:
        self._log(plan)
        if plan.skill.is_work:
            assert self._work is not None  # plan() refused a work skill without it
            return await self._work.run(user, plan)
        if plan.skill.runner == "ask":
            request, extras = self._ask_inputs(plan)
            return await self._assistant.ask(user, request, extras)
        return await self._run_workflow(user, plan)

    async def run_stream(self, user: UserContext, plan: AskPlan) -> AsyncGenerator[dict[str, Any], None]:
        """NDJSON events as /ask/stream always sends them. A workflow skill has no text deltas."""
        self._log(plan)
        if plan.skill.is_work:
            assert self._work is not None
            async with contextlib.aclosing(self._work.run_stream(user, plan)) as work_events:
                async for event in work_events:
                    yield event
            return
        if plan.skill.runner == "ask":
            request, extras = self._ask_inputs(plan)
            async with contextlib.aclosing(self._assistant.ask_stream(user, request, extras)) as events:
                async for event in events:
                    yield event
            return
        yield {"type": "status", "stage": "retrieving"}
        yield {"type": "status", "stage": "generating", "provider": self._assistant.provider.mode}
        try:
            response = await self._run_workflow(user, plan)
        except ApiError as exc:
            yield {"type": "error", "code": exc.code, "message": exc.message, "status": exc.status_code}
            return
        yield {"type": "status", "stage": "validating"}
        yield {"type": "final", "response": response.model_dump(mode="json")}
