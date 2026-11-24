"""Knowledge-provider rules that do not need GitLab: incremental index, sorting, revisions of the local
store, proposal validation (paths, size, front matter) and migration of earlier proposal stores."""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.knowledge.base import KnowledgeSnapshot, RevisionNotAvailableError
from app.adapters.knowledge.local import LocalKnowledgeRepository
from app.adapters.knowledge.records import build_record
from app.adapters.search.sqlite_fts import SqliteFtsSearchProvider
from app.config import security_violations
from app.domain.models import DocumentRecord, UserContext
from app.domain.text import analyze_query
from app.services.proposals import ProposalStore, repository_path_problem, validate_proposal
from tests.conftest import make_doc, write_doc

USER = UserContext(user_id="u", display_name="u")


def record(doc_id: str, body: str, revision: str) -> DocumentRecord:
    built = build_record(
        make_doc(doc_id, body=f"# Раздел\n\n{body}\n").encode(),
        path=f"docs/{doc_id}.md",
        source="gitlab",
        source_uri_for="gitlab://x/{id}",
        revision=revision,
        updated_at=None,
        is_demo=False,
        issues=[],
    )
    assert built is not None
    return built


def snapshot(version: str, *records: DocumentRecord) -> KnowledgeSnapshot:
    return KnowledgeSnapshot(version=version, documents={r.id.lower(): r for r in records})


def test_search_index_is_incremental_and_tracks_revisions(tmp_path: Path) -> None:
    index = SqliteFtsSearchProvider(tmp_path / "index.sqlite3")
    a1, b1 = record("DOC-A", "альфа первая версия", "a" * 40), record("DOC-B", "бета удаляемый", "b" * 40)
    index.sync(snapshot("v1", a1, b1))
    assert index.indexed_revisions() == {"DOC-A": "a" * 40, "DOC-B": "b" * 40}
    a2, c1 = record("DOC-A", "альфа вторая версия", "c" * 40), record("DOC-C", "гамма новый", "d" * 40)
    index.sync(snapshot("v2", a2, c1))
    assert index.indexed_revisions() == {"DOC-A": "c" * 40, "DOC-C": "d" * 40}

    def ids(query: str) -> list[str]:
        return [h.document_id for h in index.search_documents(analyze_query(query), _no_filters(), 10)]

    assert ids("удаляемый") == []  # removed from the source → removed from the index
    assert ids("первая") == [] and ids("вторая") == ["DOC-A"]  # old revision no longer searchable
    with sqlite3.connect(tmp_path / "index.sqlite3") as conn:  # exactly one entry per document
        assert conn.execute("SELECT count(*) FROM docs WHERE doc_id = 'DOC-A'").fetchone()[0] == 1
    version, count, indexed_at = index.index_info()
    assert version == "v2" and count == 2 and indexed_at is not None
    # a restart keeps the index and only re-indexes what changed
    reopened = SqliteFtsSearchProvider(tmp_path / "index.sqlite3")
    reopened.sync(snapshot("v2", a2, c1))
    assert reopened.indexed_revisions() == {"DOC-A": "c" * 40, "DOC-C": "d" * 40}


def _no_filters() -> Any:
    from app.adapters.search.base import SearchFilters

    return SearchFilters()


@pytest.mark.parametrize(
    ("sort", "check"),
    [
        (
            "title",
            lambda items: [i["title"].lower() for i in items] == sorted(i["title"].lower() for i in items),
        ),
        (
            "status",
            lambda items: (
                [i["status"] for i in items]
                == sorted(
                    (i["status"] for i in items), key=["approved", "in_review", "draft", "deprecated"].index
                )
            ),
        ),
        (
            # The document's own front-matter date (the catalog's «Обновлён»), not the file/index time: newest
            # first, documents without a date last in title order (tests/test_catalog_fields.py covers the rules).
            "updated",
            lambda items: (
                any(i["metadata_updated_at"] for i in items)
                and [i["metadata_updated_at"] for i in items if i["metadata_updated_at"]]
                == sorted((i["metadata_updated_at"] for i in items if i["metadata_updated_at"]), reverse=True)
                and all(
                    i["metadata_updated_at"] is None
                    for i in items[[bool(i["metadata_updated_at"]) for i in items].count(True) :]
                )
                and [i["title"].lower() for i in items if not i["metadata_updated_at"]]
                == sorted(i["title"].lower() for i in items if not i["metadata_updated_at"])
            ),
        ),
    ],
)
def test_catalog_sorting(
    client: TestClient, sort: str, check: Callable[[list[dict[str, Any]]], bool]
) -> None:
    items = client.get("/api/documents", params={"sort": sort, "size": 100}).json()["items"]
    assert len(items) == 9 and check(items)


def test_catalog_rejects_unknown_sort(client: TestClient) -> None:
    assert client.get("/api/documents", params={"sort": "random"}).status_code == 422


def test_local_store_reports_revisions_honestly(workspace: Path) -> None:
    repo = LocalKnowledgeRepository(workspace, max_document_bytes=512 * 1024, refresh_seconds=0)
    doc = asyncio.run(repo.get_document("SEM-ARCH-001", USER))
    assert asyncio.run(repo.get_document_at_revision("SEM-ARCH-001", doc.revision, USER)) == doc
    with pytest.raises(RevisionNotAvailableError):
        asyncio.run(repo.get_document_at_revision("SEM-ARCH-001", "sha256:0000", USER))
    assert asyncio.run(repo.exists("SEM-ARCH-001", USER)) and not asyncio.run(repo.exists("NOPE-1", USER))
    (workspace / doc.path).write_text(doc.raw + "\nправка\n", encoding="utf-8")
    assert asyncio.run(repo.current_revision("SEM-ARCH-001", USER)) != doc.revision  # bypasses the cache
    assert repo.sync_info().state == "fresh"


def test_local_index_status_endpoint(client: TestClient) -> None:
    status = client.get("/api/index/status").json()
    assert status["source"] == "local" and status["state"] == "fresh"
    assert status["documents"] == status["indexed_documents"] == 9
    synced = client.post("/api/index/sync").json()
    assert synced["state"] == "fresh" and synced["last_success_at"]


@pytest.mark.parametrize(
    ("path", "prefix", "ok"),
    [
        ("docs/SEM-ARCH-001.md", "docs", True),
        ("SEM-ARCH-001.md", "", True),
        ("../secrets.md", "", False),
        ("docs/../../x.md", "docs", False),
        ("/etc/passwd.md", "", False),
        ("docs\\x.md", "", False),
        ("docs/x.txt", "docs", False),
        ("other/x.md", "docs", False),
        ("docs//x.md", "docs", False),
        ("C:/x.md", "", False),
    ],
)
def test_repository_path_rules(path: str, prefix: str, ok: bool) -> None:
    assert (repository_path_problem(path, prefix) is None) is ok


def test_validation_covers_front_matter_id_size_and_path(workspace: Path) -> None:
    repo = LocalKnowledgeRepository(workspace, max_document_bytes=512 * 1024, refresh_seconds=0)
    doc = asyncio.run(repo.get_document("SEM-ARCH-001", USER))
    codes = lambda text, **kw: {i.code for i in validate_proposal(doc, text, "manual", **kw)}  # noqa: E731
    assert "frontmatter_invalid_yaml" in codes("---\nid: [x\n---\n")
    assert "id_changed" in codes(doc.raw.replace("id: SEM-ARCH-001", "id: SEM-OTHER-001"))
    assert "document_too_large" in codes(doc.raw + "x" * 5000, max_bytes=1024)
    assert "no_changes" in codes(doc.raw)
    assert "unsafe_path" in codes(doc.raw + "\nok\n", knowledge_prefix="elsewhere")
    missing_owner = "\n".join(line for line in doc.raw.splitlines() if not line.startswith("owner:"))
    assert "missing_field" in codes(missing_owner)


def test_earlier_proposal_stores_are_migrated(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """CREATE TABLE proposals (
                id TEXT PRIMARY KEY, document_id TEXT NOT NULL, document_title TEXT NOT NULL,
                document_path TEXT NOT NULL, source TEXT NOT NULL, base_revision TEXT NOT NULL,
                base_content TEXT NOT NULL, proposed_content TEXT NOT NULL, reason TEXT NOT NULL,
                origin TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL,
                validation_json TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
                review_comment TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
        )
        for pid, status in (("a" * 32, "open"), ("b" * 32, "submitted")):
            conn.execute(
                "INSERT INTO proposals VALUES (?, 'D-1', 't', 'd.md', 'local', 'r', 'x', 'y', 'why', 'manual', "
                "'u', ?, '[]', 1, 1, NULL, '2026-11-01T00:00:00+00:00', '2026-11-01T00:00:00+00:00')",
                (pid, status),
            )
    store = ProposalStore(path)
    assert store.get("a" * 32)["status"] == "draft"  # type: ignore[index]
    assert store.get("b" * 32)["status"] == "submitted_to_gitlab"  # type: ignore[index]
    assert store.get("a" * 32)["submit_attempts"] == 0  # type: ignore[index]
    store.close()


@pytest.mark.parametrize(
    ("overrides", "fragment"),
    [
        (
            {
                "confluence_connector": "mcp",
                "confluence_mcp_url": "http://mcp.corp.example/mcp",
                "confluence_mcp_allow_insecure_http": True,
            },
            "loopback",
        ),
        ({"app_public_url": "http://kb.corp.example"}, "APP_PUBLIC_URL"),
        (
            {
                "ai_provider": "internal_api",
                "ai_base_url": "http://llm.corp.example/v1",
                "ai_allow_insecure_http": True,
                "ai_allowed_hosts": "llm.corp.example",
                "ai_model": "m",
            },
            "AI_BASE_URL с http",
        ),
        (
            {
                "knowledge_backend": "gitlab",
                "gitlab_url": "http://gitlab.corp.example",
                "gitlab_allow_insecure_http": True,
                "gitlab_project_id": "1",
            },
            "GITLAB_URL с http",
        ),
        ({"app_public_url": "ftp://127.0.0.1"}, "APP_PUBLIC_URL"),
    ],
)
def test_plain_http_and_public_urls_are_restricted(
    settings_factory: Callable[..., Any], overrides: dict[str, Any], fragment: str
) -> None:
    problems = security_violations(settings_factory(**overrides), in_container=False)
    assert any(fragment in p for p in problems), problems


def test_plain_http_is_only_for_loopback_test_doubles() -> None:
    from pydantic import SecretStr

    from app.adapters.ai.openai_compatible import validate_endpoint
    from app.adapters.gitlab.client import validate_gitlab_config

    token = SecretStr("t")
    assert "loopback" in (validate_gitlab_config("http://gitlab.corp.example", "1", token, True) or "")
    assert validate_gitlab_config("http://127.0.0.1:8929", "1", token, True) is None
    assert validate_gitlab_config("http://127.0.0.1:8929", "1", token, False) is not None
    assert "loopback" in (validate_endpoint("http://llm.corp.example/v1", ["llm.corp.example"], True) or "")


def test_unreadable_document_in_workspace_is_reported(
    workspace: Path, client_factory: Callable[..., TestClient]
) -> None:
    write_doc(workspace, "BROKEN.md", "---\nid: BROKEN-1\n---\nno title\n")
    client = client_factory()
    issues = client.get("/api/knowledge/issues").json()
    assert any(i["path"] == "BROKEN.md" for i in issues)


def test_openapi_contract_lists_documented_endpoints(client: TestClient) -> None:
    schema = client.get("/api/openapi.json").json()
    paths = schema["paths"]
    for path, method in [
        ("/api/health", "get"),
        ("/api/documents", "get"),
        ("/api/documents/{document_id}", "get"),
        ("/api/search", "get"),
        ("/api/assistant/ask", "post"),
        ("/api/assistant/ask/stream", "post"),
        ("/api/integrations/status", "get"),
        ("/api/index/status", "get"),
        ("/api/index/sync", "post"),
        ("/api/drafts", "post"),
        ("/api/drafts/{draft_id}/mark-ready", "post"),
        ("/api/drafts/{draft_id}/submit", "post"),
        ("/api/drafts/{draft_id}/refresh-status", "post"),
        ("/api/drafts/{draft_id}/reject", "post"),
        ("/api/drafts/{draft_id}", "put"),
        ("/api/drafts/{draft_id}", "delete"),
        ("/api/authoring/templates", "get"),
        ("/api/authoring/check", "post"),
        ("/api/authoring/ai-draft", "post"),
        ("/api/authoring/drafts", "post"),
        ("/api/documents/{document_id}/publication", "get"),
        ("/api/documents/{document_id}/publication/prepare", "post"),
        ("/api/publications/jobs", "get"),
        ("/api/publications/jobs/{job_id}", "get"),
        ("/api/publications/jobs/{job_id}/dry-run", "post"),
        ("/api/publications/jobs/{job_id}/publish", "post"),
        ("/api/publications/jobs/{job_id}/reconcile", "post"),
        ("/api/publications/jobs/{job_id}/acknowledge-manual-edit", "post"),
        ("/api/publications/jobs/{job_id}/release-missing-page", "post"),
        ("/api/assistant/skills", "get"),
        ("/api/assistant/attachments", "post"),
        ("/api/assistant/attachments/{attachment_id}", "delete"),
    ]:
        assert method in paths.get(path, {}), (path, method)
    assert paths["/api/drafts/{draft_id}/open-mr"]["post"].get("deprecated") is True
    statuses = schema["components"]["schemas"]["ProposalStatus"]["enum"]
    assert statuses == [
        "draft",
        "ready_for_review",
        "submitting",
        "submitted_to_gitlab",
        "merged",
        "rejected",
        "conflict",
        "submission_failed",
    ]
    sort = next(p for p in paths["/api/documents"]["get"]["parameters"] if p["name"] == "sort")
    assert "updated" in str(sort["schema"])
