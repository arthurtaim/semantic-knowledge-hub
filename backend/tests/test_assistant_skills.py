"""UI v2 — assistant skills: registry per AI mode, server-side checks, skills on top of the M5.6.3 workflows
(nothing applied), chosen documents and selections as context (docs/ui-v2/specs/02_ASSISTANT.md §4–§6)."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.authz import Action
from app.domain.models import UserContext
from tests.test_assistant import provider

TABLE_ORDER = [
    "answer",
    "explain",
    "summarize",
    "check_completeness",
    "check_freshness",
    "find_related",
    "compare_with_file",
    "draft_document",
    "improve_section",
    "suggest_metadata",
    # M7 chat work skills (REG-01: 10 existing + 3 new)
    "analyze_project",
    "draft_task_plan",
    "propose_task_changes",
]
DESIGN_TEXTS = {
    "answer": ("Ответ по базе знаний", "Отвечает только по документам, с цитатами"),
    "draft_document": ("Черновик документа", "Подберёт шаблон и подготовит черновик на ревью"),
    "check_freshness": ("Что перепроверить", "Покажет связанные документы, которые могли устареть"),
    "find_related": ("Найти связи", "Покажет связанные документы и путь на карте знаний"),
    "compare_with_file": ("Сравнить с файлом", "Сверит вложение с утверждёнными документами"),
}


def skills(client: TestClient) -> dict[str, dict[str, Any]]:
    response = client.get("/api/assistant/skills")
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()
    assert [s["id"] for s in items] == TABLE_ORDER
    return {s["id"]: s for s in items}


def ask(client: TestClient, **payload: Any) -> dict[str, Any]:
    response = client.post("/api/assistant/ask", json=payload)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def use_internal_api(client: TestClient, content: str) -> list[dict[str, Any]]:
    """A non-mock provider (internal OpenAI-compatible API over a mock transport) for the whole app."""
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    fake = provider(handler)
    container: Any = client.app.state.container  # type: ignore[attr-defined]
    container.assistant._provider = fake
    container.ai_workflows._ai = fake
    container.authoring._ai = fake
    container.work_ai._ai = fake  # M7: the chat work skills use the work services' provider
    container.work_changes._ai = fake
    return sent


# --- registry -------------------------------------------------------------------------------------------------


def test_skill_registry_in_mock_mode(client: TestClient) -> None:
    items = skills(client)
    for skill_id, (name, description) in DESIGN_TEXTS.items():
        assert (items[skill_id]["name"], items[skill_id]["description"]) == (name, description)
    assert {s for s, v in items.items() if v["access"] == "draft"} == {
        "draft_document",
        "improve_section",
        "suggest_metadata",
        "draft_task_plan",
        "propose_task_changes",
    }
    unavailable = {s: v["unavailable_reason"] for s, v in items.items() if not v["available"]}
    # no honest deterministic mock path; the work analysis is a server summary, so it stays available
    assert list(unavailable) == ["improve_section", "draft_task_plan", "propose_task_changes"]
    assert unavailable["improve_section"] and "\n" not in unavailable["improve_section"]
    assert items["compare_with_file"]["requires"] == {
        "document": False,
        "selection": False,
        "attachment": True,
        "document_or_question": False,
        "project": False,
    }
    assert items["improve_section"]["requires"] == {
        "document": True,
        "selection": True,
        "attachment": False,
        "document_or_question": False,
        "project": False,
    }
    # «One of»: find_related runs on a document or on a question; only it declares that.
    assert items["find_related"]["requires"] == {
        "document": False,
        "selection": False,
        "attachment": False,
        "document_or_question": True,
        "project": False,
    }
    assert [s for s, v in items.items() if v["requires"]["document_or_question"]] == ["find_related"]
    assert items["answer"]["prompt_optional"] is False and items["summarize"]["prompt_optional"] is True
    assert all(v["unavailable_reason"] is None for v in items.values() if v["available"])


def test_skill_registry_with_ai_disabled(client_factory: Callable[..., TestClient]) -> None:
    items = skills(client_factory(ai_provider="disabled"))
    assert all(not v["available"] and v["unavailable_reason"] == "ИИ отключён" for v in items.values())


def test_skill_registry_with_a_model_provider(client: TestClient) -> None:
    use_internal_api(client, "{}")
    items = skills(client)
    assert all(v["available"] for v in items.values())


# --- server-side checks ---------------------------------------------------------------------------------------


def test_unknown_unavailable_and_disabled_skills(
    client: TestClient, client_factory: Callable[..., TestClient]
) -> None:
    unknown = client.post("/api/assistant/ask", json={"question": "Что такое слой?", "skill_id": "publish"})
    assert unknown.status_code == 422 and unknown.json()["code"] == "skill_unknown"
    improve = client.post(
        "/api/assistant/ask",
        json={
            "skill_id": "improve_section",
            "selection": {"document_id": "SEM-ARCH-001", "section_anchor": "principles", "text": ""},
        },
    )
    assert improve.status_code == 503 and improve.json()["code"] == "skill_unavailable"
    assert improve.json()["message"]
    disabled = client_factory(ai_provider="disabled").post(
        "/api/assistant/ask", json={"skill_id": "summarize", "context_document_ids": ["SEM-ARCH-001"]}
    )
    assert disabled.status_code == 503 and disabled.json()["code"] == "assistant_disabled"


def test_missing_skill_inputs(client: TestClient) -> None:
    summary = client.post("/api/assistant/ask", json={"skill_id": "summarize"})
    assert summary.status_code == 422 and summary.json()["code"] == "skill_input_missing"
    assert summary.json()["details"]["missing"] == ["document"]
    compare = client.post("/api/assistant/ask", json={"skill_id": "compare_with_file", "question": "Сверь"})
    assert compare.json()["details"]["missing"] == ["attachment"]
    related = client.post("/api/assistant/ask", json={"skill_id": "find_related"})
    assert related.status_code == 422 and related.json()["details"]["missing"] == ["document_or_question"]
    assert related.json()["message"] == "Для навыка «Найти связи» нужно: документ или вопрос."
    blank = client.post("/api/assistant/ask", json={"skill_id": "find_related", "question": "   "})
    assert blank.status_code == 422 and blank.json()["details"]["missing"] == ["document_or_question"]


def test_question_is_optional_only_for_skills_that_allow_it(client: TestClient) -> None:
    assert client.post("/api/assistant/ask", json={"question": ""}).status_code == 422
    assert client.post("/api/assistant/ask", json={"skill_id": "answer"}).status_code == 422
    assert (
        client.post("/api/assistant/ask", json={"skill_id": "draft_document", "question": "x"}).status_code
        == 422
    )
    ok = client.post(
        "/api/assistant/ask",
        json={"skill_id": "check_completeness", "context_document_ids": ["SEM-ARCH-001"]},
    )
    assert ok.status_code == 200


def test_chosen_documents_and_selections_are_checked(client: TestClient) -> None:
    unknown = client.post(
        "/api/assistant/ask", json={"question": "Что это за слой?", "context_document_ids": ["NOPE-404"]}
    )
    assert unknown.status_code == 404 and unknown.json()["code"] == "document_not_found"
    forged = client.post(
        "/api/assistant/ask",
        json={
            "skill_id": "explain",
            "selection": {"document_id": "SEM-ARCH-001", "text": "The bank runs seven hidden layers."},
        },
    )
    assert forged.status_code == 422 and forged.json()["code"] == "selection_not_found"
    wrong_anchor = client.post(
        "/api/assistant/ask",
        json={"skill_id": "explain", "selection": {"document_id": "SEM-ARCH-001", "section_anchor": "nope"}},
    )
    assert wrong_anchor.status_code == 422 and wrong_anchor.json()["code"] == "selection_not_found"


# --- ask-based skills -----------------------------------------------------------------------------------------


def test_answer_without_new_fields_is_unchanged(client: TestClient) -> None:
    answer = ask(client, question="What layers does the demonstration architecture have?")
    assert answer["skill"] is None and answer["proposal"] is None
    assert [c["document_id"] for c in answer["citations"]] == ["SEM-ARCH-001"]


def test_chosen_document_is_cited_first(client: TestClient) -> None:
    question = "Какой идентификатор у документа?"
    plain = ask(client, question=question)
    assert [c["document_id"] for c in plain["citations"]][:2] == ["SEM-GLOSS-001", "SEM-STD-001"]
    answer = ask(client, question=question, context_document_ids=["SEM-STD-001"], skill_id="answer")
    assert answer["skill"] == {"id": "answer", "name": "Ответ по базе знаний", "access": "read"}
    assert answer["citations"][0]["document_id"] == "SEM-STD-001"
    # Chosen but irrelevant: it is not forced into the answer.
    unrelated = ask(client, question=question, context_document_ids=["SEM-ARCH-001"])
    assert "SEM-ARCH-001" not in [c["document_id"] for c in unrelated["citations"]]


def test_model_providers_are_told_which_context_was_chosen(client: TestClient) -> None:
    sent = use_internal_api(
        client, '{"answer": "нет", "confidence": "insufficient_evidence", "citations": []}'
    )
    ask(client, question="Какой идентификатор у документа?", context_document_ids=["SEM-STD-001"])
    message = sent[0]["messages"][1]["content"]
    assert '"chosen": true' in message and "цитируй их первыми" in message
    first_meta = next(line for line in message.splitlines() if line.startswith('{"id": "C1"'))
    assert json.loads(first_meta)["document_id"] == "SEM-STD-001"
    plain = use_internal_api(
        client, '{"answer": "нет", "confidence": "insufficient_evidence", "citations": []}'
    )
    ask(client, question="Какой идентификатор у документа?")
    assert '"chosen"' not in plain[0]["messages"][1]["content"]  # unchanged prompt without chosen context


def test_explain_cites_the_selection_first(client: TestClient) -> None:
    selection = "Suggested changes require human review."
    answer = ask(
        client,
        skill_id="explain",
        selection={"document_id": "SEM-ARCH-001", "section_anchor": "principles", "text": selection},
    )
    first = answer["citations"][0]
    assert first["document_id"] == "SEM-ARCH-001" and first["section_anchor"] == "principles"
    assert selection in first["excerpt"]
    assert answer["proposal"] is None  # a read skill answered through the grounded pipeline


# --- workflow skills (M5.6.3), nothing applied ---------------------------------------------------------------


@pytest.fixture
def kb_client(client_factory: Callable[..., TestClient], full_workspace: Path) -> TestClient:
    return client_factory(local_knowledge_dir=full_workspace)


def assert_nothing_applied(client: TestClient) -> None:
    assert client.get("/api/drafts").json()["total"] == 0


def test_read_skills_return_a_proposal_reference(kb_client: TestClient) -> None:
    completeness = ask(kb_client, skill_id="check_completeness", context_document_ids=["DEMO-INT-014"])
    assert completeness["proposal"]["kind"] == "check_completeness"
    assert completeness["skill"]["access"] == "read" and completeness["answer"]
    stored = kb_client.get(f"/api/ai/proposals/{completeness['proposal']['id']}")
    assert stored.status_code == 200 and stored.json()["summary"] in completeness["answer"]
    freshness = ask(kb_client, skill_id="check_freshness", context_document_ids=["DEMO-SEM-002"])
    assert (
        freshness["proposal"]["kind"] == "impact_analysis" and freshness["proposal"]["status"] == "answered"
    )
    assert freshness["proposal"]["graph_link"].startswith("/graph?focus=DEMO-SEM-002")
    summary = ask(kb_client, skill_id="summarize", context_document_ids=["DEMO-INT-014"])
    assert summary["proposal"]["kind"] == "summarize"
    # the chosen synthetic document is the provenance of the result (metadata), not a fixed «only demo» warning
    assert summary["provenance"]["overall"] == "synthetic" and summary["provenance"]["synthetic"] >= 1
    assert not any("демо-документ" in w for w in summary["warnings"])
    assert_nothing_applied(kb_client)


def test_find_related_by_document_pair_or_question(kb_client: TestClient) -> None:
    single = ask(kb_client, skill_id="find_related", context_document_ids=["DEMO-INT-014"])
    assert single["proposal"]["kind"] == "find_related"
    pair = ask(kb_client, skill_id="find_related", context_document_ids=["DEMO-INT-001", "DEMO-SRC-002"])
    assert pair["proposal"]["kind"] == "explain_relation" and pair["proposal"]["graph_link"]
    by_question = ask(
        kb_client, skill_id="find_related", question="Как устроена выгрузка справочника регионов?"
    )
    assert by_question["answer"].startswith("Документ по вопросу:")
    assert by_question["proposal"]["kind"] == "find_related"
    assert_nothing_applied(kb_client)


def test_draft_skills_create_proposals_and_apply_nothing(kb_client: TestClient) -> None:
    draft = ask(
        kb_client,
        skill_id="draft_document",
        question="Нужна спецификация интеграции: поток загружает процессы ARIS в каталог метаданных",
    )
    assert draft["skill"] == {"id": "draft_document", "name": "Черновик документа", "access": "draft"}
    assert draft["proposal"]["kind"] == "draft_from_prompt" and draft["proposal"]["status"] == "suggested"
    assert any("ничего не применено" in w for w in draft["warnings"])
    metadata = ask(kb_client, skill_id="suggest_metadata", context_document_ids=["DEMO-INT-014"])
    assert metadata["proposal"]["kind"] == "suggest_metadata"
    assert_nothing_applied(kb_client)
    # The person decides: accepting the proposal is the separate, existing endpoint.
    accepted = kb_client.post(
        f"/api/ai/proposals/{draft['proposal']['id']}/accept", json={"item_ids": ["draft"]}
    )
    assert accepted.status_code == 200
    assert kb_client.get("/api/drafts").json()["total"] == 1


def test_improve_section_with_a_model_provider(client: TestClient) -> None:
    use_internal_api(
        client,
        json.dumps({"text": "A document has a stable ID and an approval status.", "citations": []}),
    )
    answer = ask(
        client,
        skill_id="improve_section",
        question="короче",
        selection={"document_id": "SEM-ARCH-001", "section_anchor": "principles", "text": ""},
    )
    assert answer["mode"] == "internal_api"
    assert answer["proposal"]["kind"] == "improve_section" and answer["proposal"]["status"] == "suggested"
    proposal = client.get(f"/api/ai/proposals/{answer['proposal']['id']}").json()
    assert proposal["items"][0]["section"] == "Principles"
    assert_nothing_applied(client)


def test_workflow_evidence_becomes_verified_citations(client: TestClient) -> None:
    quote = "This local demonstration models a knowledge base with four layers"
    use_internal_api(
        client,
        json.dumps(
            {
                "text": "Четыре слоя.",
                "citations": [
                    {"document_id": "SEM-ARCH-001", "quote": quote},
                    {"document_id": "SEM-ARCH-001", "quote": "seven secret layers of the bank"},
                ],
            },
            ensure_ascii=False,
        ),
    )
    answer = ask(client, skill_id="summarize", context_document_ids=["SEM-ARCH-001"])
    assert [c["excerpt"] for c in answer["citations"]] == [quote]
    assert answer["confidence"] == "supported" and answer["citations"][0]["app_path"].startswith(
        "/documents/"
    )


def test_draft_skills_need_the_proposal_permission(client: TestClient) -> None:
    class NoProposals:
        name = "no_proposals"

        def allows(self, user: UserContext, action: Action) -> bool:
            return action != Action.create_proposal

    client.app.state.container.policy = NoProposals()  # type: ignore[attr-defined]
    denied = client.post(
        "/api/assistant/ask",
        json={"skill_id": "check_completeness", "context_document_ids": ["SEM-ARCH-001"]},
    )
    assert denied.status_code == 403
    assert ask(client, question="What layers does the demonstration architecture have?")["citations"]


# --- stream ------------------------------------------------------------------------------------------------


def test_stream_runs_workflow_skills_and_rejects_bad_input_before_streaming(client: TestClient) -> None:
    with client.stream(
        "POST",
        "/api/assistant/ask/stream",
        json={"skill_id": "check_completeness", "context_document_ids": ["SEM-ARCH-001"]},
    ) as response:
        assert response.status_code == 200
        events = [json.loads(line) for line in response.iter_lines() if line.strip()]
    assert [e.get("stage") for e in events[:-1]] == ["retrieving", "generating", "validating"]
    assert (
        events[-1]["type"] == "final" and events[-1]["response"]["proposal"]["kind"] == "check_completeness"
    )
    bad = client.post("/api/assistant/ask/stream", json={"question": "Что такое слой?", "skill_id": "nope"})
    assert bad.status_code == 422 and bad.json()["code"] == "skill_unknown"


def test_openapi_lists_the_new_endpoints(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    assert "get" in paths["/api/assistant/skills"]
    assert "multipart/form-data" in paths["/api/assistant/attachments"]["post"]["requestBody"]["content"]
    assert "delete" in paths["/api/assistant/attachments/{attachment_id}"]
