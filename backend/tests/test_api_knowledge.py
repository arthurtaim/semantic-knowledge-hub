"""Documents, search, facets and integration status over HTTP (AC-01..AC-04, AC-11, AC-12, AC-16)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_doc, write_doc


def test_document_list_contains_fixtures(client: TestClient) -> None:
    body = client.get("/api/documents", params={"size": 100}).json()
    ids = {item["id"] for item in body["items"]}
    assert {"SEM-ARCH-001", "SEM-INT-ARIS-001", "SEM-PROC-001"} <= ids
    assert body["total"] == len(ids)
    assert all(item["is_demo"] for item in body["items"])
    assert all(
        item["source"] == "local" and item["source_uri"].startswith("local://") for item in body["items"]
    )


def test_filters(client: TestClient) -> None:
    drafts = client.get("/api/documents", params={"status": "draft"}).json()["items"]
    assert [d["id"] for d in drafts] == ["SEM-INT-ARIS-001"]
    several = client.get("/api/documents", params={"status": "draft,deprecated"}).json()["items"]
    assert {d["status"] for d in several} == {"draft", "deprecated"}
    integration = client.get("/api/documents", params={"type": "integration", "tag": "aris"}).json()
    assert integration["total"] == 1
    assert client.get("/api/documents", params={"owner": "nobody"}).json()["total"] == 0


def test_invalid_filter_value(client: TestClient) -> None:
    response = client.get("/api/documents", params={"status": "published"})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_filter"


def test_pagination(client: TestClient) -> None:
    first = client.get("/api/documents", params={"size": 2, "page": 1}).json()
    second = client.get("/api/documents", params={"size": 2, "page": 2}).json()
    assert len(first["items"]) == 2
    assert {i["id"] for i in first["items"]}.isdisjoint({i["id"] for i in second["items"]})


def test_review_and_owner_signals(client: TestClient) -> None:
    items = {i["id"]: i for i in client.get("/api/documents", params={"size": 100}).json()["items"]}
    assert items["SEM-STD-001"]["review_state"] == "stale"
    assert items["SEM-PROC-OLD-001"]["owner_missing"] is True
    assert items["SEM-ARCH-001"]["review_state"] == "ok"


def test_document_detail(client: TestClient) -> None:
    response = client.get("/api/documents/SEM-INT-ARIS-001")
    assert response.status_code == 200
    doc = response.json()
    assert doc["title"] == "ARIS integration — questions for discovery"
    assert doc["status"] == "draft"
    assert doc["owner"] == "demo-team"
    assert doc["type"] == "integration"
    assert "aris" in doc["tags"]
    assert doc["revision"].startswith("sha256:")
    assert doc["related"] == [
        {
            "id": "SEM-ARCH-001",
            "title": "Semantic Layer — demonstration architecture",
            "status": "approved",
            "resolved": True,
        }
    ]
    assert '<h1 id="aris-integration-questions-for-discovery">' in doc["content_html"]
    assert doc["raw"].startswith("---\nid: SEM-INT-ARIS-001")


def test_document_lookup_is_case_insensitive(client: TestClient) -> None:
    assert client.get("/api/documents/sem-arch-001").json()["id"] == "SEM-ARCH-001"


@pytest.mark.parametrize(
    "path",
    [
        "/api/documents/..%2F..%2Fetc%2Fpasswd",
        "/api/documents/%2E%2E",
        "/api/documents/a..b",
        "/api/documents/..",
        "/api/documents/SEM-ARCH-001%00",
    ],
)
def test_path_traversal_attempts(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert response.status_code in (400, 404)
    assert "root:" not in response.text


def test_duplicate_id_is_validation_error(client: TestClient, workspace: Path) -> None:
    write_doc(workspace, "copy.md", (workspace / "SEM-ARCH-001.md").read_text(encoding="utf-8"))
    response = client.get("/api/documents/SEM-ARCH-001")
    assert response.status_code == 422
    assert response.json()["code"] == "duplicate_document_id"
    ids = [i["id"] for i in client.get("/api/documents", params={"size": 100}).json()["items"]]
    assert "SEM-ARCH-001" not in ids
    issues = client.get("/api/knowledge/issues").json()
    assert {i["code"] for i in issues} == {"duplicate_id"}


def test_xss_document_is_sanitized(client: TestClient, workspace: Path) -> None:
    write_doc(
        workspace,
        "xss.md",
        make_doc(
            "XSS-001",
            title="<script>alert('t')</script>",
            body="# XSS\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n",
        ),
    )
    doc = client.get("/api/documents/XSS-001").json()
    assert "<script" not in doc["content_html"].lower()
    assert "<img" not in doc["content_html"].lower()
    assert 'href="javascript:' not in doc["content_html"].lower()  # only inert text may remain
    assert any(w["code"] == "unsafe_markup" for w in doc["warnings"])


def test_facets(client: TestClient) -> None:
    facets = client.get("/api/knowledge/facets").json()
    statuses = {f["value"]: f["count"] for f in facets["statuses"]}
    assert statuses["draft"] == 1
    assert facets["total"] >= 9


# --- search -------------------------------------------------------------------------------------


def test_search_aris(client: TestClient) -> None:
    body = client.get("/api/search", params={"q": "ARIS"}).json()
    first = body["items"][0]
    assert first["id"] == "SEM-INT-ARIS-001"
    assert first["status"] == "draft"
    assert first["source"] == "local"
    assert first["is_demo"] is True
    assert any(s["highlight"] and s["text"].lower() == "aris" for s in first["excerpt_segments"])
    assert body["scopes"] == [
        {"scope": "team", "state": "connected", "message": "Локальный workspace с демо-документами."}
    ]


def test_search_no_matches_is_empty(client: TestClient) -> None:
    body = client.get("/api/search", params={"q": "квазизвездный радиотелескоп"}).json()
    assert body["items"] == []
    assert body["total"] == 0


def test_search_russian_morphology(client: TestClient) -> None:
    ids = [i["id"] for i in client.get("/api/search", params={"q": "согласования правок"}).json()["items"]]
    assert "SEM-PROC-OLD-001" in ids


def test_search_by_related_entity(client: TestClient) -> None:
    ids = [i["id"] for i in client.get("/api/search", params={"q": "SEM-INT-ARIS-001"}).json()["items"]]
    assert ids[0] == "SEM-INT-ARIS-001"
    assert "SEM-ARCH-001" in ids  # related_ids are indexed


@pytest.mark.parametrize("q", ['"', "ARIS OR", "NEAR(a b)", "*", "a AND (", "title:x", "-x", "^aris"])
def test_search_fts_syntax_is_never_injected(client: TestClient, q: str) -> None:
    response = client.get("/api/search", params={"q": q})
    assert response.status_code == 200


def test_search_with_status_filter(client: TestClient) -> None:
    items = client.get("/api/search", params={"q": "ARIS", "status": "approved"}).json()["items"]
    assert "SEM-INT-ARIS-001" not in [i["id"] for i in items]


def test_search_corporate_scope_disabled(client: TestClient) -> None:
    body = client.get("/api/search", params={"q": "ARIS", "source": "team,corporate"}).json()
    corporate = next(s for s in body["scopes"] if s["scope"] == "corporate")
    assert corporate["state"] == "disabled"
    assert all(i["source"] != "confluence" for i in body["items"])
    assert body["warnings"]


def test_list_with_query_uses_search(client: TestClient) -> None:
    body = client.get("/api/documents", params={"query": "ARIS"}).json()
    assert body["items"][0]["id"] == "SEM-INT-ARIS-001"


# --- integrations ------------------------------------------------------------------------------------


def test_integration_status_offline_defaults(client: TestClient) -> None:
    items = {i["name"]: i for i in client.get("/api/integrations/status").json()["items"]}
    assert items["local_knowledge"]["state"] == "connected"
    assert items["gitlab_knowledge"]["state"] == "disabled"
    assert items["confluence_mcp"]["state"] == "disabled"
    assert items["ai_provider"]["state"] == "mock"
    assert items["confluence_publisher"]["state"] == "disabled"
    assert items["gitlab_proposals"]["state"] == "disabled"
    assert items["task_system"]["state"] == "disabled"
    assert not any(
        i["state"] == "connected" for n, i in items.items() if n not in ("local_knowledge", "search_index")
    )


def test_tokens_never_exposed(client_factory: Callable[..., TestClient]) -> None:
    client = client_factory(gitlab_token="glpat-SHOULD-NOT-LEAK-123456789", ai_api_key="sk-SHOULD-NOT-LEAK")
    for path in ("/api/integrations/status", "/api/session", "/api/health"):
        text = client.get(path).text
        assert "SHOULD-NOT-LEAK" not in text


def test_session_reports_demo_mode(client: TestClient) -> None:
    session = client.get("/api/session").json()
    assert session["auth_mode"] == "local_demo"
    assert session["demo_content"] is True
    assert session["features"] == {
        "ai_mode": "mock",
        "ai_edit_suggestions": False,
        "corporate_search": "disabled",
        "gitlab_proposals": False,
        "confluence_publish": False,
    }
