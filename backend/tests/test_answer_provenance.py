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
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.adapters.ai.base import AnswerOptions, CitedEvidence, ContextPassage, ProviderAnswer
from app.adapters.ai.openai_compatible import format_passages
from app.domain.models import Citation, DocStatus, SystemFact, SystemFactItem
from app.domain.provenance import MIXED_PROVENANCE_WARNING, summarize_provenance
from tests.conftest import make_doc, write_doc
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
