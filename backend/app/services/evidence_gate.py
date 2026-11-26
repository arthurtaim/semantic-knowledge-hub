"""Local-first evidence gate (Adaptive RAG, docs/ADAPTIVE_RAG.md): is the external source consulted for this answer?

Deterministic orchestration around ONE narrow model decision (designed for a weak model):

    authorized team passages → ≤ 5 bounded evidence cards (E1…) → one chat call (+ ≤ 1 repair for a non-JSON reply)
    → strict parse (gap_protocol) → server checks → GateDecision: search or not, with 0–2 focused queries.

The model judges MEANING (does the excerpt state the asked fact, is «пауза» the documented «задержка»); the server
keeps everything else: source mode, statuses and ACL (cards are built only from passages the reader may see), the
evidence ids (only the server's), identifiers of the question (a «sufficient» whose cited passages lack them is not
accepted), query safety, the per-scope rate budget, time limits and the fallback. There is no keyword routing.

Policies (`EXTERNAL_GATE`):
- `semantic` (default) — the model decision when the provider has the capability (`supports_gap_assessment`);
- `lexical` — LOCAL_SUFFICIENCY v2 (`local_insufficiency`), the rule used before; also the automatic policy of
  providers without the capability (the offline mock, so the deterministic evaluation is unchanged). Nothing
  «semantic» is simulated for them.

Fallback when the model reply is invalid, times out or fails (`EXTERNAL_GATE_INVALID_FALLBACK`): `lexical` — the
v2 rule decides, visibly (`fallback: lexical:<code>`); a local-only answer is marked incomplete; `local` — always a
local-only answer marked incomplete. Sufficiency is never assumed on the model's word.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import defaultdict, deque
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, cast

from app.adapters.ai.base import (
    AIProviderError,
    ContextPassage,
    EvidenceCard,
    EvidenceGapAIProvider,
    GapAssessmentRequest,
)
from app.adapters.ai.gap_protocol import GapProtocolError, GapReply, parse_gap_reply, sanitize_query
from app.domain.models import UserContext
from app.domain.text import QueryTerm, reportable_terms, term_matches_text, tokenize
from app.services.discovery import acl_scope_key

logger = logging.getLogger("skh.evidence_gate")

LOCAL_SUFFICIENCY = "v2"
# A question word found in at most this share of the eligible documents (and at least one) is what the question is
# specifically about («лимит», «срок»): a local source that does not contain it is topical, not an answer.
SPECIFIC_TERM_SHARE = 0.10
SEMANTIC_POLICY = "semantic-v1"
LEXICAL_POLICY = f"lexical-{LOCAL_SUFFICIENCY}"
TEAM_SOURCES = ("local", "gitlab")
MAX_DERIVED_WORDS = 8
REPAIR_NOTE = "ответ не был JSON-объектом"

GateDecisionKind = Literal["sufficient", "need_external", "uncertain", "invalid", "not_assessed"]


def local_insufficiency(
    passages: list[ContextPassage],
    terms: list[QueryTerm],
    matched: set[str],
    *,
    frequency: list[int] | None = None,
    eligible: int = 0,
) -> str | None:
    """Why the team documents alone do not look sufficient (policy LOCAL_SUFFICIENCY v2), or None.
    Deterministic and explainable: it decides whether the external source is consulted at all.

    `matched`: stems found anywhere in the eligible documents; `frequency[i]`: in how many of the `eligible`
    documents term i occurs. Evidence is counted per SOURCE DOCUMENT over the passages given to the model (sections
    of one document complement each other; words scattered over different documents are still not an answer):
    some document must cover ≥ 2/3 of the question AND every specific (rare) word of it."""
    if not terms:
        return None
    if not passages:
        return "no_local_passages"
    unmatched = [t for t in terms if t.stem not in matched]
    if any(t.is_entity_like for t in unmatched):
        return "unmatched_entities"
    if len(unmatched) * 3 > len(terms):
        return "low_term_coverage"
    by_source: dict[str, set[int]] = {}
    for p in passages:
        words = tokenize(f"{p.title} {p.section or ''} {p.text}")
        by_source.setdefault(p.document_id, set()).update(
            i for i, t in enumerate(terms) if term_matches_text(t, words)
        )
    answering = [found for found in by_source.values() if len(found) * 3 >= len(terms) * 2]
    if not answering:
        return "no_single_local_source"
    if frequency is not None and eligible > 0:
        limit = max(1, int(eligible * SPECIFIC_TERM_SHARE))
        specific = {i for i, n in enumerate(frequency[: len(terms)]) if 0 < n <= limit}
        if not any(specific <= found for found in answering):
            return "specific_terms_not_covered"
    return None


@dataclass(frozen=True)
class GateSettings:
    policy: Literal["semantic", "lexical"] = "semantic"
    timeout_seconds: float = 20.0  # the model call(s), repair included
    cards: int = 5
    card_chars: int = 600
    context_chars: int = 3500
    repair: bool = True
    invalid_fallback: Literal["lexical", "local"] = "lexical"
    max_searches: int = 2  # focused external searches per answer (fetch/fragment limits stay shared)
    rate_limit: int = 30  # gate-decided external searches per ACL scope and window; 0 = unlimited
    rate_window_seconds: int = 600


@dataclass(frozen=True)
class GateInput:
    question: str  # this question as the user wrote it
    referent: str  # the previous question of the dialog (context only) or ""
    passages: list[ContextPassage]  # what the answer would be built from now (chosen + team), cids assigned
    terms: list[QueryTerm]  # retrieval terms (with the referent's words for a follow-up)
    own_terms: list[QueryTerm]  # the words of this question only
    matched: set[str]  # stems present in some eligible team document
    frequency: list[int]  # per term: eligible team documents that contain it
    eligible: int


@dataclass
class GateDecision:
    policy: str
    decision: GateDecisionKind
    reason: str  # trigger of the external call, or local_sufficient / external_budget_exhausted
    search: bool
    queries: tuple[str, ...] = ()  # focused queries; empty = search with the question as before
    missing: tuple[str, ...] = ()  # the model's description of the gap (data for the answering model)
    evidence_cids: tuple[str, ...] = ()
    lexical: str | None = None  # what LOCAL_SUFFICIENCY v2 says (A/B), None = sufficient
    model_calls: int = 0
    repaired: bool = False
    error: str | None = None
    fallback: str | None = None
    cards: int = 0
    queries_rejected: int = 0
    incomplete: bool = False  # a local-only answer whose completeness could not be checked
    elapsed_ms: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        """Codes and counts only — never the question, the gap or the queries (privacy, docs/ADAPTIVE_RAG.md)."""
        return {
            "policy": self.policy,
            "decision": self.decision,
            "reason": self.reason,
            "external_called": self.search,
            "model_calls": self.model_calls,
            "repaired": self.repaired,
            "error": self.error,
            "fallback": self.fallback,
            "lexical": self.lexical,
            "cards": self.cards,
            "evidence": len(self.evidence_cids),
            "missing": len(self.missing),
            "queries": len(self.queries),
            "queries_rejected": self.queries_rejected,
            "incomplete": self.incomplete,
            "elapsed_ms": self.elapsed_ms,
        }


def forced(reason: str, policy: str) -> GateDecision:
    """The user chose the external source (corporate scope or «искать во внешнем»): no local-first decision."""
    return GateDecision(policy=policy, decision="not_assessed", reason=reason, search=True)


_UNIT_RE = re.compile(r"(?<=[.!?;:])\s+|\n+")


def focus_excerpt(text: str, terms: list[QueryTerm], limit: int) -> str:
    """At most `limit` characters of a passage for a card, the whole text if it fits. Units (lines, sentences) are
    chosen greedily by the question words they ADD, each word weighted by its rarity among the units of this text
    (a word in every sentence — the document's own subject — says little about which sentence answers), each with
    the unit after it (a value often follows its label); then the remaining room is filled; document order kept."""
    if len(text) <= limit:
        return text
    units = [u.strip() for u in _UNIT_RE.split(text) if u.strip()]
    present = [{i for i, t in enumerate(terms) if term_matches_text(t, tokenize(u))} for u in units]
    df: dict[int, int] = {}
    for found in present:
        for i in found:
            df[i] = df.get(i, 0) + 1
    chosen: dict[int, str] = {}
    size = 0

    def take(j: int) -> bool:
        nonlocal size
        if j >= len(units) or j in chosen:
            return False
        room = limit - size - (3 if chosen else 0)
        if room < 20:
            return False
        piece = units[j] if len(units[j]) <= room else units[j][: room - 1].rstrip() + "…"
        chosen[j] = piece
        size += len(piece) + (3 if len(chosen) > 1 else 0)
        return True

    covered: set[int] = set()
    while True:
        gains = [
            (sum(1 / df[i] for i in found - covered), -j)
            for j, found in enumerate(present)
            if j not in chosen and found - covered
        ]
        if not gains:
            break
        _gain, neg = max(gains)
        if not take(-neg):
            break
        covered |= present[-neg]
        take(-neg + 1)
    for j in sorted(range(len(units)), key=lambda j: (-sum(1 / df[i] for i in present[j]), j)):
        if not present[j]:
            break
        take(j)
    if not chosen:
        return text[: limit - 1].rstrip() + "…"
    return " … ".join(chosen[j] for j in sorted(chosen))


class EvidenceGate:
    def __init__(self, settings: GateSettings | None = None) -> None:
        self.settings = settings or GateSettings()
        self._searches: dict[str, deque[float]] = defaultdict(deque)

    # --- policy ---------------------------------------------------------------------------------------------------
    def semantic_for(self, provider: object) -> bool:
        return self.settings.policy == "semantic" and bool(
            getattr(provider, "supports_gap_assessment", False)
        )

    @property
    def policy_label(self) -> str:
        return SEMANTIC_POLICY if self.settings.policy == "semantic" else LEXICAL_POLICY

    def will_call_model(self, provider: object, passages: Sequence[ContextPassage]) -> bool:
        """For the stream's progress line («проверяю, хватает ли данных»)."""
        return self.semantic_for(provider) and any(p.source_type in TEAM_SOURCES for p in passages)

    # --- rate budget ----------------------------------------------------------------------------------------------
    def _budget_left(self, scope: str) -> bool:
        if self.settings.rate_limit <= 0:
            return True
        window = self._searches[scope]
        horizon = time.monotonic() - self.settings.rate_window_seconds
        while window and window[0] < horizon:
            window.popleft()
        return len(window) < self.settings.rate_limit

    def _spend(self, scope: str) -> None:
        if self.settings.rate_limit > 0:
            self._searches[scope].append(time.monotonic())

    # --- the decision -----------------------------------------------------------------------------------------------
    async def decide(self, provider: object, user: UserContext, data: GateInput) -> GateDecision:
        started = time.perf_counter()
        decision = await self._decide(provider, user, data)
        decision.elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        if decision.search:
            self._spend(acl_scope_key(user))
        logger.info(
            "gate policy=%s decision=%s reason=%s calls=%d repaired=%s error=%s fallback=%s queries=%d",
            decision.policy,
            decision.decision,
            decision.reason,
            decision.model_calls,
            decision.repaired,
            decision.error or "-",
            decision.fallback or "-",
            len(decision.queries),
        )
        return decision

    async def _decide(self, provider: object, user: UserContext, data: GateInput) -> GateDecision:
        lexical = local_insufficiency(
            data.passages, data.terms, data.matched, frequency=data.frequency, eligible=data.eligible
        )
        semantic = self.semantic_for(provider)
        policy = SEMANTIC_POLICY if semantic else LEXICAL_POLICY
        if (lexical is not None or semantic) and not self._budget_left(acl_scope_key(user)):
            return GateDecision(
                policy=policy,
                decision="not_assessed",
                reason="external_budget_exhausted",
                search=False,
                lexical=lexical,
                warnings=[
                    "Лимит обращений к внешнему источнику на ближайшие минуты исчерпан — ответ построен только по "
                    "документам команды и может быть неполным."
                ],
            )
        if not semantic:
            return GateDecision(
                policy=policy,
                decision="sufficient" if lexical is None else "need_external",
                reason=lexical or "local_sufficient",
                search=lexical is not None,
                lexical=lexical,
            )
        team = [p for p in data.passages if p.source_type in TEAM_SOURCES]
        if not team:
            # Nothing local to judge: one bounded external search, no model call (a clean query, not the prompt).
            derived = self._derived_query(data.own_terms)
            return GateDecision(
                policy=policy,
                decision="not_assessed",
                reason="no_local_passages",
                search=bool(data.terms),
                queries=(derived,) if derived else (),
                lexical=lexical,
            )
        return await self._assess(cast(EvidenceGapAIProvider, provider), data, team, lexical)

    async def _assess(
        self,
        provider: EvidenceGapAIProvider,
        data: GateInput,
        team: list[ContextPassage],
        lexical: str | None,
    ) -> GateDecision:
        s = self.settings
        cards, mapping = self._cards(team, data.own_terms or data.terms)
        absent = tuple(
            t.original for t in reportable_terms([t for t in data.own_terms if t.stem not in data.matched])
        )
        request = GapAssessmentRequest(
            question=data.question, cards=tuple(cards), referent=data.referent, absent_terms=absent[:6]
        )
        result = GateDecision(
            policy=SEMANTIC_POLICY, decision="invalid", reason="decision_invalid", search=False
        )
        result.lexical, result.cards = lexical, len(cards)
        reply: GapReply | None = None
        try:
            async with asyncio.timeout(s.timeout_seconds):
                result.model_calls += 1
                raw = await provider.assess_evidence_gap(request, max_chars=s.context_chars)
                try:
                    reply = parse_gap_reply(raw, mapping.keys())
                except GapProtocolError as exc:
                    if exc.kind != "syntax" or not s.repair:
                        raise
                    result.model_calls += 1
                    result.repaired = True
                    raw = await provider.assess_evidence_gap(
                        replace(request, repair=REPAIR_NOTE), max_chars=s.context_chars
                    )
                    reply = parse_gap_reply(raw, mapping.keys())
        except TimeoutError:
            result.error = "timeout"
        except AIProviderError as exc:
            result.error = exc.code
        except GapProtocolError as exc:
            result.error = exc.detail
        if reply is None:
            return self._fallback(result, lexical)

        result.evidence_cids = tuple(cid for e in reply.evidence_ids for cid in mapping[e])
        result.missing = tuple(reply.missing)
        entities = [t.original for t in data.own_terms if t.is_entity_like]
        if reply.decision == "sufficient":
            cited = [p for p in team if p.cid in result.evidence_cids]
            words = tokenize(" ".join(f"{p.title} {p.section or ''} {p.text}" for p in cited))
            lacking = [t for t in data.own_terms if t.is_entity_like and not term_matches_text(t, words)]
            if not lacking:
                result.decision, result.reason = "sufficient", "local_sufficient"
                return result
            # The model says «enough», but the passages it names do not mention an identifier of the question.
            result.error = "sufficient_entity_not_in_evidence"
            reply = replace(reply, decision="uncertain")

        queries: list[str] = []
        unsafe = False
        for raw_query in reply.search_queries:
            safe, why = sanitize_query(raw_query, entities)
            if safe is None:
                result.queries_rejected += 1
                result.error = result.error or why
                unsafe = unsafe or why == "unsafe_query"
            elif safe.casefold() not in {q.casefold() for q in queries}:
                queries.append(safe)
        if reply.decision == "need_external":
            if not queries and not unsafe:
                # A weak model often restates the whole question as its query: the decision and the gap stay the
                # model's, the search text becomes the server's clean query of the question's own words.
                derived = self._derived_query(data.own_terms or data.terms)
                queries = [derived] if derived else []
            if not queries:
                # Only an address-like «query» (e.g. injected by a document): the decision itself is not trusted.
                result.decision = "invalid"
                return self._fallback(result, lexical)
            result.decision, result.reason, result.search = "need_external", "evidence_gap", True
            result.queries = tuple(queries[: max(1, s.max_searches)])
            return result
        # uncertain: never «enough»; one safe probe of the external source (the gap is not established)
        probe = queries[0] if queries else self._derived_query(data.own_terms or data.terms)
        result.decision, result.reason, result.search = "uncertain", "model_uncertain", True
        result.queries = (probe,) if probe else ()
        return result

    def _fallback(self, result: GateDecision, lexical: str | None) -> GateDecision:
        result.decision, result.reason = "invalid", "decision_invalid"
        if self.settings.invalid_fallback == "lexical":
            result.fallback = f"lexical:{lexical or 'sufficient'}"
            result.search = lexical is not None
        else:
            result.fallback = "local"
            result.search = False
        result.queries = ()  # the fallback searches exactly like the lexical rule: with the question
        result.incomplete = not result.search
        result.warnings.append(
            "Проверить полноту ответа по документам команды не удалось (оценка модели не получена"
            + (")." if result.search else ") — ответ может быть неполным.")
        )
        return result

    def _cards(
        self, team: list[ContextPassage], terms: list[QueryTerm]
    ) -> tuple[list[EvidenceCard], dict[str, tuple[str, ...]]]:
        """One card per DOCUMENT (its sections complement each other), in the order of the passages, ≤ 5 cards; an
        E-id maps back to every passage of its document."""
        s = self.settings
        documents: dict[str, list[ContextPassage]] = {}
        for p in team:
            if p.document_id in documents or len(documents) < max(1, min(s.cards, 5)):
                documents.setdefault(p.document_id, []).append(p)
        cards: list[EvidenceCard] = []
        mapping: dict[str, tuple[str, ...]] = {}
        budget = s.context_chars
        for document_id, sections in documents.items():
            if budget < 80:
                break
            limit = min(s.card_chars * min(len(sections), 2), budget)
            excerpt = focus_excerpt("\n".join(p.text for p in sections), terms, limit)
            budget -= len(excerpt)
            names = list(dict.fromkeys(p.section for p in sections if p.section))
            eid = f"E{len(cards) + 1}"
            first = sections[0]
            cards.append(
                EvidenceCard(
                    eid, document_id, first.title, " / ".join(names[:3]) or None, first.status, excerpt
                )
            )
            mapping[eid] = tuple(p.cid for p in sections)
        return cards, mapping

    @staticmethod
    def _derived_query(terms: list[QueryTerm]) -> str | None:
        """A clean query from the question's own words: identifiers first, at most MAX_DERIVED_WORDS words."""
        ordered = [t for t in terms if t.is_entity_like] + [t for t in terms if not t.is_entity_like]
        words = list(dict.fromkeys(t.original for t in ordered))[:MAX_DERIVED_WORDS]
        if not words:
            return None
        safe, _ = sanitize_query(" ".join(words), [t.original for t in terms if t.is_entity_like])
        return safe
