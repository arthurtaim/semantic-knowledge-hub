"""Template Studio (docs/TEMPLATE_HUB.md «Template Studio»): the editable form of a template and its rules.

A template SPEC is what the editor edits: catalogue fields and the schema (sections with required / optional and
hints, metadata fields, validation rules, status). A spec becomes a template through the SAME source format and
parser as a shipped file (`render_template_source` → `parse_template_text`), so a studio version and a file version
obey one set of rules. Pure functions: no storage, no I/O.

Markdown ↔ sections — the editor's two views of one structure (the frontend mirrors this in lib/templateSpec.ts):
- a section is `## Title`, then optionally the placeholder line `> Требует уточнения: hint`, then free content;
- a section with neither hint nor content gets the bare placeholder `> Требует уточнения`;
- text before the first `## ` (and any `# ` heading) cannot be mapped: a document gets `# Title` from its name;
- `render_body(parse_body(body)) == body` for every shipped template, so opening a template and saving it unchanged
  never changes its schema (and never creates a version).
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from app.domain.models import DocType
from app.domain.schema import is_valid_document_id
from app.domain.templates import (
    ID_PREFIX_RE,
    MAX_TEMPLATE_BYTES,
    METADATA_FIELDS,
    PLACEHOLDER,
    TEMPLATE_ID_RE,
    DocumentTemplate,
    TemplateError,
    parse_template_text,
    schema_checksum,
)

# `/templates/new` and `/api/templates/studio/*` are routes: such ids would be unreachable.
RESERVED_TEMPLATE_IDS = frozenset({"new", "studio", "edit"})
BLANK_ID_PREFIX = "SEM-DOC"  # IDs of documents without a template (services/authoring.py)
MAX_SECTIONS = 40
MAX_FRONTMATTER_BYTES = 16 * 1024  # app/domain/schema.py: a larger YAML header is refused by the parser
VersionStatus = Literal["active", "deprecated", "archived"]

_SECTION_LINE = re.compile(r"^##\s+(.+?)\s*$")  # one line of templates._HEADING_RE
_H1_LINE = re.compile(r"^#\s+\S")
_HINT_LINE = re.compile(rf"^> {PLACEHOLDER}:\s?(.*)$")
_BARE_PLACEHOLDER = re.compile(rf"^> {PLACEHOLDER}:?\s*$")
_TAG_RE = re.compile(r"^[^\s,#\[\]{}]{1,40}$")


class SectionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="", max_length=200)
    required: bool = True
    hint: str = Field(default="", max_length=500)
    content: str = Field(default="", max_length=4000)  # free Markdown after the hint (a table, a list)


class TemplateSpec(BaseModel):
    """Everything a person (or an AI proposal) edits. Bounded: an oversized request is a plain 422."""

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(default="", max_length=60)
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=600)
    category: str = Field(default="", max_length=80)
    doc_type: str = Field(default="guide", max_length=40)
    id_prefix: str = Field(default="", max_length=40)
    owner: str = Field(default="", max_length=80)
    labels: list[str] = Field(default_factory=list, max_length=20)
    default_tags: list[str] = Field(default_factory=list, max_length=20)
    sections: list[SectionSpec] = Field(default_factory=list, max_length=MAX_SECTIONS)
    required_metadata: list[str] = Field(default_factory=lambda: ["title", "owner"], max_length=12)
    optional_metadata: list[str] = Field(default_factory=list, max_length=12)
    validation: list[str] = Field(default_factory=list, max_length=30)
    instructions: str = Field(default="", max_length=2000)
    ai_guidance: str = Field(default="", max_length=2000)
    example: str = Field(default="", max_length=3000)
    changes: str = Field(default="", max_length=800)
    breaking: bool = False
    migration: str = Field(default="", max_length=1500)
    status: VersionStatus = "active"


class StudioIssue(BaseModel):
    """A validation finding bound to a field of the spec (`sections.2.title`, `id_prefix`, …)."""

    field: str
    code: str
    message: str
    severity: Literal["error", "warning"] = "error"


# --- Markdown ↔ sections ------------------------------------------------------------------------------------------
def _section(title: str, lines: list[str]) -> SectionSpec:
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    hint = ""
    if lines:
        match = _HINT_LINE.match(lines[0])
        if match and match.group(1).strip():
            hint = match.group(1).strip()
            lines = lines[1:]
            while lines and not lines[0].strip():
                lines.pop(0)
        elif len(lines) == 1 and _BARE_PLACEHOLDER.match(lines[0]):
            lines = []
    return SectionSpec(title=title, required=True, hint=hint, content="\n".join(lines))


def parse_body(body: str) -> tuple[list[SectionSpec], list[str]]:
    """Sections of a template body and the reasons it cannot be mapped (empty = the builder shows it exactly)."""
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    sections: list[SectionSpec] = []
    problems: list[str] = []
    preamble: list[str] = []
    title: str | None = None
    current: list[str] = []
    for line in lines:
        match = _SECTION_LINE.match(line)
        if match:
            if title is not None:
                sections.append(_section(title, current))
            title, current = match.group(1), []
        elif title is None:
            if line.strip():
                preamble.append(line)
        else:
            current.append(line)
    if title is not None:
        sections.append(_section(title, current))
    if any(_H1_LINE.match(line) for line in preamble):
        problems.append(
            "Заголовок первого уровня «# …» в шаблоне не нужен: документ получает его из названия."
        )
    elif preamble:
        problems.append(
            "Текст до первого раздела «## …» не относится ни к одному разделу — перенесите его в раздел."
        )
    if not sections and not preamble:
        problems.append("В Markdown нет ни одного раздела «## …».")
    return sections, problems


def render_body(sections: list[SectionSpec]) -> str:
    blocks = []
    for section in sections:
        lines = [f"## {section.title.strip()}"]
        hint = " ".join(section.hint.split())
        content = section.content.replace("\r\n", "\n").replace("\r", "\n").strip("\n").rstrip()
        if hint:
            lines.append(f"> {PLACEHOLDER}: {hint}")
        if content:
            if hint:
                lines.append("")
            lines.append(content)
        elif not hint:
            lines.append(f"> {PLACEHOLDER}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + "\n"


# --- spec ↔ template ------------------------------------------------------------------------------------------------
def spec_from_template(template: DocumentTemplate) -> TemplateSpec:
    sections, _ = parse_body(template.body)
    optional = set(template.optional_sections)
    for section in sections:
        section.required = section.title not in optional
    status: VersionStatus = (
        template.status if template.status in ("active", "deprecated", "archived") else "active"  # type: ignore[assignment]
    )
    return TemplateSpec(
        template_id=template.id,
        title=template.title,
        description=template.description,
        category=template.category,
        doc_type=template.doc_type.value,
        id_prefix=template.id_prefix,
        owner=template.owner,
        labels=list(template.labels),
        default_tags=list(template.default_tags),
        sections=sections,
        required_metadata=list(template.required_metadata),
        optional_metadata=list(template.optional_metadata),
        validation=list(template.validation),
        instructions=template.instructions,
        ai_guidance=template.ai_guidance,
        example=template.example,
        changes=template.changes,
        breaking=template.breaking,
        migration=template.migration,
        status=status,
    )


def _clean(values: list[str], lower: bool = False) -> list[str]:
    cleaned = [" ".join(v.split()) for v in values]
    return list(dict.fromkeys(v.lower() if lower else v for v in cleaned if v))


def _header(spec: TemplateSpec, *, version: int, order: int, listed: bool, updated: str) -> str:
    # Fresh list objects per key: yaml would write anchors/aliases for a shared object, which the parser refuses.
    meta: dict[str, object] = {
        "template_id": spec.template_id.strip(),
        "title": " ".join(spec.title.split()),
        "description": spec.description.strip(),
        "doc_type": spec.doc_type,
        "id_prefix": spec.id_prefix.strip(),
        "default_tags": _clean(spec.default_tags, lower=True),
        "order": order,
        "version": version,
        "status": spec.status,
        "listed": listed,
        "category": " ".join(spec.category.split()),
        "owner": spec.owner.strip(),
        "updated": updated,
        "labels": _clean(spec.labels, lower=True),
        "required_metadata": _clean(spec.required_metadata),
        "optional_metadata": _clean(spec.optional_metadata),
        "optional_sections": [s.title.strip() for s in spec.sections if not s.required and s.title.strip()],
        "validation": _clean(spec.validation),
        "breaking": spec.breaking,
        "migration": spec.migration.strip(),
        "changes": spec.changes.strip(),
        "instructions": spec.instructions.strip(),
        "ai_guidance": spec.ai_guidance.strip(),
        "example": spec.example.strip(),
    }
    return yaml.safe_dump(meta, allow_unicode=True, sort_keys=False, default_flow_style=False, width=1000)


def render_template_source(
    spec: TemplateSpec, *, version: int, order: int = 100, listed: bool = True, updated: str = ""
) -> str:
    """The template file a spec stands for (the format of `app/document_templates/*.md`)."""
    header = _header(spec, version=version, order=order, listed=listed, updated=updated)
    return f"---\n{header}---\n{render_body(spec.sections)}"


def template_from_spec(
    spec: TemplateSpec, *, version: int, order: int = 100, listed: bool = True, updated: str = ""
) -> DocumentTemplate:
    """Raises TemplateError exactly where a shipped file with the same content would be refused."""
    return parse_template_text(
        render_template_source(spec, version=version, order=order, listed=listed, updated=updated)
    )


def loose_template(
    spec: TemplateSpec, *, version: int, order: int = 100, listed: bool = True, updated: str = ""
) -> DocumentTemplate:
    """A best-effort template of a spec that may still have errors — for catalogue rows of drafts, comparisons and
    previews. Never stored and never offered to documents (activation goes through `template_from_spec`)."""
    doc_type = DocType(spec.doc_type) if spec.doc_type in DocType._value2member_map_ else DocType.guide
    titles = [s.title.strip() for s in spec.sections if s.title.strip()]
    optional = tuple(s.title.strip() for s in spec.sections if not s.required and s.title.strip())
    template = DocumentTemplate(
        id=spec.template_id.strip(),
        title=" ".join(spec.title.split()) or spec.template_id,
        description=spec.description.strip(),
        doc_type=doc_type,
        id_prefix=spec.id_prefix.strip(),
        default_tags=tuple(_clean(spec.default_tags, lower=True)),
        sections=tuple(t for t in titles if t not in optional),
        body=render_body(spec.sections) if spec.sections else "",
        order=order,
        version=version,
        listed=listed,
        status=spec.status,
        category=" ".join(spec.category.split()),
        owner=spec.owner.strip(),
        labels=tuple(_clean(spec.labels, lower=True)),
        optional_sections=optional,
        required_metadata=tuple(_clean(spec.required_metadata)),
        optional_metadata=tuple(_clean(spec.optional_metadata)),
        validation=tuple(_clean(spec.validation)),
        instructions=spec.instructions.strip(),
        ai_guidance=spec.ai_guidance.strip(),
        example=spec.example.strip(),
        changes=spec.changes.strip(),
        breaking=spec.breaking,
        migration=spec.migration.strip(),
        updated=updated,
    )
    return replace(template, checksum=schema_checksum(template))


def changed_fields(before: TemplateSpec, after: TemplateSpec) -> list[str]:
    old, new = before.model_dump(), after.model_dump()
    return [name for name in TemplateSpec.model_fields if old.get(name) != new.get(name)]


# --- validation -------------------------------------------------------------------------------------------------
def validate_spec(
    spec: TemplateSpec,
    *,
    creating: bool,
    taken_ids: set[str],
    prefixes: dict[str, str],
) -> list[StudioIssue]:
    """Field-bound checks of a spec. `taken_ids`: every template id known to the registry (shipped, removed,
    studio); `prefixes`: ID prefix (upper case) → template id of the other ACTIVE templates."""
    issues: list[StudioIssue] = []

    def error(field: str, code: str, message: str) -> None:
        issues.append(StudioIssue(field=field, code=code, message=message))

    def warning(field: str, code: str, message: str) -> None:
        issues.append(StudioIssue(field=field, code=code, message=message, severity="warning"))

    tid = spec.template_id.strip()
    if not TEMPLATE_ID_RE.fullmatch(tid):
        error(
            "template_id",
            "template_id_invalid",
            "ID шаблона: строчная латиница, цифры и «_», начинается с буквы, от 2 до 41 символа.",
        )
    elif tid in RESERVED_TEMPLATE_IDS:
        error("template_id", "template_id_reserved", f"ID «{tid}» зарезервирован приложением.")
    elif creating and tid in taken_ids:
        error("template_id", "template_id_taken", f"Шаблон с ID «{tid}» уже есть (в поставке или в студии).")

    if not spec.title.strip():
        error("title", "title_missing", "Укажите название шаблона.")
    if not spec.description.strip():
        warning("description", "description_missing", "Короткое описание помогает выбрать шаблон в каталоге.")
    if not spec.category.strip():
        warning(
            "category", "category_missing", "Без категории шаблон попадёт в каталоге в группу без названия."
        )
    if not spec.owner.strip():
        warning("owner", "owner_missing", "Укажите владельца шаблона: к нему придут с вопросами.")
    if spec.doc_type not in DocType._value2member_map_:
        error("doc_type", "doc_type_invalid", "Выберите тип документа из списка.")

    prefix = spec.id_prefix.strip()
    if not ID_PREFIX_RE.fullmatch(prefix) or not is_valid_document_id(prefix):
        error(
            "id_prefix",
            "id_prefix_invalid",
            "Префикс ID: заглавная латиница и цифры, части через «-», например SEM-INT.",
        )
    elif prefix.upper() == BLANK_ID_PREFIX:
        error("id_prefix", "id_prefix_reserved", f"Префикс {BLANK_ID_PREFIX} занят документами без шаблона.")
    else:
        owner = prefixes.get(prefix.upper())
        if owner is not None and owner != tid:
            error(
                "id_prefix",
                "id_prefix_taken",
                f"Префикс {prefix} уже использует шаблон «{owner}»: документы получали бы ID из одной нумерации.",
            )

    for field, values in (("labels", spec.labels), ("default_tags", spec.default_tags)):
        bad = [v for v in values if v.strip() and not _TAG_RE.fullmatch(v.strip())]
        if bad:
            error(
                field, "tag_invalid", f"Без пробелов, запятых и скобок, до 40 символов: {', '.join(bad[:3])}."
            )

    sections = spec.sections
    if not sections:
        error("sections", "sections_missing", "Добавьте хотя бы один раздел.")
    elif not any(s.required for s in sections):
        error("sections", "required_section_missing", "Нужен хотя бы один обязательный раздел.")
    seen: dict[str, int] = {}
    for index, section in enumerate(sections):
        title = section.title.strip()
        where = f"sections.{index}"
        if not title:
            error(f"{where}.title", "section_title_missing", "Укажите название раздела.")
            continue
        if title.startswith("#") or "\n" in section.title:
            error(f"{where}.title", "section_title_invalid", "Название раздела — одна строка без «#».")
        elif len(title) > 120:
            error(f"{where}.title", "section_title_too_long", "Название раздела — не длиннее 120 символов.")
        key = title.casefold()
        if key in seen:
            error(
                f"{where}.title",
                "section_title_duplicate",
                f"Раздел «{title}» уже есть (№{seen[key] + 1}): названия разделов не повторяются.",
            )
        else:
            seen[key] = index
        for line in section.content.splitlines():
            if _SECTION_LINE.match(line) or _H1_LINE.match(line):
                error(
                    f"{where}.content",
                    "section_content_heading",
                    "Строка «# …» или «## …» внутри раздела станет отдельным разделом: используйте «###» "
                    "или добавьте раздел.",
                )
                break

    required = [f.strip() for f in spec.required_metadata if f.strip()]
    optional = [f.strip() for f in spec.optional_metadata if f.strip()]
    allowed = ", ".join(sorted(METADATA_FIELDS))
    for field, values in (("required_metadata", required), ("optional_metadata", optional)):
        unknown = [f for f in values if f not in METADATA_FIELDS]
        if unknown:
            error(field, "metadata_unknown", f"Неизвестные поля: {', '.join(unknown)}. Допустимо: {allowed}.")
    if "title" not in required:
        error(
            "required_metadata",
            "metadata_title_required",
            "Название (title) обязательно для любого документа.",
        )
    both = sorted(set(required) & set(optional))
    if both:
        error(
            "optional_metadata",
            "metadata_both",
            f"Поле не может быть одновременно обязательным и необязательным: {', '.join(both)}.",
        )

    rules_seen: set[str] = set()
    for index, rule in enumerate(spec.validation):
        text = " ".join(rule.split())
        if not text:
            error(f"validation.{index}", "rule_empty", "Пустое правило: заполните или удалите его.")
        elif len(text) > 300:
            error(f"validation.{index}", "rule_too_long", "Правило — не длиннее 300 символов.")
        elif text.casefold() in rules_seen:
            error(f"validation.{index}", "rule_duplicate", "Такое правило уже есть.")
        else:
            rules_seen.add(text.casefold())

    if spec.breaking and not spec.migration.strip():
        error("migration", "migration_missing", "Для несовместимой версии опишите, как перевести документ.")

    if not any(i.severity == "error" for i in issues):
        source = render_template_source(spec, version=1)
        header = _header(spec, version=1, order=100, listed=True, updated="")
        if len(header.encode("utf-8")) > MAX_FRONTMATTER_BYTES:
            error(
                "instructions", "header_too_large", "Описательные поля вместе больше 16 КБ: сократите текст."
            )
        elif len(source.encode("utf-8")) > MAX_TEMPLATE_BYTES:
            error("sections", "template_too_large", "Шаблон больше 32 КБ: сократите разделы или описания.")
        else:
            try:
                parse_template_text(source)
            except TemplateError as exc:  # the file parser has the last word
                error("source", "template_invalid", str(exc))
    return issues


def has_errors(issues: list[StudioIssue]) -> bool:
    return any(i.severity == "error" for i in issues)
