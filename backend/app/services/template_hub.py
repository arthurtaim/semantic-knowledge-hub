"""Template Hub (M5.6.3): one versioned registry read by people (catalogue UI) and by the runtime AI.

The registry (`TemplateRegistry`) is the only store. This service is a read model over it: catalogue rows,
the exact structure of any version, a version comparison, and where a template is used — counted only over
documents the reader can see and the reader's own drafts. The AI gets the SAME objects through
`for_ai()` / `exact()` (active, listed, reviewed templates only); it never reads template files itself.
"""

from __future__ import annotations

from collections import Counter
from typing import Literal

from pydantic import BaseModel

from app.domain.markdown import render_html
from app.domain.models import DocStatus, DocType, UserContext
from app.domain.template_registry import TemplateRegistry
from app.domain.templates import DocumentTemplate, missing_sections
from app.services.authoring import AuthoringService, template_hints
from app.services.knowledge import KnowledgeService

TemplateStatus = Literal["draft", "active", "deprecated", "archived"]


class TemplateSection(BaseModel):
    title: str
    required: bool
    hint: str


class TemplateVersionRow(BaseModel):
    version: int
    status: str
    active: bool
    first_seen: str
    changes: str
    breaking: bool


class TemplateSummary(BaseModel):
    id: str
    title: str
    description: str
    doc_type: DocType
    category: str
    owner: str
    labels: list[str]
    status: str
    version: int
    versions: list[int]
    updated: str
    listed: bool
    required_sections: int
    optional_sections: int
    documents: int  # visible documents created with this template (any version)


class TemplateUsage(BaseModel):
    document_id: str
    title: str
    status: DocStatus
    template_version: int | None


class TemplateDetail(TemplateSummary):
    id_prefix: str
    default_tags: list[str]
    sections: list[TemplateSection]
    required_metadata: list[str]
    optional_metadata: list[str]
    validation: list[str]
    instructions: str
    ai_guidance: str
    example: str
    example_html: str
    skeleton: str
    changes: str
    breaking: bool
    migration: str
    history: list[TemplateVersionRow]
    used_by: list[TemplateUsage]
    my_open_drafts: dict[str, int]  # "v<N>" -> number of the reader's open drafts pinned to that version


class TemplateComparison(BaseModel):
    template_id: str
    from_version: int
    to_version: int
    sections_added: list[str]
    sections_removed: list[str]
    became_required: list[str]
    became_optional: list[str]
    metadata_required_added: list[str]
    metadata_required_removed: list[str]
    validation_added: list[str]
    validation_removed: list[str]
    status_change: str | None
    breaking: bool
    migration: str
    changes: str


def sections_of(template: DocumentTemplate) -> list[TemplateSection]:
    optional = set(template.optional_sections)
    return [
        TemplateSection(title=h, required=h not in optional, hint=hint)
        for h, hint in template_hints(template)
    ]


class TemplateHubService:
    def __init__(self, authoring: AuthoringService, knowledge: KnowledgeService) -> None:
        self._authoring = authoring
        self._knowledge = knowledge

    @property
    def _registry(self) -> TemplateRegistry:
        return self._authoring.registry

    async def _usage(self, user: UserContext) -> Counter[str]:
        snapshot = await self._knowledge.snapshot(user)
        return Counter(d.template_id for d in snapshot.documents.values() if d.template_id)

    def _summary(self, t: DocumentTemplate, usage: Counter[str]) -> TemplateSummary:
        return TemplateSummary(
            id=t.id,
            title=t.title,
            description=t.description,
            doc_type=t.doc_type,
            category=t.category,
            owner=t.owner,
            labels=list(t.labels),
            status=t.status,
            version=t.version,
            versions=[v.version for v in self._registry.versions(t.id)],
            updated=t.updated,
            listed=t.listed,
            required_sections=len(t.sections),
            optional_sections=len(t.optional_sections),
            documents=usage.get(t.id, 0),
        )

    async def catalogue(
        self,
        user: UserContext,
        *,
        q: str = "",
        status: str | None = None,
        doc_type: str | None = None,
        category: str | None = None,
        label: str | None = None,
        include_hidden: bool = False,
    ) -> list[TemplateSummary]:
        usage = await self._usage(user)
        needle = q.strip().casefold()
        rows = []
        for t in self._registry.active().values():
            if (not t.listed and not include_hidden) or (t.status == "archived" and status != "archived"):
                continue
            if (status and t.status != status) or (doc_type and t.doc_type.value != doc_type):
                continue
            if (category and t.category != category) or (label and label.lower() not in t.labels):
                continue
            haystack = f"{t.id} {t.title} {t.description} {t.category} {' '.join(t.labels)}".casefold()
            if needle and needle not in haystack:
                continue
            rows.append(self._summary(t, usage))
        return rows

    async def detail(
        self, user: UserContext, template_id: str, version: int | None = None
    ) -> TemplateDetail | None:
        current = self._registry.get(template_id)
        t = self._registry.get(template_id, version) if version is not None else current
        if t is None:
            return None
        snapshot = await self._knowledge.snapshot(user)
        usage = await self._usage(user)
        used_by = sorted(
            (
                TemplateUsage(
                    document_id=d.id, title=d.title, status=d.status, template_version=d.template_version
                )
                for d in snapshot.documents.values()
                if d.template_id == t.id
            ),
            key=lambda u: u.document_id,
        )
        drafts: Counter[str] = Counter()
        for row in self._authoring.store.list_rows("draft", None):
            if row["author"] == user.user_id and row["template_id"] == t.id:
                drafts[f"v{row['template_version'] or 1}"] += 1
        history = []
        for info in self._registry.versions(t.id):
            stored = self._registry.get(t.id, info.version)
            history.append(
                TemplateVersionRow(
                    version=info.version,
                    status=stored.status if stored else "active",
                    active=info.active,
                    first_seen=info.first_seen,
                    changes=stored.changes if stored else "",
                    breaking=stored.breaking if stored else False,
                )
            )
        summary = self._summary(t, usage)
        return TemplateDetail(
            **summary.model_dump(),
            id_prefix=t.id_prefix,
            default_tags=list(t.default_tags),
            sections=sections_of(t),
            required_metadata=list(t.required_metadata),
            optional_metadata=list(t.optional_metadata),
            validation=list(t.validation),
            instructions=t.instructions,
            ai_guidance=t.ai_guidance,
            example=t.example,
            example_html=render_html(t.example) if t.example else "",
            skeleton=t.body,
            changes=t.changes,
            breaking=t.breaking,
            migration=t.migration,
            history=history,
            used_by=used_by,
            my_open_drafts=dict(drafts),
        )

    def compare(self, template_id: str, from_version: int, to_version: int) -> TemplateComparison | None:
        old = self._registry.get(template_id, from_version)
        new = self._registry.get(template_id, to_version)
        if old is None or new is None:
            return None
        old_all = [*old.sections, *old.optional_sections]
        new_all = [*new.sections, *new.optional_sections]
        return TemplateComparison(
            template_id=template_id,
            from_version=from_version,
            to_version=to_version,
            sections_added=[s for s in new_all if s not in old_all],
            sections_removed=[s for s in old_all if s not in new_all],
            became_required=[s for s in new.sections if s in old.optional_sections],
            became_optional=[s for s in new.optional_sections if s in old.sections],
            metadata_required_added=[f for f in new.required_metadata if f not in old.required_metadata],
            metadata_required_removed=[f for f in old.required_metadata if f not in new.required_metadata],
            validation_added=[v for v in new.validation if v not in old.validation],
            validation_removed=[v for v in old.validation if v not in new.validation],
            status_change=f"{old.status} → {new.status}" if old.status != new.status else None,
            breaking=new.breaking and to_version > from_version,
            migration=new.migration,
            changes=new.changes,
        )

    # --- the same registry for the runtime AI (read-only; active, listed, reviewed templates only) ---------
    def for_ai(self) -> list[DocumentTemplate]:
        return [t for t in self._registry.active().values() if t.listed and t.status == "active"]

    def exact(self, template_id: str, version: int | None = None) -> DocumentTemplate | None:
        """A pinned version for AI drafting/validation; None for unknown, draft or archived templates."""
        t = self._registry.get(template_id, version)
        if t is None or t.status in ("draft", "archived"):
            return None
        return t

    @staticmethod
    def completeness(template: DocumentTemplate, body: str) -> list[str]:
        """Required sections of the PINNED template version missing from a body."""
        return missing_sections(template, body)
