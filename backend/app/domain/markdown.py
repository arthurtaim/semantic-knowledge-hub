"""Safe Markdown processing: one parser for sections, plain text, anchors and sanitized HTML.

Using the same token stream for section extraction and HTML rendering guarantees that a
citation's `section_anchor` matches the `id` of the rendered heading.
"""

from __future__ import annotations

import html
import re
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import nh3
from markdown_it import MarkdownIt
from markdown_it.renderer import RendererHTML
from markdown_it.token import Token
from markdown_it.utils import EnvType, OptionsDict

from app.domain.models import Section
from app.domain.wikilinks import WikiLink, use_wikilinks, wikilinks_from_tokens

_ALLOWED_TAGS = {
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "blockquote",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "s",
    "del",
    "code",
    "pre",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
}
_ALLOWED_ATTRIBUTES = {
    "h1": {"id"},
    "h2": {"id"},
    "h3": {"id"},
    "h4": {"id"},
    "h5": {"id"},
    "h6": {"id"},
    "a": {"href", "title", "target", "class"},
    "code": {"class"},
    "span": {"class"},
    "ol": {"start"},
}
_ALLOWED_URL_SCHEMES = {"http", "https", "mailto"}
_DOC_LINK_RE = re.compile(r"^(?:\./)?([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\.md(#[\w-]*)?$")


def slugify(text: str) -> str:
    """GitHub-like heading slug that keeps Unicode letters (Cyrillic) and digits."""
    normalized = unicodedata.normalize("NFKC", text).strip().lower()
    chars: list[str] = []
    for ch in normalized:
        if ch.isalnum():
            chars.append(ch)
        elif ch in (" ", "-", "_"):
            chars.append("-")
    slug = re.sub(r"-{2,}", "-", "".join(chars)).strip("-")
    return slug or "section"


class AnchorRegistry:
    """Assigns unique anchors in document order (`intro`, `intro-1`, …)."""

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    def assign(self, heading: str) -> str:
        base = slugify(heading)
        count = self._seen.get(base, 0)
        self._seen[base] = count + 1
        return base if count == 0 else f"{base}-{count}"


def _new_parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False})
    md.enable(["table", "strikethrough"])
    return use_wikilinks(md)


# Resolves a WikiLink target to (canonical ID, title) among documents the READER can see; None otherwise.
WikiResolver = Callable[[str], tuple[str, str] | None]


_PARSER = _new_parser()


def _inline_plain(token: Token) -> str:
    parts: list[str] = []
    for child in token.children or []:
        if child.type in ("text", "code_inline", "wikilink"):
            parts.append(child.content)
        elif child.type in ("softbreak", "hardbreak"):
            parts.append(" ")
        elif child.type == "image":
            parts.append(child.content)
    return "".join(parts)


@dataclass(frozen=True)
class ParsedMarkdown:
    sections: list[Section]
    plain_text: str
    paragraphs: list[str]
    wikilinks: list[WikiLink]


def parse_markdown(body: str, title_fallback: str = "") -> ParsedMarkdown:
    """Split Markdown into heading-delimited sections of plain text."""
    tokens = _PARSER.parse(body)
    anchors = AnchorRegistry()
    sections: list[Section] = []
    paragraphs: list[str] = []
    current_heading = title_fallback
    current_anchor = ""
    current_level = 0
    current_blocks: list[str] = []
    in_heading = False
    heading_level = 0

    def flush() -> None:
        text = "\n".join(b for b in current_blocks if b).strip()
        if text or current_anchor:
            sections.append(
                Section(heading=current_heading, anchor=current_anchor, level=current_level, text=text)
            )

    for i, token in enumerate(tokens):
        if token.type == "heading_open":
            in_heading = True
            heading_level = int(token.tag[1])
        elif token.type == "heading_close":
            in_heading = False
        elif token.type == "inline" and in_heading:
            flush()
            current_heading = _inline_plain(token).strip()
            current_anchor = anchors.assign(current_heading)
            current_level = heading_level
            current_blocks = []
        elif token.type == "inline":
            text = _inline_plain(token).strip()
            if text:
                current_blocks.append(text)
                prev = tokens[i - 1].type if i > 0 else ""
                if prev == "paragraph_open":
                    paragraphs.append(text)
        elif token.type in ("fence", "code_block"):
            code = token.content.strip()
            if code:
                current_blocks.append(code)
    flush()
    plain = "\n".join(s.text for s in sections if s.text)
    return ParsedMarkdown(
        sections=sections,
        plain_text=plain,
        paragraphs=paragraphs,
        wikilinks=wikilinks_from_tokens(tokens, body),
    )


class _SafeRenderer(RendererHTML):
    """Adds heading anchors, neutralizes images and marks external links."""

    def heading_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        registry: AnchorRegistry = env.setdefault("anchors", AnchorRegistry())
        inline = tokens[idx + 1]
        tokens[idx].attrSet("id", registry.assign(_inline_plain(inline).strip()))
        return self.renderToken(tokens, idx, options, env)

    def image(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        alt = html.escape(_inline_plain(tokens[idx]) or "без подписи")
        return f'<span class="md-image-placeholder">[Изображение: {alt}]</span>'

    def wikilink(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        meta = tokens[idx].meta
        label = str(meta.get("label") or "")
        resolve: WikiResolver | None = env.get("wikilink_resolve")
        found = resolve(str(meta.get("target", ""))) if resolve else None
        if found is None:  # missing, inaccessible or a title link: show only what the author wrote
            text = html.escape(label or str(meta.get("target", "")))
            return f'<span class="wikilink wikilink--unresolved" title="Ссылка не разрешена">{text}</span>'
        doc_id, title = found
        anchor = str(meta.get("anchor") or "")
        href = f"/documents/{quote(doc_id)}" + (f"#{quote(slugify(anchor))}" if anchor else "")
        text = html.escape(label or doc_id)
        return f'<a href="{href}" class="wikilink" title="{html.escape(title)}">{text}</a>'

    def link_open(self, tokens: Sequence[Token], idx: int, options: OptionsDict, env: EnvType) -> str:
        token = tokens[idx]
        href = str(token.attrGet("href") or "")
        doc_match = _DOC_LINK_RE.match(href)
        if doc_match:  # repository-relative link to another knowledge document
            anchor = doc_match.group(2) or ""
            token.attrSet("href", f"/documents/{doc_match.group(1)}{anchor}")
        elif href.startswith(("http://", "https://")):
            token.attrSet("target", "_blank")
        return self.renderToken(tokens, idx, options, env)


def render_html(body: str, resolve: WikiResolver | None = None) -> str:
    """Render Markdown to sanitized HTML. Raw HTML in the source is escaped, never executed.
    `resolve` turns WikiLinks into links to documents the reader can see; without it they stay text."""
    md = _new_parser()
    md.renderer = _SafeRenderer(md)
    env: dict[str, Any] = {"wikilink_resolve": resolve}
    rendered = md.render(body, env)
    return nh3.clean(
        rendered,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRIBUTES,
        url_schemes=_ALLOWED_URL_SCHEMES,
        link_rel="noopener noreferrer nofollow",
        strip_comments=True,
    )


def first_meaningful_paragraph(paragraphs: list[str], limit: int = 280) -> str:
    """Excerpt for lists: first paragraph that is not a DEMO banner."""
    for paragraph in paragraphs:
        if re.match(r"^\W*(DEMO ONLY|ДЕМО)", paragraph, flags=re.IGNORECASE):
            continue
        return truncate(paragraph, limit)
    return truncate(paragraphs[0], limit) if paragraphs else ""


def truncate(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0]
    return cut + "…"
