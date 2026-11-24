"""M6 Step 1 over HTTP: projects, tasks, subtasks, validation, optimistic locking, idempotency, archive, audit,
seed, restart persistence and the identity gate. Scenario ids in the test names: M6-01, M6-17, M6-19, M6-20,
M6-21, M6-22, M6-25, M6-27, M6-35, M6-36, M6-37, M6-40."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.authz import Action
from app.work import store
from tests.support.work_identity import enable_membership, team_user
from tests.test_authz import _actions, api_routes

Client = Callable[..., TestClient]


@pytest.fixture
def wc(client_factory: Client) -> TestClient:
    """A clean work module (no demo seed)."""
    return client_factory(work_seed_demo=False)


def project(client: TestClient, key: str = "TST", **extra: Any) -> dict[str, Any]:
    response = client.post("/api/projects", json={"key": key, "title": f"Проект {key}", **extra})
    assert response.status_code == 201, response.text
    return dict(response.json())


def task(client: TestClient, project_ref: str, **fields: Any) -> dict[str, Any]:
    body = {"title": "Задача", **fields}
    response = client.post(f"/api/projects/{project_ref}/tasks", json=body)
    assert response.status_code == 201, response.text
    return dict(response.json())


def patch(client: TestClient, task_ref: str, **fields: Any) -> Any:
    return client.patch(f"/api/tasks/{task_ref}", json=fields)


def audit_count(client: TestClient) -> int:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return store.count_audit(conn)


# --- routes and actions --------------------------------------------------------------------------------------
WORK_ROUTES = {
    ("GET", "/api/work/capabilities"): Action.view_projects,
    ("GET", "/api/work/assignees"): Action.view_projects,
    ("GET", "/api/projects"): Action.view_projects,
    ("POST", "/api/projects"): Action.manage_project,
    ("GET", "/api/projects/{project_id}"): Action.view_projects,
    ("PATCH", "/api/projects/{project_id}"): Action.manage_project,
    ("GET", "/api/projects/{project_id}/members"): Action.view_projects,
    ("GET", "/api/projects/{project_id}/activity"): Action.view_work_audit,
    ("GET", "/api/projects/{project_id}/tasks"): Action.view_tasks,
    ("POST", "/api/projects/{project_id}/tasks"): Action.create_task,
    ("GET", "/api/tasks/{task_id}"): Action.view_tasks,
    ("PATCH", "/api/tasks/{task_id}"): Action.edit_task,
    ("DELETE", "/api/tasks/{task_id}"): Action.edit_task,
    ("POST", "/api/tasks/{task_id}/restore"): Action.edit_task,
    ("GET", "/api/tasks/{task_id}/activity"): Action.view_work_audit,
}


def test_every_work_route_declares_its_action(wc: TestClient) -> None:
    seen = {(m, r.path): _actions(r.dependant) for r in api_routes(wc) for m in r.methods}
    work_paths = {k for k in seen if k[1].startswith(("/api/projects", "/api/tasks", "/api/work"))}
    assert work_paths == set(WORK_ROUTES)
    for key, action in WORK_ROUTES.items():
        assert seen[key] == {action}, key


# --- M6-01 CRUD ----------------------------------------------------------------------------------------------
def test_m6_01_project_with_three_tasks_is_visible_in_every_view(wc: TestClient) -> None:
    p = project(
        wc, "CRUD", description="Описание **Markdown**", start_date="2026-11-30", target_date="2026-12-31"
    )
    assert p["key"] == "CRUD" and p["version"] == 1 and p["plan_revision"] == 1 and p["is_demo"] is False
    assert p["my_role"] == "local_operator" and p["created_by"] == "local-demo-user"
    created = [
        task(
            wc,
            "CRUD",
            title="Анализ",
            start_date="2026-11-30",
            duration_workdays=2,
            assignee_id="demo-analyst",
        ),
        task(wc, p["id"], title="Разработка", priority="high"),
        task(
            wc, "CRUD", title="Релиз", is_milestone=True, start_date="2026-12-04", end_exclusive="2026-12-04"
        ),
    ]
    assert [t["key"] for t in created] == ["CRUD-1", "CRUD-2", "CRUD-3"]
    first = created[0]
    assert (first["start_date"], first["end_exclusive"], first["last_day"], first["duration_workdays"]) == (
        "2026-11-30",
        "2026-12-02",
        "2026-12-01",
        2,
    )
    assert first["assignee"] == {"id": "demo-analyst", "display_name": "Аналитик (демо)", "kind": "fixture"}
    listed = wc.get("/api/projects/CRUD/tasks").json()
    detail = wc.get("/api/tasks/CRUD-2").json()
    assert [t["key"] for t in listed["items"]] == ["CRUD-1", "CRUD-2", "CRUD-3"]
    unscheduled = wc.get("/api/projects/CRUD/tasks", params={"scheduled": False}).json()["items"]
    assert [t["id"] for t in unscheduled] == [created[1]["id"]]
    assert detail["id"] == created[1]["id"] and detail["priority"] == "high"
    assert listed["plan_revision"] == 4  # created + three tasks
    card = wc.get("/api/projects/CRUD").json()
    assert (
        card["stats"]["total"] == 3 and card["stats"]["milestones"] == 1 and card["stats"]["unscheduled"] == 1
    )
    assert card["stats"]["next_milestone"]["key"] == "CRUD-3"


def test_project_validation_and_unique_key(wc: TestClient) -> None:
    project(wc, "DUP")
    dup = wc.post("/api/projects", json={"key": "DUP", "title": "Второй"})
    assert dup.status_code == 409 and dup.json()["details"]["reason"] == "key_taken"
    for body in (
        {"key": "dup", "title": "x"},  # lower case
        {"key": "D", "title": "x"},  # too short
        {"key": "OK1", "title": "   "},  # blank
        {"key": "OK2", "title": "x", "timezone": "Mars/Base"},
        {"key": "OK3", "title": "x", "start_date": "2026-12-10", "target_date": "2026-12-01"},
        {"key": "OK4", "title": "x", "created_by": "someone"},  # server-owned field
        {"key": "OK5", "title": "x", "version": 7},
    ):
        assert wc.post("/api/projects", json=body).status_code == 422, body


def test_project_patch_uses_optimistic_locking(wc: TestClient) -> None:
    p = project(wc, "PATCH")
    ok = wc.patch(
        "/api/projects/PATCH", json={"expected_version": 1, "title": "Новое имя", "status": "on_hold"}
    )
    assert ok.status_code == 200 and ok.json()["version"] == 2 and ok.json()["status"] == "on_hold"
    stale = wc.patch(f"/api/projects/{p['id']}", json={"expected_version": 1, "title": "Устаревшее"})
    assert stale.status_code == 409 and stale.json()["code"] == "stale_project"
    assert stale.json()["details"]["current_version"] == 2
    archived = wc.patch("/api/projects/PATCH", json={"expected_version": 2, "status": "archived"}).json()
    assert archived["archived_at"] is not None
    assert (
        wc.post("/api/projects/PATCH/tasks", json={"title": "x"}).json()["details"]["reason"]
        == "project_archived"
    )
    assert wc.get("/api/projects").json()["total"] == 0
    assert wc.get("/api/projects", params={"include_archived": True}).json()["total"] == 1


# --- validation ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("fields", "code", "reason"),
    [
        ({"start_date": "2026-11-30"}, "invalid_date_range", "partial"),
        ({"end_exclusive": "2026-11-30"}, "invalid_date_range", "partial"),
        (
            {"start_date": "2026-12-02", "end_exclusive": "2026-11-30"},
            "invalid_date_range",
            "end_before_start",
        ),
        ({"start_date": "2026-11-28", "end_exclusive": "2026-11-30"}, "invalid_date_range", "no_workdays"),
        ({"start_date": "2026-11-30", "duration_workdays": 0}, "invalid_date_range", "duration_zero"),
        (
            {"start_date": "2026-11-30", "end_exclusive": "2026-12-04", "duration_workdays": 2},
            "invalid_date_range",
            "duration_mismatch",
        ),
        (
            {"is_milestone": True, "start_date": "2026-11-30", "end_exclusive": "2026-12-01"},
            "invalid_date_range",
            "milestone_point",
        ),
        ({"date_locked": True}, "invalid_date_range", "lock_requires_dates"),
        ({"start_date": "1999-12-31", "duration_workdays": 1}, "invalid_date_range", "out_of_range"),
        ({"assignee_id": "real.person@bank"}, "invalid_assignee", None),
        ({"status": "blocked"}, "invalid_request", None),  # «blocked» is computed, never a status
        ({"title": "x" * 201}, "invalid_request", None),
        ({"description": "x" * 20_001}, "invalid_request", None),
        ({"key": "TST-99"}, "invalid_request", None),
        ({"created_by": "attacker"}, "invalid_request", None),
        ({"lag_workdays": 1}, "invalid_request", None),
    ],
)
def test_task_validation(wc: TestClient, fields: dict[str, Any], code: str, reason: str | None) -> None:
    project(wc)
    response = wc.post("/api/projects/TST/tasks", json={"title": "Задача", **fields})
    assert response.status_code == 422, response.text
    assert response.json()["code"] == code
    if reason:
        assert response.json()["details"]["reason"] == reason


def test_dates_are_stored_canonically_and_unicode_is_kept(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "TST", title="  Ёжик — «проверка» 🦔  ", start_date="2026-11-28", end_exclusive="2026-12-01")
    assert t["title"] == "Ёжик — «проверка» 🦔"
    assert (t["start_date"], t["end_exclusive"], t["duration_workdays"]) == ("2026-11-30", "2026-12-01", 1)
    fri = task(wc, "TST", start_date="2026-11-27", end_exclusive="2026-11-30")  # [Fri, Mon) = Friday only
    assert (fri["end_exclusive"], fri["last_day"]) == ("2026-11-28", "2026-11-27")


def test_m6_27_unscheduled_task_lives_in_list_board_and_the_unscheduled_pool(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "TST", title="Без дат", estimate_workdays=3)
    assert (t["start_date"], t["end_exclusive"], t["duration_workdays"], t["scheduled"]) == (
        None,
        None,
        None,
        False,
    )
    assert wc.get("/api/projects/TST/tasks", params={"status": "todo"}).json()["total"] == 1
    assert [
        x["id"] for x in wc.get("/api/projects/TST/tasks", params={"scheduled": False}).json()["items"]
    ] == [t["id"]]
    moved = patch(wc, t["id"], expected_version=1, status="in_progress").json()
    assert moved["start_date"] is None  # no invented dates on any edit
    scheduled = patch(wc, t["id"], expected_version=2, start_date="2026-11-30", duration_workdays=3).json()
    assert scheduled["end_exclusive"] == "2026-12-03"
    unscheduled = patch(wc, t["id"], expected_version=3, start_date=None, end_exclusive=None).json()
    assert unscheduled["scheduled"] is False


def test_patch_semantics_move_keeps_duration_and_null_clears(wc: TestClient) -> None:
    project(wc)
    t = task(
        wc, "TST", start_date="2026-11-30", duration_workdays=3, assignee_id="demo-qa", due_date="2026-12-10"
    )
    moved = patch(wc, "TST-1", expected_version=1, start_date="2026-12-03").json()
    assert (moved["start_date"], moved["end_exclusive"], moved["duration_workdays"]) == (
        "2026-12-03",
        "2026-12-08",
        3,
    )
    cleared = patch(wc, t["id"], expected_version=2, assignee_id=None, due_date=None).json()
    assert cleared["assignee_id"] is None and cleared["due_date"] is None
    assert patch(wc, t["id"], expected_version=3, title=None).status_code == 422
    assert patch(wc, t["id"], expected_version=3, end_exclusive=None).json()["details"]["reason"] == "partial"
    same = patch(wc, t["id"], expected_version=3, title=cleared["title"]).json()
    assert same["version"] == 3  # no change → no new version, no revision bump


def test_m6_17_stale_task_version_is_409_with_the_current_version(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "TST")
    first = patch(wc, t["id"], expected_version=1, status="in_progress")
    assert first.status_code == 200 and first.json()["version"] == 2
    second = patch(wc, t["id"], expected_version=1, status="done")
    assert second.status_code == 409 and second.json()["code"] == "stale_task"
    assert second.json()["details"]["current_version"] == 2
    assert (
        wc.get(f"/api/tasks/{t['id']}").json()["status"] == "in_progress"
    )  # nothing was lost or overwritten


def test_m6_02_status_moves_freely_and_list_sees_it(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "TST")
    version = 1
    for status in ("in_progress", "review", "todo", "done", "in_progress"):
        response = patch(wc, t["id"], expected_version=version, status=status)
        assert response.status_code == 200 and response.json()["status"] == status
        version = response.json()["version"]
    assert (
        wc.get("/api/projects/TST/tasks", params={"status": "in_progress"}).json()["items"][0]["id"]
        == t["id"]
    )


def test_m6_36_views_share_one_plan_revision_after_a_mutation(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "TST", start_date="2026-11-30", duration_workdays=1)
    patch(wc, t["id"], expected_version=1, status="review", start_date="2026-12-01")
    listed = wc.get("/api/projects/TST/tasks").json()
    card = wc.get("/api/projects/TST").json()
    assert listed["plan_revision"] == card["plan_revision"] == 3
    rows = [listed["items"][0], wc.get(f"/api/tasks/{t['id']}").json()]
    assert {(r["status"], r["start_date"], r["end_exclusive"], r["version"]) for r in rows} == {
        ("review", "2026-12-01", "2026-12-02", 2)
    }


# --- hierarchy, archive ------------------------------------------------------------------------------------
def test_subtasks_up_to_four_levels_and_hierarchy_rules(wc: TestClient) -> None:
    project(wc)
    level1 = task(wc, "TST", title="1")
    level2 = task(wc, "TST", title="2", parent_task_id=level1["id"])
    level3 = task(wc, "TST", title="3", parent_task_id=level2["id"])
    level4 = task(wc, "TST", title="4", parent_task_id=level3["id"])
    assert [t["depth"] for t in (level1, level2, level3, level4)] == [1, 2, 3, 4]
    too_deep = wc.post("/api/projects/TST/tasks", json={"title": "5", "parent_task_id": level4["id"]})
    assert too_deep.status_code == 422 and too_deep.json()["details"]["reason"] == "too_deep"
    cycle = patch(wc, level1["id"], expected_version=1, parent_task_id=level3["id"])
    assert cycle.json()["details"]["reason"] == "parent_cycle"
    assert (
        patch(wc, level1["id"], expected_version=1, parent_task_id=level1["id"]).json()["details"]["reason"]
        == "self_parent"
    )
    other = task(wc, "TST", title="Другая ветка")
    deep = patch(wc, level2["id"], expected_version=1, parent_task_id=other["id"])
    assert deep.status_code == 200 and deep.json()["depth"] == 2  # the subtree moves together (depth 2..4)
    milestone = task(wc, "TST", title="Веха", is_milestone=True)
    child = wc.post("/api/projects/TST/tasks", json={"title": "x", "parent_task_id": milestone["id"]})
    assert child.json()["details"]["reason"] == "milestone_parent"
    become = patch(wc, other["id"], expected_version=1, is_milestone=True)
    assert become.status_code == 409 and become.json()["details"]["reason"] == "milestone_has_children"
    project(wc, "OTH")
    foreign = task(wc, "OTH")
    across = wc.post("/api/projects/TST/tasks", json={"title": "x", "parent_task_id": foreign["id"]})
    assert across.json()["details"]["reason"] == "parent_not_in_project"


def test_archive_needs_cascade_for_children_and_restore_undoes_it(wc: TestClient) -> None:
    project(wc)
    parent = task(wc, "TST", title="Родитель")
    child = task(wc, "TST", title="Дочерняя", parent_task_id=parent["id"])
    refused = wc.delete(f"/api/tasks/{parent['id']}", params={"expected_version": 1})
    assert refused.status_code == 409 and refused.json()["details"] == {
        "reason": "has_children",
        "children": 1,
    }
    archived = wc.delete(f"/api/tasks/{parent['id']}", params={"expected_version": 1, "cascade": True}).json()
    assert {t["id"] for t in archived["archived"]} == {parent["id"], child["id"]}
    assert wc.get("/api/projects/TST/tasks").json()["total"] == 0
    assert wc.get("/api/projects/TST/tasks", params={"include_archived": True}).json()["total"] == 2
    assert (
        wc.get(f"/api/tasks/{child['id']}").json()["archived_at"] is not None
    )  # soft delete: still readable
    assert (
        patch(wc, child["id"], expected_version=2, title="x").json()["details"]["reason"] == "task_archived"
    )
    blocked = wc.post(f"/api/tasks/{child['id']}/restore", params={"expected_version": 2})
    assert blocked.json()["details"]["reason"] == "parent_archived"
    restored = wc.post(f"/api/tasks/{parent['id']}/restore", params={"expected_version": 2})
    assert restored.status_code == 200 and restored.json()["archived_at"] is None
    assert wc.get("/api/projects/TST/tasks").json()["total"] == 2  # the cascade was undone as one operation


def test_filters_sorting_pagination_and_case_insensitive_search(wc: TestClient) -> None:
    project(wc)
    for i, (title, prio, status) in enumerate(
        [
            ("Альфа", "low", "todo"),
            ("бета", "critical", "done"),
            ("Гамма", "high", "todo"),
            ("дельта", "medium", "review"),
        ]
    ):
        task(wc, "TST", title=title, priority=prio, status=status, assignee_id="demo-qa" if i % 2 else None)
    get = lambda **p: wc.get("/api/projects/TST/tasks", params=p).json()  # noqa: E731
    assert [t["title"] for t in get(sort="priority")["items"]] == ["бета", "Гамма", "дельта", "Альфа"]
    assert [t["title"] for t in get(sort="title", order="desc")["items"]] == [
        "дельта",
        "Гамма",
        "бета",
        "Альфа",
    ]
    assert get(q="БЕТА")["total"] == 1 and get(q="tst-3")["items"][0]["title"] == "Гамма"
    assert get(status="todo,review")["total"] == 3 and get(priority="critical")["total"] == 1
    assert get(assignee="none")["total"] == 2 and get(assignee="demo-qa")["total"] == 2
    page = get(limit=2, offset=2, sort="key")
    assert page["total"] == 4 and [t["key"] for t in page["items"]] == ["TST-3", "TST-4"]
    assert wc.get("/api/projects/TST/tasks", params={"status": "blocked"}).status_code == 400
    assert wc.get("/api/projects/TST/tasks", params={"limit": 501}).status_code == 422


def test_idempotent_create_returns_the_first_result(wc: TestClient) -> None:
    project(wc)
    body = {"title": "Один раз", "client_request_id": "req-create-0001"}
    first = wc.post("/api/projects/TST/tasks", json=body)
    replay = wc.post("/api/projects/TST/tasks", json=body)
    assert first.json()["id"] == replay.json()["id"]
    assert wc.get("/api/projects/TST/tasks").json()["total"] == 1
    reused = wc.post("/api/projects/TST/tasks", json={**body, "title": "Другое"})
    assert reused.status_code == 409 and reused.json()["details"]["reason"] == "idempotency_key_reused"


def test_activity_records_who_what_when_without_bodies(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "TST", description="Секретный текст описания")
    patch(wc, t["id"], expected_version=1, description="Новый секретный текст", status="done")
    events = wc.get(f"/api/tasks/{t['id']}/activity").json()["items"]
    assert [e["operation"] for e in events] == ["task_updated", "task_created"]
    update = events[0]
    assert (
        update["actor_id"] == "local-demo-user" and update["actor_display"] == "Демо-пользователь (localhost)"
    )
    assert update["changes"]["status"] == {"before": "todo", "after": "done"}
    assert update["changes"]["description"] == {"changed": True}
    assert "Секретный" not in str(events)
    feed = wc.get("/api/projects/TST/activity", params={"limit": 1}).json()
    assert len(feed["items"]) == 1 and feed["next_before_seq"] is not None


# --- seed, restart, AI off ---------------------------------------------------------------------------------
def test_demo_seed_has_the_required_shape(client: TestClient) -> None:
    projects = client.get("/api/projects").json()["items"]
    assert [p["key"] for p in projects] == ["ARIS", "DQI", "RAG"] and all(p["is_demo"] for p in projects)
    tasks = [t for p in projects for t in client.get(f"/api/projects/{p['id']}/tasks").json()["items"]]
    assert len(tasks) >= 30 and all(t["is_demo"] for t in tasks)
    assert max(t["depth"] for t in tasks) == 4
    assert {t["status"] for t in tasks} == {"todo", "in_progress", "review", "done"}
    assert sum(t["is_milestone"] for t in tasks) >= 3 and any(t["date_locked"] for t in tasks)
    assert any(not t["scheduled"] for t in tasks)
    assert any(t["overdue"] for t in tasks) and any(t["late"] for t in tasks)
    fixture_ids = {"demo-analyst", "demo-architect", "demo-engineer", "demo-qa", "demo-owner"}
    assert {t["assignee_id"] for t in tasks if t["assignee_id"]} <= fixture_ids


def test_m6_21_data_survives_a_restart(client_factory: Client) -> None:
    first = client_factory(work_seed_demo=False)
    project(first, "KEEP")
    t = task(first, "KEEP", title="Переживёт рестарт", start_date="2026-11-30", duration_workdays=2)
    first.__exit__(None, None, None)
    second = client_factory(work_seed_demo=False)  # same workspace, new process-like app
    again = second.get("/api/tasks/KEEP-1").json()
    assert again["id"] == t["id"] and again["end_exclusive"] == "2026-12-02"
    assert task(second, "KEEP")["key"] == "KEEP-2"  # the key counter persisted too


def test_m6_25_m6_40_work_module_needs_no_ai_and_no_integrations(client_factory: Client) -> None:
    c = client_factory(ai_provider="disabled", work_seed_demo=False)
    project(c, "NOAI")
    t = task(c, "NOAI", start_date="2026-11-30", duration_workdays=1)
    assert patch(c, t["id"], expected_version=1, status="done").status_code == 200
    items = {i["name"]: i for i in c.get("/api/integrations/status").json()["items"]}
    assert items["ai_provider"]["state"] == "disabled"  # unavailable stays visible, not faked
    assert items["task_system"]["state"] == "connected" and items["task_system"]["target"] == "local"


def test_task_system_disabled_answers_feature_unavailable(client_factory: Client) -> None:
    c = client_factory(task_system="disabled")
    response = c.get("/api/projects")
    assert response.status_code == 503 and response.json()["code"] == "feature_unavailable"
    items = {i["name"]: i for i in c.get("/api/integrations/status").json()["items"]}
    assert items["task_system"]["state"] == "disabled"


# --- identity gate -----------------------------------------------------------------------------------------
WRITE_CALLS: list[tuple[str, str, dict[str, Any] | None, dict[str, Any] | None]] = [
    ("POST", "/api/projects", {"key": "NEW", "title": "x"}, None),
    ("PATCH", "/api/projects/ARIS", {"expected_version": 1, "title": "x"}, None),
    ("POST", "/api/projects/ARIS/tasks", {"title": "x"}, None),
    ("PATCH", "/api/tasks/ARIS-1", {"expected_version": 1, "title": "x"}, None),
    ("DELETE", "/api/tasks/ARIS-5", None, {"expected_version": 1, "cascade": True}),
    ("POST", "/api/tasks/ARIS-1/restore", None, {"expected_version": 1}),
    ("GET", "/api/tasks/ARIS-1/activity", None, None),  # the private audit is not public either
    ("GET", "/api/projects/ARIS/activity", None, None),
]


@pytest.mark.parametrize("via", ["config", "gateway_header"])
def test_m6_20_m6_35_public_exposure_is_read_only(client_factory: Client, via: str) -> None:
    c = client_factory(work_public_exposure=True) if via == "config" else client_factory()
    headers = {"X-SKH-Exposure": "public"} if via == "gateway_header" else {}
    before = audit_count(c)
    for method, path, body, params in WRITE_CALLS:
        response = c.request(method, path, json=body, params=params, headers=headers)
        assert response.status_code == 403, (path, response.text)
        assert response.json()["details"]["mode"] == "read_only"
    assert audit_count(c) == before  # nothing written, no AI invoked
    assert c.get("/api/projects", headers=headers).status_code == 200  # the synthetic demo stays readable
    assert c.get("/api/projects/ARIS/tasks", headers=headers).status_code == 200
    caps = c.get("/api/work/capabilities", headers=headers).json()
    assert (caps["mode"], caps["can_write"], caps["team_ready"]) == ("read_only", False, False)
    assert caps["read_only_reason"]
    if via == "config":
        status = {i["name"]: i for i in c.get("/api/integrations/status").json()["items"]}["task_system"]
        assert status["access"] == "read"


def test_m6_35_no_client_can_claim_another_actor_or_role(wc: TestClient) -> None:
    spoof = {"X-User-ID": "admin", "X-SKH-Role": "admin", "X-Forwarded-User": "boss"}
    p = wc.post("/api/projects", json={"key": "SPF", "title": "x"}, headers=spoof).json()
    assert p["created_by"] == "local-demo-user" and p["my_role"] == "local_operator"
    t = wc.post("/api/projects/SPF/tasks", json={"title": "x"}, headers=spoof).json()
    assert t["created_by"] == t["reporter_id"] == "local-demo-user"
    for field in ("actor", "created_by", "updated_by", "reporter_id", "role", "is_demo", "plan_revision"):
        assert wc.post("/api/projects/SPF/tasks", json={"title": "x", field: "admin"}).status_code == 422, (
            field
        )
    members = wc.get("/api/projects/SPF/members").json()
    assert members["members"] == [] and members["mode"] == "local_operator"  # no fake team roles
    caps = wc.get("/api/work/capabilities").json()
    assert caps["label"] == "Локальная демонстрация — один оператор" and caps["team_ready"] is False
    assignees = wc.get("/api/work/assignees").json()
    assert {a["kind"] for a in assignees} == {"operator", "fixture"}


def test_writes_can_be_switched_off_explicitly(client_factory: Client) -> None:
    c = client_factory(work_writes_enabled=False)
    assert c.post("/api/projects", json={"key": "OFF", "title": "x"}).status_code == 403
    assert c.get("/api/work/capabilities").json()["mode"] == "read_only"


def _member(client: TestClient, project_id: str, user_id: str, role: str) -> None:
    with client.app.state.container.work.db.write() as conn:  # type: ignore[attr-defined]
        store.put_member(conn, project_id, user_id, role, "test-admin", datetime.now(UTC).isoformat())


def test_m6_19_m6_37_project_roles_with_server_side_identities(wc: TestClient) -> None:
    identity = enable_membership(wc)
    identity.current = team_user("alice")
    alpha = project(wc, "ALPHA")
    assert alpha["my_role"] == "admin"
    t = task(wc, "ALPHA", title="Секретная задача альфы", assignee_id=None)
    beta = project(wc, "BETA")
    _member(wc, alpha["id"], "bob", "viewer")
    _member(wc, alpha["id"], "carol", "member")
    # assignees in team mode are project members only (no fixtures, no free-form ids)
    assert (
        wc.post("/api/projects/ALPHA/tasks", json={"title": "x", "assignee_id": "demo-qa"}).status_code == 422
    )
    assert task(wc, "ALPHA", assignee_id="carol")["assignee"]["kind"] == "member"

    identity.current = team_user("bob")  # viewer
    assert wc.get("/api/projects/ALPHA/tasks").status_code == 200
    denied = patch(wc, t["id"], expected_version=1, title="Изменено зрителем")
    assert denied.status_code == 403 and denied.json()["code"] == "forbidden"  # M6-19
    assert wc.post("/api/projects/ALPHA/tasks", json={"title": "x"}).status_code == 403
    assert wc.get(f"/api/tasks/{t['id']}/activity").status_code == 403
    assert wc.get("/api/projects/BETA").status_code == 404  # not a member: invisible, not «forbidden»
    assert [p["key"] for p in wc.get("/api/projects").json()["items"]] == ["ALPHA"]  # no counts of BETA

    identity.current = team_user("carol")  # member
    assert patch(wc, t["id"], expected_version=1, status="in_progress").status_code == 200
    assert wc.patch("/api/projects/ALPHA", json={"expected_version": 1, "title": "x"}).status_code == 403
    assert wc.get(f"/api/tasks/{t['id']}/activity").status_code == 200

    identity.current = team_user("mallory")  # nobody
    assert wc.get("/api/projects").json()["total"] == 0
    for path in (
        "/api/projects/ALPHA",
        "/api/projects/ALPHA/tasks",
        f"/api/tasks/{t['id']}",
        "/api/tasks/ALPHA-1",
    ):
        response = wc.get(path)
        assert response.status_code == 404 and "Секретная" not in response.text, path

    identity.current = team_user("alice")  # admin
    assert wc.patch("/api/projects/ALPHA", json={"expected_version": 1, "title": "Альфа"}).status_code == 200
    members = wc.get("/api/projects/ALPHA/members").json()
    assert {(m["user_id"], m["role"]) for m in members["members"]} == {
        ("alice", "admin"),
        ("bob", "viewer"),
        ("carol", "member"),
    }
    assert beta["my_role"] == "admin"


def test_membership_mode_refuses_the_demo_operator(wc: TestClient) -> None:
    identity = enable_membership(wc)
    identity.current = wc.app.state.container.demo_user()  # type: ignore[attr-defined]
    wc.app.state.container.policy = type(  # type: ignore[attr-defined]
        "AllowAll", (), {"name": "allow", "allows": lambda self, u, a: True}
    )()
    assert wc.post("/api/projects", json={"key": "DEMO", "title": "x"}).status_code == 403
