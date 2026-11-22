"""Authoring of NEW documents: templates, generated frontmatter, validation, preview and demo AI.

Nothing here writes to the knowledge base. A new document becomes a `create` proposal
(services/proposals.py) and enters the knowledge base only after a confirmed GitLab merge and sync
(docs/DOCUMENT_CREATION_WORKFLOW.md).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from app.adapters.ai.base import AIProvider, AIProviderError, AuthoringReference, AuthoringRequest
from app.adapters.knowledge.base import KnowledgeRepository, RepositoryUnavailableError
from app.adapters.search.base import SearchFilters
from app.domain.markdown import render_html
from app.domain.models import DocStatus, UserContext, ValidationIssue
from app.domain.proposals import (
    AiDraftRequest,
    AiDraftResponse,
    AuthoringCheckResponse,
    AuthoringCitationInfo,
    AuthoringReferenceInfo,
    DocumentTemplateInfo,
    NewDocumentMetadata,
)
from app.domain.schema import is_valid_document_id, parse_document, split_frontmatter
from app.domain.templates import (
    PLACEHOLDER,
    DocumentTemplate,
    compose_document,
    missing_sections,
    placeholder_count,
    suggest_document_id,
    suggest_path,
)
from app.domain.text import analyze_query
from app.errors import ApiError
from app.services.assistant import prepare_passage_text, quote_is_verbatim
from app.services.knowledge import KnowledgeService
from app.services.proposals import ProposalStore, repository_path_problem

logger = logging.getLogger("skh.authoring")

MAX_REFERENCES = 4
MAX_REFERENCE_SECTION_CHARS = 1500
_HINT_RE = re.compile(rf"^>?\s*{PLACEHOLDER}:?\s*(.*)$")
TAKEN_CODES = frozenset({"document_id_taken", "document_path_taken"})


@dataclass
class NewDocumentCheck:
    content: str
    path: str
    issues: list[ValidationIssue]
    id_available: bool
    path_available: bool

    @property
    def errors(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "error"]

    def taken_issue(self) -> ValidationIssue | None:
        return next((i for i in self.issues if i.code in TAKEN_CODES), None)


def _issue(severity: str, code: str, message: str, field: str | None = None) -> ValidationIssue:
    return ValidationIssue.model_validate(
        {"severity": severity, "code": code, "message": message, "field": field}
    )


def template_hints(template: DocumentTemplate) -> tuple[tuple[str, str], ...]:
    """(heading, placeholder hint) pairs taken from the template skeleton."""
    result: list[tuple[str, str]] = []
    current: str | None = None
    hint = ""
    for line in template.body.splitlines():
        if line.startswith("## "):
            if current is not None:
                result.append((current, hint))
            current, hint = line[3:].strip(), ""
        elif current is not None and not hint:
            match = _HINT_RE.match(line.strip())
            if match:
                hint = match.group(1).strip()
    if current is not None:
        result.append((current, hint))
    return tuple(result)


def split_document(content: str) -> tuple[dict[str, object], str]:
    """(frontmatter fields, body) of a stored new-document proposal, for the editing form."""
    from app.domain.schema import load_frontmatter

    yaml_text, body = split_frontmatter(content)
    meta = load_frontmatter(yaml_text)
    return {str(k): (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in meta.items()}, body


class AuthoringService:
    def __init__(
        self,
        *,
        templates: dict[str, DocumentTemplate],
        repository: KnowledgeRepository,
        knowledge: KnowledgeService,
        store: ProposalStore,
        ai: AIProvider,
        knowledge_prefix: str = "",
        max_document_bytes: int | None = None,
    ) -> None:
        self._templates = templates
        self._repository = repository
        self._knowledge = knowledge
        self._store = store
        self._ai = ai
        self._prefix = knowledge_prefix.strip("/")
        self._max_bytes = max_document_bytes

    @property
    def knowledge_prefix(self) -> str:
        return self._prefix

    def template(self, template_id: str) -> DocumentTemplate:
        template = self._templates.get(template_id)
        if template is None:
            raise ApiError(404, "template_not_found", "Шаблон документа не найден.")
        return template

    async def _snapshot_ids(self, user: UserContext) -> tuple[set[str], set[str]]:
        try:
            snapshot = await self._knowledge.snapshot(user)
        except RepositoryUnavailableError as exc:
            raise ApiError(503, exc.code, f"Источник знаний недоступен: {exc.message}") from exc
        ids = {d.id for d in snapshot.documents.values()}
        paths = {d.path for d in snapshot.documents.values()} | {i.path for i in snapshot.issues}
        return ids, paths

    async def templates(self, user: UserContext) -> list[DocumentTemplateInfo]:
        ids, _ = await self._snapshot_ids(user)
        taken = ids | self._store.open_create_ids()
        result = []
        for template in self._templates.values():
            suggested = suggest_document_id(template.id_prefix, taken)
            result.append(
                DocumentTemplateInfo(
                    id=template.id,
                    title=template.title,
                    description=template.description,
                    doc_type=template.doc_type,
                    id_prefix=template.id_prefix,
                    default_tags=list(template.default_tags),
                    sections=list(template.sections),
                    skeleton=template.body,
                    suggested_id=suggested,
                    suggested_path=suggest_path(suggested, self._prefix),
                )
            )
        return result

    # --- validation --------------------------------------------------------------------------------
    def compose(self, template: DocumentTemplate, metadata: NewDocumentMetadata, body: str) -> str:
        fields = metadata.model_dump()
        fields["type"] = template.doc_type
        fields["tags"] = [t.lower() for t in metadata.tags]
        return compose_document(fields, body)

    async def check_new_document(
        self,
        user: UserContext,
        template_id: str,
        metadata: NewDocumentMetadata,
        body: str,
        path: str | None,
        origin: str,
        *,
        exclude_proposal_id: str | None = None,
        fresh: bool = False,
    ) -> NewDocumentCheck:
        template = self.template(template_id)
        target = path.strip() if path and path.strip() else suggest_path(metadata.id.strip(), self._prefix)
        content = self.compose(template, metadata, body)
        return await self.check_content(
            user,
            template,
            content,
            target,
            origin,
            metadata.id.strip(),
            exclude_proposal_id=exclude_proposal_id,
            fresh=fresh,
        )

    async def check_content(
        self,
        user: UserContext,
        template: DocumentTemplate | None,
        content: str,
        path: str,
        origin: str,
        document_id: str,
        *,
        exclude_proposal_id: str | None = None,
        fresh: bool = False,
    ) -> NewDocumentCheck:
        """Full validation of a new document. `fresh` re-reads the source (before mark-ready/submit):
        a concurrent document or file with the same ID/path is reported, never overwritten."""
        parsed = parse_document(
            content, expected_id=document_id if is_valid_document_id(document_id) else None
        )
        issues = list(parsed.issues)
        if self._max_bytes is not None and len(content.encode("utf-8")) > self._max_bytes:
            issues.append(
                _issue(
                    "error",
                    "document_too_large",
                    f"Документ превышает допустимый размер ({self._max_bytes // 1024} КБ).",
                )
            )
        problem = repository_path_problem(path, self._prefix)
        if problem:
            issues.append(_issue("error", "unsafe_path", problem, "path"))
        elif PurePosixPath(path).name != f"{document_id}.md":
            issues.append(
                _issue(
                    "error", "path_id_mismatch", f"Имя файла должно совпадать с ID: {document_id}.md.", "path"
                )
            )
        status = parsed.metadata.get("status")
        if status == DocStatus.deprecated:
            issues.append(
                _issue(
                    "error", "new_document_deprecated", "Новый документ не может быть устаревшим.", "status"
                )
            )
        elif status == DocStatus.approved:
            if origin == "ai_suggestion":
                issues.append(
                    _issue(
                        "error",
                        "ai_cannot_approve",
                        "Черновик от ИИ не может иметь статус approved.",
                        "status",
                    )
                )
            else:
                issues.append(
                    _issue(
                        "warning",
                        "status_to_approved",
                        "Статус approved вступит в силу только после ревью и merge в GitLab.",
                        "status",
                    )
                )
        if template is not None:
            doc_type = parsed.metadata.get("type")
            if doc_type is not None and doc_type != template.doc_type:
                issues.append(
                    _issue(
                        "error", "template_type_mismatch", "Тип документа не совпадает с шаблоном.", "type"
                    )
                )
            missing = missing_sections(template, parsed.body)
            if missing:
                issues.append(
                    _issue(
                        "warning",
                        "template_section_missing",
                        f"Нет разделов шаблона: {', '.join(missing)}.",
                    )
                )
        placeholders = placeholder_count(parsed.body)
        if placeholders:
            issues.append(
                _issue(
                    "warning",
                    "unresolved_placeholders",
                    f"Осталось мест с пометкой «{PLACEHOLDER}»: {placeholders}.",
                )
            )

        try:
            snapshot = await (self._knowledge.refresh() if fresh else self._knowledge.snapshot(user))
        except RepositoryUnavailableError as exc:
            raise ApiError(
                503, exc.code, f"Не удалось проверить уникальность ID и пути: {exc.message}"
            ) from exc
        unresolved = [r for r in parsed.metadata.get("related_ids", []) if snapshot.get(r) is None]
        if unresolved:
            issues.append(
                _issue(
                    "warning",
                    "unresolved_related",
                    f"Связанные документы не найдены в базе знаний: {', '.join(unresolved)}.",
                    "related_ids",
                )
            )
        id_available = path_available = True
        existing = snapshot.get(document_id) if is_valid_document_id(document_id) else None
        if existing is not None or document_id.lower() in snapshot.duplicates:
            id_available = False
            issues.append(
                _issue(
                    "error", "document_id_taken", f"Документ с ID {document_id} уже есть в базе знаний.", "id"
                )
            )
        known_paths = {d.path.lower() for d in snapshot.documents.values()} | {
            i.path.lower() for i in snapshot.issues
        }
        path_in_source = path.lower() in known_paths
        if not path_in_source and fresh and not problem:
            try:
                path_in_source = await self._repository.file_exists(path)
            except RepositoryUnavailableError as exc:
                raise ApiError(503, exc.code, f"Не удалось проверить путь файла: {exc.message}") from exc
        if path_in_source:
            path_available = False
            issues.append(_issue("error", "document_path_taken", f"Файл {path} уже существует.", "path"))
        for other in self._store.open_create_conflicts(document_id, path, exclude_proposal_id):
            if other["document_id"].lower() == document_id.lower() and id_available:
                id_available = False
                issues.append(
                    _issue(
                        "error",
                        "document_id_taken",
                        f"ID {document_id} уже занят незавершённым предложением «{other['reason'][:80]}».",
                        "id",
                    )
                )
            if other["document_path"].lower() == path.lower() and path_available:
                path_available = False
                issues.append(
                    _issue(
                        "error",
                        "document_path_taken",
                        f"Путь {path} уже занят незавершённым предложением «{other['reason'][:80]}».",
                        "path",
                    )
                )
        return NewDocumentCheck(
            content=content,
            path=path,
            issues=issues,
            id_available=id_available,
            path_available=path_available,
        )

    async def check(
        self,
        user: UserContext,
        template_id: str,
        metadata: NewDocumentMetadata,
        body: str,
        path: str | None,
        origin: str,
        exclude_proposal_id: str | None,
    ) -> AuthoringCheckResponse:
        result = await self.check_new_document(
            user, template_id, metadata, body, path, origin, exclude_proposal_id=exclude_proposal_id
        )
        return AuthoringCheckResponse(
            content=result.content,
            path=result.path,
            validation=result.issues,
            preview_html=render_html(body),
            id_available=result.id_available,
            path_available=result.path_available,
            error_count=len(result.errors),
            warning_count=sum(1 for i in result.issues if i.severity == "warning"),
        )

    # --- AI-assisted authoring --------------------------------------------------------------------
    async def ai_draft(self, user: UserContext, req: AiDraftRequest) -> AiDraftResponse:
        template = self.template(req.template_id)
        if self._ai.mode == "disabled" or not self._ai.supports_authoring:
            raise ApiError(503, "ai_authoring_unavailable", "AI-помощник для создания документов отключён.")
        try:
            snapshot = await self._knowledge.snapshot(user)
        except RepositoryUnavailableError as exc:
            raise ApiError(503, exc.code, f"Источник знаний недоступен: {exc.message}") from exc
        warnings: list[str] = []
        # Evidence comes only from APPROVED team documents the user can read (scope "team");
        # corporate sources are not mixed into authoring drafts.
        chosen: list[str] = []
        for doc_id in req.related_ids:
            doc = snapshot.get(doc_id) if is_valid_document_id(doc_id) else None
            if doc is None:
                warnings.append(f"Связанный документ {doc_id} не найден и не использован.")
            elif doc.status != DocStatus.approved:
                warnings.append(f"Документ {doc.id} не утверждён и не используется как источник.")
            elif doc.id not in chosen:
                chosen.append(doc.id)
        terms = analyze_query(f"{req.title} {req.request}")
        filters = SearchFilters(statuses=frozenset({DocStatus.approved.value}))
        for chunk in self._knowledge.search_provider.search_chunks(terms, filters, MAX_REFERENCES * 4):
            doc = snapshot.get(chunk.document_id)
            if doc is not None and doc.id not in chosen and len(chosen) < MAX_REFERENCES:
                chosen.append(doc.id)
        references: list[AuthoringReference] = []
        for doc_id in chosen:
            doc = snapshot.get(doc_id)
            if doc is None:
                continue
            sections = tuple(
                (s.heading, prepare_passage_text(s.text[:MAX_REFERENCE_SECTION_CHARS])[0])
                for s in doc.sections
                if s.text.strip()
            )
            references.append(
                AuthoringReference(
                    document_id=doc.id,
                    title=doc.title,
                    revision=doc.revision,
                    status=doc.status,
                    source_type=doc.source,
                    sections=sections,
                    is_demo=doc.is_demo,
                )
            )
        request = AuthoringRequest(
            request=req.request.strip(),
            template_id=template.id,
            doc_type=template.doc_type,
            title=req.title.strip(),
            sections=template_hints(template),
            references=tuple(references),
            access_scope="team",
        )
        try:
            draft = await self._ai.draft_document(request)
        except AIProviderError as exc:
            status = 503 if exc.code in ("assistant_disabled", "ai_misconfigured") else 502
            raise ApiError(status, exc.code, exc.message) from exc
        by_id = {r.document_id: r for r in references}
        citations: list[AuthoringCitationInfo] = []
        for citation in draft.citations:
            ref = by_id.get(citation.document_id)
            doc = snapshot.get(citation.document_id) if ref else None
            source_text = "\n".join(s.text for s in doc.sections) if doc else ""
            if ref is None or doc is None or not quote_is_verbatim(citation.quote, source_text):
                warnings.append(
                    f"Выдержка, приписанная {citation.document_id}, не найдена в источнике дословно и исключена."
                )
                continue
            citations.append(
                AuthoringCitationInfo(
                    document_id=doc.id,
                    title=doc.title,
                    revision=doc.revision,
                    status=doc.status,
                    section=citation.section,
                    quote=citation.quote,
                )
            )
        logger.info(
            "ai draft template=%s mode=%s references=%d citations=%d",
            template.id,
            self._ai.mode,
            len(references),
            len(citations),
        )
        return AiDraftResponse(
            mode=self._ai.mode,
            body=draft.body,
            references=[
                AuthoringReferenceInfo(
                    document_id=r.document_id,
                    title=r.title,
                    revision=r.revision,
                    status=r.status,
                    source=r.source_type,
                    is_demo=r.is_demo,
                )
                for r in references
            ],
            citations=citations,
            unverified_claims=draft.unverified_claims,
            warnings=[*draft.warnings, *warnings],
            insufficient_data=draft.insufficient_data,
            suggested_related_ids=[i for i in draft.suggested_related_ids if i in by_id],
            access_scope=request.access_scope,
        )
