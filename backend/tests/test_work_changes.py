"""M7 change-set proposals for EXISTING tasks (WCP, app/work/changes.py) through the real HTTP API and the chat skill
`propose_task_changes`, with the SCRIPTED MODEL double and the synthetic demo projects. Every scenario reads the work
state back: task values and versions, the plan revision, the audit and the proposal row.

Acceptance ids (SKH_CHAT_WORK_SKILLS_M7/ACCEPTANCE_MATRIX.csv): WCP-01 … WCP-22."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider
from app.domain.models import UserContext
from app.work import migrations, store
from app.work.db import WorkDatabase, schema_version, verify_database
from app.work.models import ProjectCreate, TaskCreate
from app.work.permissions import WorkAccessGate, WorkAccessMode, WorkPrincipal
from app.work.service import WorkService
from tests.support.scripted_model import Recorder, openai_transport
from tests.support.work_identity import enable_membership, team_user

Factory = Callable[..., tuple[TestClient, Recorder]]
REQUEST = "ARIS-6 на ревью, ARIS-8 высокий приоритет, ARIS-14 срок 2027-01-20"


@pytest.fixture
def wc(client_factory: Callable[..., TestClient]) -> Factory:
    def factory(**overrides: Any) -> tuple[TestClient, Recorder]:
        client = client_factory(**overrides)
        container = client.app.state.container  # type: ignore[attr-defined]
        recorder = Recorder()
        provider = OpenAICompatibleAIProvider(
            base_url="https://ai.example.test/v1",
            model="scripted",
            api_key=SecretStr(""),
            timeout_seconds=10,
            allowed_hosts=["ai.example.test"],
            transport=openai_transport(recorder),
            instructions=container.instructions,
        )
        container.assistant._provider = provider
        container.work_ai._ai = provider
        container.work_changes._ai = provider
        return client, recorder

    return factory


def propose(client: TestClient, request: str = REQUEST, **extra: Any) -> Any:
    return client.post(
        "/api/work-ai/change-proposals", json={"project_id": "ARIS", "request": request, **extra}
    )


def apply(
    client: TestClient, wcp: dict[str, Any], ops: list[str] | None = None, key: str = "wcp-apply-0001"
) -> Any:
    body = {
        "operation_ids": ops if ops is not None else [c["operation_id"] for c in wcp["changes"]],
        "expected_plan_revision": wcp["base_plan_revision"],
        "client_request_id": key,
    }
    return client.post(f"/api/work-ai/change-proposals/{wcp['id']}/apply", json=body)


def task(client: TestClient, key: str) -> dict[str, Any]:
    data: dict[str, Any] = client.get(f"/api/tasks/{key}").json()
    return data


def state(client: TestClient) -> dict[str, Any]:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return {
            "tasks": [
                tuple(r)
                for r in conn.execute(
                    "SELECT id, title, description, status, priority, due_date, start_date, end_exclusive, version "
                    "FROM work_tasks ORDER BY id"
                ).fetchall()
            ],
            "audit": store.count_audit(conn),
            "plan": conn.execute("SELECT plan_revision FROM work_projects WHERE key = 'ARIS'").fetchone()[0],
            "wcp": [
                tuple(r)
                for r in conn.execute(
                    "SELECT id, status, result_json FROM work_task_change_proposals ORDER BY id"
                ).fetchall()
            ],
        }


def op(wcp: dict[str, Any], key: str, field: str) -> dict[str, Any]:
    return next(c for c in wcp["changes"] if c["task_key"] == key and c["field"] == field)


# --- WCP-01 / 02 / 03 / 04: a proposal, a preview and a selective, atomic apply -------------------------------
def test_wcp01_to_04_proposal_preview_and_selective_atomic_apply(wc: Factory) -> None:
    client, _ = wc()
    before = state(client)
    created = propose(client)
    assert created.status_code == 201, created.text
    wcp = created.json()
    assert wcp["kind"] == "task_changes" and wcp["state"] == "ready" and wcp["can_apply"] is True
    # WCP-02: «before» is the server's value, never the model's
    assert (op(wcp, "ARIS-6", "status")["before"], op(wcp, "ARIS-6", "status")["after"]) == (
        "in_progress",
        "review",
    )
    assert (op(wcp, "ARIS-8", "priority")["before"], op(wcp, "ARIS-8", "priority")["after"]) == (
        "medium",
        "high",
    )
    assert op(wcp, "ARIS-14", "due_date")["after"] == "2027-01-20"
    assert op(wcp, "ARIS-14", "due_date")["before"] == task(client, "ARIS-14")["due_date"]
    # WCP-01: nothing in tasks changed; one audit event for the proposal
    after = state(client)
    assert after["tasks"] == before["tasks"] and after["plan"] == before["plan"]
    assert after["audit"] == before["audit"] + 1 and len(after["wcp"]) == 1
    # WCP-03: a preview writes nothing
    keep = [op(wcp, "ARIS-6", "status")["operation_id"], op(wcp, "ARIS-8", "priority")["operation_id"]]
    preview = client.post(
        f"/api/work-ai/change-proposals/{wcp['id']}/preview", json={"operation_ids": keep}
    ).json()
    assert [c["included"] for c in preview["changes"]] == [
        c["operation_id"] in keep for c in preview["changes"]
    ]
    assert state(client) == after
    # WCP-04: only the chosen operations, one transaction
    v6, v8, v14 = (task(client, k)["version"] for k in ("ARIS-6", "ARIS-8", "ARIS-14"))
    result = apply(client, wcp, keep)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["applied_operations"] == 2 and {t["key"] for t in body["updated_tasks"]} == {
        "ARIS-6",
        "ARIS-8",
    }
    assert body["plan_revision"] == before["plan"] + 1
    assert (task(client, "ARIS-6")["status"], task(client, "ARIS-6")["version"]) == ("review", v6 + 1)
    assert (task(client, "ARIS-8")["priority"], task(client, "ARIS-8")["version"]) == ("high", v8 + 1)
    assert task(client, "ARIS-14")["version"] == v14 and task(client, "ARIS-14")["due_date"] != "2027-01-20"
    final = state(client)
    assert final["audit"] == after["audit"] + 3  # two task_updated + change_proposal_applied
    activity = client.get("/api/tasks/ARIS-6/activity").json()["items"][0]
    assert activity["operation"] == "task_updated" and activity["changes"]["status"] == {
        "before": "in_progress",
        "after": "review",
    }
    shown = client.get(f"/api/work-ai/change-proposals/{wcp['id']}").json()
    assert shown["state"] == "applied" and sorted(shown["applied_task_keys"]) == ["ARIS-6", "ARIS-8"]
    # replay with the same key: the first result, nothing written
    replay = apply(client, wcp, keep).json()
    assert replay["replayed"] is True and state(client) == final


def test_wcp05_two_fields_of_one_task_bump_its_version_once(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client, "ARIS-8 высокий приоритет и назови «Справочники: правила»").json()
    assert {c["field"] for c in wcp["changes"]} == {"priority", "title"}
    version = task(client, "ARIS-8")["version"]
    assert apply(client, wcp).status_code == 200
    updated = task(client, "ARIS-8")
    assert (updated["priority"], updated["title"], updated["version"]) == (
        "high",
        "Справочники: правила",
        version + 1,
    )


def test_wcp06_clearing_a_due_date_keeps_the_gantt_plan(wc: Factory) -> None:
    client, _ = wc()
    before = task(client, "ARIS-14")
    assert before["due_date"] is not None
    wcp = propose(client, "ARIS-14 без срока").json()
    assert op(wcp, "ARIS-14", "due_date")["after"] is None
    assert apply(client, wcp).status_code == 200
    after = task(client, "ARIS-14")
    assert after["due_date"] is None
    assert (after["start_date"], after["end_exclusive"], after["date_locked"]) == (
        before["start_date"],
        before["end_exclusive"],
        before["date_locked"],
    )


def test_wcp07_unsupported_fields_are_dropped_with_a_work_ui_hint(wc: Factory) -> None:
    client, _ = wc()
    before = state(client)
    only = propose(client, "ARIS-6 исполнитель другой, ARIS-7 по Ганту на неделю позже")
    assert only.status_code == 422 and only.json()["details"]["reason"] == "nothing_to_propose"
    assert state(client) == before  # nothing stored
    mixed = propose(client, "ARIS-6 на ревью, ARIS-7 исполнителя сменить").json()
    assert [c["field"] for c in mixed["changes"]] == ["status"]
    hint = next(i for i in mixed["issues"] if i["code"] == "unsupported_field")
    assert "карточке задачи" in hint["message"]


def test_wcp08_unknown_task_and_wrong_project(wc: Factory) -> None:
    client, recorder = wc()
    dropped = propose(client, "ARIS-6 на ревью и чужая задача").json()
    assert [c["task_key"] for c in dropped["changes"]] == ["ARIS-6"]
    assert any(i["code"] == "unknown_task" for i in dropped["issues"])
    assert "ZZZ-999" not in str(dropped)  # the model's invented key is not echoed
    calls = len(recorder.calls)
    foreign = propose(client, "на ревью", task_keys=["DQI-1"])
    unknown = propose(client, "на ревью", task_keys=["ARIS-999"])
    assert foreign.status_code == unknown.status_code == 404
    assert "Классифицировать" not in foreign.text and len(recorder.calls) == calls


def test_wcp09_archived_task_is_refused_before_the_model(wc: Factory) -> None:
    client, recorder = wc()
    version = task(client, "ARIS-13")["version"]
    assert client.delete(f"/api/tasks/ARIS-13?expected_version={version}").status_code == 200
    calls = len(recorder.calls)
    refused = propose(client, "ARIS-13 на ревью")
    assert refused.status_code == 409 and refused.json()["details"]["reason"] == "task_archived"
    assert len(recorder.calls) == calls


def test_wcp10_wcp11_invalid_values_and_wrong_types(wc: Factory) -> None:
    client, _ = wc()
    before = state(client)
    out_of_range = propose(client, "ARIS-6 срок 3000-01-01")
    assert out_of_range.status_code == 422  # the only change had an impossible date: nothing stored
    mixed = propose(client, "ARIS-6 на ревью, невалид").json()
    assert [c["field"] for c in mixed["changes"]] == ["status"]
    assert any(i["code"] == "invalid_value" for i in mixed["issues"])
    types = propose(client, "неверные типы")
    assert types.status_code == 502 and types.json()["code"] == "ai_invalid_response"
    broken = propose(client, "сломанный формат")
    assert broken.status_code == 502
    after = state(client)
    assert after["tasks"] == before["tasks"] and len(after["wcp"]) == 1


def test_wcp12_a_changed_task_makes_the_whole_set_stale(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client).json()
    other = task(client, "ARIS-8")
    client.patch(
        "/api/tasks/ARIS-8", json={"title": "Изменено вручную", "expected_version": other["version"]}
    )
    shown = client.get(f"/api/work-ai/change-proposals/{wcp['id']}").json()
    assert shown["state"] == "stale" and "task_changed" in shown["stale_reasons"]
    assert op(shown, "ARIS-8", "priority")["state"] == "task_changed" and shown["can_apply"] is False
    before = state(client)
    refused = apply(client, wcp, [op(wcp, "ARIS-6", "status")["operation_id"]])
    assert refused.status_code == 409 and refused.json()["code"] == "proposal_stale"
    assert state(client) == before  # no task, audit, revision or status change


def test_wcp13_a_plan_change_elsewhere_in_the_project_is_409(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client, "ARIS-6 на ревью").json()
    unrelated = task(client, "ARIS-12")
    client.patch("/api/tasks/ARIS-12", json={"priority": "low", "expected_version": unrelated["version"]})
    before = state(client)
    refused = apply(client, wcp)
    assert refused.status_code == 409 and refused.json()["details"]["reason"] == "plan_changed"
    assert state(client) == before


def test_wcp14_a_changed_source_document_is_409(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client, "ARIS-6 на ревью", document_ids=["SEM-ARCH-001"]).json()
    root = Path(client.app.state.container.settings.local_knowledge_dir)  # type: ignore[attr-defined]
    path = next(p for p in root.rglob("*.md") if "\nid: SEM-ARCH-001\n" in p.read_text(encoding="utf-8"))
    path.write_text(path.read_text(encoding="utf-8") + "\nИзменение (демо).\n", encoding="utf-8")
    shown = client.get(f"/api/work-ai/change-proposals/{wcp['id']}").json()
    assert shown["state"] == "stale" and "source_changed" in shown["stale_reasons"]
    before = state(client)
    assert apply(client, wcp).status_code == 409 and state(client) == before


def test_wcp15_losing_the_right_after_the_proposal(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client, "ARIS-6 на ревью").json()
    before = state(client)
    body = {
        "operation_ids": [c["operation_id"] for c in wcp["changes"]],
        "expected_plan_revision": wcp["base_plan_revision"],
        "client_request_id": "wcp-apply-public",
    }
    exposed = client.post(
        f"/api/work-ai/change-proposals/{wcp['id']}/apply", json=body, headers={"X-SKH-Exposure": "public"}
    )
    assert exposed.status_code == 403 and state(client) == before
    identity = enable_membership(client)
    identity.current = team_user("stranger")
    assert (
        client.get(f"/api/work-ai/change-proposals/{wcp['id']}").status_code == 404
    )  # another actor's: invisible
    assert apply(client, wcp).status_code == 404 and state(client) == before


def test_wcp16_a_fault_after_the_first_write_rolls_everything_back(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client).json()
    container = client.app.state.container  # type: ignore[attr-defined]
    written: list[str] = []

    def explode(task_id: str) -> None:
        written.append(task_id)
        raise RuntimeError("injected fault after the first task write")

    container.work._after_change_write = explode
    before = state(client)
    with pytest.raises(RuntimeError):
        apply(client, wcp)
    container.work._after_change_write = None
    assert len(written) == 1 and state(client) == before  # tasks, audit, revision, proposal status
    assert apply(client, wcp, key="wcp-apply-retry").status_code == 200  # the same set applies later


def test_wcp17_concurrent_applies_commit_once(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client).json()
    results: list[int] = []
    barrier = threading.Barrier(2)

    def run(key: str) -> None:
        barrier.wait()
        results.append(apply(client, wcp, key=key).status_code)

    threads = [threading.Thread(target=run, args=(f"wcp-concurrent-{i}",)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == [200, 409]
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        applied = conn.execute(
            "SELECT COUNT(*) FROM work_audit_events WHERE operation = 'change_proposal_applied'"
        ).fetchone()[0]
    assert applied == 1 and task(client, "ARIS-6")["status"] == "review"


def test_wcp18_wcp19_wcp20_idempotency_empty_selection_and_reject(wc: Factory) -> None:
    client, _ = wc()
    wcp = propose(client).json()
    before = state(client)
    empty = apply(client, wcp, [])
    assert empty.status_code == 422 and empty.json()["details"]["reason"] == "nothing_to_apply"
    assert state(client) == before  # WCP-19: no revision bump
    unknown = apply(client, wcp, ["op99"])
    assert unknown.status_code == 422 and state(client) == before
    assert (
        apply(client, wcp, [op(wcp, "ARIS-6", "status")["operation_id"]], key="wcp-key-reused").status_code
        == 200
    )
    other = apply(client, wcp, [op(wcp, "ARIS-8", "priority")["operation_id"]], key="wcp-key-reused")
    assert (
        other.status_code == 409 and other.json()["details"]["reason"] == "idempotency_key_reused"
    )  # WCP-18
    second = propose(client, "ARIS-9 высокий приоритет").json()
    rejected = client.post(f"/api/work-ai/change-proposals/{second['id']}/reject").json()
    assert rejected["state"] == "rejected"
    snapshot = state(client)
    assert apply(client, second, key="after-reject-001").status_code == 409  # WCP-20
    again = client.post(f"/api/work-ai/change-proposals/{second['id']}/reject")
    assert again.status_code == 409 and again.json()["details"]["reason"] == "already_rejected"
    assert state(client) == snapshot


def test_wcp21_a_restart_keeps_the_proposal_reviewable(
    wc: Factory, client_factory: Callable[..., TestClient]
) -> None:
    client, _ = wc()
    wcp = propose(client).json()
    shown = client.get(f"/api/work-ai/change-proposals/{wcp['id']}").json()
    restarted = client_factory()  # a new app on the same work database file
    again = restarted.get(f"/api/work-ai/change-proposals/{wcp['id']}").json()
    assert again == shown


def test_change_set_refinement_is_a_new_proposal(wc: Factory) -> None:
    client, recorder = wc()
    first = propose(client, "ARIS-6 на ревью").json()
    revised = client.post(
        f"/api/work-ai/change-proposals/{first['id']}/revise",
        json={"instruction": "ARIS-6 лучше в работу, ARIS-8 high"},
    )
    assert revised.status_code == 201, revised.text
    new = revised.json()
    assert new["id"] != first["id"] and new["revised_from"] == first["id"]
    assert client.get(f"/api/work-ai/change-proposals/{first['id']}").json()["changes"] == first["changes"]
    sent = next(p for s, p in recorder.calls[::-1] if "Режим изменения задач SKH." in s)
    assert "<<<PREVIOUS CHANGES>>>" in sent


# --- the chat skill ---------------------------------------------------------------------------------------------
def test_chat_skill_proposes_a_change_set_and_never_applies_it(wc: Factory) -> None:
    client, _ = wc()
    before = state(client)
    response = client.post(
        "/api/assistant/ask",
        json={
            "question": REQUEST,
            "skill_id": "propose_task_changes",
            "work_context": {"project_key": "ARIS"},
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    ref = data["work_proposal"]
    assert ref["kind"] == "task_changes" and ref["id"].startswith("WCP-") and ref["change_count"] == 3
    assert ref["app_path"] == f"/projects/ARIS?changes={ref['id']}" and data["proposal"] is None
    assert "ARIS-6 · Статус: «in_progress» → «review»" in data["answer"]
    assert "Задачи НЕ изменены" in data["answer"]
    after = state(client)
    assert after["tasks"] == before["tasks"] and after["plan"] == before["plan"]
    # «да, применяй» in the chat is a question, not an Apply
    client.post("/api/assistant/ask", json={"question": "Да, применяй все изменения"})
    assert state(client)["tasks"] == before["tasks"]
    assert client.get(f"/api/work-ai/change-proposals/{ref['id']}").json()["status"] == "suggested"


def test_chat_skill_with_named_tasks_only_offers_those_tasks(wc: Factory) -> None:
    client, recorder = wc()
    client.post(
        "/api/assistant/ask",
        json={
            "question": "все на ревью",
            "skill_id": "propose_task_changes",
            "work_context": {"project_key": "ARIS", "task_keys": ["ARIS-11", "ARIS-12"]},
        },
    )
    sent = next(p for s, p in recorder.calls[::-1] if "Режим изменения задач SKH." in s)
    tasks_block = sent.split("<<<TASKS>>>")[1].split("<<<END TASKS>>>")[0]
    assert "ARIS-11" in tasks_block and "ARIS-12" in tasks_block and "ARIS-6" not in tasks_block


# --- WCP-22: migration v3 → v4 on a populated database ----------------------------------------------------------
OPERATOR = UserContext(user_id="local-demo-user", display_name="Оператор", roles=[], is_demo=True)
P = WorkPrincipal(user=OPERATOR, request_id="test")


def _dump(path: Path) -> dict[str, list[tuple[Any, ...]]]:
    import sqlite3

    conn = sqlite3.connect(path)
    try:
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'work_%'"
            )
            if r[0] not in ("work_schema_migrations", "work_task_change_proposals")
        ]
        out: dict[str, list[tuple[Any, ...]]] = {}
        for table in sorted(tables):
            columns = [c[1] for c in conn.execute(f"PRAGMA table_info({table})") if c[1] != "revised_from"]
            out[table] = sorted(
                conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall(),  # noqa: S608 — names from sqlite_master
                key=repr,
            )
        return out
    finally:
        conn.close()


def test_wcp22_v3_database_upgrades_to_v4_twice_without_loss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "work.sqlite3"
    monkeypatch.setattr("app.work.db.MIGRATIONS", migrations.MIGRATIONS[:3])
    monkeypatch.setattr("app.work.db.LATEST_VERSION", 3)
    old = WorkService(WorkDatabase(path), WorkAccessGate(WorkAccessMode.local_operator), operator=OPERATOR)
    for key in ("ONE", "TWO", "THR"):
        project = old.create_project(P, ProjectCreate(key=key, title=f"Проект {key}"))
        parent = old.create_task(P, project.id, TaskCreate(title="Родитель"))
        old.create_task(P, project.id, TaskCreate(title="Подзадача", parent_task_id=parent.id))
    with old.db.write() as conn:  # two v3 task-plan proposals (rows as M6 stores them)
        for n in range(2):
            store.insert_proposal(
                conn,
                {
                    "id": f"WAP-000000000000000{n}",
                    "project_id": project.id,
                    "actor_id": OPERATOR.user_id,
                    "kind": "task_plan",
                    "schema_version": "work_plan.v1",
                    "status": "suggested",
                    "provider": "scripted",
                    "request_text": "план",
                    "goal": "",
                    "parent_task_id": None,
                    "start_date": None,
                    "base_plan_revision": 1,
                    "sources_json": "[]",
                    "plan_json": '{"tasks": [], "dependencies": []}',
                    "issues_json": "[]",
                    "assumptions_json": "[]",
                    "created_at": "2026-11-26T00:00:00+00:00",
                    "expires_at": "2026-11-27T00:00:00+00:00",
                },
            )
    assert schema_version(path) == 3
    before = _dump(path)
    monkeypatch.setattr("app.work.db.MIGRATIONS", migrations.MIGRATIONS)
    monkeypatch.setattr("app.work.db.LATEST_VERSION", migrations.LATEST_VERSION)
    upgraded = WorkDatabase(path)
    assert schema_version(path) == 4 == migrations.LATEST_VERSION
    assert len(upgraded.backups) == 1 and schema_version(upgraded.backups[0]) == 3
    assert verify_database(upgraded.backups[0]) == [] and verify_database(path) == []
    assert _dump(path) == before  # every pre-existing row, column and id kept
    with upgraded.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM work_task_change_proposals").fetchone()[0] == 0
        assert {r[0] for r in conn.execute("SELECT revised_from FROM work_ai_proposals")} == {None}
    again = WorkDatabase(path)  # restart: the migration is not re-run, no new backup
    assert again.backups == [] and schema_version(path) == 4 and _dump(path) == before
