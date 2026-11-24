"""Document templates and composition of new knowledge documents (docs/DOCUMENT_TEMPLATES.md).

Templates are Markdown files with a small YAML header, stored outside the UI code
(`app/document_templates/`, or `DOCUMENT_TEMPLATES_DIR`). Adding a template is adding a file.
The application — not the user — writes the document's YAML frontmatter from form fields.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from app.domain.models import DocStatus, DocType
from app.domain.schema import FrontmatterError, is_valid_document_id, load_frontmatter, split_frontmatter

logger = logging.getLogger("skh.templates")

DEFAULT_TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "document_templates"
PLACEHOLDER = "Требует уточнения"
TEMPLATE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
ID_PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$")
_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
MAX_TEMPLATE_BYTES = 32 * 1024
# Field order of generated frontmatter (docs/DOCUMENT_SCHEMA.md).
FRONTMATTER_ORDER = (
    "id",
    "title",
    "type",
    "status",
    "owner",
    "tags",
    "related_ids",
    "source_refs",
    "summary",
    "template",
    "template_version",
)


TEMPLATE_STATUSES = ("draft", "active", "deprecated", "archived")
# Metadata a template may declare as required/optional (the document schema's human-supplied fields).
METADATA_FIELDS = frozenset(
    {"title", "owner", "tags", "summary", "related_ids", "source_refs", "aliases", "relations", "version"}
)


class TemplateError(ValueError):
    pass


@dataclass(frozen=True)
class DocumentTemplate:
    id: str
    title: str
    description: str
    doc_type: DocType
    id_prefix: str
    default_tags: tuple[str, ...]
    sections: tuple[str, ...]  # required `##` sections, in order
    body: str  # Markdown skeleton with placeholders
    order: int
    version: int = 1  # declared in the template header (`version:`), resolved by the TemplateRegistry
    checksum: str = ""
    listed: bool = True  # `listed: false`: not offered for manual authoring (e.g. external_import)
    # --- Template Hub (M5.6.3): a machine-readable schema + authoring guide, shared by people and the AI ---
    status: str = "active"  # draft | active | deprecated | archived (only `active` is offered / recommended)
    category: str = ""
    owner: str = ""
    labels: tuple[str, ...] = ()  # tags of the TEMPLATE (default_tags are given to new documents)
    optional_sections: tuple[str, ...] = ()  # `##` sections that may stay out; `sections` are required
    required_metadata: tuple[str, ...] = ("title", "owner")
    optional_metadata: tuple[str, ...] = ()
    validation: tuple[str, ...] = ()  # human-readable rules the reviewer and the AI check
    instructions: str = ""  # for the author
    ai_guidance: str = ""  # for the runtime AI (data from the registry, never a system instruction)
    example: str = ""  # a short SYNTHETIC example body
    changes: str = ""  # what changed in this version
    breaking: bool = False  # existing documents need a manual migration to this version
    migration: str = ""  # what to do when moving a document to this version
    updated: str = ""  # YYYY-MM-DD from the header

    def skeleton(self, title: str) -> str:
        heading = f"# {title.strip()}\n\n" if title.strip() else ""
        return heading + self.body.strip() + "\n"


def _parse_template(path: Path) -> DocumentTemplate:
    if path.stat().st_size > MAX_TEMPLATE_BYTES:
        raise TemplateError("файл шаблона слишком большой")
    return parse_template_text(path.read_text(encoding="utf-8"))


def parse_template_text(text: str) -> DocumentTemplate:
    """The one parser of a template's source (a shipped file or a Template Studio version): same rules for both."""
    if len(text.encode("utf-8")) > MAX_TEMPLATE_BYTES:
        raise TemplateError("файл шаблона слишком большой")
    try:
        yaml_text, body = split_frontmatter(text)
        meta = load_frontmatter(yaml_text)
    except FrontmatterError as exc:
        raise TemplateError(exc.message) from exc
    template_id = str(meta.get("template_id", ""))
    if not TEMPLATE_ID_RE.fullmatch(template_id):
        raise TemplateError("template_id должен состоять из строчной латиницы, цифр и '_'")
    doc_type = str(meta.get("doc_type", ""))
    if doc_type not in DocType._value2member_map_:
        raise TemplateError(f"doc_type должен быть одним из: {', '.join(t.value for t in DocType)}")
    prefix = str(meta.get("id_prefix", ""))
    if not ID_PREFIX_RE.fullmatch(prefix) or not is_valid_document_id(prefix):
        raise TemplateError("id_prefix должен быть вида SEM-ARCH")
    title = str(meta.get("title", "")).strip()
    if not title:
        raise TemplateError("не задан title")
    headings = tuple(m.group(1) for m in _HEADING_RE.finditer(body))
    if not headings:
        raise TemplateError("в шаблоне нет ни одного раздела `## …`")
    optional = _str_tuple(meta, "optional_sections")
    unknown_optional = [s for s in optional if s not in headings]
    if unknown_optional:
        raise TemplateError(f"optional_sections не найдены в тексте шаблона: {', '.join(unknown_optional)}")
    sections = tuple(h for h in headings if h not in optional)
    if not sections:
        raise TemplateError("нужен хотя бы один обязательный раздел")
    status = str(meta.get("status", "active"))
    if status not in TEMPLATE_STATUSES:
        raise TemplateError(f"status должен быть одним из: {', '.join(TEMPLATE_STATUSES)}")
    required_metadata = _str_tuple(meta, "required_metadata") or ("title", "owner")
    optional_metadata = _str_tuple(meta, "optional_metadata")
    unknown_fields = [f for f in (*required_metadata, *optional_metadata) if f not in METADATA_FIELDS]
    if unknown_fields:
        raise TemplateError(f"неизвестные поля метаданных: {', '.join(unknown_fields)}")
    tags = meta.get("default_tags") or []
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise TemplateError("default_tags должен быть списком строк")
    order = meta.get("order", 100)
    version = meta.get("version", 1)
    if isinstance(version, bool) or not isinstance(version, int) or not 1 <= version <= 1000:
        raise TemplateError("version должен быть целым числом от 1")
    template = DocumentTemplate(
        id=template_id,
        title=title,
        description=str(meta.get("description", "")).strip(),
        doc_type=DocType(doc_type),
        id_prefix=prefix,
        default_tags=tuple(t.strip().lower() for t in tags if t.strip()),
        sections=sections,
        body=body.strip() + "\n",
        order=order if isinstance(order, int) else 100,
        version=version,
        listed=meta.get("listed", True) is not False,
        status=status,
        category=str(meta.get("category", "")).strip(),
        owner=str(meta.get("owner", "")).strip(),
        labels=tuple(x.lower() for x in _str_tuple(meta, "labels")),
        optional_sections=optional,
        required_metadata=required_metadata,
        optional_metadata=optional_metadata,
        validation=_str_tuple(meta, "validation"),
        instructions=str(meta.get("instructions", "")).strip(),
        ai_guidance=str(meta.get("ai_guidance", "")).strip(),
        example=str(meta.get("example", "")).strip(),
        changes=str(meta.get("changes", "")).strip(),
        breaking=meta.get("breaking", False) is True,
        migration=str(meta.get("migration", "")).strip(),
        updated=str(meta.get("updated", "") or "").strip(),
    )
    return replace(template, checksum=schema_checksum(template))


# What a template VERSION is: the structure documents are created and validated against. Catalogue text
# (title, description, category, owner, labels, instructions, AI guidance, example, change notes) may be
# corrected without a new version; any change below is a new version (declared, or auto-bumped).
SCHEMA_FIELDS = (
    "doc_type",
    "id_prefix",
    "default_tags",
    "sections",
    "optional_sections",
    "body",
    "required_metadata",
    "optional_metadata",
    "validation",
    "status",
    "breaking",
    "migration",
    "listed",
)


def schema_checksum(template: DocumentTemplate) -> str:
    data = {name: getattr(template, name) for name in SCHEMA_FIELDS}
    data["doc_type"] = template.doc_type.value
    canonical = json.dumps(data, ensure_ascii=False, sort_keys=True, default=list)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _str_tuple(meta: dict[str, Any], key: str) -> tuple[str, ...]:
    value = meta.get(key) or []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise TemplateError(f"{key} должен быть списком строк")
    return tuple(v.strip() for v in value if v.strip())


def parse_template_file(path: Path) -> DocumentTemplate:
    return _parse_template(path)


def load_templates(directory: Path) -> dict[str, DocumentTemplate]:
    """Load every `*.md` template. Invalid files are skipped with an error in the log, so one broken
    template never hides the others."""
    templates: dict[str, DocumentTemplate] = {}
    if not directory.is_dir():
        logger.error("templates directory not found: %s", directory)
        return templates
    for path in sorted(directory.glob("*.md")):
        if path.is_symlink() or not path.is_file():
            logger.error("template %s skipped: not a regular file", path.name)
            continue
        try:
            template = _parse_template(path)
        except (TemplateError, OSError, UnicodeDecodeError) as exc:
            logger.error("template %s skipped: %s", path.name, exc)
            continue
        if template.id in templates:
            logger.error("template %s skipped: duplicate template_id %s", path.name, template.id)
            continue
        templates[template.id] = template
    return dict(sorted(templates.items(), key=lambda item: (item[1].order, item[0])))


def _clean_list(values: list[str]) -> list[str]:
    return list(dict.fromkeys(v.strip() for v in values if v and v.strip()))


def compose_document(metadata: dict[str, Any], body: str, extra: dict[str, Any] | None = None) -> str:
    """YAML frontmatter generated from form fields + the Markdown body. Values are serialized by the
    YAML library (quoting/escaping), never concatenated by hand. `extra`: keys the form does not manage, kept
    from the stored file (e.g. `relations`, `aliases`, `reviewed_at` of an imported document)."""
    data: dict[str, Any] = {}
    for key in FRONTMATTER_ORDER:
        value = metadata.get(key)
        if key in ("tags", "related_ids", "source_refs"):
            data[key] = _clean_list(list(value or []))
        elif key == "summary":
            if value and str(value).strip():
                data[key] = " ".join(str(value).split())
        elif isinstance(value, DocStatus | DocType):
            data[key] = value.value
        elif key == "template_version":
            if isinstance(value, int) and value >= 1:
                data[key] = value
        elif value is not None:
            data[key] = str(value).strip()
    data["reviewed_at"] = None
    for key, value in (extra or {}).items():
        if key not in FRONTMATTER_ORDER:
            data[key] = value
    header = yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=None, width=1000)
    normalized_body = body.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    return f"---\n{header}---\n\n{normalized_body}\n"


def suggest_document_id(prefix: str, taken: set[str]) -> str:
    """Next free `<PREFIX>-NNN` (case-insensitive against documents and open proposals)."""
    pattern = re.compile(rf"^{re.escape(prefix.lower())}-(\d+)$")
    numbers = [int(m.group(1)) for m in (pattern.match(t.lower()) for t in taken) if m]
    candidate = max(numbers, default=0) + 1
    lowered = {t.lower() for t in taken}
    while f"{prefix}-{candidate:03d}".lower() in lowered:
        candidate += 1
    return f"{prefix}-{candidate:03d}"


def suggest_path(document_id: str, knowledge_prefix: str = "", folder: str = "") -> str:
    parts = [p for p in (knowledge_prefix.strip("/"), folder.strip("/")) if p]
    return str(PurePosixPath(*parts, f"{document_id}.md")) if parts else f"{document_id}.md"


def missing_sections(template: DocumentTemplate, body: str) -> list[str]:
    present = {m.group(1).strip().casefold() for m in _HEADING_RE.finditer(body)}
    return [s for s in template.sections if s.casefold() not in present]


def placeholder_count(body: str) -> int:
    return body.count(PLACEHOLDER)
