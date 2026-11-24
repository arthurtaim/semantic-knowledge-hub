"""«Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §4): the computed group rule, `GET /api/documents/tree`
and the `summary` / `systems` fields of the catalog list.

The demo layout below is the owner-approved result of the rule on the synthetic base. «Today» is pinned: whether an
approved document's review is stale depends on the date (`review_stale_days`, 180 by default)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.knowledge.base import KnowledgeSnapshot, SyncInfo
from app.adapters.knowledge.records import assemble_snapshot, build_record
from app.domain.doc_tree import (
    COMMON_GROUP_LABEL,
    GROUP_RESOLVERS,
    SECTION_ORDER,
    GroupRef,
    SystemIndex,
    build_layout,
    build_system_index,
    document_systems,
    needs_attention,
    resolve_group,
    section_label,
    section_rank,
)
from app.domain.models import DocStatus, DocumentRecord, DocumentTree, UserContext
from app.services.knowledge import DocumentQuery, KnowledgeService
from tests.conftest import make_doc, write_doc

TODAY = date(2026, 11, 24)
OWNER = UserContext(user_id="owner", display_name="o")
GUEST = UserContext(user_id="guest", display_name="g")


def _tree_client(client_factory: Callable[..., TestClient], root: Path) -> TestClient:
    client = client_factory(local_knowledge_dir=root)
    client.app.state.container.knowledge.today = lambda: TODAY  # type: ignore[attr-defined]
    return client


@pytest.fixture
def demo_tree(client_factory: Callable[..., TestClient], full_workspace: Path) -> dict[str, Any]:
    response = _tree_client(client_factory, full_workspace).get("/api/documents/tree")
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


def _record(
    doc_id: str,
    *,
    title: str | None = None,
    doc_type: str = "process",
    status: str = "approved",
    owner: str = "test-team",
    tags: str = "[test]",
    extra: str = "",
    body: str = "Содержимое тестового документа достаточной длины.",
) -> DocumentRecord:
    built = build_record(
        make_doc(
            doc_id,
            title=json.dumps(title or f"Документ {doc_id}", ensure_ascii=False),  # «ARIS: …» needs quoting
            doc_type=doc_type,
            status=status,
            owner=owner,
            tags=tags,
            extra=extra,
            body=f"# {doc_id}\n\n{body}\n",
        ).encode(),
        path=f"{doc_id}.md",
        source="local",
        source_uri_for="local://{id}",
        revision=f"r-{doc_id}",
        updated_at=None,
        is_demo=True,
        issues=[],
    )
    assert built is not None, doc_id
    return built


class _ScopedRepository:
    """Each reader gets their own snapshot (the repository is the access boundary)."""

    source = "local"

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
    service = KnowledgeService(
        _ScopedRepository(by_user),  # type: ignore[arg-type]
        _NoIndex(),  # type: ignore[arg-type]
        review_stale_days=180,
    )
    service.today = lambda: TODAY
    return service


def _tree(service: KnowledgeService, user: UserContext) -> DocumentTree:
    return asyncio.run(service.document_tree(user))


# --- the demo layout ------------------------------------------------------------------------------------------


def test_demo_sections_follow_the_logical_order_with_their_counts(demo_tree: dict[str, Any]) -> None:
    assert demo_tree["total"] == 83
    assert [(s["key"], s["label"], s["count"]) for s in demo_tree["sections"]] == [
        ("overview", "Продукт", 1),
        ("architecture", "Архитектура", 1),
        ("domain", "Домен", 9),
        ("source", "Системы-источники", 12),
        ("integration", "Интеграции", 19),
        ("dataset", "Датасеты", 3),
        ("process", "Процессы", 7),
        ("decision", "Решения", 5),
        ("standard", "Стандарты", 19),
        ("guide", "Руководства", 5),
        ("glossary", "Глоссарий", 2),
    ]
    assert sum(s["count"] for s in demo_tree["sections"]) == 83
    assert len(demo_tree["documents"]) == 83


def test_demo_integration_groups_are_the_owner_approved_layout(demo_tree: dict[str, Any]) -> None:
    integration = next(s for s in demo_tree["sections"] if s["key"] == "integration")
    assert [(g["key"], g["label"], g["count"]) for g in integration["groups"]] == [
        ("integration/aris", "ARIS", 8),
        ("integration/catia", "CATIA", 2),
        ("integration/crm", "CRM", 1),
        ("integration/cat", "Data Catalog", 1),
        ("integration/erp", "ERP", 1),
        ("integration/_common", COMMON_GROUP_LABEL, 6),
    ]
    assert integration["doc_ids"] == []
    groups = {g["label"]: set(g["doc_ids"]) for g in integration["groups"]}
    # ARIS: the flow (consumes DEMO-SRC-002), its mapping and validation (tag `aris`), the schedule and the lineage
    # (tag `aris`), the draft v2 schedule, the deprecated nightly export and the discovery questions.
    assert groups["ARIS"] == {
        "DEMO-INT-001",
        "DEMO-INT-002",
        "DEMO-INT-003",
        "DEMO-INT-013",
        "DEMO-INT-014",
        "DEMO-INT-017",
        "DEMO-INT-018",
        "SEM-INT-ARIS-001",
    }
    assert groups["CATIA"] == {"DEMO-INT-004", "DEMO-INT-005"}
    assert groups["CRM"] == {"DEMO-INT-006"}
    assert groups["ERP"] == {"DEMO-INT-007"}
    assert groups["Data Catalog"] == {"DEMO-INT-008"}
    assert groups[COMMON_GROUP_LABEL] == {
        "DEMO-INT-009",
        "DEMO-INT-010",
        "DEMO-INT-011",
        "DEMO-INT-012",
        "DEMO-INT-015",
        "DEMO-INT-016",
    }
    assert demo_tree["documents"]["DEMO-INT-013"]["group"] == "integration/aris"


def test_demo_standards_split_into_templates_and_rules(demo_tree: dict[str, Any]) -> None:
    standard = next(s for s in demo_tree["sections"] if s["key"] == "standard")
    assert [(g["key"], g["label"], g["count"]) for g in standard["groups"]] == [
        ("standard/rules", "Регламенты и качество", 14),
        ("standard/templates", "Шаблоны документов", 5),
    ]
    templates = next(g for g in standard["groups"] if g["key"] == "standard/templates")
    assert set(templates["doc_ids"]) == {f"DEMO-PROC-{n:03d}" for n in range(6, 11)}


def test_other_sections_have_no_groups(demo_tree: dict[str, Any]) -> None:
    for section in demo_tree["sections"]:
        if section["key"] in ("integration", "standard"):
            continue
        assert section["groups"] == [], section["key"]
        assert len(section["doc_ids"]) == section["count"], section["key"]
        assert all(demo_tree["documents"][i]["group"] is None for i in section["doc_ids"])


def test_demo_attention_is_twelve_documents(demo_tree: dict[str, Any]) -> None:
    assert demo_tree["attention_total"] == 12
    flagged = {i for i, d in demo_tree["documents"].items() if d["attention"]}
    assert flagged == {
        # in review
        "DEMO-SRC-010",
        "DEMO-GOV-012",
        "DEMO-SEM-012",
        "SEM-DOM-001",
        # drafts
        "DEMO-SRC-009",
        "DEMO-INT-017",
        "SEM-INT-ARIS-001",
        # deprecated
        "DEMO-INT-018",
        "DEMO-GOV-013",
        "SEM-PROC-OLD-001",
        # approved, but the review is older than 180 days
        "DEMO-SRC-004",
        "SEM-STD-001",
    }
    by_section = {s["key"]: s["attention"] for s in demo_tree["sections"]}
    assert by_section == {
        "overview": 0,
        "architecture": 0,
        "domain": 2,
        "source": 3,
        "integration": 3,
        "dataset": 0,
        "process": 1,
        "decision": 0,
        "standard": 3,
        "guide": 0,
        "glossary": 0,
    }
    aris = next(g for s in demo_tree["sections"] for g in s["groups"] if g["key"] == "integration/aris")
    assert aris["attention"] == 3
    assert demo_tree["documents"]["DEMO-SRC-004"]["review_state"] == "stale"
    assert demo_tree["documents"]["SEM-DOM-001"]["review_state"] == "never_reviewed"
    assert demo_tree["documents"]["DEMO-SRC-010"]["owner_missing"] is True


def test_documents_need_attention_first_then_by_title(demo_tree: dict[str, Any]) -> None:
    aris = next(g for s in demo_tree["sections"] for g in s["groups"] if g["key"] == "integration/aris")
    docs = demo_tree["documents"]
    flags = [docs[i]["attention"] for i in aris["doc_ids"]]
    assert flags == sorted(flags, reverse=True)
    assert aris["doc_ids"][:3] == ["SEM-INT-ARIS-001", "DEMO-INT-018", "DEMO-INT-017"]
    titles = [docs[i]["title"].casefold() for i in aris["doc_ids"][3:]]
    assert titles == sorted(titles)


def test_tree_entry_carries_the_spec_fields(demo_tree: dict[str, Any]) -> None:
    entry = demo_tree["documents"]["DEMO-INT-001"]
    assert entry["title"] == "ARIS → Catalog: обзор потока (демо)"
    assert entry["type"] == "integration"
    assert entry["status"] == "approved"
    assert entry["review_state"] == "ok"
    assert entry["reviewed_at"] == "2026-10-16"
    assert entry["owner"] == "demo-integration-team"
    assert entry["owner_missing"] is False
    assert entry["summary"].startswith("Инкрементальный поток процессных метаданных")
    assert entry["systems"] == ["ARIS", "Data Catalog"]
    assert entry["is_demo"] is True
    assert entry["group"] == "integration/aris"
    assert entry["attention"] is False
    assert entry["source"] == "local"
    assert entry["index_state"] == "current"


def test_tree_link_count_equals_the_catalog_link_count(
    client_factory: Callable[..., TestClient], full_workspace: Path
) -> None:
    client = _tree_client(client_factory, full_workspace)
    tree = client.get("/api/documents/tree").json()["documents"]
    listed: dict[str, int] = {}
    for page in (1, 2):
        for item in client.get("/api/documents", params={"size": 100, "page": page}).json()["items"]:
            listed[item["id"]] = item["link_count"]
    assert {i: d["link_count"] for i, d in tree.items()} == listed


def test_tree_route_is_not_taken_as_a_document_id(client: TestClient) -> None:
    body = client.get("/api/documents/tree").json()
    assert set(body) == {"total", "attention_total", "sections", "documents"}
    assert client.get("/api/documents/SEM-ARCH-001").json()["id"] == "SEM-ARCH-001"


# --- empty and unknown --------------------------------------------------------------------------------------------


def test_empty_base_has_no_sections() -> None:
    tree = _tree(_service({"owner": assemble_snapshot([], "v0", [])}), OWNER)
    assert tree.total == 0 and tree.attention_total == 0
    assert tree.sections == [] and tree.documents == {}


def test_empty_sections_are_left_out(client: TestClient) -> None:
    # The core base has no dataset, guide or source documents.
    keys = [s["key"] for s in client.get("/api/documents/tree").json()["sections"]]
    assert "dataset" not in keys and "guide" not in keys
    assert keys == sorted(keys, key=section_rank)


def test_unknown_type_never_reaches_the_tree_and_unknown_sections_go_last(
    client: TestClient, workspace: Path
) -> None:
    write_doc(workspace, "odd.md", make_doc("ODD-TYPE-001", doc_type="memo"))
    tree = client.get("/api/documents/tree").json()
    assert "ODD-TYPE-001" not in tree["documents"]  # an invalid type is a load issue, not a document
    assert any(i["document_id"] == "ODD-TYPE-001" for i in client.get("/api/knowledge/issues").json())
    assert section_rank("memo") > section_rank(SECTION_ORDER[-1])
    assert section_rank("alpha") < section_rank("memo")  # several unknown ones: by key
    assert section_label("memo") == "memo"


# --- access ------------------------------------------------------------------------------------------------------


def test_a_reader_gets_neither_a_hidden_document_nor_its_counts() -> None:
    hidden_source = _record(
        "SEC-SRC-001", title="Vault: закрытая система", doc_type="source", tags="[vault, sys-vault]"
    )
    flow = _record(
        "PUB-INT-001",
        title="Поток из закрытой системы",
        doc_type="integration",
        tags="[vault, integration]",
        extra="relations:\n  consumes: [SEC-SRC-001]\n",
    )
    draft = _record("PUB-INT-002", doc_type="integration", status="draft")
    hidden_draft = _record("SEC-INT-003", doc_type="integration", status="draft")
    full = assemble_snapshot([hidden_source, flow, draft, hidden_draft], "v1", [])
    guest = assemble_snapshot([flow, draft], "v1-guest", [])
    service = _service({"owner": full, "guest": guest})

    owner_tree = _tree(service, OWNER)
    assert owner_tree.total == 4 and owner_tree.attention_total == 2
    assert owner_tree.documents["PUB-INT-001"].group == "integration/vault"
    assert owner_tree.documents["PUB-INT-001"].systems == ["Vault"]

    guest_tree = _tree(service, GUEST)
    assert set(guest_tree.documents) == {"PUB-INT-001", "PUB-INT-002"}
    assert guest_tree.total == 2 and guest_tree.attention_total == 1
    assert [(s.key, s.count, s.attention) for s in guest_tree.sections] == [("integration", 2, 1)]
    # The hidden source system names neither a group nor a system of the visible flow.
    assert guest_tree.documents["PUB-INT-001"].group == "integration/_common"
    assert guest_tree.documents["PUB-INT-001"].systems == []
    assert all("SEC-" not in i for s in guest_tree.sections for g in s.groups for i in g.doc_ids)
    assert guest_tree.documents["PUB-INT-001"].link_count == 0  # its link to the hidden source does not count


def test_tree_uses_the_same_snapshot_as_the_catalog(client_factory: Callable[..., TestClient]) -> None:
    client = client_factory()
    tree = client.get("/api/documents/tree").json()
    listed = client.get("/api/documents", params={"size": 100}).json()
    assert set(tree["documents"]) == {i["id"] for i in listed["items"]}
    assert tree["total"] == listed["total"]


# --- the rule, unit by unit ---------------------------------------------------------------------------------------


def _index(*docs: DocumentRecord) -> SystemIndex:
    return build_system_index(docs)


def test_source_systems_take_the_title_before_the_colon_and_the_sys_tag() -> None:
    aris = _record("S-1", title="ARIS: модель", doc_type="source", tags="[aris, sys-aris]")
    keyless = _record("S-2", title="Legacy DWH: без ключа", doc_type="source", tags="[dwh]")
    overview = _record("S-3", title="Обзор ландшафта", doc_type="source", tags="[sys-landscape]")
    not_a_source = _record("P-1", title="CRM: не профиль", doc_type="process", tags="[sys-crm]")
    index = _index(aris, keyless, overview, not_a_source)
    assert {k: (s.name, s.key) for k, s in index.by_document.items()} == {
        "s-1": ("ARIS", "aris"),
        "s-2": ("Legacy DWH", None),
    }
    assert set(index.by_key) == {"aris"}
    assert index.for_tag("ARIS") is index.for_tag("sys-aris") is index.by_key["aris"]
    assert index.for_tag("sys-") is None


def test_integration_group_prefers_the_first_consumed_source_then_a_tag_then_common() -> None:
    aris = _record("S-1", title="ARIS: модель", doc_type="source", tags="[sys-aris]")
    crm = _record("S-2", title="CRM: карточки", doc_type="source", tags="[sys-crm]")
    dataset = _record("D-1", doc_type="dataset")
    by_consumes = _record(
        "I-1",
        doc_type="integration",
        tags="[crm]",
        extra="relations:\n  consumes: [D-1, S-1, S-2]\n",
    )
    by_tag = _record("I-2", doc_type="integration", tags="[schedule, crm, aris]")
    produces_only = _record(
        "I-3", doc_type="integration", tags="[x]", extra="relations:\n  produces: [S-1]\n"
    )
    index = _index(aris, crm, dataset)
    assert resolve_group(by_consumes, index) == GroupRef(key="aris", label="ARIS")
    assert resolve_group(by_tag, index) == GroupRef(key="crm", label="CRM")
    assert resolve_group(produces_only, index) == GroupRef(key="_common", label=COMMON_GROUP_LABEL, last=True)


def test_keyless_system_groups_by_its_document() -> None:
    dwh = _record("S-9", title="Legacy DWH: без ключа", doc_type="source")
    flow = _record("I-9", doc_type="integration", extra="relations:\n  consumes: [S-9]\n")
    assert resolve_group(flow, _index(dwh)) == GroupRef(key="s-9", label="Legacy DWH")


def test_standard_group_by_template_tag() -> None:
    index = _index()
    assert resolve_group(_record("T-1", doc_type="standard", tags="[Template]"), index) == GroupRef(
        key="templates", label="Шаблоны документов"
    )
    assert resolve_group(_record("T-2", doc_type="standard", tags="[шаблон]"), index) is not None
    assert resolve_group(_record("T-3", doc_type="standard", tags="[policy]"), index) == GroupRef(
        key="rules", label="Регламенты и качество"
    )
    assert resolve_group(_record("T-4", doc_type="process", tags="[template]"), index) is None


def test_an_earlier_resolver_wins_so_an_explicit_parent_can_be_added_in_front() -> None:
    flow = _record("I-1", doc_type="integration")

    def explicit(doc: DocumentRecord, index: SystemIndex) -> GroupRef | None:
        return GroupRef(key="pinned", label="Закреплено") if doc.id == "I-1" else None

    other = _record("I-2", doc_type="integration")
    resolvers = (explicit, *GROUP_RESOLVERS)
    assert resolve_group(flow, _index(), resolvers) == GroupRef(key="pinned", label="Закреплено")
    assert resolve_group(other, _index(), resolvers) == GroupRef(
        key="_common", label=COMMON_GROUP_LABEL, last=True
    )
    layout = build_layout([flow, other], lambda d: False, resolvers=resolvers)
    assert [g.key for g in layout.sections[0].groups] == ["integration/pinned", "integration/_common"]


def test_a_one_document_group_is_kept_and_common_is_last() -> None:
    zeta = _record("S-1", title="Zeta: система", doc_type="source", tags="[sys-zeta]")
    flows = [
        _record("I-1", title="Поток Z", doc_type="integration", tags="[zeta]"),
        _record("I-2", title="Общий поток", doc_type="integration"),
    ]
    layout = build_layout([zeta, *flows], lambda d: False)
    integration = next(s for s in layout.sections if s.key == "integration")
    assert [(g.label, g.doc_ids) for g in integration.groups] == [
        ("Zeta", ("I-1",)),
        (COMMON_GROUP_LABEL, ("I-2",)),
    ]


def test_systems_from_consumes_and_produces_then_tags_without_repeats() -> None:
    aris = _record("S-1", title="ARIS: модель", doc_type="source", tags="[sys-aris]")
    cat = _record("S-2", title="Data Catalog: активы", doc_type="source", tags="[sys-cat]")
    crm = _record("S-3", title="CRM: карточки", doc_type="source", tags="[sys-crm]")
    dataset = _record("D-1", doc_type="dataset")
    flow = _record(
        "I-1",
        doc_type="integration",
        tags="[crm, aris, catalog, crm]",
        extra="relations:\n  consumes: [S-1, D-1]\n  produces: [S-2]\n  depends_on: [S-3]\n",
    )
    index = _index(aris, cat, crm, dataset)
    # consumes S-1 → ARIS, produces S-2 → Data Catalog, then tags: crm → CRM, aris (repeat), catalog (no key).
    assert document_systems(flow, index) == ["ARIS", "Data Catalog", "CRM"]
    assert document_systems(cat, index) == [
        "Data Catalog"
    ]  # a profile names its own system by its `sys-` tag
    assert document_systems(dataset, index) == []


def test_attention_rule() -> None:
    assert needs_attention(DocStatus.approved, "ok", False) is False
    assert needs_attention(DocStatus.approved, "not_required", False) is False
    for status in (DocStatus.in_review, DocStatus.draft, DocStatus.deprecated):
        assert needs_attention(status, "ok", False) is True
    assert needs_attention(DocStatus.approved, "stale", False) is True
    assert needs_attention(DocStatus.approved, "never_reviewed", False) is True
    assert needs_attention(DocStatus.approved, "ok", True) is True


def test_attention_follows_the_date(client_factory: Callable[..., TestClient], full_workspace: Path) -> None:
    client = _tree_client(client_factory, full_workspace)
    # DEMO-PROC-009 was reviewed on 2026-06-10: 180 days later its review is stale and it needs attention.
    client.app.state.container.knowledge.today = lambda: date(2026, 12, 8)  # type: ignore[attr-defined]
    tree = client.get("/api/documents/tree").json()
    assert tree["documents"]["DEMO-PROC-009"]["review_state"] == "stale"
    assert tree["documents"]["DEMO-PROC-009"]["attention"] is True
    assert tree["attention_total"] > 12


# --- `summary` and `systems` in the catalog list ----------------------------------------------------------------


def test_catalog_items_carry_summary_and_systems(
    client_factory: Callable[..., TestClient], full_workspace: Path
) -> None:
    client = _tree_client(client_factory, full_workspace)
    items = {
        i["id"]: i
        for page in (1, 2)
        for i in client.get("/api/documents", params={"size": 100, "page": page}).json()["items"]
    }
    assert items["DEMO-INT-001"]["systems"] == ["ARIS", "Data Catalog"]
    assert items["DEMO-INT-001"]["summary"].startswith("Инкрементальный поток")
    assert items["SEM-ARCH-001"]["systems"] == []
    tree = client.get("/api/documents/tree").json()["documents"]
    assert {i: d["systems"] for i, d in items.items()} == {i: d["systems"] for i, d in tree.items()}
    assert {i: d["summary"] for i, d in items.items()} == {i: d["summary"] for i, d in tree.items()}
    found = client.get("/api/documents", params={"query": "ARIS"}).json()["items"]
    assert found and all(isinstance(i["systems"], list) for i in found)


def test_detail_keeps_its_summary_and_adds_systems(
    client_factory: Callable[..., TestClient], full_workspace: Path
) -> None:
    detail = _tree_client(client_factory, full_workspace).get("/api/documents/DEMO-INT-001").json()
    assert detail["summary"].startswith("Инкрементальный поток")
    assert detail["systems"] == ["ARIS", "Data Catalog"]
    assert detail["link_count"] is None  # unchanged: the document page counts its links from /links


def test_list_summary_is_the_documents_summary_and_null_without_one() -> None:
    declared = _record("P-1", extra='summary: "Короткое описание из метаданных."\n')
    derived = _record("P-2", body="Первый абзац текста становится описанием документа.")
    without = _record("P-3").model_copy(update={"summary": None})
    service = _service({"owner": assemble_snapshot([declared, derived, without], "v1", [])})
    page = asyncio.run(service.list_documents(OWNER, DocumentQuery(sort="title")))
    assert [(i.id, i.summary, i.systems) for i in page.items] == [
        ("P-1", "Короткое описание из метаданных.", []),
        ("P-2", "Первый абзац текста становится описанием документа.", []),
        ("P-3", None, []),
    ]
