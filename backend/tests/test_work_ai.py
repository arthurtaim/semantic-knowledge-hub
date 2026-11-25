"""M6 Step 5: «AI план» — typed task-plan proposals through the real HTTP API with the SCRIPTED MODEL double (no real
model, no sockets). Nothing is written to tasks until a person applies; apply is one transaction; stale or invalid
plans never reach the tasks. Scenario ids: M6-13, M6-14, M6-15, M6-16, M6-18, M6-19, M6-20, M6-25, M6-33, M6-34,
M6-37, M6-40."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.ai.claude_cli import ClaudeCodeCLIProvider
from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider
from app.work import store
from app.work.links import DocumentScope
from app.work.models import WorkProposalApply
from app.work.permissions import WorkPrincipal
from tests.support.scripted_model import Recorder, claude_transport, openai_transport
from tests.support.work_identity import enable_membership, team_user

Factory = Callable[..., tuple[TestClient, Recorder]]
DOCS = ["SEM-ARCH-001", "SEM-STD-001"]
FRIDAY = "2026-11-27"


@pytest.fixture
def ai_client(client_factory: Callable[..., TestClient]) -> Factory:
    def factory(kind: str = "openai", **overrides: Any) -> tuple[TestClient, Recorder]:
        client = client_factory(**{"work_seed_demo": False, **overrides})
        container = client.app.state.container  # type: ignore[attr-defined]
        recorder = Recorder()
        if kind == "openai":
            provider: Any = OpenAICompatibleAIProvider(
                base_url="https://ai.example.test/v1",
                model="scripted",
                api_key=SecretStr(""),
                timeout_seconds=10,
                allowed_hosts=["ai.example.test"],
                transport=openai_transport(recorder),
                instructions=container.instructions,
            )
        else:
            provider = ClaudeCodeCLIProvider(
                worker_url="http://127.0.0.1:8090",
                transport=claude_transport(recorder),
                instructions=container.instructions,
            )
        container.work_ai._ai = provider
        container.work.ai_planning = container.work_ai.available
        client.post("/api/projects", json={"key": "PLN", "title": "Проект для плана"})
        return client, recorder

    return factory


def propose(
    client: TestClient, request: str = "Подготовь задачи по архитектуре и стандарту", **extra: Any
) -> Any:
    body = {"project_id": "PLN", "request": request, "document_ids": DOCS, **extra}
    return client.post("/api/work-ai/proposals", json=body)


def state(client: TestClient) -> dict[str, int]:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return {
            "tasks": conn.execute("SELECT COUNT(*) FROM work_tasks").fetchone()[0],
            "deps": conn.execute("SELECT COUNT(*) FROM work_dependencies").fetchone()[0],
            "links": conn.execute("SELECT COUNT(*) FROM work_task_links").fetchone()[0],
            "audit": store.count_audit(conn),
            "proposals": conn.execute("SELECT COUNT(*) FROM work_ai_proposals").fetchone()[0],
            "plan": conn.execute("SELECT plan_revision FROM work_projects WHERE key = 'PLN'").fetchone()[0],
        }


def apply(client: TestClient, proposal: dict[str, Any], key: str = "apply-req-0001", **edits: Any) -> Any:
    body = {"expected_plan_revision": proposal["base_plan_revision"], "client_request_id": key, **edits}
    return client.post(f"/api/work-ai/proposals/{proposal['id']}/apply", json=body)


def doc_file(client: TestClient, doc_id: str) -> Path:
    root = Path(client.app.state.container.settings.local_knowledge_dir)  # type: ignore[attr-defined]
    return next(p for p in root.rglob("*.md") if f"\nid: {doc_id}\n" in p.read_text(encoding="utf-8"))


# --- M6-13: a proposal writes nothing ------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["openai", "claude"])
def test_m6_13_a_proposal_is_reviewable_evidence_and_writes_no_task(ai_client: Factory, kind: str) -> None:
    client, recorder = ai_client(kind)
    before = state(client)
    response = propose(client, start_date=FRIDAY)
    assert response.status_code == 201, response.text
    p = response.json()
    assert (p["status"], p["state"], p["kind"], p["schema_version"]) == (
        "suggested",
        "ready",
        "task_plan",
        "work_plan.v1",
    )
    assert p["provider"] == ("internal_api" if kind == "openai" else "claude_cli")
    assert p["base_plan_revision"] == before["plan"] and p["can_apply"] is True
    assert [s["document_id"] for s in p["sources"]] == DOCS and all(
        s["state"] == "current" for s in p["sources"]
    )
    by_id = {t["local_id"]: t for t in p["tasks"]}
    assert len(by_id) == 6 and all(t["assignee_id"] is None for t in p["tasks"])
    first = by_id["t1"]
    assert first["sources"][0]["verified"] is True and first["sources"][0]["quote"]
    assert first["sources"][0]["title"] and first["sources"][0]["document_id"] == "SEM-ARCH-001"
    assert by_id["t4"]["parent_local_id"] == "t3" and by_id["t6"]["is_milestone"] is True
    assert {(d["predecessor"], d["successor"]) for d in p["dependencies"]} == {
        ("t1", "t3"),
        ("t2", "t3"),
        ("t3", "t5"),
        ("t5", "t6"),
    }
    # dates come from the SERVER: Mon–Fri from Friday, FS chain, the milestone a point
    assert (first["start_date"], first["end_exclusive"], first["last_day"]) == (
        "2026-11-27",
        "2026-12-01",
        "2026-11-30",
    )
    assert by_id["t3"]["start_date"] == "2026-12-01" and by_id["t3"]["end_exclusive"] == "2026-12-04"
    assert (
        by_id["t5"]["start_date"] == "2026-12-04"
        and by_id["t6"]["start_date"] == by_id["t6"]["end_exclusive"] == "2026-12-07"
    )
    assert p["assumptions"] and any(i["code"] == "no_sources" for i in p["issues"])
    after = state(client)
    assert {k: after[k] - before[k] for k in after} == {
        "tasks": 0,
        "deps": 0,
        "links": 0,
        "audit": 1,  # proposal_created only
        "proposals": 1,
        "plan": 0,
    }
    system, prompt = recorder.calls[0]
    assert "Режим планирования задач SKH" in system and "НЕДОВЕРЕННЫЕ ДАННЫЕ" in system
    assert "<<<SOURCE SEM-ARCH-001>>>" in prompt and "Подготовь задачи" in prompt
    assert client.get(f"/api/work-ai/proposals/{p['id']}").json()["state"] == "ready"


# --- M6-14: apply in one transaction ---------------------------------------------------------------------------
def test_m6_14_apply_writes_tasks_dependencies_and_links_in_one_transaction(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client, start_date=FRIDAY).json()
    before = state(client)
    response = apply(client, p)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["applied"] is True and result["replayed"] is False
    assert result["plan_revision"] == before["plan"] + 1  # one bump for the whole plan
    keys = {t["title"]: t["key"] for t in result["created_tasks"]}
    assert len(keys) == 6 and result["created_dependencies"] == 4 and result["created_links"] == 3
    created = {t["title"]: t for t in result["created_tasks"]}
    impl = created["Реализовать по требованиям"]
    assert created["Подготовить тестовые данные (синтетические)"]["parent_task_id"] == impl["id"]
    milestone = created["Готово к приёмке"]
    assert milestone["is_milestone"] and milestone["start_date"] == milestone["end_exclusive"] == "2026-12-07"
    assert all(
        t["status"] == "todo" and t["assignee_id"] is None and not t["is_demo"]
        for t in result["created_tasks"]
    )
    deps = client.get(f"/api/tasks/{impl['key']}/dependencies").json()
    assert len(deps["predecessors"]) == 2 and all(d["dependency"]["satisfied"] for d in deps["predecessors"])
    links = client.get(
        f"/api/tasks/{created[next(t for t in created if t.startswith('Разобрать'))]['key']}/links"
    ).json()
    assert links["items"][0]["state"] == "current" and links["items"][0]["relation"] == "implements"
    after = state(client)
    assert (
        after["tasks"] - before["tasks"],
        after["deps"] - before["deps"],
        after["links"] - before["links"],
    ) == (6, 4, 3)
    activity = client.get(f"/api/tasks/{impl['key']}/activity").json()["items"]
    created_event = next(e for e in activity if e["operation"] == "task_created")
    assert created_event["changes"]["proposal_id"] == p["id"] and created_event["correlation_id"] == p["id"]
    shown = client.get(f"/api/work-ai/proposals/{p['id']}").json()
    assert shown["status"] == shown["state"] == "applied" and sorted(shown["applied_task_keys"]) == sorted(
        keys.values()
    )
    assert shown["can_apply"] is False
    # an idempotent replay returns the first result; another confirmation is refused
    replay = apply(client, p)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert state(client) == after
    again = apply(client, p, key="apply-req-0002")
    assert again.status_code == 409 and again.json()["details"]["reason"] == "already_applied"


def test_reviewed_edits_are_the_only_changes_a_person_can_make(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client).json()  # no start: unscheduled until a person chooses one
    assert all(t["start_date"] is None for t in p["tasks"])
    edits = {
        "tasks": [
            {"local_id": "t2", "include": False},
            {
                "local_id": "t1",
                "title": "Разобрать архитектуру (правка)",
                "estimate_workdays": 3,
                "assignee_id": "demo-analyst-1",
            },
        ],
        "excluded_dependencies": [{"predecessor": "t5", "successor": "t6"}],
        "start_date": "2026-11-30",
    }
    before = state(client)
    preview = client.post(f"/api/work-ai/proposals/{p['id']}/preview", json=edits)
    assert preview.status_code == 200, preview.text
    shown = {t["local_id"]: t for t in preview.json()["tasks"]}
    assert shown["t2"]["included"] is False and shown["t1"]["title"] == "Разобрать архитектуру (правка)"
    assert (shown["t1"]["start_date"], shown["t1"]["end_exclusive"]) == ("2026-11-30", "2026-12-03")
    assert shown["t3"]["start_date"] == "2026-12-03"  # after the edited t1 only
    assert shown["t6"]["start_date"] == "2026-11-30"  # its dependency was dropped
    assert state(client) == before  # preview writes nothing
    for bad in (
        {"tasks": [{"local_id": "t99"}]},  # cannot add or address a task that is not in the proposal
        {"excluded_dependencies": [{"predecessor": "t1", "successor": "t6"}]},
        {"tasks": [{"local_id": "t6", "estimate_workdays": 3}]},  # a milestone has no duration
        {"tasks": [{"local_id": "t1", "status": "done"}]},  # not an editable field
    ):
        assert client.post(f"/api/work-ai/proposals/{p['id']}/preview", json=bad).status_code == 422, bad
    wrong = apply(client, p, tasks=[{"local_id": "t1", "assignee_id": "someone-real"}])
    assert wrong.status_code == 422 and wrong.json()["code"] == "invalid_assignee"
    assert state(client) == before  # rolled back, nothing written
    done = apply(client, p, key="apply-req-0003", **edits).json()
    titles = {t["title"]: t for t in done["created_tasks"]}
    assert "Разобрать архитектуру (правка)" in titles and not any(
        t.startswith("Разобрать требования: Стандарт") for t in titles
    )
    assert titles["Разобрать архитектуру (правка)"]["assignee_id"] == "demo-analyst-1"
    assert len(done["created_tasks"]) == 5 and done["created_dependencies"] == 2


# --- M6-15 / M6-16 / M6-33 ----------------------------------------------------------------------------------------
def test_m6_15_rejected_proposal_creates_nothing(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client).json()
    before = state(client)
    rejected = client.post(f"/api/work-ai/proposals/{p['id']}/reject")
    assert rejected.status_code == 200 and rejected.json()["state"] == "rejected"
    after = state(client)
    assert after["tasks"] == before["tasks"] and after["audit"] == before["audit"] + 1  # proposal_rejected
    refused = apply(client, p)
    assert refused.status_code == 409 and refused.json()["details"]["reason"] == "already_rejected"
    assert client.post(f"/api/work-ai/proposals/{p['id']}/reject").status_code == 409


@pytest.mark.parametrize(
    ("request_text", "reason"),
    [
        ("Сделай цикл зависимостей", "dependency_cycle"),
        ("Ссылка на неизвестную задачу", "unknown_task_in_dependency"),
    ],
)
def test_m6_16_invalid_plan_is_refused_and_nothing_is_stored(
    ai_client: Factory, request_text: str, reason: str
) -> None:
    client, _ = ai_client()
    before = state(client)
    response = propose(client, request_text)
    assert response.status_code == 422 and response.json()["code"] == "proposal_invalid"
    assert response.json()["details"]["reason"] == reason
    assert state(client) == before


def test_m6_33_hallucinated_assignee_dates_and_sources_never_become_data(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client, "Галлюцинации модели: исполнитель, даты, источник").json()
    codes = {(i["code"], i["local_id"]) for i in p["issues"]}
    assert {
        ("assignee_ignored", "t1"),
        ("dates_ignored", "t1"),
        ("unknown_source", "t1"),
        ("quote_not_verified", "t1"),
    } <= codes
    dump = json.dumps(p, ensure_ascii=False)
    assert "SEC-HIDDEN-001" not in dump and "real.person" not in dump
    first = next(t for t in p["tasks"] if t["local_id"] == "t1")
    assert first["assignee_id"] is None and first["start_date"] is None
    assert [(s["document_id"], s["verified"], s["quote"]) for s in first["sources"]] == [
        ("SEM-ARCH-001", False, None)
    ]
    result = apply(client, p).json()
    t1 = next(t for t in result["created_tasks"] if t["title"].startswith("Разобрать требования: Semantic"))
    assert t1["assignee_id"] is None and t1["start_date"] is None
    assert (
        client.get(f"/api/tasks/{t1['key']}/links").json()["items"] == []
    )  # an unverified source is not linked


# --- M6-34 and staleness ----------------------------------------------------------------------------------------
def test_m6_34_changed_or_hidden_source_and_plan_changes_make_it_stale(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client).json()
    path = doc_file(client, "SEM-STD-001")
    path.write_text(
        path.read_text(encoding="utf-8") + "\nИзменение после предложения (демо).\n", encoding="utf-8"
    )
    shown = client.get(f"/api/work-ai/proposals/{p['id']}").json()
    assert (
        shown["state"] == "stale"
        and shown["stale_reasons"] == ["source_changed"]
        and shown["can_apply"] is False
    )
    before = state(client)
    refused = apply(client, p)
    assert refused.status_code == 409 and refused.json()["details"]["reason"] == "source_changed"
    assert state(client) == before
    # a hidden / deleted source: no id or title of it is shown any more
    q = propose(client).json()
    doc_file(client, "SEM-ARCH-001").unlink()
    hidden = client.get(f"/api/work-ai/proposals/{q['id']}").json()
    assert "source_unavailable" in hidden["stale_reasons"]
    assert "SEM-ARCH-001" not in json.dumps(hidden["sources"], ensure_ascii=False)
    assert apply(client, q).status_code == 409


def test_plan_change_and_expiry_make_a_proposal_stale(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client).json()
    assert client.post("/api/projects/PLN/tasks", json={"title": "Чужая правка"}).status_code == 201
    shown = client.get(f"/api/work-ai/proposals/{p['id']}").json()
    assert (
        shown["stale_reasons"] == ["plan_changed"]
        and shown["current_plan_revision"] == p["base_plan_revision"] + 1
    )
    refused = apply(client, p)
    assert refused.status_code == 409 and refused.json()["details"]["reason"] == "plan_changed"
    q = propose(client).json()
    service = client.app.state.container.work_ai  # type: ignore[attr-defined]
    service._now = lambda: datetime.now(UTC) + timedelta(days=2)
    assert client.get(f"/api/work-ai/proposals/{q['id']}").json()["stale_reasons"] == ["expired"]
    assert apply(client, q).json()["details"]["reason"] == "expired"


# --- M6-18: failure in the middle of apply ----------------------------------------------------------------------
def test_m6_18_failure_during_apply_rolls_everything_back(ai_client: Factory) -> None:
    client, _ = ai_client()
    p = propose(client, start_date=FRIDAY).json()
    container = client.app.state.container  # type: ignore[attr-defined]
    before = state(client)
    written: list[str] = []

    def explode(task_id: str) -> None:
        written.append(task_id)
        if len(written) == 3:
            raise RuntimeError("disk full (simulated)")

    container.work._after_plan_write = explode
    principal = WorkPrincipal(
        user=container.demo_user(),
        request_id="t",
        documents=DocumentScope.from_snapshot(
            client.portal.call(container.knowledge.snapshot, container.demo_user()),
            "g",  # type: ignore[attr-defined]
        ),
    )
    body = WorkProposalApply(
        expected_plan_revision=p["base_plan_revision"], client_request_id="apply-fail-0001"
    )
    with pytest.raises(RuntimeError):
        container.work_ai.apply(principal, p["id"], body)
    assert len(written) == 3 and state(client) == before
    assert client.get(f"/api/work-ai/proposals/{p['id']}").json()["status"] == "suggested"
    container.work._after_plan_write = None
    assert apply(client, p, key="apply-fail-0001").status_code == 200  # the same key now applies once


# --- gates: read-only exposure, roles, no AI ----------------------------------------------------------------------
def test_m6_20_public_exposure_never_invokes_the_model(ai_client: Factory) -> None:
    client, recorder = ai_client()
    headers = {"X-SKH-Exposure": "public"}
    refused = client.post(
        "/api/work-ai/proposals",
        json={"project_id": "PLN", "request": "План", "document_ids": DOCS},
        headers=headers,
    )
    assert refused.status_code == 403 and refused.json()["details"]["mode"] == "read_only"
    assert recorder.calls == []  # the gate is checked before any model call
    p = propose(
        client
    ).json()  # the same operator on loopback may propose; through the gateway nobody may apply
    blocked = client.post(
        f"/api/work-ai/proposals/{p['id']}/apply",
        json={"expected_plan_revision": p["base_plan_revision"], "client_request_id": "apply-pub-0001"},
        headers=headers,
    )
    assert blocked.status_code == 403
    caps = client.get("/api/work/capabilities", headers=headers).json()
    assert caps["can_write"] is False
    assert client.get(f"/api/work-ai/proposals/{p['id']}").json()["status"] == "suggested"  # nothing applied


def test_m6_19_m6_37_viewers_and_non_members_cannot_make_the_model_plan(ai_client: Factory) -> None:
    client, recorder = ai_client()
    identity = enable_membership(client)
    identity.current = team_user("alice")
    project = client.post("/api/projects", json={"key": "TEAM", "title": "Командный"}).json()
    with client.app.state.container.work.db.write() as conn:  # type: ignore[attr-defined]
        store.put_member(conn, project["id"], "vera", "viewer", "alice", "2026-11-25T00:00:00+00:00")
    body = {"project_id": "TEAM", "request": "План по архитектуре", "document_ids": DOCS}
    identity.current = team_user("vera")
    assert client.post("/api/work-ai/proposals", json=body).status_code == 403
    identity.current = team_user("carol")
    assert client.post("/api/work-ai/proposals", json=body).status_code == 404  # the project is invisible
    assert recorder.calls == []
    identity.current = team_user("alice")
    p = client.post("/api/work-ai/proposals", json=body)
    assert p.status_code == 201
    _, prompt = recorder.calls[-1]
    assert "PLN" not in prompt.split("<<<EXISTING TASKS>>>")[1].split("<<<END EXISTING TASKS>>>")[0]
    identity.current = team_user("vera")
    assert client.get(f"/api/work-ai/proposals/{p.json()['id']}").status_code in (
        403,
        404,
    )  # personal + gated


def test_m6_25_m6_40_without_a_planning_model_the_tracker_works_and_says_so(
    client_factory: Callable[..., TestClient],
) -> None:
    client = client_factory(work_seed_demo=False)  # AI_PROVIDER=mock: no planning capability, nothing faked
    caps = client.get("/api/work/capabilities").json()
    assert caps["features"]["ai_proposals"] is False
    client.post("/api/projects", json={"key": "NOAI", "title": "Без AI"})
    refused = client.post(
        "/api/work-ai/proposals", json={"project_id": "NOAI", "request": "План", "document_ids": DOCS}
    )
    assert refused.status_code == 503 and refused.json()["code"] == "feature_unavailable"
    assert client.post("/api/projects/NOAI/tasks", json={"title": "Работает"}).status_code == 201


def test_model_failure_or_garbage_stores_nothing(ai_client: Factory) -> None:
    client, _ = ai_client()
    before = state(client)
    failed = propose(client, "Модель упади, пожалуйста")
    assert failed.status_code in (502, 503) and failed.json()["code"].startswith("ai_")
    garbage = propose(client, "Сломанный формат ответа")
    assert garbage.status_code == 502 and garbage.json()["code"] == "ai_invalid_response"
    assert state(client) == before
    assert client.post("/api/projects/PLN/tasks", json={"title": "Трекер работает"}).status_code == 201


def test_documents_must_be_visible_and_evidence_is_required(ai_client: Factory) -> None:
    client, recorder = ai_client()
    hidden = propose(client, document_ids=["SEM-NOPE-404"])
    assert hidden.status_code == 404 and recorder.calls == []
    nothing = client.post(
        "/api/work-ai/proposals", json={"project_id": "PLN", "request": "Квазизвёздный шлюз зюйдвест"}
    )
    assert (
        nothing.status_code == 422
        and nothing.json()["details"]["reason"] == "no_sources"
        and recorder.calls == []
    )
    auto = client.post(
        "/api/work-ai/proposals", json={"project_id": "PLN", "request": "архитектура семантического слоя"}
    )
    assert auto.status_code == 201
    assert all(
        s["status"] == "approved" for s in auto.json()["sources"]
    )  # chosen by the server: approved only
    for body in (
        {"project_id": "PLN", "request": "План", "document_ids": DOCS, "assignee_id": "x"},
        {"project_id": "PLN", "request": "План", "document_ids": DOCS * 3},  # > 5 documents
        {"project_id": "PLN", "request": "x" * 2001},
    ):
        assert client.post("/api/work-ai/proposals", json=body).status_code == 422, body
