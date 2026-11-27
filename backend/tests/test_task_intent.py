"""The deterministic create-task intent rule (design 2026-11-27 §5.2): precision over recall."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from app.domain.task_intent import looks_like_create_task, strip_trigger

EVAL_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "eval"

POSITIVE = [
    "создай задачу обновить витрину до 5 декабря",
    "Заведите, пожалуйста, задачу на проверку DQ",
    "добавь в проект RAG задачу описать API",
    "поставь задачу Анне",
    "задача: проверить загрузку",
    "Новая задача — ревью схемы",
    "оформи задачу по документу",
]
NEGATIVE = [
    "как создать задачу в Jira?",
    "какие задачи просрочены",
    "создай задачи по документу",
    "создай документ про задачу",
    "что такое задача DQ",
    "создай задачу?",
    "можно ли создать задачу из чата",
    "покажи задачу RAG-3",
    "задачи: а, б",
    "создай задачу:\nпервая\nвторая",
]


@pytest.mark.parametrize("question", POSITIVE)
def test_triggers(question: str) -> None:
    assert looks_like_create_task(question)


@pytest.mark.parametrize("question", NEGATIVE)
def test_does_not_trigger(question: str) -> None:
    assert not looks_like_create_task(question)


def test_no_gold_question_triggers() -> None:
    cases = [
        case for path in sorted(EVAL_DIR.glob("*.yaml")) for case in (yaml.safe_load(path.read_text()) or [])
    ]
    texts = [str(case.get("question") or case.get("query") or "") for case in cases]
    texts += [str(h) for case in cases for h in case.get("history") or []]
    assert len(cases) >= 216
    assert [t for t in texts if looks_like_create_task(t)] == []


def test_strip_trigger() -> None:
    assert strip_trigger("Создай задачу: обновить витрину") == "обновить витрину"
    assert strip_trigger("Заведите, пожалуйста, задачу на проверку DQ") == "на проверку DQ"
    assert strip_trigger("Новая задача — ревью схемы") == "ревью схемы"
    assert strip_trigger("обновить витрину") == "обновить витрину"


def test_a_task_key_after_the_verb_is_not_a_new_task() -> None:
    assert not looks_like_create_task("Поставь задачу RAG-12 на ревью")
    assert looks_like_create_task("поставь задачу Анне")
