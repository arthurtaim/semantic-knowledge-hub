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
# How a skill runs: through the grounded ask pipeline, through one M5.6.3 workflow (AiWorkflowService), or — M7 chat
# work skills (docs/WORK_CHAT_SKILLS.md) — over the M6 work module: `work_read` reads facts (WorkInspector),
# `work_plan` creates a task-plan PROPOSAL (WorkAiService, WAP), `work_change` a change-set PROPOSAL for existing
# tasks (WorkChangeService, WCP). No runner applies anything: tasks change only through an explicit review UI.
SkillRunner = Literal["ask", "workflow", "work_read", "work_plan", "work_change"]
WORK_RUNNERS: frozenset[str] = frozenset({"work_read", "work_plan", "work_change"})

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
    # M7: a project chosen explicitly (`AskRequest.work_context.project_key`) — never guessed by the server.
    requires_project: bool = False
    needs_work_planning: bool = False  # the provider must support plan_work (M6 «AI план»)
    needs_work_changes: bool = False  # the provider must support plan_work_changes (M7 change-set)

    @property
    def is_work(self) -> bool:
        return self.runner in WORK_RUNNERS


@dataclass(frozen=True)
class WorkSkillState:
    """What the server knows about the work module for THIS request before a project is chosen (M7): the module is
    on, the global policy and the work gate let this principal view / propose, the provider's capabilities. Per-project
    rights (membership roles) are checked again on every request with the chosen project."""

    enabled: bool = False
    may_view: bool = False
    may_propose: bool = False
    read_only_reason: str | None = None
    supports_planning: bool = False
    supports_changes: bool = False


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
    # --- M7: chat work skills over the M6 work module (docs/WORK_CHAT_SKILLS.md) -----------------------------------
    SkillDefinition(
        id="analyze_project",
        name="Проанализировать проект",
        description="Разберёт сроки, просрочки, ожидания и вехи проекта по данным модуля задач; ничего не меняет",
        access="read",
        runner="work_read",
        builds_on=("work_inspect",),
        prompt_optional=True,
        requires_project=True,
    ),
    SkillDefinition(
        id="draft_task_plan",
        name="Составить план задач",
        description="Подготовит предложение новых задач по документам; задачи создаются только после вашей "
        "проверки в проекте",
        access="draft",
        runner="work_plan",
        builds_on=("work_plan",),
        requires_project=True,
        needs_work_planning=True,
        mock_unavailable_reason="Нет языковой модели (режим mock): план задач не готовится.",
    ),
    SkillDefinition(
        id="propose_task_changes",
        name="Предложить изменения задач",
        description="Предложит новые статус, приоритет, срок или текст существующих задач; применяется только "
        "после вашего подтверждения",
        access="draft",
        runner="work_change",
        builds_on=("work_changes",),
        requires_project=True,
        needs_work_changes=True,
        mock_unavailable_reason="Нет языковой модели (режим mock): изменения задач не предлагаются.",
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
    # M7 (additive): a project chosen in the composer (`work_context.project_key`); the server never picks one.
    project: bool = False


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
    # M7 (additive): the skill works over the work module (projects and tasks), not over documents only.
    work: bool = False


def _work_reason(skill: SkillDefinition, work: WorkSkillState | None) -> str | None:
    state = work or WorkSkillState()
    if not state.enabled:
        return "Модуль задач отключён."
    if skill.runner == "work_read":
        return None if state.may_view else "Нет прав на просмотр задач."
    if not state.may_propose:
        return state.read_only_reason or "Нет прав предлагать изменения задач."
    if skill.needs_work_planning and not state.supports_planning:
        return "Провайдер ИИ не поддерживает планирование задач."
    if skill.needs_work_changes and not state.supports_changes:
        return "Провайдер ИИ не поддерживает предложения изменений задач."
    return None


def work_denied(skill: SkillDefinition, work: WorkSkillState | None) -> tuple[int, str, str] | None:
    """A work skill refused for the module or the reader's rights — (HTTP status, code, message) — checked BEFORE the
    provider: a read-only exposure or a missing right is 403 like the work API, a disabled module 503."""
    state = work or WorkSkillState()
    if not state.enabled:
        return 503, "feature_unavailable", "Модуль задач отключён."
    if skill.runner == "work_read":
        return None if state.may_view else (403, "forbidden", "Нет прав на просмотр задач.")
    if not state.may_propose:
        return 403, "forbidden", state.read_only_reason or "Нет прав предлагать изменения задач."
    return None


def unavailable_reason(
    skill: SkillDefinition, mode: str, supports_authoring: bool, work: WorkSkillState | None = None
) -> str | None:
    """Why the skill cannot run with the current AI mode (and, for a work skill, the work module and the reader's
    rights before a project is chosen); None: available."""
    if mode == "disabled":
        return AI_DISABLED_REASON
    if mode == "mock" and skill.mock_unavailable_reason:
        return skill.mock_unavailable_reason
    if skill.needs_authoring and not supports_authoring:
        return "Провайдер ИИ не поддерживает подготовку черновиков."
    if skill.is_work:
        return _work_reason(skill, work)
    return None


def skill_info(
    skill: SkillDefinition, mode: str, supports_authoring: bool, work: WorkSkillState | None = None
) -> SkillInfo:
    reason = unavailable_reason(skill, mode, supports_authoring, work)
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
            project=skill.requires_project,
        ),
        prompt_optional=skill.prompt_optional,
        available=reason is None,
        unavailable_reason=reason,
        work=skill.is_work,
    )
