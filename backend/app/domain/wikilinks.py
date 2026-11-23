"""Obsidian-like WikiLinks (M5.6.3): `[[ID]]`, `[[ID|label]]`, `[[ID#anchor|label]]`.

Parsed as an INLINE rule of the same markdown-it parser that renders documents, so links inside fenced code,
indented code, inline code and escaped brackets (`\\[[…]]`) are never links — the token stream already
excludes them; YAML frontmatter is split off before the body is parsed. A WikiLink states only a directed
`references` edge: never `depends_on` / `maps_to` / `derived_from`.

The persisted target is the STABLE document ID. `[[Some title]]` is not resolved automatically (titles change
and repeat): it is reported as a title link with candidates, and the editor converts it to `[[ID|title]]`.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from markdown_it import MarkdownIt
from markdown_it.rules_inline import StateInline
from markdown_it.token import Token

MAX_INNER = 300
# A target that LOOKS like an ID (letters/digits with at least one separator and a digit, no spaces).
_ID_LIKE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+$")


@dataclass(frozen=True)
class WikiLink:
    target: str  # as written (an ID, or a title the author has not converted yet)
    anchor: str  # `#anchor` part ("" when absent)
    label: str  # display text as written ("" when absent)
    raw: str
    line: int  # 1-based line in the Markdown body
    excerpt: str  # the source line (plain), for backlinks and diagnostics

    @property
    def id_like(self) -> bool:
        return bool(_ID_LIKE_RE.fullmatch(self.target))

    @property
    def display(self) -> str:
        return self.label or self.target


def _rule(state: StateInline, silent: bool) -> bool:
    src, pos = state.src, state.pos
    if not src.startswith("[[", pos):
        return False
    end = src.find("]]", pos + 2)
    if end < 0:
        return False
    inner = src[pos + 2 : end]
    if not inner.strip() or len(inner) > MAX_INNER or any(ch in inner for ch in "[]\n"):
        return False
    target_part, _, label = inner.partition("|")
    target, _, anchor = target_part.partition("#")
    if not target.strip():
        return False
    if not silent:
        token = state.push("wikilink", "", 0)
        token.content = label.strip() or target.strip()
        token.meta = {
            "target": target.strip(),
            "anchor": anchor.strip(),
            "label": label.strip(),
            "raw": src[pos : end + 2],
        }
    state.pos = end + 2
    return True


def use_wikilinks(md: MarkdownIt) -> MarkdownIt:
    md.inline.ruler.before("link", "wikilink", _rule)
    return md


def _parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False})
    md.enable(["table", "strikethrough"])
    return use_wikilinks(md)


_PARSER = _parser()


def extract_wikilinks(body: str) -> list[WikiLink]:
    """All WikiLinks of a Markdown body in document order, with line numbers and the source line."""
    return wikilinks_from_tokens(_PARSER.parse(body), body)


def wikilinks_from_tokens(tokens: Sequence[Token], body: str) -> list[WikiLink]:
    """Same as extract_wikilinks, from an already parsed token stream (one parse per document)."""
    lines = body.splitlines()
    links: list[WikiLink] = []
    for token in tokens:
        if token.type != "inline" or not token.children or token.map is None:
            continue
        offset = 0
        for child in token.children:
            if child.type != "wikilink":
                continue
            raw = str(child.meta["raw"])
            at = token.content.find(raw, offset)
            offset = at + len(raw) if at >= 0 else offset
            line_no = token.map[0] + (token.content.count("\n", 0, at) if at >= 0 else 0)
            source_line = lines[line_no] if 0 <= line_no < len(lines) else ""
            links.append(
                WikiLink(
                    target=str(child.meta["target"]),
                    anchor=str(child.meta["anchor"]),
                    label=str(child.meta["label"]),
                    raw=raw,
                    line=line_no + 1,
                    excerpt=" ".join(source_line.split())[:200],
                )
            )
    return links
