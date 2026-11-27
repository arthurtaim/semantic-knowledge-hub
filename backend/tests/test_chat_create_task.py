"""«Создать задачу» in the chat (design 2026-11-27 §5.1–5.4): the create_task skill — chosen or auto-started — answers
with a task DRAFT and writes nothing; the task is created only by the regular task API (the card's button)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient

from tests.test_work_chat_skills import BROWSER, Factory, chat, counts, model_calls  # noqa: F401  (chat is a fixture)


def _client(chat: Factory, kind: str = "openai", **overrides: Any) -> tuple[TestClient, Any]:  # noqa: F811
    client, recorder = chat(kind, **overrides)
    client.app.state.container.work.now = lambda: datetime(2026, 11, 27, 9, 0, tzinfo=UTC)  # type: ignore[attr-defined]
    return client, recorder


def _ask(client: TestClient, question: str, skill: str | None = None, **extra: Any) -> Any:
    body: dict[str, Any] = {"question": question, **extra}
    if skill is not None:
        body["skill_id"] = skill
    return client.post("/api/assistant/ask", json=body)


def test_create_task_skill_in_the_catalog_and_available_in_mock(client_factory: Any) -> None:
    client = client_factory()  # mock provider
    items = {s["id"]: s for s in client.get("/api/assistant/skills").json()}
    skill = items["create_task"]
    assert (skill["name"], skill["access"], skill["available"], skill["work"]) == (
        "Создать задачу",
        "draft",
        True,
        True,
    )
    assert skill["requires"]["project"] is False


def test_unavailable_when_disabled(client_factory: Any) -> None:
    client = client_factory(ai_provider="disabled")
    items = {s["id"]: s for s in client.get("/api/assistant/skills").json()}
    assert items["create_task"]["available"] is False


def test_unavailable_read_only(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    items = {
        s["id"]: s for s in client.get("/api/assistant/skills", headers={"X-SKH-Exposure": "public"}).json()
    }
    assert items["create_task"]["available"] is False
    assert items["create_task"]["unavailable_reason"]


def test_manual_skill_returns_a_draft_and_writes_nothing(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    before = counts(client)
    response = _ask(client, "в проекте RAG обновить витрину до 5 декабря", "create_task")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["skill"]["id"] == "create_task"
    draft = body["task_draft"]
    assert draft["project_key"] == "RAG" and draft["due_date"] == "2026-12-05"
    assert draft["auto_started"] is False and draft["client_request_id"]
    assert "Создать задачу" in body["answer"]
    assert counts(client) == before


def test_auto_start_on_a_create_phrase(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    body = _ask(client, "создай задачу в проекте RAG обновить витрину").json()
    assert body["skill"]["id"] == "create_task"
    assert body["task_draft"]["auto_started"] is True
    assert body["task_draft"]["title"] == "Обновить витрину"


def test_auto_start_in_mock_mode(client_factory: Any) -> None:
    client = client_factory()
    body = client.post("/api/assistant/ask", json={"question": "создай задачу проверить индекс"}).json()
    assert body["task_draft"]["title"] == "Проверить индекс"
    assert body["task_draft"]["missing"] == ["project"]


def test_explicit_answer_skill_disables_auto_start(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    body = _ask(client, "создай задачу в проекте RAG обновить витрину", "answer").json()
    assert body.get("task_draft") is None


def test_attachments_disable_auto_start(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    upload = client.post(
        "/api/assistant/attachments",
        data={"conversation_id": "conv-create-task-01"},
        files={"file": ("note.txt", "Синтетическая заметка.".encode(), "text/plain")},
    )
    assert upload.status_code == 201, upload.text
    body = _ask(
        client,
        "создай задачу по файлу",
        attachment_ids=[upload.json()["id"]],
        conversation_id="conv-create-task-01",
    ).json()
    assert body.get("task_draft") is None


def test_question_does_not_auto_start(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    body = _ask(client, "как создать задачу в Jira?").json()
    assert body.get("task_draft") is None


def test_auto_start_with_a_document_in_context(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    body = _ask(client, "создай задачу описать стандарт", context_document_ids=["SEM-STD-001"]).json()
    assert [d["document_id"] for d in body["task_draft"]["documents"]] == ["SEM-STD-001"]


def test_auto_start_without_create_right_answers_normally(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    response = client.post(
        "/api/assistant/ask",
        json={"question": "создай задачу в проекте RAG обновить витрину"},
        headers={"X-SKH-Exposure": "public"},
    )
    assert response.status_code == 200, response.text
    assert response.json().get("task_draft") is None


def test_composer_project_is_resolved_like_other_work_skills(chat: Factory) -> None:  # noqa: F811
    client, recorder = _client(chat)
    client.post("/api/projects", json={"key": "OLD", "title": "Старый"})
    version = client.get("/api/projects/OLD").json()["version"]
    client.patch("/api/projects/OLD", json={"status": "archived", "expected_version": version})
    calls = model_calls(recorder)
    archived = _ask(client, "обновить витрину", "create_task", work_context={"project_key": "OLD"})
    hidden = _ask(client, "обновить витрину", "create_task", work_context={"project_key": "NOPE"})
    assert archived.status_code == 409 and hidden.status_code == 404
    assert model_calls(recorder) == calls


def test_words_never_create_a_task(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    before = counts(client)
    _ask(client, "создай задачу в проекте RAG обновить витрину")
    for words in ("да, создавай", "принимаю", "создай"):
        _ask(client, words)
    assert counts(client)["tasks"] == before["tasks"]


def test_stream_has_one_final_with_the_draft(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    with client.stream(
        "POST", "/api/assistant/ask/stream", json={"question": "создай задачу в проекте RAG обновить витрину"}
    ) as response:
        events = [json.loads(line) for line in response.iter_lines() if line.strip()]
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1 and not [e for e in events if e["type"] == "error"]
    assert finals[0]["response"]["task_draft"]["project_key"] == "RAG"


def test_history_keeps_the_draft(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    headers = {"X-SKH-Browser": BROWSER}
    question = {
        "question": "создай задачу в проекте RAG обновить витрину",
        "conversation_id": "conv-create-task-02",
    }
    response = client.post("/api/assistant/ask", json=question, headers=headers)
    assert response.status_code == 200, response.text
    stored = client.get("/api/assistant/conversations/conv-create-task-02", headers=headers).json()
    assert stored["turns"][-1]["response"]["task_draft"]["title"] == "Обновить витрину"


def test_creating_from_the_draft_uses_the_task_api(chat: Factory) -> None:  # noqa: F811
    client, _ = _client(chat)
    draft = _ask(
        client,
        "создай задачу в проекте RAG обновить витрину до 5 декабря",
        context_document_ids=["SEM-STD-001"],
    ).json()["task_draft"]
    body = {
        "title": draft["title"],
        "description": draft["description"],
        "priority": draft["priority"],
        "due_date": draft["due_date"],
        "client_request_id": draft["client_request_id"],
    }
    first = client.post("/api/projects/RAG/tasks", json=body)
    again = client.post("/api/projects/RAG/tasks", json=body)
    assert first.status_code == 201, first.text
    assert again.json()["id"] == first.json()["id"]  # a double click creates one task
    link = client.post(
        f"/api/tasks/{first.json()['id']}/links",
        json={
            "document_id": draft["documents"][0]["document_id"],
            "client_request_id": draft["client_request_id"],
        },
    )
    assert link.status_code == 201, link.text
