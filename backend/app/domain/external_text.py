"""Confluence storage HTML → structured plain text → cite-ready fragments (M5.6.2 §G, Appendix 5 §3).

The page body is untrusted. It is never rendered as HTML; only text survives. Structure that matters for
citations is kept: headings become `## …` lines (fragment boundaries and anchors), list items become
`- …`, table rows become `cell | cell | cell` so a fact inside a table cell survives with its row.
Negations, numbers and units are never touched. Oversized pages are cut deterministically at a line
boundary with an explicit marker, so a quote can never point beyond what was actually retrieved.
"""

from __future__ import annotations

import hashlib
import html
import re
from dataclasses import dataclass
from html.parser import HTMLParser

from app.domain.markdown import slugify
from app.domain.text import strip_control

TRUNCATION_MARKER = "[…страница обрезана: превышен лимит размера…]"
_BLOCK = {"p", "div", "br", "section", "article", "blockquote", "pre"}
_SKIP = {"script", "style", "iframe", "object", "embed", "noscript", "template", "svg"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[str] = []
        self._buffer: list[str] = []
        self._skip_depth = 0
        self._heading: str | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def _flush(self, prefix: str = "") -> None:
        text = " ".join("".join(self._buffer).split())
        self._buffer = []
        if text:
            self.lines.append(prefix + text)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self._heading = tag
        elif tag == "li":
            self._flush()
        elif tag == "tr":
            self._flush()
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
        elif tag in _BLOCK:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6") and self._heading:
            self._flush("## ")
            self._heading = None
        elif tag == "li":
            self._flush("- ")
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            cells = [c for c in self._row if c]
            if cells:
                self.lines.append(" | ".join(cells))
            self._row = None
        elif tag in _BLOCK:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._cell is not None:
            self._cell.append(data)
        else:
            self._buffer.append(data)

    def close(self) -> None:
        super().close()
        self._flush()


def storage_to_text(body: str, *, max_chars: int) -> tuple[str, bool]:
    """Return (plain text, truncated?). Bounded: the parser never sees more than ~4× max_chars."""
    raw = body[: max_chars * 4]
    parser = _TextExtractor()
    parser.feed(raw)
    parser.close()
    lines = [strip_control(html.unescape(line)) for line in parser.lines]
    text = "\n".join(line for line in lines if line.strip())
    truncated = len(raw) < len(body)
    if len(text) > max_chars:
        cut = text.rfind("\n", 0, max_chars)
        text = text[: cut if cut > max_chars // 2 else max_chars]
        truncated = True
    if truncated:
        text = text.rstrip() + "\n" + TRUNCATION_MARKER
    return text, truncated


@dataclass(frozen=True)
class Fragment:
    fragment_id: str  # stable within one page version: s1, s2, …
    heading: str | None
    anchor: str | None
    text: str
    content_hash: str


def fragments(text: str, *, max_fragment_chars: int = 1500) -> list[Fragment]:
    """Split on `## ` headings; long sections are split further at line boundaries."""
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    for line in text.split("\n"):
        if line.startswith("## "):
            sections.append((line[3:].strip(), []))
        else:
            sections[-1][1].append(line)
    result: list[Fragment] = []
    for heading, lines in sections:
        parts: list[list[str]] = [[]]
        size = 0
        for line in lines:
            if size + len(line) > max_fragment_chars and parts[-1]:
                parts.append([])
                size = 0
            parts[-1].append(line)
            size += len(line) + 1
        for part in parts:
            body = "\n".join(part).strip()
            if not body:
                continue
            number = len(result) + 1
            result.append(
                Fragment(
                    fragment_id=f"s{number}",
                    heading=heading,
                    anchor=slugify(heading) if heading else None,
                    text=body,
                    content_hash=hashlib.sha256(body.encode()).hexdigest()[:12],
                )
            )
    return result


_TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(body: str) -> str:
    """Plain text without structure (used by tests to compare quoted fragments)."""
    return " ".join(html.unescape(_TAG_RE.sub(" ", body)).split())
