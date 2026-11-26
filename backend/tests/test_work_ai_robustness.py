"""Post-M6 remediation A2/A3 (audit CODE-004, CODE-005, CODE-008, CODE-011).

A2 — a model reply in the wrong shape is a controlled AI failure (502 `ai_invalid_response`, the existing contract for
an unusable model answer), never a 500, and stores nothing. Content the model may get wrong (an estimate, a date, an
unknown key) stays neutralised as before (M6-33).
A3 — one supported date range (calendar.MIN_YEAR..MAX_YEAR) for every work date: a person's input outside it is a 422
`invalid_date_range` naming the field; a date the server derives from it (a duration, an AI plan, a dependency shift)
is checked the same way, so nothing outside the range is ever written and nothing overflows into a 500.
The model is a scripted httpx double — never a live model."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider
from app.work import store
from app.work.models import PLAN_ESTIMATE_MAX
from tests.conftest import CLIENT_HEADERS

Client = Callable[..., TestClient]
DOCS = ["SEM-ARCH-001"]
GOOD = {"local_id": "t1", "title": "Разобрать требования", "estimate_workdays": 2, "sources": []}
SECOND = {"local_id": "t2", "title": "Согласовать решение", "estimate_workdays": 1, "sources": []}
MILESTONE = {"local_id": "m1", "title": "Веха", "estimate_workdays": 0, "milestone": True, "sources": []}


def plan(tasks: Any, deps: Any = None, **extra: Any) -> str:
    return json.dumps({"goal": "g", "tasks": tasks, "dependencies": deps or [], **extra}, ensure_ascii=False)


@pytest.fixture
def wc(client_factory: Client) -> TestClient:
    client = client_factory(work_seed_demo=False)
    assert client.post("/api/projects", json={"key": "PLN", "title": "План"}).status_code == 201
    # A server exception must surface as the 500 a user would get, not be raised into the test.
    return TestClient(
        client.app, base_url="http://localhost", headers=CLIENT_HEADERS, raise_server_exceptions=False
    )


def scripted(client: TestClient, reply: str) -> list[str]:
    """Replace the planning model by a double that always returns `reply`; returns the prompts it received."""
    prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": "scripted"}]})
        prompts.append(json.loads(request.content)["messages"][-1]["content"])
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": reply}}]})

    container = client.app.state.container  # type: ignore[attr-defined]
    container.work_ai._ai = OpenAICompatibleAIProvider(
        base_url="https://ai.example.test/v1",
        model="scripted",
        api_key=SecretStr(""),
        timeout_seconds=10,
        allowed_hosts=["ai.example.test"],
        transport=httpx.MockTransport(handler),
        instructions=container.instructions,
    )
    container.work.ai_planning = container.work_ai.available
    return prompts


def state(client: TestClient) -> dict[str, int]:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return {
            "tasks": conn.execute("SELECT COUNT(*) FROM work_tasks").fetchone()[0],
            "deps": conn.execute("SELECT COUNT(*) FROM work_dependencies").fetchone()[0],
            "audit": store.count_audit(conn),
            "proposals": conn.execute("SELECT COUNT(*) FROM work_ai_proposals").fetchone()[0],
            "plan": conn.execute("SELECT plan_revision FROM work_projects WHERE key = 'PLN'").fetchone()[0],
        }


def propose(client: TestClient, **extra: Any) -> Any:
    body = {"project_id": "PLN", "request": "Разложи на задачи", "document_ids": DOCS, **extra}
    return client.post("/api/work-ai/proposals", json=body)


def apply(client: TestClient, proposal: dict[str, Any], **edits: Any) -> Any:
    body = {
        "expected_plan_revision": proposal["base_plan_revision"],
        "client_request_id": "apply-req-0001",
        **edits,
    }
    return client.post(f"/api/work-ai/proposals/{proposal['id']}/apply", json=body)


# --- A2: the shape of the model's reply ------------------------------------------------------------------------
MALFORMED = {
    "corrupted_json": '{"goal": "g", "tasks": [{"local_id": "t1", "title": "x"',
    "tasks_is_object": plan({"t1": GOOD}),
    "dependencies_is_object": plan([GOOD, SECOND], {"predecessor": "t1", "successor": "t2"}),
    "dependencies_is_string": plan([GOOD, SECOND], "t1 -> t2"),
    "dependency_is_not_object": plan([GOOD, SECOND], [["t1", "t2"]]),
    "dependency_end_is_not_string": plan([GOOD, SECOND], [{"predecessor": 1, "successor": "t2"}]),
    "sources_is_object": plan([{**GOOD, "sources": {"document_id": "SEM-ARCH-001", "quote": "x"}}]),
    "sources_is_string": plan([{**GOOD, "sources": "SEM-ARCH-001"}]),
    "parent_is_not_string": plan([GOOD, {**SECOND, "parent_local_id": 1}]),
    "non_ascii_local_id": plan([{**GOOD, "local_id": "т1"}]),  # CODE-008: a Cyrillic «т»
    "local_id_with_space": plan([{**GOOD, "local_id": "t 1"}]),  # CODE-008
    "deeply_nested": '{"tasks": ' + "[" * 20000 + "]" * 20000 + "}",
}


@pytest.mark.parametrize("variant", sorted(MALFORMED))
def test_a_malformed_model_reply_is_a_controlled_ai_error_and_stores_nothing(
    wc: TestClient, variant: str
) -> None:
    scripted(wc, MALFORMED[variant])
    before = state(wc)

    response = propose(wc)

    assert response.status_code == 502, response.text
    body = response.json()
    assert body["code"] == "ai_invalid_response"
    assert body["request_id"]  # the correlation id a person can quote; no traceback in the body
    assert "Traceback" not in response.text and "KeyError" not in response.text
    assert "повтор" in body["message"]  # the UI shows this message: it says what to do next
    assert state(wc) == before


def test_unknown_keys_model_dates_and_bad_estimates_stay_neutralised(wc: TestClient) -> None:
    """M6-33 is unchanged: what the model may not set or got wrong becomes a review issue, never data."""
    reply = plan(
        [
            {**GOOD, "start_date": "9999-99-99", "colour": "red", "estimate_workdays": "два"},
            {**SECOND, "estimate_workdays": 10**9},
        ],
        surprise={"nested": True},
    )
    scripted(wc, reply)

    response = propose(wc, start_date="2026-11-30")

    assert response.status_code == 201, response.text
    proposal = response.json()
    codes = {(i["local_id"], i["code"]) for i in proposal["issues"]}
    assert {("t1", "dates_ignored"), ("t1", "estimate_missing"), ("t2", "estimate_clamped")} <= codes
    first, second = proposal["tasks"]
    assert (
        first["start_date"] is None and first["estimate_workdays"] is None
    )  # no estimate → no invented dates
    assert second["estimate_workdays"] == PLAN_ESTIMATE_MAX and second["start_date"] == "2026-11-30"
    assert "colour" not in json.dumps(proposal) and "surprise" not in json.dumps(proposal)


# --- A3: one date range for proposals ----------------------------------------------------------------------------
@pytest.mark.parametrize("start", ["1999-12-31", "2101-01-03", "9999-12-30"])
def test_a_proposal_start_outside_the_range_is_refused_before_the_model_is_asked(
    wc: TestClient, start: str
) -> None:
    prompts = scripted(wc, plan([GOOD]))
    before = state(wc)

    response = propose(wc, start_date=start)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "invalid_date_range"
    assert response.json()["details"] == {"reason": "out_of_range", "field": "start_date"}
    assert prompts == []  # no model call, no cost
    assert state(wc) == before


def test_the_first_supported_day_is_accepted_and_moved_to_a_working_day(wc: TestClient) -> None:
    scripted(wc, plan([GOOD]))
    response = propose(wc, start_date="2000-01-01")  # Saturday
    assert response.status_code == 201, response.text
    assert response.json()["tasks"][0]["start_date"] == "2000-01-03"


@pytest.mark.parametrize("start", ["9999-12-30", "2999-01-05", "1999-12-31"])
def test_a_preview_or_apply_start_outside_the_range_is_a_422_and_writes_nothing(
    wc: TestClient, start: str
) -> None:
    """CODE-005: 9999-12-30 overflowed into a 500 on preview; 2999-01-05 was applied although a task cannot have it."""
    scripted(wc, plan([GOOD]))
    proposal = propose(wc, start_date="2026-11-30").json()
    before = state(wc)

    preview = wc.post(f"/api/work-ai/proposals/{proposal['id']}/preview", json={"start_date": start})
    applied = apply(wc, proposal, start_date=start)

    for response in (preview, applied):
        assert response.status_code == 422, response.text
        assert response.json()["code"] == "invalid_date_range"
        assert response.json()["details"] == {"reason": "out_of_range", "field": "start_date"}
    assert state(wc) == before
    assert wc.get(f"/api/work-ai/proposals/{proposal['id']}").json()["status"] == "suggested"


def test_a_plan_that_would_end_after_the_range_cannot_be_applied(wc: TestClient) -> None:
    """The start is valid (Thu 2100-12-30) but t1 (2 workdays) would end in 2101: the preview says so, apply refuses."""
    scripted(wc, plan([GOOD, MILESTONE], [{"predecessor": "t1", "successor": "m1"}]))
    proposal = propose(wc, start_date="2026-11-30").json()
    before = state(wc)

    preview = wc.post(f"/api/work-ai/proposals/{proposal['id']}/preview", json={"start_date": "2100-12-30"})
    applied = apply(wc, proposal, start_date="2100-12-30")

    assert preview.status_code == 200, preview.text
    shown = preview.json()
    assert shown["can_apply"] is False
    assert ("t1", "dates_out_of_range") in {(i["local_id"], i["code"]) for i in shown["issues"]}
    assert [(t["start_date"], t["end_exclusive"]) for t in shown["tasks"]] == [(None, None), (None, None)]
    assert applied.status_code == 422, applied.text
    assert applied.json()["details"]["reason"] == "plan_out_of_range"
    assert state(wc) == before


def test_a_plan_on_the_last_supported_days_is_applied(wc: TestClient) -> None:
    """Boundary: a 1-day task from Wed 2100-12-29 ends on Thu (end_exclusive Fri 2100-12-31), the milestone on Fri."""
    scripted(
        wc, plan([{**GOOD, "estimate_workdays": 1}, MILESTONE], [{"predecessor": "t1", "successor": "m1"}])
    )
    proposal = propose(wc, start_date="2100-12-29").json()
    assert proposal["can_apply"] is True

    applied = apply(wc, proposal)

    assert applied.status_code == 200, applied.text
    dates = {t["title"]: (t["start_date"], t["end_exclusive"]) for t in applied.json()["created_tasks"]}
    assert dates == {
        "Разобрать требования": ("2100-12-29", "2100-12-30"),
        "Веха": ("2100-12-30", "2100-12-30"),
    }


# --- A3: the same range for tasks and the scheduler ----------------------------------------------------------------
def test_a_duration_that_ends_after_the_range_is_refused_like_an_explicit_end(wc: TestClient) -> None:
    """CODE-011: start + duration_workdays may not produce an end the explicit end_exclusive check refuses."""
    derived = wc.post(
        "/api/projects/PLN/tasks",
        json={"title": "Длинная", "start_date": "2100-12-30", "duration_workdays": 2000},
    )
    explicit = wc.post(
        "/api/projects/PLN/tasks",
        json={"title": "Длинная", "start_date": "2100-12-30", "end_exclusive": "2108-08-30"},
    )
    last = wc.post(
        "/api/projects/PLN/tasks",
        json={"title": "Последняя", "start_date": "2100-12-30", "duration_workdays": 1},
    )

    for response in (derived, explicit):
        assert response.status_code == 422, response.text
        assert response.json()["details"] == {"reason": "out_of_range", "field": "end_exclusive"}
    assert last.status_code == 201, last.text
    assert (last.json()["start_date"], last.json()["end_exclusive"]) == ("2100-12-30", "2100-12-31")


@pytest.mark.parametrize("start,status", [("1999-12-31", 422), ("2000-01-03", 201), ("2101-01-03", 422)])
def test_task_start_bounds(wc: TestClient, start: str, status: int) -> None:
    response = wc.post(
        "/api/projects/PLN/tasks", json={"title": "Граница", "start_date": start, "duration_workdays": 1}
    )
    assert response.status_code == status, response.text
    if status == 422:
        assert response.json()["details"] == {"reason": "out_of_range", "field": "start_date"}


def test_shifting_dependants_past_the_range_is_a_conflict_and_apply_writes_nothing(wc: TestClient) -> None:
    """A dependency shift is a derived date too: moving A pushes its successor B into 2101 → conflict, not a write."""
    a = wc.post(
        "/api/projects/PLN/tasks", json={"title": "A", "start_date": "2100-12-27", "duration_workdays": 1}
    ).json()
    b = wc.post(
        "/api/projects/PLN/tasks", json={"title": "B", "start_date": "2100-12-29", "duration_workdays": 2}
    ).json()
    dep = wc.post(f"/api/tasks/{b['key']}/dependencies", json={"predecessor_task_id": a["id"]})
    assert dep.status_code == 201, dep.text
    before = state(wc)
    move = {
        "mode": "shift_successors",
        "changes": [{"task_id": a["id"], "start_date": "2100-12-29", "duration_workdays": 1}],
    }

    preview = wc.post("/api/projects/PLN/schedule/preview", json=move)

    assert preview.status_code == 200, preview.text
    shown = preview.json()
    assert shown["can_apply"] is False
    assert [(c["code"], c["key"]) for c in shown["conflicts"]] == [("out_of_range", b["key"])]
    applied = wc.post(
        "/api/projects/PLN/schedule/apply",
        json={
            "preview_id": shown["preview_id"],
            "expected_plan_revision": shown["base_plan_revision"],
            "client_request_id": "sched-apply-0001",
        },
    )
    assert applied.status_code in (409, 422), applied.text
    assert state(wc) == before
