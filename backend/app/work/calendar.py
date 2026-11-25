"""Project working calendar (M6 P0): Monday–Friday, no holidays, date-only values.

Time model (docs/WORK_MANAGEMENT.md «Время и календарь»):

- A scheduled task occupies the half-open interval `[start_date, end_exclusive)`; the end is NOT a working day of
  the task. `duration_workdays` = the number of working days inside the interval (weekends are not counted).
- A milestone is a point: `start_date == end_exclusive`, duration 0.
- `due_date` is a separate INCLUSIVE deadline; it never replaces `end_exclusive`.
- Finish-to-Start with lag 0: `start_B >= next_workday(end_exclusive_A)`.

Example (a fixed test): A = Fri 2026-11-27, one working day → `[2026-11-27, 2026-11-28)`; B after A (FS) starts at
the earliest on Mon 2026-11-30. Mon 2026-11-30 + 2 working days → end_exclusive Wed 2026-12-02.

All functions are O(1) (whole weeks are skipped arithmetically), so scheduling thousands of tasks stays linear.
"""

from __future__ import annotations

from datetime import date, timedelta

CALENDAR_ID = "mon_fri_v1"
WORKDAYS_PER_WEEK = 5
WORKDAY_NUMBERS = (1, 2, 3, 4, 5)  # ISO weekday numbers: Monday = 1 … Friday = 5
_ONE_DAY = timedelta(days=1)
# The one supported date range of the work module (audit CODE-005, CODE-011). Every stored work date — given by a
# person, derived from a duration, shifted by the scheduler or computed for an AI plan — has its year in
# [MIN_YEAR, MAX_YEAR]; checking derived dates too keeps calendar arithmetic far from date.max (no overflow).
MIN_YEAR, MAX_YEAR = 2000, 2100


def in_supported_range(day: date) -> bool:
    return MIN_YEAR <= day.year <= MAX_YEAR


def is_workday(day: date) -> bool:
    return day.weekday() < WORKDAYS_PER_WEEK


def next_workday(day: date) -> date:
    """`day` itself when it is a working day, otherwise the first working day after it."""
    weekday = day.weekday()
    if weekday < WORKDAYS_PER_WEEK:
        return day
    return day + timedelta(days=7 - weekday)


def previous_workday(day: date) -> date:
    """`day` itself when it is a working day, otherwise the last working day before it."""
    weekday = day.weekday()
    if weekday < WORKDAYS_PER_WEEK:
        return day
    return day - timedelta(days=weekday - (WORKDAYS_PER_WEEK - 1))


def shift_workdays(day: date, count: int) -> date:
    """The working day `count` working days after `day` (normalised to a working day first); count >= 0."""
    if count < 0:
        raise ValueError("count must be >= 0")
    start = next_workday(day)
    weeks, rest = divmod(count, WORKDAYS_PER_WEEK)
    result = start + timedelta(weeks=weeks)
    weekday = result.weekday()
    if weekday + rest >= WORKDAYS_PER_WEEK:
        rest += 2  # jump over the weekend
    return result + timedelta(days=rest)


def count_workdays(start: date, end_exclusive: date) -> int:
    """Number of working days in `[start, end_exclusive)`; 0 for an empty or inverted interval."""
    if end_exclusive <= start:
        return 0
    days = (end_exclusive - start).days
    weeks, rest = divmod(days, 7)
    total = weeks * WORKDAYS_PER_WEEK
    weekday = start.weekday()
    for offset in range(rest):
        if (weekday + offset) % 7 < WORKDAYS_PER_WEEK:
            total += 1
    return total


def add_workdays(start: date, duration: int) -> date:
    """`end_exclusive` of a task that starts on `next_workday(start)` and lasts `duration` working days.

    The end is the calendar day after the last occupied working day (Fri + 1 day → Sat). `duration == 0` is a
    milestone: the end equals the (normalised) start.
    """
    if duration < 0:
        raise ValueError("duration must be >= 0")
    first = next_workday(start)
    if duration == 0:
        return first
    return shift_workdays(first, duration - 1) + _ONE_DAY


def last_workday(start: date, end_exclusive: date) -> date | None:
    """The last occupied working day of `[start, end_exclusive)` (what a UI shows as «по …»); None if empty."""
    if count_workdays(start, end_exclusive) == 0:
        return None
    return previous_workday(end_exclusive - _ONE_DAY)


def canonical_interval(start: date, end_exclusive: date) -> tuple[date, date] | None:
    """The same set of working days written canonically: the start on a working day, the end right after the
    last working day. None when the interval holds no working day (not a valid task interval)."""
    last = last_workday(start, end_exclusive)
    if last is None:
        return None
    return next_workday(start), last + _ONE_DAY


def fs_earliest_start(predecessor_end_exclusive: date, lag_workdays: int = 0) -> date:
    """Earliest start of a Finish-to-Start successor: the first working day at/after the predecessor's end,
    plus `lag_workdays` working days (P0 API accepts lag 0 only)."""
    return shift_workdays(next_workday(predecessor_end_exclusive), lag_workdays)
