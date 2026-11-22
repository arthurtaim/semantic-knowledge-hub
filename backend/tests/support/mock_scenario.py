"""Scripted full scenario for the `integration_mock` Docker profile (`make mock-e2e`).

Runs INSIDE the internal Docker network against the real backend container and the stateful TEST
DOUBLES. It proves the integrated application flow as modelled by the doubles — not the behaviour of
real GitLab/Confluence. Unique IDs per run, so repeated runs never collide with earlier state.

    new document draft → review → GitLab MR → merge (double) → sync + FTS → publication dry-run (no
    writes) → create page → approved update → same page, version 2 → manual edit → conflict →
    corporate answer via MCP with provenance
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any

import httpx


class ScenarioError(AssertionError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise ScenarioError(message)


class Runner:
    def __init__(self, backend: str, gitlab: str, confluence: str) -> None:
        # The backend accepts loopback Host headers only (local_demo); the scenario speaks as localhost.
        self.api = httpx.Client(
            base_url=backend, headers={"Host": "localhost", "X-SKH-Client": "mock-scenario"}, timeout=30
        )
        self.gitlab = httpx.Client(base_url=gitlab, timeout=10)
        self.confluence = httpx.Client(base_url=confluence, timeout=10)
        self.step_no = 0

    def step(self, title: str) -> None:
        self.step_no += 1
        print(f"[{self.step_no:02d}] {title}", flush=True)

    def call(self, method: str, path: str, expected: int = 200, **kwargs: Any) -> Any:
        response = self.api.request(method, path, **kwargs)
        check(
            response.status_code == expected,
            f"{method} {path}: HTTP {response.status_code} {response.text[:300]}",
        )
        return response.json() if response.content else None

    def writes(self) -> int:
        return int(self.confluence.get("/__mock__/state").json()["write_requests"])

    def merge(self, proposal_id: str) -> dict[str, Any]:
        self.call("POST", f"/api/drafts/{proposal_id}/mark-ready")
        submitted = self.call("POST", f"/api/drafts/{proposal_id}/submit")
        check(submitted["status"] == "submitted_to_gitlab", f"submit: {submitted['status']}")
        iid = submitted["merge_request"]["iid"]
        merged = self.gitlab.post(f"/__mock__/merge-requests/{iid}/merge")
        check(merged.status_code == 200, f"merge in double: {merged.text}")
        detail: dict[str, Any] = self.call("POST", f"/api/drafts/{proposal_id}/refresh-status")
        check(
            detail["status"] == "merged" and bool(detail["merged_revision"]),
            f"after merge: {detail['status']}",
        )
        return detail

    def latest_job(self, doc_id: str) -> dict[str, Any]:
        status = self.call("GET", f"/api/documents/{doc_id}/publication")
        check(status["latest_job"] is not None, "no publication job")
        job: dict[str, Any] = self.call("GET", f"/api/publications/jobs/{status['latest_job']['id']}")
        return job

    def update(self, doc_id: str, text: str) -> None:
        doc = self.call("GET", f"/api/documents/{doc_id}")
        created = self.call(
            "POST",
            "/api/drafts",
            expected=201,
            json={
                "document_id": doc_id,
                "base_revision": doc["revision"],
                "proposed_content": doc["raw"].rstrip("\n") + f"\n\n{text}\n",
                "reason": "Изменение из сценария integration_mock",
            },
        )
        self.merge(created["id"])

    def run(self) -> None:
        stamp = time.strftime("%Y%m%d%H%M%S")
        doc_id, title = f"SEM-E2E-{stamp}", f"Сценарий integration_mock {stamp}"

        self.step("Статусы интеграций: все цели — объявленные тестовые дубли")
        items = {i["name"]: i for i in self.call("GET", "/api/integrations/status")["items"]}
        for name, access in (
            ("gitlab_knowledge", "read"),
            ("gitlab_proposals", "write"),
            ("confluence_publisher", "read_write"),
        ):
            check(items[name]["state"] == "connected", f"{name}: {items[name]['human_readable_message']}")
            check((items[name]["target"], items[name]["access"]) == ("mock", access), f"{name} labels")
        check(
            items["confluence_mcp"]["state"] == "connected", items["confluence_mcp"]["human_readable_message"]
        )

        self.step(f"Новый документ {doc_id}: шаблон → черновик (persisted)")
        template = next(t for t in self.call("GET", "/api/authoring/templates") if t["id"] == "architecture")
        draft = self.call(
            "POST",
            "/api/authoring/drafts",
            expected=201,
            json={
                "template_id": "architecture",
                "metadata": {"id": doc_id, "title": title, "owner": "semantic-team", "status": "approved"},
                "body": f"# {title}\n\nМаркер{stamp} для поиска.\n\n{template['skeleton']}",
                "reason": "Документ из сценария integration_mock",
            },
        )
        check(draft["operation"] == "create" and draft["status"] == "draft", "draft state")
        check(
            self.api.get(f"/api/documents/{doc_id}").status_code == 404, "a draft must not be in the catalog"
        )

        self.step("Ревью → ветка + create-коммит + MR → merge в GitLab-дубле → синхронизация")
        writes_before = self.writes()
        merged = self.merge(draft["id"])
        doc = self.call("GET", f"/api/documents/{doc_id}")
        check(doc["revision"] == merged["merged_revision"] and doc["source"] == "gitlab", "synced revision")
        hits = self.call("GET", "/api/search", params={"q": f"Маркер{stamp}"})["items"]
        check([h["id"] for h in hits] == [doc_id], f"FTS after merge: {hits}")

        self.step("Задание публикации создано после merge; dry-run без записи в Confluence")
        job = self.latest_job(doc_id)
        check(job["state"] == "dry_run_ready" and job["plan"]["action"] == "create", f"job: {job['state']}")
        check(self.writes() == writes_before, "dry-run must not write to Confluence")

        self.step("Публикация: создана одна страница с меткой владельца")
        published = self.call("POST", f"/api/publications/jobs/{job['id']}/publish")
        check(
            published["state"] == "published" and published["version_after"] == 1,
            f"publish: {published['state']}",
        )
        page_id = published["page_id"]
        pages = self.confluence.get("/__mock__/state").json()["pages"]
        page = next(p for p in pages if p["id"] == page_id)
        check(page["properties"]["skh-managed-document"]["document_id"] == doc_id, "ownership marker")

        self.step("Утверждённое изменение → та же страница, версия 2")
        self.update(doc_id, "Вторая утверждённая ревизия.")
        job = self.latest_job(doc_id)
        check(job["plan"]["action"] == "update", f"plan: {job['plan']['action']}")
        second = self.call("POST", f"/api/publications/jobs/{job['id']}/publish")
        check(second["page_id"] == page_id and second["version_after"] == 2, "update of the same page")

        self.step("Ручная правка в Confluence → конфликт, перезаписи нет")
        self.confluence.post(f"/__mock__/pages/{page_id}/edit", json={})
        self.update(doc_id, "Третья ревизия после ручной правки.")
        job = self.latest_job(doc_id)
        check(
            job["state"] == "conflict" and job["plan"]["diff_kind"] == "manual_edit",
            f"conflict: {job['state']}",
        )
        refused = self.api.post(f"/api/publications/jobs/{job['id']}/publish")
        check(refused.status_code == 409, "publish of a conflict must be refused")

        self.step("Корпоративный ответ через Confluence MCP (только чтение) с провенансом")
        answer = self.call(
            "POST",
            "/api/assistant/ask",
            json={"question": "Где хранится каноническая база знаний команды?", "sources": ["corporate"]},
        )
        corporate = [c for c in answer["citations"] if c["source_type"] == "confluence"]
        check(bool(corporate) and corporate[0]["revision"], f"corporate citations: {answer['citations']}")
        print(
            f"\nOK: сценарий integration_mock пройден ({self.step_no} шагов). Это проверка на тестовых дублях."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Full scenario against the integration_mock Docker profile.")
    parser.add_argument("--backend", required=True)
    parser.add_argument("--gitlab", required=True)
    parser.add_argument("--confluence", required=True)
    args = parser.parse_args()
    runner = Runner(args.backend, args.gitlab, args.confluence)
    for _ in range(30):  # the backend may still be starting
        try:
            if runner.api.get("/api/health").status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(1)
    try:
        runner.run()
    except (ScenarioError, httpx.HTTPError) as exc:
        print(f"\nFAILED на шаге {runner.step_no}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
