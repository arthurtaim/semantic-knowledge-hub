"""Provenance of an answer's evidence (answer-quality fix, docs/API_CONTRACTS.md «Answer provenance»).

`is_demo` of a source is METADATA. It used to become a fixed server warning («Используются только демо-документы…»)
on every answer that had retrieved — not necessarily cited — a demo passage, and on every answer without passages
when any accessible document was demo. That repeated a disclaimer on ordinary answers and made false «only demo»
claims about answers without evidence. Now the server derives a typed summary from what the answer ACTUALLY relies on
(validated citations and the documents named by its system facts); the UI shows it quietly, per answer and per
source. A warning remains only where provenance is material for reading the answer: synthetic and non-synthetic
evidence mixed in one answer. Questions such as «are these real bank data?» are answered by the model from the same
metadata (passages and catalog rows carry `synthetic`) — the server never classifies questions by keywords.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.domain.models import (
    AnswerProvenance,
    AskResponse,
    Citation,
    ProvenanceOrigin,
    SystemFact,
    provenance_origin,
)

MIXED_PROVENANCE_WARNING = (
    "Ответ опирается на источники разного происхождения: часть помечена как синтетическая (учебная), часть — нет. "
    "Происхождение указано у каждого источника; синтетические сведения не являются фактами о банке."
)


def _kind(source_type: str) -> str:
    if source_type == "attachment":
        return "attachment"
    return "corporate" if source_type == "confluence" else "team"


def summarize_provenance(
    citations: Iterable[Citation],
    facts: Iterable[SystemFact] = (),
    documents: Iterable[tuple[str, bool]] = (),
) -> AnswerProvenance:
    """Distinct sources of the evidence by origin. `documents`: further team documents the answer is ABOUT (a
    skill's chosen document) as (id, is_demo). A team document cited and also listed by a fact counts once."""
    sources: dict[str, tuple[str, ProvenanceOrigin]] = {}
    for c in citations:
        kind = _kind(c.source_type)
        key = (
            f"team:{c.document_id.casefold()}"
            if kind == "team"
            else (c.source_id or f"{kind}:{c.document_id}")
        )
        sources.setdefault(key, (kind, c.provenance or provenance_origin(c.source_type, c.is_demo)))
    for fact in facts:
        for item in fact.items:
            if item.kind == "document" and item.is_demo is not None:
                sources.setdefault(
                    f"team:{item.id.casefold()}", ("team", "synthetic" if item.is_demo else "not_synthetic")
                )
    for document_id, is_demo in documents:
        sources.setdefault(
            f"team:{document_id.casefold()}", ("team", "synthetic" if is_demo else "not_synthetic")
        )
    counts = {"synthetic": 0, "not_synthetic": 0, "unknown": 0}
    by_kind: dict[str, int] = {}
    for kind, origin in sources.values():
        counts[origin] += 1
        by_kind[kind] = by_kind.get(kind, 0) + 1
    present = [origin for origin, n in counts.items() if n]
    overall = "none" if not present else present[0] if len(present) == 1 else "mixed"
    return AnswerProvenance(overall=overall, by_kind=by_kind, **counts)


def apply_provenance(response: AskResponse, documents: Iterable[tuple[str, bool]] = ()) -> AskResponse:
    """Set `response.provenance` from its validated evidence; warn only when the origin is material."""
    provenance = summarize_provenance(response.citations, response.system_facts, documents)
    response.provenance = provenance
    if (
        provenance.synthetic
        and provenance.not_synthetic
        and MIXED_PROVENANCE_WARNING not in response.warnings
    ):
        response.warnings.append(MIXED_PROVENANCE_WARNING)
    return response
