"""Template Studio: create, edit, check, version and activate templates in the app (docs/TEMPLATE_HUB.md).

    editor (spec) ─ check ─▶ validate_spec (field-bound issues, preview of a new document, activation outcome)
                  ─ save  ─▶ TemplateRegistry.studio_* (draft; optimistic lock; event with author + time)
                  ─ activate (separate right, confirmation) ─▶ a new version / catalogue text in place / a rollback
    «Создать с помощью AI» ─▶ AiWorkflowService (`draft_template` proposal) ─▶ edited in the editor ─▶ saved as draft

The registry stays the only store of templates; this service holds no state of its own. Nothing here touches
documents: they keep their pinned `template_version` and are validated against it.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.adapters.ai.base import (
    AIProvider,
    AIProviderError,
    TemplateCatalogueEntry,
    TemplateDraftingAIProvider,
    TemplateDraftRequest,
    ai_error_status,
)
from app.adapters.ai.template_protocol import parse_template_reply
from app.authz import Action, AuthorizationPolicy
from app.domain.markdown import render_html
from app.domain.models import DocStatus, DocType, UserContext
from app.domain.template_registry import StudioConflictError, StudioRecord, TemplateRegistry
from app.domain.template_studio import (
    MAX_SECTIONS,
    RESERVED_TEMPLATE_IDS,
    SectionSpec,
    StudioIssue,
    TemplateSpec,
    changed_fields,
    has_errors,
    loose_template,
    render_template_source,
    spec_from_template,
    template_from_spec,
    validate_spec,
)
from app.domain.templates import (
    ID_PREFIX_RE,
    METADATA_FIELDS,
    TEMPLATE_ID_RE,
    DocumentTemplate,
    TemplateError,
    compose_document,
)
from app.errors import ApiError
from app.services.ai_workflows import AiWorkflowService, DraftedTemplate, ProposalItem
from app.services.knowledge import KnowledgeService
from app.services.template_hub import TemplateComparison, TemplateSection, compare_templates

ActivationOutcome = Literal["new_template", "new_version", "info_update", "reactivate", "no_change"]
PREVIEW_TITLE = "Новый документ"
SIMILARITY_THRESHOLD = 0.34
AI_UNAVAILABLE_MOCK = "Без языковой модели структуру шаблона не предложить: нужен подключённый AI-провайдер."
AI_UNAVAILABLE_DISABLED = "ИИ отключён в этой установке."
_TRANSLIT = str.maketrans(
    {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i",
        "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
        "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "",
        "э": "e", "ю": "yu", "я": "ya",
    }
)  # fmt: skip


# --- API models -------------------------------------------------------------------------------------------------
class StudioPermissions(BaseModel):
    view: bool
    create: bool
    edit: bool
    activate: bool


class StudioAi(BaseModel):
    available: bool
    mode: str
    reason: str | None = None  # one line when unavailable (mock: no language model; disabled: AI off)


class StudioOptions(BaseModel):
    doc_types: list[str]
    metadata_fields: list[str]
    statuses: list[str]
    reserved_ids: list[str]
    prefixes: dict[str, str]  # ID prefix → template id of the active templates (a new prefix must be free)
    template_id_pattern: str
    id_prefix_pattern: str
    max_sections: int
    permissions: StudioPermissions
    ai: StudioAi
    defaults: TemplateSpec  # a starting point for «Создать шаблон»


class StudioPreview(BaseModel):
    """The new document a person would get from this template (the ID is only a sample)."""

    document_id: str
    markdown: str
    html: str
    sections: list[TemplateSection]


class StudioCheck(BaseModel):
    valid: bool
    issues: list[StudioIssue]
    activation: ActivationOutcome
    next_version: int  # the version that will be current after «Активировать»
    schema_changed: bool
    changed_fields: list[str]
    source: str  # the template file this spec stands for
    preview: StudioPreview


class StudioVersion(BaseModel):
    version: int
    status: str
    current: bool
    source: Literal["shipped", "studio"]
    first_seen: str
    changes: str
    breaking: bool
    activated_by: str | None = None
    activated_at: str | None = None
    documents: int  # visible documents pinned to this version


class StudioEventInfo(BaseModel):
    at: str
    actor: str
    action: str
    version: int | None
    revision: int
    summary: str


class StudioDraft(BaseModel):
    spec: TemplateSpec
    base_version: int | None
    saved_by: str
    saved_at: str
    check: StudioCheck


class StudioState(BaseModel):
    template_id: str
    kind: Literal["shipped", "created", "adopted"]
    revision: int  # name it as `expected_revision` in every write
    current_version: int | None  # None: a new template that was never activated
    current: TemplateSpec | None
    draft: StudioDraft | None
    versions: list[StudioVersion]
    events: list[StudioEventInfo]
    shipped_version: int | None  # the version in the release files (shipped / adopted templates)
    shipped_update: (
        int | None
    )  # a shipped version that is neither current nor acknowledged (a conflict to resolve)
    updated_by: str | None
    updated_at: str | None
    ai_proposal_id: str | None


class StudioValidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec: TemplateSpec
    template_id: str | None = Field(default=None, max_length=60)  # the template being edited; None: a new one


class StudioCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec: TemplateSpec
    ai_proposal_id: str | None = Field(default=None, pattern=r"^AIP-[0-9a-f]{16}$")


class StudioDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec: TemplateSpec
    expected_revision: int = Field(ge=0)


class StudioRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=0)


class StudioActivateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=0)
    version: int | None = Field(default=None, ge=1, le=1000)  # None: the open draft; N: an existing version


class StudioSaveResult(BaseModel):
    state: StudioState
    check: StudioCheck


class StudioActivation(BaseModel):
    action: Literal["info_updated", "reactivated", "activated"]
    version: int
    state: StudioState


def _today() -> str:
    return datetime.now(UTC).date().isoformat()


def _conflict(exc: StudioConflictError) -> ApiError:
    status = 404 if exc.code in ("template_not_found", "template_version_not_found") else 409
    details = {"current_revision": exc.current_revision} if exc.current_revision is not None else {}
    return ApiError(status, exc.code, exc.message, details)


def _invalid(issues: list[StudioIssue], message: str) -> ApiError:
    return ApiError(422, "template_invalid", message, {"issues": [i.model_dump() for i in issues]})


def slug(text: str) -> str:
    """A template id candidate from a title (Russian is transliterated)."""
    value = re.sub(r"[^a-z0-9]+", "_", text.casefold().translate(_TRANSLIT)).strip("_")
    value = re.sub(r"^[^a-z]+", "", value)[:36].strip("_")
    return value if len(value) >= 2 else "template"


class TemplateStudioService:
    def __init__(
        self,
        *,
        registry: TemplateRegistry,
        knowledge: KnowledgeService,
        ai: AIProvider,
        workflows: AiWorkflowService,
        policy: AuthorizationPolicy,
    ) -> None:
        self._registry = registry
        self._knowledge = knowledge
        self._ai = ai
        self._workflows = workflows
        self._policy = policy
        workflows.attach_template_drafter(self.draft_with_ai)

    # --- reading ------------------------------------------------------------------------------------------------
    def permissions(self, user: UserContext) -> StudioPermissions:
        allows = self._policy.allows
        return StudioPermissions(
            view=allows(user, Action.view_templates),
            create=allows(user, Action.create_template),
            edit=allows(user, Action.edit_template),
            activate=allows(user, Action.activate_template),
        )

    def ai_availability(self) -> StudioAi:
        mode = self._ai.mode
        if mode == "disabled":
            return StudioAi(available=False, mode=mode, reason=AI_UNAVAILABLE_DISABLED)
        if not getattr(self._ai, "supports_template_drafting", False):
            return StudioAi(available=False, mode=mode, reason=AI_UNAVAILABLE_MOCK)
        return StudioAi(available=True, mode=mode)

    def _prefixes(self, exclude: str | None = None) -> dict[str, str]:
        """ID prefixes of the active templates and of the studio drafts of new templates (both allocate IDs soon)."""
        result = {t.id_prefix.upper(): t.id for t in self._registry.active().values() if t.id != exclude}
        for tid, record in self._registry.studio_records().items():
            if tid != exclude and record.active_version is None and record.draft_json:
                prefix = TemplateSpec.model_validate_json(record.draft_json).id_prefix.strip().upper()
                if prefix:
                    result.setdefault(prefix, tid)
        return result

    def options(self, user: UserContext) -> StudioOptions:
        return StudioOptions(
            doc_types=[t.value for t in DocType],
            metadata_fields=sorted(METADATA_FIELDS),
            statuses=["active", "deprecated", "archived"],
            reserved_ids=sorted(RESERVED_TEMPLATE_IDS),
            prefixes=self._prefixes(),
            template_id_pattern=TEMPLATE_ID_RE.pattern,
            id_prefix_pattern=ID_PREFIX_RE.pattern,
            max_sections=MAX_SECTIONS,
            permissions=self.permissions(user),
            ai=self.ai_availability(),
            defaults=TemplateSpec(
                doc_type=DocType.guide.value,
                sections=[SectionSpec(title="Назначение", required=True, hint="зачем нужен документ")],
            ),
        )

    def _outcome(
        self, template_id: str | None, spec: TemplateSpec
    ) -> tuple[ActivationOutcome, int, bool, list[str]]:
        record = self._registry.studio_record(template_id) if template_id else None
        current = self._registry.get(template_id) if template_id else None
        if current is None or (record is not None and record.active_version is None):
            return "new_template", 1, True, []
        candidate = loose_template(spec, version=current.version)
        fields = changed_fields(spec_from_template(current), spec)
        if candidate.checksum == current.checksum:
            return ("info_update" if fields else "no_change"), current.version, False, fields
        versions = self._registry.versions(current.id)
        same = next((v.version for v in versions if v.checksum == candidate.checksum), None)
        if same is not None:
            return "reactivate", same, True, fields
        return "new_version", max((v.version for v in versions), default=0) + 1, True, fields

    def check(self, spec: TemplateSpec, template_id: str | None = None) -> StudioCheck:
        """«Проверить»: field-bound issues, what «Активировать» would do, the source and a new document's preview."""
        creating = template_id is None
        issues = validate_spec(
            spec,
            creating=creating,
            taken_ids=self._registry.known_ids() if creating else set(),
            prefixes=self._prefixes(exclude=template_id or spec.template_id.strip()),
        )
        if template_id is not None and spec.template_id.strip() != template_id:
            issues.insert(
                0,
                StudioIssue(
                    field="template_id",
                    code="template_id_changed",
                    message=f"ID шаблона не меняется: «{template_id}». Чтобы получить другой ID, создайте новый шаблон.",
                ),
            )
        activation, next_version, schema_changed, fields = self._outcome(template_id, spec)
        current = self._registry.get(template_id) if template_id else None
        order, listed = (current.order, current.listed) if current else (100, True)
        source = render_template_source(
            spec, version=next_version, order=order, listed=listed, updated=_today()
        )
        return StudioCheck(
            valid=not has_errors(issues),
            issues=issues,
            activation=activation,
            next_version=next_version,
            schema_changed=schema_changed,
            changed_fields=fields,
            source=source,
            preview=self._preview(spec, next_version),
        )

    @staticmethod
    def _preview(spec: TemplateSpec, version: int) -> StudioPreview:
        template = loose_template(spec, version=version)
        prefix = template.id_prefix if ID_PREFIX_RE.fullmatch(template.id_prefix) else "SEM-NEW"
        document_id = f"{prefix}-001"
        body = template.skeleton(PREVIEW_TITLE) if spec.sections else f"# {PREVIEW_TITLE}\n"
        markdown = compose_document(
            {
                "id": document_id,
                "title": PREVIEW_TITLE,
                "type": template.doc_type,
                "status": DocStatus.draft,
                "owner": "unassigned",
                "tags": list(template.default_tags),
                "template": template.id,
                "template_version": version,
            },
            body,
        )
        optional = set(template.optional_sections)
        return StudioPreview(
            document_id=document_id,
            markdown=markdown,
            html=render_html(body),
            sections=[
                TemplateSection(title=s.title.strip(), required=s.title.strip() not in optional, hint=s.hint)
                for s in spec.sections
                if s.title.strip()
            ],
        )

    async def state(self, user: UserContext, template_id: str) -> StudioState:
        record = self._registry.studio_record(template_id)
        current = self._registry.get(template_id)
        if current is None and (record is None or record.draft_json is None):
            raise ApiError(404, "template_not_found", "Шаблон не найден.")
        return await self._state(user, template_id, record, current)

    async def _state(
        self,
        user: UserContext,
        template_id: str,
        record: StudioRecord | None,
        current: DocumentTemplate | None,
    ) -> StudioState:
        events = self._registry.studio_events(template_id)
        snapshot = await self._knowledge.snapshot(user)
        pinned: Counter[int] = Counter(
            d.template_version or 1 for d in snapshot.documents.values() if d.template_id == template_id
        )
        activations: dict[int, StudioEventInfo] = {}
        for event in reversed(events):  # oldest first: the latest activation of a version wins
            if event.action in ("activated", "reactivated", "info_updated") and event.version is not None:
                activations[event.version] = StudioEventInfo(**event.__dict__)
        versions = []
        for info in self._registry.versions(template_id):
            stored = self._registry.get(template_id, info.version)
            activated = activations.get(info.version)
            versions.append(
                StudioVersion(
                    version=info.version,
                    status=stored.status if stored else "active",
                    current=current is not None and current.version == info.version,
                    source="studio" if info.origin == "studio" else "shipped",
                    first_seen=info.first_seen,
                    changes=stored.changes if stored else "",
                    breaking=stored.breaking if stored else False,
                    activated_by=activated.actor if activated else None,
                    activated_at=activated.at if activated else None,
                    documents=pinned.get(info.version, 0),
                )
            )
        draft = None
        if record is not None and record.draft_json is not None:
            spec = TemplateSpec.model_validate_json(record.draft_json)
            draft = StudioDraft(
                spec=spec,
                base_version=record.draft_base_version,
                saved_by=record.draft_by or record.updated_by,
                saved_at=record.draft_at or record.updated_at,
                check=self.check(spec, template_id),
            )
        shipped = self._registry.shipped(template_id)
        kind: Literal["shipped", "created", "adopted"] = (
            "shipped" if record is None else "created" if record.kind == "created" else "adopted"
        )
        return StudioState(
            template_id=template_id,
            kind=kind,
            revision=record.revision if record else 0,
            current_version=current.version if current else None,
            current=spec_from_template(current) if current else None,
            draft=draft,
            versions=versions,
            events=[StudioEventInfo(**e.__dict__) for e in events],
            shipped_version=shipped.version if shipped else None,
            shipped_update=self._registry.shipped_update(template_id),
            updated_by=record.updated_by if record else None,
            updated_at=record.updated_at if record else None,
            ai_proposal_id=record.ai_proposal_id if record else None,
        )

    def compare(self, template_id: str, from_version: int, to: int | Literal["draft"]) -> TemplateComparison:
        old = self._registry.get(template_id, from_version)
        new: DocumentTemplate | None
        if to == "draft":
            record = self._registry.studio_record(template_id)
            if record is None or record.draft_json is None:
                raise ApiError(404, "template_draft_missing", "Открытого черновика нет.")
            spec = TemplateSpec.model_validate_json(record.draft_json)
            outcome = self._outcome(template_id, spec)
            current = self._registry.get(template_id)
            new = loose_template(  # what «Активировать» would store: same order/listing, today's date
                spec,
                version=outcome[1],
                order=current.order if current else 100,
                listed=current.listed if current else True,
                updated=_today(),
            )
        else:
            new = self._registry.get(template_id, to)
        if old is None or new is None:
            raise ApiError(404, "template_version_not_found", "Такой версии шаблона нет.")
        return compare_templates(old, new, to_draft=to == "draft")

    # --- writing ------------------------------------------------------------------------------------------------
    async def create(
        self, user: UserContext, spec: TemplateSpec, ai_proposal_id: str | None = None
    ) -> StudioSaveResult:
        """A new template = its first draft. Not offered to documents until it is activated."""
        check = self.check(spec)
        blocking = [i for i in check.issues if i.field == "template_id" and i.severity == "error"]
        if blocking:
            raise _invalid(blocking, blocking[0].message)
        if ai_proposal_id:
            self._workflows.open_template_proposal(user, ai_proposal_id)
        template_id = spec.template_id.strip()
        try:
            record = self._registry.studio_create(
                template_id, spec.model_dump_json(), actor=user.user_id, ai_proposal_id=ai_proposal_id
            )
        except StudioConflictError as exc:
            raise _conflict(exc) from exc
        if ai_proposal_id:
            self._workflows.settle_template_proposal(user, ai_proposal_id, template_id)
        return StudioSaveResult(state=await self._state(user, template_id, record, None), check=check)

    async def save_draft(
        self, user: UserContext, template_id: str, spec: TemplateSpec, expected_revision: int
    ) -> StudioSaveResult:
        """«Сохранить черновик»: the current version stays current. A draft may still have errors (they are
        returned and shown next to the fields); only activation requires a clean check."""
        if self._registry.get(template_id) is None and self._registry.studio_record(template_id) is None:
            raise ApiError(404, "template_not_found", "Шаблон не найден.")
        check = self.check(spec, template_id)
        blocking = [i for i in check.issues if i.code == "template_id_changed"]
        if blocking:
            raise _invalid(blocking, blocking[0].message)
        summary = {
            "new_template": "Черновик нового шаблона сохранён",
            "new_version": f"Черновик сохранён: при активации будет v{check.next_version}",
            "reactivate": f"Черновик сохранён: структура совпадает с v{check.next_version}",
            "info_update": f"Черновик сохранён: только информационные поля v{check.next_version}",
            "no_change": "Черновик сохранён без изменений",
        }[check.activation]
        try:
            record = self._registry.studio_save_draft(
                template_id,
                spec.model_dump_json(),
                expected_revision=expected_revision,
                actor=user.user_id,
                summary=summary,
            )
        except StudioConflictError as exc:
            raise _conflict(exc) from exc
        state = await self._state(user, template_id, record, self._registry.get(template_id))
        return StudioSaveResult(state=state, check=check)

    async def discard_draft(
        self, user: UserContext, template_id: str, expected_revision: int
    ) -> StudioState | None:
        try:
            record = self._registry.studio_discard_draft(
                template_id, expected_revision=expected_revision, actor=user.user_id
            )
        except StudioConflictError as exc:
            raise _conflict(exc) from exc
        if record is None:
            return None  # a never-activated template is gone with its draft
        return await self._state(user, template_id, record, self._registry.get(template_id))

    async def activate(
        self, user: UserContext, template_id: str, expected_revision: int, version: int | None = None
    ) -> StudioActivation:
        """«Активировать» (a separate right, confirmed in the UI). The draft must pass the check; documents and
        drafts keep the version they are pinned to."""
        try:
            if version is not None:
                record = self._registry.studio_activate_version(
                    template_id, version, expected_revision=expected_revision, actor=user.user_id
                )
                state = await self._state(user, template_id, record, self._registry.get(template_id))
                return StudioActivation(action="reactivated", version=version, state=state)
            record_now = self._registry.studio_record(template_id)
            if record_now is None or record_now.draft_json is None:
                if self._registry.get(template_id) is None:
                    raise ApiError(404, "template_not_found", "Шаблон не найден.")
                raise ApiError(
                    409, "template_draft_missing", "Открытого черновика нет: сначала сохраните черновик."
                )
            if (
                record_now.revision != expected_revision
            ):  # stale editor: say so before checking someone else's draft
                raise StudioConflictError(
                    "template_conflict",
                    f"Шаблон уже изменён: {record_now.updated_by}, {record_now.updated_at} (ревизия "
                    f"{record_now.revision}, у вас {expected_revision}). Обновите редактор.",
                    record_now.revision,
                )
            spec = TemplateSpec.model_validate_json(record_now.draft_json)
            check = self.check(spec, template_id)
            if not check.valid:
                raise _invalid(check.issues, "Черновик не прошёл проверку: исправьте ошибки и сохраните его.")
            current = self._registry.get(template_id)
            try:
                candidate = template_from_spec(
                    spec,
                    version=check.next_version,
                    order=current.order if current else 100,
                    listed=current.listed if current else True,
                    updated=_today(),
                )
            except TemplateError as exc:
                issue = StudioIssue(field="source", code="template_invalid", message=str(exc))
                raise _invalid([issue], str(exc)) from exc
            action, activated = self._registry.studio_activate_draft(
                template_id, candidate, expected_revision=expected_revision, actor=user.user_id
            )
        except StudioConflictError as exc:
            raise _conflict(exc) from exc
        state = await self._state(
            user, template_id, self._registry.studio_record(template_id), self._registry.get(template_id)
        )
        return StudioActivation(action=action, version=activated, state=state)

    async def acknowledge_shipped(
        self, user: UserContext, template_id: str, expected_revision: int
    ) -> StudioState:
        try:
            record = self._registry.studio_acknowledge_shipped(
                template_id, expected_revision=expected_revision, actor=user.user_id
            )
        except StudioConflictError as exc:
            raise _conflict(exc) from exc
        return await self._state(user, template_id, record, self._registry.get(template_id))

    # --- «Создать с помощью AI» ------------------------------------------------------------------------------------
    def _catalogue(self) -> list[DocumentTemplate]:
        return [t for t in self._registry.active().values() if t.listed and t.status == "active"]

    @staticmethod
    def similar(
        spec: TemplateSpec, templates: list[DocumentTemplate]
    ) -> list[tuple[DocumentTemplate, float, str]]:
        """Deterministic overlap with existing templates (section titles, document type, title words) — the duplicate
        warning does not depend on what the model claims."""
        mine = {s.title.strip().casefold() for s in spec.sections if s.title.strip()}
        words = {w for w in re.findall(r"\w{4,}", spec.title.casefold())}
        result = []
        for template in templates:
            theirs = {s.casefold() for s in (*template.sections, *template.optional_sections)}
            common = sorted(mine & theirs)
            overlap = len(common) / max(1, len(mine | theirs))
            same_type = template.doc_type.value == spec.doc_type
            title_hit = bool(words & set(re.findall(r"\w{4,}", template.title.casefold())))
            score = round(overlap + (0.15 if same_type else 0.0) + (0.1 if title_hit else 0.0), 2)
            if score >= SIMILARITY_THRESHOLD:
                reasons = []
                if common:
                    reasons.append(f"совпадают разделы: {', '.join(common[:4])}")
                if same_type:
                    reasons.append("тот же тип документа")
                if title_hit:
                    reasons.append("похожее название")
                result.append((template, score, "; ".join(reasons)))
        return sorted(result, key=lambda item: -item[1])[:3]

    def _normalize(self, raw: dict[str, Any], warnings: list[str]) -> TemplateSpec:
        """A model's proposal → a spec the editor can open: values the backend cannot accept are replaced by safe
        ones WITH a warning (never silently), so the person sees what to fix."""
        data = {k: v for k, v in raw.items() if k in TemplateSpec.model_fields and k != "sections"}
        sections = []
        seen: set[str] = set()
        for item in raw.get("sections") or []:
            title = str(item["title"])
            if title.casefold() in seen:
                continue
            seen.add(title.casefold())
            sections.append(SectionSpec(title=title, required=bool(item["required"]), hint=str(item["hint"])))
        doc_type = str(data.get("doc_type") or "")
        if doc_type not in DocType._value2member_map_:
            warnings.append(f"Тип документа «{doc_type or '—'}» неизвестен: выбран «guide» — проверьте тип.")
            data["doc_type"] = DocType.guide.value
        asked_required: list[str] = list(data.get("required_metadata") or [])
        asked_optional: list[str] = list(data.get("optional_metadata") or [])
        required = [f for f in asked_required if f in METADATA_FIELDS]
        optional = [f for f in asked_optional if f in METADATA_FIELDS and f not in required]
        dropped = [f for f in [*asked_required, *asked_optional] if f not in METADATA_FIELDS]
        if dropped:
            warnings.append(
                f"Поля, которых нет в схеме документа, убраны: {', '.join(map(str, dropped[:5]))}."
            )
        required = ["title", *[f for f in required if f != "title"]]
        if "owner" not in required and "owner" not in optional:
            required.append("owner")
        data["required_metadata"], data["optional_metadata"] = required, optional
        taken = self._registry.known_ids()
        candidate = str(data.get("template_id") or "")
        base = candidate if TEMPLATE_ID_RE.fullmatch(candidate) else slug(str(data.get("title") or ""))
        template_id, n = base, 2
        while template_id in taken or template_id in RESERVED_TEMPLATE_IDS:
            template_id, n = f"{base[:36]}_{n}", n + 1
        if candidate and candidate != template_id:
            warnings.append(f"ID «{candidate}» занят или недопустим: предложен «{template_id}».")
        data["template_id"] = template_id
        prefixes = self._prefixes()
        prefix = str(data.get("id_prefix") or "").upper()
        if not ID_PREFIX_RE.fullmatch(prefix) or prefix in prefixes or prefix == "SEM-DOC":
            stem = re.sub(r"[^A-Z0-9]", "", template_id.upper())[:6] or "TPL"
            fixed, n = f"SEM-{stem}", 2
            while fixed in prefixes:
                fixed, n = f"SEM-{stem}{n}", n + 1
            if prefix:
                warnings.append(f"Префикс ID «{prefix}» занят или недопустим: предложен «{fixed}».")
            prefix = fixed
        data["id_prefix"] = prefix
        return TemplateSpec.model_validate({**data, "sections": sections, "status": "active"})

    async def draft_with_ai(self, user: UserContext, prompt: str) -> DraftedTemplate:
        """The `draft_template` proposal (called by AiWorkflowService, which stores and audits it)."""
        availability = self.ai_availability()
        if not availability.available:
            raise ApiError(503, "ai_template_unavailable", availability.reason or AI_UNAVAILABLE_MOCK)
        provider: TemplateDraftingAIProvider = self._ai  # type: ignore[assignment]
        catalogue = self._catalogue()
        request = TemplateDraftRequest(
            request=prompt,
            catalogue=tuple(
                TemplateCatalogueEntry(
                    template_id=t.id,
                    title=t.title,
                    doc_type=t.doc_type.value,
                    category=t.category,
                    description=t.description,
                    sections=(*t.sections, *t.optional_sections),
                )
                for t in catalogue
            ),
            doc_types=tuple(t.value for t in DocType),
            metadata_fields=tuple(sorted(METADATA_FIELDS)),
        )
        try:
            reply = parse_template_reply(await provider.draft_template(request))
        except AIProviderError as exc:
            raise ApiError(ai_error_status(exc.code), exc.code, exc.message) from exc
        warnings = list(reply.warnings)
        spec = self._normalize(reply.template, warnings)
        by_id = {t.id: t for t in catalogue}
        similar = self.similar(spec, catalogue)
        similar_ids = {t.id for t, _, _ in similar}
        for (
            template_id,
            reason,
        ) in reply.similar_to:  # the model's claims count only for real catalogue entries
            known = by_id.get(template_id)
            if known is not None and template_id not in similar_ids:
                similar.append((known, 0.0, reason or "так считает модель"))
        for template, _, reason in similar:
            warnings.append(f"Похоже на существующий шаблон «{template.title}» ({template.id}): {reason}.")
        required = sum(1 for s in spec.sections if s.required)
        items = [
            ProposalItem(
                id="template",
                kind="template",
                proposed=spec.model_dump(),
                reason=(
                    f"разделов {len(spec.sections)} (обязательных {required}), правил проверки "
                    f"{len(spec.validation)}; откройте в редакторе, исправьте и сохраните черновик"
                ),
            )
        ]
        if similar:
            items.append(
                ProposalItem(
                    id="similar",
                    kind="note",
                    current=[
                        {"template_id": t.id, "title": t.title, "score": score, "reason": reason}
                        for t, score, reason in similar
                    ],
                    reason="похожие шаблоны уже есть в каталоге — возможно, лучше доработать их",
                    applicable=False,
                )
            )
        summary = (
            f"Предложен шаблон «{spec.title or spec.template_id}»: разделов {len(spec.sections)}, обязательных "
            f"{required}, правил проверки {len(spec.validation)}. Шаблон появится только после «Сохранить черновик» "
            "в редакторе; активация — отдельный шаг."
        )
        return DraftedTemplate(summary=summary, items=items, warnings=warnings)
