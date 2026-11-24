"""Synthetic demo projects for M6 (docs/WORK_MANAGEMENT.md «Демо-данные»). Idempotent and isolated:

- every demo project has a `seed_key`; if it exists the project is skipped ENTIRELY — the seed never updates,
  deletes or re-creates anything, so the operator's edits of demo tasks and all user projects stay untouched;
- a demo project whose key is already taken by a user project is skipped (reported), never merged;
- ids are deterministic (uuid5 of the seed key), rows carry `is_demo = 1`, titles/descriptions say «демо»;
- dates are laid out relative to the Monday three weeks before «today» with a forward FS pass, so the seeded plan
  has no FS violations, has finished, running, late and future work, milestones, a locked and unscheduled tasks;
- all names are fictional roles, no real people, systems or bank data.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.work import store
from app.work.calendar import CALENDAR_ID, add_workdays, fs_earliest_start, last_workday, shift_workdays
from app.work.db import WorkDatabase

SEED_ACTOR = "system:demo-seed"
_NAMESPACE = uuid.UUID("6f1d3c2e-9a57-4f0b-8f61-5d2a4c9b7e10")


@dataclass(frozen=True)
class _T:
    local: str
    title: str
    status: str = "todo"
    priority: str = "medium"
    parent: str | None = None
    assignee: str | None = None
    offset: int | None = None  # earliest start, working days after the anchor; None = unscheduled
    days: int = 0  # working days; 0 with milestone=True
    after: tuple[str, ...] = ()
    milestone: bool = False
    locked: bool = False
    due: str | int | None = None  # "end" = the planned last day; int = working days after the anchor
    estimate: int | None = None
    description: str = ""


@dataclass(frozen=True)
class _P:
    seed_key: str
    key: str
    title: str
    description: str
    tasks: tuple[_T, ...] = field(default_factory=tuple)


_DEMO = "Синтетические демо-данные SKH (ДЕМО-ДАННЫЕ): вымышленные задачи и роли, не факты о банке."

PROJECTS: tuple[_P, ...] = (
    _P(
        "demo:aris-metadata-integration",
        "ARIS",
        "ARIS Metadata Integration (демо)",
        f"Интеграция метаданных моделей ARIS в каталог SKH: анализ, маппинг, загрузчик, проверка. {_DEMO}",
        (
            _T("a1", "Анализ источника ARIS", "done", "high", None, "demo-analyst", 0, 6),
            _T("a1.1", "Инвентаризация моделей ARIS", "done", "medium", "a1", "demo-analyst", 0, 3),
            _T("a1.2", "Интервью с владельцами процессов", "done", "medium", "a1", "demo-owner", 3, 3),
            _T("a1.2.1", "Подготовить опросник для интервью", "done", "low", "a1.2", "demo-analyst", 0, 2),
            _T("a2", "Маппинг метаданных", "in_progress", "high", None, "demo-architect", 6, 12),
            _T(
                "a2.1",
                "Сопоставить атрибуты моделей",
                "in_progress",
                "high",
                "a2",
                "demo-architect",
                6,
                8,
                after=("a1.1",),
                due="end",
                description="Сопоставление атрибутов моделей ARIS с полями каталога. Задача **отстаёт** от плана.",
            ),
            _T(
                "a2.2",
                "Описать правила трансформации",
                "in_progress",
                "medium",
                "a2",
                "demo-architect",
                0,
                5,
                after=("a2.1",),
            ),
            _T(
                "a2.2.1",
                "Правила для справочников",
                "in_progress",
                "medium",
                "a2.2",
                "demo-engineer",
                0,
                4,
                after=("a2.1",),
            ),
            _T(
                "a2.2.1.1",
                "Проверить коды справочника ролей",
                "done",
                "low",
                "a2.2.1",
                "demo-qa",
                0,
                1,
                after=("a2.1",),
            ),
            _T(
                "am1",
                "Маппинг согласован",
                "todo",
                "high",
                None,
                "demo-owner",
                0,
                0,
                after=("a2.2",),
                milestone=True,
            ),
            _T(
                "a3",
                "Разработка загрузчика метаданных",
                "todo",
                "high",
                None,
                "demo-engineer",
                0,
                6,
                after=("am1",),
            ),
            _T(
                "a4",
                "Проверка загрузки на тестовом контуре",
                "todo",
                "medium",
                None,
                "demo-qa",
                0,
                3,
                after=("a3",),
            ),
            _T("a5", "Документация интеграции", "todo", "medium", None, "demo-analyst", 0, 2, after=("a3",)),
            _T(
                "am2",
                "Готовность к пилоту",
                "todo",
                "critical",
                None,
                "demo-owner",
                0,
                0,
                after=("a4", "a5"),
                milestone=True,
                due="end",
            ),
        ),
    ),
    _P(
        "demo:dataset-quality-initiative",
        "DQI",
        "Dataset Quality Initiative (демо)",
        f"Единый каталог правил качества данных, шаблон правила и пилотные проверки. {_DEMO}",
        (
            _T("d1", "Каталог правил качества", "in_progress", "high", None, "demo-qa", 0, 19),
            _T("d1.1", "Собрать существующие проверки", "done", "medium", "d1", "demo-qa", 0, 5),
            _T(
                "d1.2",
                "Классифицировать правила по измерениям качества",
                "review",
                "medium",
                "d1",
                "demo-analyst",
                5,
                6,
                after=("d1.1",),
            ),
            _T(
                "d2",
                "Шаблон описания правила качества",
                "done",
                "medium",
                None,
                "demo-architect",
                2,
                4,
                description="Используется шаблон документа `data_quality_rule` из Template Hub.",
            ),
            _T(
                "d3",
                "Пилот: проверки для синтетического набора клиентских данных",
                "todo",
                "high",
                None,
                "demo-qa",
                0,
                6,
                after=("d1", "d2"),
            ),
            _T(
                "d3.1",
                "Настроить пороги срабатывания",
                "todo",
                "medium",
                "d3",
                "demo-engineer",
                0,
                3,
                after=("d1",),
            ),
            _T(
                "d3.2",
                "Согласовать ответственных за правила",
                "todo",
                "low",
                "d3",
                "demo-owner",
                0,
                2,
                after=("d1",),
            ),
            _T(
                "dm1",
                "Пилот запущен",
                "todo",
                "high",
                None,
                "demo-owner",
                0,
                0,
                after=("d3",),
                milestone=True,
            ),
            _T(
                "d4",
                "Отчёт о покрытии проверками",
                "todo",
                "medium",
                None,
                "demo-analyst",
                None,
                0,
                after=("dm1",),
                estimate=3,
                description="Даты не заданы: появятся после пилота (задача в пуле «без дат»).",
            ),
            _T("d5", "Ретроспектива пилота", "todo", "low", None, None, None, 0, estimate=1),
        ),
    ),
    _P(
        "demo:confluence-rag-improvements",
        "RAG",
        "Confluence RAG Improvements (демо)",
        f"Улучшения поиска по синтетическому корпусу Confluence: релевантность, кэш, тесты, связи графа. {_DEMO}",
        (
            _T("r1", "Анализ релевантности поиска", "done", "high", None, "demo-analyst", 0, 4),
            _T(
                "r2",
                "Словарь синонимов для поиска",
                "in_progress",
                "high",
                None,
                "demo-engineer",
                0,
                7,
                after=("r1",),
                due=9,
                description="Срок прошёл — задача просрочена (демо).",
            ),
            _T("r3", "Кэш внешних страниц", "review", "medium", None, "demo-engineer", 2, 12),
            _T("r3.1", "TTL и инвалидация кэша", "review", "medium", "r3", "demo-engineer", 2, 10),
            _T("r3.2", "Ограничение размера кэша", "done", "low", "r3", "demo-qa", 2, 3),
            _T("r4", "Регрессионные тесты поиска", "todo", "high", None, "demo-qa", 0, 4, after=("r2", "r3")),
            _T(
                "r5",
                "Связи задач и документов в графе знаний",
                "todo",
                "medium",
                None,
                "demo-architect",
                16,
                5,
                after=("r1",),
            ),
            _T(
                "rm1",
                "Релиз улучшений поиска",
                "todo",
                "critical",
                None,
                "demo-owner",
                0,
                0,
                after=("r4", "r5"),
                milestone=True,
                locked=True,
            ),
        ),
    ),
)


@dataclass
class SeedReport:
    created: list[str] = field(default_factory=list)
    skipped_existing: list[str] = field(default_factory=list)
    skipped_key_conflict: list[str] = field(default_factory=list)
    tasks_created: int = 0


def _uid(*parts: str) -> str:
    return uuid.uuid5(_NAMESPACE, ":".join(parts)).hex


def _anchor(now: datetime, timezone: str) -> date:
    try:
        today = now.astimezone(ZoneInfo(timezone)).date()
    except (ZoneInfoNotFoundError, ValueError):
        today = now.date()
    monday = today - timedelta(days=today.weekday())
    return monday - timedelta(weeks=3)


def _layout(spec: _P, anchor: date) -> dict[str, tuple[date | None, date | None, date | None]]:
    """Forward pass over the declared FS edges: start = max(anchor + offset, every predecessor's FS earliest)."""
    plan: dict[str, tuple[date | None, date | None, date | None]] = {}
    remaining = list(spec.tasks)
    while remaining:
        progressed = False
        for task in list(remaining):
            if any(a not in plan for a in task.after):
                continue
            remaining.remove(task)
            progressed = True
            if task.offset is None:
                plan[task.local] = (None, None, None)
                continue
            start = shift_workdays(anchor, task.offset)
            for pred in task.after:
                pred_end = plan[pred][1]
                if pred_end is not None:
                    start = max(start, fs_earliest_start(pred_end))
            end = start if task.milestone else add_workdays(start, task.days)
            due: date | None = None
            if task.due == "end":
                due = start if task.milestone else last_workday(start, end)
            elif isinstance(task.due, int):
                due = shift_workdays(anchor, task.due)
            plan[task.local] = (start, end, due)
        if not progressed:
            raise ValueError(f"demo seed {spec.key}: dependency cycle or unknown predecessor")
    return plan


def seed_demo(db: WorkDatabase, *, now: datetime, timezone: str) -> SeedReport:
    report = SeedReport()
    anchor = _anchor(now, timezone)
    at = store.now_iso(now)
    for spec in PROJECTS:
        with db.write() as conn:
            if store.get_project_by_seed(conn, spec.seed_key) is not None:
                report.skipped_existing.append(spec.key)
                continue
            if store.get_project_by_key(conn, spec.key) is not None:
                report.skipped_key_conflict.append(spec.key)
                continue
            project_id = _uid(spec.seed_key)
            layout = _layout(spec, anchor)
            ends = [e for _, e, _ in layout.values() if e is not None]
            store.insert_project(
                conn,
                {
                    "id": project_id,
                    "key": spec.key,
                    "title": spec.title,
                    "description": spec.description,
                    "status": "active",
                    "timezone": timezone,
                    "calendar": CALENDAR_ID,
                    "start_date": anchor.isoformat(),
                    "target_date": max(ends).isoformat() if ends else None,
                    "is_demo": 1,
                    "seed_key": spec.seed_key,
                    "created_by": SEED_ACTOR,
                    "created_at": at,
                    "updated_by": SEED_ACTOR,
                    "updated_at": at,
                },
            )
            _audit(
                conn,
                at,
                "project_created",
                "project",
                project_id,
                project_id,
                None,
                {"key": spec.key, "seed": True},
            )
            ids = {t.local: _uid(spec.seed_key, t.local) for t in spec.tasks}
            for task in spec.tasks:
                number = store.allocate_task_number(conn, project_id)
                start, end, due = layout[task.local]
                row: dict[str, Any] = {
                    "id": ids[task.local],
                    "project_id": project_id,
                    "number": number,
                    "parent_task_id": ids[task.parent] if task.parent else None,
                    "title": task.title,
                    "description": task.description,
                    "status": task.status,
                    "priority": task.priority,
                    "assignee_id": task.assignee,
                    "reporter_id": SEED_ACTOR,
                    "estimate_workdays": task.estimate,
                    "start_date": start.isoformat() if start else None,
                    "end_exclusive": end.isoformat() if end else None,
                    "due_date": due.isoformat() if due else None,
                    "is_milestone": int(task.milestone),
                    "date_locked": int(task.locked and start is not None),
                    "sort_order": number * 1024,
                    "is_demo": 1,
                    "created_by": SEED_ACTOR,
                    "created_at": at,
                    "updated_by": SEED_ACTOR,
                    "updated_at": at,
                }
                store.insert_task(conn, row)
                _audit(conn, at, "task_created", "task", row["id"], project_id, row["id"], {"seed": True})
                report.tasks_created += 1
            for task in spec.tasks:
                for pred in task.after:
                    dep_id = _uid(spec.seed_key, pred, "->", task.local)
                    store.insert_dependency(
                        conn,
                        {
                            "id": dep_id,
                            "project_id": project_id,
                            "predecessor_id": ids[pred],
                            "successor_id": ids[task.local],
                            "kind": "FS",
                            "lag_workdays": 0,
                            "created_by": SEED_ACTOR,
                            "created_at": at,
                        },
                    )
            report.created.append(spec.key)
    return report


def _audit(
    conn: Any,
    at: str,
    operation: str,
    entity_type: str,
    entity_id: str,
    project_id: str,
    task_id: str | None,
    changes: dict[str, Any],
) -> None:
    store.insert_audit(
        conn,
        at=at,
        actor_id=SEED_ACTOR,
        operation=operation,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        task_id=task_id,
        correlation_id="demo-seed",
        changes=changes,
    )
