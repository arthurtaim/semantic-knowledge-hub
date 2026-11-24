"""Apply a template to an existing document — later, after it was written (docs/TEMPLATE_HUB.md).

Pure functions: nothing here reads or writes storage. The result is always shown as a diff and saved only after the
person confirms it (a draft is updated with its version guard; an approved document gets a change proposal).

Rules of the body (`apply_template_to_body`):

- every existing line is kept, in its order: the body only GAINS lines (skeletons of missing required sections);
- an existing `## ` heading maps to a template section when the titles are equal ignoring case and surrounding
  spaces — the same comparison as the template validation (`templates.missing_sections`);
- a missing REQUIRED section gets the template's skeleton (the «Требует уточнения» placeholder); a missing OPTIONAL
  section is not added; a section the template does not know is kept as is;
- a missing section goes after the nearest preceding template section already in the document (so the template
  order is followed wherever the document allows it), else before the nearest following one, else at the end;
- `## ` lines inside fenced code blocks are text, never sections.

Front matter (`set_template_fields`): only `type`, `template` and `template_version` change; every other line of the
YAML stays byte for byte (a document keeps its ID, status, owner, relations, dates and unknown fields).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

import yaml

from app.domain.schema import FrontmatterError, load_frontmatter, split_frontmatter
from app.domain.templates import DocumentTemplate

SectionState = Literal["matched", "added", "kept", "optional_missing"]

_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
# The same heading rule as the template validation (`templates._HEADING_RE`).
_H2_RE = re.compile(r"^##\s+(.+?)\s*$")
# Keys of the front matter that applying a template rewrites.
TEMPLATE_KEYS = ("type", "template", "template_version")


@dataclass(frozen=True)
class SectionMapping:
    heading: str  # as it reads in the result
    template_heading: str | None  # the template section it maps to (None: unknown to the template)
    state: SectionState
    required: bool  # a required section of the template


@dataclass(frozen=True)
class AppliedBody:
    body: str
    sections: tuple[SectionMapping, ...]


def heading_key(heading: str) -> str:
    """Comparison key of a `##` title — the validator's rule (case and surrounding spaces ignored)."""
    return heading.strip().casefold()


def split_sections(body: str) -> tuple[list[str], list[tuple[str, list[str]]]]:
    """(preamble lines, [(heading, lines incl. the heading line)]) split at level-2 headings outside code fences."""
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    fence: str | None = None
    for line in body.split("\n"):
        marker = _FENCE_RE.match(line)
        heading = None
        if fence is not None:
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                fence = None
        elif marker:
            fence = marker.group(1)
        else:
            match = _H2_RE.match(line)
            heading = match.group(1) if match else None
        if heading is not None:
            sections.append((heading, [line]))
        elif sections:
            sections[-1][1].append(line)
        else:
            preamble.append(line)
    return preamble, sections


def _skeleton(lines: list[str]) -> list[str]:
    """A template section without blank lines at its edges (the heading line first)."""
    result = list(lines)
    while result and not result[-1].strip():
        result.pop()
    return result


def apply_template_to_body(body: str, template: DocumentTemplate) -> AppliedBody:
    text = body.replace("\r\n", "\n").replace("\r", "\n")
    core = text.rstrip("\n")
    trailing = text[len(core) :] or "\n"
    preamble, sections = split_sections(core) if core else ([], [])
    _, template_sections = split_sections(template.body)
    required = {heading_key(s) for s in template.sections}

    matched: dict[int, int] = {}  # template section index -> document section index
    used: set[int] = set()
    for ti, (t_heading, _) in enumerate(template_sections):
        for si, (s_heading, _) in enumerate(sections):
            if si not in used and heading_key(s_heading) == heading_key(t_heading):
                matched[ti] = si
                used.add(si)
                break

    order: list[tuple[Literal["doc", "tpl"], int]] = [("doc", i) for i in range(len(sections))]
    for ti, (t_heading, _) in enumerate(template_sections):
        if ti in matched or heading_key(t_heading) not in required:
            continue
        position: int | None = None
        for previous in range(ti - 1, -1, -1):
            anchor: tuple[Literal["doc", "tpl"], int] = (
                ("doc", matched[previous]) if previous in matched else ("tpl", previous)
            )
            if anchor in order:
                position = order.index(anchor) + 1
                break
        if position is None:
            following = next((n for n in range(ti + 1, len(template_sections)) if n in matched), None)
            position = order.index(("doc", matched[following])) if following is not None else len(order)
        order.insert(position, ("tpl", ti))

    by_doc = {si: ti for ti, si in matched.items()}
    lines = list(preamble)  # existing lines are emitted unchanged; only blank separators are added
    report: list[SectionMapping] = []
    for kind, index in order:
        if kind == "doc":
            heading, block = sections[index]
            mapped = by_doc.get(index)
            mapped_heading = template_sections[mapped][0] if mapped is not None else None
            lines.extend(block)  # unchanged; an inserted skeleton before it already ends with a blank line
            report.append(
                SectionMapping(
                    heading=heading,
                    template_heading=mapped_heading,
                    state="matched" if mapped_heading is not None else "kept",
                    required=mapped_heading is not None and heading_key(mapped_heading) in required,
                )
            )
        else:
            t_heading, block = template_sections[index]
            if lines and lines[-1].strip():
                lines.append("")
            lines.extend(_skeleton(block))
            lines.append("")
            report.append(SectionMapping(t_heading, t_heading, "added", True))
    for ti, (t_heading, _) in enumerate(template_sections):
        if ti not in matched and heading_key(t_heading) not in required:
            report.append(SectionMapping(t_heading, t_heading, "optional_missing", False))
    while lines and lines[-1] == "":  # `core` ends with a non-empty line: trailing "" are added separators
        lines.pop()
    return AppliedBody(body="\n".join(lines) + trailing, sections=tuple(report))


def _set_line(yaml_lines: list[str], key: str, value: str, after: str | None) -> None:
    """Replace the top-level single-line `key:`; insert it (after `after:` when present, else last) if absent."""
    pattern = re.compile(rf"^{re.escape(key)}\s*:")
    for index, line in enumerate(yaml_lines):
        if pattern.match(line):
            yaml_lines[index] = f"{key}: {value}"
            return
    if after is not None:
        anchor = re.compile(rf"^{re.escape(after)}\s*:")
        for index, line in enumerate(yaml_lines):
            if anchor.match(line):
                yaml_lines.insert(index + 1, f"{key}: {value}")
                return
    yaml_lines.append(f"{key}: {value}")


def set_template_fields(yaml_text: str, template: DocumentTemplate) -> str:
    """The YAML with `type`, `template` and `template_version` of the template; every other line unchanged.

    A value written over several lines (unusual for these keys) falls back to re-serialising the mapping, so the
    result is always valid YAML with exactly these three values.
    """
    wanted: dict[str, Any] = {
        "type": template.doc_type.value,
        "template": template.id,
        "template_version": template.version,
    }
    lines = yaml_text.split("\n")
    _set_line(lines, "type", wanted["type"], after="title")
    _set_line(lines, "template", wanted["template"], after=None)
    _set_line(lines, "template_version", str(wanted["template_version"]), after="template")
    edited = "\n".join(lines)
    try:
        loaded = load_frontmatter(edited)
        if all(loaded.get(k) == v for k, v in wanted.items()):
            return edited
    except FrontmatterError:
        pass
    data = dict(load_frontmatter(yaml_text))
    data.update(wanted)
    dumped = yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=None, width=1000)
    return dumped.rstrip("\n")


@dataclass(frozen=True)
class AppliedDocument:
    content: str
    sections: tuple[SectionMapping, ...]
    previous: dict[str, Any]  # `type`, `template`, `template_version` before (absent keys are None)


def apply_template_to_content(content: str, template: DocumentTemplate) -> AppliedDocument:
    """A full Markdown file (YAML front matter + body) with the template applied. Raises FrontmatterError."""
    normalized = content.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    yaml_text, body = split_frontmatter(normalized)
    meta = load_frontmatter(yaml_text)
    rest = normalized[4 + len(yaml_text) :]  # "\n---" + the blank lines + the body
    separator = rest[: len(rest) - len(body)]
    applied = apply_template_to_body(body, template)
    return AppliedDocument(
        content=f"---\n{set_template_fields(yaml_text, template)}{separator}{applied.body}",
        sections=applied.sections,
        previous={key: meta.get(key) for key in TEMPLATE_KEYS},
    )
