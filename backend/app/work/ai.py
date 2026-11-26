"""«AI план» (M6 Step 5): typed AI task-plan PROPOSALS with evidence; a person applies or rejects them.

    UI «AI план» (project + request + documents)
      -> WorkService.planning_context: the `propose_work` gate (read-only exposure / viewer → 403 BEFORE any model call)
      -> the reader's knowledge snapshot: chosen documents must be visible; otherwise approved documents found for the
         request (none → 422, no plan without evidence); references are injection-redacted, bounded
      -> AIProvider.plan_work (optional capability; mock/disabled → 503 feature_unavailable) → raw text
      -> work_protocol.parse_work_plan (types, sizes) → validate_plan here: local ids, parent hierarchy, FS DAG
         (cycle / unknown id → 422 proposal_invalid, nothing stored), sources only among the given documents with
         VERBATIM quotes, assignees / dates / task ids from the model dropped as review issues
      -> stored as `suggested` with its basis (plan revision, document revisions, provider, schema, expiry) + audit;
         NOTHING in tasks changes
      -> person reviews: edits titles / estimates / priority / assignee, drops tasks or dependencies, picks a start
         (preview recomputes dates on the server, writes nothing)
      -> apply: one transaction (WorkService.apply_task_plan) after re-checking plan revision, expiry and every source
         revision against the reader's CURRENT snapshot — changed → 409 proposal_stale, never merged silently
      -> or reject: status only, no task.

Dates are never the model's: they are computed here on the Mon–Fri calendar from the chosen start, the estimates and
the FS dependencies (no estimate → unscheduled). The model never chooses assignees (a person may, from the
directory). There is no write tool in the chat loop: a plan is created and applied only from the project UI.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from app.adapters.ai.base import (
    AIProvider,
    AIProviderError,
    AuthoringReference,
    WorkPlanningAIProvider,
    WorkPlanRequest,
    ai_error_status,
)
from app.adapters.ai.work_protocol import WorkPlanReply, parse_work_plan
from app.adapters.knowledge.base import KnowledgeSnapshot, RepositoryUnavailableError
from app.adapters.search.base import SearchFilters
from app.domain.models import DocStatus, DocumentRecord
from app.errors import ApiError
from app.services.assistant import prepare_passage_text, quote_is_verbatim
from app.work import store
from app.work.calendar import (
    MAX_YEAR,
    add_workdays,
    fs_earliest_start,
    in_supported_range,
    last_workday,
    next_workday,
)
from app.work.links import DocumentScope, link_state
from app.work.models import (
    MAX_DEPTH,
    PLAN_ESTIMATE_MAX,
    ProposalIssue,
    ProposalSourceRef,
    ProposedDependency,
    ProposedTask,
    TaskPriority,
    WorkPlanCreate,
    WorkProposalApply,
    WorkProposalApplyResult,
    WorkProposalEdits,
    WorkProposalOut,
)
from app.work.permissions import WorkAccessMode, WorkPrincipal
from app.work.service import PlannedTask, PlanningContext, PlanToApply, WorkService, check_work_date

if TYPE_CHECKING:
    from app.services.knowledge import KnowledgeService

logger = logging.getLogger("skh.work.ai")

SCHEMA_VERSION = "work_plan.v1"
AUTO_DOCUMENTS = 3
SECTION_CHARS = 1200
ISSUE_TEXT: dict[str, str] = {
    "assignee_ignored": "Модель указала исполнителя — отброшено: исполнителя выбирает человек.",
    "dates_ignored": "Модель указала даты — отброшены: даты рассчитывает сервер по календарю Пн–Пт.",
    "task_id_ignored": "Модель указала id/ключ задачи — отброшено: ключи выдаёт сервер при создании.",
    "unknown_source": "Источник, которого нет среди переданных документов, отброшен.",
    "quote_not_verified": "Цитата не найдена в документе дословно — оставлена только ссылка на документ (не подтверждена).",
    "estimate_missing": "Нет оценки — задача останется без дат (сроки не придумываются).",
    "estimate_clamped": "Оценка вне допустимых границ — приведена к границе.",
    "priority_defaulted": "Приоритет не распознан — поставлен «средний».",
    "duplicate_of_existing": "Похожая задача уже есть в проекте.",
    "duplicate_dependency": "Повторяющаяся зависимость убрана.",
    "not_approved_source": "Источник не утверждён (черновик, на ревью или устарел) — не авторитетный.",
    "predecessor_unscheduled": "Предшественник без дат — эта задача тоже без дат.",
    "no_sources": "Нет опоры в документах — это допущение модели, проверьте.",
    "truncated": "Модель предложила больше задач, чем допустимо: лишние отброшены.",
    "dates_out_of_range": f"С этой даты начала задача закончилась бы после {MAX_YEAR} года — выберите более "
    "раннее начало: применить такой план нельзя.",
}
BLOCKING_ISSUES = frozenset({"dates_out_of_range"})


def _issue(
    code: str, local_id: str | None = None, *, severity: str = "warning", extra: str = ""
) -> ProposalIssue:
    return ProposalIssue(
        code=code,
        message=ISSUE_TEXT.get(code, code) + (f" {extra}" if extra else ""),
        local_id=local_id,
        severity="info" if severity == "info" else "warning",
    )


def _invalid(reason: str, message: str, **details: Any) -> ApiError:
    return ApiError(422, "proposal_invalid", message, {"reason": reason, **details})


def _stale(reason: str, message: str) -> ApiError:
    return ApiError(409, "proposal_stale", message, {"reason": reason})


def _now_iso(now: datetime) -> str:
    return now.astimezone(UTC).isoformat()


def request_hash(payload: Any) -> str:
    """The canonical hash of an idempotent request body (same payload → same hash)."""
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


@dataclass(frozen=True)
class Idempotency:
    """One send of a chat work skill (M7): a retry with the same key and payload returns the proposal already stored.
    Kept in `work_idempotency` (scope + actor + key) in the SAME transaction as the proposal."""

    scope: str
    key: str
    request_hash: str


# --- validation of the model's reply (pure) ----------------------------------------------------------------------
@dataclass
class StoredTask:
    local_id: str
    title: str
    description: str
    priority: str
    estimate: int | None
    milestone: bool
    parent: str | None
    sources: list[dict[str, Any]] = field(default_factory=list)  # {document_id, revision, quote, verified}
    duplicate_of: str | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "local_id": self.local_id,
            "title": self.title,
            "description": self.description,
            "priority": self.priority,
            "estimate": self.estimate,
            "milestone": self.milestone,
            "parent": self.parent,
            "sources": self.sources,
            "duplicate_of": self.duplicate_of,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> StoredTask:
        return cls(
            local_id=str(data["local_id"]),
            title=str(data["title"]),
            description=str(data.get("description") or ""),
            priority=str(data.get("priority") or "medium"),
            estimate=data.get("estimate"),
            milestone=bool(data.get("milestone")),
            parent=data.get("parent"),
            sources=list(data.get("sources") or []),
            duplicate_of=data.get("duplicate_of"),
        )


def _ancestors(tasks: dict[str, StoredTask], local_id: str) -> list[str]:
    chain: list[str] = []
    current = tasks[local_id].parent
    while current is not None and current in tasks and current not in chain:
        chain.append(current)
        current = tasks[current].parent
    return chain


def find_cycle(nodes: list[str], edges: list[tuple[str, str]]) -> list[str] | None:
    """A cycle of the directed graph (as a closed path of node ids), or None — deterministic DFS in node order."""
    succ: dict[str, list[str]] = defaultdict(list)
    for a, b in edges:
        succ[a].append(b)
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(node: str) -> list[str] | None:
        state[node] = 1
        stack.append(node)
        for nxt in succ.get(node, []):
            if state.get(nxt) == 1:
                return [*stack[stack.index(nxt) :], nxt]
            if state.get(nxt) is None:
                found = visit(nxt)
                if found:
                    return found
        stack.pop()
        state[node] = 2
        return None

    for node in nodes:
        if state.get(node) is None:
            found = visit(node)
            if found:
                return found
    return None


def validate_plan(
    reply: WorkPlanReply,
    references: dict[str, DocumentRecord],
    existing: dict[str, str],
    anchor_depth: int,
) -> tuple[list[StoredTask], list[tuple[str, str]], list[ProposalIssue]]:
    """Server-side checks of the model's plan. Structural errors (ids, hierarchy, DAG) reject the WHOLE proposal
    (422, nothing stored, M6-16); content problems become review issues and are neutralised (M6-33): an unknown source
    is dropped, an unverifiable quote is dropped, assignees / dates / task ids from the model are ignored."""
    issues: list[ProposalIssue] = []
    if reply.truncated:
        issues.append(_issue("truncated", severity="info"))
    tasks: dict[str, StoredTask] = {}
    for raw in reply.tasks:
        if raw.local_id in tasks:
            raise _invalid(
                "duplicate_local_id", f"Модель повторила local_id «{raw.local_id}».", local_id=raw.local_id
            )
        for ignored in raw.ignored:
            issues.append(_issue(f"{ignored}_ignored", raw.local_id))
        priority = raw.priority if raw.priority in {p.value for p in TaskPriority} else "medium"
        if priority != raw.priority:
            issues.append(_issue("priority_defaulted", raw.local_id, severity="info"))
        estimate = raw.estimate
        if raw.milestone:
            if estimate not in (None, 0):
                issues.append(_issue("estimate_clamped", raw.local_id, severity="info"))
            estimate = 0
        elif estimate is None or estimate < 1:
            issues.append(_issue("estimate_missing", raw.local_id))
            estimate = None
        elif estimate > PLAN_ESTIMATE_MAX:
            issues.append(_issue("estimate_clamped", raw.local_id, severity="info"))
            estimate = PLAN_ESTIMATE_MAX
        sources: list[dict[str, Any]] = []
        for src in raw.sources:
            doc = references.get(src.document_id.lower())
            if doc is None:
                issues.append(_issue("unknown_source", raw.local_id))
                continue
            if any(s["document_id"] == doc.id for s in sources):
                continue
            text = "\n".join(s.text for s in doc.sections) or doc.body
            verified = len(src.quote.strip()) >= 12 and quote_is_verbatim(src.quote, text)
            if src.quote and not verified:
                issues.append(_issue("quote_not_verified", raw.local_id, extra=f"({doc.id})"))
            if doc.status != DocStatus.approved:
                issues.append(
                    _issue(
                        "not_approved_source",
                        raw.local_id,
                        severity="info",
                        extra=f"{doc.id}: {doc.status.value}.",
                    )
                )
            sources.append(
                {
                    "document_id": doc.id,
                    "revision": doc.revision,
                    "quote": src.quote if verified else None,
                    "verified": verified,
                }
            )
        if not sources:
            issues.append(_issue("no_sources", raw.local_id))
        duplicate = existing.get(raw.title.casefold())
        if duplicate:
            issues.append(_issue("duplicate_of_existing", raw.local_id, extra=f"({duplicate})"))
        tasks[raw.local_id] = StoredTask(
            local_id=raw.local_id,
            title=raw.title,
            description=raw.description,
            priority=priority,
            estimate=estimate,
            milestone=raw.milestone,
            parent=raw.parent_local_id,
            sources=sources,
            duplicate_of=duplicate,
        )
    # hierarchy
    for task in tasks.values():
        if task.parent is None:
            continue
        if task.parent == task.local_id or task.parent not in tasks:
            raise _invalid(
                "unknown_parent", f"Задача {task.local_id}: неизвестный parent_local_id «{task.parent}»."
            )
        if tasks[task.parent].milestone:
            raise _invalid("milestone_parent", f"У вехи {task.parent} не может быть подзадач.")
    parent_cycle = find_cycle(list(tasks), [(t.parent, t.local_id) for t in tasks.values() if t.parent])
    if parent_cycle:
        raise _invalid("parent_cycle", "Иерархия задач в предложении замкнута в цикл.", cycle=parent_cycle)
    for task in tasks.values():
        if anchor_depth + 1 + len(_ancestors(tasks, task.local_id)) > MAX_DEPTH:
            raise _invalid("too_deep", f"Допустимо не более {MAX_DEPTH} уровней вложенности.")
    # dependencies: FS DAG between proposed tasks only
    deps: list[tuple[str, str]] = []
    for pred, succ in reply.dependencies:
        if pred not in tasks or succ not in tasks:
            raise _invalid(
                "unknown_task_in_dependency",
                "Зависимость ссылается на задачу, которой нет в предложении.",
                dependency=[pred, succ],
            )
        if pred == succ:
            raise _invalid("self_dependency", f"Задача {pred} зависит от самой себя.")
        if pred in _ancestors(tasks, succ) or succ in _ancestors(tasks, pred):
            raise _invalid(
                "hierarchy_dependency", f"Зависимость {pred} → {succ} между задачей и её родителем."
            )
        if (pred, succ) in deps:
            issues.append(_issue("duplicate_dependency", succ, severity="info"))
            continue
        deps.append((pred, succ))
    cycle = find_cycle(list(tasks), deps)
    if cycle:
        raise _invalid(
            "dependency_cycle",
            "Зависимости в предложении образуют цикл: " + " → ".join(cycle) + ".",
            cycle=cycle,
        )
    return list(tasks.values()), deps, issues


# --- materialising a stored plan (edits + server-side dates, pure) -----------------------------------------------
@dataclass
class Materialized:
    tasks: list[ProposedTask]
    dependencies: list[tuple[str, str]]
    issues: list[ProposalIssue]
    start: date | None


def materialize(
    stored: list[StoredTask], deps: list[tuple[str, str]], start: date | None, edits: WorkProposalEdits | None
) -> Materialized:
    by_id = {t.local_id: replace(t) for t in stored}
    included = {t.local_id: True for t in stored}
    assignees: dict[str, str | None] = {}
    if edits is not None:
        for edit in edits.tasks:
            task = by_id.get(edit.local_id)
            if task is None:
                raise _invalid("unknown_local_id", f"В предложении нет задачи «{edit.local_id}».")
            included[edit.local_id] = edit.include
            if edit.title is not None:
                task.title = edit.title
            if edit.description is not None:
                task.description = edit.description
            if edit.priority is not None:
                task.priority = edit.priority.value
            if edit.estimate_workdays is not None:
                if task.milestone and edit.estimate_workdays != 0:
                    raise _invalid(
                        "milestone_estimate", f"У вехи {task.local_id} нет длительности (оценка 0)."
                    )
                task.estimate = (
                    edit.estimate_workdays if task.milestone or edit.estimate_workdays > 0 else None
                )
            if "assignee_id" in edit.model_fields_set:
                assignees[edit.local_id] = edit.assignee_id
        dropped = {(d.predecessor, d.successor) for d in edits.excluded_dependencies}
        unknown = dropped - set(deps)
        if unknown:
            raise _invalid(
                "unknown_dependency", "В предложении нет такой зависимости.", dependency=sorted(unknown)[0]
            )
        deps = [d for d in deps if d not in dropped]
        if "start_date" in edits.model_fields_set:
            start = edits.start_date
            check_work_date(start, "start_date")
    # an excluded task drops its dependencies; its subtasks move up to the nearest included ancestor
    for task in by_id.values():
        parent = task.parent
        while parent is not None and not included.get(parent, False):
            parent = by_id[parent].parent if parent in by_id else None
        task.parent = parent
    keep = [t for t in stored if included[t.local_id]]
    kept_ids = {t.local_id for t in keep}
    deps = [d for d in deps if d[0] in kept_ids and d[1] in kept_ids]
    dates, issues = plan_dates([by_id[t.local_id] for t in keep], deps, start)
    tasks = [
        ProposedTask(
            local_id=t.local_id,
            title=by_id[t.local_id].title,
            description=by_id[t.local_id].description,
            priority=TaskPriority(by_id[t.local_id].priority),
            estimate_workdays=by_id[t.local_id].estimate,
            is_milestone=t.milestone,
            parent_local_id=by_id[t.local_id].parent if t.local_id in kept_ids else None,
            assignee_id=assignees.get(t.local_id),
            sources=[
                ProposalSourceRef(
                    document_id=s["document_id"],
                    revision=s["revision"],
                    quote=s["quote"],
                    verified=bool(s["verified"]),
                )
                for s in t.sources
            ],
            duplicate_of=t.duplicate_of,
            start_date=dates.get(t.local_id, (None, None))[0],
            end_exclusive=dates.get(t.local_id, (None, None))[1],
            last_day=_last_day(dates.get(t.local_id), t.milestone),
            included=included[t.local_id],
        )
        for t in stored
    ]
    return Materialized(tasks=tasks, dependencies=deps, issues=issues, start=start)


def _last_day(interval: tuple[date | None, date | None] | None, milestone: bool) -> date | None:
    if interval is None or interval[0] is None or interval[1] is None or milestone:
        return None
    return last_workday(interval[0], interval[1])


def plan_dates(
    tasks: list[StoredTask], deps: list[tuple[str, str]], start: date | None
) -> tuple[dict[str, tuple[date | None, date | None]], list[ProposalIssue]]:
    """Forward FS pass on the Mon–Fri calendar from `start` (Kahn, proposal order for ties). No start → nothing is
    scheduled; no estimate → unscheduled; an unscheduled predecessor leaves its successors unscheduled too."""
    if start is None:
        return {}, []
    order = {t.local_id: i for i, t in enumerate(tasks)}
    preds: dict[str, list[str]] = defaultdict(list)
    indegree = {t.local_id: 0 for t in tasks}
    succs: dict[str, list[str]] = defaultdict(list)
    for a, b in deps:
        preds[b].append(a)
        succs[a].append(b)
        indegree[b] += 1
    ready = sorted((t for t, n in indegree.items() if n == 0), key=order.__getitem__)
    by_id = {t.local_id: t for t in tasks}
    dates: dict[str, tuple[date | None, date | None]] = {}
    issues: list[ProposalIssue] = []
    base = next_workday(start)
    while ready:
        local = ready.pop(0)
        task = by_id[local]
        earliest = base
        blocked = False
        for p in preds[local]:
            _start, p_end = dates.get(p, (None, None))
            if p_end is None:
                blocked = True
                break
            earliest = max(earliest, fs_earliest_start(p_end))
        if blocked:
            dates[local] = (None, None)
            issues.append(_issue("predecessor_unscheduled", local, severity="info"))
        elif task.milestone:
            dates[local] = (earliest, earliest)
        elif task.estimate is None:
            dates[local] = (None, None)
        else:
            dates[local] = (earliest, add_workdays(earliest, task.estimate))
        first, end = dates[local]
        if (
            first is not None
            and end is not None
            and not (in_supported_range(first) and in_supported_range(end))
        ):
            dates[local] = (None, None)  # its successors become «predecessor_unscheduled»
            issues.append(_issue("dates_out_of_range", local))
        for nxt in succs[local]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                ready.append(nxt)
                ready.sort(key=order.__getitem__)
    return dates, issues


# --- the service --------------------------------------------------------------------------------------------------
class WorkAiService:
    def __init__(
        self,
        work: WorkService,
        knowledge: KnowledgeService,
        ai: AIProvider,
        *,
        ttl_seconds: int = 86_400,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._work = work
        self._knowledge = knowledge
        self._ai = ai
        self._ttl = ttl_seconds
        self._now: Callable[[], datetime] = now or (lambda: datetime.now(UTC))

    @property
    def available(self) -> bool:
        return (
            bool(getattr(self._ai, "supports_work_planning", False))
            and self._work.gate.mode != WorkAccessMode.disabled
        )

    def _require_available(self) -> None:
        if not self.available:
            raise ApiError(
                503,
                "feature_unavailable",
                "AI-планирование недоступно: текущий AI-провайдер его не поддерживает (без модели или отключён). "
                "Задачи, доска и Гант работают как обычно.",
                {"provider": self._ai.mode},
            )

    @property
    def provider(self) -> AIProvider:
        return self._ai

    # --- propose ---------------------------------------------------------------------------------------------
    async def propose(
        self, principal: WorkPrincipal, body: WorkPlanCreate, *, idempotency: Idempotency | None = None
    ) -> WorkProposalOut:
        """A new task-plan proposal. `idempotency` (the M7 chat: one send = one key) makes a retry return the proposal
        already stored instead of a second one — checked BEFORE the model is called."""
        # The gate first: read-only exposure, viewers and non-members never reach the model (M6-20).
        ctx = await asyncio.to_thread(
            self._work.planning_context, principal, body.project_id, body.parent_task_id
        )
        self._require_available()
        check_work_date(body.start_date, "start_date")  # before the model: a refused input costs nothing
        replayed = await asyncio.to_thread(self._replayed, principal, idempotency)
        if replayed is not None:
            return self.get(principal, replayed)
        snapshot = await self._snapshot(principal)
        docs = self._documents(snapshot, body)
        proposal_id = await self._generate(
            principal,
            ctx,
            docs,
            request_text=body.request,
            start_date=body.start_date,
            idempotency=idempotency,
        )
        return self.get(principal, proposal_id)

    async def revise(
        self,
        principal: WorkPrincipal,
        proposal_id: str,
        instruction: str,
        *,
        idempotency: Idempotency | None = None,
    ) -> WorkProposalOut:
        """M7 multi-turn refinement: a NEW proposal from the stored one (its validated plan + the SAME sources) and the
        person's instruction. The refined proposal is never changed, re-interpreted or applied. Everything it was based
        on is re-checked BEFORE the model is called: owner (foreign → 404), project gate (read-only → 403), status
        (applied / rejected → 409), plan revision, expiry, every source revision (changed / unavailable → 409)."""
        row = await asyncio.to_thread(self._row, principal, proposal_id)
        ctx = await asyncio.to_thread(
            self._work.planning_context, principal, row["project_id"], row["parent_task_id"]
        )
        self._require_available()
        if row["status"] != "suggested":
            raise _stale(
                f"already_{row['status']}",
                "Предложение уже применено или отклонено — уточнить можно только действующее; подготовьте новое.",
            )
        scope = principal.documents or DocumentScope.unavailable()
        reasons = self._stale_reasons(row, ctx.plan_revision, scope)
        if "knowledge_unavailable" in reasons:
            raise ApiError(
                503, "knowledge_unavailable", "База знаний недоступна: источники предложения не проверить."
            )
        if reasons:
            raise _stale(
                reasons[0],
                "Предложение устарело (изменился план проекта, источники или срок действия) — уточнять его нельзя; "
                "подготовьте новое.",
            )
        replayed = await asyncio.to_thread(self._replayed, principal, idempotency)
        if replayed is not None:
            return self.get(principal, replayed)
        snapshot = await self._snapshot(principal)
        docs: list[DocumentRecord] = []
        for src in json.loads(row["sources_json"]):
            doc = snapshot.get(src["document_id"])
            if doc is None or doc.revision != src["revision"]:  # re-checked: never a silently newer source
                raise _stale(
                    "source_changed", "Документы-источники изменились — подготовьте новое предложение."
                )
            docs.append(doc)
        stored, deps = self._plan(row)
        previous = json.dumps(
            {
                "goal": row["goal"],
                "tasks": [
                    {
                        "local_id": t.local_id,
                        "title": t.title,
                        "description": t.description[:300],
                        "estimate_workdays": t.estimate,
                        "priority": t.priority,
                        "milestone": t.milestone,
                        "parent_local_id": t.parent,
                        "sources": [
                            {"document_id": src["document_id"], "quote": src["quote"]}
                            for src in t.sources
                            if src.get("verified") and src.get("quote")
                        ],
                    }
                    for t in stored
                ],
                "dependencies": [{"predecessor": a, "successor": b} for a, b in deps],
            },
            ensure_ascii=False,
        )
        new_id = await self._generate(
            principal,
            ctx,
            docs,
            request_text=row["request_text"],
            start_date=date.fromisoformat(row["start_date"]) if row["start_date"] else None,
            refinement=instruction,
            previous_plan=previous,
            revised_from=proposal_id,
            idempotency=idempotency,
        )
        return self.get(principal, new_id)

    async def _snapshot(self, principal: WorkPrincipal) -> KnowledgeSnapshot:
        try:
            return await self._knowledge.snapshot(principal.user)
        except RepositoryUnavailableError as exc:
            raise ApiError(
                503, "knowledge_unavailable", "База знаний недоступна: план без документов не готовится."
            ) from exc

    def _replayed(self, principal: WorkPrincipal, idempotency: Idempotency | None) -> str | None:
        """The proposal a previous send with the same idempotency key stored (same payload), or None; a reused key
        with another payload is 409 (never the wrong proposal)."""
        if idempotency is None:
            return None
        with self._work.db.read() as conn:
            row = store.get_idempotent(conn, idempotency.scope, principal.user.user_id, idempotency.key)
        if row is None:
            return None
        if row["request_hash"] != idempotency.request_hash:
            raise ApiError(
                409,
                "conflict",
                "client_request_id уже использован для другого запроса.",
                {"reason": "idempotency_key_reused"},
            )
        return str(json.loads(row["response_json"])["proposal_id"])

    async def _generate(
        self,
        principal: WorkPrincipal,
        ctx: PlanningContext,
        docs: list[DocumentRecord],
        *,
        request_text: str,
        start_date: date | None,
        refinement: str | None = None,
        previous_plan: str | None = None,
        revised_from: str | None = None,
        idempotency: Idempotency | None = None,
    ) -> str:
        """ONE model call → strict parse → `validate_plan` → stored `suggested` proposal (+ audit, + the idempotency
        receipt in the same transaction). Structural errors store nothing (422); a model failure stores nothing."""
        references = tuple(
            AuthoringReference(
                document_id=d.id,
                title=d.title,
                revision=d.revision,
                status=d.status,
                source_type=d.source,
                sections=tuple(
                    (s.heading, prepare_passage_text(s.text[:SECTION_CHARS])[0])
                    for s in d.sections
                    if s.text.strip()
                )
                or (("Текст", prepare_passage_text(d.body[:SECTION_CHARS])[0]),),
                is_demo=d.is_demo,
            )
            for d in docs
        )
        request = WorkPlanRequest(
            project_key=ctx.project_key,
            project_title=ctx.project_title,
            request=request_text,
            start_date=start_date.isoformat() if start_date else None,
            existing_tasks=tuple(ctx.existing),
            references=references,
            refinement=refinement,
            previous_plan=previous_plan,
        )
        provider: WorkPlanningAIProvider = self._ai  # type: ignore[assignment]  # checked by `available`
        try:
            raw = await provider.plan_work(request)
            reply = parse_work_plan(raw)
        except AIProviderError as exc:
            logger.info("work ai plan failed project=%s code=%s", ctx.project_key, exc.code)
            raise ApiError(ai_error_status(exc.code), exc.code, exc.message) from exc
        existing = {title.casefold(): key for key, title in ctx.existing}
        stored, deps, issues = validate_plan(
            reply, {d.id.lower(): d for d in docs}, existing, ctx.anchor[2] if ctx.anchor else 0
        )
        now = self._now()
        seed = f"{now.isoformat()}{principal.request_id}{request_text}{refinement or ''}{revised_from or ''}"
        proposal_id = f"WAP-{hashlib.sha256(seed.encode()).hexdigest()[:16]}"
        row = {
            "id": proposal_id,
            "project_id": ctx.project_id,
            "actor_id": principal.user.user_id,
            "kind": "task_plan",
            "schema_version": SCHEMA_VERSION,
            "status": "suggested",
            "provider": self._ai.mode,
            "request_text": request_text
            if refinement is None
            else f"{request_text}\nУточнение: {refinement}"[:4000],
            "goal": reply.goal,
            "parent_task_id": ctx.anchor[0] if ctx.anchor else None,
            "start_date": start_date.isoformat() if start_date else None,
            "base_plan_revision": ctx.plan_revision,
            "sources_json": json.dumps(
                [{"document_id": d.id, "revision": d.revision, "status": d.status.value} for d in docs],
                ensure_ascii=False,
            ),
            "plan_json": json.dumps(
                {"tasks": [t.as_json() for t in stored], "dependencies": [list(d) for d in deps]},
                ensure_ascii=False,
            ),
            "issues_json": json.dumps([i.model_dump() for i in issues], ensure_ascii=False),
            "assumptions_json": json.dumps(reply.assumptions + reply.warnings, ensure_ascii=False),
            "created_at": _now_iso(now),
            "expires_at": _now_iso(now + timedelta(seconds=self._ttl)),
            "revised_from": revised_from,
        }
        stored_id = await asyncio.to_thread(self._store, principal, row, len(stored), len(deps), idempotency)
        logger.info(
            "work ai proposal project=%s id=%s tasks=%d deps=%d issues=%d mode=%s revised=%s",
            ctx.project_key,
            stored_id,
            len(stored),
            len(deps),
            len(issues),
            self._ai.mode,
            bool(revised_from),
        )
        return stored_id

    def _documents(self, snapshot: KnowledgeSnapshot, body: WorkPlanCreate) -> list[DocumentRecord]:
        docs: list[DocumentRecord] = []
        for doc_id in dict.fromkeys(body.document_ids):
            doc = None if doc_id.lower() in snapshot.duplicates else snapshot.get(doc_id)
            if doc is None:  # missing and not visible are the same answer
                raise ApiError(
                    404, "not_found", "Документ не найден или недоступен.", {"field": "document_ids"}
                )
            docs.append(doc)
        if docs:
            return docs
        retrieval = self._knowledge.retrieval
        analysis = retrieval.analyze(body.request)
        hits = retrieval.rank_documents(
            snapshot, analysis, SearchFilters(statuses=frozenset({"approved"})), AUTO_DOCUMENTS
        )
        docs = [d for h in hits if (d := snapshot.get(h.document_id)) is not None]
        if not docs:
            raise _invalid(
                "no_sources",
                "По запросу не найдено утверждённых документов: выберите документы явно — план без опоры не готовится.",
            )
        return docs

    def _store(
        self,
        principal: WorkPrincipal,
        row: dict[str, Any],
        tasks: int,
        deps: int,
        idempotency: Idempotency | None = None,
    ) -> str:
        """Stores the proposal (+ audit, + the idempotency receipt) in ONE transaction; returns its id — or, when a
        concurrent send with the same key won the race, the id that send stored (this one is not written)."""
        with self._work.db.write() as conn:
            if idempotency is not None:
                previous = store.get_idempotent(
                    conn, idempotency.scope, principal.user.user_id, idempotency.key
                )
                if previous is not None and previous["request_hash"] == idempotency.request_hash:
                    return str(json.loads(previous["response_json"])["proposal_id"])
                if previous is not None:
                    raise ApiError(
                        409,
                        "conflict",
                        "client_request_id уже использован для другого запроса.",
                        {"reason": "idempotency_key_reused"},
                    )
                store.put_idempotent(
                    conn,
                    scope=idempotency.scope,
                    actor_id=principal.user.user_id,
                    key=idempotency.key,
                    request_hash=idempotency.request_hash,
                    status_code=201,
                    response={"proposal_id": row["id"]},
                    at=row["created_at"],
                )
            store.insert_proposal(conn, row)
            store.insert_audit(
                conn,
                at=row["created_at"],
                actor_id=principal.user.user_id,
                operation="proposal_created",
                entity_type="proposal",
                entity_id=row["id"],
                project_id=row["project_id"],
                task_id=None,
                correlation_id=row["id"],
                changes={
                    "tasks": tasks,
                    "dependencies": deps,
                    "provider": row["provider"],
                    "schema": SCHEMA_VERSION,
                    **({"revised_from": row["revised_from"]} if row.get("revised_from") else {}),
                },
            )
        return str(row["id"])

    # --- read / preview --------------------------------------------------------------------------------------
    def _row(self, principal: WorkPrincipal, proposal_id: str) -> Any:
        with self._work.db.read() as conn:
            row = store.get_proposal(conn, proposal_id)
        if row is None or row["actor_id"] != principal.user.user_id:
            raise ApiError(404, "not_found", "Предложение не найдено.")
        return row

    @staticmethod
    def _plan(row: Any) -> tuple[list[StoredTask], list[tuple[str, str]]]:
        plan = json.loads(row["plan_json"])
        return [StoredTask.from_json(t) for t in plan["tasks"]], [(a, b) for a, b in plan["dependencies"]]

    def _stale_reasons(self, row: Any, plan_revision: int, scope: DocumentScope) -> list[str]:
        reasons: list[str] = []
        if int(row["base_plan_revision"]) != plan_revision:
            reasons.append("plan_changed")
        if datetime.fromisoformat(row["expires_at"]) < self._now():
            reasons.append("expired")
        if not scope.available:
            reasons.append("knowledge_unavailable")
            return reasons
        for src in json.loads(row["sources_json"]):
            state = link_state(scope, src["document_id"], src["revision"])
            if state == "unavailable" and "source_unavailable" not in reasons:
                reasons.append("source_unavailable")
            elif state == "revision_changed" and "source_changed" not in reasons:
                reasons.append("source_changed")
        return reasons

    def _source_ref(self, src: dict[str, Any], scope: DocumentScope) -> ProposalSourceRef:
        state = link_state(scope, src.get("document_id"), src.get("revision"))
        doc = scope.get(src.get("document_id")) if state not in ("unavailable", "unverified") else None
        if doc is None:  # nothing about a document the reader cannot see now
            return ProposalSourceRef(document_id=None, revision=None, quote=None, verified=False, state=state)
        return ProposalSourceRef(
            document_id=doc.id,
            revision=src.get("revision"),
            quote=src.get("quote"),
            verified=bool(src.get("verified", True)),
            title=doc.title,
            status=doc.status.value,
            state=state,
        )

    def _out(
        self, principal: WorkPrincipal, row: Any, edits: WorkProposalEdits | None = None
    ) -> WorkProposalOut:
        scope = principal.documents or DocumentScope.unavailable()
        view = self._work.proposal_view(principal, row["project_id"], row["parent_task_id"])
        stored, deps = self._plan(row)
        start = date.fromisoformat(row["start_date"]) if row["start_date"] else None
        built = materialize(stored, deps, start, edits)
        for task in built.tasks:
            task.sources = [self._source_ref(s.model_dump(), scope) for s in task.sources]
        reasons = self._stale_reasons(row, view.plan_revision, scope) if row["status"] == "suggested" else []
        state = row["status"] if row["status"] != "suggested" else ("stale" if reasons else "ready")
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        issues = [ProposalIssue.model_validate(i) for i in json.loads(row["issues_json"])] + built.issues
        return WorkProposalOut(
            id=row["id"],
            project_id=row["project_id"],
            project_key=view.project_key,
            schema_version=row["schema_version"],
            status=row["status"],
            state=state,
            stale_reasons=reasons,
            provider=row["provider"],
            request=row["request_text"],
            goal=row["goal"],
            start_date=built.start,
            parent_task_id=row["parent_task_id"],
            parent_task_key=view.parent_key,
            base_plan_revision=int(row["base_plan_revision"]),
            current_plan_revision=view.plan_revision,
            created_at=datetime.fromisoformat(row["created_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
            decided_at=datetime.fromisoformat(row["decided_at"]) if row["decided_at"] else None,
            tasks=built.tasks,
            dependencies=[ProposedDependency(predecessor=a, successor=b) for a, b in built.dependencies],
            sources=[self._source_ref(s, scope) for s in json.loads(row["sources_json"])],
            assumptions=json.loads(row["assumptions_json"]),
            issues=issues,
            can_apply=state == "ready"
            and view.may_apply
            and any(t.included for t in built.tasks)
            and not any(i.code in BLOCKING_ISSUES for i in built.issues),
            applied_task_keys=list((result.get("task_keys") or {}).values()),
            revised_from=row["revised_from"],
        )

    def get(self, principal: WorkPrincipal, proposal_id: str) -> WorkProposalOut:
        return self._out(principal, self._row(principal, proposal_id))

    def preview(
        self, principal: WorkPrincipal, proposal_id: str, edits: WorkProposalEdits
    ) -> WorkProposalOut:
        """The reviewed plan as it WOULD be created (dates recomputed on the server); writes nothing."""
        return self._out(principal, self._row(principal, proposal_id), edits)

    # --- apply / reject --------------------------------------------------------------------------------------
    def apply(
        self, principal: WorkPrincipal, proposal_id: str, body: WorkProposalApply
    ) -> WorkProposalApplyResult:
        scope = principal.documents or DocumentScope.unavailable()
        request_hash = hashlib.sha256(
            json.dumps(body.model_dump(mode="json", exclude={"client_request_id"}), sort_keys=True).encode()
        ).hexdigest()

        def prepare(row: Any, project: Any) -> PlanToApply:
            if int(project["plan_revision"]) != int(
                row["base_plan_revision"]
            ) or body.expected_plan_revision != int(row["base_plan_revision"]):
                raise _stale(
                    "plan_changed", "План проекта изменился после подготовки предложения — подготовьте новое."
                )
            if datetime.fromisoformat(row["expires_at"]) < self._now():
                raise _stale("expired", "Предложение устарело по времени — подготовьте новое.")
            reasons = self._stale_reasons(row, int(project["plan_revision"]), scope)
            if "knowledge_unavailable" in reasons:
                raise ApiError(
                    503,
                    "knowledge_unavailable",
                    "База знаний недоступна: источники предложения не проверить.",
                )
            if reasons:
                raise _stale(
                    reasons[0],
                    "Документы-источники изменились или недоступны — подготовьте новое предложение.",
                )
            stored, deps = self._plan(row)
            start = date.fromisoformat(row["start_date"]) if row["start_date"] else None
            built = materialize(stored, deps, start, body)
            chosen = [t for t in built.tasks if t.included]
            if not chosen:
                raise _invalid("nothing_to_apply", "Не выбрано ни одной задачи.")
            if any(i.code in BLOCKING_ISSUES for i in built.issues):
                raise ApiError(
                    422,
                    "invalid_date_range",
                    f"С этой даты начала план заканчивается после {MAX_YEAR} года — выберите более раннюю дату.",
                    {"reason": "plan_out_of_range", "field": "start_date"},
                )
            return PlanToApply(
                tasks=tuple(
                    PlannedTask(
                        local_id=t.local_id,
                        title=t.title,
                        description=t.description,
                        priority=t.priority.value,
                        estimate=t.estimate_workdays,
                        milestone=t.is_milestone,
                        parent_local_id=t.parent_local_id,
                        assignee_id=t.assignee_id,
                        start=t.start_date,
                        end=t.end_exclusive,
                        sources=tuple(
                            (s.document_id, s.revision)
                            for s in t.sources
                            if s.document_id and s.revision and s.verified
                        ),
                    )
                    for t in chosen
                ),
                dependencies=tuple(built.dependencies),
                anchor_id=row["parent_task_id"],
            )

        return self._work.apply_task_plan(
            principal,
            proposal_id,
            client_request_id=body.client_request_id,
            request_hash=request_hash,
            prepare=prepare,
        )

    def reject(self, principal: WorkPrincipal, proposal_id: str) -> WorkProposalOut:
        row = self._row(principal, proposal_id)
        self._work.proposal_view(principal, row["project_id"], None)  # the gate (propose_work)
        at = _now_iso(self._now())
        with self._work.db.write() as conn:
            if not store.decide_proposal(conn, proposal_id, "rejected", principal.user.user_id, at, None):
                current = store.get_proposal(conn, proposal_id)
                raise ApiError(
                    409,
                    "proposal_stale",
                    "Предложение уже применено или отклонено.",
                    {"reason": f"already_{current['status'] if current else 'gone'}"},
                )
            store.insert_audit(
                conn,
                at=at,
                actor_id=principal.user.user_id,
                operation="proposal_rejected",
                entity_type="proposal",
                entity_id=proposal_id,
                project_id=row["project_id"],
                task_id=None,
                correlation_id=proposal_id,
                changes={},
            )
        return self.get(principal, proposal_id)
