"""Dates a person names in Russian text (chat create-task and the task-plan skill; design 2026-11-27 §5.5).

Pure functions: `today` is always passed in (the work calendar's date in the project's timezone). A date enters a
task only from the person's own words — the model may QUOTE a fragment of the request, never set a value; the server
re-checks the quote (`quote_in_text`) and parses it here.

    find_dates("загрузка с 1 по 4 декабря, срок 10.12", today)
      -> [FoundDate("start", 2026-12-01, "с 1 по 4 декабря"), FoundDate("end", 2026-12-04, "с 1 по 4 декабря"),
          FoundDate("due", 2026-12-10, "срок 10.12")]

Markers: «до / к / не позднее / срок / дедлайн» → due; «с X по Y», «X–Y месяц» → start + end; «с / начать / начиная с /
стартовать» → start; a date without a marker → due (a task's day). A date without a year is the nearest one today or
later; an explicit year is kept even in the past (the caller flags it with `is_past`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

DateRole = Literal["due", "start", "end"]


@dataclass(frozen=True)
class FoundDate:
    role: DateRole
    value: date
    fragment: str  # the exact substring of the text, marker included


_MONTH_STEMS: tuple[tuple[str, int], ...] = (
    ("январ", 1),
    ("янв", 1),
    ("феврал", 2),
    ("фев", 2),
    ("март", 3),
    ("мар", 3),
    ("апрел", 4),
    ("апр", 4),
    ("ма", 5),  # май / мая
    ("июн", 6),
    ("июл", 7),
    ("август", 8),
    ("авг", 8),
    ("сентябр", 9),
    ("сен", 9),
    ("октябр", 10),
    ("окт", 10),
    ("ноябр", 11),
    ("ноя", 11),
    ("декабр", 12),
    ("дек", 12),
)
_MONTH = (
    r"(?:январ[а-я]*|янв\.?|феврал[а-я]*|фев\.?|март[а-я]*|мар\.?|апрел[а-я]*|апр\.?|ма[йя]|июн[а-я]*|июл[а-я]*|"
    r"август[а-я]*|авг\.?|сентябр[а-я]*|сент?\.?|октябр[а-я]*|окт\.?|ноябр[а-я]*|нояб?\.?|декабр[а-я]*|дек\.?)"
)
_WEEKDAYS: tuple[tuple[str, int], ...] = (
    ("понедельн", 0),
    ("вторн", 1),
    ("сред", 2),
    ("четверг", 3),
    ("пятниц", 4),
    ("суббот", 5),
    ("воскресен", 6),
)
_WEEKDAY = (
    r"(?:понедельник[а-я]*|вторник[а-я]*|сред[уаеы]|четверг[а-я]*|пятниц[уаеы]|суббот[уаеы]|воскресень[еяю])"
)
_NUMBER_WORDS = {
    "один": 1,
    "одну": 1,
    "одного": 1,
    "два": 2,
    "две": 2,
    "двух": 2,
    "три": 3,
    "трёх": 3,
    "трех": 3,
    "четыре": 4,
    "пять": 5,
    "шесть": 6,
    "семь": 7,
    "восемь": 8,
    "девять": 9,
    "десять": 10,
}
_COUNT = r"(?:\d{1,3}|" + "|".join(_NUMBER_WORDS) + r")"
_RELATIVE = (
    r"(?:сегодня|послезавтра|завтра|"
    rf"через\s+(?:{_COUNT}\s+)?(?:рабоч(?:ий|их|его)\s+)?(?:дн(?:я|ей)|день|недел[юиь]|недель))"
)
# Unambiguous forms are dates anywhere; a weekday word («среда» is also «environment») and a short «dd.mm» («3.12» is
# also a version) are dates only right after a marker (design review 2026-11-27).
_SHORT_NUM = r"(?<![\d.])(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])(?![\d.]*\d)"  # «05.12»: two digits each
_UNAMBIGUOUS = (
    r"(?:\d{4}-\d{2}-\d{2}"
    r"|(?<![\d.])\d{1,2}\.(?:0[1-9]|1[0-2])\.(?:\d{4}|\d{2})(?![\d.]*\d)"
    rf"|\d{{1,2}}\s+{_MONTH}(?:\s+\d{{4}})?(?:\s*г(?:ода|\.)?)?"
    rf"|{_RELATIVE})"
)
_DATE = rf"(?:{_UNAMBIGUOUS}|{_SHORT_NUM}|{_WEEKDAY})"  # after a marker
_B = r"(?<![А-Яа-яЁёA-Za-z0-9])"  # a word start (Cyrillic-aware)
_E = r"(?![А-Яа-яЁёA-Za-z0-9])"

_RANGE_RE = re.compile(
    rf"{_B}(?:с\s+)?(?P<a>{_DATE}|\d{{1,2}})\s*(?:по|[–—-])\s*(?P<b>{_DATE}){_E}", re.IGNORECASE
)
_DUE_RE = re.compile(
    rf"{_B}(?:не\s+позднее|до|к|срок(?:ом)?|дедлайн)(?:\s*[:—-]\s*|\s+)(?P<d>{_DATE}){_E}", re.IGNORECASE
)
_START_RE = re.compile(
    rf"{_B}(?:начиная\s+с|начать(?:\s+с)?|стартовать(?:\s+с)?|старт(?:\s+с)?|с)\s+(?P<d>{_DATE}){_E}",
    re.IGNORECASE,
)
# «в пятницу», «на среду», «по четверг»: a weekday in the accusative only («в среде» is a place, not a day)
_ON_WEEKDAY_RE = re.compile(
    r"(?<![А-Яа-яЁёA-Za-z0-9])(?:в|во|на|по)\s+"
    r"(?P<d>понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?![А-Яа-яЁёA-Za-z0-9])",
    re.IGNORECASE,
)
_PLAIN_RE = re.compile(rf"{_B}(?P<d>{_UNAMBIGUOUS}){_E}", re.IGNORECASE)
_VERSION_BEFORE_RE = re.compile(r"(?:верси[яиюей]|v)\s*$", re.IGNORECASE)
_LEADING_MARKER_RE = re.compile(
    r"^(?:не\s+позднее|начиная\s+с|начать(?:\s+с)?|стартовать(?:\s+с)?|срок(?:ом)?|дедлайн|до|по|к|с|в|на)"
    r"(?:\s*[:—-]\s*|\s+)",
    re.IGNORECASE,
)
_QUOTES_RE = re.compile(r"[«»\"'“”„]")


def _month_of(word: str) -> int | None:
    stem = word.lower().rstrip(".")
    for prefix, month in _MONTH_STEMS:
        if stem.startswith(prefix):
            return month
    return None


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _upcoming(today: date, month: int, day: int) -> date | None:
    """The nearest date with this day and month, today or later (a date written without a year)."""
    candidate = _safe_date(today.year, month, day)
    if candidate is not None and candidate >= today:
        return candidate
    return _safe_date(today.year + 1, month, day)


def _add_workdays(start: date, count: int) -> date:
    current = start
    added = 0
    while added < count:
        current += timedelta(days=1)
        if current.weekday() < 5:
            added += 1
    return current


def _count(word: str | None) -> int:
    if not word:
        return 1
    return int(word) if word.isdigit() else _NUMBER_WORDS.get(word.lower(), 1)


def parse_date_phrase(text: str, today: date) -> date | None:
    """One date expression (a leading marker such as «до» is tolerated); None when it is not a valid date."""
    phrase = _LEADING_MARKER_RE.sub("", " ".join(text.split()).strip(" ,.;")).strip()
    low = phrase.lower()
    if not low:
        return None
    if m := re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", low):
        return _safe_date(int(m[1]), int(m[2]), int(m[3]))
    if m := re.fullmatch(r"(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?", low):
        day, month = int(m[1]), int(m[2])
        if m[3] is None:
            return _upcoming(today, month, day)
        year = int(m[3]) + (2000 if len(m[3]) == 2 else 0)
        return _safe_date(year, month, day)
    if m := re.fullmatch(rf"(\d{{1,2}})\s+({_MONTH})(?:\s+(\d{{4}}))?(?:\s*г(?:ода|\.)?)?", low):
        month_of = _month_of(m[2])
        if month_of is None:
            return None
        if m[3] is None:
            return _upcoming(today, month_of, int(m[1]))
        return _safe_date(int(m[3]), month_of, int(m[1]))
    if low == "сегодня":
        return today
    if low == "завтра":
        return today + timedelta(days=1)
    if low == "послезавтра":
        return today + timedelta(days=2)
    if m := re.fullmatch(
        rf"через\s+(?:({_COUNT})\s+)?(рабоч(?:ий|их|его)\s+)?(дн(?:я|ей)|день|недел[юиь]|недель)", low
    ):
        count = _count(m[1])
        if m[3].startswith("недел"):
            return today + timedelta(weeks=count)
        if m[2]:
            return _add_workdays(today, count)
        return today + timedelta(days=count)
    if re.fullmatch(_WEEKDAY, low):
        target = next(index for stem, index in _WEEKDAYS if low.startswith(stem))
        delta = (target - today.weekday()) % 7
        return today + timedelta(days=delta or 7)
    return None


def _range_start(a: str, end: date, today: date) -> date | None:
    """«с 1 по 5 декабря»: a bare day takes the month and year of the end (the month before if it would be later)."""
    if a.isdigit():
        start = _safe_date(end.year, end.month, int(a))
        if start is not None and start > end:
            previous = end.replace(day=1) - timedelta(days=1)
            start = _safe_date(previous.year, previous.month, int(a))
        return start
    return parse_date_phrase(a, today)


def find_dates(text: str, today: date) -> list[FoundDate]:
    """Every date the text names, with its role (by marker) and the exact fragment, in text order."""
    taken: list[tuple[int, int]] = []
    found: list[tuple[int, FoundDate]] = []

    def free(start: int, end: int) -> bool:
        return all(end <= s or start >= e for s, e in taken)

    for m in _RANGE_RE.finditer(text):
        if not free(*m.span()):
            continue
        end = parse_date_phrase(m["b"], today)
        start = _range_start(m["a"], end, today) if end is not None else None
        if start is None or end is None or start > end:
            continue
        taken.append(m.span())
        fragment = m[0]
        found.append((m.start(), FoundDate("start", start, fragment)))
        found.append((m.start() + 1, FoundDate("end", end, fragment)))
    for pattern, role in (
        (_DUE_RE, "due"),
        (_START_RE, "start"),
        (_ON_WEEKDAY_RE, "due"),
        (_PLAIN_RE, "due"),
    ):
        for m in pattern.finditer(text):
            if not free(*m.span()):
                continue
            if re.fullmatch(_SHORT_NUM, m["d"]) and _VERSION_BEFORE_RE.search(text[: m.start()]):
                continue  # «до версии 10.12» is a version
            value = parse_date_phrase(m["d"], today)
            if value is None:
                continue
            taken.append(m.span())
            found.append((m.start(), FoundDate(role, value, m[0])))  # type: ignore[arg-type]
    return [f for _, f in sorted(found, key=lambda item: item[0])]


def normalize_quote(text: str) -> str:
    """Casefolded, «ё» → «е», quotes removed, whitespace collapsed — the form quotes are compared in."""
    return " ".join(_QUOTES_RE.sub("", text).casefold().replace("ё", "е").split())


def quote_in_text(quote: str, text: str) -> bool:
    """A quote from the model is accepted only when it is a non-empty fragment of the person's text."""
    needle = normalize_quote(quote)
    return bool(needle) and needle in normalize_quote(text)


def is_past(value: date, today: date) -> bool:
    return value < today
