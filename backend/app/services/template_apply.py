"""«Применить шаблон» (docs/TEMPLATE_HUB.md): give an existing draft or document the structure of an ACTIVE template.

Preview first (nothing is stored), then a guarded confirm:

- a `create` draft (e.g. a blank document or an import): the template is pinned and the text updated in place,
  guarded by `expected_version` (the draft's `edit_version`), like every other draft save;
- an `update` draft: its proposed text is updated through the usual draft save (same guard);
- an indexed document (approved or not): a CHANGE PROPOSAL is created with the document's revision as its base — the
  document itself never changes here; it changes only after review and merge.

The template version shown in the preview must still be the active one at confirm (else `409
template_version_changed`): a pinned version is never switched silently. The body only gains lines (skeletons of
missing required sections) — see `app/domain/template_apply.py` for the matching rules.
"""

from __future__ import annotations

import json
import logging

from app.adapters.knowledge.base import (
    DocumentNotFoundError,
    DuplicateDocumentIdError,
    KnowledgeRepository,
    RepositoryUnavailableError,
)
from app.domain.models import DocType, DocumentRecord, UserContext, ValidationIssue
from app.domain.proposals import (
    DocumentTemplateApply,
    DraftCreate,
    DraftTemplateApply,
    DraftUpdate,
    ProposalDetail,
    TemplateApplyPreview,
    TemplateSectionMapping,
)
from app.domain.schema import FrontmatterError, is_valid_document_id
from app.domain.template_apply import AppliedDocument, apply_template_to_content
from app.domain.templates import DocumentTemplate
from app.errors import ApiError
from app.services.authoring import AuthoringService
from app.services.proposals import ProposalService, compute_diff, validate_proposal

logger = logging.getLogger("skh.template_apply")


def _doc_type(value: object) -> DocType | None:
    return DocType(value) if isinstance(value, str) and value in DocType._value2member_map_ else None


def _int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


class TemplateApplyService:
    def __init__(
        self,
        proposals: ProposalService,
        authoring: AuthoringService,
        repository: KnowledgeRepository,
        *,
        max_document_bytes: int | None = None,
    ) -> None:
        self._proposals = proposals
        self._authoring = authoring
        self._repository = repository
        self._max_bytes = max_document_bytes

    # --- helpers -----------------------------------------------------------------------------------------
    def active_template(self, template_id: str) -> DocumentTemplate:
        """Only an active template that is offered for documents (draft / deprecated / archived / hidden: 409)."""
        template = self._authoring.registry.get(template_id)
        if template is None:
            raise ApiError(404, "template_not_found", "Шаблон документа не найден.")
        if not template.listed or template.status != "active":
            raise ApiError(
                409,
                "template_not_active",
                f"Шаблон «{template.title}» ({template.status}) нельзя применить: выберите активный шаблон.",
            )
        return template

    def _confirmed(self, template_id: str, version: int) -> DocumentTemplate:
        template = self.active_template(template_id)
        if template.version != version:
            raise ApiError(
                409,
                "template_version_changed",
                f"Шаблон «{template.title}» обновился до v{template.version} после предпросмотра: "
                "посмотрите изменения ещё раз.",
                {"current_version": str(template.version)},
            )
        return template

    @staticmethod
    def _apply(content: str, template: DocumentTemplate) -> AppliedDocument:
        try:
            return apply_template_to_content(content, template)
        except FrontmatterError as exc:
            raise ApiError(
                422, "template_apply_invalid_document", f"Метаданные документа не разобрать: {exc.message}"
            ) from exc

    async def _document(self, user: UserContext, document_id: str) -> DocumentRecord:
        if not is_valid_document_id(document_id):
            raise ApiError(400, "invalid_document_id", "Некорректный идентификатор документа.")
        try:
            return await self._repository.get_document(document_id, user)
        except DocumentNotFoundError as exc:
            raise ApiError(404, "document_not_found", f"Документ {document_id} не найден.") from exc
        except DuplicateDocumentIdError as exc:
            raise ApiError(
                422, "duplicate_document_id", f"Идентификатор {document_id} неоднозначен: несколько файлов."
            ) from exc
        except RepositoryUnavailableError as exc:
            raise ApiError(503, exc.code, f"Источник знаний недоступен: {exc.message}") from exc

    async def _editable_draft(self, user: UserContext, draft_id: str) -> ProposalDetail:
        draft = await self._proposals.get(user, draft_id)
        if draft.status != "draft":
            raise ApiError(
                409, "draft_not_editable", "Применить шаблон можно только к черновику (до «Готово к ревью»)."
            )
        return draft

    async def _validate(
        self,
        user: UserContext,
        draft: ProposalDetail | None,
        doc: DocumentRecord | None,
        *,
        content: str,
        template: DocumentTemplate,
    ) -> list[ValidationIssue]:
        """Validation of the RESULT: a new document by its new template, a change by the document rules."""
        if draft is not None and draft.operation == "create":
            check = await self._authoring.check_content(
                user,
                template,
                content,
                draft.document_path,
                draft.origin,
                draft.document_id,
                exclude_proposal_id=draft.id,
            )
            return check.issues
        if doc is None:
            raise ApiError(404, "document_not_found", "Документ не найден.")
        base = (
            doc
            if draft is None
            else doc.model_copy(update={"raw": draft.base_content, "path": draft.document_path})
        )
        origin = draft.origin if draft is not None else "manual"
        return validate_proposal(
            base,
            content,
            origin,
            max_bytes=self._max_bytes,
            knowledge_prefix=self._authoring.knowledge_prefix,
        )

    @staticmethod
    def _preview(
        *,
        target: str,
        document_id: str,
        path: str,
        before: str,
        applied: AppliedDocument,
        template: DocumentTemplate,
        validation: list[ValidationIssue],
        draft_id: str | None = None,
        expected_version: int | None = None,
        base_revision: str | None = None,
    ) -> TemplateApplyPreview:
        diff = compute_diff(before, applied.content, path)
        previous_template = applied.previous.get("template")
        return TemplateApplyPreview.model_validate(
            {
                "target": target,
                "document_id": document_id,
                "draft_id": draft_id,
                "expected_version": expected_version,
                "base_revision": base_revision,
                "template_id": template.id,
                "template_version": template.version,
                "template_title": template.title,
                "previous_template_id": previous_template if isinstance(previous_template, str) else None,
                "previous_template_version": _int(applied.previous.get("template_version")),
                "type_before": _doc_type(applied.previous.get("type")),
                "type_after": template.doc_type,
                "sections": [
                    TemplateSectionMapping(
                        heading=s.heading,
                        template_heading=s.template_heading,
                        state=s.state,
                        required=s.required,
                    )
                    for s in applied.sections
                ],
                "content_before": before,
                "content_after": applied.content,
                "diff": diff,
                "changed": diff.changed,
                "validation": validation,
            }
        )

    # --- drafts ------------------------------------------------------------------------------------------
    async def preview_draft(self, user: UserContext, draft_id: str, template_id: str) -> TemplateApplyPreview:
        draft = await self._editable_draft(user, draft_id)
        template = self.active_template(template_id)
        applied = self._apply(draft.proposed_content, template)
        doc = None if draft.operation == "create" else await self._document(user, draft.document_id)
        validation = await self._validate(user, draft, doc, content=applied.content, template=template)
        return self._preview(
            target="draft",
            document_id=draft.document_id,
            path=draft.document_path,
            before=draft.proposed_content,
            applied=applied,
            template=template,
            validation=validation,
            draft_id=draft.id,
            expected_version=draft.edit_version,
        )

    async def apply_to_draft(
        self, user: UserContext, draft_id: str, req: DraftTemplateApply
    ) -> ProposalDetail:
        draft = await self._editable_draft(user, draft_id)
        template = self._confirmed(req.template_id, req.template_version)
        if req.expected_version != draft.edit_version:
            raise ApiError(
                409,
                "draft_modified",
                "Черновик изменён после предпросмотра: шаблон не применён. Посмотрите изменения ещё раз.",
                {"current_version": str(draft.edit_version)},
            )
        applied = self._apply(draft.proposed_content, template)
        if not compute_diff(draft.proposed_content, applied.content, draft.document_path).changed:
            raise ApiError(409, "template_apply_no_change", "Шаблон уже применён: изменений нет.")
        if draft.operation != "create":
            saved = await self._proposals.save_draft(
                user,
                draft.id,
                DraftUpdate(expected_version=req.expected_version, proposed_content=applied.content),
            )
            self._authoring.store.audit(
                user.user_id, "template_applied", draft.id, draft.document_id, None, "draft"
            )
            return saved
        validation = await self._validate(user, draft, None, content=applied.content, template=template)
        diff = compute_diff("", applied.content, draft.document_path)
        if not self._authoring.store.apply_template(
            draft.id,
            req.expected_version,
            template_id=template.id,
            template_version=template.version,
            proposed_content=applied.content,
            validation_json=json.dumps([i.model_dump() for i in validation], ensure_ascii=False),
            additions=diff.additions,
            deletions=diff.deletions,
        ):
            raise ApiError(409, "draft_modified", "Черновик изменился параллельно: шаблон не применён.")
        self._authoring.store.audit(
            user.user_id, "template_applied", draft.id, draft.document_id, None, "draft"
        )
        logger.info("template applied draft=%s template=%s v%d", draft.id, template.id, template.version)
        return await self._proposals.get(user, draft.id)

    # --- indexed documents -------------------------------------------------------------------------------
    async def preview_document(
        self, user: UserContext, document_id: str, template_id: str
    ) -> TemplateApplyPreview:
        doc = await self._document(user, document_id)
        template = self.active_template(template_id)
        applied = self._apply(doc.raw, template)
        validation = await self._validate(user, None, doc, content=applied.content, template=template)
        return self._preview(
            target="document",
            document_id=doc.id,
            path=doc.path,
            before=doc.raw,
            applied=applied,
            template=template,
            validation=validation,
            base_revision=doc.revision,
        )

    async def apply_to_document(
        self, user: UserContext, document_id: str, req: DocumentTemplateApply
    ) -> ProposalDetail:
        """A change proposal (operation `update`, status `draft`); the document is never modified here."""
        doc = await self._document(user, document_id)
        template = self._confirmed(req.template_id, req.template_version)
        if req.base_revision != doc.revision:
            raise ApiError(
                409,
                "revision_conflict",
                "Документ изменился после предпросмотра: шаблон не применён. Посмотрите изменения ещё раз.",
                {"current_revision": doc.revision, "base_revision": req.base_revision},
            )
        applied = self._apply(doc.raw, template)
        if not compute_diff(doc.raw, applied.content, doc.path).changed:
            raise ApiError(409, "template_apply_no_change", "Шаблон уже применён: изменений нет.")
        created = await self._proposals.create(
            user,
            DraftCreate(
                document_id=doc.id,
                base_revision=req.base_revision,
                proposed_content=applied.content,
                reason=req.reason or f"Применить шаблон «{template.title}» v{template.version}",
                origin="manual",
            ),
        )
        self._authoring.store.audit(
            user.user_id, "template_applied", created.id, doc.id, doc.revision, "draft"
        )
        logger.info("template applied document=%s template=%s v%d", doc.id, template.id, template.version)
        return created
