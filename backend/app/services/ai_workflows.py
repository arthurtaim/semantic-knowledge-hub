"""AI-first knowledge workflows (M5.6.3): contextual, evidence-backed PROPOSALS with explicit Accept/Reject.

    UI action (+ document / draft / selection / goal)
      -> this orchestrator: access-scoped evidence (search, graph, links) + PINNED template from the registry
      -> AIProvider only for text (improve / summarize / draft); facts, links and structure come from the backend
      -> typed proposal (items with evidence), stored with its base (draft version / revision / template version)
      -> person accepts chosen items -> applied to a DRAFT (an approved document gets an update draft)

Nothing is applied without Accept; nothing is ever approved, merged or published here. A proposal whose base
changed (draft saved elsewhere, document revised, template re-pinned, link target gone) is `invalidated`
instead of being applied. The model never gets tools: the backend selects every input.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
import threading
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from app.adapters.ai.base import (
    AIProvider,
    AIProviderError,
    AssistRequest,
    AuthoringReference,
    ai_error_status,
)
from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.models import AskRequest, DocStatus, DocumentRecord, UserContext
from app.domain.proposals import (
    AiDraftRequest,
    DraftCreate,
    DraftUpdate,
    NewDocumentDraftCreate,
    NewDocumentMetadata,
    ProposalDetail,
)
from app.domain.schema import load_frontmatter, split_frontmatter
from app.domain.template_match import recommend_templates
from app.domain.templates import PLACEHOLDER, DocumentTemplate, missing_sections
from app.errors import ApiError
from app.services import graph as g
from app.services.assistant import prepare_passage_text, quote_is_verbatim
from app.services.authoring import template_hints

if TYPE_CHECKING:
    from app.services.assistant import AssistantService
    from app.services.authoring import AuthoringService
    from app.services.graph import GraphService
    from app.services.knowledge import KnowledgeService
    from app.services.links import LinkService
    from app.services.metadata import MetadataService
    from app.services.proposals import ProposalService

logger = logging.getLogger("skh.ai_workflows")

ProposalKind = Literal[
    "draft_from_prompt",
    "suggest_metadata",
    "improve_section",
    "summarize",
    "explain",
    "check_completeness",
    "find_related",
    "explain_relation",
    "impact_analysis",
    "draft_template",  # Template Studio: a template structure; saved only from the editor (docs/AI_WORKFLOWS.md)
]
ProposalState = Literal["suggested", "applied", "partially_applied", "rejected", "invalidated", "answered"]
ItemKind = Literal["metadata", "section", "link", "template", "draft", "task", "note"]
MAX_ITEMS = 30
RELATED_SECTION_NAMES = (
    "Связанные документы",
    "Связанные материалы",
    "Связи",
    "Связанные документы (Related Docs)",
)


class Evidence(BaseModel):
    document_id: str
    title: str = ""
    revision: str = ""
    status: str = ""
    quote: str = ""
    reason: str = ""


class ProposalItem(BaseModel):
    id: str
    kind: ItemKind
    field: str | None = None  # metadata field
    section: str | None = None  # section heading
    target_id: str | None = None  # link / task target document
    current: Any = None
    proposed: Any = None
    reason: str = ""
    evidence: list[Evidence] = []
    applicable: bool = True  # False: information or a plan item (never applied automatically)


class ProposalBase(BaseModel):
    draft_id: str | None = None
    edit_version: int | None = None
    document_id: str | None = None
    revision: str | None = None
    template_id: str | None = None
    template_version: int | None = None
    index_generation: str = ""


class AiProposal(BaseModel):
    id: str
    kind: ProposalKind
    status: ProposalState
    created_at: str
    decided_at: str | None = None
    mode: str
    base: ProposalBase
    summary: str
    items: list[ProposalItem]
    warnings: list[str] = []
    insufficient: bool = False
    graph_link: str | None = None
    applied_items: list[str] = []
    result_draft_id: str | None = None  # the draft the accepted items went into
    result_template_id: str | None = None  # draft_template: the template created from the (edited) proposal


class ProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ProposalKind
    draft_id: str | None = Field(default=None, max_length=64)
    document_id: str | None = Field(default=None, max_length=128)
    target_id: str | None = Field(default=None, max_length=128)  # explain_relation: the other document
    section: str | None = Field(default=None, max_length=300)
    selection: str | None = Field(default=None, max_length=8000)
    prompt: str | None = Field(default=None, max_length=2000)
    title: str | None = Field(default=None, max_length=300)
    template_id: str | None = Field(default=None, max_length=40)
    goal: str | None = Field(default=None, max_length=300)


class AcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_ids: list[str] = Field(min_length=1, max_length=MAX_ITEMS)
    reason: str | None = Field(default=None, min_length=3, max_length=2000)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _ev(doc: DocumentRecord, reason: str = "", quote: str = "") -> Evidence:
    return Evidence(
        document_id=doc.id,
        title=doc.title,
        revision=doc.revision,
        status=doc.status.value,
        quote=quote,
        reason=reason,
    )


_SECTION_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*$", re.MULTILINE)


def section_text(body: str, heading: str) -> str | None:
    matches = list(_SECTION_RE.finditer(body))
    for i, m in enumerate(matches):
        if m.group(2).strip().casefold() == heading.strip().casefold():
            end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
            return body[m.end() : end].strip("\n")
    return None


def replace_section(body: str, heading: str, new_text: str) -> str:
    """Replace the text of `## heading` (up to the next heading); append the section when it is absent."""
    matches = list(_SECTION_RE.finditer(body))
    for i, m in enumerate(matches):
        if m.group(2).strip().casefold() == heading.strip().casefold():
            end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
            return body[: m.end()] + "\n" + new_text.strip("\n") + "\n\n" + body[end:].lstrip("\n")
    return body.rstrip("\n") + f"\n\n## {heading}\n{new_text.strip()}\n"


@dataclass
class DraftedTemplate:
    """What Template Studio returns for a `draft_template` proposal (services/template_studio.py)."""

    summary: str
    items: list[ProposalItem]
    warnings: list[str]


TemplateDrafter = Callable[[UserContext, str], Awaitable[DraftedTemplate]]


class AiProposalStore:
    """Audit and state of AI proposals (no prompts, no tokens; the prompt is kept only as a hash)."""

    def __init__(self, path: Path | str) -> None:
        self._lock = threading.Lock()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        with self._conn:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS ai_proposals (id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, "
                "status TEXT NOT NULL, prompt_hash TEXT, created_at TEXT NOT NULL, decided_at TEXT, "
                "proposal_json TEXT NOT NULL)"
            )

    def save(self, actor: str, proposal: AiProposal, prompt_hash: str | None = None) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO ai_proposals (id, actor, kind, status, prompt_hash, created_at, decided_at, "
                "proposal_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    proposal.id,
                    actor,
                    proposal.kind,
                    proposal.status,
                    prompt_hash,
                    proposal.created_at,
                    proposal.decided_at,
                    proposal.model_dump_json(),
                ),
            )

    def get(self, actor: str, proposal_id: str) -> AiProposal | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT proposal_json FROM ai_proposals WHERE id = ? AND actor = ?", (proposal_id, actor)
            ).fetchone()
        return AiProposal.model_validate_json(row[0]) if row else None

    def find(self, actor: str, draft_id: str | None, document_id: str | None) -> list[AiProposal]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT proposal_json FROM ai_proposals WHERE actor = ? ORDER BY created_at DESC LIMIT 200",
                (actor,),
            ).fetchall()
        items = [AiProposal.model_validate_json(r[0]) for r in rows]
        return [
            p
            for p in items
            if (draft_id is None or p.base.draft_id == draft_id)
            and (document_id is None or p.base.document_id == document_id)
        ]

    def counts(self) -> dict[str, int]:
        with self._lock:
            rows = self._conn.execute("SELECT status, COUNT(*) FROM ai_proposals GROUP BY status").fetchall()
        return {r[0]: r[1] for r in rows}

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class _Target:
    def __init__(
        self,
        *,
        draft: ProposalDetail | None,
        doc: DocumentRecord | None,
        content: str,
        template: DocumentTemplate | None,
    ) -> None:
        self.draft = draft
        self.doc = doc
        self.content = content
        try:
            yaml_text, body = split_frontmatter(content)
            self.meta: dict[str, Any] = dict(load_frontmatter(yaml_text))
        except Exception:
            self.meta, body = {}, content
        self.body = body
        self.template = template

    @property
    def document_id(self) -> str:
        return str(
            self.meta.get("id") or (self.doc.id if self.doc else self.draft.document_id if self.draft else "")
        )

    @property
    def title(self) -> str:
        return str(self.meta.get("title") or (self.doc.title if self.doc else ""))


class AiWorkflowService:
    def __init__(
        self,
        *,
        store: AiProposalStore,
        ai: AIProvider,
        knowledge: KnowledgeService,
        authoring: AuthoringService,
        proposals: ProposalService,
        metadata: MetadataService,
        links: LinkService,
        graph: GraphService,
        assistant: AssistantService,
    ) -> None:
        self._store = store
        self._ai = ai
        self._knowledge = knowledge
        self._authoring = authoring
        self._proposals = proposals
        self._metadata = metadata
        self._links = links
        self._graph = graph
        self._assistant = assistant
        self._accept_lock = asyncio.Lock()
        self._template_drafter: TemplateDrafter | None = None

    def attach_template_drafter(self, drafter: TemplateDrafter) -> None:
        """Template Studio provides `draft_template` (the registry, validation and the provider protocol live there)."""
        self._template_drafter = drafter

    # --- loading the subject of a proposal -----------------------------------------------------------
    async def _target(self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot) -> _Target:
        if req.draft_id:
            draft = await self._proposals.get(user, req.draft_id)
            if draft.author != user.user_id:
                raise ApiError(404, "proposal_not_found", "Черновик не найден.")
            template = (
                self._authoring.registry.get(draft.template_id, draft.template_version)
                if draft.template_id
                else None
            )
            return _Target(draft=draft, doc=None, content=draft.proposed_content, template=template)
        if req.document_id:
            doc = snapshot.get(req.document_id)
            if doc is None:
                raise ApiError(404, "document_not_found", "Документ не найден.")
            template = (
                self._authoring.registry.get(doc.template_id, doc.template_version)
                if doc.template_id
                else None
            )
            return _Target(draft=None, doc=doc, content=doc.raw, template=template)
        raise ApiError(422, "validation_failed", "Нужен draft_id или document_id.")

    def _base(self, target: _Target | None, snapshot: KnowledgeSnapshot) -> ProposalBase:
        generation = self._knowledge.generation_label(snapshot)
        if target is None:
            return ProposalBase(index_generation=generation)
        return ProposalBase(
            draft_id=target.draft.id if target.draft else None,
            edit_version=target.draft.edit_version if target.draft else None,
            document_id=target.document_id or None,
            revision=target.doc.revision if target.doc else None,
            template_id=target.template.id if target.template else None,
            template_version=target.template.version if target.template else None,
            index_generation=generation,
        )

    def _references(self, docs: list[DocumentRecord]) -> tuple[AuthoringReference, ...]:
        return tuple(
            AuthoringReference(
                document_id=d.id,
                title=d.title,
                revision=d.revision,
                status=d.status,
                source_type=d.source,
                sections=tuple(
                    (s.heading, prepare_passage_text(s.text[:1200])[0]) for s in d.sections if s.text.strip()
                ),
                is_demo=d.is_demo,
            )
            for d in docs
            if d.status == DocStatus.approved
        )

    # --- creating proposals ---------------------------------------------------------------------------
    async def propose(self, user: UserContext, req: ProposalRequest) -> AiProposal:
        snapshot = await self._knowledge.snapshot(user)
        builder = {
            "draft_from_prompt": self._draft_from_prompt,
            "suggest_metadata": self._suggest_metadata,
            "improve_section": self._text_task,
            "summarize": self._text_task,
            "explain": self._explain,
            "check_completeness": self._completeness,
            "find_related": self._find_related,
            "explain_relation": self._explain_relation,
            "impact_analysis": self._impact,
            "draft_template": self._draft_template,
        }[req.kind]
        try:
            proposal = await builder(user, req, snapshot)
        except AIProviderError as exc:
            raise ApiError(ai_error_status(exc.code), exc.code, exc.message) from exc
        prompt_hash = hashlib.sha256(req.prompt.encode()).hexdigest()[:16] if req.prompt else None
        self._store.save(user.user_id, proposal, prompt_hash)
        logger.info(
            "ai proposal kind=%s id=%s items=%d mode=%s",
            proposal.kind,
            proposal.id,
            len(proposal.items),
            proposal.mode,
        )
        return proposal

    def _new(
        self, kind: ProposalKind, base: ProposalBase, summary: str, items: list[ProposalItem], **kw: Any
    ) -> AiProposal:
        actionable = any(i.applicable for i in items)
        return AiProposal(
            id=f"AIP-{uuid.uuid4().hex[:16]}",
            kind=kind,
            status="suggested" if actionable else "answered",
            created_at=_now(),
            mode=self._ai.mode,
            base=base,
            summary=summary,
            items=items[:MAX_ITEMS],
            **kw,
        )

    async def _draft_from_prompt(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        prompt = (req.prompt or "").strip()
        if len(prompt) < 3:
            raise ApiError(422, "validation_failed", "Опишите, какой документ нужен (prompt).")
        active = {
            t.id: t for t in self._authoring.registry.active().values() if t.listed and t.status == "active"
        }
        ranked = recommend_templates(f"{req.title or ''}\n{prompt}", active, limit=4)
        if req.template_id:
            chosen = active.get(req.template_id)
            if chosen is None:
                raise ApiError(
                    409, "template_not_active", "Этот шаблон нельзя использовать для нового документа."
                )
            reason = "выбран пользователем"
        elif ranked:
            chosen = active[ranked[0].template_id]
            reason = "; ".join(ranked[0].reasons)
        else:
            chosen = self._metadata.default_template()
            if chosen is None:
                raise ApiError(409, "no_active_template", "Нет активного шаблона.")
            reason = "тип не распознан: шаблон по умолчанию"
        title = (req.title or prompt.split(".")[0])[:200].strip()
        draft = await self._authoring.ai_draft(
            user, AiDraftRequest(template_id=chosen.id, title=title, request=prompt, related_ids=[])
        )
        missing = [
            h
            for h, _ in template_hints(chosen)
            if (section_text(draft.body, h) or "").startswith(f"> {PLACEHOLDER}")
        ]
        tags = self._metadata.suggest_tags(snapshot, f"{title}\n{prompt}\n{draft.body}", chosen)
        related = [r.document_id for r in draft.references]
        base = self._base(None, snapshot)
        base.template_id, base.template_version = chosen.id, chosen.version
        evidence = [
            Evidence(
                document_id=c.document_id,
                title=c.title,
                revision=c.revision,
                status=c.status.value,
                quote=c.quote,
            )
            for c in draft.citations
        ]
        items = [
            ProposalItem(
                id="template",
                kind="template",
                proposed={"template_id": chosen.id, "version": chosen.version, "title": chosen.title},
                reason=reason,
                current={
                    "alternatives": [
                        {"template_id": m.template_id, "title": m.title, "score": m.score}
                        for m in ranked
                        if m.template_id != chosen.id
                    ]
                },
                applicable=False,
            ),
            ProposalItem(
                id="draft",
                kind="draft",
                proposed={"title": title, "body": draft.body, "missing_sections": missing},
                reason=f"черновик по шаблону «{chosen.title}» v{chosen.version}; разделы без подтверждения помечены «{PLACEHOLDER}»",
                evidence=evidence,
            ),
            ProposalItem(
                id="tags",
                kind="metadata",
                field="tags",
                current=[],
                proposed=tags,
                reason="теги, уже принятые в базе",
            ),
        ]
        if related:
            items.append(
                ProposalItem(
                    id="related_ids",
                    kind="metadata",
                    field="related_ids",
                    current=[],
                    proposed=related,
                    reason="утверждённые документы, на которые опирается черновик",
                    evidence=[
                        Evidence(
                            document_id=r.document_id,
                            title=r.title,
                            revision=r.revision,
                            status=r.status.value,
                        )
                        for r in draft.references
                    ],
                )
            )
        summary = (
            f"Шаблон: «{chosen.title}» v{chosen.version}. Источников: {len(draft.references)}, "
            f"проверенных цитат: {len(draft.citations)}. Нужно дописать разделов: {len(missing)}."
        )
        return self._new(
            "draft_from_prompt",
            base,
            summary,
            items,
            warnings=draft.warnings,
            insufficient=draft.insufficient_data,
        )

    async def _draft_template(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        prompt = (req.prompt or "").strip()
        if len(prompt) < 10:
            raise ApiError(422, "validation_failed", "Опишите, какой шаблон нужен (prompt, от 10 символов).")
        if self._template_drafter is None:
            raise ApiError(503, "ai_template_unavailable", "Проектирование шаблонов с ИИ недоступно.")
        drafted = await self._template_drafter(user, prompt)
        return self._new(
            "draft_template",
            self._base(None, snapshot),
            drafted.summary,
            drafted.items,
            warnings=drafted.warnings,
        )

    def open_template_proposal(self, user: UserContext, proposal_id: str) -> AiProposal:
        """A `draft_template` proposal the user may still turn into a template (their own, not decided yet)."""
        proposal = self.get(user, proposal_id)
        if proposal.kind != "draft_template":
            raise ApiError(422, "validation_failed", "Это не предложение шаблона.")
        if proposal.status != "suggested":
            raise ApiError(409, "ai_proposal_closed", "Решение по предложению уже принято.")
        return proposal

    def settle_template_proposal(self, user: UserContext, proposal_id: str, template_id: str) -> AiProposal:
        """The person saved the (edited) proposal as a template draft in the editor: that is the Accept."""
        proposal = self.open_template_proposal(user, proposal_id)
        proposal.status, proposal.decided_at = "applied", _now()
        proposal.applied_items = [i.id for i in proposal.items if i.applicable]
        proposal.result_template_id = template_id
        self._store.save(user.user_id, proposal)
        logger.info("ai template proposal %s saved as template %s", proposal.id, template_id)
        return proposal

    async def _suggest_metadata(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        target = await self._target(user, req, snapshot)
        items: list[ProposalItem] = []
        text = f"{target.title}\n{target.body}"
        current_tags = list(target.meta.get("tags") or [])
        tags = self._metadata.suggest_tags(snapshot, text, target.template)
        new_tags = [t for t in tags if t not in current_tags]
        if new_tags:
            items.append(
                ProposalItem(
                    id="tags",
                    kind="metadata",
                    field="tags",
                    current=current_tags,
                    proposed=current_tags + new_tags,
                    reason="теги, которые уже используются в базе и встречаются в тексте",
                )
            )
        if not str(target.meta.get("summary") or "").strip():
            result = await self._ai.assist(
                AssistRequest(task="summarize", text=target.body[:6000], title=target.title)
            )
            if result.text:
                items.append(
                    ProposalItem(
                        id="summary",
                        kind="metadata",
                        field="summary",
                        current=None,
                        proposed=result.text[:1000],
                        reason="краткое описание по тексту документа",
                    )
                )
        current_related = [str(r) for r in target.meta.get("related_ids") or []]
        related = [
            (i, why)
            for i, why in self._metadata.suggest_related(snapshot, target.body, exclude=target.document_id)
            if i not in current_related
        ]
        if related:
            items.append(
                ProposalItem(
                    id="related_ids",
                    kind="metadata",
                    field="related_ids",
                    current=current_related,
                    proposed=current_related + [i for i, _ in related],
                    reason="упомянутые или похожие утверждённые документы",
                    evidence=[_ev(d, why) for i, why in related if (d := snapshot.get(i))],
                )
            )
        if str(target.meta.get("owner") or "") in ("", "unassigned"):
            items.append(
                ProposalItem(
                    id="owner",
                    kind="note",
                    field="owner",
                    reason="Владелец не указан. ИИ не назначает владельца: это решение человека.",
                    applicable=False,
                )
            )
        if target.template is None:
            for m in self._metadata.template_suggestions(text)[:1]:
                items.append(
                    ProposalItem(
                        id="template",
                        kind="template",
                        proposed={"template_id": m.template_id, "version": m.version, "title": m.title},
                        reason="; ".join(m.reasons),
                        applicable=False,
                    )
                )
        summary = f"Предложений по метаданным: {sum(1 for i in items if i.applicable)}. Примите нужные поля по отдельности."
        return self._new("suggest_metadata", self._base(target, snapshot), summary, items)

    async def _text_task(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        target = await self._target(user, req, snapshot)
        heading = req.section
        text = req.selection or (section_text(target.body, heading) if heading else None) or target.body
        if not text.strip():
            raise ApiError(422, "validation_failed", "Нечего обрабатывать: раздел пуст.")
        related = [
            snapshot.get(i)
            for i, _ in self._metadata.suggest_related(snapshot, text, exclude=target.document_id)[:3]
        ]
        references = self._references([d for d in related if d is not None])
        task: Literal["improve", "summarize"] = "improve" if req.kind == "improve_section" else "summarize"
        result = await self._ai.assist(
            AssistRequest(
                task=task,
                text=text[:8000],
                title=target.title,
                references=references,
                guidance=target.template.ai_guidance if target.template else "",
                goal=req.goal or "",
            )
        )
        verified, warnings = self._verify_quotes(result.citations, snapshot)
        warnings = [*result.warnings, *warnings]
        if task == "improve":
            if not heading:
                raise ApiError(422, "validation_failed", "Для улучшения укажите раздел (section).")
            items = [
                ProposalItem(
                    id="section",
                    kind="section",
                    section=heading,
                    current=text,
                    proposed=result.text,
                    reason="предложенная формулировка раздела",
                    evidence=verified,
                    applicable=result.text.strip() != text.strip() and bool(result.text.strip()),
                )
            ]
            summary = (
                "Предложена новая формулировка раздела «" + heading + "»."
                if items[0].applicable
                else "Изменений не предложено."
            )
        else:
            items = [
                ProposalItem(
                    id="summary",
                    kind="metadata",
                    field="summary",
                    current=target.meta.get("summary"),
                    proposed=result.text[:1000],
                    reason="краткое изложение выбранного текста",
                    evidence=verified,
                    applicable=bool(result.text.strip()),
                )
            ]
            summary = result.text[:500]
        return self._new(
            req.kind,
            self._base(target, snapshot),
            summary,
            items,
            warnings=warnings,
            insufficient=result.insufficient_data,
        )

    def _verify_quotes(
        self, citations: list[Any], snapshot: KnowledgeSnapshot
    ) -> tuple[list[Evidence], list[str]]:
        verified: list[Evidence] = []
        warnings: list[str] = []
        for c in citations:
            doc = snapshot.get(c.document_id)
            source = "\n".join(s.text for s in doc.sections) if doc else ""
            if doc is None or len(c.quote.strip()) < 12 or not quote_is_verbatim(c.quote, source):
                warnings.append(f"Цитата, приписанная {c.document_id}, не найдена дословно и исключена.")
                continue
            verified.append(_ev(doc, quote=c.quote))
        return verified, warnings

    async def _explain(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        question = (req.selection or req.prompt or "").strip()
        if len(question) < 3:
            raise ApiError(422, "validation_failed", "Выделите текст или задайте вопрос.")
        answer = await self._assistant.ask(
            user, AskRequest(question=f"Объясни: {question[:1500]}", sources=["team"])
        )
        evidence = [
            Evidence(
                document_id=c.document_id,
                title=c.title,
                revision=c.revision or "",
                status=(c.status.value if c.status else ""),
                quote=c.excerpt,
            )
            for c in answer.citations
        ]
        items = [
            ProposalItem(
                id="answer",
                kind="note",
                reason="ответ по утверждённым источникам",
                evidence=evidence,
                applicable=False,
            )
        ]
        target = await self._target(user, req, snapshot) if (req.draft_id or req.document_id) else None
        return self._new(
            "explain",
            self._base(target, snapshot),
            answer.answer,
            items,
            warnings=list(answer.warnings),
            insufficient=answer.confidence == "insufficient_evidence",
        )

    async def _completeness(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        target = await self._target(user, req, snapshot)
        items: list[ProposalItem] = []
        if target.template is None:
            items.append(
                ProposalItem(
                    id="no_template",
                    kind="note",
                    reason="У документа нет шаблона: проверяются только метаданные и ссылки.",
                    applicable=False,
                )
            )
        else:
            hints = dict(template_hints(target.template))
            for heading in missing_sections(target.template, target.body):
                items.append(
                    ProposalItem(
                        id=f"missing:{heading}",
                        kind="section",
                        section=heading,
                        current=None,
                        proposed=f"> {PLACEHOLDER}: {hints.get(heading, '')}".rstrip(": "),
                        reason=f"обязательный раздел шаблона «{target.template.title}» v{target.template.version}",
                    )
                )
            for heading in target.template.sections:
                text = section_text(target.body, heading)
                if text is not None and (not text.strip() or text.strip().startswith(f"> {PLACEHOLDER}")):
                    items.append(
                        ProposalItem(
                            id=f"empty:{heading}",
                            kind="note",
                            section=heading,
                            reason="раздел есть, но не заполнен",
                            applicable=False,
                        )
                    )
            for field_name in target.template.required_metadata:
                value = target.meta.get(field_name)
                if value in (None, "", [], "unassigned"):
                    items.append(
                        ProposalItem(
                            id=f"field:{field_name}",
                            kind="note",
                            field=field_name,
                            reason=f"обязательное поле шаблона «{field_name}» не заполнено",
                            applicable=False,
                        )
                    )
        unresolved = [
            w
            for w in (target.doc.wikilinks if target.doc else ())
            if w.id_like and snapshot.get(w.target) is None
        ]
        for w in unresolved:
            items.append(
                ProposalItem(
                    id=f"link:{w.line}",
                    kind="note",
                    reason=f"строка {w.line}: ссылка [[{w.target}]] не найдена",
                    applicable=False,
                )
            )
        gaps = len(items)
        summary = (
            "Документ заполнен по шаблону."
            if gaps == 0
            else f"Найдено пробелов: {gaps}. Недостающие разделы можно добавить заготовками."
        )
        return self._new("check_completeness", self._base(target, snapshot), summary, items)

    async def _find_related(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        target = await self._target(user, req, snapshot)
        linked = {w.target.lower() for w in (target.doc.wikilinks if target.doc else ())}
        linked |= {m.lower() for m in re.findall(r"\[\[([^\]|#]+)", target.body)}
        items: list[ProposalItem] = []
        for doc_id, why in self._metadata.suggest_related(
            snapshot, f"{target.title}\n{target.body}", exclude=target.document_id
        ):
            doc = snapshot.get(doc_id)
            if doc is None or doc.id.lower() in linked:
                continue
            items.append(
                ProposalItem(
                    id=f"link:{doc.id}",
                    kind="link",
                    target_id=doc.id,
                    proposed=f"[[{doc.id}|{doc.title.replace('|', '/')}]]",
                    reason=why + " — будет добавлена ссылка в тексте (references), не бизнес-зависимость",
                    evidence=[_ev(doc, why)],
                )
            )
        summary = f"Найдено связанных документов: {len(items)}. Принятые попадут в раздел связанных документов как [[ID|название]]."
        return self._new("find_related", self._base(target, snapshot), summary, items)

    async def _explain_relation(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        if not req.document_id or not req.target_id:
            raise ApiError(422, "validation_failed", "Нужны document_id и target_id.")
        source, target = snapshot.get(req.document_id), snapshot.get(req.target_id)
        if source is None or target is None:
            raise ApiError(404, "document_not_found", "Документ не найден.")
        graph = await self._graph.graph(user)
        chain = g.shortest_path(
            graph,
            g.doc_node_id(source.id),
            g.doc_node_id(target.id),
            max_depth=g.PATH_DEPTH_MAX,
            directed=False,
            flt=g.GraphFilter(),
        )
        items: list[ProposalItem] = []
        if not chain:
            summary = (
                f"Между {source.id} и {target.id} нет связей в базе (в пределах {g.PATH_DEPTH_MAX} шагов)."
            )
        else:
            kinds = []
            for i, edge in enumerate(chain, 1):
                declared = snapshot.get(edge.declared_in or "")
                if (
                    edge.type == "references"
                    and edge.provenance
                    and all(p.startswith("body:") for p in edge.provenance)
                ):
                    label = "ссылка в тексте (WikiLink) — упоминание, не бизнес-зависимость"
                elif edge.type == "references":
                    label = "простая ссылка (related_ids / текст) — упоминание, не бизнес-зависимость"
                elif edge.verified:
                    label = f"подтверждённая бизнес-связь «{edge.type}» из метаданных"
                else:
                    label = "временная или неподтверждённая связь"
                kinds.append(label)
                items.append(
                    ProposalItem(
                        id=f"edge:{i}",
                        kind="note",
                        reason=f"{edge.source.removeprefix('doc:')} → {edge.target.removeprefix('doc:')}: {label}; объявлено в {edge.declared_in} ({', '.join(edge.provenance) or edge.field})",
                        evidence=[_ev(declared, "объявляет связь")] if declared else [],
                        applicable=False,
                    )
                )
            typed = sum(1 for k in kinds if k.startswith("подтверждённая"))
            summary = (
                f"{source.id} и {target.id} связаны через {len(chain)} шаг(а). Подтверждённых бизнес-связей: {typed}, "
                f"упоминаний (references): {len(chain) - typed}. Упоминание не означает зависимость данных."
            )
        return self._new(
            "explain_relation",
            self._base(None, snapshot),
            summary,
            items,
            graph_link=f"/graph?focus={source.id}&depth=2",
        )

    async def _impact(
        self, user: UserContext, req: ProposalRequest, snapshot: KnowledgeSnapshot
    ) -> AiProposal:
        if not req.document_id:
            raise ApiError(422, "validation_failed", "Нужен document_id.")
        links = await self._links.links(user, req.document_id)
        if links is None:
            raise ApiError(404, "document_not_found", "Документ не найден.")
        doc = snapshot.get(req.document_id)
        assert doc is not None
        items: list[ProposalItem] = []
        typed_first = sorted(
            links.backlinks, key=lambda b: (b.relation == "references", b.source.document_id)
        )
        for b in typed_first:
            source = snapshot.get(b.source.document_id)
            if source is None:
                continue
            priority = "высокий" if b.relation != "references" else "проверить"
            items.append(
                ProposalItem(
                    id=f"task:{source.id}:{b.relation}",
                    kind="task",
                    target_id=source.id,
                    reason=f"{priority}: {source.id} связан с {doc.id} ({b.relation}, {', '.join(b.via)}) — проверьте, не устарели ли формулировки",
                    evidence=[
                        _ev(
                            source,
                            "ссылается на изменяемый документ",
                            quote=(b.excerpts[0] if b.excerpts else ""),
                        )
                    ],
                    applicable=False,
                )
            )
        if doc.template_id:
            items.append(
                ProposalItem(
                    id="template",
                    kind="note",
                    reason=f"Документ создан по шаблону {doc.template_id} v{doc.template_version or 1}: проверьте, не вышла ли новая версия.",
                    applicable=False,
                )
            )
        summary = (
            f"При изменении {doc.id} стоит проверить документов: {sum(1 for i in items if i.kind == 'task')} "
            "(сначала типизированные зависимости, затем упоминания). Это план для людей — ничего не меняется автоматически."
        )
        return self._new(
            "impact_analysis",
            self._base(None, snapshot),
            summary,
            items,
            graph_link=f"/graph?focus={doc.id}&depth=1",
        )

    # --- decisions ----------------------------------------------------------------------------------------
    def get(self, user: UserContext, proposal_id: str) -> AiProposal:
        proposal = self._store.get(user.user_id, proposal_id)
        if proposal is None:
            raise ApiError(404, "ai_proposal_not_found", "Предложение не найдено.")
        return proposal

    def list_proposals(
        self, user: UserContext, draft_id: str | None, document_id: str | None
    ) -> list[AiProposal]:
        return self._store.find(user.user_id, draft_id, document_id)

    def reject(self, user: UserContext, proposal_id: str) -> AiProposal:
        proposal = self.get(user, proposal_id)
        if proposal.status not in ("suggested",):
            raise ApiError(409, "ai_proposal_closed", "Решение по предложению уже принято.")
        proposal.status, proposal.decided_at = "rejected", _now()
        self._store.save(user.user_id, proposal)
        return proposal

    async def _still_valid(
        self, user: UserContext, proposal: AiProposal, snapshot: KnowledgeSnapshot
    ) -> str | None:
        base = proposal.base
        if base.draft_id:
            draft = await self._proposals.get(user, base.draft_id)
            if draft.status != "draft":
                return "черновик уже не редактируется"
            if draft.edit_version != base.edit_version:
                return "черновик изменён после того, как было сделано предложение"
        elif base.document_id and base.revision:
            doc = snapshot.get(base.document_id)
            if doc is None or doc.revision != base.revision:
                return "документ изменился или удалён после того, как было сделано предложение"
        if base.template_id and proposal.kind == "draft_from_prompt":
            current = self._authoring.registry.get(base.template_id)
            if current is None or current.version != base.template_version or current.status != "active":
                return "шаблон получил новую версию или стал неактивным: сгенерируйте предложение заново"
        return None

    async def accept(self, user: UserContext, proposal_id: str, req: AcceptRequest) -> AiProposal:
        async with self._accept_lock:  # two simultaneous Accepts of one proposal: only the first applies
            return await self._accept(user, proposal_id, req)

    async def _accept(self, user: UserContext, proposal_id: str, req: AcceptRequest) -> AiProposal:
        proposal = self.get(user, proposal_id)
        if proposal.status != "suggested":
            raise ApiError(409, "ai_proposal_closed", "Решение по предложению уже принято.")
        if proposal.kind == "draft_template":
            raise ApiError(
                409,
                "ai_proposal_use_editor",
                "Предложение шаблона принимается в редакторе шаблонов: проверьте, отредактируйте и сохраните черновик.",
            )
        chosen = [i for i in proposal.items if i.id in set(req.item_ids)]
        if not chosen or any(not i.applicable for i in chosen):
            raise ApiError(422, "validation_failed", "Выберите применимые пункты предложения.")
        snapshot = await self._knowledge.snapshot(user)
        stale = await self._still_valid(user, proposal, snapshot)
        missing_targets = [
            i.target_id
            for i in chosen
            if i.kind == "link" and i.target_id and snapshot.get(i.target_id) is None
        ]
        if missing_targets:
            stale = f"связанные документы больше не доступны: {', '.join(missing_targets)}"
        if stale:
            proposal.status, proposal.decided_at = "invalidated", _now()
            proposal.warnings.append(f"Предложение устарело: {stale}.")
            self._store.save(user.user_id, proposal)
            raise ApiError(409, "ai_proposal_stale", f"Предложение устарело: {stale}. Сгенерируйте новое.")
        reason = req.reason or f"Принято предложение ИИ ({proposal.kind})"
        if proposal.kind == "draft_from_prompt":
            result = await self._accept_new_document(user, proposal, chosen, reason)
        else:
            result = await self._accept_into_draft(user, proposal, chosen, reason, snapshot)
        proposal.applied_items = [i.id for i in chosen]
        proposal.result_draft_id = result.id
        proposal.status = (
            "applied"
            if len(chosen) == sum(1 for i in proposal.items if i.applicable)
            else "partially_applied"
        )
        proposal.decided_at = _now()
        self._store.save(user.user_id, proposal)
        logger.info("ai proposal %s accepted items=%d draft=%s", proposal.id, len(chosen), result.id)
        return proposal

    async def _accept_new_document(
        self, user: UserContext, proposal: AiProposal, chosen: list[ProposalItem], reason: str
    ) -> ProposalDetail:
        draft_item = next((i for i in proposal.items if i.kind == "draft"), None)
        if draft_item is None or draft_item.id not in {i.id for i in chosen}:
            raise ApiError(422, "validation_failed", "Чтобы создать документ, примите пункт «черновик».")
        fields = {i.field: i.proposed for i in chosen if i.kind == "metadata" and i.field}
        data = draft_item.proposed
        metadata = NewDocumentMetadata(
            title=str(data["title"])[:300],
            tags=[str(t) for t in fields.get("tags") or []][:30],
            related_ids=[str(r) for r in fields.get("related_ids") or []][:50],
        )
        return await self._proposals.create_new_document(
            user,
            NewDocumentDraftCreate(
                template_id=str(proposal.base.template_id),
                metadata=metadata,
                body=str(data["body"]),
                reason=reason,
                origin="ai_suggestion",
            ),
        )

    async def _accept_into_draft(
        self,
        user: UserContext,
        proposal: AiProposal,
        chosen: list[ProposalItem],
        reason: str,
        snapshot: KnowledgeSnapshot,
    ) -> ProposalDetail:
        base = proposal.base
        if base.draft_id:
            draft = await self._proposals.get(user, base.draft_id)
            content = draft.proposed_content
        else:
            doc = snapshot.get(base.document_id or "")
            if doc is None:
                raise ApiError(404, "document_not_found", "Документ не найден.")
            content = doc.raw
        yaml_text, body = split_frontmatter(content)
        meta = dict(load_frontmatter(yaml_text))
        for item in chosen:
            if item.kind == "metadata" and item.field:
                meta[item.field] = item.proposed
            elif item.kind == "section" and item.section:
                body = replace_section(body, item.section, str(item.proposed))
        links = [i for i in chosen if i.kind == "link"]
        if links:
            section = next(
                (s for s in RELATED_SECTION_NAMES if section_text(body, s) is not None), "Связанные документы"
            )
            existing = section_text(body, section) or ""
            lines = [f"- {i.proposed}" for i in links]
            body = replace_section(
                body, section, (existing.strip() + "\n" if existing.strip() else "") + "\n".join(lines)
            )
        if base.draft_id:
            draft = await self._proposals.get(user, base.draft_id)
            if draft.operation == "create":
                allowed = set(NewDocumentMetadata.model_fields)
                return await self._proposals.save_draft(
                    user,
                    base.draft_id,
                    DraftUpdate(
                        expected_version=int(base.edit_version or 1),
                        metadata=NewDocumentMetadata(
                            **{k: v for k, v in meta.items() if k in allowed and v is not None}
                        ),
                        body=body.strip("\n") + "\n",
                        reason=reason,
                    ),
                )
            return await self._proposals.save_draft(
                user,
                base.draft_id,
                DraftUpdate(
                    expected_version=int(base.edit_version or 1),
                    proposed_content=_compose(meta, body),
                    reason=reason,
                ),
            )
        return await self._proposals.create(
            user,
            DraftCreate(
                document_id=str(base.document_id),
                base_revision=str(base.revision),
                proposed_content=_compose(meta, body),
                reason=reason,
                origin="ai_suggestion",
            ),
        )


def _compose(meta: dict[str, Any], body: str) -> str:
    """Frontmatter of an EXISTING document after accepted field changes: every other key is kept as is."""
    clean = {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in meta.items()}
    header = yaml.safe_dump(clean, allow_unicode=True, sort_keys=False, default_flow_style=None, width=1000)
    return f"---\n{header}---\n\n{body.strip(chr(10))}\n"


def as_json(proposal: AiProposal) -> str:
    return json.dumps(proposal.model_dump(), ensure_ascii=False)
