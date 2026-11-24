"""Readable display of a cited excerpt that comes from a Markdown table (`Citation.excerpt_parts`).

Section text glues the cells of a table together («Роль Система Код Комментарий Источник ARIS …»): that text is what
search indexes, what a provider reads and what a quote is verified against, so it stays as it is. For DISPLAY the
server traces the verified quote back to the cited section's Markdown — word by word, the tokens of the quote are a
contiguous run of the section's tokens — and returns the quote's prose plus the table rows it touches, with the
header row. Nothing here creates evidence: without a confident match there are no parts and the plain excerpt is
shown; the table cells are the section's own text at the cited revision.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.domain.markdown import Block, TableBlock, TextBlock, section_blocks
from app.domain.models import ExcerptPart
from app.domain.text import token_spans

ELLIPSIS = "…"
# Opening punctuation that belongs to the word after it: kept with the prose that starts at that word.
_OPENERS = "«„“\"'([{"


@dataclass(frozen=True)
class _Unit:
    token: str
    block: int
    row: int  # -1: prose; 0: the table's header row; 1…: body rows


def _units(blocks: Sequence[Block]) -> list[_Unit]:
    units: list[_Unit] = []
    for index, block in enumerate(blocks):
        if isinstance(block, TextBlock):
            units += [_Unit(token, index, -1) for token, _, _ in token_spans(block.text)]
            continue
        for row_no, cells in enumerate((block.headers, *block.rows)):
            for cell in cells:
                units += [_Unit(token, index, row_no) for token, _, _ in token_spans(cell)]
    return units


def _find(units: list[_Unit], words: list[str]) -> int | None:
    """Start of the first run of `units` spelling `words`; the first and last words may be cut (a quote that
    starts or ends inside a word)."""
    n = len(words)
    for start in range(len(units) - n + 1):
        if n == 1:
            if words[0] in units[start].token:
                return start
            continue
        if not units[start].token.endswith(words[0]) or not units[start + n - 1].token.startswith(words[-1]):
            continue
        if all(units[start + k].token == words[k] for k in range(1, n - 1)):
            return start
    return None


def _cut(text: str, position: int) -> int:
    while position > 0 and text[position - 1] in _OPENERS:
        position -= 1
    return position


def _push_text(parts: list[ExcerptPart], text: str) -> None:
    text = text.strip()
    if not text:
        return
    if parts and parts[-1].kind == "text":
        parts[-1] = ExcerptPart(kind="text", text=f"{parts[-1].text} {text}")
    else:
        parts.append(ExcerptPart(kind="text", text=text))


def excerpt_parts(quote: str, blocks: Sequence[Block]) -> list[ExcerptPart] | None:
    """The quote as prose and table rows, or None when it touches no table or cannot be traced to `blocks`.
    `quote` may join several pieces with « … » (as `quote_is_verbatim` accepts); each piece is traced on its own."""
    if not any(isinstance(block, TableBlock) for block in blocks):
        return None
    units = _units(blocks)
    pieces = [p.strip().rstrip(ELLIPSIS).strip() for p in quote.split(f" {ELLIPSIS} ")]
    parts: list[ExcerptPart] = []
    for piece_no, piece in enumerate(p for p in pieces if p):
        spans = token_spans(piece)
        if not spans:
            continue
        start = _find(units, [token for token, _, _ in spans])
        if start is None:
            return None
        if piece_no:
            _push_text(parts, ELLIPSIS)
        # Consecutive words of the quote that come from one block form one group: prose or a table.
        groups: list[tuple[int, int, int]] = []  # (block, first word, last word)
        for k in range(len(spans)):
            block_no = units[start + k].block
            if groups and groups[-1][0] == block_no:
                groups[-1] = (block_no, groups[-1][1], k)
            else:
                groups.append((block_no, k, k))
        for g, (block_no, first, last) in enumerate(groups):
            block = blocks[block_no]
            if isinstance(block, TableBlock):
                touched = sorted({units[start + k].row for k in range(first, last + 1)})
                parts.append(
                    ExcerptPart(
                        kind="table",
                        headers=list(block.headers),
                        rows=[list(block.rows[r - 1]) for r in touched if r >= 1],
                    )
                )
                continue
            begin = 0 if g == 0 else _cut(piece, spans[first][1])
            end = len(piece) if g == len(groups) - 1 else _cut(piece, spans[last + 1][1])
            _push_text(parts, piece[begin:end])
    return parts if any(part.kind == "table" for part in parts) else None


def citation_excerpt_parts(body: str, anchor: str | None, quote: str) -> list[ExcerptPart] | None:
    """`excerpt_parts` of a quote from a document's Markdown `body`: within the cited section when the citation
    names one, else within the whole document."""
    sections = section_blocks(body)
    if anchor:
        blocks = next((b for a, b in sections if a == anchor), None)
        return excerpt_parts(quote, blocks) if blocks is not None else None
    return excerpt_parts(quote, [block for _, section in sections for block in section])
