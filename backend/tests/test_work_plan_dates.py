"""Dates the person names in a task-plan request are kept (design 2026-11-27 §5.6): the model may only QUOTE the
request; the server verifies the quote and parses it. Scripted model double, real HTTP API, «today» = Fri 2026-11-27."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.work.calendar import last_workday
from tests.test_work_ai import Factory, ai_client, propose  # noqa: F401  (ai_client is a fixture)


def _client(ai_client: Factory) -> TestClient:  # noqa: F811
    client, _ = ai_client()
    client.app.state.container.work.now = lambda: datetime(2026, 11, 27, 9, 0, tzinfo=UTC)  # type: ignore[attr-defined]
    return client


def _proposal(client: TestClient, request: str, **extra: Any) -> dict[str, Any]:
    response = propose(client, request, **extra)
    assert response.status_code == 201, response.text
    return response.json()  # type: ignore[no-any-return]


def _first(proposal: dict[str, Any]) -> dict[str, Any]:
    return proposal["tasks"][0]  # type: ignore[no-any-return]


def _codes(proposal: dict[str, Any], local_id: str | None = None) -> set[str]:
    return {i["code"] for i in proposal["issues"] if local_id is None or i["local_id"] == local_id}


def test_a_due_date_named_in_the_request_is_kept(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи по архитектуре до 5 декабря")
    assert _first(proposal)["due_date"] == "2026-12-05"
    assert "dates_ignored" not in _codes(proposal)


def test_an_invented_date_quote_is_dropped(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи по архитектуре, выдумай дату")
    assert _first(proposal)["due_date"] is None
    assert "date_unverified" in _codes(proposal, _first(proposal)["local_id"])


def test_a_bare_date_value_is_still_ignored(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи по архитектуре, голая дата")
    assert _first(proposal)["due_date"] is None
    assert "dates_ignored" in _codes(proposal)


def test_a_period_pins_the_task(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи: загрузка с 1 по 4 декабря")
    task = _first(proposal)
    assert (task["fixed_start"], task["fixed_end"]) == ("2026-12-01", "2026-12-04")


def test_start_only_with_estimate_pins_the_start(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи по архитектуре, начать 1 декабря")
    task = _first(proposal)  # the scripted first task has estimate_workdays = 2
    assert (task["fixed_start"], task["fixed_end"]) == ("2026-12-01", "2026-12-02")


def test_end_only_becomes_the_due_date(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи, только окончание 4 декабря")
    task = _first(proposal)
    assert task["due_date"] == "2026-12-04"
    assert task["fixed_start"] is None and task["fixed_end"] is None


def test_plan_start_quote_prefills_suggested_start(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи по архитектуре, старт плана с 1 декабря")
    assert proposal["suggested_start"] == "2026-12-01"
    assert proposal["start_date"] == "2026-12-01"  # the person chose no start: the named one is used


def test_a_chosen_start_is_not_replaced_by_the_named_one(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(
        _client(ai_client),
        "Подготовь задачи по архитектуре, старт плана с 1 декабря",
        start_date="2026-12-07",
    )
    assert proposal["start_date"] == "2026-12-07"
    assert proposal["suggested_start"] == "2026-12-01"


def test_a_past_date_is_kept_and_flagged(ai_client: Factory) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), "Подготовь задачи по архитектуре до 05.11.2026")
    assert _first(proposal)["due_date"] == "2026-11-05"
    assert "date_past" in _codes(proposal, _first(proposal)["local_id"])


def test_refinement_dates_are_verified_against_the_refinement_text(ai_client: Factory) -> None:  # noqa: F811
    client = _client(ai_client)
    first = _proposal(client, "Подготовь задачи по архитектуре")
    response = client.post(
        f"/api/work-ai/proposals/{first['id']}/revise", json={"instruction": "добавь срок до 10 декабря"}
    )
    assert response.status_code == 201, response.text
    assert _first(response.json())["due_date"] == "2026-12-10"


def test_dates_survive_a_refinement(ai_client: Factory) -> None:  # noqa: F811
    client = _client(ai_client)
    first = _proposal(client, "Подготовь задачи по архитектуре до 5 декабря")
    response = client.post(
        f"/api/work-ai/proposals/{first['id']}/revise", json={"instruction": "сделай описания короче"}
    )
    assert response.status_code == 201, response.text
    assert _first(response.json())["due_date"] == "2026-12-05"


def test_old_stored_proposal_without_date_keys_still_reads(ai_client: Factory) -> None:  # noqa: F811
    client = _client(ai_client)
    proposal = _proposal(client, "Подготовь задачи по архитектуре до 5 декабря")
    db = client.app.state.container.work.db  # type: ignore[attr-defined]
    with db.write() as conn:
        row = conn.execute(
            "SELECT plan_json FROM work_ai_proposals WHERE id = ?", (proposal["id"],)
        ).fetchone()
        plan = json.loads(row[0])
        plan.pop("suggested_start", None)
        for task in plan["tasks"]:
            for key in ("due_date", "fixed_start", "fixed_end", "due_quote", "start_quote", "end_quote"):
                task.pop(key, None)
        conn.execute(
            "UPDATE work_ai_proposals SET plan_json = ? WHERE id = ?", (json.dumps(plan), proposal["id"])
        )
    again = client.get(f"/api/work-ai/proposals/{proposal['id']}")
    assert again.status_code == 200, again.text
    assert _first(again.json())["due_date"] is None
    assert again.json()["suggested_start"] is None


@pytest.mark.parametrize("request_text", ["Подготовь задачи по архитектуре и стандарту"])
def test_a_request_without_dates_changes_nothing(ai_client: Factory, request_text: str) -> None:  # noqa: F811
    proposal = _proposal(_client(ai_client), request_text)
    assert all(t["due_date"] is None and t["fixed_start"] is None for t in proposal["tasks"])
    assert proposal["suggested_start"] is None


# --- Task 4: scheduling, review edits and apply ---------------------------------------------------------------
def _stored(local_id: str, **kw: Any) -> Any:
    from app.work.ai import StoredTask

    base: dict[str, Any] = {"title": local_id, "description": "", "priority": "medium", "estimate": 2}
    base.update(kw)
    milestone = base.pop("milestone", False)
    return StoredTask(local_id=local_id, milestone=milestone, parent=None, **base)


def test_pinned_task_keeps_its_dates_and_successor_follows() -> None:
    from app.work.ai import plan_dates

    tasks = [_stored("t1", fixed_start="2026-12-01", fixed_end="2026-12-04"), _stored("t2", estimate=2)]
    dates, issues = plan_dates(tasks, [("t1", "t2")], date(2026, 11, 30))
    assert dates["t1"][0] == date(2026, 12, 1)
    assert last_workday(*dates["t1"]) == date(2026, 12, 4)  # type: ignore[arg-type]
    assert dates["t2"][0] == date(2026, 12, 7)
    assert not issues


def test_without_a_plan_start_pinned_tasks_and_their_successors_get_dates() -> None:
    from app.work.ai import plan_dates

    tasks = [
        _stored("t1", fixed_start="2026-12-01", fixed_end="2026-12-04"),
        _stored("t2", estimate=2),
        _stored("t3", estimate=1),
    ]
    dates, _ = plan_dates(tasks, [("t1", "t2")], None)
    assert dates["t1"][0] == date(2026, 12, 1)
    assert dates["t2"][0] == date(2026, 12, 7)
    assert dates.get("t3", (None, None)) == (None, None)


def test_due_date_does_not_move_the_gantt() -> None:
    from app.work.ai import plan_dates

    plain, _ = plan_dates([_stored("t1")], [], date(2026, 11, 30))
    with_due, _ = plan_dates([_stored("t1", due_date="2026-12-20")], [], date(2026, 11, 30))
    assert plain == with_due


def test_pinned_conflict_is_an_issue_not_an_error() -> None:
    from app.work.ai import plan_dates

    tasks = [
        _stored("t1", fixed_start="2026-12-01", fixed_end="2026-12-04"),
        _stored("t2", fixed_start="2026-12-02", fixed_end="2026-12-03"),
    ]
    dates, issues = plan_dates(tasks, [("t1", "t2")], None)
    assert dates["t2"][0] == date(2026, 12, 2)  # kept as the person named it
    assert [i.code for i in issues] == ["date_conflict"]


def test_review_edits_due_and_unpin(ai_client: Factory) -> None:  # noqa: F811
    client = _client(ai_client)
    proposal = _proposal(client, "Подготовь задачи: загрузка с 1 по 4 декабря", start_date="2026-12-07")
    first = _first(proposal)["local_id"]
    response = client.post(
        f"/api/work-ai/proposals/{proposal['id']}/apply",
        json={
            "expected_plan_revision": proposal["base_plan_revision"],
            "client_request_id": "apply-dates-0001",
            "tasks": [{"local_id": first, "due_date": "2026-12-10", "unpin_dates": True}],
        },
    )
    assert response.status_code == 200, response.text
    created = {t["title"]: t for t in response.json()["created_tasks"]}
    task = created[_first(proposal)["title"]]
    assert task["due_date"] == "2026-12-10"
    assert task["date_locked"] is False
    assert task["start_date"] == "2026-12-07"  # computed from the plan start, no longer pinned


def test_apply_creates_due_and_locked_dates(ai_client: Factory) -> None:  # noqa: F811
    client = _client(ai_client)
    proposal = _proposal(client, "Подготовь задачи: загрузка с 1 по 4 декабря до 5 декабря")
    response = client.post(
        f"/api/work-ai/proposals/{proposal['id']}/apply",
        json={
            "expected_plan_revision": proposal["base_plan_revision"],
            "client_request_id": "apply-dates-0002",
        },
    )
    assert response.status_code == 200, response.text
    task = {t["title"]: t for t in response.json()["created_tasks"]}[_first(proposal)["title"]]
    assert task["date_locked"] is True
    assert task["start_date"] == "2026-12-01"
    assert last_workday(date(2026, 12, 1), date.fromisoformat(task["end_exclusive"])) == date(2026, 12, 4)
    assert task["due_date"] == "2026-12-05"
