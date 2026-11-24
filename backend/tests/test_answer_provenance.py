"""Answer provenance, broad questions and follow-ups (answer-quality root-cause fix, workstreams B and C).

`is_demo` is SOURCE METADATA. An ordinary answer over synthetic documents carries a typed provenance summary derived
from its VALIDATED evidence (cited sources and documents named by its system facts) — never a generic «only demo»
warning on every turn, never a provenance claim about an answer without evidence. Warnings stay for what is material:
mixed synthetic / non-synthetic evidence, attachments, drafts, unconfirmed external pages, integrity problems.

Broad questions and follow-ups: the pre-retrieved passages are a small lexical SAMPLE (the model is told so and may use
the tools for an overview); corpus-wide boilerplate (e.g. the synthetic banner repeated in every demo document) is not
handed to the model as evidence; a follow-up keeps the subject of its own words next to the previous question's.

Deterministic: the mock provider, a tiny fake provider for mixed sources and the scripted model double
(tests/support/scripted_model.py) for the tool loop. Synthetic data only.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.adapters.ai.base import AnswerOptions, CitedEvidence, ContextPassage, ProviderAnswer
from app.adapters.ai.openai_compatible import OpenAICompatibleAIProvider, format_passages
from app.domain.models import AskRequest, Citation, DocStatus, SystemFact, SystemFactItem
from app.domain.provenance import MIXED_PROVENANCE_WARNING, summarize_provenance
from tests.conftest import FIXTURES_DIR, make_doc, write_doc
from tests.support.scripted_model import Recorder, openai_transport
from tests.test_assistant_tool_loop import Factory, m57_workspace, tool_client  # noqa: F401 (fixtures)

DEMO_CLAIM = re.compile(r"демо|синтетич|synthetic|demo", re.I)


def ask(client: TestClient, question: str, **body: Any) -> dict[str, Any]:
    response = client.post("/api/assistant/ask", json={"question": question, **body})
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def provenance_warnings(answer: dict[str, Any]) -> list[str]:
    """Server warnings that make a claim about the synthetic / demo nature of the sources."""
    return [w for w in answer["warnings"] if DEMO_CLAIM.search(w)]


def distinct_sources(answer: dict[str, Any]) -> int:
    return len({c["source_id"] for c in answer["citations"]})


# --- B: provenance is metadata, not a disclaimer -----------------------------------------------------------------
def test_synthetic_answer_has_provenance_and_no_generic_warning(client: TestClient) -> None:
    answer = ask(client, "What layers does the demonstration architecture have?")
    assert answer["confidence"] == "supported" and answer["citations"]
    assert provenance_warnings(answer) == []  # no «only demo documents» banner on an ordinary answer
    provenance = answer["provenance"]
    assert provenance["overall"] == "synthetic"
    assert provenance["synthetic"] == distinct_sources(answer)
    assert provenance["not_synthetic"] == 0 and provenance["unknown"] == 0
    assert provenance["by_kind"] == {"team": distinct_sources(answer)}
    assert {c["provenance"] for c in answer["citations"]} == {"synthetic"}
    assert all(c["is_demo"] for c in answer["citations"])  # per-source metadata unchanged


def test_answers_without_evidence_make_no_provenance_claim(client: TestClient) -> None:
    for question in ("Какой SLA у интеграции с ЦФТ?", "что это и как?"):
        answer = ask(client, question)
        assert answer["confidence"] == "insufficient_evidence"
        assert provenance_warnings(answer) == [], question
        assert answer["provenance"]["overall"] == "none"


def test_no_passages_on_a_non_demo_base_is_not_called_demo(
    client_factory: Callable[..., TestClient], tmp_path: Path
) -> None:
    root = tmp_path / "plain-kb"
    write_doc(
        root,
        "TEAM-PROC-001.md",
        make_doc("TEAM-PROC-001", tags="[process]", body="# Процесс\n\nЗаявка проходит ревью владельцем.\n"),
    )
    client = client_factory(local_knowledge_dir=root, local_content_is_demo=False)
    answer = ask(client, "Какой SLA у интеграции с ЦФТ?")
    assert answer["confidence"] == "insufficient_evidence"
    assert provenance_warnings(answer) == []
    assert answer["provenance"]["overall"] == "none"


class _CiteEverything:
    """A provider double that cites every passage with a verbatim quote (mixed-source evidence)."""

    mode = "internal_api"
    supports_edit_suggestions = False
    supports_authoring = False

    async def answer(
        self, question: str, passages: list[ContextPassage], options: AnswerOptions
    ) -> ProviderAnswer:
        evidence = [CitedEvidence(cid=p.cid, quote=" ".join(p.text.split())[:40]) for p in passages]
        text = "Сводка источников: " + " ".join(f"[{p.cid}]" for p in passages)
        return ProviderAnswer(answer=text, confidence="supported", evidence=evidence)


def test_mixed_sources_get_per_source_provenance_and_one_material_warning(
    client_factory: Callable[..., TestClient], tmp_path: Path
) -> None:
    root = tmp_path / "mixed-kb"
    body = (
        "# Выгрузка\n\nВыгрузка справочника регионов выполняется ежедневно в 02:00 по московскому времени.\n"
    )
    write_doc(
        root,
        "MIX-INT-001.md",
        make_doc("MIX-INT-001", tags="[integration]", body=body, extra="synthetic: true\n"),
    )
    write_doc(root, "MIX-INT-002.md", make_doc("MIX-INT-002", tags="[integration]", body=body))
    client = client_factory(local_knowledge_dir=root, local_content_is_demo=False)
    client.app.state.container.assistant._provider = _CiteEverything()  # type: ignore[attr-defined]
    answer = ask(client, "Когда выполняется выгрузка справочника регионов?")
    by_doc = {c["document_id"]: c["provenance"] for c in answer["citations"]}
    assert by_doc == {"MIX-INT-001": "synthetic", "MIX-INT-002": "not_synthetic"}
    provenance = answer["provenance"]
    assert (provenance["overall"], provenance["synthetic"], provenance["not_synthetic"]) == ("mixed", 1, 1)
    assert answer["warnings"].count(MIXED_PROVENANCE_WARNING) == 1
    assert not any("только демо" in w for w in answer["warnings"])  # never a global «only demo» claim


def _citation(source_type: str, *, is_demo: bool, doc_id: str = "DOC-1") -> Citation:
    return Citation(
        ref=1,
        source_type=source_type,  # type: ignore[arg-type]
        document_id=doc_id,
        title="t",
        source_uri="u",
        revision="r",
        status=None if source_type == "attachment" else DocStatus.approved,
        section=None,
        section_anchor=None,
        excerpt="дословная выдержка из источника",
        retrieved_at=datetime.now(UTC),
        is_demo=is_demo,
        app_path=None,
        source_id=f"{source_type}:{doc_id}",
    )


def test_provenance_summary_classes() -> None:
    attachment = _citation("attachment", is_demo=False, doc_id="ATT-1")
    assert attachment.provenance == "unknown"  # a user's file has no provenance metadata: never «real»
    only_file = summarize_provenance([attachment], [])
    assert (only_file.overall, only_file.unknown, only_file.by_kind) == ("unknown", 1, {"attachment": 1})
    assert summarize_provenance([], []).overall == "none"
    team = _citation("local", is_demo=True)
    same_doc_twice = summarize_provenance([team, team.model_copy(update={"ref": 2})], [])
    assert (same_doc_twice.overall, same_doc_twice.synthetic) == ("synthetic", 1)  # distinct sources
    fact = SystemFact(
        ref="F1",
        tool="catalog_query",
        operation="list",
        label="l",
        source="skh_document_registry",
        as_of=datetime.now(UTC),
        items=[
            SystemFactItem(id="DOC-1", title="t", kind="document", is_demo=True),  # also cited: counted once
            SystemFactItem(id="DOC-2", title="t", kind="document", is_demo=False),
            SystemFactItem(id="TPL", title="t", kind="template"),  # not a source of knowledge content
        ],
    )
    with_facts = summarize_provenance([team], [fact])
    assert (with_facts.overall, with_facts.synthetic, with_facts.not_synthetic) == ("mixed", 1, 1)


def test_provenance_is_model_visible_metadata_not_text() -> None:
    def passage(cid: str, source_type: str, is_demo: bool) -> ContextPassage:
        return ContextPassage(
            cid=cid,
            document_id=f"D-{cid}",
            title="t",
            section=None,
            section_anchor=None,
            status=None,
            source_type=source_type,  # type: ignore[arg-type]
            source_uri="u",
            revision="r",
            text="текст фрагмента",
            is_demo=is_demo,
        )

    blocks = format_passages(
        [passage("C1", "local", True), passage("C2", "gitlab", False), passage("C3", "attachment", False)],
        10_000,
    )
    metas = [json.loads(b.split("\n")[1]) for b in blocks if b.startswith("<<<PASSAGE")]
    assert [m.get("synthetic") for m in metas] == [True, False, None]  # no claim about a user's file


# --- B: the tool loop never labels failures «only demo» ----------------------------------------------------------
@pytest.mark.parametrize(
    "question",
    [
        "Сколько документов в базе?",
        "Упади после подсчёта: сколько документов?",
        "Бесконечный цикл: сколько документов?",
        "Неизвестный инструмент: посчитай документы",
    ],
)
def test_tool_answers_and_failures_never_claim_only_demo(tool_client: Factory, question: str) -> None:  # noqa: F811
    client, _recorder = tool_client("openai")
    answer = ask(client, question)
    assert provenance_warnings(answer) == [], answer["warnings"]
    assert answer["provenance"]["overall"] == "none"  # a count is a registry fact, not cited content


# --- C: broad questions and follow-ups on the full synthetic base -------------------------------------------------
@pytest.fixture
def full_tool_client(
    client_factory: Callable[..., TestClient], full_workspace: Path
) -> Callable[[], tuple[TestClient, Recorder]]:
    def factory() -> tuple[TestClient, Recorder]:
        client = client_factory(local_knowledge_dir=full_workspace)
        container = client.app.state.container  # type: ignore[attr-defined]
        recorder = Recorder()
        container.assistant._provider = OpenAICompatibleAIProvider(
            base_url="https://ai.example.test/v1",
            model="scripted",
            api_key=SecretStr(""),
            timeout_seconds=10,
            allowed_hosts=["ai.example.test"],
            transport=openai_transport(recorder),
            instructions=container.instructions,
        )
        return client, recorder

    return factory


def boilerplate_lines(min_documents: int = 5) -> set[str]:
    """Independent oracle: body lines repeated verbatim in at least `min_documents` fixture documents."""
    counts: Counter[str] = Counter()
    for path in FIXTURES_DIR.rglob("*.md"):
        body = path.read_text(encoding="utf-8").split("---", 2)[-1]
        lines = {" ".join(line.lstrip("> ").split()).casefold() for line in body.splitlines()}
        counts.update(line for line in lines if len(line) > 20 and not line.startswith(("#", "|")))
    return {line for line, n in counts.items() if n >= min_documents}


def passage_texts(prompt: str) -> list[tuple[str, str]]:
    return [
        (json.loads(meta)["document_id"], text)
        for _cid, meta, text in re.findall(r"<<<PASSAGE (C\d+)>>>\n(.*?)\n(.*?)\n<<<END \1>>>", prompt, re.S)
    ]


def test_boilerplate_is_not_handed_to_the_model_as_evidence(full_tool_client: Callable[..., Any]) -> None:
    client, _ = full_tool_client()
    container = client.app.state.container  # type: ignore[attr-defined]
    banner = boilerplate_lines()
    assert banner  # the synthetic base repeats its disclaimer in most documents
    for question in (
        "Какая у нас модель данных?",
        "Какие источники данных у нас описаны?",
        "Что такое lineage?",
    ):
        prepared = client.portal.call(
            container.assistant._prepare, container.demo_user(), AskRequest(question=question)
        )
        assert prepared.passages, question
        for p in prepared.passages:
            lines = [" ".join(x.split()).casefold() for x in p.text.splitlines() if x.strip()]
            assert not lines or not all(line in banner for line in lines), (
                question,
                p.document_id,
                p.text[:80],
            )


def test_broad_question_gets_a_scope_aware_overview(full_tool_client: Callable[..., Any]) -> None:
    client, recorder = full_tool_client()
    answer = ask(client, "Какая у нас модель данных?")
    steps = [(s["tool"], s["operation"], s["outcome"]) for s in answer["tool_steps"]]
    assert ("catalog_query", "list", "ok") in steps and ("knowledge_search", "search", "ok") in steps
    assert answer["confidence"] == "supported"
    assert len({c["document_id"] for c in answer["citations"]}) >= 2  # an overview, not the first passage
    assert "в доступных вам документах" in answer["answer"].casefold()
    assert provenance_warnings(answer) == []
    assert answer["provenance"]["overall"] == "synthetic" and answer["provenance"]["by_kind"]["team"] >= 2
    system, first = (" ".join(text.split()) for text in recorder.calls[0])
    # the policy tells the model what the pre-retrieved passages are and how to answer a broad question
    assert "выборка" in first and "не весь каталог" in first
    assert "Обзорный вопрос" in system and "в просмотренных источниках не найдено" in system
    listed = json.loads(
        re.search(r"<<<TOOL RESULT T1>>>\n(.*?)\n<<<END T1>>>", recorder.calls[1][1], re.S).group(1)
    )
    assert all("synthetic" in row for row in listed["items"])  # provenance as catalog metadata


def test_follow_up_continues_the_referent_without_a_disclaimer(full_tool_client: Callable[..., Any]) -> None:
    client, _recorder = full_tool_client()
    first = ask(client, "Какая у нас модель данных?")
    history = [
        {
            "question": "Какая у нас модель данных?",
            "answer": first["answer"][:4000],
            "context": first["conversation_context"],
        }
    ]
    answer = ask(client, "нам интересны демо-файлы", history=history)
    assert answer["confidence"] == "supported" and answer["citations"]
    search = next(s for s in answer["tool_steps"] if s["tool"] == "knowledge_search")
    assert search["outcome"] == "ok"
    assert provenance_warnings(answer) == []
    assert answer["provenance"]["overall"] == "synthetic"
    # words of the PREVIOUS question are not reported as «not found» for this turn
    assert not {"нас", "модель", "данных"} & {t.casefold() for t in answer["unmatched_terms"]}


@pytest.mark.parametrize(
    ("previous", "question"),
    [
        ("Что такое логическая модель BusinessProcess?", "а физическая?"),
        ("Какая у нас модель данных?", "Как часто метаданные ARIS обновляются в каталоге?"),
        ("Как устроен поток ARIS → Catalog?", "а какие у него ограничения?"),
    ],
)
def test_follow_up_retrieval_keeps_both_readings(
    client_factory: Callable[..., TestClient], full_workspace: Path, previous: str, question: str
) -> None:
    """The pre-retrieval of a follow-up keeps the best passage of the new words AND of the conversation: old terms
    never push the subject of the new question out of the context (and vice versa)."""
    client = client_factory(local_knowledge_dir=full_workspace)
    container = client.app.state.container  # type: ignore[attr-defined]

    def prepared(body: dict[str, Any]) -> list[str]:
        result = client.portal.call(container.assistant._prepare, container.demo_user(), AskRequest(**body))
        return [p.document_id for p in result.passages]

    alone = prepared({"question": question})
    combined = prepared({"question": f"{question} {previous}"})
    follow_up = prepared({"question": question, "history": [{"question": previous, "answer": ""}]})
    assert alone[0] in follow_up and combined[0] in follow_up, (alone[:3], combined[:3], follow_up)


def test_real_data_question_gets_an_explicit_disclosure(full_tool_client: Callable[..., Any]) -> None:
    client, _ = full_tool_client()
    answer = ask(client, "Это реальные данные банка?")
    fact = answer["system_facts"][0]
    total = sum(
        1 for _ in FIXTURES_DIR.rglob("*.md")
    )  # every fixture document is synthetic (oracle: the files)
    assert fact["breakdown"]["provenance"] == {"synthetic": total}
    assert "синтетические" in answer["answer"] and f"[{fact['ref']}]" in answer["answer"]
    assert provenance_warnings(answer) == []  # the disclosure is the answer itself, backed by the fact


def test_a_word_missing_from_an_earlier_question_never_blocks_a_new_subject(client: TestClient) -> None:
    unanswered = ask(client, "Какой SLA у интеграции с ЦФТ?")
    assert unanswered["confidence"] == "insufficient_evidence"
    history = [{"question": "Какой SLA у интеграции с ЦФТ?", "answer": unanswered["answer"][:4000]}]
    answer = ask(client, "What layers does the demonstration architecture have?", history=history)
    assert answer["confidence"] != "insufficient_evidence" and answer["citations"]
    assert "ЦФТ" not in answer["unmatched_terms"] and "ЦФТ" not in answer["answer"]
