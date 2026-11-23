"""Lifecycle evaluation scenarios (add / update / delete / rename / conflicts / templates) for knowledge_eval.

Each scenario copies the small synthetic snapshot `fixtures/knowledge_updates/base` (and, for template
scenarios, the shipped templates) into a TEMPORARY directory, runs the real application through its HTTP API,
applies one change and checks every projection: catalog, full-text index, graph, grounded answer, facets,
sync result. The curated base, developer workspaces and server volumes are never touched.

Registered in `knowledge_eval.SCENARIO_METHODS` under the case `method` name.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
import warnings
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.domain.templates import DEFAULT_TEMPLATES_DIR  # noqa: E402
from app.evaluation.knowledge_eval import HEADERS, SCENARIO_METHODS, CaseResult  # noqa: E402
from app.main import create_app  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[3]
UPDATES = PROJECT_ROOT / "fixtures" / "knowledge_updates"


class Problems(list[str]):
    def expect(self, condition: bool, message: str) -> None:
        if not condition:
            self.append(message)


@contextmanager
def _env(templates: bool = False) -> Iterator[tuple[Path, Path | None, Callable[[], TestClient]]]:
    with tempfile.TemporaryDirectory(prefix="skh-scenario-") as tmp:
        root = Path(tmp)
        knowledge = root / "knowledge"
        shutil.copytree(UPDATES / "base", knowledge)
        template_dir: Path | None = None
        if templates:
            template_dir = root / "templates"
            shutil.copytree(DEFAULT_TEMPLATES_DIR, template_dir)
        clients: list[TestClient] = []

        def make() -> TestClient:
            settings = Settings(
                _env_file=None,
                app_env="test",
                project_root=root,
                local_knowledge_dir=knowledge,
                seed_fixtures=False,
                search_index_path=root / "search.sqlite3",
                app_state_path=root / "app_state.sqlite3",
                publication_state_path=root / "publications.sqlite3",
                repository_refresh_seconds=0.0,
                ai_provider="mock",
                confluence_connector="disabled",
                document_templates_dir=str(template_dir) if template_dir else "",
            )
            client = TestClient(create_app(settings), base_url="http://localhost", headers=HEADERS)
            client.__enter__()
            clients.append(client)
            return client

        try:
            yield knowledge, template_dir, make
        finally:
            for client in clients:
                client.__exit__(None, None, None)


def _overlay(knowledge: Path, name: str) -> None:
    for path in sorted((UPDATES / name).rglob("*.md")):
        target = knowledge / path.relative_to(UPDATES / name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)


def _sync(client: TestClient) -> dict[str, Any]:
    response = client.post("/api/index/sync")
    response.raise_for_status()
    result: dict[str, Any] = response.json()["last_sync"]
    return result


def _search(client: TestClient, query: str) -> list[str]:
    """Direct matches only (graph-expansion items, marked `related_via`, are not text matches)."""
    items = client.get("/api/documents", params={"query": query}).json()["items"]
    ids = [i["id"] for i in items if not i.get("related_via")]
    assert len(ids) == len(set(ids)), f"duplicate results {ids}"
    return ids


def _ask(client: TestClient, question: str, **extra: Any) -> dict[str, Any]:
    response = client.post("/api/assistant/ask", json={"question": question, **extra})
    response.raise_for_status()
    data: dict[str, Any] = response.json()
    return data


def _text(answer: dict[str, Any]) -> str:
    return " ".join([answer["answer"], *(c["excerpt"] for c in answer["citations"])])


def _cited(answer: dict[str, Any]) -> set[str]:
    return {c["document_id"] for c in answer["citations"]}


def _finish(r: CaseResult, problems: Problems) -> None:
    r.status = "fail" if problems else "pass"
    r.detail = "; ".join(problems)


def scenario(name: str) -> Callable[[Callable[[Problems], None]], Callable[[Problems], None]]:
    def register(fn: Callable[[Problems], None]) -> Callable[[Problems], None]:
        def run(_kb: Path, _case: dict[str, Any], r: CaseResult) -> None:
            problems = Problems()
            fn(problems)
            _finish(r, problems)

        SCENARIO_METHODS[name] = run
        return fn

    return register


# --- documents -------------------------------------------------------------------------------------------


@scenario("sync_add_approved")
def _add_approved(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        before = _ask(c, "Что означает поле SYNTHETIC_Q7_FIELD?")
        p.expect(
            before["confidence"] == "insufficient_evidence", "before: the unknown field must have no answer"
        )
        revisions = {
            i["id"]: i["revision"] for i in c.get("/api/documents", params={"size": 100}).json()["items"]
        }
        _overlay(kb, "add")
        result = _sync(c)
        p.expect(result["added"] == ["DEMO-TEST-NEW-001"], f"added {result['added']}")
        p.expect(_search(c, "SYNTHETIC_Q7_FIELD")[:1] == ["DEMO-TEST-NEW-001"], "not first in search")
        after = _ask(c, "Что означает поле SYNTHETIC_Q7_FIELD?")
        p.expect("DEMO-TEST-NEW-001" in _cited(after), f"not cited: {_cited(after)}")
        p.expect("Q7-A" in _text(after), "fact Q7-A missing from the grounded answer")
        nodes = c.get("/api/graph/nodes/doc:DEMO-TEST-NEW-001/neighbors").json().get("nodes", [])
        p.expect(any(n.get("document_id") == "DEMO-TEST-REV-001" for n in nodes), "graph edge missing")
        now = {i["id"]: i["revision"] for i in c.get("/api/documents", params={"size": 100}).json()["items"]}
        p.expect(all(now.get(k) == v for k, v in revisions.items()), "other documents changed")


@scenario("sync_add_draft")
def _add_draft(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        _overlay(kb, "add_draft")
        _sync(c)
        drafts = [i["id"] for i in c.get("/api/documents", params={"status": "draft"}).json()["items"]]
        p.expect(drafts == ["DEMO-TEST-DRAFT-001"], f"catalog drafts {drafts}")
        answer = _ask(c, "Какое значение DEMO_VALIDATION_LIMIT?")
        p.expect("DEMO-TEST-DRAFT-001" not in _cited(answer), "a draft was cited by default")
        p.expect("3 ошибки" not in _text(answer), "the draft value leaked into the answer")
        p.expect("7 ошибок" in _text(answer), "the approved value is missing")


@scenario("sync_update_rule")
def _update_rule(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        p.expect("7 ошибок" in _text(_ask(c, "Какое значение DEMO_VALIDATION_LIMIT?")), "before: 7 expected")
        _overlay(kb, "update")
        result = _sync(c)
        p.expect(result["updated"] == ["DEMO-TEST-REV-001"], f"updated {result['updated']}")
        p.expect(_search(c, "квазиреликт") == [], "the old unique term is still in the active index")
        answer = _ask(c, "Какое значение DEMO_VALIDATION_LIMIT?")
        text = _text(answer)
        p.expect("11 ошибок" in text and "7 ошибок" not in text, "the answer does not use the new value only")
        revision = c.get("/api/documents/DEMO-TEST-REV-001").json()["revision"]
        p.expect(all(x["revision"] == revision for x in answer["citations"]), "citation of an old revision")


@scenario("sync_update_metadata")
def _update_metadata(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        _overlay(kb, "update_meta")
        _sync(c)
        facets = c.get("/api/knowledge/facets").json()
        statuses = {f["value"]: f["count"] for f in facets["statuses"]}
        owners = {f["value"] for f in facets["owners"]}
        p.expect(statuses.get("deprecated") == 1, f"statuses {statuses}")
        p.expect("demo-test-team-2" in owners, "owner facet not updated")
        answer = _ask(c, "Что хранит поле beta_edges?")
        p.expect("DEMO-TEST-SEM-010" not in _cited(answer), "deprecated document used as evidence")


@scenario("sync_update_relation")
def _update_relation(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()

        def targets() -> set[str]:
            edges = c.get("/api/graph/nodes/doc:DEMO-TEST-MAP-001/neighbors").json()["edges"]
            return {
                e["target"]
                for e in edges
                if e["type"] == "maps_to" and e["source"] == "doc:DEMO-TEST-MAP-001"
            }

        p.expect(targets() == {"doc:DEMO-TEST-SEM-009"}, f"before {targets()}")
        _overlay(kb, "update_relation")
        _sync(c)
        p.expect(targets() == {"doc:DEMO-TEST-SEM-010"}, f"after {targets()}")


@scenario("sync_delete")
def _delete(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        (kb / "DEMO-TEST-DEL-001.md").unlink()
        result = _sync(c)
        p.expect(result["deleted"] == ["DEMO-TEST-DEL-001"], f"deleted {result['deleted']}")
        p.expect(_search(c, "гелиодор") == [], "deleted document still searchable")
        p.expect(
            c.get("/api/documents/DEMO-TEST-DEL-001").status_code == 404, "deleted document still served"
        )
        dangling = c.get("/api/graph/diagnostics").json()["dangling"]
        p.expect(any(d["target"] == "doc:DEMO-TEST-DEL-001" for d in dangling), "dangling link not reported")
        p.expect(
            "DEMO-TEST-DEL-001" not in _cited(_ask(c, "Какой регламент гелиодор?")), "deleted document cited"
        )


@scenario("sync_rename")
def _rename(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        (kb / "b").mkdir()
        shutil.move(kb / "a" / "DEMO-TEST-MOVE-001.md", kb / "b" / "DEMO-TEST-MOVE-001.md")
        result = _sync(c)
        p.expect(result["renamed"] == ["DEMO-TEST-MOVE-001"] and not result["added"], f"result {result}")
        p.expect(_search(c, "турмалин") == ["DEMO-TEST-MOVE-001"], "duplicate or missing after rename")
        path = c.get("/api/documents/DEMO-TEST-MOVE-001").json()["path"]
        p.expect(path == "b/DEMO-TEST-MOVE-001.md", f"locator {path}")


@scenario("sync_duplicate_id")
def _duplicate(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        _overlay(kb, "conflict")
        result = _sync(c)
        codes = {r["code"] for r in result["rejected"]}
        p.expect(codes == {"duplicate_id"}, f"rejected {result['rejected']}")
        p.expect(c.get("/api/documents/DEMO-TEST-REV-001").status_code == 422, "a duplicate id was guessed")
        p.expect(
            "DEMO-TEST-REV-001" not in _cited(_ask(c, "Какое значение DEMO_VALIDATION_LIMIT?")),
            "quarantined cited",
        )
        p.expect(_search(c, "турмалин") == ["DEMO-TEST-MOVE-001"], "valid documents not served")


@scenario("sync_invalid_yaml")
def _invalid(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        _overlay(kb, "invalid")
        result = _sync(c)
        p.expect(
            any(r["code"] == "frontmatter_invalid_yaml" for r in result["rejected"]),
            f"rejected {result['rejected']}",
        )
        p.expect(
            c.get("/api/documents", params={"size": 100}).json()["total"] == 7, "valid subset not served"
        )


@scenario("sync_idempotent_parallel")
def _idempotent(p: Problems) -> None:
    with _env() as (kb, _, make):
        c = make()
        first = _sync(c)
        second = _sync(c)
        p.expect(
            second["applied"] is False and second["generation"] == first["generation"],
            "repeat is not a no-op",
        )
        rebuilt = c.post("/api/index/sync", params={"rebuild": "true"}).json()["last_sync"]
        p.expect(rebuilt["checksum"] == first["checksum"], "full rebuild differs from incremental")
        _overlay(kb, "add")
        statuses: list[int] = []

        def run() -> None:
            statuses.append(c.post("/api/index/sync").status_code)

        threads = [threading.Thread(target=run) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        p.expect(statuses == [200, 200, 200], f"parallel statuses {statuses}")
        p.expect(_search(c, "SYNTHETIC_Q7_FIELD") == ["DEMO-TEST-NEW-001"], "duplicate after parallel sync")
        final = c.get("/api/index/status").json()
        p.expect(final["indexed_documents"] == 8, f"indexed {final['indexed_documents']}")


# --- templates -------------------------------------------------------------------------------------------


def _templates(c: TestClient) -> dict[str, dict[str, Any]]:
    return {t["id"]: t for t in c.get("/api/authoring/templates").json()}


def _draft(c: TestClient, template_id: str, *, body: str | None = None) -> dict[str, Any]:
    t = _templates(c)[template_id]
    body = body or "\n\n".join(
        f"## {s}\nСодержимое раздела «{s}» тестового документа." for s in t["sections"]
    )
    response = c.post(
        "/api/authoring/drafts",
        json={
            "template_id": template_id,
            "metadata": {"id": t["suggested_id"], "title": "Сценарный документ", "owner": "t", "tags": []},
            "body": body,
            "reason": "Сценарий проверки шаблонов",
        },
    )
    response.raise_for_status()
    data: dict[str, Any] = response.json()
    data["_body"] = body
    return data


def _bump(
    template_dir: Path, file: str, extra_section: str | None = "Новый обязательный раздел", bump: bool = True
) -> None:
    path = template_dir / file
    text = path.read_text(encoding="utf-8")
    if bump:
        import re

        text = re.sub(r"^version: (\d+)$", lambda m: f"version: {int(m.group(1)) + 1}", text, flags=re.M)
    if extra_section:
        text += f"\n## {extra_section}\n> Требует уточнения: новое.\n"
    path.write_text(text, encoding="utf-8")


@scenario("template_new_visible")
def _template_new(p: Problems) -> None:
    with _env(templates=True) as (_, tdir, make):
        c = make()
        assert tdir is not None
        (tdir / "glossary_entry.md").write_text(
            '---\ntemplate_id: glossary_entry\ntitle: Термин глоссария\ndescription: "Новый тестовый шаблон."\n'
            "doc_type: glossary\nid_prefix: SEM-GLS\ndefault_tags: [glossary]\norder: 70\nversion: 1\n---\n"
            "## Термин\n> Требует уточнения: термин.\n\n## Определение\n> Требует уточнения: определение.\n",
            encoding="utf-8",
        )
        c.post("/api/index/sync")
        found = _templates(c).get("glossary_entry")
        p.expect(
            found is not None and found["version"] == 1, "new template not offered without a code change"
        )


@scenario("template_v2_for_new_drafts")
def _template_v2(p: Problems) -> None:
    with _env(templates=True) as (_, _tdir, make):
        c = make()
        integration = _templates(c)["integration"]
        p.expect(
            integration["version"] == 2 and integration["previous_versions"] == [1], f"versions {integration}"
        )
        draft = _draft(c, "integration")
        p.expect(draft["template_version"] == 2, "new draft not on v2")
        p.expect(
            "template_version: 2" in draft["proposed_content"], "template version not recorded in the file"
        )
        p.expect("Происхождение данных (Data Lineage)" in draft["_body"], "v2 section missing")


@scenario("template_old_draft_keeps_version")
def _template_old_draft(p: Problems) -> None:
    with _env(templates=True) as (_, tdir, make):
        c = make()
        assert tdir is not None
        draft = _draft(c, "dataset_spec")
        _bump(tdir, "dataset.md")
        c.post("/api/index/sync")
        detail = c.get(f"/api/drafts/{draft['id']}").json()
        p.expect(
            detail["template_version"] == 1 and detail["template_current_version"] == 2, "versions not kept"
        )
        p.expect(detail["proposed_content"] == draft["proposed_content"], "old draft was rewritten silently")
        meta = {
            k: v
            for k, v in detail["new_document"]["metadata"].items()
            if k in ("id", "title", "owner", "tags")
        }
        saved = c.put(
            f"/api/drafts/{draft['id']}",
            json={
                "expected_version": detail["edit_version"],
                "metadata": meta,
                "body": draft["_body"] + "\n\nПравка.",
                "reason": "Правка старого черновика",
            },
        )
        p.expect(saved.status_code == 200, f"save {saved.status_code}")
        codes = {i["code"] for i in saved.json().get("validation", [])}
        p.expect("template_section_missing" not in codes, "old draft validated against the new version")


@scenario("template_removed_old_draft_opens")
def _template_removed(p: Problems) -> None:
    with _env(templates=True) as (_, tdir, make):
        c = make()
        assert tdir is not None
        draft = _draft(c, "dataset_spec")
        (tdir / "dataset.md").unlink()
        c.post("/api/index/sync")
        p.expect("dataset_spec" not in _templates(c), "removed template still offered")
        detail = c.get(f"/api/drafts/{draft['id']}")
        p.expect(
            detail.status_code == 200 and detail.json()["template_version"] == 1, "old draft does not open"
        )


@scenario("template_silent_edit_versioned")
def _template_silent(p: Problems) -> None:
    with _env(templates=True) as (_, tdir, make):
        c = make()
        assert tdir is not None
        before = _templates(c)["adr"]["version"]
        _bump(tdir, "adr.md", extra_section="Риски", bump=False)
        c.post("/api/index/sync")
        after = _templates(c)["adr"]
        p.expect(
            after["version"] == before + 1 and before in after["previous_versions"],
            f"{before} → {after['version']}",
        )


@scenario("template_ai_authoring_uses_registry")
def _template_ai(p: Problems) -> None:
    with _env(templates=True) as (_, _tdir, make):
        c = make()
        sections = _templates(c)["dataset_spec"]["sections"]
        draft = c.post(
            "/api/authoring/ai-draft",
            json={
                "template_id": "dataset_spec",
                "title": "Датасет для сценария",
                "request": "Опиши датасет альфа",
            },
        ).json()
        body = draft.get("body", "")
        p.expect(all(f"## {s}" in body for s in sections), "AI draft does not follow the registry template")


@scenario("template_required_section_only_for_new_docs")
def _template_required(p: Problems) -> None:
    with _env(templates=True) as (_, tdir, make):
        c = make()
        assert tdir is not None
        t = _templates(c)["dataset_spec"]
        body = "\n\n".join(f"## {s}\nТекст раздела «{s}»." for s in t["sections"])
        meta = {"id": t["suggested_id"], "title": "Проверка", "owner": "t", "tags": []}
        _bump(tdir, "dataset.md")
        c.post("/api/index/sync")
        new = c.post(
            "/api/authoring/check", json={"template_id": "dataset_spec", "metadata": meta, "body": body}
        ).json()
        old = c.post(
            "/api/authoring/check",
            json={"template_id": "dataset_spec", "template_version": 1, "metadata": meta, "body": body},
        ).json()
        p.expect(
            "template_section_missing" in {i["code"] for i in new["validation"]}, "new docs not checked by v2"
        )
        p.expect("template_section_missing" not in {i["code"] for i in old["validation"]}, "v1 check uses v2")


@scenario("template_registry_restart")
def _template_restart(p: Problems) -> None:
    with _env(templates=True) as (_, tdir, make):
        make()
        assert tdir is not None
        _bump(tdir, "team_process.md", extra_section="Метрики", bump=False)
        restarted = make()  # a new process on the same state
        versions = _templates(restarted)["team_process"]
        p.expect(
            versions["version"] == 2 and versions["previous_versions"] == [1], f"after restart {versions}"
        )
