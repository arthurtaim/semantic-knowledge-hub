"""Synthetic read-backs for reports/chat-work-skills/02_WORKFLOWS.md (in-process app, scripted model, temp dirs)."""
import json, pathlib, shutil, tempfile, sys
sys.path.insert(0, ".")  # run from backend/: ../.venv/bin/python ../reports/chat-work-skills/workflows_evidence.py
from fastapi.testclient import TestClient
from pydantic import SecretStr
from app.config import Settings
from app.main import create_app
from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider
from app.work import store
from tests.support.scripted_model import Recorder, openai_transport

tmp = pathlib.Path(tempfile.mkdtemp())
kb = tmp / "kb"; shutil.copytree("../fixtures/knowledge", kb)
s = Settings(_env_file=None, app_env="test", project_root=tmp, local_knowledge_dir=kb,
             fixtures_dir=pathlib.Path("../fixtures/knowledge"), seed_fixtures=False,
             search_index_path=tmp/"w"/"s.sqlite3", app_state_path=tmp/"w"/"a.sqlite3",
             publication_state_path=tmp/"w"/"p.sqlite3", work_state_path=tmp/"w"/"work.sqlite3",
             repository_refresh_seconds=0.0, ai_provider="mock", confluence_connector="disabled")
app = create_app(s)
out = []
def p(*a): out.append(" ".join(str(x) for x in a))
with TestClient(app, base_url="http://localhost", headers={"X-SKH-Client": "e2e"}) as c:
    con = app.state.container
    prov = OpenAICompatibleAIProvider(base_url="https://ai.example.test/v1", model="scripted", api_key=SecretStr(""),
        timeout_seconds=10, allowed_hosts=["ai.example.test"], transport=openai_transport(Recorder()), instructions=con.instructions)
    con.assistant._provider = prov; con.work_ai._ai = prov; con.work_changes._ai = prov
    def state(key):
        with con.work.db.read() as conn:
            pr = store.get_project_by_key(conn, key)
            return {"tasks": conn.execute("SELECT COUNT(*) FROM work_tasks WHERE project_id=?", (pr["id"],)).fetchone()[0],
                    "plan_revision": pr["plan_revision"], "audit": store.count_audit(conn)}
    # chat -> WAP -> apply
    p("### Чат → план задач (WAP) → проверка → «Создать задачи»"); p("")
    p("- до:", json.dumps(state("ARIS")))
    r = c.post("/api/assistant/ask", json={"question": "Подготовь задачи по архитектуре", "skill_id": "draft_task_plan",
        "context_document_ids": ["SEM-ARCH-001"], "work_context": {"project_key": "ARIS", "client_request_id": "evidence-0001"}}).json()
    ref = r["work_proposal"]; p("- ответ чата: `work_proposal` =", json.dumps(ref, ensure_ascii=False))
    p("- после ответа:", json.dumps(state("ARIS")), "(задачи не созданы; +1 событие аудита `proposal_created`)")
    w = c.get(f"/api/work-ai/proposals/{ref['id']}").json()
    p("- проверка в проекте: state =", w["state"], "· задач", len(w["tasks"]), "· зависимостей", len(w["dependencies"]), "· источники", [x["document_id"] for x in w["sources"]])
    a = c.post(f"/api/work-ai/proposals/{ref['id']}/apply", json={"expected_plan_revision": w["base_plan_revision"], "client_request_id": "evidence-apply-1"}).json()
    p("- «Создать задачи»: создано", len(a["created_tasks"]), "задач,", a["created_dependencies"], "зависимостей,", a["created_links"], "связей; ревизия плана", a["plan_revision"])
    p("- после применения:", json.dumps(state("ARIS")))
    again = c.post(f"/api/work-ai/proposals/{ref['id']}/apply", json={"expected_plan_revision": w["base_plan_revision"], "client_request_id": "evidence-apply-1"}).json()
    p("- повтор того же подтверждения: replayed =", again["replayed"], "·", json.dumps(state("ARIS")))
    p("")
    # chat -> WCP -> selective apply
    p("### Чат → изменения задач (WCP) → снять один пункт → «Применить изменения»"); p("")
    def t(k):
        x = c.get(f"/api/tasks/{k}").json(); return {"key": k, "status": x["status"], "priority": x["priority"], "due": x["due_date"], "version": x["version"], "start": x["start_date"], "end": x["end_exclusive"]}
    p("- до:", json.dumps([t("ARIS-6"), t("ARIS-8"), t("ARIS-14")], ensure_ascii=False), json.dumps(state("ARIS")))
    r = c.post("/api/assistant/ask", json={"question": "ARIS-6 на ревью, ARIS-8 высокий приоритет, ARIS-14 срок 2027-01-20",
        "skill_id": "propose_task_changes", "work_context": {"project_key": "ARIS"}}).json()
    p("- ответ чата (текст):"); p("```"); p(r["answer"]); p("```")
    ref = r["work_proposal"]; wcp = c.get(f"/api/work-ai/change-proposals/{ref['id']}").json()
    p("- после ответа (задачи не изменены):", json.dumps(state("ARIS")))
    keep = [x["operation_id"] for x in wcp["changes"] if x["task_key"] != "ARIS-14"]
    res = c.post(f"/api/work-ai/change-proposals/{ref['id']}/apply", json={"operation_ids": keep, "expected_plan_revision": wcp["base_plan_revision"], "client_request_id": "evidence-wcp-1"}).json()
    p("- применено операций:", res["applied_operations"], "· задачи:", [x["key"] for x in res["updated_tasks"]], "· ревизия плана", res["plan_revision"])
    p("- после:", json.dumps([t("ARIS-6"), t("ARIS-8"), t("ARIS-14")], ensure_ascii=False), json.dumps(state("ARIS")))
    acts = c.get("/api/tasks/ARIS-6/activity").json()["items"][0]
    p("- аудит ARIS-6:", json.dumps({k: acts[k] for k in ("operation", "changes", "correlation_id")}, ensure_ascii=False))
    p("")
    # stale
    p("### Устаревший change-set"); p("")
    r = c.post("/api/work-ai/change-proposals", json={"project_id": "ARIS", "request": "ARIS-12 высокий приоритет"}).json()
    x = c.get("/api/tasks/ARIS-11").json(); c.patch("/api/tasks/ARIS-11", json={"title": "Правка вручную", "expected_version": x["version"]})
    before = state("ARIS"); g = c.get(f"/api/work-ai/change-proposals/{r['id']}").json()
    ap = c.post(f"/api/work-ai/change-proposals/{r['id']}/apply", json={"operation_ids": ["op1"], "expected_plan_revision": r["base_plan_revision"], "client_request_id": "evidence-stale-1"})
    p("- после ручной правки другой задачи: state =", g["state"], g["stale_reasons"], "· apply →", ap.status_code, ap.json()["code"], ap.json()["details"], "· состояние не изменилось:", state("ARIS") == before)
    p("")
    # analysis (scripted)
    p("### Анализ проекта"); p("")
    r = c.post("/api/assistant/ask", json={"question": "Какие задачи просрочены?", "skill_id": "analyze_project", "work_context": {"project_key": "RAG"}}).json()
    p("- ответ:", r["answer"]); f = r["system_facts"][0]
    p("- факт:", json.dumps({k: f[k] for k in ("ref", "source", "operation", "label", "value", "effective_filters")}, ensure_ascii=False))
print("\n".join(out))
