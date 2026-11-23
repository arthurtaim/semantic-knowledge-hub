"""Markdown → Confluence Data Center *storage format* (XHTML-based), for M5 publication.

Built from the same markdown-it token stream as the in-app renderer. Every text node and attribute is
escaped; raw HTML is never passed through (the parser runs with html=False); only http(s)/mailto links
survive. Constructs that cannot be published faithfully are reported BEFORE publication: unsafe links
are errors (publication is blocked), images/raw HTML/diagrams/internal links are warnings with a
visible placeholder — nothing is dropped silently (docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md).
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from html import escape
from urllib.parse import urlsplit

from markdown_it import MarkdownIt
from markdown_it.token import Token

from app.domain.models import ValidationIssue

_LANG_RE = re.compile(r"^[A-Za-z0-9+#._-]{1,24}$")
_DIAGRAM_LANGS = frozenset({"mermaid", "plantuml", "puml", "dot", "graphviz"})
_DOC_LINK_RE = re.compile(r"^(?:\./)?([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\.md(#[\w-]*)?$")
_UNSAFE_LINK_RE = re.compile(r"\]\(\s*<?\s*(javascript|vbscript|data|file):", re.IGNORECASE)
_RAW_HTML_RE = re.compile(r"<\s*/?\s*[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?>")
_SAFE_SCHEMES = ("http", "https", "mailto")


def _issue(severity: str, code: str, message: str) -> ValidationIssue:
    return ValidationIssue.model_validate({"severity": severity, "code": code, "message": message})


@dataclass
class StorageRender:
    storage: str
    issues: list[ValidationIssue] = field(default_factory=list)

    @property
    def errors(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "warning"]


def storage_hash(storage: str) -> str:
    return "sha256:" + hashlib.sha256(storage.encode("utf-8")).hexdigest()


def storage_signature(storage: str) -> str:
    """Hash that ignores whitespace between tags — Confluence may re-serialize stored XHTML."""
    compact = re.sub(r">\s+<", "><", storage.strip())
    compact = re.sub(r"<br\s*/?>", "<br/>", compact)
    return "sig:" + hashlib.sha256(compact.encode("utf-8")).hexdigest()


def _attr(value: str) -> str:
    return escape(value, quote=True)


def _cdata(text: str) -> str:
    return "<![CDATA[" + text.replace("]]>", "]]]]><![CDATA[>") + "]]>"


class _Renderer:
    def __init__(self) -> None:
        self.issues: list[ValidationIssue] = []
        self._seen: set[str] = set()

    def note(self, severity: str, code: str, message: str) -> None:
        if code + message not in self._seen:
            self._seen.add(code + message)
            self.issues.append(_issue(severity, code, message))

    # --- inline ------------------------------------------------------------------------------
    def inline(self, tokens: Sequence[Token]) -> str:
        out: list[str] = []
        link_stack: list[bool] = []  # True when the matching link_open emitted <a>
        for token in tokens:
            kind = token.type
            if kind == "text":
                out.append(escape(token.content, quote=False))
            elif kind == "softbreak":
                out.append("\n")
            elif kind == "hardbreak":
                out.append("<br />")
            elif kind == "code_inline":
                out.append(f"<code>{escape(token.content, quote=False)}</code>")
            elif kind in ("strong_open", "strong_close"):
                out.append("<strong>" if kind.endswith("open") else "</strong>")
            elif kind in ("em_open", "em_close"):
                out.append("<em>" if kind.endswith("open") else "</em>")
            elif kind in ("s_open", "s_close"):
                out.append("<del>" if kind.endswith("open") else "</del>")
            elif kind == "link_open":
                href = str(token.attrGet("href") or "")
                emitted = self._link_open(href, out)
                link_stack.append(emitted)
            elif kind == "link_close":
                if link_stack.pop() if link_stack else False:
                    out.append("</a>")
            elif kind == "image":
                alt = "".join(c.content for c in (token.children or [])) or "без подписи"
                self.note(
                    "warning",
                    "image_not_published",
                    "Изображения не публикуются: на странице будет текстовая отметка вместо картинки.",
                )
                out.append(f"<em>[Изображение не опубликовано: {escape(alt, quote=False)}]</em>")
            elif kind == "html_inline":
                out.append(escape(token.content, quote=False))
            else:  # unknown inline token: keep its text visible
                out.append(escape(token.content, quote=False))
        return "".join(out)

    def _link_open(self, href: str, out: list[str]) -> bool:
        doc = _DOC_LINK_RE.match(href)
        if doc:
            self.note(
                "warning",
                "internal_link_as_text",
                f"Ссылка на документ {doc.group(1)} опубликована текстом: внутренние ссылки базы знаний "
                "не преобразуются в ссылки Confluence.",
            )
            return False
        try:
            parts = urlsplit(href)
        except ValueError:
            parts = None
        if (
            parts is not None
            and parts.scheme.lower() in _SAFE_SCHEMES
            and (parts.netloc or parts.scheme == "mailto")
        ):
            out.append(f'<a href="{_attr(href)}">')
            return True
        self.note(
            "warning", "link_as_text", f"Ссылка «{href[:80]}» опубликована текстом (не http(s)/mailto)."
        )
        return False

    # --- blocks ------------------------------------------------------------------------------
    def blocks(self, tokens: list[Token], title: str) -> str:
        out: list[str] = []
        i = 0
        skip_title = True
        while i < len(tokens):
            token = tokens[i]
            kind = token.type
            if kind == "heading_open":
                text = self.inline(tokens[i + 1].children or [])
                plain = "".join(c.content for c in (tokens[i + 1].children or []))
                if skip_title and token.tag == "h1" and plain.strip() == title.strip():
                    i += 3  # the page title already shows it
                    skip_title = False
                    continue
                out.append(f"<{token.tag}>{text}</{token.tag}>")
                i += 3
                skip_title = False
                continue
            skip_title = skip_title and kind in ("html_block",)
            if kind == "paragraph_open":
                inline = tokens[i + 1]
                content = self.inline(inline.children or [])
                out.append(content if token.hidden else f"<p>{content}</p>")
                i += 3
                continue
            if kind in ("bullet_list_open", "bullet_list_close"):
                out.append("<ul>" if kind.endswith("open") else "</ul>")
            elif kind == "ordered_list_open":
                start = token.attrGet("start")
                if start not in (None, 1, "1"):
                    self.note("warning", "list_start_ignored", "Нумерация списка начнётся с 1.")
                out.append("<ol>")
            elif kind == "ordered_list_close":
                out.append("</ol>")
            elif kind in ("list_item_open", "list_item_close"):
                out.append("<li>" if kind.endswith("open") else "</li>")
            elif kind in ("blockquote_open", "blockquote_close"):
                out.append("<blockquote>" if kind.endswith("open") else "</blockquote>")
            elif kind == "hr":
                out.append("<hr />")
            elif kind in ("fence", "code_block"):
                out.append(self._code(token))
            elif kind == "table_open":
                out.append("<table><tbody>")
            elif kind == "table_close":
                out.append("</tbody></table>")
            elif kind in ("thead_open", "thead_close", "tbody_open", "tbody_close"):
                pass
            elif kind in ("tr_open", "tr_close"):
                out.append("<tr>" if kind.endswith("open") else "</tr>")
            elif kind in ("th_open", "td_open"):
                cell = token.tag
                content = self.inline(tokens[i + 1].children or [])
                out.append(f"<{cell}>{content}</{cell}>")
                i += 3
                continue
            elif kind == "html_block":
                self.note("warning", "raw_html_as_text", "HTML-разметка опубликована как текст.")
                out.append(f"<p>{escape(token.content.strip(), quote=False)}</p>")
            i += 1
        return "\n".join(out)

    def _code(self, token: Token) -> str:
        language = (token.info or "").strip().split(" ")[0].lower()
        parameter = ""
        if language in _DIAGRAM_LANGS:
            self.note(
                "warning",
                "diagram_as_code",
                f"Диаграмма «{language}» будет опубликована как исходный код, а не как рисунок.",
            )
        if language and _LANG_RE.fullmatch(language):
            parameter = f'<ac:parameter ac:name="language">{_attr(language)}</ac:parameter>'
        body = token.content.rstrip("\n")
        return (
            f'<ac:structured-macro ac:name="code">{parameter}'
            f"<ac:plain-text-body>{_cdata(body)}</ac:plain-text-body></ac:structured-macro>"
        )


def _parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False})
    md.enable(["table", "strikethrough"])
    return md


def render_storage(
    body: str,
    *,
    title: str,
    document_id: str,
    status: str,
    owner: str,
) -> StorageRender:
    """Render a document body. The leading info panel identifies the managed page for humans; the
    machine-readable ownership marker is a content property written by the publisher."""
    renderer = _Renderer()
    if _UNSAFE_LINK_RE.search(body):
        renderer.note(
            "error",
            "unsafe_link",
            "Документ содержит небезопасную ссылку (javascript:/data:/file:/vbscript:). Публикация запрещена.",
        )
    if _RAW_HTML_RE.search(re.sub(r"```.*?```|`[^`]*`", "", body, flags=re.DOTALL)):
        renderer.note("warning", "raw_html_as_text", "HTML-разметка опубликована как текст.")
    content = renderer.blocks(_parser().parse(body), title)
    content = re.sub(r"<li>\n", "<li>", re.sub(r"\n</li>", "</li>", content))  # tight list items
    panel = (
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Страница опубликована из базы знаний '
        f"команды (GitLab): документ <code>{escape(document_id, quote=False)}</code>, статус "
        f"<code>{escape(status, quote=False)}</code>, владелец {escape(owner, quote=False)}. Изменения "
        "вносятся только через GitLab Merge Request; ручная правка этой страницы будет обнаружена как "
        "конфликт и не будет перезаписана автоматически.</p></ac:rich-text-body></ac:structured-macro>"
    )
    return StorageRender(storage=f"{panel}\n{content}\n", issues=renderer.issues)
