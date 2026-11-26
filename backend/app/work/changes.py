"""«Предложить изменения задач» (M7, docs/WORK_CHAT_SKILLS.md): a durable, typed CHANGE-SET for EXISTING tasks.

Separate from «AI план» (app/work/ai.py, WAP — NEW tasks) and from document AI proposals: its own table
(`work_task_change_proposals`, schema v4), its own review and an atomic apply through WorkService.

    request (chat skill or POST /api/work-ai/change-proposals: project + request + optional task keys / documents)
      -> WorkService.change_context: `propose_work` + `edit_task` gate (read-only → 403) BEFORE any model call; open
         project; the named tasks (each an active task of THIS project) or the project's active tasks (bounded)
      -> AIProvider.plan_work_changes (optional capability; mock / disabled → 503 feature_unavailable) → raw text
      -> work_change_protocol.parse_work_changes (types; wrong types → 502, nothing stored)
      -> validate_changes HERE: every operation is mapped onto a task of the given list (unknown → dropped), onto the
         v1 field allowlist (title, description, status, priority, due_date; anything else → dropped with a hint to the
         Work UI), its value validated like a task edit (invalid → dropped), duplicates and no-ops dropped; `before`
         and the task version are READ BY THE SERVER, never taken from the model; nothing valid left → 422, nothing
         stored
      -> stored `suggested` (+ audit, + the idempotency receipt) — NOTHING in tasks changes
      -> a person reviews the diff, unchecks operations; preview re-reads everything and writes nothing
      -> apply: ONE transaction (WorkService.apply_task_change_set) after re-checking the plan revision, every task
         version, expiry and sources against the CURRENT state — changed → 409 proposal_stale, never merged
      -> or reject: status only.

`due_date` is a deadline, not the plan: changing it never moves `start_date` / `end_exclusive` / the Gantt.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from app.adapters.ai.base import (
    AIProvider,
    AIProviderError,
    AuthoringReference,
    WorkChangeAIProvider,
    WorkChangeRequest,
    WorkChangeTask,
    ai_error_status,
)
from app.adapters.ai.work_change_protocol import WorkChangeReply, parse_work_changes
from app.adapters.knowledge.base import KnowledgeSnapshot, RepositoryUnavailableError
from app.domain.markdown import truncate
from app.domain.models import DocumentRecord
from app.domain.safety import neutralize_citation_markers, redact_prompt_injection
from app.errors import ApiError
from app.work import store
from app.work.ai import Idempotency, request_hash
from app.work.calendar import in_supported_range
from app.work.links import DocumentScope, link_state
from app.work.models import (
    CHANGE_FIELD_LABELS,
    CHANGE_FIELDS,
    CHANGE_OPERATIONS_MAX,
    CHANGE_TASKS_MAX,
    DESCRIPTION_MAX,
    TITLE_MAX,
    ProposalIssue,
    ProposalSourceRef,
    TaskChangeOut,
    TaskPriority,
    TaskStatus,
    WorkChangeApply,
    WorkChangeApplyResult,
    WorkChangeCreate,
    WorkChangeProposalOut,
    WorkChangeSelection,
    _clean_text,
)
from app.work.permissions import WorkAccessMode, WorkPrincipal
from app.work.service import ChangeContext, TaskFieldChanges, WorkService

if TYPE_CHECKING:
    from app.services.knowledge import KnowledgeService

logger = logging.getLogger("skh.work.changes")

SCHEMA_VERSION = "work_changes.v1"
SECTION_CHARS = 1200
DESCRIPTION_EXCERPT = 300
ISSUE_TEXT: dict[str, str] = {
    "unknown_task": "Модель назвала задачу, которой нет среди переданных задач проекта, — изменение отброшено.",
    "unsupported_field": "Это поле предложением не меняется — изменение отброшено.",
    "invalid_value": "Недопустимое значение — изменение отброшено.",
    "duplicate_change": "Повторное изменение того же поля той же задачи — отброшено.",
    "no_op": "Значение уже такое — изменение не нужно.",
    "too_many_tasks": f"Изменения больше чем для {CHANGE_TASKS_MAX} задач — лишние отброшены.",
    "truncated": "Модель предложила больше изменений, чем допустимо: лишние отброшены.",
    "unsupported_request": "Модель отметила просьбу, которую предложение не выполняет.",
    "attachment_not_source": "Вложение не является документом базы знаний и не стало источником.",
}
# Where a person does what a change-set never does (v1 allowlist) — a hint, never «done».
UNSUPPORTED_HINTS: dict[str, str] = {
    "assignee": "Исполнителя меняют в карточке задачи.",
    "dates": "Даты плана меняют на диаграмме Ганта через предпросмотр расписания (срок — поле due_date).",
    "dependency": "Зависимости добавляют и удаляют в карточке задачи или на диаграмме Ганта.",
    "hierarchy": "Родительскую задачу меняют в карточке задачи.",
    "archive": "Архивируют и восстанавливают задачу в её карточке.",
}
_UNSUPPORTED_KIND: dict[str, str] = {
    "assignee": "assignee",
    "assignee_id": "assignee",
    "owner": "assignee",
    "start_date": "dates",
    "end_date": "dates",
    "end_exclusive": "dates",
    "duration_workdays": "dates",
    "estimate_workdays": "dates",
    "date_locked": "dates",
    "dependencies": "dependency",
    "dependency": "dependency",
    "predecessor": "dependency",
    "parent_task_id": "hierarchy",
    "parent": "hierarchy",
    "archived": "archive",
    "archived_at": "archive",
}


def _issue(
    code: str, *, task_key: str | None = None, severity: str = "warning", extra: str = ""
) -> ProposalIssue:
    return ProposalIssue(
        code=code,
        message=ISSUE_TEXT.get(code, code) + (f" {extra}" if extra else ""),
        local_id=task_key,
        severity="info" if severity == "info" else "warning",
    )


def _stale(reason: str, message: str) -> ApiError:
    return ApiError(409, "proposal_stale", message, {"reason": reason})


def _now_iso(now: datetime) -> str:
    return now.astimezone(UTC).isoformat()


def _safe(text: str, chars: int) -> str:
    return redact_prompt_injection(neutralize_citation_markers(truncate(text, chars)))[0]


def value_text(field_name: str, value: Any) -> str | None:
    """A field value as the change-set stores and shows it (dates ISO, enums by value)."""
    if value is None:
        return None
    if field_name == "due_date" and isinstance(value, date):
        return value.isoformat()
    return str(value)


def normalize_value(field_name: str, raw: str | None) -> str | None:
    """The proposed value validated EXACTLY like a task edit (TaskUpdate + WorkService): a ValueError when it is not
    allowed. Returns the canonical stored text (None only for a cleared due date)."""
    if field_name == "status":
        if raw not in {s.value for s in TaskStatus}:
            raise ValueError("status")
        return raw
    if field_name == "priority":
        if raw not in {p.value for p in TaskPriority}:
            raise ValueError("priority")
        return raw
    if field_name == "due_date":
        if raw is None:
            return None
        try:
            parsed = date.fromisoformat(raw.strip())
        except ValueError as exc:
            raise ValueError("due_date") from exc
        if not in_supported_range(parsed):
            raise ValueError("due_date_range")
        return parsed.isoformat()
    if raw is None:
        raise ValueError(field_name)
    if field_name == "title":  # the same cleaning as TaskUpdate (_clean_text)
        value = _clean_text(raw).strip()
        if not value or len(value) > TITLE_MAX:
            raise ValueError("title")
        return value
    if field_name == "description":
        value = _clean_text(raw)
        if len(value) > DESCRIPTION_MAX:
            raise ValueError("description")
        return value
    raise ValueError(field_name)


@dataclass
class Operation:
    operation_id: str
    task_id: str
    task_key: str
    field: str
    before: str | None
    after: str | None
    reason: str

    def as_json(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "task_id": self.task_id,
            "task_key": self.task_key,
            "field": self.field,
            "before": self.before,
            "after": self.after,
            "reason": self.reason,
        }


@dataclass
class Validated:
    operations: list[Operation]
    issues: list[ProposalIssue] = field(default_factory=list)
    notes: list[str] = field(
        default_factory=list
    )  # the model's «unsupported» notes + assumptions (unverified)


def validate_changes(reply: WorkChangeReply, ctx: ChangeContext) -> Validated:
    """Server-side checks of the model's change-set. Content problems drop the operation and become review issues;
    nothing the model wrote about a task (its id, version, current value) is trusted — only keys of the given list."""
    by_key = {t["key"]: t for t in ctx.tasks}
    out = Validated(operations=[])
    if reply.truncated:
        out.issues.append(_issue("truncated", severity="info"))
    seen: set[tuple[str, str]] = set()
    tasks: set[str] = set()
    for raw in reply.changes:
        task = by_key.get(raw.task_key)
        if task is None:
            out.issues.append(_issue("unknown_task"))  # the model's text is not echoed (no invented keys)
            continue
        if raw.field not in CHANGE_FIELDS:
            kind = _UNSUPPORTED_KIND.get(raw.field.casefold())
            hint = UNSUPPORTED_HINTS.get(kind or "", "Такие изменения делают в интерфейсе задач.")
            out.issues.append(_issue("unsupported_field", task_key=task["key"], extra=hint))
            continue
        try:
            after = normalize_value(raw.field, raw.new_value)
        except ValueError:
            label = CHANGE_FIELD_LABELS[raw.field]
            out.issues.append(_issue("invalid_value", task_key=task["key"], extra=f"({label})"))
            continue
        if (task["key"], raw.field) in seen:
            out.issues.append(_issue("duplicate_change", task_key=task["key"], severity="info"))
            continue
        before = value_text(raw.field, task[raw.field])
        if after == before:
            out.issues.append(_issue("no_op", task_key=task["key"], severity="info"))
            continue
        if task["key"] not in tasks and len(tasks) >= CHANGE_TASKS_MAX:
            out.issues.append(_issue("too_many_tasks", task_key=task["key"], severity="info"))
            continue
        if len(out.operations) >= CHANGE_OPERATIONS_MAX:
            out.issues.append(_issue("truncated", severity="info"))
            break
        seen.add((task["key"], raw.field))
        tasks.add(task["key"])
        out.operations.append(
            Operation(
                operation_id=f"op{len(out.operations) + 1}",
                task_id=task["id"],
                task_key=task["key"],
                field=raw.field,
                before=before,
                after=after,
                reason=_safe(raw.reason, 200),
            )
        )
    for note in reply.unsupported:
        out.issues.append(_issue("unsupported_request", severity="info", extra=f"«{_safe(note, 200)}»"))
    out.notes = [_safe(n, 300) for n in reply.assumptions]
    return out


class WorkChangeService:
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
    def provider(self) -> AIProvider:
        return self._ai

    @property
    def available(self) -> bool:
        return (
            bool(getattr(self._ai, "supports_work_changes", False))
            and self._work.gate.mode != WorkAccessMode.disabled
        )

    def _require_available(self) -> None:
        if not self.available:
            raise ApiError(
                503,
                "feature_unavailable",
                "Предложения изменений задач недоступны: текущий AI-провайдер их не поддерживает (без модели или "
                "отключён). Задачи можно менять вручную.",
                {"provider": self._ai.mode},
            )

    # --- propose ---------------------------------------------------------------------------------------------
    async def propose(
        self, principal: WorkPrincipal, body: WorkChangeCreate, *, idempotency: Idempotency | None = None
    ) -> WorkChangeProposalOut:
        ctx = await asyncio.to_thread(
            self._work.change_context, principal, body.project_id, body.task_keys, body.request
        )
        self._require_available()
        if idempotency is None and body.client_request_id:
            idempotency = Idempotency(
                scope=f"change_create:{ctx.project_id}",
                key=body.client_request_id,
                request_hash=request_hash(body.model_dump(mode="json", exclude={"client_request_id"})),
            )
        replayed = await asyncio.to_thread(self._replayed, principal, idempotency)
        if replayed is not None:
            return self.get(principal, replayed)
        docs = await self._documents(principal, body.document_ids)
        proposal_id = await self._generate(principal, ctx, docs, body.request, idempotency=idempotency)
        return self.get(principal, proposal_id)

    async def revise(
        self,
        principal: WorkPrincipal,
        proposal_id: str,
        instruction: str,
        *,
        idempotency: Idempotency | None = None,
    ) -> WorkChangeProposalOut:
        """A NEW change-set from a stored one (its tasks, the person's instruction, its operations as data). The
        refined change-set is never changed or applied; everything is re-checked before the model is called."""
        row = await asyncio.to_thread(self._row, principal, proposal_id)
        operations = json.loads(row["operations_json"])
        keys = list(dict.fromkeys(op["task_key"] for op in operations))
        ctx = await asyncio.to_thread(
            self._work.change_context, principal, row["project_id"], keys, instruction
        )
        self._require_available()
        if row["status"] != "suggested":
            raise _stale(
                f"already_{row['status']}",
                "Предложение уже применено или отклонено — уточнить можно только действующее; подготовьте новое.",
            )
        view = await asyncio.to_thread(self._work.change_view, principal, row["project_id"], [])
        if int(row["base_plan_revision"]) != view.plan_revision:
            raise _stale("plan_changed", "Задачи проекта изменились — подготовьте новое предложение.")
        replayed = await asyncio.to_thread(self._replayed, principal, idempotency)
        if replayed is not None:
            return self.get(principal, replayed)
        docs = await self._documents(principal, [s["document_id"] for s in json.loads(row["sources_json"])])
        previous = json.dumps(
            [{k: op[k] for k in ("task_key", "field", "after")} for op in operations], ensure_ascii=False
        )
        new_id = await self._generate(
            principal,
            ctx,
            docs,
            f"{row['request_text']}\nУточнение: {instruction}"[:4000],
            previous=previous,
            revised_from=proposal_id,
            idempotency=idempotency,
        )
        return self.get(principal, new_id)

    async def _documents(self, principal: WorkPrincipal, ids: list[str]) -> list[DocumentRecord]:
        if not ids:
            return []
        try:
            snapshot: KnowledgeSnapshot = await self._knowledge.snapshot(principal.user)
        except RepositoryUnavailableError as exc:
            raise ApiError(
                503, "knowledge_unavailable", "База знаний недоступна: документы не проверить."
            ) from exc
        docs: list[DocumentRecord] = []
        for doc_id in dict.fromkeys(ids):
            doc = None if doc_id.lower() in snapshot.duplicates else snapshot.get(doc_id)
            if doc is None:  # missing and not visible are the same answer
                raise ApiError(
                    404, "not_found", "Документ не найден или недоступен.", {"field": "document_ids"}
                )
            docs.append(doc)
        return docs

    def _replayed(self, principal: WorkPrincipal, idempotency: Idempotency | None) -> str | None:
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
        ctx: ChangeContext,
        docs: list[DocumentRecord],
        request_text: str,
        *,
        previous: str | None = None,
        revised_from: str | None = None,
        idempotency: Idempotency | None = None,
    ) -> str:
        request = WorkChangeRequest(
            project_key=ctx.project_key,
            project_title=_safe(ctx.project_title, 200),
            request=request_text,
            tasks=tuple(
                WorkChangeTask(
                    key=t["key"],
                    title=_safe(t["title"], 200),
                    status=t["status"],
                    priority=t["priority"],
                    due_date=t["due_date"],
                    description=_safe(t["description"], DESCRIPTION_EXCERPT),
                )
                for t in ctx.tasks
            ),
            references=tuple(
                AuthoringReference(
                    document_id=d.id,
                    title=d.title,
                    revision=d.revision,
                    status=d.status,
                    source_type=d.source,
                    sections=tuple(
                        (s.heading, _safe(s.text, SECTION_CHARS)) for s in d.sections if s.text.strip()
                    )
                    or (("Текст", _safe(d.body, SECTION_CHARS)),),
                    is_demo=d.is_demo,
                )
                for d in docs
            ),
            previous=previous,
            max_changes=CHANGE_OPERATIONS_MAX,
        )
        provider: WorkChangeAIProvider = self._ai  # type: ignore[assignment]  # checked by `available`
        try:
            raw = await provider.plan_work_changes(request)
            reply = parse_work_changes(raw)
        except AIProviderError as exc:
            logger.info("work change-set failed project=%s code=%s", ctx.project_key, exc.code)
            raise ApiError(ai_error_status(exc.code), exc.code, exc.message) from exc
        checked = validate_changes(reply, ctx)
        if not checked.operations:
            raise ApiError(
                422,
                "proposal_invalid",
                "Модель не предложила ни одного допустимого изменения: "
                + "; ".join(dict.fromkeys(i.message for i in checked.issues[:4]))
                if checked.issues
                else "Модель не предложила ни одного изменения.",
                {"reason": "nothing_to_propose", "issues": [i.code for i in checked.issues][:20]},
            )
        now = self._now()
        seed = f"{now.isoformat()}{principal.request_id}{request_text}{revised_from or ''}"
        proposal_id = f"WCP-{hashlib.sha256(seed.encode()).hexdigest()[:16]}"
        versions = {
            t["id"]: t["version"] for t in ctx.tasks if t["id"] in {o.task_id for o in checked.operations}
        }
        row = {
            "id": proposal_id,
            "project_id": ctx.project_id,
            "actor_id": principal.user.user_id,
            "schema_version": SCHEMA_VERSION,
            "status": "suggested",
            "provider": self._ai.mode,
            "request_text": request_text,
            "goal": _safe(reply.goal, 300),
            "base_plan_revision": ctx.plan_revision,
            "operations_json": json.dumps([o.as_json() for o in checked.operations], ensure_ascii=False),
            "task_versions_json": json.dumps(versions, ensure_ascii=False),
            "sources_json": json.dumps(
                [{"document_id": d.id, "revision": d.revision, "status": d.status.value} for d in docs],
                ensure_ascii=False,
            ),
            "issues_json": json.dumps([i.model_dump() for i in checked.issues], ensure_ascii=False),
            "assumptions_json": json.dumps(checked.notes, ensure_ascii=False),
            "revised_from": revised_from,
            "created_at": _now_iso(now),
            "expires_at": _now_iso(now + timedelta(seconds=self._ttl)),
        }
        stored_id = await asyncio.to_thread(self._store, principal, row, len(checked.operations), idempotency)
        logger.info(
            "work change-set proposal project=%s id=%s operations=%d tasks=%d issues=%d mode=%s",
            ctx.project_key,
            stored_id,
            len(checked.operations),
            len(versions),
            len(checked.issues),
            self._ai.mode,
        )
        return stored_id

    def _store(
        self, principal: WorkPrincipal, row: dict[str, Any], operations: int, idempotency: Idempotency | None
    ) -> str:
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
            store.insert_change_proposal(conn, row)
            store.insert_audit(
                conn,
                at=row["created_at"],
                actor_id=principal.user.user_id,
                operation="change_proposal_created",
                entity_type="proposal",
                entity_id=row["id"],
                project_id=row["project_id"],
                task_id=None,
                correlation_id=row["id"],
                changes={
                    "operations": operations,
                    "provider": row["provider"],
                    "schema": SCHEMA_VERSION,
                    **({"revised_from": row["revised_from"]} if row["revised_from"] else {}),
                },
            )
        return str(row["id"])

    # --- read / preview --------------------------------------------------------------------------------------
    def _row(self, principal: WorkPrincipal, proposal_id: str) -> sqlite3.Row:
        with self._work.db.read() as conn:
            row = store.get_change_proposal(conn, proposal_id)
        if row is None or row["actor_id"] != principal.user.user_id:
            raise ApiError(404, "not_found", "Предложение не найдено.")
        return row

    def _source_ref(self, src: dict[str, Any], scope: DocumentScope) -> ProposalSourceRef:
        state = link_state(scope, src.get("document_id"), src.get("revision"))
        doc = scope.get(src.get("document_id")) if state not in ("unavailable", "unverified") else None
        if doc is None:
            return ProposalSourceRef(document_id=None, revision=None, quote=None, verified=False, state=state)
        return ProposalSourceRef(
            document_id=doc.id,
            revision=src.get("revision"),
            quote=None,
            verified=False,
            title=doc.title,
            status=doc.status.value,
            state=state,
        )

    def _out(
        self, principal: WorkPrincipal, row: sqlite3.Row, selection: WorkChangeSelection | None = None
    ) -> WorkChangeProposalOut:
        operations = json.loads(row["operations_json"])
        versions: dict[str, int] = json.loads(row["task_versions_json"])
        view = self._work.change_view(principal, row["project_id"], [op["task_id"] for op in operations])
        known = {op["operation_id"] for op in operations}
        if selection is not None:
            unknown = set(selection.operation_ids) - known
            if unknown:
                raise ApiError(
                    422,
                    "proposal_invalid",
                    "В предложении нет такого изменения.",
                    {"reason": "unknown_operation", "operation_id": sorted(unknown)[0]},
                )
        chosen = set(selection.operation_ids) if selection is not None else known
        suggested = row["status"] == "suggested"
        changes: list[TaskChangeOut] = []
        reasons: list[str] = []
        for op in operations:
            task = view.tasks.get(op["task_id"])
            expected = int(versions.get(op["task_id"], 0))
            if task is None:
                state, current, version, title = "task_unavailable", None, None, None
            else:
                current = value_text(op["field"], task[op["field"]])
                version, title = int(task["version"]), _safe(str(task["title"]), 200)
                if task["archived_at"] is not None:
                    state = "task_archived"
                elif version != expected:
                    state = "task_changed"
                elif current == op["after"]:
                    state = "no_op"
                else:
                    state = "ok"
            if (
                suggested
                and state in ("task_unavailable", "task_archived", "task_changed")
                and state not in reasons
            ):
                reasons.append(state)
            changes.append(
                TaskChangeOut(
                    operation_id=op["operation_id"],
                    task_id=op["task_id"] if task is not None else None,
                    task_key=op["task_key"],
                    task_title=title,
                    field=op["field"],
                    field_label=CHANGE_FIELD_LABELS[op["field"]],
                    before=op["before"],
                    after=op["after"],
                    current=current,
                    expected_version=expected,
                    current_version=version,
                    reason=op.get("reason") or "",
                    included=op["operation_id"] in chosen,
                    state=state,
                )
            )
        scope = principal.documents or DocumentScope.unavailable()
        if suggested:
            if int(row["base_plan_revision"]) != view.plan_revision:
                reasons.insert(0, "plan_changed")
            if datetime.fromisoformat(row["expires_at"]) < self._now():
                reasons.append("expired")
            sources = json.loads(row["sources_json"])
            if sources and not scope.available:
                reasons.append("knowledge_unavailable")
            elif sources:
                for src in sources:
                    state = link_state(scope, src["document_id"], src["revision"])
                    if state == "unavailable" and "source_unavailable" not in reasons:
                        reasons.append("source_unavailable")
                    elif state == "revision_changed" and "source_changed" not in reasons:
                        reasons.append("source_changed")
        state_out = row["status"] if not suggested else ("stale" if reasons else "ready")
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        return WorkChangeProposalOut(
            id=row["id"],
            project_id=row["project_id"],
            project_key=view.project_key,
            schema_version=row["schema_version"],
            status=row["status"],
            state=state_out,
            stale_reasons=reasons,
            provider=row["provider"],
            request=row["request_text"],
            goal=row["goal"],
            base_plan_revision=int(row["base_plan_revision"]),
            current_plan_revision=view.plan_revision,
            created_at=datetime.fromisoformat(row["created_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
            decided_at=datetime.fromisoformat(row["decided_at"]) if row["decided_at"] else None,
            changes=changes,
            issues=[ProposalIssue.model_validate(i) for i in json.loads(row["issues_json"])],
            assumptions=json.loads(row["assumptions_json"]),
            sources=[self._source_ref(s, scope) for s in json.loads(row["sources_json"])],
            can_apply=state_out == "ready"
            and view.may_apply
            and any(c.included and c.state == "ok" for c in changes),
            applied_operation_ids=list(result.get("operation_ids") or []),
            applied_task_keys=list(result.get("task_keys") or []),
            revised_from=row["revised_from"],
        )

    def get(self, principal: WorkPrincipal, proposal_id: str) -> WorkChangeProposalOut:
        return self._out(principal, self._row(principal, proposal_id))

    def preview(
        self, principal: WorkPrincipal, proposal_id: str, selection: WorkChangeSelection
    ) -> WorkChangeProposalOut:
        """The change-set with only the chosen operations included, re-read from the CURRENT state; writes nothing."""
        return self._out(principal, self._row(principal, proposal_id), selection)

    # --- apply / reject --------------------------------------------------------------------------------------
    def apply(
        self, principal: WorkPrincipal, proposal_id: str, body: WorkChangeApply
    ) -> WorkChangeApplyResult:
        scope = principal.documents or DocumentScope.unavailable()
        digest = request_hash(body.model_dump(mode="json", exclude={"client_request_id"}))

        def prepare(row: Any, project: Any, current: dict[str, Any]) -> list[TaskFieldChanges]:
            if int(project["plan_revision"]) != int(
                row["base_plan_revision"]
            ) or body.expected_plan_revision != int(row["base_plan_revision"]):
                raise _stale(
                    "plan_changed",
                    "Задачи проекта изменились после подготовки предложения — подготовьте новое.",
                )
            if datetime.fromisoformat(row["expires_at"]) < self._now():
                raise _stale("expired", "Предложение устарело по времени — подготовьте новое.")
            sources = json.loads(row["sources_json"])
            if sources and not scope.available:
                raise ApiError(
                    503,
                    "knowledge_unavailable",
                    "База знаний недоступна: источники предложения не проверить.",
                )
            for src in sources:
                if link_state(scope, src["document_id"], src["revision"]) in (
                    "unavailable",
                    "revision_changed",
                ):
                    raise _stale(
                        "source_changed", "Документы-источники изменились или недоступны — подготовьте новое."
                    )
            operations = {op["operation_id"]: op for op in json.loads(row["operations_json"])}
            unknown = set(body.operation_ids) - set(operations)
            if unknown:
                raise ApiError(
                    422,
                    "proposal_invalid",
                    "В предложении нет такого изменения.",
                    {"reason": "unknown_operation", "operation_id": sorted(unknown)[0]},
                )
            versions: dict[str, int] = json.loads(row["task_versions_json"])
            grouped: dict[str, TaskFieldChanges] = {}
            for op_id in body.operation_ids:
                op = operations[op_id]
                task = current.get(op["task_id"])
                if task is None:
                    raise ApiError(404, "not_found", "Задача не найдена.", {"reason": "task_unavailable"})
                if task["archived_at"] is not None:
                    raise _stale(
                        "task_archived", "Задача перенесена в архив — подготовьте новое предложение."
                    )
                expected = int(versions[op["task_id"]])
                if int(task["version"]) != expected:
                    raise _stale(
                        "task_changed", "Задача изменена после подготовки предложения — подготовьте новое."
                    )
                try:  # the stored value is re-validated by the current rules, never trusted as stored
                    value = normalize_value(op["field"], op["after"])
                except ValueError as exc:
                    raise ApiError(
                        422,
                        "proposal_invalid",
                        "Недопустимое значение в предложении.",
                        {"reason": "invalid_value"},
                    ) from exc
                if value_text(op["field"], task[op["field"]]) == value:
                    continue  # a no-op: nothing to write for this field
                entry = grouped.setdefault(
                    op["task_id"],
                    TaskFieldChanges(
                        task_id=op["task_id"], expected_version=expected, fields={}, operation_ids=()
                    ),
                )
                entry.fields[op["field"]] = value
                grouped[op["task_id"]] = TaskFieldChanges(
                    task_id=entry.task_id,
                    expected_version=entry.expected_version,
                    fields=entry.fields,
                    operation_ids=(*entry.operation_ids, op_id),
                )
            return list(grouped.values())

        return self._work.apply_task_change_set(
            principal,
            proposal_id,
            client_request_id=body.client_request_id,
            request_hash=digest,
            prepare=prepare,
        )

    def reject(self, principal: WorkPrincipal, proposal_id: str) -> WorkChangeProposalOut:
        """Closes the change-set; no task changes. Repeating it is a 409 (already rejected), never a second event."""
        row = self._row(principal, proposal_id)
        self._work.change_view(principal, row["project_id"], [])  # the gate (propose_work)
        at = _now_iso(self._now())
        with self._work.db.write() as conn:
            if not store.decide_change_proposal(
                conn, proposal_id, "rejected", principal.user.user_id, at, None
            ):
                current = store.get_change_proposal(conn, proposal_id)
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
                operation="change_proposal_rejected",
                entity_type="proposal",
                entity_id=proposal_id,
                project_id=row["project_id"],
                task_id=None,
                correlation_id=proposal_id,
                changes={},
            )
        return self.get(principal, proposal_id)
