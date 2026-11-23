"""M5.6.3 — WikiLinks: parsing, `references` edges in the same generation, backlinks, diagnostics, ACL."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.knowledge.records import assemble_snapshot, build_record
from app.domain.markdown import render_html
from app.domain.models import UserContext
from app.domain.wikilinks import extract_wikilinks
from app.services.links import LinkService
from tests.conftest import make_doc, write_doc


def test_parser_skips_code_escapes_and_keeps_line_numbers() -> None:
    body = (
        "Первая строка [[DEMO-A-001|Подпись]] и [[DEMO-B-002]].\n\n"
        "```\n[[DEMO-C-003]] в блоке кода\n```\n\n"
        "Инлайн `[[DEMO-D-004]]`, экранировано \\[[DEMO-E-005]], заголовок [[Семантическая модель]].\n\n"
        "| a | b |\n|---|---|\n| [[DEMO-F-006\\|в таблице]] | x |\n"
    )
    links = extract_wikilinks(body)
    assert [(w.target, w.label, w.line) for w in links] == [
        ("DEMO-A-001", "Подпись", 1),
        ("DEMO-B-002", "", 1),
        ("Семантическая модель", "", 7),
        ("DEMO-F-006", "в таблице", 11),
    ]
    assert [w.id_like for w in links] == [True, True, False, True]


def test_rendering_escapes_labels_and_hides_unresolvable_targets() -> None:
    body = "См. [[DEMO-A-001|<img src=x onerror=alert(1)>]] и [[DEMO-HIDDEN-9|Секретный]]."
    html = render_html(body, lambda t: ("DEMO-A-001", "Открытый") if t == "DEMO-A-001" else None)
    assert '<a href="/documents/DEMO-A-001" class="wikilink"' in html and "<img" not in html
    assert "&lt;img src=x onerror=alert(1)&gt;" in html
    assert '<span class="wikilink wikilink--unresolved"' in html and "DEMO-HIDDEN-9" not in html


def _doc(root: Path, name: str, doc_id: str, body: str, **kw: Any) -> None:
    title = kw.pop("title", doc_id)
    write_doc(
        root,
        name,
        make_doc(
            doc_id, title=title, body=f"# {title}\n\n{body}\n\nТекст документа для проверки ссылок.\n", **kw
        ),
    )


def test_wikilink_edges_backlinks_and_provenance(client: TestClient, workspace: Path) -> None:
    _doc(
        workspace,
        "a.md",
        "TST-A-001",
        "Опирается на [[TST-B-001|модель Б]].\nЕщё раз [[TST-B-001]].",
        extra="related_ids: [TST-B-001]\n",
        title="Документ А",
    )
    _doc(workspace, "b.md", "TST-B-001", "Модель Б.", title="Модель Б")
    _doc(workspace, "c.md", "TST-C-001", "```\n[[TST-B-001]]\n```\nТолько код.", title="Документ В")
    sync = client.post("/api/index/sync").json()["last_sync"]
    assert set(sync["added"]) >= {"TST-A-001", "TST-B-001", "TST-C-001"}
    edges = client.get("/api/graph/nodes/doc:TST-A-001/neighbors").json()["edges"]
    refs = [e for e in edges if e["source"] == "doc:TST-A-001" and e["target"] == "doc:TST-B-001"]
    assert len(refs) == 1 and refs[0]["type"] == "references"  # related_ids + inline: shown once
    assert refs[0]["provenance"] == ["related_ids", "body:3"]
    links = client.get("/api/documents/TST-B-001/links").json()
    back = {b["source"]["document_id"]: b for b in links["backlinks"]}
    assert set(back) == {"TST-A-001"}  # the code block in TST-C-001 is not a link
    assert back["TST-A-001"]["via"] == ["related_ids", "inline"] and back["TST-A-001"]["lines"] == [3]
    assert "модель Б" in back["TST-A-001"]["excerpts"][0]
    out = client.get("/api/documents/TST-A-001/links").json()["outgoing"]
    assert out[0]["target"]["document_id"] == "TST-B-001" and out[0]["labels"] == ["модель Б"]
    page = client.get("/api/documents/TST-A-001").json()["content_html"]
    assert '<a href="/documents/TST-B-001" class="wikilink" title="Модель Б"' in page


def test_removed_link_leaves_no_stale_edge_and_keeps_a_typed_relation(
    client: TestClient, workspace: Path
) -> None:
    _doc(
        workspace, "a.md", "TST-A-001", "Ссылка [[TST-B-001]].", extra="relations:\n  maps_to: [TST-B-001]\n"
    )
    _doc(workspace, "b.md", "TST-B-001", "Модель Б.")
    client.post("/api/index/sync")
    types = {e["type"] for e in client.get("/api/graph/nodes/doc:TST-A-001/neighbors").json()["edges"]}
    assert types == {"references", "maps_to"}
    _doc(workspace, "a.md", "TST-A-001", "Ссылки больше нет.", extra="relations:\n  maps_to: [TST-B-001]\n")
    assert client.post("/api/index/sync").json()["last_sync"]["updated"] == ["TST-A-001"]
    edges = client.get("/api/graph/nodes/doc:TST-A-001/neighbors").json()["edges"]
    assert {e["type"] for e in edges} == {"maps_to"}
    back = client.get("/api/documents/TST-B-001/links").json()["backlinks"]
    assert [(b["relation"], b["via"]) for b in back] == [("maps_to", ["typed"])]


def test_rename_keeps_the_link_and_delete_reports_it(client: TestClient, workspace: Path) -> None:
    _doc(workspace, "a.md", "TST-A-001", "Ссылка [[TST-B-001|Б]].")
    _doc(workspace, "old/b.md", "TST-B-001", "Модель Б.", title="Модель Б")
    client.post("/api/index/sync")
    (workspace / "new").mkdir()
    (workspace / "old" / "b.md").rename(workspace / "new" / "b.md")
    assert client.post("/api/index/sync").json()["last_sync"]["renamed"] == ["TST-B-001"]
    nodes = client.get("/api/graph/overview").json()["nodes"]
    assert sum(1 for n in nodes if n["id"] == "doc:TST-B-001") == 1
    assert (
        client.get("/api/documents/TST-A-001/links").json()["outgoing"][0]["target"]["document_id"]
        == "TST-B-001"
    )
    (workspace / "new" / "b.md").unlink()
    client.post("/api/index/sync")
    links = client.get("/api/documents/TST-A-001/links").json()
    assert links["outgoing"] == [] and links["unresolved"][0]["reason"] == "missing"
    dangling = client.get("/api/graph/diagnostics").json()["dangling"]
    assert any(d["target"] == "doc:TST-B-001" and d["field"] == "body" for d in dangling)


def test_title_links_are_never_guessed(client: TestClient, workspace: Path) -> None:
    _doc(workspace, "a.md", "TST-A-001", "Смотри [[Модель Б]] и [[Общий термин]].")
    _doc(workspace, "b.md", "TST-B-001", "Модель.", title="Модель Б")
    _doc(workspace, "c.md", "TST-C-001", "Раз.", title="Общий термин")
    _doc(workspace, "d.md", "TST-D-001", "Два.", title="Общий термин")
    client.post("/api/index/sync")
    links = client.get("/api/documents/TST-A-001/links").json()
    assert links["outgoing"] == []
    problems = {u["raw_target"]: u for u in links["unresolved"]}
    assert problems["Модель Б"]["reason"] == "title_link"
    assert [c["document_id"] for c in problems["Модель Б"]["candidates"]] == ["TST-B-001"]
    assert problems["Общий термин"]["reason"] == "ambiguous_title"
    assert len(problems["Общий термин"]["candidates"]) == 2


def test_autocomplete_matches_ids_russian_titles_and_aliases(client: TestClient, workspace: Path) -> None:
    _doc(
        workspace,
        "b.md",
        "TST-B-001",
        "Модель.",
        title="Ёмкость хранилища",
        extra="aliases: [Storage capacity]\n",
    )
    _doc(workspace, "x.md", "TST-X-001", "Старое.", title="Ёмкость старая", status="deprecated")
    client.post("/api/index/sync")
    by_title = client.get("/api/links/suggest", params={"q": "емкость"}).json()
    assert [s["document_id"] for s in by_title] == ["TST-B-001", "TST-X-001"]  # deprecated last; ё = е
    assert by_title[0]["insert"] == "[[TST-B-001|Ёмкость хранилища]]"
    by_alias = client.get("/api/links/suggest", params={"q": "storage"}).json()
    assert by_alias[0]["matched"] == "alias" and by_alias[0]["alias"] == "Storage capacity"
    assert client.get("/api/links/suggest", params={"q": "[[tst-b-001"}).json()[0]["matched"] == "id"


class _ScopedKnowledge:
    """Stand-in for KnowledgeService: the repository decides visibility per user (as GitLab does)."""

    def __init__(self, full: KnowledgeSnapshot, guest: KnowledgeSnapshot) -> None:
        self._by_user = {"owner": full, "guest": guest}

    async def snapshot(self, user: UserContext) -> KnowledgeSnapshot:
        return self._by_user[user.user_id]

    def generation_label(self, snapshot: KnowledgeSnapshot) -> str:
        return "g1"


def _record(doc_id: str, body: str, title: str) -> Any:
    return build_record(
        make_doc(doc_id, title=title, body=body).encode(),
        path=f"{doc_id}.md",
        source="local",
        source_uri_for="local://{id}",
        revision=f"r-{doc_id}",
        updated_at=None,
        is_demo=True,
        issues=[],
    )


def test_inaccessible_documents_leak_nothing_through_links() -> None:
    public = _record("PUB-A-001", "Ссылка на [[SEC-B-001|скрытый]].", "Открытый")
    secret = _record("SEC-B-001", "Ссылка на [[PUB-A-001]].", "Секретный документ")
    full = assemble_snapshot([public, secret], "v1", [])
    guest = assemble_snapshot([public], "v1-guest", [])
    service = LinkService(_ScopedKnowledge(full, guest))  # type: ignore[arg-type]
    owner = UserContext(user_id="owner", display_name="o")
    viewer = UserContext(user_id="guest", display_name="g")
    full_view = asyncio.run(service.links(owner, "PUB-A-001"))
    assert full_view and [b.source.document_id for b in full_view.backlinks] == ["SEC-B-001"]
    guest_view = asyncio.run(service.links(viewer, "PUB-A-001"))
    assert guest_view and guest_view.backlinks == [] and guest_view.outgoing == []
    problem = guest_view.unresolved[0]
    assert problem.reason == "missing" and problem.candidates == []  # no title of the hidden document
    dump = guest_view.model_dump_json()
    assert "Секретный документ" not in dump
    assert all(s.document_id != "SEC-B-001" for s in asyncio.run(service.suggest(viewer, "sec")))
