"""Deterministic analysis of a staged batch (M8): per file the existing single-file import preview (YAML validation,
title, template, tags, related documents with evidence), then batch-level duplicates, conflicts, UPDATE detection
and relation candidates. Works without any model; a model only enriches later (`OnboardingService.suggest`)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.models import UserContext
from app.domain.onboarding import (
    CandidateLink,
    Diagnostic,
    DuplicateRef,
    Evidence,
    ExistingDocRef,
    FieldSuggestion,
)
from app.domain.proposals import MAX_PROPOSED_CHARS
from app.domain.schema import FrontmatterError, load_frontmatter, parse_document, split_frontmatter
from app.domain.wikilinks import extract_wikilinks
from app.errors import ApiError
from app.services.metadata import ImportPreviewRequest, MetadataService
from app.services.onboarding.ingest import IncomingFile
from app.services.onboarding.parsing import Parsed, parse_file
from app.services.proposals import compute_diff
from app.services.retrieval import ID_CANDIDATE_RE

PREVIEW_CHARS = 20_000
DIFF_LINES = 400
SNIPPET = 160
_ORIGIN = {"existing": "frontmatter", "parsed": "parser", "suggested": "heuristic", "system": "system"}
_REFUSED_STATUS = {"nested_archive": "unsupported"}


@dataclass
class ItemAnalysis:
    item_id: str
    path: str
    size: int
    checksum: str
    parsed: Parsed
    content: str | None = None
    analysis: dict[str, Any] = field(default_factory=dict)
    decisions: dict[str, Any] = field(default_factory=dict)


def _hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _snippet(text: str) -> str:
    return " ".join(text.split())[:SNIPPET]


def _diag(severity: str, code: str, message: str, fld: str | None = None) -> dict[str, Any]:
    return Diagnostic(severity=severity, code=code, message=message, field=fld).model_dump()


async def analyze_file(
    user: UserContext, incoming: IncomingFile, ordinal: int, metadata: MetadataService, limits: Any
) -> ItemAnalysis:
    data = incoming.data or b""
    checksum = hashlib.sha256(data).hexdigest()
    item_id = _hex(f"{ordinal}:{incoming.path}:{checksum}")[:16]
    if incoming.data is None:
        status = _REFUSED_STATUS.get(incoming.refused or "", "invalid")
        parsed = Parsed("none", "application/octet-stream", status)  # type: ignore[arg-type]
        item = ItemAnalysis(item_id, incoming.path, 0, "", parsed)
        item.analysis = _empty(
            incoming.path, [_diag("error", incoming.refused or "refused", incoming.refused_message or "")]
        )
        item.decisions = {"excluded": True}
        return item
    parsed = parse_file(incoming.path, data, limits)
    item = ItemAnalysis(item_id, incoming.path, len(data), checksum, parsed)
    diagnostics = [d.model_dump() for d in parsed.diagnostics]
    if parsed.status != "parsed":
        item.analysis = _empty(incoming.path, diagnostics)
        item.decisions = {"excluded": True}
        return item
    text = parsed.text
    if len(text) > MAX_PROPOSED_CHARS:
        item.parsed.status = "invalid"
        diagnostics.append(
            _diag("error", "document_too_large", "Документ слишком большой для одного черновика.")
        )
        item.analysis = _empty(incoming.path, diagnostics)
        item.decisions = {"excluded": True}
        return item
    filename = incoming.path.rsplit("/", 1)[-1]
    try:
        preview = await metadata.import_preview(user, ImportPreviewRequest(content=text, filename=filename))
    except ApiError as exc:
        item.parsed.status = "invalid"
        diagnostics.append(_diag("error", exc.code, exc.message))
        item.analysis = _empty(incoming.path, diagnostics)
        item.decisions = {"excluded": True}
        return item
    item.content = text
    for issue in preview.issues:
        if issue.code == "document_id_taken":
            continue  # an existing document: handled as UPDATE below, not an error
        code = (
            "invalid_yaml"
            if preview.state == "invalid_metadata" and issue.severity == "error"
            else issue.code
        )
        diagnostics.append(_diag(issue.severity, code, issue.message, issue.field))
    if preview.state == "invalid_metadata":
        diagnostics.append(
            _diag(
                "warning",
                "yaml_repair",
                "YAML файла некорректен: черновик будет создан из полей ниже (проверьте их), исходный YAML не "
                "сохранится.",
            )
        )
    fields: list[dict[str, Any]] = []
    for mf in preview.fields:
        origin = _ORIGIN.get(mf.origin, "heuristic")
        evidence = [Evidence(file=incoming.path, snippet=mf.note).model_dump()] if mf.note else []
        evidence += [
            Evidence(
                file=incoming.path,
                snippet=str(e),
                document_id=str(e) if ID_CANDIDATE_RE.fullmatch(str(e)) else None,
            ).model_dump()
            for e in mf.evidence
        ]
        fields.append(
            FieldSuggestion(
                field="template_id" if mf.field == "template" else mf.field,
                value=mf.value,
                origin=origin,
                evidence=[Evidence(**e) for e in evidence],
                needs_review=origin not in ("frontmatter", "system"),
                note=mf.note,
            ).model_dump()
        )
    for name in preview.missing:
        fields.append(
            FieldSuggestion(
                field=name, value=None, origin="heuristic", needs_review=True, note="не определено — укажите"
            ).model_dump()
        )
    meta = (
        dict(parse_document(text).metadata)
        if preview.has_frontmatter and preview.state != "invalid_metadata"
        else {}
    )
    has_valid_yaml = bool(meta) and preview.keeps_original_metadata
    template_id = next((f["value"] for f in fields if f["field"] == "template_id"), None)
    template_doc_type = None
    if template_id:
        tpl = metadata._authoring.registry.get(str(template_id))
        template_doc_type = tpl.doc_type.value if tpl is not None else None
    item.analysis = {
        "document_id": str(meta["id"]) if meta.get("id") else None,
        "declared_id": None if meta or not preview.has_frontmatter else _declared_id(text),
        "title": preview.title,
        "template_id": template_id,
        "doc_type": str(meta.get("type") or template_doc_type or "") or None,
        "operation": "create",
        "existing_doc": None,
        "fields": fields,
        "links": [],
        "diagnostics": diagnostics,
        "duplicates": [],
        "preview_html": preview.preview_html,
        "body": preview.body,
        "body_preview": preview.body[:PREVIEW_CHARS],
        "has_frontmatter": preview.has_frontmatter,
        "has_valid_yaml": has_valid_yaml,
        "yaml_related_ids": [str(x) for x in (meta.get("related_ids") or [])] if has_valid_yaml else [],
        "content_hash": _hex(text),
        "diff": None,
        "diff_stats": None,
        "ai": {"state": "none"},
    }
    item.decisions = {}
    return item


def _empty(path: str, diagnostics: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "document_id": None,
        "title": path.rsplit("/", 1)[-1],
        "template_id": None,
        "doc_type": None,
        "operation": "skip",
        "existing_doc": None,
        "fields": [],
        "links": [],
        "diagnostics": diagnostics,
        "duplicates": [],
        "preview_html": "",
        "body": "",
        "body_preview": "",
        "has_frontmatter": False,
        "has_valid_yaml": False,
        "yaml_related_ids": [],
        "content_hash": "",
        "diff": None,
        "diff_stats": None,
        "ai": {"state": "none"},
    }


def _declared_id(text: str) -> str | None:
    """The `id` a file's frontmatter names even when the YAML as a whole is unusable (to warn, never to act on)."""
    try:
        raw = load_frontmatter(split_frontmatter(text)[0]).get("id")
    except FrontmatterError:
        return None
    return str(raw) if raw and ID_CANDIDATE_RE.fullmatch(str(raw)) else None


def resolve_batch(items: list[ItemAnalysis], snapshot: KnowledgeSnapshot, open_create_ids: set[str]) -> None:
    """Batch-level: UPDATE of existing documents, duplicates and conflicts, relation candidates (in place)."""
    by_hash: dict[str, ItemAnalysis] = {}
    by_id: dict[str, list[ItemAnalysis]] = {}
    titles = {d.title.casefold(): d.id for d in snapshot.documents.values()}
    for item in items:
        if item.parsed.status != "parsed":
            continue
        a = item.analysis
        if item.checksum in by_hash:  # exact duplicate of an earlier file of this batch
            first = by_hash[item.checksum]
            item.parsed.status = "duplicate"
            a["operation"] = "skip"
            a["duplicates"].append(
                DuplicateRef(
                    kind="exact_hash", item_id=first.item_id, message=f"Точная копия «{first.path}»."
                ).model_dump()
            )
            item.decisions = {"excluded": True}
            continue
        by_hash[item.checksum] = item
        doc_id = a["document_id"]
        declared = a.get("declared_id")
        if not doc_id and declared and snapshot.get(declared) is not None:
            a["diagnostics"].append(
                _diag(
                    "warning",
                    "declared_id_not_used",
                    f"В файле указан ID {declared} существующего документа, но YAML некорректен: будет создан НОВЫЙ "
                    f"документ. Чтобы предложить изменение {declared}, исправьте YAML и загрузите файл снова.",
                    "id",
                )
            )
        if doc_id:
            existing = snapshot.get(doc_id)
            if existing is not None:
                a["existing_doc"] = ExistingDocRef(
                    document_id=existing.id,
                    title=existing.title,
                    revision=existing.revision,
                    status=existing.status.value,
                ).model_dump()
                if existing.raw.strip() == (item.content or "").strip():
                    item.parsed.status = "duplicate"
                    a["operation"] = "skip"
                    a["duplicates"].append(
                        DuplicateRef(
                            kind="existing_content",
                            document_id=existing.id,
                            message=f"Совпадает с текущей версией {existing.id}: изменений нет.",
                        ).model_dump()
                    )
                    item.decisions = {"excluded": True}
                    continue
                a["operation"] = "update"
                diff = compute_diff(existing.raw, item.content or "", existing.path)
                a["diff"] = [
                    ln.model_dump() if hasattr(ln, "model_dump") else ln for ln in diff.lines[:DIFF_LINES]
                ]
                a["diff_stats"] = {"additions": diff.additions, "deletions": diff.deletions}
                a["diagnostics"].append(
                    _diag(
                        "warning",
                        "existing_document",
                        f"{existing.id} уже есть в базе ({existing.status.value}): файл станет ПРЕДЛОЖЕНИЕМ ИЗМЕНЕНИЯ "
                        "через обычное ревью, документ не заменяется.",
                        "id",
                    )
                )
            elif doc_id in open_create_ids:
                item.parsed.status = "conflict"
                a["duplicates"].append(
                    DuplicateRef(
                        kind="open_draft",
                        document_id=doc_id,
                        message=f"Черновик нового документа {doc_id} уже открыт.",
                    ).model_dump()
                )
            by_id.setdefault(doc_id, []).append(item)
        title_hit = titles.get(str(a["title"]).casefold())
        if title_hit and title_hit != doc_id:
            a["duplicates"].append(
                DuplicateRef(
                    kind="similar_title",
                    document_id=title_hit,
                    message=f"Такое же название у {title_hit} (проверьте, не дубль ли).",
                ).model_dump()
            )
    for doc_id, group in by_id.items():
        if len(group) < 2:
            continue
        for index, item in enumerate(group):
            others = [g for g in group if g is not item]
            item.parsed.status = "conflict"
            item.analysis["duplicates"].append(
                DuplicateRef(
                    kind="same_id",
                    item_id=others[0].item_id,
                    message=f"ID {doc_id} есть и в «{others[0].path}»: создать можно только один файл с этим ID.",
                ).model_dump()
            )
            if index > 0:
                item.decisions = {"excluded": True}
    batch_ids = {i.analysis["document_id"]: i.item_id for i in items if i.analysis.get("document_id")}
    for item in items:
        if item.parsed.status in ("invalid", "unsupported"):
            continue
        item.analysis["links"] = _links(item, snapshot, batch_ids)


def _links(
    item: ItemAnalysis, snapshot: KnowledgeSnapshot, batch_ids: dict[str, str]
) -> list[dict[str, Any]]:
    a = item.analysis
    own = a.get("document_id")
    body = a.get("body") or ""
    found: dict[str, dict[str, Any]] = {}

    def add(kind: str, target: str, line: int | None, snippet: str, selected: bool = False) -> None:
        if target == own or target in found:
            return
        doc = snapshot.get(target)
        state, title, in_batch = "missing", None, None
        if doc is not None:
            state, title = "resolved", doc.title
        elif target in batch_ids:
            state, in_batch = "in_batch", batch_ids[target]
        found[target] = CandidateLink(
            link_id=_hex(f"{item.item_id}:{kind}:{target}")[:12],
            link_kind=kind,
            target_document_id=target,
            target_title=title,
            target_item_id=in_batch,
            resolve_state=state,
            evidence=Evidence(file=item.path, line=line, snippet=_snippet(snippet)),
            selected_by_user=selected and state in ("resolved", "in_batch"),
        ).model_dump()

    for target in a.get("yaml_related_ids") or []:
        add("related_id", target, None, "related_ids в YAML файла", selected=True)
    for link in extract_wikilinks(body):
        if link.id_like:
            add("wikilink", link.target, link.line, link.excerpt)
            continue
        matches = [d for d in snapshot.documents.values() if d.title.casefold() == link.target.casefold()]
        key = f"title:{link.target}"
        if key in found:
            continue
        found[key] = CandidateLink(
            link_id=_hex(f"{item.item_id}:wikilink:{link.target}")[:12],
            link_kind="wikilink",
            target_document_id=matches[0].id if len(matches) == 1 else link.target,
            target_title=matches[0].title if len(matches) == 1 else None,
            resolve_state="resolved" if len(matches) == 1 else ("ambiguous" if matches else "missing"),
            evidence=Evidence(file=item.path, line=link.line, snippet=_snippet(link.excerpt)),
        ).model_dump()
    for lineno, line in enumerate(body.split("\n"), start=1):
        for match in ID_CANDIDATE_RE.finditer(line):
            target = match.group(0)
            if snapshot.get(target) is not None or target in batch_ids:
                add("mention", target, lineno, line)
    for f in a.get("fields") or []:
        if f["field"] != "related_ids" or f["origin"] == "frontmatter":
            continue
        values = f["value"] if isinstance(f["value"], list) else []
        for target in values:
            add("similar", str(target), None, f.get("note") or "похожий утверждённый документ")
    return list(found.values())
