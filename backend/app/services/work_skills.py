"""M7 chat work skills (docs/WORK_CHAT_SKILLS.md): the in-app assistant works with M6 projects and tasks through the
SAME services, rights and review screens as the «Работа» section. Nothing here writes a task.

    POST /api/assistant/ask {skill_id, question, work_context{project_key, task_keys, proposal_id, client_request_id}}
      -> route: the global Action (view_tasks | propose_work) + the work principal (ONE builder with api/work.py)
      -> resolve(): the project and the tasks in the READER's scope (404 = unknown or hidden, 403 read-only exposure,
         409 archived for a proposal); a referenced proposal must be the reader's own, of this skill and this project —
         all BEFORE any model call
      -> analyze_project (work_read): WorkInspector facts (`skh_work`, the same as the `work_inspect` tool) → the tool
         loop narrates them with [F] markers; without a tool-capable model a summary composed BY THE SERVER, labelled so
      -> draft_task_plan (work_plan): WorkAiService.propose / .revise → a stored WAP `suggested` (no task) → a card that
         opens the existing Project review (/projects/KEY?proposal=WAP-…), where a person applies it
      -> propose_task_changes (work_change): WorkChangeService.propose / .revise → a stored WCP `suggested` (no task
         changes) → a card that opens the change review (/projects/KEY?changes=WCP-…): diff, selection, explicit apply.

Words in the chat («да», «принимаю», «сделай») are never an Apply: there is no write path from /ask, and there is no
work write tool in the model loop.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.authz import Action, AuthorizationPolicy
from app.domain.assistant_tools import WORK_TOOL, WorkInspectArgs
from app.domain.markdown import truncate
from app.domain.models import (
    AskRequest,
    AskResponse,
    AskWorkContext,
    SystemFact,
    UserContext,
    WorkProposalRef,
)
from app.domain.safety import neutralize_citation_markers
from app.domain.skills import SkillDefinition, WorkSkillState
from app.errors import ApiError, is_storage_busy
from app.services.assistant import AskExtras, AssistantService
from app.services.assistant_loop import SeededCall
from app.services.assistant_tools import ToolResult, work_inspect_result
from app.work.ai import Idempotency, WorkAiService, request_hash
from app.work.changes import WorkChangeService
from app.work.inspect import WorkInspector
from app.work.models import WorkChangeCreate, WorkPlanCreate
from app.work.permissions import WorkAccessMode, WorkPrincipal
from app.work.service import ChatTarget, WorkService

if TYPE_CHECKING:
    from app.services.knowledge import KnowledgeService
    from app.services.skills import AskPlan

logger = logging.getLogger("skh.work.chat")

MAX_TASK_FACTS = 3  # tasks named in the composer that get their own fact in an analysis
LIST_IN_ANSWER = 10
PLAN_TITLES_IN_ANSWER = 8
SERVER_SUMMARY_NOTE = "Ответ составлен сервером по данным модуля задач без языковой модели: только вычисленные факты, без выводов."
WORK_DRAFT_NOTE = (
    "Навык подготовил ПРЕДЛОЖЕНИЕ: в задачах ничего не изменено. Откройте его, проверьте и подтвердите отдельной "
    "кнопкой; слова в чате («да», «принимаю») ничего не применяют."
)
ATTACHMENT_NOTE = (
    "Вложение не является документом базы знаний: план опирается только на документы базы. Чтобы опереться на "
    "конкретный документ, выберите его через «@»."
)
_STATE_WORDS = {
    "ready": "готово к проверке",
    "stale": "устарело",
    "applied": "применено",
    "rejected": "отклонено",
}


@dataclass(frozen=True)
class WorkAsk:
    """The resolved work target of one chat turn (server-side; never from the client)."""

    principal: WorkPrincipal
    target: ChatTarget
    proposal_id: str | None
    client_request_id: str | None


def _action_of(skill: SkillDefinition) -> tuple[Action, ...]:
    if skill.runner == "work_read":
        return (Action.view_tasks,)
    if skill.runner == "work_change":
        return (Action.propose_work, Action.edit_task)
    return (Action.propose_work,)


def global_actions(skill: SkillDefinition) -> tuple[Action, ...]:
    """The global Actions a work skill needs (the route checks them with the AuthorizationPolicy)."""
    return _action_of(skill)


class WorkChatSkills:
    def __init__(
        self,
        *,
        work: WorkService,
        work_ai: WorkAiService,
        changes: WorkChangeService,
        inspector: WorkInspector,
        knowledge: KnowledgeService,
        assistant: AssistantService,
        policy: AuthorizationPolicy,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._work = work
        self._work_ai = work_ai
        self._changes = changes
        self._inspector = inspector
        self._knowledge = knowledge
        self._assistant = assistant
        self._policy = policy
        self._clock = clock

    # --- availability (the skill catalog) ------------------------------------------------------------------------
    def state(self, principal: WorkPrincipal | None) -> WorkSkillState:
        enabled = self._work.gate.mode != WorkAccessMode.disabled
        if principal is None or not enabled:
            return WorkSkillState(enabled=enabled)
        user = principal.user
        may_view = self._policy.allows(user, Action.view_tasks) and self._work.may(
            principal, Action.view_tasks
        )
        may_propose = self._policy.allows(user, Action.propose_work) and self._work.may(
            principal, Action.propose_work
        )
        return WorkSkillState(
            enabled=True,
            may_view=may_view,
            may_propose=may_propose,
            read_only_reason=self._work.gate.reason(principal) if not may_propose else None,
            supports_planning=self._work_ai.available,
            supports_changes=self._changes.available,
        )

    # --- server-side checks before any model call ----------------------------------------------------------------
    def resolve(
        self, skill: SkillDefinition, principal: WorkPrincipal, ctx: AskWorkContext | None
    ) -> WorkAsk:
        """Runs in a worker thread (SQLite reads). Raises the HTTP errors of the work API (404 / 403 / 409 / 422)."""
        context = ctx or AskWorkContext()
        if not context.project_key:
            raise ApiError(
                422,
                "work_project_required",
                f"Выберите проект: навык «{skill.name}» работает с одним явно выбранным проектом.",
                {"skill_id": skill.id},
            )
        target = self._work.chat_target(
            principal,
            context.project_key,
            _action_of(skill),
            context.task_keys,
            writable=skill.runner != "work_read",
        )
        if context.proposal_id is not None:
            prefix = context.proposal_id[:3]
            wanted = {"work_plan": "WAP", "work_change": "WCP"}.get(skill.runner)
            if prefix != wanted:
                raise ApiError(
                    422,
                    "work_context_invalid",
                    "Это предложение не относится к выбранному навыку: план задач уточняется навыком «Составить план "
                    "задач», изменения — навыком «Предложить изменения задач».",
                    {"skill_id": skill.id},
                )
            project_of = self._proposal_project(principal, context.proposal_id)
            if (
                project_of != target.project_id
            ):  # another project's proposal: the same answer as a foreign one
                raise ApiError(404, "not_found", "Предложение не найдено в этом проекте.")
        return WorkAsk(
            principal=principal,
            target=target,
            proposal_id=context.proposal_id,
            client_request_id=context.client_request_id,
        )

    def _proposal_project(self, principal: WorkPrincipal, proposal_id: str) -> str:
        if proposal_id.startswith("WAP-"):
            return str(self._work_ai._row(principal, proposal_id)["project_id"])
        return str(self._changes._row(principal, proposal_id)["project_id"])

    # --- running -------------------------------------------------------------------------------------------------
    async def run(self, user: UserContext, plan: AskPlan) -> AskResponse:
        work = plan.work
        assert work is not None  # plan() resolved it for every work skill
        logger.info(
            "chat work skill=%s project=%s tasks=%d proposal=%s",
            plan.skill.id,
            work.target.project_key,
            len(work.target.task_keys),
            work.proposal_id or "-",
        )
        if plan.skill.runner == "work_read":
            return await self._analyze(user, plan, work)
        if plan.skill.runner == "work_plan":
            return await self._task_plan(plan, work)
        return await self._task_changes(plan, work)

    async def run_stream(self, user: UserContext, plan: AskPlan) -> AsyncGenerator[dict[str, Any], None]:
        """NDJSON events: bounded status stages and exactly ONE terminal `final` or `error`. A proposal is stored
        before `final` is sent; a client that disconnects later finds it in the project (and a retry with the same
        client_request_id returns it, never a second one)."""
        work = plan.work
        assert work is not None
        if plan.skill.runner == "work_read" and self._uses_tools():
            seed = await self._seed(user, work)
            if seed is None:
                yield _error(_work_unavailable())
                return
            request, extras = self._analysis_inputs(plan, work, seed)
            async with contextlib.aclosing(self._assistant.ask_stream(user, request, extras)) as events:
                async for event in events:
                    yield event
            return
        yield {"type": "status", "stage": "retrieving", "step": "work"}
        if plan.skill.runner != "work_read":
            yield {"type": "status", "stage": "generating", "provider": self._assistant.provider.mode}
        try:
            response = await self.run(user, plan)
        except ApiError as exc:
            yield _error(exc)
            return
        except Exception as exc:
            if is_storage_busy(exc):
                yield _error(
                    ApiError(503, "storage_busy", "Хранилище занято — повторите запрос через пару секунд.")
                )
                return
            raise
        yield {"type": "status", "stage": "validating"}
        yield {"type": "final", "response": response.model_dump(mode="json")}

    # --- analyze_project -----------------------------------------------------------------------------------------
    def _uses_tools(self) -> bool:
        return self._assistant.tools_available

    async def _seed(self, user: UserContext, work: WorkAsk) -> list[SeededCall] | None:
        """The server's own read-only inspection of the chosen project (+ the chosen tasks): exactly the facts the
        `work_inspect` tool returns. None when the project's plan cannot be read now."""
        calls: list[WorkInspectArgs] = [
            WorkInspectArgs(operation="get_project_schedule", project=work.target.project_key)
        ]
        calls += [
            WorkInspectArgs(operation="get_task", task=key) for key in work.target.task_keys[:MAX_TASK_FACTS]
        ]
        seeded: list[SeededCall] = []
        for args in calls:
            try:
                result = await work_inspect_result(
                    self._inspector,
                    self._knowledge,
                    user,
                    args,
                    ref=f"F{len(seeded) + 1}",
                    as_of=self._clock(),
                )
            except ApiError:
                if args.operation == "get_project_schedule":
                    return None
                continue  # a task that vanished since resolve(): not named, not guessed
            seeded.append(
                SeededCall(
                    name=WORK_TOOL,
                    arguments=args.model_dump(mode="json", exclude_defaults=True),
                    result=result,
                )
            )
        return seeded

    def _analysis_inputs(
        self, plan: AskPlan, work: WorkAsk, seed: list[SeededCall]
    ) -> tuple[AskRequest, AskExtras]:
        key = work.target.project_key
        question = plan.request.question.strip() or (
            "Проанализируй состояние проекта: сроки, просрочки, ожидания предшественников, задачи без дат и вехи."
        )
        request = plan.request.model_copy(
            update={"question": f"Проект {key}. {question}"[:2000], "sources": ["team"], "work_context": None}
        )
        extras = AskExtras(skill=plan.skill_ref, tool_seed=tuple(seed), retrieval=False)
        return request, extras

    async def _analyze(self, user: UserContext, plan: AskPlan, work: WorkAsk) -> AskResponse:
        seed = await self._seed(user, work)
        if seed is None:
            raise _work_unavailable()
        if self._uses_tools():
            request, extras = self._analysis_inputs(plan, work, seed)
            return await self._assistant.ask(user, request, extras)
        return self._server_summary(plan, work, [s.result for s in seed])

    def _server_summary(self, plan: AskPlan, work: WorkAsk, results: list[ToolResult]) -> AskResponse:
        """Without a tool-capable model: the facts themselves, as text composed by the SERVER (no inference)."""
        facts: list[SystemFact] = [r.fact for r in results if r.fact is not None]
        lines: list[str] = []
        schedule = results[0]
        fact = schedule.fact
        assert fact is not None
        p = schedule.payload
        counts = p["counts"]
        by_status = ", ".join(f"{k} {v}" for k, v in sorted(counts["by_status"].items())) or "нет задач"
        lines.append(
            f"Проект {p['project']}: ревизия плана {p['plan_revision']}, «сегодня» {p['today']} [{fact.ref}]."
        )
        lines.append(f"- Задач: {counts['tasks']} ({by_status}).")
        lines.append(_listed("Просрочено", counts["overdue"], [t["key"] for t in p["overdue"]], fact.ref))
        lines.append(_listed("Отстают от плана", counts["late"], [t["key"] for t in p["late"]], fact.ref))
        lines.append(
            _listed(
                "Ждут предшественников (FS)",
                counts["waiting_for_predecessors"],
                [f"{t['key']} ← {', '.join(t['waits_for'])}" for t in p["waiting"]],
                fact.ref,
            )
        )
        lines.append(_listed("Без дат", counts["unscheduled"], list(p["unscheduled"]), fact.ref))
        milestones = [f"{m['key']} {m['date']}" for m in p["next_milestones"]]
        lines.append(_listed("Открытые вехи", counts["milestones_open"], milestones, fact.ref))
        lines.append(f"- Нарушенных зависимостей FS: {counts['violated_dependencies']} [{fact.ref}].")
        lines.append("Критический путь модуль задач не рассчитывает — он здесь не указан.")
        for result in results[1:]:
            task_fact = result.fact
            if task_fact is None:
                continue
            t = result.payload["task"]
            waits = ", ".join(t.get("waits_for") or []) or "нет"
            due = t.get("due") or "не задан"
            documents = len(t.get("documents") or [])
            lines.append(
                f"- {t['key']} «{t['title']}»: статус {t['status']}, приоритет {t['priority']}, срок {due}, ждёт: "
                f"{waits}, связанных документов: {documents} [{task_fact.ref}]."
            )
        response = AskResponse(
            answer="\n".join(lines),
            mode=self._assistant.provider.mode,
            confidence="supported",
            citations=[],
            warnings=[SERVER_SUMMARY_NOTE],
            instructions_version=self._assistant.instructions_version,
            skill=plan.skill_ref,
            system_facts=facts,
        )
        response.conversation_context = self._assistant._conversation_context(facts)
        return response

    # --- draft_task_plan -----------------------------------------------------------------------------------------
    def _idempotency(self, plan: AskPlan, work: WorkAsk, scope: str) -> Idempotency | None:
        if not work.client_request_id:
            return None
        payload = {
            "skill": plan.skill.id,
            "project": work.target.project_id,
            "question": plan.request.question,
            "documents": [d.id for d in plan.documents],
            "tasks": list(work.target.task_keys),
            "proposal": work.proposal_id,
        }
        return Idempotency(scope=scope, key=work.client_request_id, request_hash=request_hash(payload))

    async def _task_plan(self, plan: AskPlan, work: WorkAsk) -> AskResponse:
        idempotency = self._idempotency(plan, work, f"chat_plan:{work.target.project_id}")
        if work.proposal_id is not None:
            out = await self._work_ai.revise(
                work.principal, work.proposal_id, plan.request.question.strip(), idempotency=idempotency
            )
        else:
            body = WorkPlanCreate(
                project_id=work.target.project_id,
                request=plan.request.question.strip(),
                document_ids=[d.id for d in plan.documents],
            )
            out = await self._work_ai.propose(work.principal, body, idempotency=idempotency)
        included = [t for t in out.tasks if t.included]
        titles = [
            f"{i}. {neutralize_citation_markers(truncate(t.title, 120))}"
            for i, t in enumerate(included[:PLAN_TITLES_IN_ANSWER], start=1)
        ]
        sources = [s.document_id for s in out.sources if s.document_id]
        head = (
            f"Подготовлено НОВОЕ предложение плана {out.id} — уточнение {out.revised_from} (оно не изменено)"
            if out.revised_from
            else f"Подготовлено предложение плана {out.id}"
        )
        lines = [
            f"{head} для проекта {out.project_key}: задач {len(included)}, зависимостей FS {len(out.dependencies)}"
            + (f", источники: {', '.join(sources)}." if sources else "."),
            "Задачи НЕ созданы. Предложенные задачи:",
            *titles,
        ]
        if len(included) > PLAN_TITLES_IN_ANSWER:
            lines.append(f"… и ещё {len(included) - PLAN_TITLES_IN_ANSWER} (все — в предложении).")
        warnings = [i for i in out.issues if i.severity == "warning"]
        if warnings:
            lines.append(f"Замечаний для проверки: {len(warnings)} — они показаны в предложении.")
        lines.append(
            "Откройте «Проверить план»: там можно поправить названия, оценки, исполнителей и зависимости, посмотреть "
            "даты и только затем нажать «Создать задачи»."
        )
        notes = [WORK_DRAFT_NOTE]
        if plan.attachments and not plan.documents:
            notes.append(ATTACHMENT_NOTE)
        return AskResponse(
            answer="\n".join(lines),
            mode=self._assistant.provider.mode,
            confidence="partial",
            citations=[],
            warnings=notes,
            instructions_version=self._assistant.instructions_version,
            skill=plan.skill_ref,
            work_proposal=WorkProposalRef(
                kind="task_plan",
                id=out.id,
                project_key=out.project_key,
                state=out.state,
                app_path=f"/projects/{out.project_key}?proposal={out.id}",
                task_count=len(included),
                dependency_count=len(out.dependencies),
                revised_from=out.revised_from,
            ),
        )

    # --- propose_task_changes ------------------------------------------------------------------------------------
    async def _task_changes(self, plan: AskPlan, work: WorkAsk) -> AskResponse:
        idempotency = self._idempotency(plan, work, f"chat_changes:{work.target.project_id}")
        if work.proposal_id is not None:
            out = await self._changes.revise(
                work.principal, work.proposal_id, plan.request.question.strip(), idempotency=idempotency
            )
        else:
            body = WorkChangeCreate(
                project_id=work.target.project_id,
                request=plan.request.question.strip(),
                task_keys=list(work.target.task_keys),
                document_ids=[d.id for d in plan.documents],
            )
            out = await self._changes.propose(work.principal, body, idempotency=idempotency)
        rows = [
            f"- {c.task_key} · {c.field_label}: {_shown(c.before)} → {_shown(c.after)}"
            for c in out.changes[:LIST_IN_ANSWER]
        ]
        head = (
            f"Подготовлено НОВОЕ предложение изменений {out.id} — уточнение {out.revised_from} (оно не изменено)"
            if out.revised_from
            else f"Подготовлено предложение изменений {out.id}"
        )
        lines = [
            f"{head} для проекта {out.project_key}: изменений {len(out.changes)} в задачах "
            f"{len({c.task_key for c in out.changes})}. Задачи НЕ изменены. «Было» прочитано из задач сервером:",
            *rows,
        ]
        if len(out.changes) > LIST_IN_ANSWER:
            lines.append(f"… и ещё {len(out.changes) - LIST_IN_ANSWER} (все — в предложении).")
        dropped = [i for i in out.issues if i.severity == "warning"]
        if dropped:
            lines.append(f"Отброшено или требует внимания: {len(dropped)} — подробности в предложении.")
        lines.append(
            "Откройте «Проверить изменения»: снимите лишние пункты и подтвердите «Применить изменения» — всё "
            "применится одной операцией или не применится ничего."
        )
        return AskResponse(
            answer="\n".join(lines),
            mode=self._assistant.provider.mode,
            confidence="partial",
            citations=[],
            warnings=[WORK_DRAFT_NOTE],
            instructions_version=self._assistant.instructions_version,
            skill=plan.skill_ref,
            work_proposal=WorkProposalRef(
                kind="task_changes",
                id=out.id,
                project_key=out.project_key,
                state=out.state,
                app_path=f"/projects/{out.project_key}?changes={out.id}",
                change_count=len(out.changes),
                revised_from=out.revised_from,
            ),
        )


def _shown(value: str | None) -> str:
    if value is None:
        return "—"
    text = neutralize_citation_markers(truncate(" ".join(value.split()), 80))
    return f"«{text}»"


def _listed(label: str, total: int, items: list[str], ref: str) -> str:
    if not total:
        return f"- {label}: 0 [{ref}]."
    shown = items[:LIST_IN_ANSWER]
    more = f" (показаны {len(shown)} из {total})" if total > len(shown) else ""
    return f"- {label}: {total} — {', '.join(shown)}{more} [{ref}]."


def _work_unavailable() -> ApiError:
    return ApiError(
        503,
        "work_unavailable",
        "Данные модуля задач сейчас недоступны: анализ не выполнен (ничего не придумано).",
    )


def _error(exc: ApiError) -> dict[str, Any]:
    return {"type": "error", "code": exc.code, "message": exc.message, "status": exc.status_code}
