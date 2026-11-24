"""Readable excerpts from Markdown tables (Citation.excerpt_parts): display only, the verified quote is unchanged."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.domain.excerpts import citation_excerpt_parts, excerpt_parts
from app.domain.markdown import TableBlock, TextBlock, parse_markdown, section_blocks
from app.services.assistant import quote_is_verbatim
from tests.conftest import make_doc, write_doc
from tests.test_assistant import ask, assert_citations_valid, use_model

TABLE_BODY = """# Поток каталога

Вступление без таблицы.

## Источник и получатель

Перед таблицей идёт короткое пояснение.

| Роль | Система | Код | Комментарий |
|:---|:---:|---:|---|
| Источник | ARIS (условная модель) | `SYS-ARIS` | процессные модели, профиль [[DEMO-SRC-002]] |
| Получатель | Data Catalog | `SYS-CAT` | каталог активов |
| Владелец потока | `demo-integration-team` |  | разбор ошибок `a\\|b` и x \\| y |

Со стороны каталога за содержание отвечает стюард данных (Steward).
"""


def _blocks(anchor: str) -> tuple[Any, ...]:
    return next(blocks for a, blocks in section_blocks(TABLE_BODY) if a == anchor)


def test_section_blocks_keep_rows_cells_and_pipes() -> None:
    blocks = _blocks("источник-и-получатель")
    assert blocks[0] == TextBlock("Перед таблицей идёт короткое пояснение.")
    table = blocks[1]
    assert isinstance(table, TableBlock)
    assert table.headers == ("Роль", "Система", "Код", "Комментарий")  # the alignment row is not a row
    assert len(table.rows) == 3  # a multi-row table keeps every row
    assert table.rows[0] == (
        "Источник",
        "ARIS (условная модель)",
        "SYS-ARIS",
        "процессные модели, профиль DEMO-SRC-002",
    )
    # An empty cell keeps its column; escaped pipes (also inside code) are cell text, not separators.
    assert table.rows[2] == ("Владелец потока", "demo-integration-team", "", "разбор ошибок a|b и x | y")
    assert blocks[2] == TextBlock("Со стороны каталога за содержание отвечает стюард данных (Steward).")


def test_section_blocks_match_the_indexed_section_text() -> None:
    """Same parser and anchors as parse_markdown: every non-empty cell is exactly a line of Section.text, so
    search, passages and quotes (all built from Section.text) are untouched by the display structure."""
    sections = parse_markdown(TABLE_BODY).sections
    blocks = dict(section_blocks(TABLE_BODY))
    assert [s.anchor for s in sections] == list(blocks)
    for section in sections:
        lines: list[str] = []
        for block in blocks[section.anchor]:
            if isinstance(block, TextBlock):
                lines.append(block.text)
            else:
                lines += [cell for row in (block.headers, *block.rows) for cell in row if cell]
        assert "\n".join(lines) == section.text


def _section_quote(start: str, end: str) -> str:
    """A verbatim quote of the section as a provider sees it (whitespace collapsed), from `start` to `end`."""
    text = " ".join(
        next(
            s.text for s in parse_markdown(TABLE_BODY).sections if s.anchor == "источник-и-получатель"
        ).split()
    )
    begin = text.index(start)
    return text[begin : text.index(end, begin) + len(end)]


def test_quote_over_a_table_becomes_rows_with_the_header_and_the_prose_around_it() -> None:
    quote = _section_quote("пояснение.", "стюард данных (Steward).")
    parts = excerpt_parts(quote, _blocks("источник-и-получатель"))
    assert parts is not None
    assert [p.kind for p in parts] == ["text", "table", "text"]
    assert parts[0].text == "пояснение."
    assert parts[1].headers == ["Роль", "Система", "Код", "Комментарий"]
    assert parts[1].rows is not None and [row[0] for row in parts[1].rows] == [
        "Источник",
        "Получатель",
        "Владелец потока",
    ]
    assert parts[2].text == "Со стороны каталога за содержание отвечает стюард данных (Steward)."


def test_quote_inside_one_row_shows_that_row_only_even_when_cut_mid_word() -> None:
    quote = _section_quote("ata Catalog", "каталог акти")  # starts and ends inside words
    parts = excerpt_parts(quote, _blocks("источник-и-получатель"))
    assert parts is not None and len(parts) == 1
    assert parts[0].kind == "table"
    assert parts[0].rows == [["Получатель", "Data Catalog", "SYS-CAT", "каталог активов"]]


def test_quote_of_several_pieces_keeps_the_gap() -> None:
    quote = "Источник ARIS (условная модель) … отвечает стюард данных (Steward)."
    assert quote_is_verbatim(quote, _section_quote("Источник ARIS", "(Steward)."))
    parts = excerpt_parts(quote, _blocks("источник-и-получатель"))
    assert parts is not None
    assert [p.kind for p in parts] == ["table", "text"]
    assert parts[0].rows is not None and len(parts[0].rows) == 1
    assert parts[1].text == "… отвечает стюард данных (Steward)."


def test_no_parts_without_a_table_or_without_a_confident_match() -> None:
    intro = _blocks("поток-каталога")
    assert excerpt_parts("Вступление без таблицы.", intro) is None  # no table: the plain excerpt is shown
    blocks = _blocks("источник-и-получатель")
    assert excerpt_parts("[фрагмент скрыт] Источник ARIS", blocks) is None  # not the section's words
    assert excerpt_parts("Перед таблицей идёт короткое пояснение.", blocks) is None  # touches no table
    # An unknown anchor never falls back to another section.
    assert citation_excerpt_parts(TABLE_BODY, "нет-такого-раздела", "Источник ARIS (условная модель)") is None
    # Without an anchor the whole document is searched.
    whole = citation_excerpt_parts(TABLE_BODY, None, "Получатель Data Catalog SYS-CAT")
    assert whole is not None and whole[0].kind == "table"


def test_answer_cites_a_table_with_rows_and_the_quote_stays_verbatim(
    client: TestClient, workspace: Path
) -> None:
    write_doc(workspace, "flow.md", make_doc("TBL-001", title="Поток каталога", body=TABLE_BODY))
    answer = ask(client, "Какой код у системы-получателя Data Catalog?")
    cited = [c for c in answer["citations"] if c["document_id"] == "TBL-001"]
    assert cited, answer
    citation = cited[0]
    assert_citations_valid(client, answer)  # the excerpt itself is the verbatim, verified quote
    parts = citation["excerpt_parts"]
    assert parts is not None
    table = next(p for p in parts if p["kind"] == "table")
    assert table["headers"] == ["Роль", "Система", "Код", "Комментарий"]
    assert ["Получатель", "Data Catalog", "SYS-CAT", "каталог активов"] in table["rows"]
    # Citations of prose sections carry no parts.
    plain = ask(client, "What layers does the demonstration architecture have?")
    assert all(c.get("excerpt_parts") is None for c in plain["citations"])


def test_model_input_and_verification_are_unchanged_by_the_display(
    client: TestClient, workspace: Path
) -> None:
    write_doc(workspace, "flow.md", make_doc("TBL-001", title="Поток каталога", body=TABLE_BODY))
    quote = "Получатель Data Catalog SYS-CAT каталог активов"
    sent = use_model(
        client,
        '{"answer": "Получатель — Data Catalog [C1].", "confidence": "supported", '
        f'"citations": [{{"id": "C1", "quote": "{quote}"}}]}}',
    )
    answer = ask(client, "Какой код у системы-получателя Data Catalog?")
    user_message = sent[0]["messages"][1]["content"]
    # The provider reads the passage exactly as before (section text, whitespace collapsed).
    assert "Роль Система Код Комментарий Источник ARIS (условная модель) SYS-ARIS" in user_message
    citation = answer["citations"][0]
    assert citation["excerpt"] == quote
    assert citation["excerpt_parts"][0]["rows"] == [
        ["Получатель", "Data Catalog", "SYS-CAT", "каталог активов"]
    ]
