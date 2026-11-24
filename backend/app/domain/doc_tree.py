"""The documents tree of «Документы» v2: sections → groups → documents (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §4).

A section is a document type. Groups are COMPUTED from the documents' own metadata (variant 1, chosen by the owner);
there is no explicit `parent` field yet. A document's group comes from a chain of resolvers, `GROUP_RESOLVERS`: the
first one that returns a group wins. A future explicit `parent` in the metadata becomes the first resolver of that
chain — the automatic rule and the layout code below stay as they are.

The automatic rule:

1. Source systems are the documents of type `source`. A system's name is the part of the title before «:» («ARIS:
   условная модель…» → «ARIS»); its key comes from the document's `sys-<key>` tag. A source document whose title has
   no «:» (an overview, a policy) names no system.
2. `integration`: the system of the first `consumes` relation whose target is a source system document; else the
   system of the first tag that names a system (`<key>` or `sys-<key>`); else «Общие правила».
3. `standard`: a `template` / `шаблон` tag → «Шаблоны документов», otherwise «Регламенты и качество».
4. Every other section has no groups: its documents sit directly in the section. A one-document group is fine.

`document_systems` lists the systems a document is about: the systems of its `consumes` / `produces` targets that
are source system documents, then the systems its tags name — without repeats, in that order.

Everything here is pure and works on ONE reader's snapshot: a system the reader cannot see neither names a group nor
appears in `systems`. Ordering: sections in the logical order of `SECTION_ORDER` (a type outside it goes last);
groups by name with «Общие правила» last; documents needing attention first, then by title.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Literal

from app.domain.models import DocStatus, DocType, DocumentRecord, RelationType, ReviewState

# Logical order of the tree (not by size): product, architecture, domain, sources, integrations, datasets, …
SECTION_ORDER: tuple[str, ...] = (
    DocType.overview.value,
    DocType.architecture.value,
    DocType.domain.value,
    DocType.source.value,
    DocType.integration.value,
    DocType.dataset.value,
    DocType.process.value,
    DocType.decision.value,
    DocType.standard.value,
    DocType.guide.value,
    DocType.glossary.value,
)
SECTION_LABELS: dict[str, str] = {
    DocType.overview.value: "Продукт",
    DocType.architecture.value: "Архитектура",
    DocType.domain.value: "Домен",
    DocType.source.value: "Системы-источники",
    DocType.integration.value: "Интеграции",
    DocType.dataset.value: "Датасеты",
    DocType.process.value: "Процессы",
    DocType.decision.value: "Решения",
    DocType.standard.value: "Стандарты",
    DocType.guide.value: "Руководства",
    DocType.glossary.value: "Глоссарий",
}

SYSTEM_TAG_PREFIX = "sys-"
TEMPLATE_TAGS = frozenset({"template", "шаблон"})
# «Требуют внимания» — ONE rule for the tree, the overview, the table and the assistant's `catalog_query`
# (`needs_attention` filter, M5.7): statuses that always need attention; an approved document needs it only when its
# review or owner does. `attention_reasons` is the rule; `needs_attention` is «at least one reason».
AttentionReason = Literal[
    "in_review", "draft", "deprecated", "review_stale", "never_reviewed", "owner_missing"
]
_STATUS_REASONS: dict[DocStatus, AttentionReason] = {
    DocStatus.in_review: "in_review",
    DocStatus.draft: "draft",
    DocStatus.deprecated: "deprecated",
}
_REVIEW_REASONS: dict[ReviewState, AttentionReason] = {
    "stale": "review_stale",
    "never_reviewed": "never_reviewed",
}
ATTENTION_STATUSES = frozenset(_STATUS_REASONS)
ATTENTION_REVIEW_STATES: frozenset[ReviewState] = frozenset(_REVIEW_REASONS)
# The reasons in words (the UI's own labels: «На ревью», «Черновик», «Устарел», «Проверка устарела», …).
ATTENTION_REASON_LABELS: dict[AttentionReason, str] = {
    "in_review": "на ревью",
    "draft": "черновик",
    "deprecated": "устарел",
    "review_stale": "проверка устарела",
    "never_reviewed": "не проверялся",
    "owner_missing": "без владельца",
}

# Group keys that are not systems start with «_»; a system key never does (see `system_key`).
COMMON_GROUP = "_common"
COMMON_GROUP_LABEL = "Общие правила"
TEMPLATES_GROUP = "templates"
TEMPLATES_GROUP_LABEL = "Шаблоны документов"
RULES_GROUP = "rules"
RULES_GROUP_LABEL = "Регламенты и качество"


@dataclass(frozen=True)
class SourceSystem:
    """A system named by a source system document."""

    name: str
    key: str | None  # from the document's `sys-<key>` tag; None without one
    document_id: str


@dataclass(frozen=True)
class SystemIndex:
    """The systems of one snapshot: by the lower-cased id of their source document and by key."""

    by_document: dict[str, SourceSystem]
    by_key: dict[str, SourceSystem]

    def for_target(self, target: str) -> SourceSystem | None:
        return self.by_document.get(target.lower())

    def for_tag(self, tag: str) -> SourceSystem | None:
        """The system a tag names: its key (`aris`) or its system tag (`sys-aris`)."""
        value = tag.strip().lower()
        if value.startswith(SYSTEM_TAG_PREFIX):
            value = value[len(SYSTEM_TAG_PREFIX) :]
        return self.by_key.get(value) if value else None


@dataclass(frozen=True)
class GroupRef:
    """A group inside the document's section: `key` is local to the section, `last` sorts it after the others."""

    key: str
    label: str
    last: bool = False


GroupResolver = Callable[[DocumentRecord, SystemIndex], GroupRef | None]


def system_name(doc: DocumentRecord) -> str | None:
    """«ARIS: условная модель…» → «ARIS»; None for a non-source document or a title without «:»."""
    if doc.type != DocType.source or ":" not in doc.title:
        return None
    name = doc.title.split(":", 1)[0].strip()
    return name or None


def system_key(doc: DocumentRecord) -> str | None:
    """The key of the document's first `sys-<key>` tag (lower case); None without one."""
    for tag in doc.tags:
        value = tag.strip().lower()
        if value.startswith(SYSTEM_TAG_PREFIX):
            key = value[len(SYSTEM_TAG_PREFIX) :]
            if key and not key.startswith("_"):
                return key
    return None


def build_system_index(docs: Iterable[DocumentRecord]) -> SystemIndex:
    """Systems of these documents. When two documents claim one key, the lower id keeps it (deterministic)."""
    by_document: dict[str, SourceSystem] = {}
    by_key: dict[str, SourceSystem] = {}
    for doc in sorted(docs, key=lambda d: d.id.lower()):
        name = system_name(doc)
        if name is None:
            continue
        system = SourceSystem(name=name, key=system_key(doc), document_id=doc.id)
        by_document[doc.id.lower()] = system
        if system.key is not None:
            by_key.setdefault(system.key, system)
    return SystemIndex(by_document=by_document, by_key=by_key)


def document_systems(doc: DocumentRecord, index: SystemIndex) -> list[str]:
    """Systems of the `consumes` / `produces` targets that are source systems, then the systems the tags name."""
    names: list[str] = []
    for rel in doc.relations:
        if rel.type in (RelationType.consumes, RelationType.produces):
            system = index.for_target(rel.target)
            if system is not None:
                names.append(system.name)
    for tag in doc.tags:
        system = index.for_tag(tag)
        if system is not None:
            names.append(system.name)
    return list(dict.fromkeys(names))


def _system_group(system: SourceSystem) -> GroupRef:
    return GroupRef(key=system.key or system.document_id.lower(), label=system.name)


def _integration_group(doc: DocumentRecord, index: SystemIndex) -> GroupRef:
    for rel in doc.relations:
        if rel.type == RelationType.consumes:
            system = index.for_target(rel.target)
            if system is not None:
                return _system_group(system)
    for tag in doc.tags:
        system = index.for_tag(tag)
        if system is not None:
            return _system_group(system)
    return GroupRef(key=COMMON_GROUP, label=COMMON_GROUP_LABEL, last=True)


def _standard_group(doc: DocumentRecord, index: SystemIndex) -> GroupRef:
    if any(tag.strip().lower() in TEMPLATE_TAGS for tag in doc.tags):
        return GroupRef(key=TEMPLATES_GROUP, label=TEMPLATES_GROUP_LABEL)
    return GroupRef(key=RULES_GROUP, label=RULES_GROUP_LABEL)


_AUTOMATIC_RULES: dict[DocType, GroupResolver] = {
    DocType.integration: _integration_group,
    DocType.standard: _standard_group,
}


def automatic_group(doc: DocumentRecord, index: SystemIndex) -> GroupRef | None:
    """The computed group (variant 1); None: the document sits directly in its section."""
    rule = _AUTOMATIC_RULES.get(doc.type)
    return rule(doc, index) if rule is not None else None


# First match wins. An explicit `parent` resolver, when the metadata gets one, goes in front of `automatic_group`.
GROUP_RESOLVERS: tuple[GroupResolver, ...] = (automatic_group,)


def resolve_group(
    doc: DocumentRecord, index: SystemIndex, resolvers: tuple[GroupResolver, ...] = GROUP_RESOLVERS
) -> GroupRef | None:
    for resolver in resolvers:
        group = resolver(doc, index)
        if group is not None:
            return group
    return None


def attention_reasons(
    status: DocStatus, review_state: ReviewState, owner_missing: bool
) -> tuple[AttentionReason, ...]:
    """Why a document needs attention (empty: it does not): in review, draft or deprecated; a review that is stale
    or never happened (`review_state`, computed for today by `KnowledgeService.review_state`); no owner."""
    reasons: list[AttentionReason] = []
    if (by_status := _STATUS_REASONS.get(status)) is not None:
        reasons.append(by_status)
    if (by_review := _REVIEW_REASONS.get(review_state)) is not None:
        reasons.append(by_review)
    if owner_missing:
        reasons.append("owner_missing")
    return tuple(reasons)


def needs_attention(status: DocStatus, review_state: ReviewState, owner_missing: bool) -> bool:
    """In review, draft or deprecated; or a review that is stale / never happened; or no owner."""
    return bool(attention_reasons(status, review_state, owner_missing))


def attention_rule_text(stale_days: int) -> str:
    """The rule in words (Russian), for the assistant's fact definition and its tool description."""
    return (
        "«Требуют внимания» — то же правило, что в разделе «Документы» (дерево, «Обзор», «Таблица»): статус «на "
        "ревью», «черновик» или «устарел»; или проверка устарела (последняя проверка, reviewed_at, старше "
        f"{stale_days} дней) или не проводилась у утверждённого документа или документа на ревью; или не назначен "
        "владелец. Достаточно одного условия."
    )


def section_rank(section: str) -> tuple[int, str]:
    """Position of a section in the tree: the logical order, then any other type by its key."""
    try:
        return (SECTION_ORDER.index(section), "")
    except ValueError:
        return (len(SECTION_ORDER), section)


def section_label(section: str) -> str:
    return SECTION_LABELS.get(section, section)


@dataclass(frozen=True)
class GroupLayout:
    key: str  # «<section>/<group>», e.g. `integration/aris`
    label: str
    doc_ids: tuple[str, ...]
    attention: int


@dataclass(frozen=True)
class SectionLayout:
    key: str
    label: str
    groups: tuple[GroupLayout, ...]
    doc_ids: tuple[str, ...]  # documents directly in the section (no group)
    count: int
    attention: int


@dataclass(frozen=True)
class TreeLayout:
    sections: tuple[SectionLayout, ...]
    group_of: dict[str, str | None]  # document id -> full group key
    systems: dict[str, list[str]]  # document id -> its systems
    total: int
    attention_total: int


def build_layout(
    docs: Iterable[DocumentRecord],
    attention: Callable[[DocumentRecord], bool],
    *,
    resolvers: tuple[GroupResolver, ...] = GROUP_RESOLVERS,
) -> TreeLayout:
    """Sections, groups and their ordered documents for these (already visibility-filtered) documents."""
    documents = list(docs)
    index = build_system_index(documents)
    flagged = {doc.id: attention(doc) for doc in documents}

    def doc_order(doc: DocumentRecord) -> tuple[bool, str, str]:
        return (not flagged[doc.id], doc.title.casefold(), doc.id)

    by_section: dict[str, list[tuple[DocumentRecord, GroupRef | None]]] = {}
    group_of: dict[str, str | None] = {}
    for doc in documents:
        group = resolve_group(doc, index, resolvers)
        by_section.setdefault(doc.type.value, []).append((doc, group))
        group_of[doc.id] = f"{doc.type.value}/{group.key}" if group is not None else None

    sections: list[SectionLayout] = []
    for section in sorted(by_section, key=section_rank):
        entries = by_section[section]
        grouped: dict[str, tuple[GroupRef, list[DocumentRecord]]] = {}
        direct: list[DocumentRecord] = []
        for doc, group in entries:
            if group is None:
                direct.append(doc)
            else:
                grouped.setdefault(group.key, (group, []))[1].append(doc)
        groups = tuple(
            GroupLayout(
                key=f"{section}/{ref.key}",
                label=ref.label,
                doc_ids=tuple(d.id for d in sorted(members, key=doc_order)),
                attention=sum(flagged[d.id] for d in members),
            )
            for ref, members in sorted(
                grouped.values(), key=lambda g: (g[0].last, g[0].label.casefold(), g[0].key)
            )
        )
        sections.append(
            SectionLayout(
                key=section,
                label=section_label(section),
                groups=groups,
                doc_ids=tuple(d.id for d in sorted(direct, key=doc_order)),
                count=len(entries),
                attention=sum(flagged[doc.id] for doc, _ in entries),
            )
        )
    return TreeLayout(
        sections=tuple(sections),
        group_of=group_of,
        systems={doc.id: document_systems(doc, index) for doc in documents},
        total=len(documents),
        attention_total=sum(flagged.values()),
    )
