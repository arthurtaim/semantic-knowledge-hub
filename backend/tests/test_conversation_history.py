"""Assistant chat history (the reported defect «история чата не сохраняется»): each completed, server-validated turn of
a conversation is stored per user AND browser (`X-SKH-Browser`) in the app-state SQLite, so the dialog can be
reopened without asking again (docs/API_CONTRACTS.md v0.7, docs/SECURITY.md «Chat history»).

The final AskResponse is stored exactly as it was sent; reading re-checks the reader's access to every document the
answer relies on (a hidden source withholds the answer, never shows it), says when the index generation changed,
and never leaks another browser's or user's conversations (404 like an unknown id)."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from app.adapters.ai.base import AIProviderError
from app.api.assistant import ask_stream
from app.domain.models import AskRequest, UserContext
from app.services.conversations import ConversationLimits, ConversationStore
from tests.conftest import write_doc
from tests.test_assistant_tools import FIXTURE, ScopedRepository, render

BROWSER = "0123456789abcdef0123456789abcdef"
OTHER_BROWSER = "fedcba9876543210fedcba9876543210"
CONV = "conv-history-0001"
QUESTION = "Где хранится каноническая база знаний команды?"
H = {"X-SKH-Browser": BROWSER}


def csv_bytes() -> bytes:
    """A synthetic ARIS export (two rows)."""
    return (
        "aris_object_guid;aris_object_name;aris_owner_role\n"
        "guid-demo-9101;Синтетический процесс;process-owner-demo\n"
        "guid-demo-9102;Синтетическая модель;model-owner-demo\n"
    ).encode()


GUEST = UserContext(user_id="local-demo-user", display_name="Guest", roles=["reader", "editor"])
OWNER = UserContext(user_id="local-demo-user", display_name="Owner", roles=["reader", "editor", "restricted"])


def ask(
    client: TestClient, question: str = QUESTION, *, headers: dict[str, str] | None = H, **body: Any
) -> dict[str, Any]:
    payload = {"question": question, "conversation_id": CONV, **body}
    response = client.post("/api/assistant/ask", json=payload, headers=headers or {})
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def stream(client: TestClient, question: str = QUESTION, **body: Any) -> list[dict[str, Any]]:
    payload = {"question": question, "conversation_id": CONV, **body}
    response = client.post("/api/assistant/ask/stream", json=payload, headers=H)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def listing(client: TestClient, headers: dict[str, str] | None = H, **params: Any) -> dict[str, Any]:
    response = client.get("/api/assistant/conversations", params=params, headers=headers or {})
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def conversation(
    client: TestClient, conversation_id: str = CONV, headers: dict[str, str] | None = H
) -> dict[str, Any]:
    response = client.get(f"/api/assistant/conversations/{conversation_id}", headers=headers or {})
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def state_rows(client: TestClient, sql: str) -> list[tuple[Any, ...]]:
    path = client.app.state.container.settings.app_state_file  # type: ignore[attr-defined]
    with sqlite3.connect(path) as conn:
        return list(conn.execute(sql).fetchall())


# --- storing --------------------------------------------------------------------------------------------------


def test_ask_stores_the_completed_turn_as_sent(client: TestClient) -> None:
    sent = ask(client)
    items = listing(client)
    assert items["enabled"] is True and items["retention_days"] == 30
    [summary] = items["items"]
    assert summary["id"] == CONV and summary["title"] == QUESTION and summary["origin"] == "dialog"
    assert summary["turn_count"] == 1 and summary["last_status"] == "done"
    assert summary["last_sources"] == len(sent["citations"]) > 0

    stored = conversation(client)
    [turn] = stored["turns"]
    assert turn["seq"] == 1 and turn["status"] == "done" and turn["withheld"] is None
    # Exactly what the client got: answer, citations, provenance, mode, generation.
    assert turn["response"] == sent
    assert turn["request"] == {
        "question": QUESTION,
        "skill": None,
        "sources": ["team"],
        "include_drafts": False,
        "include_deprecated": False,
        "search_external": False,
        "documents": [],
        "attachments": [],
        "selection": None,
        "work": None,  # M7 (additive): a work skill's project / tasks / proposal references
    }
    assert turn["generation_changed"] is False and turn["notes"] == []
    assert stored["index_generation"] == sent["index_generation"]


def test_stream_stores_the_final_answer(client: TestClient) -> None:
    events = stream(client)
    final = next(e["response"] for e in events if e["type"] == "final")
    [turn] = conversation(client)["turns"]
    assert turn["response"] == final


def test_follow_ups_append_in_order_and_keep_the_title(client: TestClient) -> None:
    ask(client)
    ask(client, "Что такое ревизия документа?")
    stored = conversation(client)
    assert [t["request"]["question"] for t in stored["turns"]] == [QUESTION, "Что такое ревизия документа?"]
    assert [t["seq"] for t in stored["turns"]] == [1, 2]
    assert stored["title"] == QUESTION and stored["turn_count"] == 2


def test_nothing_is_stored_without_a_browser_id_or_a_conversation_id(client: TestClient) -> None:
    ask(client, headers={})  # no browser id
    ask(client, headers={"X-SKH-Browser": "not-a-browser-id"})  # invalid: treated as absent
    response = client.post("/api/assistant/ask", json={"question": QUESTION}, headers=H)  # no conversation id
    assert response.status_code == 200
    assert listing(client)["items"] == []
    assert state_rows(client, "SELECT COUNT(*) FROM assistant_turns") == [(0,)]


def test_input_errors_store_nothing(client: TestClient) -> None:
    response = client.post(
        "/api/assistant/ask",
        json={"question": "", "skill_id": "explain", "conversation_id": CONV},
        headers=H,
    )
    assert response.status_code == 422
    assert listing(client)["items"] == []


def test_the_request_context_is_stored_without_contents(client: TestClient) -> None:
    upload = client.post(
        "/api/assistant/attachments",
        data={"conversation_id": CONV},
        files={"file": ("aris_mapping.csv", csv_bytes(), "text/csv")},
    )
    assert upload.status_code == 201, upload.text
    attachment = upload.json()
    sent = ask(
        client,
        "Сравни поля выгрузки с документом ARIS",
        skill_id="compare_with_file",
        attachment_ids=[attachment["id"]],
        context_document_ids=["SEM-INT-ARIS-001"],
    )
    [turn] = conversation(client)["turns"]
    request = turn["request"]
    assert request["skill"] == {"id": "compare_with_file", "name": "Сравнить с файлом", "access": "read"}
    assert request["documents"] == [{"id": "SEM-INT-ARIS-001", "title": request["documents"][0]["title"]}]
    [stored_file] = request["attachments"]
    assert stored_file["id"] == attachment["id"] and stored_file["name"] == "aris_mapping.csv"
    assert stored_file["available"] is True and stored_file["size"] == attachment["size"]
    assert turn["response"] == sent
    # Only the answer as sent: never the file's text beyond what the answer quotes, never the prompt.
    raw = " ".join(str(r) for r in state_rows(client, "SELECT request_json FROM assistant_turns"))
    assert "guid-" not in raw and "units" not in raw


# --- ownership: per user and browser ----------------------------------------------------------------------------


def test_another_browser_or_user_sees_nothing_and_gets_the_same_404(client: TestClient) -> None:
    ask(client)
    other = {"X-SKH-Browser": OTHER_BROWSER}
    assert listing(client, headers=other)["items"] == []
    assert listing(client, headers={})["items"] == []
    foreign = client.get(f"/api/assistant/conversations/{CONV}", headers=other)
    unknown = client.get("/api/assistant/conversations/conv-never-existed", headers=H)
    missing_header = client.get(f"/api/assistant/conversations/{CONV}")
    assert foreign.status_code == unknown.status_code == missing_header.status_code == 404
    assert foreign.json()["code"] == unknown.json()["code"] == "conversation_not_found"
    assert foreign.json()["message"] == unknown.json()["message"]
    # The same conversation id from another browser is a separate conversation, never the first one's.
    client.post(
        "/api/assistant/ask",
        json={"question": "Что такое ревизия документа?", "conversation_id": CONV},
        headers=other,
    )
    assert [t["request"]["question"] for t in conversation(client, headers=other)["turns"]] == [
        "Что такое ревизия документа?"
    ]
    assert [t["request"]["question"] for t in conversation(client)["turns"]] == [QUESTION]

    container: Any = client.app.state.container  # type: ignore[attr-defined]
    container.demo_user = lambda: UserContext(user_id="someone-else", display_name="Другой", roles=["reader"])
    assert listing(client)["items"] == []
    assert client.get(f"/api/assistant/conversations/{CONV}", headers=H).status_code == 404


def test_malformed_ids_are_rejected(client: TestClient) -> None:
    assert client.get("/api/assistant/conversations/..%2F..%2Fetc", headers=H).status_code in (404, 422)
    assert client.get("/api/assistant/conversations/x", headers=H).status_code == 422
    assert client.get("/api/assistant/conversations?limit=0", headers=H).status_code == 422
    assert client.get("/api/assistant/conversations?origin=elsewhere", headers=H).status_code == 422


# --- delete and clear -----------------------------------------------------------------------------------------------


def test_delete_one_and_clear_all_for_this_browser(client: TestClient) -> None:
    upload = client.post(
        "/api/assistant/attachments",
        data={"conversation_id": CONV},
        files={"file": ("aris_mapping.csv", csv_bytes(), "text/csv")},
    ).json()
    ask(client, "Что в этой выгрузке?", attachment_ids=[upload["id"]])
    ask(client, conversation_id="conv-history-0002")
    other = {"X-SKH-Browser": OTHER_BROWSER}
    client.post(
        "/api/assistant/ask",
        json={"question": QUESTION, "conversation_id": "conv-history-0003"},
        headers=other,
    )

    assert client.delete(f"/api/assistant/conversations/{CONV}", headers=H).status_code == 204
    assert client.delete(f"/api/assistant/conversations/{CONV}", headers=H).status_code == 204  # idempotent
    assert client.get(f"/api/assistant/conversations/{CONV}", headers=H).status_code == 404
    # The dialog's files went with it.
    gone = client.post(
        "/api/assistant/ask",
        json={"question": "Что в этой выгрузке?", "conversation_id": CONV, "attachment_ids": [upload["id"]]},
        headers=H,
    )
    assert gone.status_code == 404 and gone.json()["code"] == "attachment_not_found"
    # Another browser cannot delete this browser's conversation.
    assert client.delete("/api/assistant/conversations/conv-history-0002", headers=other).status_code == 204
    assert [c["id"] for c in listing(client)["items"]] == ["conv-history-0002"]

    cleared = client.delete("/api/assistant/conversations", headers=H)
    assert cleared.status_code == 200 and cleared.json() == {"deleted": 1}
    assert listing(client)["items"] == []
    assert [c["id"] for c in listing(client, headers=other)["items"]] == ["conv-history-0003"]


# --- reading re-checks access and freshness --------------------------------------------------------------------------


@pytest.fixture
def scoped_client(client_factory: Callable[..., TestClient], tmp_path: Path) -> TestClient:
    root = tmp_path / "history-kb"
    root.mkdir()
    for spec in FIXTURE:
        (root / f"{spec.id}.md").write_text(render(spec), encoding="utf-8")
    client = client_factory(local_knowledge_dir=root)
    container: Any = client.app.state.container  # type: ignore[attr-defined]
    container.knowledge._repository = ScopedRepository(container.knowledge._repository)
    container.demo_user = lambda: OWNER
    return client


def test_a_citation_the_reader_can_no_longer_see_is_withheld(scoped_client: TestClient) -> None:
    sent = ask(scoped_client, "Какой закрытый план переноса ARIS?")
    assert "M57-SEC-001" in {c["document_id"] for c in sent["citations"]}
    assert conversation(scoped_client)["turns"][0]["response"] == sent  # the owner still sees it

    scoped_client.app.state.container.demo_user = lambda: GUEST  # type: ignore[attr-defined]
    stored = conversation(scoped_client)
    [turn] = stored["turns"]
    assert turn["status"] == "done" and turn["withheld"] == "sources_unavailable"
    assert turn["response"] is None
    assert turn["request"]["question"] == "Какой закрытый план переноса ARIS?"  # the reader's own words stay
    assert turn["notes"] == [
        "Ответ скрыт: часть его источников вам сейчас недоступна. Задайте вопрос заново — ответ будет построен "
        "по доступным документам."
    ]
    dump = json.dumps(stored, ensure_ascii=False)
    assert "M57-SEC-001" not in dump and "Секретный" not in dump and "Закрытый план" not in dump
    summary = listing(scoped_client)["items"][0]
    assert "M57-SEC-001" not in json.dumps(summary, ensure_ascii=False)


def test_hidden_documents_named_by_facts_or_chosen_as_context_withhold_too(scoped_client: TestClient) -> None:
    container: Any = scoped_client.app.state.container  # type: ignore[attr-defined]
    service = container.conversations
    ask(scoped_client, "Что такое формат обмена?", context_document_ids=["M57-SEC-001"])
    [turn] = conversation(scoped_client)["turns"]
    assert turn["request"]["documents"][0]["id"] == "M57-SEC-001"

    # A stored answer whose only evidence is a system fact listing the restricted document.
    handle = service.begin_raw(OWNER, BROWSER, "conv-history-facts", question="Какие документы про ARIS?")
    fact_answer = {
        **turn["response"],
        "citations": [],
        "system_facts": [
            {
                "ref": "F1",
                "tool": "catalog_query",
                "operation": "list",
                "label": "Документы",
                "value": 2,
                "source": "skh_document_registry",
                "as_of": "2026-11-24T10:00:00Z",
                "items": [
                    {"id": "M57-SRC-001", "title": "Источник", "kind": "document"},
                    {"id": "M57-SEC-001", "title": "Секретный план миграции ARIS", "kind": "document"},
                ],
            }
        ],
    }
    service.finish(handle, fact_answer)

    container.demo_user = lambda: GUEST
    [chosen] = conversation(scoped_client)["turns"]
    assert chosen["withheld"] == "sources_unavailable" and chosen["request"]["documents"] == []
    [facts] = conversation(scoped_client, "conv-history-facts")["turns"]
    assert facts["withheld"] == "sources_unavailable" and facts["response"] is None
    assert "Секретный" not in json.dumps(facts, ensure_ascii=False)


def test_a_changed_index_generation_is_said_not_silently_re_answered(
    client: TestClient, workspace: Path
) -> None:
    sent = ask(client)
    write_doc(
        workspace,
        "SEM-NEW-001.md",
        "---\nid: SEM-NEW-001\ntitle: Новый документ\ntype: process\nstatus: approved\nowner: team\n"
        "tags: [demo]\nsynthetic: true\nreviewed_at: 2026-11-01\n---\n\n# Новый документ\n\nТекст.\n",
    )
    assert client.post("/api/index/sync").status_code == 200
    stored = conversation(client)
    [turn] = stored["turns"]
    before, now = sent["index_generation"], stored["index_generation"]
    assert before != now
    assert (
        turn["response"] == sent
        and turn["generation_changed"] is True
        and turn["answer_generation"] == before
    )
    assert turn["notes"] == [f"Ответ дан по поколению {before}; база с тех пор обновлена (сейчас {now})."]


# --- failures, interruptions and limits ------------------------------------------------------------------------------


def test_a_model_failure_is_stored_as_a_failed_turn_and_replaced_by_the_retry(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    container: Any = client.app.state.container  # type: ignore[attr-defined]
    real = container.assistant.ask

    async def failing(*args: Any, **kwargs: Any) -> Any:
        raise AIProviderError("ai_timeout", "Модель не ответила за отведённое время.")

    monkeypatch.setattr(container.assistant, "ask", failing)
    failed = client.post(
        "/api/assistant/ask", json={"question": QUESTION, "conversation_id": CONV}, headers=H
    )
    assert failed.status_code == 504 or failed.status_code >= 500
    [turn] = conversation(client)["turns"]
    assert turn["status"] == "failed" and turn["response"] is None
    assert turn["error"] == {
        "code": "ai_timeout",
        "message": "Модель не ответила за отведённое время.",
        "status": failed.status_code,
    }
    assert listing(client)["items"][0]["last_status"] == "failed"

    monkeypatch.setattr(container.assistant, "ask", real)
    ask(client)  # the retry replaces the failed turn, as the dialog shows it
    turns = conversation(client)["turns"]
    assert [(t["seq"], t["status"]) for t in turns] == [(2, "done")]


def test_a_stream_error_event_is_stored_as_a_failed_turn(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    container: Any = client.app.state.container  # type: ignore[attr-defined]

    async def failing_stream(*args: Any, **kwargs: Any) -> Any:
        yield {"type": "status", "stage": "retrieving"}
        yield {"type": "error", "code": "ai_unavailable", "message": "Модель недоступна.", "status": 503}

    monkeypatch.setattr(container.assistant, "ask_stream", failing_stream)
    events = stream(client)
    assert events[-1]["type"] == "error"
    [turn] = conversation(client)["turns"]
    assert turn["status"] == "failed" and turn["error"]["code"] == "ai_unavailable"


def test_a_stream_closed_before_the_end_is_an_interrupted_turn(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The browser went away mid-answer (a reload, a closed tab): the generation is cancelled as before and the
    turn reads as interrupted — after a reload the dialog says «Ответ не был получен», it never re-runs."""
    container: Any = client.app.state.container  # type: ignore[attr-defined]

    async def endless(*args: Any, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
        yield {"type": "status", "stage": "retrieving"}
        await asyncio.sleep(3600)
        yield {"type": "status", "stage": "validating"}

    monkeypatch.setattr(container.assistant, "ask_stream", endless)

    class Headers:
        def __init__(self) -> None:
            self.headers = {"X-SKH-Browser": BROWSER}

    async def open_and_leave() -> bytes:
        response = await ask_stream(
            AskRequest(question=QUESTION, conversation_id=CONV),
            cast(Request, Headers()),
            container,
            container.demo_user(),
        )
        body = cast(Any, response.body_iterator)
        first = cast(bytes, await body.__anext__())
        await body.aclose()  # what a client disconnect does to the response body
        return first

    first = client.portal.call(open_and_leave)  # type: ignore[union-attr]
    assert json.loads(first) == {"type": "status", "stage": "retrieving"}
    [turn] = conversation(client)["turns"]
    assert turn["status"] == "interrupted" and turn["response"] is None and turn["error"] is None


def test_an_unfinished_turn_reads_as_interrupted_never_re_run(client: TestClient) -> None:
    container: Any = client.app.state.container  # type: ignore[attr-defined]
    service = container.conversations
    handle = service.begin_raw(container.demo_user(), BROWSER, CONV, question=QUESTION)
    [pending] = conversation(client)["turns"]
    assert pending["status"] == "pending" and pending["response"] is None
    service.interrupt(handle)
    [turn] = conversation(client)["turns"]
    assert turn["status"] == "interrupted" and turn["response"] is None and turn["error"] is None

    # A pending turn nobody finished (the process stopped) reads as interrupted after a while.
    service.begin_raw(container.demo_user(), BROWSER, "conv-history-stale", question=QUESTION)
    real_clock = service.clock
    service.clock = lambda: real_clock() + 3600
    [stale] = conversation(client, "conv-history-stale")["turns"]
    assert stale["status"] == "interrupted"


def test_limits_prune_the_oldest(client_factory: Callable[..., TestClient]) -> None:
    client = client_factory(assistant_history_max_turns=2, assistant_history_max_conversations=2)
    for question in ("Первый вопрос о базе", "Второй вопрос о базе", "Третий вопрос о базе"):
        ask(client, question)
    stored = conversation(client)
    assert [t["request"]["question"] for t in stored["turns"]] == [
        "Второй вопрос о базе",
        "Третий вопрос о базе",
    ]
    assert stored["title"] == "Первый вопрос о базе" and stored["turn_count"] == 2

    ask(client, conversation_id="conv-history-0002")
    ask(client, conversation_id="conv-history-0003")
    assert [c["id"] for c in listing(client)["items"]] == ["conv-history-0003", "conv-history-0002"]
    assert listing(client, limit=1)["items"][0]["id"] == "conv-history-0003"


def test_retention_purges_old_conversations(client: TestClient) -> None:
    ask(client)
    service: Any = client.app.state.container.conversations  # type: ignore[attr-defined]
    real_clock = service.clock
    service.clock = lambda: real_clock() + 31 * 86400
    assert listing(client)["items"] == []
    assert client.get(f"/api/assistant/conversations/{CONV}", headers=H).status_code == 404
    assert state_rows(client, "SELECT COUNT(*) FROM assistant_turns") == [(0,)]


def test_an_oversized_answer_is_not_stored_and_says_so(client_factory: Callable[..., TestClient]) -> None:
    client = client_factory(assistant_history_max_answer_kb=16)
    container: Any = client.app.state.container  # type: ignore[attr-defined]
    sent = ask(client)
    service = container.conversations
    handle = service.begin_raw(container.demo_user(), BROWSER, "conv-history-big", question=QUESTION)
    service.finish(handle, {**sent, "answer": "А" * 20_000})
    [turn] = conversation(client, "conv-history-big")["turns"]
    assert turn["status"] == "done" and turn["withheld"] == "too_large" and turn["response"] is None
    assert turn["notes"] == ["Ответ не сохранён в истории: он больше допустимого размера."]


def test_a_storage_failure_never_breaks_the_answer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    store: Any = client.app.state.container.conversations.store  # type: ignore[attr-defined]

    def locked(*args: Any, **kwargs: Any) -> Any:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(store, "begin_turn", locked)
    with caplog.at_level("WARNING", logger="skh.history"):
        sent = ask(client)
        events = stream(client)
    assert sent["answer"] and events[-1]["type"] == "final"
    assert "history turn not recorded: OperationalError" in caplog.text
    assert QUESTION not in caplog.text  # never the question or the answer in the log

    monkeypatch.undo()
    monkeypatch.setattr(store, "finish_turn", locked)
    assert ask(client)["answer"]
    [turn] = conversation(client)["turns"]
    assert turn["status"] == "pending"  # the answer was sent; only its record failed


def test_history_can_be_switched_off(client_factory: Callable[..., TestClient]) -> None:
    client = client_factory(assistant_history_enabled=False)
    ask(client)
    data = listing(client)
    assert data["enabled"] is False and data["items"] == []
    assert client.get(f"/api/assistant/conversations/{CONV}", headers=H).status_code == 404


def test_concurrent_appends_from_two_tabs_keep_a_strict_order(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    limits = ConversationLimits(max_turns=500)
    # Two connections, like two worker processes.
    tabs = [ConversationStore(path, limits), ConversationStore(path, limits)]
    seqs: list[int] = []
    lock = threading.Lock()

    def append(store: ConversationStore, n: int) -> None:
        for i in range(n):
            seq = store.begin_turn(
                "local-demo-user",
                BROWSER,
                CONV,
                origin="dialog",
                document_id=None,
                title=QUESTION,
                request={"question": f"q{i}"},
                now=1000.0 + i,
            )
            with lock:
                seqs.append(seq)

    threads = [threading.Thread(target=append, args=(tabs[i % 2], 25)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(seqs) == list(range(1, 101))  # unique, gap-free
    rows = tabs[0].turns("local-demo-user", BROWSER, CONV)
    assert [row.seq for row in rows] == list(range(1, 101))
    for store in tabs:
        store.close()
