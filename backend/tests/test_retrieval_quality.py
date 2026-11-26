"""Retrieval quality v2 (reports/retrieval-quality/): query analysis, passage packing and local sufficiency.

Every test builds its OWN small synthetic corpus, independent of the gold evaluation suite, and checks the evidence
itself (which section, which fact, which trigger) — not just that something was returned. The tests marked
«v1 failed» fail on the code before retrieval v2 (verified on f4ea26e, reports/retrieval-quality/04_TEST_RESULTS.md).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.adapters.ai.base import ContextPassage
from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.knowledge.records import build_record
from app.adapters.search.base import SearchFilters
from app.adapters.search.sqlite_fts import SqliteFtsSearchProvider
from app.domain.dictionary import load_dictionary
from app.domain.models import DocStatus, DocumentRecord
from app.domain.text import MAX_QUERY_TERMS, analyze_query, fleeting_vowel_stem, term_matches_text, tokenize
from app.evaluation import retrieval_trace
from app.services.assistant import local_insufficiency
from app.services.retrieval import Passage, RetrievalService
from tests.conftest import make_doc

APPROVED = SearchFilters(statuses=frozenset({"approved"}))
WITH_DRAFTS = SearchFilters(statuses=frozenset({"approved", "draft", "in_review"}))
FILLER = (
    "Раздел приведён для полноты описания и не меняет правил. Формулировки согласованы с владельцем. "
    "Изменения вносятся через ревью и фиксируются в истории ревизий. "
)


def doc(doc_id: str, title: str, sections: dict[str, str], *, status: str = "approved") -> DocumentRecord:
    body = f"# {title}\n\n" + "\n\n".join(f"## {heading}\n\n{text}" for heading, text in sections.items())
    built = build_record(
        make_doc(doc_id, title=title, status=status, body=body + "\n").encode(),
        path=f"docs/{doc_id}.md",
        source="gitlab",
        source_uri_for="gitlab://kb/{id}",
        revision=hashlib.sha1(body.encode()).hexdigest(),  # noqa: S324 - a test revision, not security
        updated_at=None,
        is_demo=False,
        issues=[],
    )
    assert built is not None
    return built


def corpus(tmp_path: Path, *records: DocumentRecord) -> tuple[RetrievalService, KnowledgeSnapshot]:
    snapshot = KnowledgeSnapshot(version="v1", documents={r.id.lower(): r for r in records})
    index = SqliteFtsSearchProvider(tmp_path / "index.sqlite3")
    index.sync(snapshot)
    return RetrievalService(index, load_dictionary()), snapshot


def passages(
    service: RetrievalService, snapshot: KnowledgeSnapshot, question: str, filters: SearchFilters = APPROVED
) -> list[Passage]:
    found, _ranked = service.passages(snapshot, service.analyze(question), filters)
    return found


def sections_of(found: list[Passage], doc_id: str) -> list[str | None]:
    return [p.section for p in found if p.document.id == doc_id]


ORDER_CONTRACT = {
    "Определение": "Код заказа — постоянный код заказа в учётной системе. Код заказа присваивается заказу один раз.",
    "Пример": "Заказ ORD-17 перенесли в архив: код заказа ORD-17 не изменился, код заказа остался прежним.",
    "Атрибуты": "Поля карточки: код заказа, дата заказа, клиент заказа.",
    "Ограничения": FILLER * 3
    + "Номер удалённого заказа никогда не выдают повторно: строка получает состояние retired. "
    + FILLER * 2,
}


def order_corpus(tmp_path: Path) -> tuple[RetrievalService, KnowledgeSnapshot]:
    # The words of the second part of the question («номер», «удалённого», «повторно», «выдать») are ordinary in this
    # corpus (moderate IDF), so the long section answering it is NOT among the two BM25-best sections of ORD-001.
    common = [
        doc(
            f"REG-{n:03d}",
            f"Регламент учёта {n}",
            {
                "Правила": f"Номер записи {n} выдают при создании; удалённого номера повторно не выдают в этом журнале."
            },
        )
        for n in range(8)
    ]
    return corpus(
        tmp_path,
        doc("ORD-001", "Контракт кода заказа", ORDER_CONTRACT),
        doc("ORD-002", "Журнал заказов", {"Назначение": "Журнал хранит коды заказов и даты заказов."}),
        doc("ORD-003", "Архив документов", {"Назначение": "Перенос в архив выполняется ежемесячно."}),
        *common,
    )


# --- query analysis -------------------------------------------------------------------------------------------
def test_function_words_never_become_search_terms_but_acronyms_do() -> None:
    """v1 failed: «какими», «откуда», «которого» were search terms (they crowd the term cap, dilute coverage)."""
    terms = [
        t.token for t in analyze_query("Какими порциями и откуда берётся идентификатор, у которого код CRM?")
    ]
    assert "какими" not in terms and "откуда" not in terms and "которого" not in terms
    assert {"порциями", "берется", "идентификатор", "код", "crm"} <= set(terms)  # folded: ё → е


def test_a_long_compound_question_keeps_its_second_part() -> None:
    """v1 failed: 12 terms — the words after the twelfth (here: the second question) were silently not searched."""
    question = (
        "Процесс согласования заявки переименовали и перенесли в другую ветку модели ARIS. Изменится ли его "
        "идентификатор, и можно ли выдать номер устаревшего процесса новому?"
    )
    tokens = [t.token for t in analyze_query(question)]
    assert MAX_QUERY_TERMS >= 16
    assert {"номер", "устаревшего", "новому"} <= set(tokens)


@pytest.mark.parametrize(
    ("word", "other_form", "expected"),
    [
        ("попыток", "попытки", "попытк"),
        ("карточек", "карточки", "карточк"),
        ("ошибок", "ошибка", "ошибк"),
        ("недоступен", "недоступности", "недоступн"),
    ],
)
def test_fleeting_vowel_forms_match_the_other_forms(word: str, other_form: str, expected: str) -> None:
    """v1 failed: «попыток» (genitive plural) never matched «попытки»."""
    assert fleeting_vowel_stem(word) == expected
    (term,) = analyze_query(word)
    assert term_matches_text(term, tokenize(other_form))


@pytest.mark.parametrize("word", ["поток", "срок", "каталог", "процесс", "CRM"])
def test_fleeting_vowel_rule_leaves_other_words_alone(word: str) -> None:
    assert fleeting_vowel_stem(word) is None


# --- passage packing ------------------------------------------------------------------------------------------
def test_a_later_section_that_answers_another_part_of_the_question_is_packed(tmp_path: Path) -> None:
    """v1 failed: the two BM25-best sections of the best document (short and word-dense) were always taken, so the
    section answering the second part of the question («можно ли выдать номер…») never reached the context."""
    service, snapshot = order_corpus(tmp_path)
    found = passages(
        service,
        snapshot,
        "Меняется ли код заказа при переносе в архив и можно ли повторно выдать номер удалённого заказа?",
    )
    assert "Ограничения" in sections_of(found, "ORD-001")
    assert any("состояние retired" in p.text for p in found)
    assert any("ORD-17" in p.text for p in found)  # the first part is still answered


def test_a_context_document_is_not_cut_off_by_word_dense_sections_of_other_documents(tmp_path: Path) -> None:
    """v1 failed: only the 60 BM25-best sections of the whole corpus were candidates; 70 short documents dense in the
    question's words pushed the relevant section of the best (title-matched) document out of them."""
    fillers = [
        doc(
            f"FIL-{n:03d}",
            f"Регламент {n}",
            {"Кратко": f"Срок хранения заказа {n}: срок хранения заказа, срок."},
        )
        for n in range(70)
    ]
    target = doc(
        "KEEP-001",
        "Срок хранения заказов",
        {
            "Назначение": FILLER,
            "Область применения": FILLER,
            "Правила": FILLER * 6
            + "Срок хранения закрытого заказа — пять лет, затем он удаляется целиком. "
            + FILLER,
        },
    )
    service, snapshot = corpus(tmp_path, target, *fillers)
    found = passages(service, snapshot, "Какой срок хранения заказа?")
    assert found and found[0].document.id == "KEEP-001"
    assert "Правила" in sections_of(found, "KEEP-001")
    assert any("пять лет" in p.text for p in found if p.document.id == "KEEP-001")


def test_two_facts_in_two_documents_both_reach_the_context(tmp_path: Path) -> None:
    service, snapshot = corpus(
        tmp_path,
        doc(
            "FLOW-001",
            "Поток изделий в каталог (обзор)",
            {"Назначение": "Поток переносит изделия в каталог. Запуск потока — ежедневно в 02:30."},
        ),
        doc(
            "MAP-001",
            "Маппинг изделий в граф зависимостей",
            {"Правила": "Идентификатор узла графа строится как SYS-CAD: плюс номер изделия."},
        ),
        doc("OTHER-001", "Каталог активов", {"Назначение": "Каталог хранит активы и их владельцев."}),
    )
    found = passages(
        service,
        snapshot,
        "Когда запускается поток изделий в каталог и как строится идентификатор узла графа?",
    )
    text = " ".join(p.text for p in found)
    assert "02:30" in text and "SYS-CAD:" in text
    assert {"FLOW-001", "MAP-001"} <= {p.document.id for p in found}


def test_an_overview_does_not_displace_the_document_with_the_rule(tmp_path: Path) -> None:
    service, snapshot = corpus(
        tmp_path,
        doc(
            "OVR-001",
            "Обзор потоков и повторов",
            {
                "Назначение": "Потоки метаданных повторяют обработку при недоступности источника по общей политике.",
                "Пример": "Повтор обработки потока выполняется автоматически, если источник недоступен.",
            },
        ),
        doc(
            "RULE-001",
            "Политика повторных попыток",
            {
                "Правила": "Интервалы между повторными попытками при недоступности источника: 30 с, 60 с, 2 мин."
            },
        ),
    )
    found = passages(
        service, snapshot, "С какими интервалами выполняются повторные попытки при недоступности источника?"
    )
    assert any("30 с, 60 с, 2 мин" in p.text for p in found if p.document.id == "RULE-001")


def test_status_policy_excludes_drafts_unless_they_are_requested(tmp_path: Path) -> None:
    service, snapshot = corpus(
        tmp_path,
        doc("RULE-APP", "Правила архивации", {"Правила": "Снимок архива хранится 36 месяцев."}),
        doc(
            "RULE-DRF",
            "Правила архивации v2",
            {"Правила": "Снимок архива хранится 48 месяцев."},
            status="draft",
        ),
        doc(
            "RULE-OLD",
            "Правила архивации (устарело)",
            {"Правила": "Снимок архива хранится 12 месяцев."},
            status="deprecated",
        ),
    )
    question = "Сколько месяцев хранится снимок архива?"
    assert {p.document.status for p in passages(service, snapshot, question)} == {DocStatus.approved}
    with_drafts = {p.document.id for p in passages(service, snapshot, question, WITH_DRAFTS)}
    assert "RULE-DRF" in with_drafts and "RULE-OLD" not in with_drafts


def test_a_document_outside_the_readers_snapshot_never_appears(tmp_path: Path) -> None:
    visible = doc("VIS-001", "Хранение снимков", {"Правила": "Снимок архива хранится 36 месяцев."})
    hidden = doc("HID-001", "Хранение снимков (закрыто)", {"Правила": "Снимок архива хранится 99 месяцев."})
    service, full = corpus(tmp_path, visible, hidden)  # the index holds both documents
    reader = KnowledgeSnapshot(version=full.version, documents={"vis-001": visible})
    found, ranked = service.passages(reader, service.analyze("Сколько хранится снимок архива?"), APPROVED)
    assert {p.document.id for p in found} == {"VIS-001"}
    assert {h.document_id for h in ranked} == {"VIS-001"}
    assert all("99" not in p.text for p in found)


def test_passages_keep_provenance_and_are_deterministic(tmp_path: Path) -> None:
    service, snapshot = order_corpus(tmp_path)
    question = (
        "Меняется ли код заказа при переносе в архив и можно ли повторно выдать номер удалённого заказа?"
    )
    first, second = passages(service, snapshot, question), passages(service, snapshot, question)
    assert [(p.document.id, p.section_anchor) for p in first] == [
        (p.document.id, p.section_anchor) for p in second
    ]
    for p in first:
        section = next(s for s in p.document.sections if s.anchor == p.section_anchor)
        assert p.text == section.text and p.section == section.heading  # verbatim section, its own anchor
        assert p.document.revision == snapshot.documents[p.document.id.lower()].revision
    assert len(first) <= 6 and len({p.document.id for p in first}) <= 4


# --- local sufficiency (LOCAL_SUFFICIENCY v2) ------------------------------------------------------------------
def ctx(doc_id: str, section: str, text: str) -> ContextPassage:
    return ContextPassage(
        cid="C1",
        document_id=doc_id,
        title=doc_id,
        section=section,
        section_anchor=section.lower(),
        status=DocStatus.approved,
        source_type="local",
        source_uri=f"local://{doc_id}",
        revision="r1",
        text=text,
        is_demo=True,
    )


def test_topical_local_evidence_without_the_specific_word_is_not_sufficient() -> None:
    """v1 failed: the flow description covers 4 of 5 words, so v1 called it sufficient although the question is
    about a LIMIT that no local source states — the external source was never consulted."""
    terms = analyze_query("Какой лимит размера пакета выгрузки CATIA?")
    local = [
        ctx(
            "FLOW",
            "Входные данные",
            "Выгрузка CATIA: размер пакета не задан, дельта грузится одним запуском.",
        )
    ]
    matched = {
        t.stem for t in terms
    }  # every word occurs somewhere in the corpus («лимит» in an unrelated document)
    frequency = [1 if t.token == "лимит" else 20 for t in terms]
    assert (
        local_insufficiency(local, terms, matched, frequency=frequency, eligible=73)
        == "specific_terms_not_covered"
    )
    # the same evidence WITH the specific word is sufficient: no external call
    local_ok = [ctx("FLOW", "Ограничения", "Лимит размера пакета выгрузки CATIA — 1 500 строк.")]
    assert local_insufficiency(local_ok, terms, matched, frequency=frequency, eligible=73) is None


def test_sections_of_one_document_complement_each_other() -> None:
    """v1 failed: «no_single_local_passage» — two sections of the SAME document that together answer were not
    enough, and the external source was consulted although the team document answers."""
    terms = analyze_query("Сколько повторных попыток выполняется при недоступности источника?")
    local = [
        ctx("RETRY", "Коды ошибок", "При недоступности источника выполняется повтор обработки."),
        ctx("RETRY", "Правила", "Выполняется не более 5 повторных попыток."),
    ]
    assert (
        local_insufficiency(local, terms, {t.stem for t in terms}, frequency=[10] * len(terms), eligible=73)
        is None
    )


def test_words_scattered_over_different_documents_are_still_not_an_answer() -> None:
    terms = analyze_query("Сколько повторных попыток выполняется при недоступности источника?")
    local = [
        ctx("A", "x", "Повторных попыток много."),
        ctx("B", "y", "Источник бывает в состоянии недоступности."),
    ]
    reason = local_insufficiency(
        local, terms, {t.stem for t in terms}, frequency=[10] * len(terms), eligible=73
    )
    assert reason == "no_single_local_source"


def test_an_entity_absent_from_the_corpus_still_triggers_the_external_source() -> None:
    terms = analyze_query("Что означает код причины R-06?")
    local = [ctx("CODES", "Коды", "Код причины указывается для каждой отклонённой записи.")]
    matched = {t.stem for t in terms if t.token != "r-06"}
    assert (
        local_insufficiency(local, terms, matched, frequency=[5] * len(terms), eligible=73)
        == "unmatched_entities"
    )


# --- developer tool: the holdout stays blind -------------------------------------------------------------------
def test_the_trace_tool_refuses_a_holdout_case(tmp_path: Path) -> None:
    cases = tmp_path / "cases.yaml"
    cases.write_text(
        json.dumps([{"case_id": "H-1", "question": "вопрос", "method": "assistant", "holdout": True}]),
        encoding="utf-8",
    )
    kb = Path(__file__).resolve().parents[2] / "fixtures" / "knowledge"
    assert retrieval_trace.main(["--kb", str(kb), "--cases", str(cases), "--case", "H-1"]) == 2


def test_a_document_named_by_its_id_is_the_subject_of_the_question(tmp_path: Path) -> None:
    """v2 before this rule failed (E2E R2-01/R2-02): «источник и получатель потока FLOW-001?» packed one section of
    every lexically similar flow first, and the answer led with ANOTHER flow's table. The named document's matching
    sections come first; other documents only take the slots left."""
    flows = [
        doc(
            f"FLOW-00{n}",
            f"Поток {n}",
            {
                "Источник и получатель": f"Источник потока {n} — система S{n}, получатель — каталог. См. FLOW-001.",
                "Назначение": f"Поток {n} переносит записи; источник и получатель описаны выше.",
                "Ограничения": f"Поток {n}: получатель принимает только полные записи источника.",
            },
        )
        for n in range(1, 5)
    ]
    service, snapshot = corpus(tmp_path, *flows)
    found = passages(service, snapshot, "Что является источником и получателем для потока FLOW-001?")
    assert found[0].document.id == "FLOW-001" and found[0].section == "Источник и получатель"
    named = [p for p in found if p.document.id == "FLOW-001"]
    assert len(named) == 3  # every matching section of the named document, before any other document
    assert [p.document.id for p in found[: len(named)]] == ["FLOW-001"] * len(named)
