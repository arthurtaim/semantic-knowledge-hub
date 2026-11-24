"""Metadata without YAML (M5.6.3): document types, import preview, staging of files that lack metadata.

Trust model (docs/METADATA_PIPELINE.md): the server owns the ID, the initial `draft` status, timestamps,
provenance and the pinned template; the person owns title / owner / description; the parser contributes
headings, WikiLinks and existing YAML; suggestions (tags, summary, related documents, template) are marked
`suggested` and applied only when the person accepts them. An unknown owner stays `unassigned`.
Nothing here writes: a preview never touches the knowledge base, and an import becomes a DRAFT proposal.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.adapters.knowledge.base import KnowledgeRepository, KnowledgeSnapshot
from app.domain.markdown import parse_markdown, render_html
from app.domain.models import DocStatus, DocType, UserContext, ValidationIssue
from app.domain.proposals import MAX_PROPOSED_CHARS
from app.domain.schema import FrontmatterError, parse_document, split_frontmatter
from app.domain.template_match import recommend_templates
from app.domain.templates import DocumentTemplate
from app.domain.text import stem, tokenize
from app.domain.wikilinks import extract_wikilinks
from app.errors import ApiError
from app.services.authoring import BLANK_DEFAULT_TYPE, UNASSIGNED_OWNER, AuthoringService
from app.services.knowledge import KnowledgeService
from app.services.retrieval import ID_CANDIDATE_RE

FieldOrigin = Literal["system", "parsed", "existing", "suggested", "missing"]
STAGING_CODES = frozenset(
    {"frontmatter_missing", "frontmatter_invalid_yaml", "frontmatter_unterminated", "frontmatter_not_mapping"}
)
SYSTEM_FIELDS = ("id", "status", "template", "template_version", "created_at", "updated_at", "origin")
HUMAN_FIELDS = ("title", "owner", "summary", "tags")
MAX_SUGGESTED_TAGS = 6
MAX_SUGGESTED_RELATED = 5


class DocumentTypeInfo(BaseModel):
    type: DocType
    templates: list[str]  # ACTIVE templates that create this type
    required_fields: list[str]
    system_fields: list[str]
    human_fields: list[str]


class MetadataField(BaseModel):
    field: str
    value: Any = None
    origin: FieldOrigin
    note: str = ""
    evidence: list[str] = []  # document IDs / headings that support a suggestion


class TemplateSuggestion(BaseModel):
    template_id: str
    version: int
    title: str
    score: float
    reasons: list[str]


class ImportPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str | None = Field(default=None, max_length=MAX_PROPOSED_CHARS)
    path: str | None = Field(default=None, max_length=400)  # a staged file of the knowledge root
    filename: str | None = Field(default=None, max_length=200)


class ImportPreview(BaseModel):
    state: Literal["ready", "needs_metadata_review", "invalid_metadata", "conflict"]
    has_frontmatter: bool
    document_id: str  # kept from valid YAML, or the ID the backend would allocate
    title: str
    fields: list[MetadataField]
    missing: list[str]
    templates: list[TemplateSuggestion]
    issues: list[ValidationIssue]
    body: str
    preview_html: str
    content: str  # the original text (for the create call)
    source_path: str | None = None
    keeps_original_metadata: bool


class StagingItem(BaseModel):
    path: str
    code: str
    message: str
    readable: bool  # the backend can read it for a preview (local workspace); else paste the content


def _issue(severity: str, code: str, message: str, field: str | None = None) -> ValidationIssue:
    return ValidationIssue(severity=severity, code=code, message=message, field=field)


def _title_from(body: str, filename: str | None) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", body, flags=re.MULTILINE)
    if match:
        return match.group(1).strip()[:300]
    if filename:
        return PurePosixPath(filename).stem.replace("_", " ").replace("-", " ").strip()[:300]
    first = next((line.strip() for line in body.splitlines() if line.strip()), "")
    return first.lstrip("#").strip()[:120]


class MetadataService:
    def __init__(
        self, knowledge: KnowledgeService, authoring: AuthoringService, repository: KnowledgeRepository
    ) -> None:
        self._knowledge = knowledge
        self._authoring = authoring
        self._repository = repository

    # --- document types ---------------------------------------------------------------------------
    def document_types(self) -> list[DocumentTypeInfo]:
        active = [t for t in self._authoring.registry.active().values() if t.listed and t.status == "active"]
        return [
            DocumentTypeInfo(
                type=doc_type,
                templates=[t.id for t in active if t.doc_type == doc_type],
                required_fields=["id", "title", "type", "status", "owner", "tags"],
                system_fields=list(SYSTEM_FIELDS),
                human_fields=list(HUMAN_FIELDS),
            )
            for doc_type in DocType
        ]

    # --- suggestions (deterministic, evidence-backed) -----------------------------------------------
    @staticmethod
    def suggest_tags(snapshot: KnowledgeSnapshot, text: str, template: DocumentTemplate | None) -> list[str]:
        """Existing tags of the base whose stem occurs in the text (most frequent first) + template defaults."""
        words = Counter(stem(t) for t in tokenize(text) if len(t) > 2)
        vocabulary = {tag for d in snapshot.documents.values() for tag in d.tags}
        scored = []
        for tag in vocabulary:
            parts = [stem(p) for p in re.split(r"[-_\s]+", tag.lower()) if len(p) > 2]
            if parts and all(words.get(p, 0) for p in parts):
                scored.append((-sum(words[p] for p in parts), tag))
        tags = [t for _, t in sorted(scored)][:MAX_SUGGESTED_TAGS]
        defaults = list(template.default_tags) if template else []
        return list(dict.fromkeys([*defaults, *tags]))[:MAX_SUGGESTED_TAGS]

    def suggest_related(
        self, snapshot: KnowledgeSnapshot, text: str, exclude: str = ""
    ) -> list[tuple[str, str]]:
        """(document id, why) — explicit mentions first (WikiLinks / IDs in the text), then approved documents
        that the retrieval pipeline ranks highest for the text's title and first lines."""
        found: dict[str, str] = {}
        for link in extract_wikilinks(text):
            doc = snapshot.get(link.target) if link.id_like else None
            if doc is not None and doc.id != exclude:
                found.setdefault(doc.id, f"ссылка [[{doc.id}]] в тексте, строка {link.line}")
        for match in ID_CANDIDATE_RE.finditer(text):
            doc = snapshot.get(match.group(0))
            if doc is not None and doc.id != exclude:
                found.setdefault(doc.id, f"ID {doc.id} упомянут в тексте")
        head = " ".join(text.split()[:40])
        analysis = self._knowledge.retrieval.analyze(head)
        from app.adapters.search.base import SearchFilters

        filters = SearchFilters(statuses=frozenset({DocStatus.approved.value}))
        for hit in self._knowledge.retrieval.rank_documents(
            snapshot, analysis, filters, 8, expand_graph=False
        ):
            if len(found) >= MAX_SUGGESTED_RELATED:
                break
            doc = snapshot.get(hit.document_id)
            if doc is not None and doc.id != exclude and doc.id not in found:
                found[doc.id] = "похожий утверждённый документ: " + "; ".join(hit.reasons[:2])
        return list(found.items())[:MAX_SUGGESTED_RELATED]

    def default_template(self) -> DocumentTemplate | None:
        """For text whose type is not recognised: the general knowledge article, else the first active one."""
        active = [t for t in self._authoring.registry.active().values() if t.listed and t.status == "active"]
        return next((t for t in active if t.id == "knowledge_article"), active[0] if active else None)

    def template_suggestions(self, text: str) -> list[TemplateSuggestion]:
        return [
            TemplateSuggestion(
                template_id=m.template_id,
                version=m.version,
                title=m.title,
                score=m.score,
                reasons=list(m.reasons),
            )
            for m in recommend_templates(text, self._authoring.registry.active())
        ]

    # --- import ---------------------------------------------------------------------------------------
    async def staging(self, user: UserContext) -> list[StagingItem]:
        snapshot = await self._knowledge.snapshot(user)
        readable = hasattr(self._repository, "read_text")
        return [
            StagingItem(path=i.path, code=i.code, message=i.message, readable=readable)
            for i in snapshot.issues
            if i.code in STAGING_CODES
        ]

    async def _staged_content(self, user: UserContext, path: str) -> str:
        snapshot = await self._knowledge.snapshot(user)
        if not any(i.path == path and i.code in STAGING_CODES for i in snapshot.issues):
            raise ApiError(404, "staged_file_not_found", "Такого файла без метаданных в базе нет.")
        reader = getattr(self._repository, "read_text", None)
        content = await reader(path) if reader else None
        if content is None:
            raise ApiError(409, "staged_file_unreadable", "Файл нельзя прочитать отсюда: вставьте его текст.")
        return str(content)

    async def import_preview(self, user: UserContext, req: ImportPreviewRequest) -> ImportPreview:
        if req.content is None and req.path is None:
            raise ApiError(422, "validation_failed", "Нужен текст документа (content) или путь (path).")
        content = req.content if req.content is not None else await self._staged_content(user, req.path or "")
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        snapshot = await self._knowledge.snapshot(user)
        issues: list[ValidationIssue] = []
        has_frontmatter = content.lstrip("﻿").startswith("---")
        meta: dict[str, Any] = {}
        body = content
        state: Literal["ready", "needs_metadata_review", "invalid_metadata", "conflict"]
        if has_frontmatter:
            try:
                _, body = split_frontmatter(content)
            except FrontmatterError:
                body = content.split("---", 2)[-1] if content.count("---") >= 2 else content
            parsed = parse_document(content)
            if parsed.is_valid:
                meta = dict(parsed.metadata)
                state = "ready"
            else:
                state = "invalid_metadata"
                issues += [_issue("error", e.code, e.message, e.field) for e in parsed.errors]
        else:
            state = "needs_metadata_review"
        filename = req.filename or req.path
        title = str(meta.get("title") or _title_from(body, filename))
        recommendations = self.template_suggestions(f"{title}\n{body}")
        template = None
        if meta.get("template"):
            template = self._authoring.registry.get(str(meta["template"]))
        elif recommendations:
            template = self._authoring.registry.get(recommendations[0].template_id)
        else:
            template = self.default_template()
        fields: list[MetadataField] = []
        missing: list[str] = []
        if meta:
            document_id = str(meta["id"])
            if snapshot.get(document_id) is not None:
                state = "conflict"
                issues.append(
                    _issue(
                        "error",
                        "document_id_taken",
                        f"Документ {document_id} уже есть в базе: это изменение существующего документа, "
                        "предложите его через страницу документа.",
                        "id",
                    )
                )
            for key in (
                "id",
                "title",
                "type",
                "status",
                "owner",
                "tags",
                "related_ids",
                "summary",
                "template",
            ):
                if key in meta and meta[key] not in (None, "", []):
                    fields.append(
                        MetadataField(field=key, value=meta[key], origin="existing", note="из YAML файла")
                    )
            if meta.get("status") == DocStatus.approved.value:
                issues.append(
                    _issue(
                        "warning",
                        "imported_approved",
                        "В файле status: approved. В базе он станет утверждённым только после ревью и merge; "
                        "до этого — черновик, который ассистент не цитирует.",
                        "status",
                    )
                )
        else:
            # No active template at all: the document is imported as a BLANK one (a template can be applied later).
            document_id = await self._authoring.allocate_id(user, template)
            fields.append(
                MetadataField(
                    field="id", value=document_id, origin="system", note="выделит сервер при создании"
                )
            )
            fields.append(MetadataField(field="status", value=DocStatus.draft.value, origin="system"))
            fields.append(
                MetadataField(
                    field="title",
                    value=title,
                    origin="parsed" if re.search(r"^#\s+", body, flags=re.MULTILINE) else "suggested",
                    note="заголовок первого уровня"
                    if re.search(r"^#\s+", body, flags=re.MULTILINE)
                    else "из имени файла",
                )
            )
            if template is not None:
                fields.append(
                    MetadataField(
                        field="template",
                        value=template.id,
                        origin="suggested",
                        note="; ".join(recommendations[0].reasons)
                        if recommendations
                        else "тип по тексту не распознан: выбран шаблон по умолчанию, проверьте его",
                    )
                )
                fields.append(
                    MetadataField(
                        field="type", value=template.doc_type.value, origin="suggested", note="тип шаблона"
                    )
                )
            else:
                fields.append(
                    MetadataField(
                        field="template",
                        value=None,
                        origin="missing",
                        note="активных шаблонов нет: документ без шаблона, шаблон можно применить позже",
                    )
                )
                fields.append(
                    MetadataField(
                        field="type",
                        value=BLANK_DEFAULT_TYPE.value,
                        origin="suggested",
                        note="общий раздел для документа без шаблона",
                    )
                )
            fields.append(
                MetadataField(
                    field="owner",
                    value=UNASSIGNED_OWNER,
                    origin="missing",
                    note="владелец неизвестен: укажите его",
                )
            )
            missing.append("owner")
            tags = self.suggest_tags(snapshot, f"{title}\n{body}", template)
            fields.append(
                MetadataField(field="tags", value=tags, origin="suggested", note="теги, уже принятые в базе")
            )
            summary = (parse_markdown(body).paragraphs or [""])[0][:300]
            if summary:
                fields.append(
                    MetadataField(field="summary", value=summary, origin="parsed", note="первый абзац")
                )
            related = self.suggest_related(snapshot, body)
            if related:
                fields.append(
                    MetadataField(
                        field="related_ids",
                        value=[r[0] for r in related],
                        origin="suggested",
                        note="связанные документы",
                        evidence=[f"{i}: {why}" for i, why in related],
                    )
                )
        if template is not None:
            from app.domain.templates import missing_sections

            absent = missing_sections(template, body)
            if absent:
                issues.append(
                    _issue(
                        "warning",
                        "template_section_missing",
                        f"Нет разделов шаблона «{template.title}»: {', '.join(absent)}.",
                    )
                )
        for link in extract_wikilinks(body):
            if link.id_like and snapshot.get(link.target) is None:
                issues.append(
                    _issue(
                        "warning",
                        "wikilink_unresolved",
                        f"Строка {link.line}: ссылка [[{link.target}]] не найдена.",
                    )
                )
        resolver = self._knowledge.wikilink_resolver(snapshot)
        return ImportPreview(
            state=state,
            has_frontmatter=has_frontmatter,
            document_id=document_id,
            title=title,
            fields=fields,
            missing=missing,
            templates=recommendations,
            issues=issues,
            body=body.strip("\n") + "\n",
            preview_html=render_html(body, resolver),
            content=content,
            source_path=req.path,
            keeps_original_metadata=state in ("ready", "conflict"),
        )
