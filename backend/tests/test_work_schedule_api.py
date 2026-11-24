"""M6 Step 2 over HTTP: FS dependencies, the Gantt snapshot, schedule preview → confirmed atomic apply.
Scenario ids: M6-03, M6-04, M6-05, M6-06, M6-07, M6-08, M6-09, M6-10, M6-18, M6-26, M6-28, M6-29, M6-30, M6-31,
M6-32 (+ 02 §8 «обязательные тесты»: Fri→Mon, Mon+2, locked, disconnected, diamond, missing duration, stale apply,
milestone FS, due date)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.work import store
from tests.test_work_api import audit_count, project, task

Client = Callable[..., TestClient]


@pytest.fixture
def wc(client_factory: Client) -> TestClient:
    c = client_factory(work_seed_demo=False)
    project(c, "SCH")
    return c


def dep(client: TestClient, pred: str, succ: str) -> Any:
    return client.post(f"/api/tasks/{succ}/dependencies", json={"predecessor_task_id": pred})


def preview(client: TestClient, **body: Any) -> Any:
    return client.post("/api/projects/SCH/schedule/preview", json=body)


def apply(client: TestClient, pv: dict[str, Any], key: str = "apply-req-0001", **extra: Any) -> Any:
    return client.post(
        "/api/projects/SCH/schedule/apply",
        json={
            "preview_id": pv["preview_id"],
            "expected_plan_revision": pv["base_plan_revision"],
            "client_request_id": key,
            **extra,
        },
    )


def snapshot(client: TestClient) -> tuple[Any, ...]:
    gantt = client.get("/api/projects/SCH/gantt").json()
    project_row = client.get("/api/projects/SCH").json()
    return (
        gantt["plan_revision"],
        project_row["version"],
        tuple((t["id"], t["version"], t["start_date"], t["end_exclusive"]) for t in gantt["tasks"]),
        tuple(d["id"] for d in gantt["dependencies"]),
        audit_count(client),
    )


# --- dependencies ------------------------------------------------------------------------------------------
def test_m6_04_m6_09_fs_after_friday_starts_monday(wc: TestClient) -> None:
    a = task(wc, "SCH", title="A", start_date="2026-11-27", duration_workdays=1)
    assert (a["end_exclusive"], a["last_day"]) == ("2026-11-28", "2026-11-27")
    early = task(wc, "SCH", title="B рано", start_date="2026-11-27", duration_workdays=1)
    ok = task(wc, "SCH", title="B", start_date="2026-11-30", duration_workdays=2)
    assert ok["end_exclusive"] == "2026-12-02"  # Mon 30 + 2 working days
    refused = dep(wc, "SCH-1", early["id"])
    assert refused.status_code == 422 and refused.json()["code"] == "schedule_conflict"
    assert refused.json()["details"]["earliest_start"] == "2026-11-30"
    created = dep(wc, "SCH-1", "SCH-3")
    assert created.status_code == 201 and created.json()["dependency"]["satisfied"] is True
    assert created.json()["plan_revision"] == 5
    pv = preview(wc, add_dependencies=[{"predecessor_task_id": "SCH-1", "successor_task_id": "SCH-2"}]).json()
    assert [(o["key"], o["after"]["start_date"]) for o in pv["operations"]] == [("SCH-2", "2026-11-30")]


def test_m6_05_cycle_is_rejected_without_partial_writes(wc: TestClient) -> None:
    for name in "ABC":
        task(wc, "SCH", title=name)
    assert dep(wc, "SCH-1", "SCH-2").status_code == 201
    assert dep(wc, "SCH-2", "SCH-3").status_code == 201
    before = snapshot(wc)
    cycle = dep(wc, "SCH-3", "SCH-1")
    assert cycle.status_code == 422 and cycle.json()["code"] == "dependency_cycle"
    assert cycle.json()["details"]["cycle_keys"] == ["SCH-3", "SCH-1", "SCH-2", "SCH-3"]
    assert "SCH-3 → SCH-1 → SCH-2 → SCH-3" in cycle.json()["message"]
    via_preview = preview(
        wc,
        mode="shift_successors",
        add_dependencies=[{"predecessor_task_id": "SCH-3", "successor_task_id": "SCH-1"}],
    )
    assert via_preview.json()["code"] == "dependency_cycle"
    assert snapshot(wc) == before


@pytest.mark.parametrize(
    ("pred", "succ", "reason"),
    [
        ("SCH-1", "SCH-1", "self"),
        ("SCH-1", "OTH-1", "not_in_project"),
        ("SCH-1", "deadbeef", "not_in_project"),
    ],
)
def test_m6_06_m6_07_self_and_cross_project_dependencies(
    wc: TestClient, pred: str, succ: str, reason: str
) -> None:
    task(wc, "SCH")
    project(wc, "OTH")
    task(wc, "OTH")
    response = wc.post(
        "/api/tasks/SCH-1/dependencies", json={"successor_task_id": succ} if pred == "SCH-1" else {}
    )
    assert response.status_code == 422 and response.json()["code"] == "invalid_dependency"
    assert response.json()["details"]["reason"] == reason


def test_duplicate_hierarchy_archived_and_lag_rules(wc: TestClient) -> None:
    parent = task(wc, "SCH", title="Родитель")
    child = task(wc, "SCH", title="Дочерняя", parent_task_id=parent["id"])
    other = task(wc, "SCH", title="Другая")
    assert dep(wc, parent["id"], child["id"]).json()["details"]["reason"] == "hierarchy"
    assert dep(wc, other["id"], parent["id"]).status_code == 201
    assert dep(wc, other["id"], parent["id"]).json()["details"]["reason"] == "duplicate"
    lag = wc.post(
        f"/api/tasks/{parent['id']}/dependencies",
        json={"predecessor_task_id": child["id"], "lag_workdays": 2},
    )
    assert lag.status_code == 422  # P0: FS with lag 0 only
    kind = wc.post(
        f"/api/tasks/{other['id']}/dependencies", json={"successor_task_id": child["id"], "kind": "SS"}
    )
    assert kind.status_code == 422
    archived = wc.delete(f"/api/tasks/{other['id']}", params={"expected_version": 1}).json()
    assert len(archived["removed_dependency_ids"]) == 1  # archiving drops the task's edges (audited)
    assert wc.get(f"/api/tasks/{parent['id']}/dependencies").json()["predecessors"] == []
    assert dep(wc, other["id"], child["id"]).json()["details"]["reason"] == "archived"


def test_dependencies_list_and_remove(wc: TestClient) -> None:
    task(wc, "SCH", start_date="2026-11-30", duration_workdays=1)
    task(wc, "SCH", start_date="2026-12-01", duration_workdays=1)
    created = dep(wc, "SCH-1", "SCH-2").json()["dependency"]
    listed = wc.get("/api/tasks/SCH-1/dependencies").json()
    assert listed["predecessors"] == [] and listed["successors"][0]["task"]["key"] == "SCH-2"
    stale = wc.delete(f"/api/tasks/SCH-1/dependencies/{created['id']}", params={"expected_plan_revision": 1})
    assert stale.status_code == 409 and stale.json()["code"] == "stale_schedule"
    removed = wc.delete(f"/api/tasks/SCH-1/dependencies/{created['id']}")
    assert removed.status_code == 200
    assert wc.delete(f"/api/tasks/SCH-1/dependencies/{created['id']}").status_code == 404
    events = [e["operation"] for e in wc.get("/api/tasks/SCH-1/activity").json()["items"]]
    assert events[:2] == ["dependency_removed", "dependency_added"]  # visible from the predecessor too


def test_direct_date_edit_may_not_break_fs_or_a_lock(wc: TestClient) -> None:
    a = task(wc, "SCH", start_date="2026-11-30", duration_workdays=2)
    b = task(wc, "SCH", start_date="2026-12-02", duration_workdays=1, date_locked=True)
    dep(wc, "SCH-1", "SCH-2")
    longer = wc.patch(f"/api/tasks/{a['id']}", json={"expected_version": 1, "duration_workdays": 3})
    assert longer.status_code == 422 and longer.json()["details"]["reason"] == "fs_violation"
    locked = wc.patch(f"/api/tasks/{b['id']}", json={"expected_version": 1, "start_date": "2026-12-03"})
    assert locked.json()["details"]["reason"] == "task_locked"
    unlock_and_move = wc.patch(
        f"/api/tasks/{b['id']}",
        json={"expected_version": 1, "date_locked": False, "start_date": "2026-12-03"},
    )
    assert unlock_and_move.status_code == 200 and unlock_and_move.json()["start_date"] == "2026-12-03"


# --- gantt -------------------------------------------------------------------------------------------------
def test_gantt_is_one_consistent_snapshot_in_tree_order(wc: TestClient) -> None:
    root = task(wc, "SCH", title="Корень", start_date="2026-11-30", duration_workdays=5)
    task(wc, "SCH", title="Поздняя", start_date="2026-12-07", duration_workdays=1)
    task(wc, "SCH", title="Дочерняя", parent_task_id=root["id"], start_date="2026-11-30", duration_workdays=1)
    task(wc, "SCH", title="Без дат")
    gantt = wc.get("/api/projects/SCH/gantt").json()
    assert [t["title"] for t in gantt["tasks"]] == ["Корень", "Дочерняя", "Поздняя", "Без дат"]
    assert gantt["calendar"] == {
        "id": "mon_fri_v1",
        "kind": "mon_fri",
        "workdays": [1, 2, 3, 4, 5],
        "holidays": [],
        "timezone": "Europe/Moscow",
        "interval": "[start_date, end_exclusive)",
    }
    assert (gantt["range_start"], gantt["range_end_exclusive"]) == ("2026-11-30", "2026-12-08")
    assert gantt["critical_path"] is None and gantt["features"]["critical_path"] is False  # no fake CPM
    assert gantt["violations"] == [] and len(gantt["unscheduled_task_ids"]) == 1


# --- preview / apply -----------------------------------------------------------------------------------------
def chain(client: TestClient) -> None:
    """A[Mon30] → B[Tue1] → C[Wed2], X independent."""
    task(client, "SCH", title="A", start_date="2026-11-30", duration_workdays=1)
    task(client, "SCH", title="B", start_date="2026-12-01", duration_workdays=1)
    task(client, "SCH", title="C", start_date="2026-12-02", duration_workdays=1, due_date="2026-12-02")
    task(client, "SCH", title="X", start_date="2026-11-30", duration_workdays=1)
    assert dep(client, "SCH-1", "SCH-2").status_code == 201
    assert dep(client, "SCH-2", "SCH-3").status_code == 201


def test_m6_30_preview_writes_nothing(wc: TestClient) -> None:
    chain(wc)
    before = snapshot(wc)
    pv = preview(wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 2}])
    assert pv.status_code == 200
    body = pv.json()
    assert [
        (o["key"], o["change"], o["after"]["start_date"], o["shift_workdays"]) for o in body["operations"]
    ] == [
        ("SCH-1", "requested", "2026-12-01", 1),
        ("SCH-2", "shifted", "2026-12-03", 2),
        ("SCH-3", "shifted", "2026-12-04", 2),
    ]
    assert body["operations"][1]["because_of"] == [wc.get("/api/tasks/SCH-1").json()["id"]]
    assert body["warnings"][0]["code"] == "due_date_exceeded" and body["warnings"][0]["key"] == "SCH-3"
    assert body["can_apply"] is True and body["conflicts"] == [] and body["critical_path"] is None
    assert snapshot(wc) == before  # M6-30: no task, revision or audit change


def test_m6_03_m6_04_apply_writes_atomically_and_every_view_agrees(wc: TestClient) -> None:
    chain(wc)
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "end_exclusive": "2026-12-03"}]
    ).json()
    unconfirmed = apply(wc, pv)
    assert (
        unconfirmed.status_code == 422 and unconfirmed.json()["details"]["reason"] == "warnings_not_accepted"
    )
    result = apply(wc, pv, accept_warnings=True)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["applied"] is True and body["plan_revision"] == pv["base_plan_revision"] + 1
    assert [t["key"] for t in body["changed_tasks"]] == ["SCH-1", "SCH-2", "SCH-3"]
    listed = {t["key"]: t for t in wc.get("/api/projects/SCH/tasks").json()["items"]}
    gantt = {t["key"]: t for t in wc.get("/api/projects/SCH/gantt").json()["tasks"]}
    for key, start in (
        ("SCH-1", "2026-12-01"),
        ("SCH-2", "2026-12-03"),
        ("SCH-3", "2026-12-04"),
        ("SCH-4", "2026-11-30"),
    ):
        assert listed[key]["start_date"] == gantt[key]["start_date"] == start
    assert listed["SCH-3"]["due_date"] == "2026-12-02"  # the deadline is never rewritten
    events = wc.get("/api/tasks/SCH-2/activity").json()["items"]
    assert events[0]["operation"] == "schedule_applied" and events[0]["correlation_id"] == pv["preview_id"]
    assert events[0]["changes"]["start_date"] == {"before": "2026-12-01", "after": "2026-12-03"}


def test_m6_31_change_between_preview_and_apply_is_stale_and_rolls_back(wc: TestClient) -> None:
    chain(wc)
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 1}]
    ).json()
    wc.patch("/api/tasks/SCH-4", json={"expected_version": 1, "title": "Кто-то изменил задачу"})
    before = snapshot(wc)
    stale = apply(wc, pv)
    assert stale.status_code == 409 and stale.json()["code"] == "stale_schedule"
    assert stale.json()["details"]["reason"] == "plan_revision"
    assert snapshot(wc) == before
    fresh = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 1}]
    ).json()
    assert apply(wc, fresh, key="apply-req-0002", accept_warnings=True).status_code == 200


def test_m6_32_double_apply_is_one_application(wc: TestClient) -> None:
    chain(wc)
    pv = preview(
        wc, changes=[{"task_id": "SCH-4", "start_date": "2026-12-07", "duration_workdays": 1}]
    ).json()
    first = apply(wc, pv, key="apply-twice-0001")
    after_first = snapshot(wc)
    replay = apply(wc, pv, key="apply-twice-0001")
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert replay.json()["plan_revision"] == first.json()["plan_revision"]
    assert snapshot(wc) == after_first  # one application, one set of audit events
    other_key = apply(wc, pv, key="apply-twice-0002")
    assert other_key.status_code == 409 and other_key.json()["details"]["reason"] == "already_applied"
    reused = wc.post(
        "/api/projects/SCH/schedule/apply",
        json={
            "preview_id": pv["preview_id"],
            "expected_plan_revision": 99,
            "client_request_id": "apply-twice-0001",
        },
    )
    assert reused.status_code == 409 and reused.json()["details"]["reason"] == "idempotency_key_reused"


def test_m6_08_m6_29_locked_successor_blocks_apply_and_changes_nothing(wc: TestClient) -> None:
    task(wc, "SCH", title="A", start_date="2026-11-30", duration_workdays=1)
    task(wc, "SCH", title="B", start_date="2026-12-01", duration_workdays=1, date_locked=True)
    dep(wc, "SCH-1", "SCH-2")
    before = snapshot(wc)
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-11-30", "duration_workdays": 3}]
    ).json()
    assert pv["can_apply"] is False
    assert [(c["code"], c["key"]) for c in pv["conflicts"]] == [("locked_successor", "SCH-2")]
    refused = apply(wc, pv)
    assert refused.status_code == 422 and refused.json()["details"]["reason"] == "conflicts"
    assert snapshot(wc) == before
    only = preview(
        wc,
        mode="only_this_task",
        changes=[{"task_id": "SCH-1", "start_date": "2026-11-30", "duration_workdays": 3}],
    ).json()
    assert [c["code"] for c in only["conflicts"]] == ["successor_violation"]


def test_m6_18_failure_in_the_middle_of_apply_rolls_back_everything(wc: TestClient) -> None:
    chain(wc)
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 1}]
    ).json()
    assert len(pv["operations"]) == 3
    before = snapshot(wc)
    service = wc.app.state.container.work  # type: ignore[attr-defined]
    calls: list[str] = []

    def explode(task_id: str) -> None:
        calls.append(task_id)
        if len(calls) == 2:
            raise RuntimeError("simulated failure after the second write")

    service._after_schedule_write = explode
    with pytest.raises(
        RuntimeError, match="simulated failure"
    ):  # the app answers 500; the test client re-raises
        apply(wc, pv, accept_warnings=True)
    assert len(calls) == 2
    assert snapshot(wc) == before  # first task write, audit, revision: all rolled back
    with service.db.read() as conn:
        assert store.get_preview(conn, pv["preview_id"])["applied_at"] is None
        assert (
            store.get_idempotent(
                conn, f"schedule_apply:{pv['project_id']}", "local-demo-user", "apply-req-0001"
            )
            is None
        )
    service._after_schedule_write = None
    assert (
        apply(wc, pv, accept_warnings=True).status_code == 200
    )  # the same confirmed preview applies afterwards


def test_m6_28_diamond_and_independent_branch_over_the_api(wc: TestClient) -> None:
    for title, start, days in (
        ("A", "2026-11-30", 1),
        ("B", "2026-12-01", 1),
        ("C", "2026-12-01", 3),
        ("D", "2026-12-04", 1),
        ("E", "2026-11-30", 2),
    ):
        task(wc, "SCH", title=title, start_date=start, duration_workdays=days)
    for pred, succ in (("SCH-1", "SCH-2"), ("SCH-1", "SCH-3"), ("SCH-2", "SCH-4"), ("SCH-3", "SCH-4")):
        assert dep(wc, pred, succ).status_code == 201
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 1}]
    ).json()
    after = {o["key"]: o["after"]["start_date"] for o in pv["operations"]}
    assert after == {
        "SCH-1": "2026-12-01",
        "SCH-2": "2026-12-02",
        "SCH-3": "2026-12-02",
        "SCH-4": "2026-12-07",
    }
    assert "SCH-5" not in after


def test_m6_10_milestone_is_zero_duration_and_takes_part_in_fs(wc: TestClient) -> None:
    task(wc, "SCH", title="Работа", start_date="2026-11-30", duration_workdays=2)
    m = task(wc, "SCH", title="Веха", is_milestone=True, start_date="2026-12-02", duration_workdays=0)
    assert (m["start_date"], m["end_exclusive"], m["duration_workdays"], m["last_day"]) == (
        "2026-12-02",
        "2026-12-02",
        0,
        None,
    )
    task(wc, "SCH", title="После вехи", start_date="2026-12-02", duration_workdays=1)
    dep(wc, "SCH-1", "SCH-2")
    dep(wc, "SCH-2", "SCH-3")
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-11-30", "duration_workdays": 4}]
    ).json()
    after = {o["key"]: (o["after"]["start_date"], o["after"]["end_exclusive"]) for o in pv["operations"]}
    assert after["SCH-2"] == ("2026-12-04", "2026-12-04") and after["SCH-3"] == ("2026-12-04", "2026-12-05")
    resize = preview(wc, changes=[{"task_id": "SCH-2", "start_date": "2026-12-04", "duration_workdays": 2}])
    assert resize.status_code == 422 and resize.json()["details"]["reason"] == "milestone_duration"
    # a task with dates becomes a milestone only as a point
    to_point = wc.patch("/api/tasks/SCH-3", json={"expected_version": 1, "is_milestone": True})
    assert to_point.status_code == 200 and to_point.json()["end_exclusive"] == to_point.json()["start_date"]


def test_m6_26_m6_27_due_date_is_inclusive_and_unscheduled_are_blocked(wc: TestClient) -> None:
    on_time = task(
        wc, "SCH", title="В срок", start_date="2026-11-30", end_exclusive="2026-12-02", due_date="2026-12-01"
    )
    assert (
        on_time["last_day"] == on_time["due_date"] == "2026-12-01"
        and on_time["end_exclusive"] == "2026-12-02"
    )
    task(wc, "SCH", title="Без дат", estimate_workdays=2)
    dep(wc, "SCH-1", "SCH-2")
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-11-30", "end_exclusive": "2026-12-02"}]
    ).json()
    assert pv["operations"] == [] and pv["warnings"] == []  # same dates: no off-by-one warning
    moved = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 2}]
    ).json()
    assert (
        moved["warnings"][0]["last_day"] == "2026-12-02" and moved["warnings"][0]["due_date"] == "2026-12-01"
    )
    assert [(b["key"], b["reason"]) for b in moved["blocked_tasks"]] == [("SCH-2", "unscheduled")]
    assert all(o["key"] != "SCH-2" for o in moved["operations"])


def test_add_dependency_through_preview_shifts_and_creates_the_edge(wc: TestClient) -> None:
    task(wc, "SCH", title="A", start_date="2026-11-30", duration_workdays=3)
    task(wc, "SCH", title="B", start_date="2026-11-30", duration_workdays=1)
    task(wc, "SCH", title="C", start_date="2026-12-01", duration_workdays=1)
    dep(wc, "SCH-2", "SCH-3")
    pv = preview(wc, add_dependencies=[{"predecessor_task_id": "SCH-1", "successor_task_id": "SCH-2"}]).json()
    assert [(o["key"], o["after"]["start_date"]) for o in pv["operations"]] == [
        ("SCH-2", "2026-12-03"),
        ("SCH-3", "2026-12-04"),
    ]
    done = apply(wc, pv).json()
    assert len(done["added_dependencies"]) == 1 and done["added_dependencies"][0]["satisfied"] is True
    assert wc.get("/api/projects/SCH/gantt").json()["violations"] == []


def test_resolve_violations_repairs_a_legacy_break(wc: TestClient) -> None:
    a = task(wc, "SCH", title="A", start_date="2026-11-30", duration_workdays=3)
    b = task(wc, "SCH", title="B", start_date="2026-12-03", duration_workdays=1)
    dep(wc, "SCH-1", "SCH-2")
    with wc.app.state.container.work.db.write() as conn:  # type: ignore[attr-defined]
        conn.execute(
            "UPDATE work_tasks SET start_date = '2026-11-30', end_exclusive = '2026-12-01' WHERE id = ?",
            (b["id"],),
        )
    gantt = wc.get("/api/projects/SCH/gantt").json()
    assert [v["successor_id"] for v in gantt["violations"]] == [b["id"]]
    pv = preview(wc, mode="resolve_violations").json()
    assert [(o["key"], o["after"]["start_date"]) for o in pv["operations"]] == [("SCH-2", "2026-12-03")]
    assert apply(wc, pv).status_code == 200
    assert wc.get("/api/projects/SCH/gantt").json()["violations"] == []
    assert a["id"]


def test_preview_validation_expiry_and_ownership(wc: TestClient) -> None:
    task(wc, "SCH", start_date="2026-11-30", duration_workdays=1)
    assert preview(wc, changes=[]).status_code == 422  # nothing to preview
    assert preview(wc, changes=[{"task_id": "SCH-1", "start_date": "2026-11-30"}]).status_code == 422
    assert (
        preview(
            wc, changes=[{"task_id": "nope", "start_date": "2026-11-30", "duration_workdays": 1}]
        ).status_code
        == 404
    )
    two = [{"task_id": "SCH-1", "start_date": "2026-11-30", "duration_workdays": 1}] * 2
    assert preview(wc, changes=two).status_code == 422
    assert preview(wc, mode="resolve_violations", base_plan_revision=1).json()["code"] == "stale_schedule"
    pv = preview(
        wc, changes=[{"task_id": "SCH-1", "start_date": "2026-12-01", "duration_workdays": 1}]
    ).json()
    service = wc.app.state.container.work  # type: ignore[attr-defined]
    real_now = service.now
    service.now = lambda: real_now() + timedelta(seconds=service.preview_ttl_seconds + 1)
    expired = apply(wc, pv)
    assert expired.status_code == 409 and expired.json()["details"]["reason"] == "expired"
    service.now = real_now
    missing = wc.post(
        "/api/projects/SCH/schedule/apply",
        json={"preview_id": "0" * 32, "expected_plan_revision": 1, "client_request_id": "apply-missing-1"},
    )
    assert missing.status_code == 404
    wrong_revision = apply(
        wc, {**pv, "base_plan_revision": pv["base_plan_revision"] + 5}, key="apply-wrong-rev"
    )
    assert wrong_revision.status_code == 409 and wrong_revision.json()["code"] == "stale_schedule"


def test_hundred_node_dag_preview_over_the_api(wc: TestClient) -> None:
    for i in range(1, 121):
        task(wc, "SCH", title=f"Шаг {i}", start_date="2026-11-30", duration_workdays=1)
    with wc.app.state.container.work.db.write() as conn:  # type: ignore[attr-defined]
        project_id = conn.execute("SELECT id FROM work_projects WHERE key = 'SCH'").fetchone()[0]
        ids = [
            r[0]
            for r in conn.execute(
                "SELECT id FROM work_tasks WHERE project_id = ? ORDER BY number", (project_id,)
            )
        ]
        for i in range(len(ids) - 1):  # a chain plus cross edges, inserted as legacy data
            store.insert_dependency(
                conn,
                {
                    "id": f"d{i}",
                    "project_id": project_id,
                    "predecessor_id": ids[i],
                    "successor_id": ids[i + 1],
                    "kind": "FS",
                    "lag_workdays": 0,
                    "created_by": "t",
                    "created_at": "t",
                },
            )
    pv = preview(wc, mode="resolve_violations").json()
    assert len(pv["operations"]) == 119 and pv["can_apply"]
    assert apply(wc, pv).status_code == 200
    last = wc.get("/api/tasks/SCH-120").json()
    assert last["start_date"] == "2027-05-14"  # 119 working days after Mon 2026-11-30 (Mon–Fri only)
