"""E2E-35 at unit level: Markdown → Confluence Data Center storage format. Supported elements are
converted, everything is escaped, unsupported constructs are reported (never dropped silently)."""

from __future__ import annotations

from app.domain.confluence_storage import render_storage, storage_signature


def render(body: str, title: str = "Документ") -> tuple[str, set[str], set[str]]:
    result = render_storage(body, title=title, document_id="SEM-X-001", status="approved", owner="team")
    return (
        result.storage,
        {i.code for i in result.errors},
        {i.code for i in result.warnings},
    )


def test_supported_elements() -> None:
    storage, errors, warnings = render(
        "# Документ\n\n"
        "## Раздел\n\nАбзац с **жирным**, *курсивом*, ~~зачёркнутым~~ и `кодом`.\n\n"
        "- пункт 1\n- пункт 2\n\n1. первый\n2. второй\n\n"
        "> цитата\n\n"
        "| A | B |\n|---|---|\n| 1 | 2 |\n\n"
        "[ссылка](https://example.org/a?b=1&c=2) и [почта](mailto:team@example.org)\n\n"
        "```python\nprint('x')\n```\n\n---\n"
    )
    assert errors == set() and warnings == set()
    assert "<h1>Документ</h1>" not in storage  # the page title already shows it
    for fragment in (
        "<h2>Раздел</h2>",
        "<strong>жирным</strong>",
        "<em>курсивом</em>",
        "<del>зачёркнутым</del>",
        "<code>кодом</code>",
        "<ul>",
        "<li>пункт 1</li>",
        "<ol>",
        "<blockquote>",
        "<table><tbody>",
        "<th>A</th>",
        "<td>2</td>",
        '<a href="https://example.org/a?b=1&amp;c=2">ссылка</a>',
        '<a href="mailto:team@example.org">почта</a>',
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter>',
        "<![CDATA[print('x')]]>",
        "<hr />",
    ):
        assert fragment in storage, fragment
    assert 'ac:name="info"' in storage and "SEM-X-001" in storage


def test_everything_is_escaped() -> None:
    storage, errors, warnings = render(
        "Текст <script>alert(1)</script> & <b>жирный</b>\n\n`<img src=x onerror=1>`\n\n"
        "```\nend ]]> marker <tag>\n```\n"
    )
    assert "<script" not in storage and "<b>" not in storage and "<img" not in storage
    assert "&lt;script&gt;" in storage and "&amp;" in storage
    assert "]]]]><![CDATA[>" in storage  # CDATA cannot be closed by content
    assert "raw_html_as_text" in warnings and errors == set()


def test_unsafe_links_block_publication() -> None:
    for link in ("javascript:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "file:///etc/passwd"):
        storage, errors, _ = render(f"[нажми]({link})\n")
        assert "unsafe_link" in errors, link
        assert "href=" not in storage.split("</ac:structured-macro>", 1)[1]  # rendered as inert text


def test_unsupported_constructs_are_reported_with_visible_placeholders() -> None:
    storage, errors, warnings = render(
        "![схема](diagram.png)\n\n```mermaid\ngraph TD; A-->B\n```\n\n"
        "См. [архитектуру](SEM-ARCH-001.md) и [файл](../relative/path.txt).\n"
    )
    assert errors == set()
    assert {"image_not_published", "diagram_as_code", "internal_link_as_text", "link_as_text"} <= warnings
    assert "[Изображение не опубликовано: схема]" in storage
    assert "архитектуру" in storage and 'href="SEM-ARCH-001.md"' not in storage


def test_signature_ignores_reserialisation() -> None:
    a = "<p>x</p>\n<p>y<br /></p>\n"
    b = "<p>x</p><p>y<br/></p>"
    assert storage_signature(a) == storage_signature(b)
    assert storage_signature(a) != storage_signature("<p>x</p><p>z</p>")
