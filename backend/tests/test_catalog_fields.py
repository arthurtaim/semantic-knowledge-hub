"""Catalog fields of `GET /api/documents` (UI v2 round 2): `link_count` — the document page's «Связи» for every
row, from the reader's snapshot in one pass — and `metadata_updated_at`, the document's own date («Обновлён»)."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.adapters.knowledge.base import KnowledgeSnapshot, SyncInfo
from app.adapters.knowledge.records import assemble_snapshot, build_record
from app.domain.models import DocumentRecord, UserContext
from app.domain.schema import parse_document
from app.services.knowledge import DocumentQuery, KnowledgeService, linked_document_counts
from tests.conftest import make_doc, write_doc

OWNER = UserContext(user_id="owner", display_name="o")
GUEST = UserContext(user_id="guest", display_name="g")


def _record(doc_id: str, body: str, extra: str = "") -> DocumentRecord:
    built = build_record(
        make_doc(doc_id, title=f"Документ {doc_id}", body=f"# {doc_id}\n\n{body}\n", extra=extra).encode(),
        path=f"{doc_id}.md",
        source="local",
        source_uri_for="local://{id}",
        revision=f"r-{doc_id}",
        updated_at=None,
        is_demo=True,
        issues=[],
    )
    assert built is not None
    return built


class _ScopedRepository:
    """Each reader gets their own snapshot (the repository is the access boundary)."""

    def __init__(self, by_user: dict[str, KnowledgeSnapshot]) -> None:
        self._by_user = by_user

    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        return self._by_user[user.user_id]

    def sync_info(self) -> SyncInfo:
        return SyncInfo(state="fresh", message="")


class _NoIndex:
    generation = 1

    def sync(self, snapshot: KnowledgeSnapshot, full: bool = False) -> None:
        return None


def _service(by_user: dict[str, KnowledgeSnapshot]) -> KnowledgeService:
    return KnowledgeService(
        _ScopedRepository(by_user),  # type: ignore[arg-type]
        _NoIndex(),  # type: ignore[arg-type]
        review_stale_days=180,
    )


def _counts(service: KnowledgeService, user: UserContext) -> dict[str, int | None]:
    page = asyncio.run(service.list_documents(user, DocumentQuery(size=100)))
    return {item.id: item.link_count for item in page.items}


def test_link_count_matches_the_document_page_for_every_document(
    client_factory: Callable[..., TestClient], full_workspace: Path
) -> None:
    client = client_factory(local_knowledge_dir=full_workspace)
    items: list[dict[str, Any]] = []
    for page in (1, 2):
        items += client.get("/api/documents", params={"size": 100, "page": page}).json()["items"]
    assert len(items) == 83
    linked = 0
    for item in items:
        links = client.get(f"/api/documents/{item['id']}/links").json()
        # The document page counts «Связи» as outgoing targets ∪ backlink sources (frontend linkedDocumentCount).
        expected = {o["target"]["document_id"] for o in links["outgoing"]} | {
            b["source"]["document_id"] for b in links["backlinks"]
        }
        assert item["link_count"] == len(expected), item["id"]
        linked += bool(expected)
    assert linked > 40  # the synthetic base is linked: the check is not vacuous


def test_link_count_is_scoped_to_the_readers_snapshot() -> None:
    public = _record("PUB-A-001", "Ссылка на [[SEC-B-001|скрытый]] и на [[PUB-C-001]].")
    secret = _record("SEC-B-001", "Ссылка на [[PUB-A-001]].")
    other = _record(
        "PUB-C-001", "Ни одной ссылки, зато связь из метаданных.", extra="related_ids: [PUB-A-001]\n"
    )
    full = assemble_snapshot([public, secret, other], "v1", [])
    guest = assemble_snapshot([public, other], "v1-guest", [])
    service = _service({"owner": full, "guest": guest})
    # PUB-A links to SEC-B and PUB-C, SEC-B links back, PUB-C links back twice (inline + related_ids): two documents.
    assert _counts(service, OWNER) == {"PUB-A-001": 2, "PUB-C-001": 1, "SEC-B-001": 1}
    # The guest cannot see SEC-B: it is neither a row nor counted as a link of PUB-A.
    assert _counts(service, GUEST) == {"PUB-A-001": 1, "PUB-C-001": 1}


def test_link_counts_are_one_pass_per_snapshot_and_ignore_dangling_and_self_links() -> None:
    lone = _record("LONE-001", "Ссылка на [[MISSING-404]] и на себя: [[LONE-001]].")
    pair_a = _record("PAIR-A-001", "Ссылка на [[PAIR-B-001]].")
    pair_b = _record("PAIR-B-001", "Обратная ссылка на [[PAIR-A-001]].")
    snapshot = assemble_snapshot([lone, pair_a, pair_b], "v1", [])
    assert linked_document_counts(snapshot) == {"lone-001": 0, "pair-a-001": 1, "pair-b-001": 1}
    service = _service({"owner": snapshot})
    assert service.link_counts(snapshot) is service.link_counts(snapshot)  # cached for this snapshot object
    newer = assemble_snapshot([lone, pair_a], "v2", [])
    assert service.link_counts(newer) == {"lone-001": 0, "pair-a-001": 0}  # a new snapshot is counted again


def test_link_count_is_listed_with_a_query_too_and_absent_from_detail(client: TestClient) -> None:
    found = client.get("/api/documents", params={"query": "архитектура"}).json()["items"]
    assert found and all(isinstance(item["link_count"], int) for item in found)
    detail = client.get("/api/documents/SEM-ARCH-001").json()
    assert detail["link_count"] is None  # the document page counts its own links from /links


# --- «Обновлён»: the document's own date ----------------------------------------------------------------------


def test_front_matter_updated_at_is_a_date_and_never_rejects_a_document() -> None:
    dated = parse_document(make_doc("DOC-D-001", extra="updated_at: 2026-10-05\n"))
    assert dated.is_valid and dated.metadata["updated_at"] == date(2026, 10, 5)
    assert "updated_at" not in dated.extra_metadata and not dated.warnings
    stamped = parse_document(make_doc("DOC-D-002", extra="updated_at: 2026-10-05T23:10:00Z\n"))
    assert stamped.metadata["updated_at"] == date(2026, 10, 5)
    quoted = parse_document(make_doc("DOC-D-003", extra='updated_at: "2026-09-01"\n'))
    assert quoted.metadata["updated_at"] == date(2026, 9, 1)
    broken = parse_document(make_doc("DOC-D-004", extra="updated_at: вчера\n"))
    assert broken.is_valid and broken.metadata["updated_at"] is None  # a warning, not an error
    assert [w.code for w in broken.warnings] == ["invalid_updated_at"]
    assert broken.extra_metadata["updated_at"] == "вчера"  # what the author wrote is not lost
    absent = parse_document(make_doc("DOC-D-005"))
    assert absent.metadata["updated_at"] is None and not absent.warnings


def test_catalog_date_and_sort_come_from_the_document_not_the_file_time(
    client: TestClient, workspace: Path
) -> None:
    def doc(doc_id: str, title: str, extra: str = "") -> Path:
        return write_doc(
            workspace, f"{doc_id}.md", make_doc(doc_id, title=title, tags="[dated]", extra=extra)
        )

    doc("DATED-001", "Весенний регламент", "updated_at: 2026-03-01\n")
    doc("DATED-002", "Осенний регламент", "updated_at: 2026-10-05\n")
    doc("DATED-003", "Битая дата", "updated_at: когда-то\n")
    undated = doc("DATED-004", "Без даты")
    # The undated file was written last (and its mtime is the newest): that must not make it «new».
    later = time.time() + 3600
    os.utime(undated, (later, later))

    items = client.get("/api/documents", params={"tag": "dated", "sort": "updated"}).json()["items"]
    # Newest own date first; the undated ones last, by title («Без даты» before «Битая дата»).
    assert [i["id"] for i in items] == ["DATED-002", "DATED-001", "DATED-004", "DATED-003"]
    by_id = {i["id"]: i for i in items}
    assert by_id["DATED-002"]["metadata_updated_at"] == "2026-10-05"
    assert by_id["DATED-001"]["metadata_updated_at"] == "2026-03-01"
    assert (
        by_id["DATED-003"]["metadata_updated_at"] is None
        and by_id["DATED-004"]["metadata_updated_at"] is None
    )
    assert all(i["updated_at"] for i in items)  # the revision time is still reported, under its own name

    detail = client.get("/api/documents/DATED-003").json()
    assert detail["metadata_updated_at"] is None and detail["extra_metadata"]["updated_at"] == "когда-то"
    assert "invalid_updated_at" in [w["code"] for w in detail["warnings"]]
    assert client.get("/api/documents/DATED-002").json()["metadata_updated_at"] == "2026-10-05"
