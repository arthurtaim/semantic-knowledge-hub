"""Assistant skills (UI v2, docs/ui-v2/specs/02_ASSISTANT.md §4): named scenarios with an explicit right.

A skill is a thin, declarative layer ON TOP of the existing M5.6.3 scenarios (`ProposalKind` in
`app/services/ai_workflows.py`) and the grounded `ask` pipeline — nothing is re-implemented here. The backend
serves the list (`GET /api/assistant/skills`); the UI never hard-codes it. A "draft" skill never applies
anything: it produces an AI proposal (accepted item by item) or a draft that goes to review.

This module is pure data (it is imported by `app.domain.models`, so it must not import it back).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

SkillAccess = Literal["read", "draft"]
# How a skill runs: through the grounded ask pipeline, or through one M5.6.3 workflow (AiWorkflowService).
SkillRunner = Literal["ask", "workflow"]

AI_DISABLED_REASON = "ИИ отключён"


@dataclass(frozen=True)
class SkillDefinition:
    id: str
    name: str
    description: str
    access: SkillAccess
    runner: SkillRunner
    builds_on: tuple[str, ...]  # the existing scenario(s): "ask" or ProposalKind values
    requires_document: bool = False
    requires_selection: bool = False
    requires_attachment: bool = False
    # Either a chosen document (or a selection in one) or a question of at least 3 characters.
    requires_document_or_question: bool = False
    prompt_optional: bool = False
    needs_authoring: bool = False  # the provider must support draft_document
    # None: the deterministic mock provider serves the skill honestly (verbatim / rule-based output).
    mock_unavailable_reason: str | None = None


SKILLS: tuple[SkillDefinition, ...] = (
    SkillDefinition(
        id="answer",
        name="Ответ по базе знаний",
        description="Отвечает только по документам, с цитатами",
        access="read",
        runner="ask",
        builds_on=("ask",),
    ),
    SkillDefinition(
        id="explain",
        name="Объяснить",
        description="Объяснит выделенный фрагмент или документ по утверждённым источникам",
        access="read",
        runner="ask",
        builds_on=("explain",),
        requires_document=True,
        prompt_optional=True,
    ),
    SkillDefinition(
        id="summarize",
        name="Кратко пересказать",
        description="Коротко перескажет документ или выделенный фрагмент",
        access="read",
        runner="workflow",
        builds_on=("summarize",),
        requires_document=True,
        prompt_optional=True,
    ),
    SkillDefinition(
        id="check_completeness",
        name="Проверить полноту",
        description="Сверит документ с его шаблоном: недостающие разделы, поля и ссылки",
        access="read",
        runner="workflow",
        builds_on=("check_completeness",),
        requires_document=True,
        prompt_optional=True,
    ),
    SkillDefinition(
        id="check_freshness",
        name="Что перепроверить",
        description="Покажет связанные документы, которые могли устареть",
        access="read",
        runner="workflow",
        builds_on=("impact_analysis",),
        requires_document=True,
        prompt_optional=True,
    ),
    SkillDefinition(
        id="find_related",
        name="Найти связи",
        description="Покажет связанные документы и путь на карте знаний",
        access="read",
        runner="workflow",
        builds_on=("find_related", "explain_relation"),
        requires_document_or_question=True,
        prompt_optional=True,
    ),
    SkillDefinition(
        id="compare_with_file",
        name="Сравнить с файлом",
        description="Сверит вложение с утверждёнными документами",
        access="read",
        runner="ask",
        builds_on=("ask",),
        requires_attachment=True,
        prompt_optional=True,
    ),
    SkillDefinition(
        id="draft_document",
        name="Черновик документа",
        description="Подберёт шаблон и подготовит черновик на ревью",
        access="draft",
        runner="workflow",
        builds_on=("draft_from_prompt",),
        needs_authoring=True,
    ),
    SkillDefinition(
        id="improve_section",
        name="Улучшить раздел",
        description="Предложит новую формулировку раздела; применяется только после вашего решения",
        access="draft",
        runner="workflow",
        builds_on=("improve_section",),
        requires_document=True,
        requires_selection=True,
        prompt_optional=True,
        mock_unavailable_reason="Нет языковой модели (режим mock): переписать раздел нельзя.",
    ),
    SkillDefinition(
        id="suggest_metadata",
        name="Предложить метаданные",
        description="Подскажет теги, краткое описание и связанные документы",
        access="draft",
        runner="workflow",
        builds_on=("suggest_metadata",),
        requires_document=True,
        prompt_optional=True,
    ),
)
SKILL_BY_ID: dict[str, SkillDefinition] = {s.id: s for s in SKILLS}
DEFAULT_SKILL = "answer"


class SkillRequires(BaseModel):
    document: bool = False  # a chosen document (context_document_ids[0]) or a selection in one
    selection: bool = False
    attachment: bool = False
    # «One of»: a chosen document / selection OR a question (≥ 3 characters). Additive: false for older skills.
    document_or_question: bool = False


class SkillInfo(BaseModel):
    """API shape of a skill (GET /api/assistant/skills)."""

    id: str
    name: str
    description: str
    access: SkillAccess
    requires: SkillRequires
    prompt_optional: bool
    available: bool
    unavailable_reason: str | None = None


def unavailable_reason(skill: SkillDefinition, mode: str, supports_authoring: bool) -> str | None:
    """Why the skill cannot run with the current AI mode (None: available)."""
    if mode == "disabled":
        return AI_DISABLED_REASON
    if mode == "mock" and skill.mock_unavailable_reason:
        return skill.mock_unavailable_reason
    if skill.needs_authoring and not supports_authoring:
        return "Провайдер ИИ не поддерживает подготовку черновиков."
    return None


def skill_info(skill: SkillDefinition, mode: str, supports_authoring: bool) -> SkillInfo:
    reason = unavailable_reason(skill, mode, supports_authoring)
    return SkillInfo(
        id=skill.id,
        name=skill.name,
        description=skill.description,
        access=skill.access,
        requires=SkillRequires(
            document=skill.requires_document,
            selection=skill.requires_selection,
            attachment=skill.requires_attachment,
            document_or_question=skill.requires_document_or_question,
        ),
        prompt_optional=skill.prompt_optional,
        available=reason is None,
        unavailable_reason=reason,
    )
