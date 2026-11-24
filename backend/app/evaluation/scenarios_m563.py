"""M5.6.3 evaluation scenarios: metadata without YAML (MD), WikiLinks (WL), AI-first workflows (AI) and the
Template Hub (TP) — 40 distinct cases. Each runs its own app on a TEMPORARY copy of the curated base (and,
where templates change, of the template directory) with the deterministic mock AI; nothing persistent is
touched. Registered into knowledge_eval.SCENARIO_METHODS like the other scenario modules.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.adapters.knowledge.records import assemble_snapshot, build_record
from app.domain.models import UserContext
from app.domain.templates import DEFAULT_TEMPLATES_DIR
from app.evaluation.knowledge_eval import SCENARIO_METHODS, CaseResult, eval_client
from app.evaluation.scenarios import Problems
from app.services.links import LinkService

BARE = "# Выгрузка справочника регионов\n\nИнтеграция загружает справочник регионов раз в сутки.\n\n## Назначение\nСм. [[DEMO-SRC-001]].\n"


def scenario(name: str) -> Callable[[Callable[[Problems, Path], None]], Callable[[Problems, Path], None]]:
    def register(fn: Callable[[Problems, Path], None]) -> Callable[[Problems, Path], None]:
        def run(kb: Path, _case: dict[str, Any], r: CaseResult) -> None:
            problems = Problems()
            fn(problems, kb)
            r.status = "fail" if problems else "pass"
            r.detail = "; ".join(problems)

        SCENARIO_METHODS[name] = run
        return fn

    return register


@contextmanager
def _client(
    kb: Path, *, templates: bool = False, **extra: Any
) -> Iterator[tuple[TestClient, Path, Path | None]]:
    with tempfile.TemporaryDirectory(prefix="skh-m563-") as tmp:
        tdir: Path | None = None
        if templates:
            tdir = Path(tmp) / "templates"
            shutil.copytree(DEFAULT_TEMPLATES_DIR, tdir)
            extra["document_templates_dir"] = str(tdir)
        with eval_client(kb, extra=extra) as c:
            root = Path(c.app.state.container.settings.local_knowledge_dir)  # type: ignore[attr-defined]
            yield c, root, tdir


def _draft(c: TestClient, template: str = "integration", **meta: Any) -> dict[str, Any]:
    body = meta.pop("body", "# Выгрузка регионов\n\n## Назначение\nпоток грузит   справочник раз в сутки\n")
    payload = {"title": "Выгрузка регионов", "tags": [], **meta}
    response = c.post(
        "/api/authoring/drafts",
        json={"template_id": template, "metadata": payload, "body": body, "reason": "Сценарий оценки"},
    )
    response.raise_for_status()
    data: dict[str, Any] = response.json()
    return data


def _propose(c: TestClient, **payload: Any) -> dict[str, Any]:
    response = c.post("/api/ai/proposals", json=payload)
    response.raise_for_status()
    data: dict[str, Any] = response.json()
    return data


def _sync(c: TestClient) -> dict[str, Any]:
    data: dict[str, Any] = c.post("/api/index/sync").json()["last_sync"]
    return data


def _write(root: Path, rel: str, doc_id: str, title: str, body: str, extra: str = "") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nid: {doc_id}\ntitle: {title}\ntype: guide\nstatus: approved\nowner: eval-team\ntags: [eval]\n"
        f"synthetic: true\nreviewed_at: 2026-11-23\n{extra}---\n\n# {title}\n\n{body}\n\nТекст сценария оценки для проверки ссылок.\n",
        encoding="utf-8",
    )


# --- MD: metadata without YAML ------------------------------------------------------------------------------


@scenario("md_create_without_yaml")
def _md_create(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = _draft(c)
        p.expect(d["document_id"].startswith("SEM-INT-"), f"id {d['document_id']}")
        p.expect(
            d["status"] == "draft" and d["template_version"] == 2, "not a draft pinned to integration v2"
        )
        p.expect(
            "template_version: 2" in d["proposed_content"] and "status: draft" in d["proposed_content"],
            "YAML not generated",
        )


@scenario("md_idempotent_retry")
def _md_idem(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        payload = {
            "template_id": "adr",
            "metadata": {"title": "Решение"},
            "body": "# Р\n\n## Контекст\nТекст контекста решения.\n",
            "reason": "Повтор запроса",
            "client_request_id": "eval-retry-001",
        }
        first, second = (c.post("/api/authoring/drafts", json=payload).json() for _ in range(2))
        p.expect(first["id"] == second["id"], "retried request created a second draft")
        p.expect(
            sum(1 for x in c.get("/api/drafts").json()["items"] if x["document_id"] == first["document_id"])
            == 1,
            "duplicate rows",
        )


@scenario("md_duplicate_title_warns")
def _md_dup(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        title = c.get("/api/documents/DEMO-INT-001").json()["title"]
        d = _draft(c, title=title)
        p.expect("duplicate_title" in {i["code"] for i in d["validation"]}, "no duplicate_title warning")
        p.expect(d["document_id"] != "DEMO-INT-001", "title reused an ID")


@scenario("md_missing_owner_unassigned")
def _md_owner(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = _draft(c)
        p.expect("owner: unassigned" in d["proposed_content"], "owner invented")
        p.expect("owner_unassigned" in {i["code"] for i in d["validation"]}, "no owner warning")


@scenario("md_bare_markdown_staged")
def _md_staged(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        (root / "inbox").mkdir()
        (root / "inbox" / "regions.md").write_text(BARE, encoding="utf-8")
        c.post("/api/index/sync")
        staging = c.get("/api/documents/import/staging").json()
        p.expect(any(s["path"] == "inbox/regions.md" for s in staging), "bare file not staged")
        bare_title = "Выгрузка справочника регионов"
        hits = c.get("/api/documents", params={"query": "справочник регионов"}).json()["items"]
        p.expect(all(h["title"] != bare_title for h in hits), "bare file in the catalog")
        found = c.get("/api/search", params={"q": "справочник регионов"}).json()["items"]
        p.expect(all(h["title"] != bare_title for h in found), "bare file in search")
        answer = c.post(
            "/api/assistant/ask", json={"question": "Как часто загружается справочник регионов?"}
        ).json()
        p.expect(all(x["title"] != bare_title for x in answer["citations"]), "bare file cited")


@scenario("md_import_preview_fields")
def _md_preview(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        before = c.get("/api/drafts").json()["total"]
        pv = c.post("/api/documents/import/preview", json={"content": BARE}).json()
        fields = {f["field"]: f for f in pv["fields"]}
        p.expect(pv["state"] == "needs_metadata_review", f"state {pv['state']}")
        p.expect(
            fields["title"]["origin"] == "parsed" and fields["owner"]["origin"] == "missing", "origins wrong"
        )
        p.expect(
            fields["template"]["value"] == "integration" and bool(pv["templates"][0]["reasons"]),
            "template not explained",
        )
        p.expect(
            "DEMO-SRC-001" in (fields.get("related_ids", {}).get("value") or []),
            "WikiLink not used as related",
        )
        p.expect(c.get("/api/drafts").json()["total"] == before, "preview wrote something")


@scenario("md_existing_yaml_kept")
def _md_yaml(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        content = "---\nid: SEM-IMP-777\ntitle: Импортированный регламент\ntype: process\nstatus: approved\nowner: team-x\ntags: [process]\nreviewed_at: 2026-11-01\n---\n\n# Регламент\n\nТекст импортированного регламента достаточной длины.\n"
        pv = c.post("/api/documents/import/preview", json={"content": content}).json()
        p.expect(
            pv["state"] == "ready" and "imported_approved" in {i["code"] for i in pv["issues"]},
            "approved import not flagged",
        )
        d = c.post(
            "/api/documents/import",
            json={"content": content, "keep_original_metadata": True, "reason": "Импорт"},
        ).json()
        p.expect(
            d.get("proposed_content") == content and d.get("status") == "draft",
            "YAML not kept verbatim as a draft",
        )
        p.expect(c.get("/api/documents/SEM-IMP-777").status_code == 404, "import became approved knowledge")


@scenario("md_invalid_yaml_reported")
def _md_invalid(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        pv = c.post(
            "/api/documents/import/preview",
            json={"content": "---\nid: X\ntitle: [\n---\n\n# Документ\n\nТекст.\n"},
        ).json()
        p.expect(pv["state"] == "invalid_metadata", f"state {pv['state']}")
        p.expect({"id", "owner"} <= {f["field"] for f in pv["fields"]}, "no generated replacement metadata")


@scenario("md_move_keeps_id")
def _md_move(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        src = next(root.rglob("DEMO-SRC-001.md"))
        target = root / "archive" / "DEMO-SRC-001.md"
        target.parent.mkdir()
        src.rename(target)
        result = _sync(c)
        p.expect(
            result["renamed"] == ["DEMO-SRC-001"] and not result["added"],
            f"sync {result['renamed']} {result['added']}",
        )
        back = c.get("/api/documents/DEMO-SRC-001/links").json()["backlinks"]
        p.expect(
            any(b["source"]["document_id"] == "DEMO-GUIDE-001" for b in back), "backlink lost after move"
        )


@scenario("md_concurrent_save_guard")
def _md_conflict(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = _draft(c)
        meta = {"title": "Новое", "tags": []}
        body = "# Новое\n\n## Назначение\nТекст раздела назначения.\n"
        first = c.put(f"/api/drafts/{d['id']}", json={"expected_version": 1, "metadata": meta, "body": body})
        second = c.put(
            f"/api/drafts/{d['id']}", json={"expected_version": 1, "metadata": meta, "body": body + "x"}
        )
        p.expect(
            first.status_code == 200 and second.status_code == 409,
            f"{first.status_code} {second.status_code}",
        )
        moved = c.put(
            f"/api/drafts/{d['id']}",
            json={"expected_version": 2, "metadata": {**meta, "id": "SEM-INT-999"}, "body": body},
        )
        p.expect(
            moved.status_code == 422 and moved.json()["code"] == "document_id_immutable",
            "ID changed after creation",
        )


# --- WL: WikiLinks ------------------------------------------------------------------------------------------


@scenario("wl_curated_backlink")
def _wl_back(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        back = c.get("/api/documents/DEMO-SRC-001/links").json()["backlinks"]
        guide = next((b for b in back if b["source"]["document_id"] == "DEMO-GUIDE-001"), None)
        p.expect(
            guide is not None and "inline" in guide["via"] and bool(guide["excerpts"]), f"backlink {guide}"
        )


@scenario("wl_provenance_merged")
def _wl_prov(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        edges = c.get("/api/graph/overview", params={"limit": 200}).json()["edges"]
        merged = [
            e
            for e in edges
            if "related_ids" in e["provenance"] and any(x.startswith("body:") for x in e["provenance"])
        ]
        p.expect(bool(merged), "no edge declared both in related_ids and inline")
        keys = [(e["source"], e["type"], e["target"]) for e in edges]
        p.expect(len(keys) == len(set(keys)), "duplicate edges")


@scenario("wl_insert_then_sync")
def _wl_insert(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        _write(
            root,
            "eval/EVAL-WL-001.md",
            "EVAL-WL-001",
            "Заметка о модели",
            "Опирается на [[DEMO-SEM-002|логическую модель]].",
        )
        p.expect(_sync(c)["added"] == ["EVAL-WL-001"], "not added")
        edges = c.get("/api/graph/nodes/doc:EVAL-WL-001/neighbors").json()["edges"]
        p.expect(
            any(e["target"] == "doc:DEMO-SEM-002" and e["type"] == "references" for e in edges),
            "no references edge",
        )
        back = c.get("/api/documents/DEMO-SEM-002/links").json()["backlinks"]
        p.expect(any(b["source"]["document_id"] == "EVAL-WL-001" for b in back), "no backlink")
        html = c.get("/api/documents/EVAL-WL-001").json()["content_html"]
        p.expect('href="/documents/DEMO-SEM-002" class="wikilink"' in html, "link not rendered")


@scenario("wl_rename_target")
def _wl_rename(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        path = next(root.rglob("DEMO-SEM-002.md"))
        (root / "moved").mkdir()
        path.rename(root / "moved" / "DEMO-SEM-002.md")
        _sync(c)
        nodes = c.get("/api/graph/overview", params={"limit": 200}).json()["nodes"]
        p.expect(sum(1 for n in nodes if n["id"] == "doc:DEMO-SEM-002") == 1, "duplicate node after move")
        out = c.get("/api/documents/DEMO-GUIDE-005/links").json()
        p.expect(
            any(o["target"]["document_id"] == "DEMO-SEM-002" for o in out["outgoing"]), "link broken by move"
        )


@scenario("wl_remove_link_no_stale_edge")
def _wl_remove(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        _write(root, "eval/EVAL-WL-002.md", "EVAL-WL-002", "Временная ссылка", "Ссылка [[DEMO-GOV-013]].")
        _sync(c)
        _write(root, "eval/EVAL-WL-002.md", "EVAL-WL-002", "Временная ссылка", "Ссылки больше нет.")
        p.expect(_sync(c)["updated"] == ["EVAL-WL-002"], "not updated")
        edges = c.get("/api/graph/nodes/doc:EVAL-WL-002/neighbors").json()["edges"]
        p.expect(not edges, f"stale edges {edges}")
        back = c.get("/api/documents/DEMO-GOV-013/links").json()["backlinks"]
        p.expect(all(b["source"]["document_id"] != "EVAL-WL-002" for b in back), "stale backlink")


@scenario("wl_delete_target_reported")
def _wl_delete(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        _write(root, "eval/EVAL-WL-003.md", "EVAL-WL-003", "Ссылка на удаляемый", "См. [[EVAL-WL-004]].")
        _write(
            root,
            "eval/EVAL-WL-004.md",
            "EVAL-WL-004",
            "Удаляемый документ",
            "Содержимое удаляемого документа гелиотроп.",
        )
        _sync(c)
        (root / "eval" / "EVAL-WL-004.md").unlink()
        _sync(c)
        links = c.get("/api/documents/EVAL-WL-003/links").json()
        p.expect(
            links["outgoing"] == [] and links["unresolved"][0]["reason"] == "missing",
            "broken link not reported",
        )
        dangling = c.get("/api/graph/diagnostics").json()["dangling"]
        p.expect(any(d["target"] == "doc:EVAL-WL-004" for d in dangling), "no dangling diagnostic")
        answer = c.post("/api/assistant/ask", json={"question": "Что такое гелиотроп?"}).json()
        p.expect("EVAL-WL-004" not in {x["document_id"] for x in answer["citations"]}, "deleted target cited")


@scenario("wl_code_is_not_a_link")
def _wl_code(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        _write(
            root,
            "eval/EVAL-WL-005.md",
            "EVAL-WL-005",
            "Пример синтаксиса",
            "```\n[[DEMO-SEM-002]]\n```\n\nИнлайн `[[DEMO-SEM-003]]` и \\[[DEMO-SEM-004]].",
        )
        _sync(c)
        p.expect(
            c.get("/api/graph/nodes/doc:EVAL-WL-005/neighbors").json()["edges"] == [], "code produced an edge"
        )


@scenario("wl_title_link_not_guessed")
def _wl_title(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        title = c.get("/api/documents/DEMO-SEM-002").json()["title"]
        _write(root, "eval/EVAL-WL-006.md", "EVAL-WL-006", "Ссылка по названию", f"См. [[{title}]].")
        _sync(c)
        links = c.get("/api/documents/EVAL-WL-006/links").json()
        u = links["unresolved"][0] if links["unresolved"] else {}
        p.expect(links["outgoing"] == [] and u.get("reason") == "title_link", f"title link resolved: {links}")
        p.expect(
            [x["document_id"] for x in u.get("candidates", [])] == ["DEMO-SEM-002"], "no repair candidate"
        )


@scenario("wl_label_escaped")
def _wl_xss(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, root, _):
        _write(
            root,
            "eval/EVAL-WL-007.md",
            "EVAL-WL-007",
            "Опасная подпись",
            "См. [[DEMO-SEM-002|<img src=x onerror=alert(1)>]].",
        )
        _sync(c)
        html = c.get("/api/documents/EVAL-WL-007").json()["content_html"]
        p.expect("<img" not in html and "&lt;img" in html, "label not escaped")


@scenario("wl_inaccessible_target_no_leak")
def _wl_acl(p: Problems, kb: Path) -> None:
    def record(doc_id: str, title: str, body: str) -> Any:
        text = f"---\nid: {doc_id}\ntitle: {title}\ntype: guide\nstatus: approved\nowner: t\ntags: [t]\nreviewed_at: 2026-11-01\n---\n\n# {title}\n\n{body}\n\nТекст достаточной длины для документа.\n"
        return build_record(
            text.encode(),
            path=f"{doc_id}.md",
            source="local",
            source_uri_for="local://{id}",
            revision=doc_id,
            updated_at=None,
            is_demo=True,
            issues=[],
        )

    open_doc = record("PUB-1", "Открытый", "Ссылка на [[SEC-1|скрытый]].")
    secret = record("SEC-1", "Секретный план", "Ссылка на [[PUB-1]].")
    full, guest = assemble_snapshot([open_doc, secret], "v", []), assemble_snapshot([open_doc], "vg", [])

    class Scoped:
        async def snapshot(self, user: UserContext) -> Any:
            return full if user.user_id == "owner" else guest

        def generation_label(self, snapshot: Any) -> str:
            return "g"

    links = asyncio.run(LinkService(Scoped()).links(UserContext(user_id="guest", display_name="g"), "PUB-1"))  # type: ignore[arg-type]
    dump = links.model_dump_json() if links else ""
    p.expect(links is not None and not links.backlinks and not links.outgoing, "hidden source/target visible")
    p.expect("Секретный план" not in dump, "hidden title leaked")


# --- AI: AI-first workflows ---------------------------------------------------------------------------------


@scenario("ai_prompt_to_document")
def _ai_prompt(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        prop = _propose(
            c,
            kind="draft_from_prompt",
            prompt="Опиши интеграцию: поток загружает процессы ARIS в каталог",
            title="Загрузка ARIS",
        )
        items = {i["id"]: i for i in prop["items"]}
        p.expect(items["template"]["proposed"]["template_id"] == "integration", "wrong template")
        p.expect(bool(items["draft"]["proposed"]["missing_sections"]), "missing facts not marked")
        p.expect(all(e["quote"] for e in items["draft"]["evidence"]), "unverified citation in evidence")
        res = c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": ["draft"]}).json()
        d = c.get(f"/api/drafts/{res['result_draft_id']}").json()
        p.expect(d["status"] == "draft" and d["origin"] == "ai_suggestion", "AI draft not a reviewable draft")


@scenario("ai_metadata_reject_unchanged")
def _ai_reject(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = _draft(c)
        prop = _propose(c, kind="suggest_metadata", draft_id=d["id"])
        c.post(f"/api/ai/proposals/{prop['id']}/reject")
        after = c.get(f"/api/drafts/{d['id']}").json()
        p.expect(
            after["edit_version"] == d["edit_version"] and after["proposed_content"] == d["proposed_content"],
            "reject changed the draft",
        )


@scenario("ai_metadata_partial_accept")
def _ai_partial(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = _draft(c)
        prop = _propose(c, kind="suggest_metadata", draft_id=d["id"])
        fields = {i["field"] for i in prop["items"] if i["kind"] == "metadata"}
        p.expect({"tags", "summary"} <= fields, f"fields {fields}")
        res = c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": ["tags"]}).json()
        meta = c.get(f"/api/drafts/{d['id']}").json()["new_document"]["metadata"]
        p.expect(
            res["status"] == "partially_applied" and meta.get("tags") and not meta.get("summary"),
            "not field-level",
        )


@scenario("ai_improve_section_partial")
def _ai_improve(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        body = "# Х\n\n## Назначение\nпоток грузит   справочник\n\n## Маппинг\nисходный текст маппинга\n"
        d = _draft(c, body=body)
        prop = _propose(c, kind="improve_section", draft_id=d["id"], section="Назначение")
        c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": ["section"]})
        new_body = c.get(f"/api/drafts/{d['id']}").json()["new_document"]["body"]
        p.expect(
            "Поток грузит справочник." in new_body and "исходный текст маппинга" in new_body,
            "other sections changed or no change",
        )


@scenario("ai_stale_proposal_invalidated")
def _ai_stale(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = _draft(c)
        prop = _propose(c, kind="improve_section", draft_id=d["id"], section="Назначение")
        c.put(
            f"/api/drafts/{d['id']}",
            json={
                "expected_version": 1,
                "metadata": {"title": "Другое", "tags": []},
                "body": "# Д\n\n## Назначение\nДругой текст назначения.\n",
            },
        )
        late = c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": ["section"]})
        status = c.get(f"/api/ai/proposals/{prop['id']}").json()["status"]
        p.expect(late.status_code == 409 and status == "invalidated", f"{late.status_code} {status}")


@scenario("ai_related_links_are_proposals")
def _ai_related(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        before_raw = c.get("/api/documents/DEMO-INT-014").json()["raw"]
        before_edges = len(c.get("/api/graph/nodes/doc:DEMO-INT-014/neighbors").json()["edges"])
        prop = _propose(c, kind="find_related", document_id="DEMO-INT-014")
        links = [i for i in prop["items"] if i["kind"] == "link"]
        p.expect(
            bool(links) and all("references" in i["reason"] for i in links), "links not marked as mentions"
        )
        res = c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": [links[0]["id"]]}).json()
        d = c.get(f"/api/drafts/{res['result_draft_id']}").json()
        p.expect(d["operation"] == "update" and d["status"] == "draft", "not an update draft")
        p.expect(
            c.get("/api/documents/DEMO-INT-014").json()["raw"] == before_raw, "source changed before review"
        )
        p.expect(
            len(c.get("/api/graph/nodes/doc:DEMO-INT-014/neighbors").json()["edges"]) == before_edges,
            "graph changed before merge",
        )


@scenario("ai_explain_relation_kinds")
def _ai_relation(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        typed = _propose(c, kind="explain_relation", document_id="DEMO-INT-001", target_id="DEMO-SRC-002")
        mention = _propose(c, kind="explain_relation", document_id="DEMO-GUIDE-001", target_id="DEMO-SRC-001")
        p.expect("Подтверждённых бизнес-связей: 1" in typed["summary"], typed["summary"][:120])
        p.expect("Подтверждённых бизнес-связей: 0" in mention["summary"], mention["summary"][:120])
        p.expect(bool(typed["graph_link"]), "no graph link")


@scenario("ai_impact_is_a_plan")
def _ai_impact(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        prop = _propose(c, kind="impact_analysis", document_id="DEMO-SEM-002")
        tasks = [i for i in prop["items"] if i["kind"] == "task"]
        p.expect(bool(tasks) and all(not i["applicable"] for i in tasks), "plan items applicable")
        refused = (
            c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": [tasks[0]["id"]]})
            if tasks
            else None
        )
        p.expect(refused is not None and refused.status_code in (409, 422), "a plan was applied")


@scenario("ai_template_change_invalidates")
def _ai_template(p: Problems, kb: Path) -> None:
    with _client(kb, templates=True) as (c, _, tdir):
        assert tdir is not None
        prop = _propose(
            c,
            kind="draft_from_prompt",
            prompt="Нужен runbook: перезапуск потока при инциденте",
            title="Перезапуск потока",
        )
        p.expect(
            prop["base"]["template_id"] == "runbook" and prop["base"]["template_version"] == 1,
            f"base {prop['base']}",
        )
        path = tdir / "runbook.md"
        path.write_text(
            path.read_text(encoding="utf-8").replace("version: 1", "version: 2")
            + "\n## Проверка после\n> Требует уточнения: что проверить.\n",
            encoding="utf-8",
        )
        c.post("/api/index/sync")
        late = c.post(f"/api/ai/proposals/{prop['id']}/accept", json={"item_ids": ["draft"]})
        p.expect(late.status_code == 409, f"accepted against an old template version ({late.status_code})")
        fresh = _propose(c, kind="draft_from_prompt", prompt="Нужен runbook: перезапуск потока при инциденте")
        p.expect(fresh["base"]["template_version"] == 2, "new session does not use the new version")


@scenario("ai_explain_no_answer")
def _ai_noanswer(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        prop = _propose(
            c, kind="explain", selection="Какова стоимость лицензии квантового компилятора Зефир-9?"
        )
        p.expect(prop["insufficient"] is True and not prop["items"][0]["evidence"], "fabricated evidence")


# --- TP: Template Hub -----------------------------------------------------------------------------------------


@scenario("tp_catalogue_statuses")
def _tp_catalogue(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        rows = {t["id"]: t for t in c.get("/api/templates").json()}
        active = [t for t in rows.values() if t["status"] == "active"]
        p.expect(len(active) >= 10, f"only {len(active)} active templates")
        p.expect(rows.get("meeting_decision", {}).get("status") == "deprecated", "deprecated not shown")
        p.expect("external_import" not in rows, "hidden template listed")


@scenario("tp_detail_structure")
def _tp_detail(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        d = c.get("/api/templates/knowledge_article").json()
        req = [s["title"] for s in d["sections"] if s["required"]]
        opt = [s["title"] for s in d["sections"] if not s["required"]]
        p.expect(
            req == ["Суть", "Подробности"] and set(opt) == {"Пример", "Связанные материалы"}, f"{req} {opt}"
        )
        p.expect(
            bool(d["example_html"]) and bool(d["ai_guidance"]) and d["versions"] == [1, 2],
            "guide/example/history missing",
        )


@scenario("tp_compare_breaking")
def _tp_breaking(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        cmp = c.get("/api/templates/mapping/compare", params={"from": 1, "to": 2}).json()
        p.expect(cmp["breaking"] and bool(cmp["migration"]), "breaking change without migration")
        p.expect(
            "Правила" in cmp["sections_removed"] and "Исключения и ошибки" in cmp["sections_added"],
            f"{cmp['sections_added']}",
        )


@scenario("tp_compare_optional_rename")
def _tp_rename(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        cmp = c.get("/api/templates/knowledge_article/compare", params={"from": 1, "to": 2}).json()
        p.expect(
            cmp["sections_removed"] == ["Дополнительно"] and cmp["sections_added"] == ["Связанные материалы"],
            str(cmp),
        )
        p.expect(not cmp["breaking"] and not cmp["became_required"], "optional rename marked breaking")


@scenario("tp_deprecated_not_recommended")
def _tp_deprecated(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        picker = {t["id"] for t in c.get("/api/authoring/templates").json()}
        p.expect("meeting_decision" not in picker, "deprecated offered in the picker")
        prop = _propose(
            c, kind="draft_from_prompt", prompt="Протокол встречи: решения встречи и ответственные"
        )
        p.expect(prop["base"]["template_id"] != "meeting_decision", "AI recommended a deprecated template")
        d = _draft(c, template="meeting_decision", body="# В\n\n## Повестка\nТемы встречи.\n")
        p.expect("template_deprecated" in {i["code"] for i in d["validation"]}, "no deprecation warning")


@scenario("tp_new_template_everywhere")
def _tp_new(p: Problems, kb: Path) -> None:
    with _client(kb, templates=True) as (c, _, tdir):
        assert tdir is not None
        (tdir / "glossary_term.md").write_text(
            '---\ntemplate_id: glossary_term\ntitle: "Термин глоссария"\ndescription: "Определение термина."\ndoc_type: glossary\nid_prefix: SEM-TERM\ndefault_tags: [glossary]\norder: 80\nversion: 1\ncategory: "Семантика"\nlabels: [термин]\n---\n## Термин\n> Требует уточнения: термин.\n\n## Определение\n> Требует уточнения: определение термина глоссария.\n',
            encoding="utf-8",
        )
        c.post("/api/index/sync")
        p.expect("glossary_term" in {t["id"] for t in c.get("/api/templates").json()}, "not in the Hub")
        p.expect(
            "glossary_term" in {t["id"] for t in c.get("/api/authoring/templates").json()},
            "not in the picker",
        )
        types = {t["type"]: t for t in c.get("/api/document-types").json()}
        p.expect("glossary_term" in types["glossary"]["templates"], "not in document types")
        prop = _propose(c, kind="draft_from_prompt", prompt="Добавь термин глоссария и его определение")
        p.expect(prop["base"]["template_id"] == "glossary_term", f"AI picked {prop['base']['template_id']}")


@scenario("tp_v2_keeps_old_drafts")
def _tp_v2(p: Problems, kb: Path) -> None:
    with _client(kb, templates=True) as (c, _, tdir):
        assert tdir is not None
        old = _draft(c, template="runbook", body="# R\n\n## Когда применять\nПри остановке потока.\n")
        path = tdir / "runbook.md"
        (tdir / "history" / "runbook.v1.md").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        path.write_text(
            path.read_text(encoding="utf-8").replace("version: 1", "version: 2")
            + "\n## Проверка после\n> Требует уточнения: проверка.\n",
            encoding="utf-8",
        )
        c.post("/api/index/sync")
        hub = c.get("/api/templates/runbook").json()
        p.expect(hub["version"] == 2 and hub["versions"] == [1, 2], f"hub {hub['version']} {hub['versions']}")
        kept = c.get(f"/api/drafts/{old['id']}").json()
        p.expect(
            kept["template_version"] == 1 and kept["template_current_version"] == 2, "old draft re-pinned"
        )
        p.expect(kept["proposed_content"] == old["proposed_content"], "old draft rewritten")


@scenario("tp_invalid_revision_keeps_active")
def _tp_invalid(p: Problems, kb: Path) -> None:
    with _client(kb, templates=True) as (c, _, tdir):
        assert tdir is not None
        (tdir / "runbook.md").write_text("---\ntemplate_id: runbook\n---\nбез разделов\n", encoding="utf-8")
        c.post("/api/index/sync")
        hub = {t["id"]: t for t in c.get("/api/templates").json()}
        p.expect(hub.get("runbook", {}).get("version") == 1, "invalid revision disabled the active template")
        d = _draft(c, template="runbook", body="# R\n\n## Когда применять\nПри остановке потока.\n")
        p.expect(d["template_version"] == 1, "document creation broken")


@scenario("tp_schema_defines_version")
def _tp_schema(p: Problems, kb: Path) -> None:
    with _client(kb, templates=True) as (c, _, tdir):
        assert tdir is not None
        path = tdir / "source_system.md"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                "Карточка системы-источника", "Паспорт системы-источника"
            ),
            encoding="utf-8",
        )
        c.post("/api/index/sync")
        p.expect(
            c.get("/api/templates/source_system").json()["versions"] == [1],
            "catalogue text created a version",
        )
        path.write_text(
            path.read_text(encoding="utf-8") + "\n## Риски\n> Требует уточнения: риски.\n", encoding="utf-8"
        )
        c.post("/api/index/sync")
        p.expect(
            c.get("/api/templates/source_system").json()["versions"] == [1, 2], "schema change not versioned"
        )


@scenario("tp_usage_counts_visible_documents")
def _tp_usage(p: Problems, kb: Path) -> None:
    with _client(kb) as (c, _, _):
        detail = c.get("/api/templates/integration").json()
        docs = c.get("/api/documents", params={"size": 100}).json()["items"]
        visible = {d["id"] for d in docs}
        p.expect(
            all(u["document_id"] in visible for u in detail["used_by"]), "usage lists invisible documents"
        )
        p.expect(detail["documents"] == len(detail["used_by"]), "count differs from the visible list")
        edges = c.get("/api/graph/overview", params={"limit": 200}).json()["edges"]
        uses = {
            e["source"]
            for e in edges
            if e["type"] == "uses_template" and e["target"] == "template:integration"
        }
        p.expect(
            uses == {f"doc:{u['document_id']}" for u in detail["used_by"]},
            "graph uses_template differs from the Hub",
        )
