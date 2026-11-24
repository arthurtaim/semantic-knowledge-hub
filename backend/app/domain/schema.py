"""Knowledge document format: Markdown with YAML frontmatter (see docs/DOCUMENT_SCHEMA.md)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode, Node

from app.domain.markdown import ParsedMarkdown, parse_markdown
from app.domain.models import DocStatus, DocType, RelationType, ValidationIssue
from app.domain.safety import find_personal_identifiers, find_secrets

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
OWNER_RE = re.compile(r"^[^\s\x00-\x1f][^\x00-\x1f]{0,99}$")
MAX_FRONTMATTER_BYTES = 16 * 1024
MIN_BODY_CHARS = 20

REQUIRED_FIELDS = ("id", "title", "type", "status", "owner", "tags")
OPTIONAL_FIELDS = (
    "reviewed_at",
    "related_ids",
    "relations",
    "aliases",
    "version",
    "synthetic",
    "template",
    "template_version",
    "source_refs",
    "summary",
    "confluence_page_id",
)
VERSION_RE = re.compile(r"^\d{1,4}(?:\.\d{1,4}){0,2}$")
TEMPLATE_REF_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
MAX_RELATION_TARGETS = 50
MAX_ALIASES = 20
# `references` is reserved for plain related_ids; typed relations use the other types.
DECLARABLE_RELATIONS = tuple(r.value for r in RelationType if r is not RelationType.references)
UNASSIGNED_OWNERS = {"unassigned", "none", "tbd", "-", "нет"}


def is_valid_document_id(value: str) -> bool:
    return bool(ID_RE.fullmatch(value)) and ".." not in value


class _StrictSafeLoader(yaml.SafeLoader):
    """SafeLoader that rejects YAML aliases (billion-laughs) and duplicate mapping keys."""

    def compose_node(self, parent: Node | None, index: Any) -> Node | None:
        if self.check_event(yaml.AliasEvent):
            event = self.peek_event()  # type: ignore[no-untyped-call]
            raise yaml.composer.ComposerError(
                None, None, "YAML aliases/anchors are not allowed", event.start_mark
            )
        return super().compose_node(parent, index)

    def construct_mapping(self, node: MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise ConstructorError(
                    None, None, f"duplicate key {key!r} in frontmatter", key_node.start_mark
                )
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


class FrontmatterError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def split_frontmatter(text: str) -> tuple[str, str]:
    """Return (yaml_text, markdown_body). Raises FrontmatterError if the block is missing."""
    normalized = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---\n"):
        raise FrontmatterError("frontmatter_missing", "Документ должен начинаться с YAML-блока '---'.")
    end = normalized.find("\n---", 4)
    while end != -1:
        after = normalized[end + 4 : end + 5]
        if after in ("", "\n"):
            break
        end = normalized.find("\n---", end + 4)
    if end == -1:
        raise FrontmatterError("frontmatter_unterminated", "YAML-блок не закрыт строкой '---'.")
    yaml_text = normalized[4:end]
    body = normalized[end + 4 :].lstrip("\n")
    if len(yaml_text.encode("utf-8")) > MAX_FRONTMATTER_BYTES:
        raise FrontmatterError("frontmatter_too_large", "YAML-блок слишком большой.")
    return yaml_text, body


def load_frontmatter(yaml_text: str) -> dict[str, Any]:
    try:
        data = yaml.load(yaml_text, Loader=_StrictSafeLoader)  # noqa: S506 - strict SafeLoader subclass
    except yaml.YAMLError as exc:
        problem = getattr(exc, "problem", None) or "синтаксическая ошибка"
        mark = getattr(exc, "problem_mark", None)
        where = f" (строка {mark.line + 1})" if mark is not None else ""
        raise FrontmatterError("frontmatter_invalid_yaml", f"Некорректный YAML: {problem}{where}.") from exc
    if not isinstance(data, dict):
        raise FrontmatterError("frontmatter_not_mapping", "YAML-блок должен быть словарём полей.")
    return data


@dataclass
class ParsedDocument:
    """Result of parsing; `errors` make the document invalid, `warnings` are advisory."""

    metadata: dict[str, Any] = field(default_factory=dict)
    body: str = ""
    markdown: ParsedMarkdown | None = None
    issues: list[ValidationIssue] = field(default_factory=list)
    extra_metadata: dict[str, str] = field(default_factory=dict)

    @property
    def errors(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def is_valid(self) -> bool:
        return not self.errors

    @property
    def document_id(self) -> str | None:
        value = self.metadata.get("id")
        return value if isinstance(value, str) else None


def _err(code: str, message: str, field_name: str | None = None) -> ValidationIssue:
    return ValidationIssue(severity="error", code=code, message=message, field=field_name)


def _warn(code: str, message: str, field_name: str | None = None) -> ValidationIssue:
    return ValidationIssue(severity="warning", code=code, message=message, field=field_name)


def _string_list(value: Any, field_name: str, issues: list[ValidationIssue]) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str | int | float) for v in value):
        issues.append(_err("invalid_list", f"Поле `{field_name}` должно быть списком строк.", field_name))
        return []
    items = [str(v).strip() for v in value]
    if any(not v for v in items):
        issues.append(_err("empty_list_item", f"Поле `{field_name}` содержит пустые значения.", field_name))
    return [v for v in items if v]


def _parse_relations(value: Any, issues: list[ValidationIssue]) -> list[tuple[str, str]]:
    """`relations: {depends_on: [ID, …], maps_to: [ID]}` → [(type, target)] in declaration order."""
    if value is None:
        return []
    if not isinstance(value, dict):
        issues.append(
            _err(
                "invalid_relations",
                "Поле `relations` должно быть словарём «тип связи: [ID, …]».",
                "relations",
            )
        )
        return []
    result: list[tuple[str, str]] = []
    total = 0
    for rel_type, targets in value.items():
        name = str(rel_type)
        if name not in DECLARABLE_RELATIONS:
            issues.append(
                _err(
                    "unknown_relation_type",
                    f"Неизвестный тип связи `{name}`. Допустимо: {', '.join(DECLARABLE_RELATIONS)}.",
                    "relations",
                )
            )
            continue
        items = _string_list(targets if isinstance(targets, list) else [targets], f"relations.{name}", issues)
        for target in items:
            if not is_valid_document_id(target):
                issues.append(
                    _err(
                        "invalid_relation_target",
                        f"Некорректный ID `{target}` в `relations.{name}`.",
                        "relations",
                    )
                )
                continue
            if (name, target) not in result:
                result.append((name, target))
        total += len(items)
    if total > MAX_RELATION_TARGETS:
        issues.append(_err("too_many_relations", "В `relations` не более 50 ссылок.", "relations"))
        return result[:MAX_RELATION_TARGETS]
    return result


def _parse_date(value: Any, issues: list[ValidationIssue]) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            pass
    issues.append(
        _err("invalid_date", "Поле `reviewed_at` должно быть датой YYYY-MM-DD или null.", "reviewed_at")
    )
    return None


def parse_document(text: str, *, expected_id: str | None = None) -> ParsedDocument:
    """Parse and validate a knowledge document. Never raises for content problems."""
    result = ParsedDocument()
    try:
        yaml_text, body = split_frontmatter(text)
        raw_meta = load_frontmatter(yaml_text)
    except FrontmatterError as exc:
        result.issues.append(_err(exc.code, exc.message))
        return result

    issues = result.issues
    meta: dict[str, Any] = {}

    for name in REQUIRED_FIELDS:
        if name not in raw_meta or raw_meta[name] in (None, "", []):
            if name == "tags" and raw_meta.get("tags") == []:
                continue
            issues.append(_err("missing_field", f"Отсутствует обязательное поле `{name}`.", name))

    doc_id = raw_meta.get("id")
    if doc_id is not None:
        if not isinstance(doc_id, str) or not is_valid_document_id(doc_id):
            issues.append(
                _err(
                    "invalid_id",
                    "Поле `id` должно содержать латиницу, цифры, '-', '_' или '.' (до 128 символов).",
                    "id",
                )
            )
        else:
            meta["id"] = doc_id
            if expected_id is not None and doc_id.lower() != expected_id.lower():
                issues.append(
                    _err("id_changed", f"Нельзя менять `id` документа (ожидается {expected_id}).", "id")
                )

    title = raw_meta.get("title")
    if title is not None:
        if not isinstance(title, str) or not title.strip() or len(title) > 300:
            issues.append(
                _err("invalid_title", "Поле `title` должно быть непустой строкой до 300 символов.", "title")
            )
        else:
            meta["title"] = title.strip()

    for name, enum_cls in (("type", DocType), ("status", DocStatus)):
        value = raw_meta.get(name)
        if value is None:
            continue
        allowed = ", ".join(e.value for e in enum_cls)
        if not isinstance(value, str) or value not in enum_cls._value2member_map_:
            issues.append(_err(f"invalid_{name}", f"Поле `{name}` должно быть одним из: {allowed}.", name))
        else:
            meta[name] = enum_cls(value)

    owner = raw_meta.get("owner")
    if owner is not None:
        if not isinstance(owner, str) or not OWNER_RE.fullmatch(owner.strip()):
            issues.append(
                _err(
                    "invalid_owner", "Поле `owner` должно быть идентификатором команды/пользователя.", "owner"
                )
            )
        else:
            meta["owner"] = owner.strip()

    if "tags" in raw_meta:
        meta["tags"] = list(
            dict.fromkeys(t.lower() for t in _string_list(raw_meta.get("tags"), "tags", issues))
        )
    related = _string_list(raw_meta.get("related_ids"), "related_ids", issues)
    bad_related = [r for r in related if not is_valid_document_id(r)]
    if bad_related:
        issues.append(
            _err("invalid_related_id", "Некорректные идентификаторы в `related_ids`.", "related_ids")
        )
    meta["related_ids"] = [r for r in related if is_valid_document_id(r)]
    meta["relations"] = _parse_relations(raw_meta.get("relations"), issues)
    if meta.get("id") and any(t.lower() == str(meta["id"]).lower() for _, t in meta["relations"]):
        issues.append(
            _err("self_relation", "Документ не может ссылаться сам на себя в `relations`.", "relations")
        )
    aliases = _string_list(raw_meta.get("aliases"), "aliases", issues)
    if len(aliases) > MAX_ALIASES or any(len(a) > 120 for a in aliases):
        issues.append(_err("invalid_aliases", "Не более 20 псевдонимов длиной до 120 символов.", "aliases"))
    meta["aliases"] = aliases[:MAX_ALIASES]
    version = raw_meta.get("version")
    if version is not None:
        text_version = str(version).strip()
        if isinstance(version, bool) or not VERSION_RE.fullmatch(text_version):
            issues.append(
                _err("invalid_version", "Поле `version` должно быть вида 1, 1.2 или 1.2.3.", "version")
            )
        else:
            meta["version"] = text_version
    synthetic = raw_meta.get("synthetic")
    if synthetic is not None and not isinstance(synthetic, bool):
        issues.append(_err("invalid_synthetic", "Поле `synthetic` должно быть true или false.", "synthetic"))
    meta["synthetic"] = synthetic is True
    template_ref = raw_meta.get("template")
    if template_ref is not None:
        if not isinstance(template_ref, str) or not TEMPLATE_REF_RE.fullmatch(template_ref):
            issues.append(
                _err("invalid_template_ref", "Поле `template` — идентификатор шаблона.", "template")
            )
        else:
            meta["template"] = template_ref
    template_version = raw_meta.get("template_version")
    if template_version is not None:
        if (
            isinstance(template_version, bool)
            or not isinstance(template_version, int)
            or template_version < 1
        ):
            issues.append(
                _err(
                    "invalid_template_version",
                    "Поле `template_version` — целое число ≥ 1.",
                    "template_version",
                )
            )
        else:
            meta["template_version"] = template_version
    meta["source_refs"] = _string_list(raw_meta.get("source_refs"), "source_refs", issues)
    meta["reviewed_at"] = _parse_date(raw_meta.get("reviewed_at"), issues)

    summary = raw_meta.get("summary")
    if summary is not None:
        if not isinstance(summary, str):
            issues.append(_err("invalid_summary", "Поле `summary` должно быть строкой.", "summary"))
        else:
            meta["summary"] = summary.strip()[:1000] or None

    for key, value in raw_meta.items():
        key_str = str(key)
        if key_str in REQUIRED_FIELDS or key_str in OPTIONAL_FIELDS:
            if key_str == "confluence_page_id" and value is not None:
                result.extra_metadata[key_str] = str(value)[:200]
            continue
        result.extra_metadata[key_str] = str(value)[:200]
        issues.append(
            _warn(
                "unknown_field",
                f"Неизвестное поле `{key_str}` сохранено как дополнительные метаданные.",
                key_str,
            )
        )

    if len(body.strip()) < MIN_BODY_CHARS:
        issues.append(_err("empty_body", "Тело документа пустое или слишком короткое."))
    if not re.search(r"^#{1,6}\s+\S", body, flags=re.MULTILINE):
        issues.append(_warn("no_heading", "В документе нет ни одного заголовка Markdown."))
    if re.search(r"<\s*(script|iframe|object|embed|style)\b", body, flags=re.IGNORECASE) or re.search(
        r"\]\(\s*(javascript|data|vbscript):", body, flags=re.IGNORECASE
    ):
        issues.append(_warn("unsafe_markup", "Небезопасная разметка будет экранирована при отображении."))

    secrets = find_secrets(text)
    if secrets:
        issues.append(
            _err("secret_detected", f"Обнаружены вероятные секреты ({', '.join(secrets)}). Удалите их.")
        )
    pii = find_personal_identifiers(text)
    if pii:
        issues.append(
            _err("personal_data_detected", f"Обнаружены вероятные персональные данные ({', '.join(pii)}).")
        )

    if meta.get("status") == DocStatus.approved:
        if meta.get("reviewed_at") is None:
            issues.append(
                _warn("approved_without_review", "Утверждённый документ без даты проверки `reviewed_at`.")
            )
        if str(meta.get("owner", "")).lower() in UNASSIGNED_OWNERS:
            issues.append(
                _warn("approved_without_owner", "Утверждённый документ без назначенного владельца.")
            )

    result.metadata = meta
    result.body = body
    result.markdown = parse_markdown(body, title_fallback=str(meta.get("title", "")))
    return result
