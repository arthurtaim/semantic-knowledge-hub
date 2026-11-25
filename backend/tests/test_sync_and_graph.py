"""Index generations, structured sync results and the knowledge graph API (M5.6.2 §C, Appendix 6)."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.adapters.search.base import SearchFilters
from app.adapters.search.sqlite_fts import SqliteFtsSearchProvider
from tests.conftest import make_doc, write_doc


def sync(client: TestClient, *, rebuild: bool = False) -> dict[str, object]:
    response = client.post("/api/index/sync", params={"rebuild": str(rebuild).lower()})
    assert response.status_code == 200, response.text
    data: dict[str, object] = response.json()
    return data


def last(status: dict[str, object]) -> dict[str, object]:
    result = status["last_sync"]
    assert isinstance(result, dict)
    return result


def search_ids(client: TestClient, q: str) -> list[str]:
    return [i["id"] for i in client.get("/api/documents", params={"query": q}).json()["items"]]


def test_add_update_rename_delete_are_reported_and_searchable(workspace: Path, client: TestClient) -> None:
    first = sync(client)
    generation = first["generation"]
    assert isinstance(generation, int) and generation >= 1
    # repeating the same sync is a no-op: same generation, nothing applied
    again = sync(client)
    assert again["generation"] == generation and last(again)["applied"] is False

    write_doc(
        workspace,
        "SEM-NEW-501.md",
        make_doc(
            "SEM-NEW-501",
            title="Квазар-реестр",
            body="# Квазар\n\nУникальное слово ксеноморф описывает реестр.\n",
        ),
    )
    added = sync(client)
    assert added["generation"] == generation + 1 and last(added)["added"] == ["SEM-NEW-501"]
    assert search_ids(client, "ксеноморф") == ["SEM-NEW-501"]

    write_doc(
        workspace,
        "SEM-NEW-501.md",
        make_doc(
            "SEM-NEW-501",
            title="Квазар-реестр",
            body="# Квазар\n\nТеперь здесь слово аметист вместо прежнего.\n",
        ),
    )
    updated = sync(client)
    assert last(updated)["updated"] == ["SEM-NEW-501"]
    assert search_ids(client, "ксеноморф") == []  # the old unique term is gone from the active index
    assert search_ids(client, "аметист") == ["SEM-NEW-501"]

    (workspace / "moved").mkdir()
    shutil.move(workspace / "SEM-NEW-501.md", workspace / "moved" / "SEM-NEW-501.md")
    renamed = sync(client)
    assert last(renamed)["renamed"] == ["SEM-NEW-501"] and last(renamed)["added"] == []
    assert search_ids(client, "аметист") == ["SEM-NEW-501"]  # exactly one result, no duplicate
    assert client.get("/api/documents/SEM-NEW-501").json()["path"] == "moved/SEM-NEW-501.md"

    (workspace / "moved" / "SEM-NEW-501.md").unlink()
    deleted = sync(client)
    assert last(deleted)["deleted"] == ["SEM-NEW-501"]
    assert search_ids(client, "аметист") == []
    assert client.get("/api/documents/SEM-NEW-501").status_code == 404


def test_invalid_and_duplicate_files_are_rejected_without_a_mixed_state(
    workspace: Path, client: TestClient
) -> None:
    sync(client)
    write_doc(workspace, "broken.md", "---\nid: SEM-BAD-1\ntitle: [unclosed\n---\n\n# x\n")
    write_doc(workspace, "dup-a.md", make_doc("SEM-DUP-1", title="Первый"))
    write_doc(workspace, "dup-b.md", make_doc("SEM-DUP-1", title="Второй"))
    status = sync(client)
    rejected = {r["path"]: r["code"] for r in last(status)["rejected"]}  # type: ignore[union-attr]
    assert rejected["broken.md"] == "frontmatter_invalid_yaml"
    assert rejected["dup-a.md"] == rejected["dup-b.md"] == "duplicate_id"
    assert client.get("/api/documents/SEM-DUP-1").status_code == 422  # never guessed
    assert client.get("/api/documents/SEM-ARCH-001").status_code == 200  # the valid subset is served
    assert "SEM-ARCH-001" in search_ids(client, "architecture")


def test_full_rebuild_equals_incremental(workspace: Path, client: TestClient) -> None:
    incremental = sync(client)
    rebuilt = sync(client, rebuild=True)
    assert last(rebuilt)["full_rebuild"] is True
    assert last(rebuilt)["checksum"] == last(incremental)["checksum"]
    assert rebuilt["indexed_documents"] == incremental["indexed_documents"]


def test_failed_sync_rolls_back_to_the_previous_generation(workspace: Path, tmp_path: Path) -> None:
    """A failure in the middle of applying a snapshot leaves the previous generation fully active."""
    from app.adapters.knowledge.local import LocalKnowledgeRepository
    from app.domain.text import analyze_query

    repo = LocalKnowledgeRepository(workspace, max_document_bytes=512 * 1024)
    index = SqliteFtsSearchProvider(tmp_path / "index.sqlite3")
    first = index.sync(repo._refresh_sync(True))
    before = dict(index.indexed_revisions())
    write_doc(
        workspace,
        "SEM-NEW-777.md",
        make_doc("SEM-NEW-777", body="# Т\n\nСлово гиперион есть только здесь.\n"),
    )
    write_doc(
        workspace, "SEM-ARCH-001.md", make_doc("SEM-ARCH-001", body="# A\n\nИзменённый текст архитектуры.\n")
    )
    snapshot = repo._refresh_sync(True)
    original = SqliteFtsSearchProvider._insert
    calls = {"n": 0}

    def flaky(self: SqliteFtsSearchProvider, doc: object) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full (simulated)")
        original(self, doc)  # type: ignore[arg-type]

    SqliteFtsSearchProvider._insert = flaky  # type: ignore[method-assign]
    try:
        with pytest.raises(RuntimeError):
            index.sync(snapshot)
    finally:
        SqliteFtsSearchProvider._insert = original  # type: ignore[method-assign]
    assert index.generation == first.generation  # nothing half-applied
    assert index.indexed_revisions() == before
    assert index.search_documents(analyze_query("гиперион"), SearchFilters(), 5) == []
    retried = index.sync(snapshot)
    assert retried.generation == first.generation + 1 and retried.added == ["SEM-NEW-777"]
    assert [h.document_id for h in index.search_documents(analyze_query("гиперион"), SearchFilters(), 5)] == [
        "SEM-NEW-777"
    ]
    index.close()


# --- graph ------------------------------------------------------------------------------------------


@pytest.fixture
def graph_client(full_workspace: Path, client_factory: Callable[..., TestClient]) -> TestClient:
    return client_factory(local_knowledge_dir=full_workspace)


def test_overview_is_capped_and_typed(graph_client: TestClient) -> None:
    assert graph_client.get("/api/graph/overview", params={"limit": 99_999_999}).status_code == 422  # no dump
    data = graph_client.get("/api/graph/overview", params={"limit": 100_000}).json()  # clamped to 200
    assert len(data["nodes"]) <= data["limits"]["overview_max"] == 200
    assert data["total_nodes"] >= 83
    ids = {n["id"] for n in data["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in data["edges"])
    assert {e["origin"] for e in data["edges"]} <= {"canonical_metadata", "verified_registry"}
    small = graph_client.get("/api/graph/overview", params={"limit": 10}).json()
    assert len(small["nodes"]) == 10 and small["partial"] is True
    kinds = {n["kind"] for n in data["nodes"]}
    assert {"source_system", "integration", "dataset", "semantic_entity", "template"} <= kinds


def test_local_graph_shows_provenance_of_every_edge(graph_client: TestClient) -> None:
    data = graph_client.get("/api/graph/nodes/doc:DEMO-INT-002/neighbors", params={"depth": 1}).json()
    neighbours = {n["document_id"] for n in data["nodes"]}
    assert {"DEMO-INT-001", "DEMO-SEM-002"} <= neighbours
    maps_to = [e for e in data["edges"] if e["type"] == "maps_to" and e["source"] == "doc:DEMO-INT-002"]
    assert maps_to and maps_to[0]["declared_in"] == "DEMO-INT-002"
    assert maps_to[0]["field"] == "relations.maps_to" and maps_to[0]["path"].endswith("DEMO-INT-002.md")
    deeper = graph_client.get("/api/graph/nodes/doc:DEMO-INT-002/neighbors", params={"depth": 99}).json()
    assert deeper["limits"]["depth_max"] == 2 and deeper["total_nodes"] > data["total_nodes"]
    assert graph_client.get("/api/graph/nodes/doc:NOPE-1/neighbors").status_code == 404


def test_required_chain_is_a_path(graph_client: TestClient) -> None:
    data = graph_client.get(
        "/api/graph/path", params={"source": "doc:DEMO-SRC-002", "target": "doc:DEMO-SEM-002"}
    ).json()
    assert data["found"] and data["nodes"][0]["document_id"] == "DEMO-SRC-002"
    assert data["nodes"][-1]["document_id"] == "DEMO-SEM-002" and len(data["nodes"]) <= 4


@pytest.mark.parametrize(
    "source,target,status,code",
    [
        ("doc:NOPE-1", "doc:DEMO-SEM-002", 404, "graph_node_not_found"),  # unknown (= not visible) source
        ("doc:DEMO-SRC-002", "doc:NOPE-1", 404, "graph_node_not_found"),  # unknown target
        ("DEMO-SRC-002", "doc:DEMO-SEM-002", 422, "invalid_request"),  # no «kind:» prefix
        ("doc:DEMO SRC", "doc:DEMO-SEM-002", 422, "invalid_request"),
    ],
)
def test_a_path_between_unknown_or_malformed_nodes_is_an_error_not_no_path(
    graph_client: TestClient, source: str, target: str, status: int, code: str
) -> None:
    """Audit SYS-001: «no such node» must not look like «no path» (200 found:false), the same answers as /neighbors."""
    response = graph_client.get("/api/graph/path", params={"source": source, "target": target})
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def test_a_path_from_a_known_node_to_itself(graph_client: TestClient) -> None:
    same = graph_client.get(
        "/api/graph/path", params={"source": "doc:DEMO-SRC-002", "target": "doc:DEMO-SRC-002"}
    )
    assert same.status_code == 200 and same.json()["found"] is True and len(same.json()["nodes"]) == 1


def test_graph_follows_sync_and_reports_dangling_links(
    full_workspace: Path, client_factory: Callable[..., TestClient]
) -> None:
    client = client_factory(local_knowledge_dir=full_workspace)
    assert client.get("/api/graph/diagnostics").json()["dangling"] == []
    path = full_workspace / "integrations" / "DEMO-INT-002.md"
    text = path.read_text(encoding="utf-8")
    assert "maps_to: [DEMO-SEM-002]" in text
    path.write_text(text.replace("maps_to: [DEMO-SEM-002]", "maps_to: [DEMO-SEM-003]"), encoding="utf-8")
    client.post("/api/index/sync")
    edges = client.get("/api/graph/nodes/doc:DEMO-INT-002/neighbors").json()["edges"]
    maps_to = {e["target"] for e in edges if e["type"] == "maps_to" and e["source"] == "doc:DEMO-INT-002"}
    assert maps_to == {"doc:DEMO-SEM-003"}  # old edge gone, new edge present, no duplicate
    (full_workspace / "semantics" / "DEMO-SEM-003.md").unlink()
    client.post("/api/index/sync")
    diagnostics = client.get("/api/graph/diagnostics").json()
    assert any(d["target"] == "doc:DEMO-SEM-003" for d in diagnostics["dangling"])
    overview = client.get("/api/graph/overview", params={"limit": 200}).json()
    assert "doc:DEMO-SEM-003" not in {n["id"] for n in overview["nodes"]}
    assert all("DEMO-SEM-003" not in e["target"] for e in overview["edges"])
