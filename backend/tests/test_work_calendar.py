"""M6 working calendar (Mon–Fri, half-open intervals): the fixed examples of 02_GANTT_AND_SCHEDULING §6/§8
and boundary cases. M6-09 (Friday → Monday), M6-26 (end_exclusive vs the last day shown)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.work.calendar import (
    add_workdays,
    canonical_interval,
    count_workdays,
    fs_earliest_start,
    is_workday,
    last_workday,
    next_workday,
    previous_workday,
    shift_workdays,
)

FRI = date(2026, 11, 27)
SAT = date(2026, 11, 28)
SUN = date(2026, 11, 29)
MON = date(2026, 11, 30)


def test_m6_09_friday_one_workday_then_fs_successor_starts_monday() -> None:
    end = add_workdays(FRI, 1)
    assert end == SAT  # [2026-11-27, 2026-11-28): the end is exclusive, not the next working day
    assert count_workdays(FRI, end) == 1
    assert fs_earliest_start(end) == MON  # not Saturday 2026-11-28


def test_monday_plus_two_workdays_ends_exclusive_on_wednesday() -> None:
    assert add_workdays(MON, 2) == date(2026, 12, 2)
    assert count_workdays(MON, date(2026, 12, 2)) == 2


def test_m6_26_last_day_shown_is_not_the_exclusive_end() -> None:
    assert last_workday(MON, date(2026, 12, 2)) == date(2026, 12, 1)  # Tue is the last occupied day
    assert last_workday(FRI, SAT) == FRI
    assert last_workday(FRI, MON) == FRI  # [Fri, Mon) — the weekend is not work
    assert last_workday(SAT, MON) is None


def test_weekends_are_skipped_everywhere() -> None:
    assert [is_workday(FRI + timedelta(days=i)) for i in range(4)] == [True, False, False, True]
    assert next_workday(SAT) == MON and next_workday(SUN) == MON and next_workday(MON) == MON
    assert previous_workday(SUN) == FRI and previous_workday(FRI) == FRI
    assert shift_workdays(FRI, 1) == MON
    assert shift_workdays(SAT, 0) == MON
    assert add_workdays(SAT, 1) == date(2026, 12, 1)  # starts Monday, ends exclusive Tuesday
    assert count_workdays(SAT, MON) == 0
    assert count_workdays(MON, MON) == 0 and count_workdays(MON, FRI) == 0  # empty / inverted


def test_milestone_has_zero_duration() -> None:
    assert add_workdays(MON, 0) == MON
    assert add_workdays(SAT, 0) == MON  # a milestone is placed on a working day boundary
    assert fs_earliest_start(MON) == MON  # a successor of a milestone may start on the milestone day


def test_canonical_interval_keeps_the_same_working_days() -> None:
    assert canonical_interval(SAT, date(2026, 12, 1)) == (MON, date(2026, 12, 1))
    assert canonical_interval(FRI, MON) == (FRI, SAT)
    assert canonical_interval(SAT, MON) is None  # no working day: not a task interval


@pytest.mark.parametrize("days", [1, 2, 4, 5, 6, 9, 10, 11, 23, 250, 1000])
def test_arithmetic_matches_a_day_by_day_walk(days: int) -> None:
    for start_offset in range(7):  # every weekday as a start
        start = MON + timedelta(days=start_offset)
        walk, day, counted = start, start, 0
        while counted < days:
            if is_workday(day):
                counted += 1
                walk = day
            day += timedelta(days=1)
        assert add_workdays(start, days) == walk + timedelta(days=1)
        assert count_workdays(next_workday(start), add_workdays(start, days)) == days
        assert shift_workdays(start, days - 1) == walk


def test_lag_adds_working_days_after_the_baseline() -> None:
    # The P0 API accepts lag 0 only; the calendar function is ready for N >= 0.
    assert fs_earliest_start(SAT, 1) == date(2026, 12, 1)
    with pytest.raises(ValueError):
        shift_workdays(MON, -1)
