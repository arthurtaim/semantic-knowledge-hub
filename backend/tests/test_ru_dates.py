"""Russian date phrases in a person's request (docs/superpowers/specs/2026-11-27-chat-create-task-design.md §5.5)."""

from __future__ import annotations

from datetime import date

import pytest

from app.domain.ru_dates import find_dates, is_past, normalize_quote, parse_date_phrase, quote_in_text

TODAY = date(2026, 11, 27)  # a Friday


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        ("5 декабря", date(2026, 12, 5)),
        ("5 дек", date(2026, 12, 5)),
        ("5 декабря 2027", date(2027, 12, 5)),
        ("05.12", date(2026, 12, 5)),
        ("05.12.26", date(2026, 12, 5)),
        ("05.12.2026", date(2026, 12, 5)),
        ("2026-12-05", date(2026, 12, 5)),
        ("сегодня", date(2026, 11, 27)),
        ("завтра", date(2026, 11, 28)),
        ("послезавтра", date(2026, 11, 29)),
        ("через 3 дня", date(2026, 11, 30)),
        ("через 2 недели", date(2026, 12, 11)),
        ("через 2 рабочих дня", date(2026, 12, 1)),
        ("пятницы", date(2026, 12, 4)),
        ("понедельник", date(2026, 11, 30)),
        ("1 ноября", date(2027, 11, 1)),  # no year and already past → the next occurrence
        ("31.02", None),
        ("когда-нибудь", None),
    ],
)
def test_parse_date_phrase(phrase: str, expected: date | None) -> None:
    assert parse_date_phrase(phrase, TODAY) == expected


def test_markers_map_to_roles() -> None:
    found = find_dates("сделать отчёт до 5 декабря", TODAY)
    assert [(f.role, f.value, f.fragment) for f in found] == [("due", date(2026, 12, 5), "до 5 декабря")]
    assert [(f.role, f.value) for f in find_dates("с 1 по 5 декабря", TODAY)] == [
        ("start", date(2026, 12, 1)),
        ("end", date(2026, 12, 5)),
    ]
    assert [f.role for f in find_dates("начать 1 декабря, дедлайн 10.12", TODAY)] == ["start", "due"]
    assert [f.role for f in find_dates("к пятнице", TODAY)] == ["due"]
    assert find_dates("отчёт за 2025 год", TODAY) == []


def test_fragments_are_exact_substrings_of_the_text() -> None:
    text = "Создай задачу: загрузка с 1 по 4 декабря, срок 10.12"
    for found in find_dates(text, TODAY):
        assert found.fragment in text


def test_explicit_past_date_is_kept_and_detectable() -> None:
    (found,) = find_dates("срок 05.11.2026", TODAY)
    assert found.value == date(2026, 11, 5)
    assert is_past(found.value, TODAY)


def test_quote_in_text_is_whitespace_and_case_insensitive() -> None:
    assert quote_in_text("До  5 Декабря", "сделать до 5 декабря")
    assert quote_in_text("«до 5 декабря»", "сделать до 5 декабря")
    assert not quote_in_text("до 6 декабря", "сделать до 5 декабря")
    assert not quote_in_text("", "текст")
    assert normalize_quote("  Ёлка   ДО\n5 ") == "елка до 5"


def test_version_numbers_are_not_dates() -> None:
    assert find_dates("обнови документ до версии 2.1", TODAY) == []
    assert find_dates("релиз 1.10.3 и схема v2", TODAY) == []


# --- review fixes: ordinary words, versions and short dates are not dates without a marker ------------------------
@pytest.mark.parametrize(
    "text",
    [
        "развернуть витрину в тестовой среде",
        "настроить переменные среды",
        "обновить Python до 3.12",
        "перейти на версию 1.10",
        "отчёт 05.12",
        "собрать данные в пятнице",
    ],
)
def test_ordinary_words_and_versions_are_not_dates(text: str) -> None:
    assert find_dates(text, TODAY) == []


def test_weekdays_and_short_dates_need_a_marker() -> None:
    assert [(f.role, f.value) for f in find_dates("сделать к среде", TODAY)] == [("due", date(2026, 12, 2))]
    assert [(f.role, f.value) for f in find_dates("сдать в пятницу", TODAY)] == [("due", date(2026, 12, 4))]
    assert [(f.role, f.value) for f in find_dates("отчёт до 05.12", TODAY)] == [("due", date(2026, 12, 5))]
    assert [(f.role, f.value) for f in find_dates("отчёт 05.12.2026", TODAY)] == [("due", date(2026, 12, 5))]
