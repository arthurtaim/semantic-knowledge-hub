"""Post-M6 remediation A1 (audit CODE-002, CODE-003): restoring an archived task re-checks every hierarchy invariant
that creating or moving a task checks — the parent is an active non-milestone task of the same project and the whole
restored subtree fits under MAX_DEPTH. A refused restore writes nothing (tasks, plan revision, audit)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.work import store

Client = Callable[..., TestClient]


@pytest.fixture
def wc(client_factory: Client) -> TestClient:
    return client_factory(work_seed_demo=False)


def project(client: TestClient, key: str) -> dict[str, Any]:
    response = client.post("/api/projects", json={"key": key, "title": f"Проект {key}"})
    assert response.status_code == 201, response.text
    return dict(response.json())


def task(client: TestClient, ref: str, **fields: Any) -> dict[str, Any]:
    response = client.post(f"/api/projects/{ref}/tasks", json={"title": "Задача", **fields})
    assert response.status_code == 201, response.text
    return dict(response.json())


def get(client: TestClient, ref: str) -> dict[str, Any]:
    return dict(client.get(f"/api/tasks/{ref}").json())


def archive(client: TestClient, t: dict[str, Any], cascade: bool = False) -> dict[str, dict[str, Any]]:
    response = client.delete(
        f"/api/tasks/{t['key']}",
        params={"expected_version": get(client, t["key"])["version"], "cascade": cascade},
    )
    assert response.status_code == 200, response.text
    return {row["id"]: row for row in response.json()["archived"]}


def restore(client: TestClient, t: dict[str, Any]) -> Any:
    return client.post(
        f"/api/tasks/{t['key']}/restore", params={"expected_version": get(client, t["key"])["version"]}
    )


def snapshot(client: TestClient, project_key: str) -> tuple[int, int, list[tuple[str, Any, int]]]:
    """Plan revision, audit size and every task's (id, archived_at, version): what a refused restore must not touch."""
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        audit = store.count_audit(conn)
        rows = conn.execute(
            "SELECT t.id, t.archived_at, t.version FROM work_tasks t JOIN work_projects p ON p.id = t.project_id "
            "WHERE p.key = ? ORDER BY t.number",
            (project_key,),
        ).fetchall()
    revision = int(client.get(f"/api/projects/{project_key}").json()["plan_revision"])
    return revision, audit, [(r["id"], r["archived_at"], int(r["version"])) for r in rows]


def test_restore_under_a_parent_that_became_a_milestone_is_refused_without_writes(wc: TestClient) -> None:
    """CODE-002: archive a subtask → make its parent a milestone → restoring the subtask would give a milestone a child."""
    project(wc, "RST")
    parent = task(wc, "RST", title="Родитель", start_date="2026-11-30", duration_workdays=2)
    child = task(wc, "RST", title="Подзадача", parent_task_id=parent["id"])
    archive(wc, child)
    to_milestone = wc.patch(
        f"/api/tasks/{parent['key']}",
        json={"expected_version": get(wc, parent["key"])["version"], "is_milestone": True},
    )
    assert to_milestone.status_code == 200, to_milestone.text
    before = snapshot(wc, "RST")

    refused = restore(wc, child)

    assert refused.status_code == 409, refused.text
    assert refused.json()["code"] == "conflict"
    assert refused.json()["details"]["reason"] == "milestone_parent"
    assert snapshot(wc, "RST") == before
    assert get(wc, parent["key"])["child_count"] == 0

    # Once the parent is a plain task again the same restore succeeds.
    back = wc.patch(
        f"/api/tasks/{parent['key']}",
        json={
            "expected_version": get(wc, parent["key"])["version"],
            "is_milestone": False,
            "duration_workdays": 2,
        },
    )
    assert back.status_code == 200, back.text
    retried = restore(wc, child)
    assert retried.status_code == 200, retried.text
    assert get(wc, parent["key"])["child_count"] == 1


def test_restore_of_a_subtree_under_a_parent_moved_deeper_is_refused_without_writes(wc: TestClient) -> None:
    """CODE-003: A>B>C (depth 3); P>Q>R; archive Q with R; move P under C (P now at depth 4); restoring Q+R → depth 6."""
    project(wc, "RSD")
    a = task(wc, "RSD", title="A")
    b = task(wc, "RSD", title="B", parent_task_id=a["id"])
    c = task(wc, "RSD", title="C", parent_task_id=b["id"])
    p = task(wc, "RSD", title="P")
    q = task(wc, "RSD", title="Q", parent_task_id=p["id"])
    r = task(wc, "RSD", title="R", parent_task_id=q["id"])
    archived = archive(wc, q, cascade=True)
    assert set(archived) == {q["id"], r["id"]}
    moved = wc.patch(
        f"/api/tasks/{p['key']}",
        json={"expected_version": get(wc, p["key"])["version"], "parent_task_id": c["id"]},
    )
    assert moved.status_code == 200, moved.text
    assert get(wc, p["key"])["depth"] == 4
    before = snapshot(wc, "RSD")

    refused = restore(wc, q)

    assert refused.status_code == 409, refused.text
    assert refused.json()["details"]["reason"] == "too_deep"
    assert snapshot(wc, "RSD") == before  # neither Q nor R came back, no revision bump, no audit
    assert get(wc, r["key"])["archived_at"] is not None


@pytest.mark.parametrize("parent_depth,restorable", [(2, True), (3, False)])
def test_restore_depth_limit_counts_the_whole_restored_subtree(
    wc: TestClient, parent_depth: int, restorable: bool
) -> None:
    """A two-level subtree (Q>R) fits under a parent at depth 2 (→ 4 levels) but not at depth 3 (→ 5 levels)."""
    project(wc, "RSB")
    chain = [task(wc, "RSB", title="L1")]
    for level in range(2, parent_depth + 1):
        chain.append(task(wc, "RSB", title=f"L{level}", parent_task_id=chain[-1]["id"]))
    holder = task(wc, "RSB", title="Держатель")
    q = task(wc, "RSB", title="Q", parent_task_id=holder["id"])
    r = task(wc, "RSB", title="R", parent_task_id=q["id"])
    archive(wc, q, cascade=True)
    # move the holder so that Q's parent ends at parent_depth
    target = chain[parent_depth - 2]
    moved = wc.patch(
        f"/api/tasks/{holder['key']}",
        json={"expected_version": get(wc, holder["key"])["version"], "parent_task_id": target["id"]},
    )
    assert moved.status_code == 200, moved.text
    assert get(wc, holder["key"])["depth"] == parent_depth

    response = restore(wc, q)

    if restorable:
        assert response.status_code == 200, response.text
        assert get(wc, r["key"])["depth"] == 4
    else:
        assert response.status_code == 409, response.text
        assert response.json()["details"]["reason"] == "too_deep"


def test_cascade_restore_still_undoes_the_whole_archived_subtree(wc: TestClient) -> None:
    """The valid case keeps working: one restore brings back the subtree archived by the same operation."""
    project(wc, "RSC")
    root = task(wc, "RSC", title="Корень")
    mid = task(wc, "RSC", title="Середина", parent_task_id=root["id"])
    leaf = task(wc, "RSC", title="Лист", parent_task_id=mid["id"])
    archive(wc, root, cascade=True)

    response = restore(wc, root)

    assert response.status_code == 200, response.text
    assert [get(wc, t["key"])["archived_at"] for t in (root, mid, leaf)] == [None, None, None]
    assert get(wc, leaf["key"])["depth"] == 3


def test_a_subtask_archived_earlier_is_not_restored_with_its_ancestor(wc: TestClient) -> None:
    """Only the subtree archived by the same operation returns; a subtask archived on its own stays in the archive."""
    project(wc, "RSE")
    root = task(wc, "RSE", title="Корень")
    child = task(wc, "RSE", title="Ребёнок", parent_task_id=root["id"])
    archive(wc, child)
    archive(wc, root)

    response = restore(wc, root)

    assert response.status_code == 200, response.text
    assert get(wc, child["key"])["archived_at"] is not None
