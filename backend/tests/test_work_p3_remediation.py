"""Post-M6 remediation, confirmed functional P3 findings of the work module.

- CODE-012: a parent may be named by its key (PKY-1) as everywhere else in the API, not only by its internal id.
- SYS-003: applying a schedule preview that changes nothing does not advance the plan revision (which would silently
  make other people's previews and AI proposals stale without a trace in the history)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.work import store

Client = Callable[..., TestClient]


@pytest.fixture
def wc(client_factory: Client) -> TestClient:
    client = client_factory(work_seed_demo=False)
    assert client.post("/api/projects", json={"key": "PKY", "title": "Ключи"}).status_code == 201
    return client


def task(client: TestClient, **fields: Any) -> dict[str, Any]:
    response = client.post("/api/projects/PKY/tasks", json={"title": "Задача", **fields})
    assert response.status_code == 201, response.text
    return dict(response.json())


def audit(client: TestClient) -> int:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return store.count_audit(conn)


def revision(client: TestClient) -> int:
    return int(client.get("/api/projects/PKY").json()["plan_revision"])


# --- CODE-012 ----------------------------------------------------------------------------------------------------
def test_a_parent_can_be_named_by_its_key_when_moving_a_task(wc: TestClient) -> None:
    parent = task(wc, title="Родитель")
    child = task(wc, title="Ребёнок")

    moved = wc.patch(
        f"/api/tasks/{child['key']}", json={"expected_version": 1, "parent_task_id": parent["key"]}
    )

    assert moved.status_code == 200, moved.text
    assert moved.json()["parent_task_id"] == parent["id"]  # stored as the stable id, never the key
    assert moved.json()["depth"] == 2


def test_a_parent_can_be_named_by_its_key_when_creating_a_task(wc: TestClient) -> None:
    parent = task(wc, title="Родитель")
    child = task(wc, title="Ребёнок", parent_task_id=parent["key"])
    assert child["parent_task_id"] == parent["id"]


def test_naming_the_current_parent_by_key_is_not_a_change(wc: TestClient) -> None:
    parent = task(wc, title="Родитель")
    child = task(wc, title="Ребёнок", parent_task_id=parent["id"])
    before = audit(wc)

    same = wc.patch(
        f"/api/tasks/{child['key']}", json={"expected_version": 1, "parent_task_id": parent["key"]}
    )

    assert same.status_code == 200 and same.json()["version"] == 1
    assert audit(wc) == before


@pytest.mark.parametrize("ref", ["PKY-99", "ZZZ-1", "missing-id"])
def test_an_unknown_parent_key_is_still_refused(wc: TestClient, ref: str) -> None:
    child = task(wc, title="Ребёнок")
    response = wc.patch(f"/api/tasks/{child['key']}", json={"expected_version": 1, "parent_task_id": ref})
    assert response.status_code == 422, response.text
    assert response.json()["details"]["reason"] == "parent_not_in_project"


# --- SYS-003 -----------------------------------------------------------------------------------------------------
def test_applying_a_preview_without_operations_keeps_the_plan_revision(wc: TestClient) -> None:
    task(wc, title="A", start_date="2026-11-30", duration_workdays=2)
    preview = wc.post("/api/projects/PKY/schedule/preview", json={"mode": "resolve_violations"}).json()
    assert preview["operations"] == [] and preview["can_apply"] is True
    rev, events = revision(wc), audit(wc)
    body = {
        "preview_id": preview["preview_id"],
        "expected_plan_revision": rev,
        "client_request_id": "empty-apply-01",
    }

    applied = wc.post("/api/projects/PKY/schedule/apply", json=body)
    replay = wc.post("/api/projects/PKY/schedule/apply", json=body)

    assert applied.status_code == 200, applied.text
    assert applied.json()["applied"] is True and applied.json()["changed_tasks"] == []
    assert applied.json()["plan_revision"] == rev
    assert revision(wc) == rev and audit(wc) == events
    assert replay.status_code == 200 and replay.json()["replayed"] is True


# --- CODE-014 ----------------------------------------------------------------------------------------------------
def table_sizes(client: TestClient) -> dict[str, int]:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return {
            table: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])  # noqa: S608 - fixed names
            for table in ("work_idempotency", "work_schedule_previews", "work_audit_events", "work_tasks")
        }


def test_replay_records_and_applied_previews_are_kept_for_a_retention_window_only(
    wc: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audit CODE-014: work_idempotency and applied previews used to grow forever. They are technical records (the
    history lives in the audit, which is never deleted): replays work inside the window, the rows go after it."""
    service = wc.app.state.container.work  # type: ignore[attr-defined]
    start = service.now()
    a = task(wc, title="A", start_date="2026-11-30", duration_workdays=1, client_request_id="ret-create-0001")
    preview = wc.post(
        "/api/projects/PKY/schedule/preview",
        json={"changes": [{"task_id": a["id"], "start_date": "2026-12-01", "duration_workdays": 1}]},
    ).json()
    applied = wc.post(
        "/api/projects/PKY/schedule/apply",
        json={
            "preview_id": preview["preview_id"],
            "expected_plan_revision": revision(wc),
            "client_request_id": "ret-apply-0001",
        },
    )
    assert applied.status_code == 200, applied.text
    kept = table_sizes(wc)
    assert kept["work_idempotency"] == 2 and kept["work_schedule_previews"] == 1

    monkeypatch.setattr(service, "now", lambda: start + timedelta(days=6))
    assert (
        task(
            wc, title="A", start_date="2026-11-30", duration_workdays=1, client_request_id="ret-create-0001"
        )["id"]
        == a["id"]
    )

    monkeypatch.setattr(service, "now", lambda: start + timedelta(days=8))
    task(wc, title="B", client_request_id="ret-create-0002")  # any later idempotent write purges the old rows

    after = table_sizes(wc)
    assert after["work_idempotency"] == 1  # only the new one
    assert after["work_schedule_previews"] == 0
    assert after["work_audit_events"] > kept["work_audit_events"]  # history is never purged
    assert after["work_tasks"] == 2
