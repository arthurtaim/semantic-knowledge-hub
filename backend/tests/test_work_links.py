"""M6 Step 4: task ↔ document links over HTTP, against the REAL knowledge service of the test app (the local
repository on a temporary workspace) — no parallel document store. Scenario ids in the test names: M6-11, M6-12,
M6-24, M6-34, M6-37, M6-38, M6-40.

Visibility is the reader's knowledge snapshot: in the local demo the repository shows every document; per-user ACL is
simulated the way GitLab enforces it — the snapshot itself differs by user (`_scope_knowledge`)."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.knowledge.base import KnowledgeSnapshot, RepositoryUnavailableError
from app.domain.models import UserContext
from app.work import store
from tests.support.work_identity import enable_membership, team_user

Client = Callable[..., TestClient]


@pytest.fixture
def wc(client_factory: Client) -> TestClient:
    return client_factory(work_seed_demo=False)


def project(client: TestClient, key: str = "LNK") -> dict[str, Any]:
    response = client.post("/api/projects", json={"key": key, "title": f"Проект {key}"})
    assert response.status_code == 201, response.text
    return dict(response.json())


def task(client: TestClient, project_ref: str, **fields: Any) -> dict[str, Any]:
    response = client.post(f"/api/projects/{project_ref}/tasks", json={"title": "Задача", **fields})
    assert response.status_code == 201, response.text
    return dict(response.json())


def link(
    client: TestClient, task_ref: str, document_id: str, relation: str = "implements", **extra: Any
) -> Any:
    return client.post(
        f"/api/tasks/{task_ref}/links", json={"document_id": document_id, "relation": relation, **extra}
    )


def audit_ops(client: TestClient) -> list[str]:
    with client.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        return [r[0] for r in conn.execute("SELECT operation FROM work_audit_events ORDER BY seq")]


def knowledge_root(client: TestClient) -> Path:
    return Path(client.app.state.container.settings.local_knowledge_dir)  # type: ignore[attr-defined]


def doc_file(client: TestClient, doc_id: str) -> Path:
    for path in knowledge_root(client).rglob("*.md"):
        if f"\nid: {doc_id}\n" in path.read_text(encoding="utf-8"):
            return path
    raise AssertionError(doc_id)


def current_revision(client: TestClient, doc_id: str) -> str:
    return str(client.get(f"/api/documents/{doc_id}").json()["revision"])


def _scope_knowledge(client: TestClient, hidden: dict[str, set[str]]) -> None:
    """Per-user visibility as a GitLab repository enforces it: the snapshot of `user` lacks `hidden[user]`."""
    knowledge = client.app.state.container.knowledge  # type: ignore[attr-defined]
    original = knowledge.snapshot

    async def scoped(user: UserContext) -> KnowledgeSnapshot:
        snapshot: KnowledgeSnapshot = await original(user)
        drop = {d.lower() for d in hidden.get(user.user_id, set())}
        if not drop:
            return snapshot
        docs = {k: v for k, v in snapshot.documents.items() if k not in drop}
        return KnowledgeSnapshot(version=f"{snapshot.version}-{user.user_id}", documents=docs)

    knowledge.snapshot = scoped


# --- M6-11: link, list, back-links, filter -------------------------------------------------------------------
def test_m6_11_link_is_read_from_the_current_snapshot_both_ways(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "LNK", title="Реализовать поток")
    other = task(wc, "LNK", title="Без документов")
    plan_before = wc.get("/api/projects/LNK").json()["plan_revision"]
    created = link(wc, t["key"], "sem-arch-001")  # any case: the server records the canonical id
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["state"] == "current" and body["relation"] == "implements" and body["source_system"] == "skh"
    assert body["document"]["document_id"] == "SEM-ARCH-001"
    assert body["document"]["app_path"] == "/documents/SEM-ARCH-001"
    assert body["revision_at_link"] == body["document"]["revision"] == current_revision(wc, "SEM-ARCH-001")
    assert body["approved"] is True and body["deprecated"] is False
    # the link changes neither the task (no version bump) nor the plan revision
    detail = wc.get(f"/api/tasks/{t['key']}").json()
    assert detail["version"] == t["version"] and detail["link_count"] == 1
    assert detail["document_ids"] == ["SEM-ARCH-001"]
    assert wc.get("/api/projects/LNK").json()["plan_revision"] == plan_before
    listed = wc.get(f"/api/tasks/{t['key']}/links").json()
    assert listed["knowledge_available"] is True and listed["generation"]
    assert [i["id"] for i in listed["items"]] == [body["id"]]
    # document → tasks (the document page's back-links), deep link to the task page
    back = wc.get("/api/documents/SEM-ARCH-001/tasks").json()
    assert back["total"] == 1 and back["revision"] == body["revision_at_link"]
    item = back["items"][0]
    assert (item["task_key"], item["app_path"], item["project_key"], item["state"]) == (
        t["key"],
        f"/tasks/{t['key']}",
        "LNK",
        "current",
    )
    assert wc.get("/api/documents/SEM-GLOSS-001/tasks").json() == {
        "document_id": "SEM-GLOSS-001",
        "revision": current_revision(wc, "SEM-GLOSS-001"),
        "items": [],
        "total": 0,
    }
    assert wc.get("/api/documents/NO-SUCH-001/tasks").status_code == 404
    # one filter for List / Board / Gantt: the API filter and the TaskOut field agree
    filtered = wc.get("/api/projects/LNK/tasks", params={"document": "sem-arch-001"}).json()
    assert [i["key"] for i in filtered["items"]] == [t["key"]]
    gantt = {x["key"]: x for x in wc.get("/api/projects/LNK/gantt").json()["tasks"]}
    assert gantt[t["key"]]["document_ids"] == ["SEM-ARCH-001"] and gantt[other["key"]]["document_ids"] == []
    docs = wc.get("/api/projects/LNK/documents").json()
    assert docs["knowledge_available"] is True
    assert [(d["document"]["document_id"], d["task_count"], d["changed_count"]) for d in docs["items"]] == [
        ("SEM-ARCH-001", 1, 0)
    ]
    assert audit_ops(wc).count("link_added") == 1


def test_link_rules_duplicates_idempotency_and_validation(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "LNK")
    first = link(wc, t["key"], "SEM-ARCH-001", client_request_id="link-req-0001")
    assert first.status_code == 201
    replay = link(wc, t["key"], "SEM-ARCH-001", client_request_id="link-req-0001")
    assert replay.status_code == 201 and replay.json()["id"] == first.json()["id"]
    dup = link(wc, t["key"], "SEM-ARCH-001")
    assert dup.status_code == 409 and dup.json()["details"]["reason"] == "link_exists"
    assert (
        link(wc, t["key"], "SEM-ARCH-001", "verifies").status_code == 201
    )  # another relation is another link
    assert audit_ops(wc).count("link_added") == 2  # the replay wrote nothing
    missing = link(wc, t["key"], "SEM-NOPE-404")
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"
    for body in (
        {"document_id": "SEM-ARCH-001", "relation": "depends_on"},  # not a task relation
        {"document_id": "../etc/passwd"},
        {"document_id": "SEM-ARCH-001", "revision_at_link": "forged"},  # server-owned
        {"document_id": "SEM-ARCH-001", "created_by": "admin"},
    ):
        assert wc.post(f"/api/tasks/{t['key']}/links", json=body).status_code == 422, body
    # removal keeps the history row; removing twice is «not found»; re-linking is a new link
    link_id = first.json()["id"]
    assert wc.delete(f"/api/tasks/{t['key']}/links/{link_id}").status_code == 200
    assert wc.delete(f"/api/tasks/{t['key']}/links/{link_id}").status_code == 404
    with wc.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        assert store.get_link(conn, link_id)["status"] == "removed"  # type: ignore[index]
    assert link(wc, t["key"], "SEM-ARCH-001").status_code == 201
    assert audit_ops(wc).count("link_removed") == 1


def test_link_states_draft_deprecated_and_archived_tasks(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "LNK")
    draft = link(wc, t["key"], "SEM-INT-ARIS-001", "documents").json()
    deprecated = link(wc, t["key"], "SEM-PROC-OLD-001", "requires").json()
    assert (draft["document"]["status"], draft["approved"], draft["deprecated"]) == ("draft", False, False)
    assert (deprecated["document"]["status"], deprecated["deprecated"]) == ("deprecated", True)
    # an archived task keeps its links as history, is read-only, and leaves the back-links
    version = wc.get(f"/api/tasks/{t['key']}").json()["version"]
    assert wc.delete(f"/api/tasks/{t['key']}", params={"expected_version": version}).status_code == 200
    assert wc.get("/api/documents/SEM-INT-ARIS-001/tasks").json()["total"] == 0
    refused = link(wc, t["key"], "SEM-ARCH-001")
    assert refused.status_code == 409 and refused.json()["details"]["reason"] == "task_archived"
    archived = wc.get(f"/api/tasks/{t['key']}").json()
    assert (
        wc.post(
            f"/api/tasks/{t['key']}/restore", params={"expected_version": archived["version"]}
        ).status_code
        == 200
    )
    assert wc.get("/api/documents/SEM-INT-ARIS-001/tasks").json()["total"] == 1


# --- M6-24 / M6-38: a revision change is shown, never re-approved automatically ------------------------------
def test_m6_24_m6_38_changed_document_is_flagged_until_a_person_acknowledges(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "LNK", title="Опирается на стандарт")
    created = link(wc, t["key"], "SEM-STD-001", "requires").json()
    seen = created["revision_at_link"]
    path = doc_file(wc, "SEM-STD-001")
    original = path.read_bytes()
    # a new revision of the canonical document (as a template version update or a merge would produce)
    path.write_text(
        path.read_text(encoding="utf-8") + "\n## Новый раздел\n\nДополнение стандарта (демо).\n",
        encoding="utf-8",
    )
    after = wc.get(f"/api/tasks/{t['key']}/links").json()["items"][0]
    assert after["state"] == "revision_changed"
    assert after["revision_at_link"] == seen and after["document"]["revision"] != seen
    assert after["document"]["document_id"] == "SEM-STD-001"  # the same canonical id, never re-pointed
    task_now = wc.get(f"/api/tasks/{t['key']}").json()
    assert task_now["version"] == t["version"] and task_now["updated_at"] == t["updated_at"]  # task untouched
    assert wc.get("/api/documents/SEM-STD-001/tasks").json()["items"][0]["state"] == "revision_changed"
    assert wc.get("/api/projects/LNK/documents").json()["items"][0]["changed_count"] == 1
    ack = wc.post(f"/api/tasks/{t['key']}/links/{created['id']}/acknowledge")
    assert ack.status_code == 200 and ack.json()["state"] == "current"
    assert ack.json()["revision_at_link"] == current_revision(wc, "SEM-STD-001")
    again = wc.post(f"/api/tasks/{t['key']}/links/{created['id']}/acknowledge")
    assert again.status_code == 200 and audit_ops(wc).count("link_revision_acknowledged") == 1
    # the work module never writes the document: the file is exactly the edited text
    assert path.read_bytes() == original + "\n## Новый раздел\n\nДополнение стандарта (демо).\n".encode()


def test_m6_34_deleted_document_becomes_unavailable_without_details(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "LNK")
    created = link(wc, t["key"], "SEM-GLOSS-001", "requires").json()
    doc_file(wc, "SEM-GLOSS-001").unlink()
    body = wc.get(f"/api/tasks/{t['key']}/links").json()
    item = body["items"][0]
    assert item["state"] == "unavailable" and item["document"] is None and item["revision_at_link"] is None
    dump = json.dumps(body, ensure_ascii=False)
    assert "SEM-GLOSS-001" not in dump and "Глоссарий" not in dump
    detail = wc.get(f"/api/tasks/{t['key']}").json()
    assert detail["link_count"] == 0 and detail["document_ids"] == []
    assert wc.get("/api/documents/SEM-GLOSS-001/tasks").status_code == 404
    ack = wc.post(f"/api/tasks/{t['key']}/links/{created['id']}/acknowledge")
    assert ack.status_code == 404
    activity = json.dumps(wc.get(f"/api/tasks/{t['key']}/activity").json(), ensure_ascii=False)
    assert "SEM-GLOSS-001" not in activity and "недоступен" in activity
    # a dangling link can still be removed by its id
    assert wc.delete(f"/api/tasks/{t['key']}/links/{created['id']}").status_code == 200


# --- M6-12 / M6-37: per-user ACL ----------------------------------------------------------------------------
def test_m6_12_m6_37_hidden_document_leaks_nothing_to_another_member(wc: TestClient) -> None:
    identity = enable_membership(wc)
    _scope_knowledge(wc, {"bob": {"SEM-ARCH-001"}})
    identity.current = team_user("alice")
    p = project(wc, "ACL")
    t = task(wc, "ACL", title="Связана со скрытым документом")
    assert link(wc, t["key"], "SEM-ARCH-001").status_code == 201
    assert link(wc, t["key"], "SEM-GLOSS-001", "requires").status_code == 201
    with wc.app.state.container.work.db.write() as conn:  # type: ignore[attr-defined]
        store.put_member(conn, p["id"], "bob", "member", "alice", "2026-11-25T00:00:00+00:00")
        store.put_member(conn, p["id"], "vera", "viewer", "alice", "2026-11-25T00:00:00+00:00")
    identity.current = team_user("bob")
    links = wc.get(f"/api/tasks/{t['key']}/links").json()
    states = sorted(i["state"] for i in links["items"])
    assert states == ["current", "unavailable"]
    hidden = next(i for i in links["items"] if i["state"] == "unavailable")
    assert hidden["document"] is None and hidden["revision_at_link"] is None
    dump = json.dumps(links, ensure_ascii=False)
    assert "SEM-ARCH-001" not in dump and "Semantic Layer" not in dump
    detail = wc.get(f"/api/tasks/{t['key']}").json()
    assert detail["link_count"] == 1 and detail["document_ids"] == ["SEM-GLOSS-001"]
    assert wc.get("/api/documents/SEM-ARCH-001/tasks").status_code == 404
    assert wc.get("/api/projects/ACL/tasks", params={"document": "SEM-ARCH-001"}).json()["items"] == []
    docs = wc.get("/api/projects/ACL/documents").json()["items"]
    assert [d["document"]["document_id"] for d in docs] == ["SEM-GLOSS-001"]
    assert link(wc, t["key"], "SEM-ARCH-001", "verifies").status_code == 404  # cannot link what it cannot see
    activity = json.dumps(wc.get(f"/api/tasks/{t['key']}/activity").json(), ensure_ascii=False)
    assert "SEM-ARCH-001" not in activity
    # a viewer reads links but cannot change them; a non-member does not see the project or its back-links
    identity.current = team_user("vera")
    assert wc.get(f"/api/tasks/{t['key']}/links").status_code == 200
    assert link(wc, t["key"], "SEM-STD-001").status_code == 403
    identity.current = team_user("carol")
    assert wc.get(f"/api/tasks/{t['key']}/links").status_code == 404
    assert wc.get("/api/documents/SEM-GLOSS-001/tasks").json()["total"] == 0  # not even counted


# --- M6-40: the knowledge source is down ----------------------------------------------------------------------
def test_m6_40_unreadable_knowledge_never_blocks_tasks_and_is_not_masked(wc: TestClient) -> None:
    project(wc)
    t = task(wc, "LNK")
    assert link(wc, t["key"], "SEM-ARCH-001").status_code == 201
    knowledge = wc.app.state.container.knowledge  # type: ignore[attr-defined]

    async def down(user: UserContext) -> KnowledgeSnapshot:
        raise RepositoryUnavailableError("gitlab_unreachable", "GitLab недоступен.")

    knowledge.snapshot = down
    body = wc.get(f"/api/tasks/{t['key']}/links").json()
    assert body["knowledge_available"] is False
    assert [(i["state"], i["document"]) for i in body["items"]] == [("unverified", None)]
    detail = wc.get(f"/api/tasks/{t['key']}").json()
    assert detail["link_count"] is None and detail["document_ids"] is None  # unknown, not «0»
    # the tracker keeps working
    assert task(wc, "LNK", title="Новая")["key"] == "LNK-2"
    assert (
        wc.patch(
            f"/api/tasks/{t['key']}", json={"expected_version": detail["version"], "status": "done"}
        ).status_code
        == 200
    )
    assert wc.get("/api/projects/LNK/gantt").status_code == 200
    refused = link(wc, t["key"], "SEM-GLOSS-001")
    assert refused.status_code == 503 and refused.json()["code"] == "knowledge_unavailable"
    assert wc.get("/api/projects/LNK/tasks", params={"document": "SEM-ARCH-001"}).status_code == 503
    assert wc.get("/api/projects/LNK/documents").json()["knowledge_available"] is False


# --- a link is not a knowledge-graph relation -----------------------------------------------------------------
def test_links_add_no_graph_edge_and_never_touch_the_document(wc: TestClient) -> None:
    before_links = wc.get("/api/documents/SEM-ARCH-001/links").json()
    before_graph = wc.get("/api/graph/overview").json()
    path = doc_file(wc, "SEM-ARCH-001")
    original = path.read_bytes()
    project(wc)
    t = task(wc, "LNK")
    assert link(wc, t["key"], "SEM-ARCH-001").status_code == 201
    after_links = wc.get("/api/documents/SEM-ARCH-001/links").json()
    assert (
        after_links["outgoing"] == before_links["outgoing"]
        and after_links["backlinks"] == before_links["backlinks"]
    )
    after_graph = wc.get("/api/graph/overview").json()
    assert len(after_graph["nodes"]) == len(before_graph["nodes"]) and len(after_graph["edges"]) == len(
        before_graph["edges"]
    )
    assert t["key"] not in json.dumps(after_graph, ensure_ascii=False)
    assert path.read_bytes() == original


# --- seed ----------------------------------------------------------------------------------------------------
def test_seeded_links_point_at_synthetic_documents_idempotently(
    client_factory: Client, settings_factory: Callable[..., Any], full_workspace: Path
) -> None:
    first = client_factory(local_knowledge_dir=full_workspace)
    links = first.get("/api/tasks/ARIS-1/links").json()["items"]
    by_doc = {i["document"]["document_id"]: i for i in links}
    assert set(by_doc) == {"DEMO-SRC-002", "DEMO-INT-018"}
    assert by_doc["DEMO-INT-018"]["deprecated"] is True and by_doc["DEMO-SRC-002"]["state"] == "current"
    assert by_doc["DEMO-SRC-002"]["created_by"] == "system:demo-seed"
    docs = first.get("/api/projects/ARIS/documents").json()["items"]
    assert {d["document"]["document_id"] for d in docs} >= {"DEMO-INT-002", "SEM-INT-ARIS-001"}
    with first.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        seeded = conn.execute(
            "SELECT COUNT(*) FROM work_task_links WHERE created_by = 'system:demo-seed'"
        ).fetchone()[0]
    assert seeded == 15
    # the operator removes one seeded link; restarts never re-create it and never duplicate the others
    removed = by_doc["DEMO-INT-018"]["id"]
    assert first.delete(f"/api/tasks/ARIS-1/links/{removed}").status_code == 200
    first.__exit__(None, None, None)
    second = client_factory(local_knowledge_dir=full_workspace)
    again = second.get("/api/tasks/ARIS-1/links").json()["items"]
    assert [i["document"]["document_id"] for i in again] == ["DEMO-SRC-002"]
    with second.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        total = conn.execute("SELECT COUNT(*) FROM work_task_links").fetchone()[0]
    assert total == 15


def test_seed_skips_documents_missing_from_the_base(client_factory: Client) -> None:
    c = client_factory()  # the 9 core documents only: DEMO-* links are skipped, SEM-* ones exist
    with c.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        ids = sorted(r[0] for r in conn.execute("SELECT document_id FROM work_task_links"))
    assert ids == ["SEM-ARCH-001", "SEM-DEC-001", "SEM-INT-ARIS-001"]


def test_m6_38_template_version_change_keeps_the_canonical_id_and_flags_the_revision(wc: TestClient) -> None:
    """A linked document re-pinned to a new template version (what a Template Studio update produces on its next
    revision): the link keeps the SAME canonical id and reports the changed revision; no task template appears, the
    task is untouched, and the work module writes nothing into the document."""
    project(wc)
    t = task(wc, "LNK", title="Опирается на стандарт")
    created = link(wc, t["key"], "SEM-STD-001", "requires").json()
    path = doc_file(wc, "SEM-STD-001")
    text = path.read_text(encoding="utf-8")
    repinned = text.replace(
        "updated_at: 2025-01-15\n", "updated_at: 2025-01-15\ntemplate: standard\ntemplate_version: 2\n", 1
    )
    assert repinned != text
    path.write_text(repinned, encoding="utf-8")
    item = wc.get(f"/api/tasks/{t['key']}/links").json()["items"][0]
    assert item["id"] == created["id"] and item["document"]["document_id"] == "SEM-STD-001"
    assert item["state"] == "revision_changed" and item["revision_at_link"] == created["revision_at_link"]
    assert wc.get(f"/api/tasks/{t['key']}").json()["version"] == t["version"]
    assert path.read_text(encoding="utf-8") == repinned  # nothing written back by the work module
    with wc.app.state.container.work.db.read() as conn:  # type: ignore[attr-defined]
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert not any("template" in name for name in tables)  # no task-template entity exists in M6
