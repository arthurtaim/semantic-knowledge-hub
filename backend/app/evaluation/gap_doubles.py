"""SCRIPTED WEAK-MODEL DOUBLES for the evidence gate — TEST DOUBLES, not models (docs/ADAPTIVE_RAG.md §Doubles).

The production code has no keyword routing; these doubles stand in for the model that judges meaning, so that the
server around it can be tested and measured deterministically, offline, without a paid or a live model:

- `ScriptedGapProvider` — answers exactly like the extractive mock (`MockAIProvider`, unchanged), adds the gap
  capability; the gap reply comes from a script (request → raw text or an exception), recorded for assertions.
- `oracle_script(cases)` — a PERFECT READER OF THE CARDS: «sufficient» iff every labelled fact is in the excerpts it
  was shown (so a fact lost by card building shows up as a false «need_external»), otherwise «need_external» with the
  labeller's gap and queries. An upper bound of the pipeline, NOT a measurement of any model.
- `weak_script(cases, seed)` — the oracle degraded the way small chat models fail: prose instead of JSON, a fence,
  an unknown key, an invented evidence id, a premature «sufficient», a needless «need_external», the whole question
  as a query, a URL. Deterministic per question and seed; rates are documented in PROFILE.
- `always_external_script`, `always_sufficient_script` — the two degenerate weak models (LF-15, LF-16).

`TARGET_MODEL_NOT_VALIDATED`: nothing here says how the target corporate model behaves.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.adapters.ai.base import GapAssessmentRequest, QueryRewriteRequest
from app.adapters.ai.mock import MockAIProvider

GapScript = Callable[[GapAssessmentRequest], "str | Exception"]


class ScriptedGapProvider(MockAIProvider):
    """The extractive mock + a scripted evidence-gap capability (a test double; never configured in production).
    With `rewrite`, it also has the query-rewrite capability (QueryRewriteRequest → raw reply)."""

    supports_gap_assessment = True
    supports_query_rewrite = False

    def __init__(
        self,
        script: GapScript,
        *,
        delay: float = 0.0,
        rewrite: Callable[[QueryRewriteRequest], str | Exception] | None = None,
    ) -> None:
        super().__init__()
        self.script = script
        self.delay = delay
        self.calls: list[GapAssessmentRequest] = []
        self.rewrite_script = rewrite
        self.rewrite_calls: list[QueryRewriteRequest] = []
        self.supports_query_rewrite = rewrite is not None

    async def rewrite_query(self, request: QueryRewriteRequest, *, max_chars: int) -> str:
        self.rewrite_calls.append(request)
        assert self.rewrite_script is not None
        reply = self.rewrite_script(request)
        if isinstance(reply, Exception):
            raise reply
        return reply

    async def assess_evidence_gap(self, request: GapAssessmentRequest, *, max_chars: int) -> str:
        self.calls.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        reply = self.script(request)
        if isinstance(reply, Exception):
            raise reply
        return reply


def sufficient(*eids: str, known: Sequence[str] = ()) -> str:
    return json.dumps(
        {"decision": "sufficient", "known": list(known), "evidence_ids": list(eids)}, ensure_ascii=False
    )


def need_external(missing: Sequence[str], queries: Sequence[str], *, evidence: Sequence[str] = ()) -> str:
    return json.dumps(
        {
            "decision": "need_external",
            "missing": list(missing),
            "search_queries": list(queries),
            "evidence_ids": list(evidence),
        },
        ensure_ascii=False,
    )


def uncertain(*queries: str) -> str:
    return json.dumps({"decision": "uncertain", "search_queries": list(queries)}, ensure_ascii=False)


def _norm(text: str) -> str:
    return " ".join(text.replace("ё", "е").replace("Ё", "Е").split()).casefold()


@dataclass(frozen=True)
class GapLabel:
    """What the labeller (a person) knows about one question: the facts a complete answer states, the gap a good
    model would describe and the queries it would write. Never read by product code."""

    question: str
    facts: tuple[str, ...]
    missing: tuple[str, ...] = ()
    queries: tuple[str, ...] = ()
    extra: Mapping[str, Any] = field(default_factory=dict)


def _label_for(request: GapAssessmentRequest, labels: Mapping[str, GapLabel]) -> GapLabel | None:
    return labels.get(_norm(request.question))


def _cards_with(request: GapAssessmentRequest, fact: str) -> list[str]:
    needle = _norm(fact)
    return [c.eid for c in request.cards if needle in _norm(f"{c.title} {c.section or ''} {c.excerpt}")]


def oracle_reply(request: GapAssessmentRequest, label: GapLabel | None) -> str:
    if label is None:
        return uncertain()
    holders = [_cards_with(request, fact) for fact in label.facts]
    if label.facts and all(holders):
        eids = list(dict.fromkeys(h[0] for h in holders))[:5]
        return sufficient(*eids)
    known = list(dict.fromkeys(h[0] for h in holders if h))[:5]
    missing = list(label.missing) or ["сведения, о которых спрашивают"]
    queries = list(label.queries) or [" ".join(request.question.split()[:8])]
    return need_external(missing[:3], queries[:2], evidence=known)


def labels_by_question(labels: Sequence[GapLabel]) -> dict[str, GapLabel]:
    return {_norm(label.question): label for label in labels}


def oracle_script(labels: Sequence[GapLabel]) -> GapScript:
    index = labels_by_question(labels)
    return lambda request: oracle_reply(request, _label_for(request, index))


# How often each failure of a weak model is injected (per question, deterministic by seed). Chosen to be visibly
# worse than any useful model, not calibrated on a real one (TARGET_MODEL_NOT_VALIDATED).
PROFILE: dict[str, float] = {
    "prose": 0.10,  # «Да, документов достаточно.» instead of JSON (repairable once)
    "fenced_with_text": 0.10,  # the right JSON inside a fence with a sentence around it (tolerated)
    "extra_key": 0.05,  # adds "confidence": 0.97 (invalid)
    "invented_eid": 0.05,  # cites E9 (invalid)
    "premature_sufficient": 0.10,  # «sufficient» with E1 although a fact is missing
    "needless_external": 0.10,  # «need_external» although the cards state everything
    "question_as_query": 0.10,  # the whole question as the search query
    "url_query": 0.05,  # a URL as the only query
}


def _roll(question: str, seed: int, what: str) -> float:
    digest = hashlib.sha256(f"{seed}:{what}:{_norm(question)}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def weak_reply(request: GapAssessmentRequest, label: GapLabel | None, seed: int) -> str:
    q = request.question
    if request.repair:  # after a repair note the weak model manages the format (once)
        return oracle_reply(request, label)
    if _roll(q, seed, "prose") < PROFILE["prose"]:
        return "Да, документов команды достаточно для ответа."
    honest = json.loads(oracle_reply(request, label))
    if (
        honest["decision"] == "need_external"
        and _roll(q, seed, "premature") < PROFILE["premature_sufficient"]
    ):
        honest = {"decision": "sufficient", "evidence_ids": ["E1"] if request.cards else []}
    elif honest["decision"] == "sufficient" and _roll(q, seed, "needless") < PROFILE["needless_external"]:
        honest = {
            "decision": "need_external",
            "missing": ["подтверждение во внешнем источнике"],
            "search_queries": [" ".join(q.split()[:8])],
            "evidence_ids": honest.get("evidence_ids", []),
        }
    if honest["decision"] == "need_external":
        if _roll(q, seed, "question_as_query") < PROFILE["question_as_query"]:
            honest["search_queries"] = [q[:140]]
        elif _roll(q, seed, "url") < PROFILE["url_query"]:
            honest["search_queries"] = ["https://wiki.corp.example/display/OPS/search"]
    if _roll(q, seed, "extra_key") < PROFILE["extra_key"]:
        honest["confidence"] = 0.97
    elif _roll(q, seed, "invented") < PROFILE["invented_eid"]:
        honest["evidence_ids"] = ["E9"]
    text = json.dumps(honest, ensure_ascii=False)
    if _roll(q, seed, "fence") < PROFILE["fenced_with_text"]:
        return f"Ответ модели:\n```json\n{text}\n```\nГотово."
    return text


def weak_script(labels: Sequence[GapLabel], seed: int = 7) -> GapScript:
    index = labels_by_question(labels)
    return lambda request: weak_reply(request, _label_for(request, index), seed)


def always_external_script(request: GapAssessmentRequest) -> str:
    return need_external(["подтверждение"], [" ".join(request.question.split()[:8])])


def always_sufficient_script(request: GapAssessmentRequest) -> str:
    return sufficient("E1") if request.cards else uncertain()
