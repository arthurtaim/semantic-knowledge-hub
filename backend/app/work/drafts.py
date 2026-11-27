"""«Создать задачу» from a chat phrase (design 2026-11-27 §5.3): a task DRAFT for a card. Nothing here writes.

    draft(principal, «создай задачу в проекте RAG обновить витрину до 5 декабря на Лебедеву, срочно»)
      1. server extraction (always, no model): dates (app.domain.ru_dates), a project the reader may create tasks in,
         an assignee of the directory (case endings tolerated), priority words, a fallback title
      2. the model (when the provider supports task drafts): ONE strict JSON call — suggestions only
      3. verification and merge: a date only from a verified QUOTE of the phrase (parsed by the server), a project or an
         assignee only when it matches what the reader may use; the composer's project wins; a disagreement leaves the
         field empty with a remark; a model failure leaves the server's draft with a remark
      -> TaskDraft (values + origin per field + missing + issues + context documents)

The person creates the task from the card with the regular task API; words in the chat never create anything.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from collections.abc import Sequence
from datetime import date
from typing import Any

from app.adapters.ai.base import AIProvider, AIProviderError, TaskDraftAIProvider, TaskDraftRequest
from app.adapters.ai.task_draft_protocol import TaskDraftReply, parse_task_draft
from app.authz import Action
from app.domain.models import (
    DocumentRecord,
    TaskDraft,
    TaskDraftDocument,
    TaskDraftField,
    TaskDraftIssue,
    TaskDraftOrigin,
)
from app.domain.ru_dates import DateRole, find_dates, is_past, quote_in_text
from app.domain.task_intent import trigger_span
from app.errors import ApiError
from app.work.ai import quoted_date
from app.work.calendar import in_supported_range, is_workday
from app.work.models import AssigneeRef, ProjectStatus
from app.work.permissions import WorkPrincipal
from app.work.service import WorkService

logger = logging.getLogger("skh.work.drafts")

MAX_TITLE = 120
ISSUE_TEXT: dict[str, str] = {
    "date_unverified": "Дата не найдена в вашей фразе — отброшена.",
    "date_conflict": "Дата названа неоднозначно — уточните её в карточке.",
    "date_past": "Дата в прошлом — проверьте.",
    "date_weekend": "Дата приходится на выходной — проверьте.",
    "date_out_of_range": "Дата вне допустимого диапазона — отброшена.",
    "dates_reversed": "Окончание раньше начала — уточните даты.",
    "project_conflict": "Проект назван неоднозначно — выберите его в карточке.",
    "project_unknown": "Проект из фразы не найден среди доступных — выберите проект.",
    "assignee_ambiguous": "Исполнитель назван неоднозначно — выберите его в карточке.",
    "assignee_conflict": "Исполнитель назван неоднозначно — выберите его в карточке.",
    "assistant_unparsed": "Ассистент не смог разобрать фразу — проверьте поля.",
    "assistant_unavailable": "Ассистент не ответил — черновик собран по вашей фразе, проверьте поля.",
}
_FIELD_OF_ROLE: dict[DateRole, TaskDraftField] = {"due": "due_date", "start": "start_date", "end": "end_date"}
_PRIORITY_WORDS: tuple[tuple[str, str], ...] = (
    (r"не\s+срочн\w*", "low"),
    (r"низк\w*\s+приоритет\w*|приоритет\w*\s+низк\w*", "low"),
    (r"срочн\w*|критичн\w*|критическ\w*", "critical"),
    (r"высок\w*\s+приоритет\w*|приоритет\w*\s+высок\w*|важн\w*", "high"),
)
_WORD_RE = re.compile(r"[А-Яа-яЁёA-Za-z0-9-]+")


def _issue(code: str, field: TaskDraftField | None = None) -> TaskDraftIssue:
    return TaskDraftIssue(field=field, code=code, message=ISSUE_TEXT.get(code, code))


def _norm(word: str) -> str:
    return word.casefold().replace("ё", "е")


def _stem(part: str) -> str:
    """The comparable stem of a name part: case endings dropped («Анна» → «анн», «Лебедева» → «лебеде»)."""
    word = _norm(part)
    cut = 1 if len(word) <= 5 else 2
    return word[: max(3, len(word) - cut)]


def _name_parts(display_name: str) -> list[str]:
    return [p for p in _WORD_RE.findall(display_name.replace("(демо)", "")) if len(p) >= 3]


def _matches_name(word: str, display_name: str) -> bool:
    w = _norm(word)
    return any(w.startswith(_stem(part)) and len(w) <= len(part) + 3 for part in _name_parts(display_name))


def _cut_title(text: str) -> str:
    """Whitespace collapsed, the first letter capitalised, cut at a word boundary to ≤ 120 characters."""
    words = re.sub(r"\s+([,.;:])", r"\1", " ".join(text.split())).strip(" ,.;:—–-").split(" ")
    out = ""
    for word in words:
        candidate = f"{out} {word}".strip()
        if len(candidate) > MAX_TITLE:
            break
        out = candidate
    return out[:1].upper() + out[1:] if out else ""


class TaskDraftService:
    def __init__(self, work: WorkService, ai: AIProvider) -> None:
        self._work = work
        self._ai = ai

    @property
    def uses_model(self) -> bool:
        return bool(getattr(self._ai, "supports_task_drafts", False))

    # --- what the reader may use ---------------------------------------------------------------------------
    def _projects(self, principal: WorkPrincipal) -> list[tuple[str, str]]:
        """(key, title) of open projects the reader may create tasks in (an archived or hidden one is never offered)."""
        listed = self._work.list_projects(principal)
        allowed: list[tuple[str, str]] = []
        for project in listed.items:
            if project.status == ProjectStatus.archived:
                continue
            try:
                self._work.chat_target(principal, project.key, (Action.create_task,), writable=True)
            except ApiError:
                continue
            allowed.append((project.key, project.title))
        return allowed

    def _assignees(self, principal: WorkPrincipal, project_key: str | None) -> list[AssigneeRef]:
        try:
            return self._work.assignees(principal, project_key)
        except ApiError:
            return []

    # --- the draft -----------------------------------------------------------------------------------------
    async def draft(
        self,
        principal: WorkPrincipal,
        question: str,
        *,
        project_key: str | None,
        documents: Sequence[DocumentRecord],
        auto_started: bool,
    ) -> TaskDraft:
        today = self._work._today(self._work.default_timezone)
        projects = await asyncio.to_thread(self._projects, principal)
        issues: list[TaskDraftIssue] = []
        origin: dict[TaskDraftField, TaskDraftOrigin] = {}
        found = find_dates(question, today)

        # project: the composer's choice, else the phrase, else the model's hint (verified)
        project, project_origin, project_fragment = self._project_from_text(question, projects)
        assignees = await asyncio.to_thread(self._assignees, principal, project_key or project)

        reply = await self._ask_model(question, today, projects, assignees, issues)

        if project_key is not None:
            project, project_origin = project_key, "composer"
        else:
            hinted = (
                self._match_project(reply.project_hint, projects) if reply and reply.project_hint else None
            )
            if reply and reply.project_hint and hinted is None:
                issues.append(_issue("project_unknown", "project"))
            if project is not None and hinted is not None and hinted != project:
                issues.append(_issue("project_conflict", "project"))
                project, project_origin = None, None
            elif project is None and hinted is not None:
                project, project_origin = hinted, "assistant"
        if project is not None and project_origin is not None:
            origin["project"] = project_origin  # type: ignore[assignment]

        # assignee
        assignee, assignee_fragment = self._assignee_from_text(question, assignees, issues)
        assignee_hint: str | None = None
        if reply and reply.assignee_hint:
            hinted_id = self._match_assignee(reply.assignee_hint, assignees)
            if hinted_id is not None and assignee is not None and hinted_id != assignee:
                issues.append(_issue("assignee_conflict", "assignee"))
                assignee = None
            elif hinted_id is not None and assignee is None:
                assignee = hinted_id
                origin["assignee"] = "assistant"
            elif hinted_id is None and assignee is None and quote_in_text(reply.assignee_hint, question):
                assignee_hint = reply.assignee_hint
        if assignee is not None and "assignee" not in origin:
            origin["assignee"] = "request"

        # priority: the phrase's words win; otherwise the model's
        priority, _priority_words = self._priority(question)
        if priority is not None:
            origin["priority"] = "request"
        elif reply and reply.priority in {"low", "medium", "high", "critical"}:
            priority = reply.priority
            origin["priority"] = "assistant"

        # dates
        values: dict[DateRole, date | None] = {}
        for role in ("due", "start", "end"):
            values[role] = self._date(role, found, reply, question, today, issues, origin)
        if values["start"] and values["end"] and values["start"] > values["end"]:
            issues.append(_issue("dates_reversed", "end_date"))
            values["start"] = values["end"] = None
            origin.pop("start_date", None)
            origin.pop("end_date", None)
        for role, value in values.items():
            if value is None:
                continue
            field = _FIELD_OF_ROLE[role]
            if is_past(value, today):
                issues.append(_issue("date_past", field))
            if role in ("start", "end") and not is_workday(value):
                issues.append(_issue("date_weekend", field))

        # title and description: the phrase without the trigger, the dates, «в проекте KEY» and the assignee — the
        # words before the trigger stay (they are often the subject); priority words stay too («срочные платежи»)
        span = trigger_span(question)
        fallback = f"{question[: span[0]]} {question[span[1] :]}" if span else question
        for fragment in [f.fragment for f in found] + [project_fragment, assignee_fragment]:
            if fragment:
                fallback = fallback.replace(fragment, " ")
        title = (reply.title if reply and reply.title else "") or _cut_title(fallback)
        if title:
            origin["title"] = "assistant" if reply and reply.title else "request"
        description = reply.description if reply and reply.description else ""
        if description:
            origin["description"] = "assistant"

        draft = TaskDraft(
            project_key=project,
            title=_cut_title(title) if len(title) > MAX_TITLE else title,
            description=description,
            priority=priority or "medium",
            assignee_id=assignee,
            assignee_hint=assignee_hint,
            due_date=values["due"],
            start_date=values["start"],
            end_date=values["end"],
            origin=origin,
            missing=[name for name, value in (("project", project), ("title", title)) if not value],
            issues=issues,
            documents=[
                TaskDraftDocument(document_id=d.id, title=d.title, revision=d.revision) for d in documents
            ],
            auto_started=auto_started,
            client_request_id=uuid.uuid4().hex,
        )
        logger.info(
            "task draft mode=%s fields=%d issues=%d missing=%d auto=%s",
            getattr(self._ai, "mode", "?"),
            len(origin),
            len(issues),
            len(draft.missing),
            auto_started,
        )
        return draft

    # --- pieces --------------------------------------------------------------------------------------------
    async def _ask_model(
        self,
        question: str,
        today: date,
        projects: list[tuple[str, str]],
        assignees: list[AssigneeRef],
        issues: list[TaskDraftIssue],
    ) -> TaskDraftReply | None:
        if not self.uses_model:
            return None
        provider: TaskDraftAIProvider = self._ai  # type: ignore[assignment]  # checked by `uses_model`
        request = TaskDraftRequest(
            request=question,
            today=today.isoformat(),
            projects=tuple(projects),
            assignees=tuple(a.display_name for a in assignees),
        )
        try:
            return parse_task_draft(await provider.draft_task(request))
        except AIProviderError as exc:
            issues.append(
                _issue("assistant_unparsed" if exc.code == "ai_invalid_response" else "assistant_unavailable")
            )
            logger.info("task draft model failed code=%s", exc.code)
            return None

    @staticmethod
    def _match_project(hint: str, projects: list[tuple[str, str]]) -> str | None:
        wanted = _norm(hint.strip())
        hits = [key for key, title in projects if _norm(key) == wanted or _norm(title) == wanted]
        return hits[0] if len(hits) == 1 else None

    @staticmethod
    def _project_from_text(
        text: str, projects: list[tuple[str, str]]
    ) -> tuple[str | None, str | None, str | None]:
        """A project the phrase names by key (any case) or by exact title: (key, origin, the fragment to drop)."""
        hits: dict[str, str] = {}
        for key, title in projects:
            m = re.search(rf"(?:в\s+проект[еа]?\s+)?(?<![\w-]){re.escape(key)}(?![\w-])", text, re.IGNORECASE)
            if m:
                # only «в проекте KEY» leaves the title; a bare key may be part of the subject («обновить rag индекс»)
                hits[key] = m[0] if "проект" in m[0].casefold() else ""
                continue
            if len(title) >= 4 and _norm(title) in _norm(text):
                start = _norm(text).index(_norm(title))
                hits[key] = text[start : start + len(title)]
        if len(hits) == 1:
            key, fragment = next(iter(hits.items()))
            return key, "request", fragment or None
        return None, None, None

    @staticmethod
    def _match_assignee(hint: str, assignees: list[AssigneeRef]) -> str | None:
        words = _WORD_RE.findall(hint)
        hits = {
            a.id
            for a in assignees
            if any(_matches_name(w, a.display_name) for w in words) or _norm(hint) == _norm(a.id)
        }
        return next(iter(hits)) if len(hits) == 1 else None

    @staticmethod
    def _assignee_from_text(
        text: str, assignees: list[AssigneeRef], issues: list[TaskDraftIssue]
    ) -> tuple[str | None, str | None]:
        hits: dict[str, str] = {}
        for m in _WORD_RE.finditer(text):
            word = m[0]
            if not word[:1].isupper():
                continue  # names are written with a capital letter («Анне», «на Лебедеву»)
            for a in assignees:
                if _matches_name(word, a.display_name):
                    hits.setdefault(a.id, word)
        if len(hits) > 1:
            issues.append(_issue("assignee_ambiguous", "assignee"))
            return None, None
        if len(hits) == 1:
            assignee_id, word = next(iter(hits.items()))
            named = re.search(rf"(?:на\s+)?{re.escape(word)}", text)
            return assignee_id, named[0] if named else word
        return None, None

    @staticmethod
    def _priority(text: str) -> tuple[str | None, str | None]:
        for pattern, value in _PRIORITY_WORDS:
            m = re.search(rf"(?<![А-Яа-яЁё]){pattern}", text, re.IGNORECASE)
            if m:
                return value, m[0]
        return None, None

    @staticmethod
    def _date(
        role: DateRole,
        found: Sequence[Any],
        reply: TaskDraftReply | None,
        question: str,
        today: date,
        issues: list[TaskDraftIssue],
        origin: dict[TaskDraftField, TaskDraftOrigin],
    ) -> date | None:
        field = _FIELD_OF_ROLE[role]
        server = list(dict.fromkeys(f.value for f in found if f.role == role))
        quote = getattr(reply, f"{role}_quote", None) if reply else None
        model, verified = quoted_date(quote, role, question, today)
        if not verified:
            issues.append(_issue("date_unverified", field))
        value: date | None
        if model is not None:
            if not server or model in server:
                value = model
                origin[field] = "request" if model in server else "assistant"
            else:
                issues.append(_issue("date_conflict", field))
                return None
        elif len(server) == 1:
            value = server[0]
            origin[field] = "request"
        elif len(server) > 1:
            issues.append(_issue("date_conflict", field))
            return None
        else:
            return None
        if not in_supported_range(value):
            issues.append(_issue("date_out_of_range", field))
            origin.pop(field, None)
            return None
        return value
