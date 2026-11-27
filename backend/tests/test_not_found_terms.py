"""«Не найдено в документах»: words of the question the evidence lacks — never function words (round 2, C)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.ai.base import AnswerOptions
from app.adapters.ai.mock import MockAIProvider
from app.domain.text import FUNCTION_WORDS, STOPWORDS, analyze_query, is_function_word, reportable_terms
from app.services.assistant import AssistantService
from tests.conftest import make_doc, write_doc
from tests.test_assistant import ask

FLOW_BODY = (
    "# Поток каталога\n\n"
    "Владелец потока — команда интеграции. Данные идут из ARIS в каталог пакетами каждые шесть часов.\n"
)


@pytest.mark.parametrize(
    "word",
    [
        # prepositions, conjunctions, particles, pronouns, auxiliary verbs — RU
        "через",
        "между",
        "после",
        "из-за",
        "потому",
        "поэтому",
        "лишь",
        "ведь",
        "который",
        "которые",
        "каком",
        "себя",
        "будет",
        "является",
        "кто-то",
        "что-нибудь",
        "какой-либо",
        "всё-таки",
        # already search stop words: still never reported
        "что",
        "как",
        "это",
        "для",
        "ли",
        # EN
        "between",
        "through",
        "which",
        "whose",
    ],
)
def test_function_words_are_never_reported(word: str) -> None:
    terms = analyze_query(word, keep_stopwords=True)
    assert terms, word
    assert all(is_function_word(t) for t in terms), word
    assert reportable_terms(terms) == []


@pytest.mark.parametrize("word", ["часто", "сбое", "поток", "владелец", "каталог", "расписание", "mapping"])
def test_content_words_are_reported(word: str) -> None:
    (term,) = analyze_query(word)
    assert not is_function_word(term)


def test_identifiers_and_acronyms_are_never_function_words() -> None:
    terms = analyze_query("US IT DEMO-INT-001 aris_object_guid", keep_stopwords=True)
    assert [t.original for t in reportable_terms(terms)] == ["US", "IT", "DEMO-INT-001", "aris_object_guid"]


def test_function_words_are_not_search_terms() -> None:
    """Retrieval v2 (evaluated before/after, reports/README.md): function words no longer become search
    terms — they crowded the bounded term list and diluted every coverage ratio. The report filter is unchanged."""
    assert STOPWORDS < FUNCTION_WORDS
    tokens = [t.token for t in analyze_query("Кто владелец потока, через который идут данные?")]
    assert tokens == ["владелец", "потока", "идут", "данные"]


def test_no_passages_message_names_only_meaningful_words() -> None:
    # Terms as the report receives them, function words included (keep_stopwords): only the naming is tested here.
    terms = analyze_query("через который расписание", keep_stopwords=True)
    message = AssistantService._no_passages_message(terms, terms)
    assert "«расписание»" in message
    assert "через" not in message and "который" not in message
    only_function = analyze_query("через который", keep_stopwords=True)
    message = AssistantService._no_passages_message(only_function, only_function)
    assert "не встречаются" not in message
    assert message.startswith("Недостаточно данных")


def test_mock_insufficient_message_counts_function_words_but_never_names_them() -> None:
    terms = analyze_query("через который поток", keep_stopwords=True)
    options = AnswerOptions(terms=terms, unmatched_terms=terms[:2])
    result = asyncio.run(MockAIProvider().answer("?", [], options))
    assert result.confidence == "insufficient_evidence"  # the decision itself is unchanged
    assert "через" not in result.answer and "который" not in result.answer
    assert "нет подтверждённого ответа на вопрос" in result.answer


def _flow(client: TestClient, workspace: Path, question: str) -> dict[str, Any]:
    write_doc(workspace, "flow.md", make_doc("FLOW-001", title="Поток каталога", body=FLOW_BODY))
    return ask(client, question)


def test_answer_does_not_list_function_words_as_not_found(client: TestClient, workspace: Path) -> None:
    answer = _flow(client, workspace, "Кто владелец потока, через который идут данные из ARIS?")
    assert [c["document_id"] for c in answer["citations"]] == ["FLOW-001"]
    # Retrieval v2: «через», «который» are not search terms, so they no longer dilute the coverage — the one
    # document covers every content word of the question (v1 reported «partial» only because of them).
    assert answer["confidence"] == "supported"
    assert answer["unmatched_terms"] == []
    # Nothing meaningful is missing: no «не встречаются» note, so the UI shows no «Не найдено в документах» line.
    assert "не встречаются" not in answer["answer"]


def test_answer_lists_meaningful_missing_words_only(client: TestClient, workspace: Path) -> None:
    question = "Кто владелец потока, через который идут данные из ARIS по регламенту и графику?"
    answer = _flow(client, workspace, question)
    note = next(line for line in answer["answer"].splitlines() if "не встречаются" in line)
    assert "«регламенту»" in note and "«графику»" in note
    assert "через" not in note and "который" not in note
    assert "через" not in answer["unmatched_terms"] and "который" not in answer["unmatched_terms"]
