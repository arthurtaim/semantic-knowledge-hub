"""UI Workstream A: a Markdown final answer survives server validation with its markers intact.

The scripted model double (tests/support/scripted_model.py, «оформи») answers in Markdown — a heading, bold, a list,
inline code and a GFM table — with a system-fact marker and a citation marker in several places. The server must
keep the formatting, rewrite verified `[Cn]` to `[n]` (also inside a code span: the UI, not the server, decides that
code is not a reference), keep `[F1]` for its fact and leave a literal `[7]` alone. Synthetic data only.
"""

from __future__ import annotations

import pytest

from tests.test_assistant_tool_loop import Factory, ask, m57_workspace, tool_client  # noqa: F401  (fixtures)


@pytest.mark.parametrize("kind", ["openai", "claude"])
def test_markdown_answer_keeps_formatting_and_verified_markers(tool_client: Factory, kind: str) -> None:  # noqa: F811
    client, _ = tool_client(kind)
    data = ask(client, "Оформи сводку по ARIS в Markdown")
    answer = data["answer"]
    assert data["confidence"] == "supported"
    assert len(data["citations"]) == 1 and data["citations"][0]["ref"] == 1
    assert [f["ref"] for f in data["system_facts"]] == ["F1"]
    # Markdown structure is passed through untouched.
    for fragment in (
        "## Сводка по ARIS",
        "**Что нашлось:**",
        "- Документы описывают:",
        "`BusinessProcess`",
        "| --- | --- |",
    ):
        assert fragment in answer
    # Verified markers in a paragraph, a list item and table cells; no raw model marker is left.
    assert answer.count("[F1]") == 2 and "[C" not in answer
    assert "»* [1]" in answer and "| Цитата | [1] |" in answer
    assert "запись `[1]` в коде" in answer  # the UI keeps this one as code
    assert "Пометка [7] не проверена" in answer  # not a citation: the UI shows it literally
