"""Deterministic template recommendation (M5.6.3): which ACTIVE template fits a text or a request.

Used by the import preview and by AI workflows; the model never picks a template from memory. The score is
explainable: matching section headings weigh most, then words of the title / description / document type.
Only templates with status `active` and `listed` are candidates (draft/deprecated/archived never are).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.domain.models import DocType
from app.domain.templates import DocumentTemplate
from app.domain.text import stem, tokenize

_HEADING_RE = re.compile(r"^#{2,3}\s+(.+?)\s*$", re.MULTILINE)

# Russian / English words that name a document type (the template's doc_type is a strong hint).
TYPE_WORDS: dict[DocType, tuple[str, ...]] = {
    DocType.integration: (
        "интеграц",
        "поток",
        "загрузк",
        "выгрузк",
        "integration",
        "flow",
        "pipeline",
        "cdc",
    ),
    DocType.dataset: ("датасет", "витрин", "набор", "dataset", "атрибут", "attribute"),
    DocType.source: ("источник", "систем", "source", "system"),
    DocType.decision: ("решени", "adr", "decision", "альтернатив"),
    DocType.architecture: ("архитектур", "architecture", "компонент"),
    DocType.domain: ("сущност", "entity", "модел", "domain"),
    DocType.process: ("процесс", "регламент", "process", "runbook", "инцидент", "шаг"),
    DocType.standard: ("правил", "стандарт", "качеств", "quality", "rule", "dq", "провер"),
    DocType.guide: ("руководств", "инструкц", "guide", "how", "статья", "article"),
    DocType.glossary: ("термин", "глоссари", "glossary", "term"),
}


@dataclass(frozen=True)
class TemplateMatch:
    template_id: str
    version: int
    title: str
    score: float
    reasons: tuple[str, ...]


def _stems(text: str) -> set[str]:
    return {stem(t) for t in tokenize(text) if len(t) > 2}


def recommend_templates(
    text: str, templates: dict[str, DocumentTemplate], *, limit: int = 3
) -> list[TemplateMatch]:
    """Active, listed templates ordered by fit; empty text → no recommendation (never a blind guess)."""
    words = _stems(text)
    headings = {h.strip().casefold() for h in _HEADING_RE.findall(text)}
    lowered = text.casefold()
    matches: list[TemplateMatch] = []
    for template in templates.values():
        if not template.listed or template.status != "active":
            continue
        reasons: list[str] = []
        score = 0.0
        common_headings = [
            s for s in (*template.sections, *template.optional_sections) if s.casefold() in headings
        ]
        if common_headings:
            score += 3.0 * len(common_headings)
            reasons.append("совпадают разделы: " + ", ".join(common_headings[:4]))
        type_hits = [w for w in TYPE_WORDS.get(template.doc_type, ()) if w in lowered]
        if type_hits:
            score += 2.0 * min(len(type_hits), 3)
            reasons.append("слова о типе «" + template.doc_type.value + "»: " + ", ".join(type_hits[:3]))
        own = _stems(f"{template.title} {template.description} {' '.join(template.labels)}")
        shared = sorted(words & own)
        if shared:
            score += 0.5 * min(len(shared), 6)
            reasons.append("общие слова с описанием шаблона: " + ", ".join(shared[:5]))
        if score > 0:
            matches.append(
                TemplateMatch(template.id, template.version, template.title, round(score, 2), tuple(reasons))
            )
    matches.sort(key=lambda m: (-m.score, m.template_id))
    return matches[:limit]
