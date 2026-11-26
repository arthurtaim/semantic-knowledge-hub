"""Query rewrite before the team search (Adaptive RAG, docs/ADAPTIVE_RAG.md §Query rewrite).

The team search is lexical (SQLite FTS5): a question asked in other words than the documents («шина», «оповещения»
for «Event Hub», «уведомления») finds nothing, and the answering model never sees the document it would have
recognized. Here ONE small call of the configured model (weak-model contract: plain chat completion, a compact JSON
reply) offers 0–3 phrasings in the words documents may use; the assistant searches the SAME authorized index with each
of them and merges the results into the same bounded context (6 passages, 12 000 characters). Nothing the model writes
is a fact: only text the search then finds can become evidence, and every citation is verified as before.

When (`QUERY_REWRITE`):
- `absent_terms` (default) — a meaningful word of THIS question occurs in no eligible team document, or the search
  found no passage at all (a server fact: document frequency 0 — no keyword list, no intent routing);
- `always` — every question with meaningful words (A/B, the cost of one more call per question);
- `off` — never. Providers without the capability (the offline mock) never rewrite: nothing is simulated.

A slow, failing or malformed model means the search simply runs as before (`error` in the trace).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, replace
from typing import Any, Literal, cast

from app.adapters.ai.base import AIProviderError, QueryRewriteRequest, QueryRewritingAIProvider
from app.adapters.ai.gap_protocol import sanitize_query
from app.adapters.ai.rewrite_protocol import RewriteProtocolError, parse_rewrite_reply
from app.domain.text import QueryTerm, analyze_query, reportable_terms

logger = logging.getLogger("skh.query_rewrite")

REPAIR_NOTE = "ответ не был JSON-объектом"
RewriteMode = Literal["off", "absent_terms", "always"]


@dataclass(frozen=True)
class RewriteSettings:
    mode: RewriteMode = "absent_terms"
    timeout_seconds: float = 10.0  # the model call(s), repair included
    max_queries: int = 3
    vocabulary: int = 12  # titles of the first search's ranked documents shown to the model
    context_chars: int = 2000
    repair: bool = True


@dataclass
class RewriteResult:
    mode: str
    trigger: str | None
    queries: tuple[str, ...] = ()
    model_calls: int = 0
    repaired: bool = False
    error: str | None = None
    rejected: int = 0  # phrasings refused by the server (unsafe, too long, empty, only the question again)
    added_passages: int = (
        0  # passages in the final context that only the rewrites found (set by the assistant)
    )
    elapsed_ms: float = 0.0

    def summary(self) -> dict[str, Any]:
        """Codes and counts only — never the question or the phrasings."""
        return {
            "mode": self.mode,
            "trigger": self.trigger,
            "called": self.model_calls > 0,
            "model_calls": self.model_calls,
            "repaired": self.repaired,
            "error": self.error,
            "queries": len(self.queries),
            "rejected": self.rejected,
            "added_passages": self.added_passages,
            "elapsed_ms": self.elapsed_ms,
        }


class QueryRewriter:
    def __init__(self, settings: RewriteSettings | None = None) -> None:
        self.settings = settings or RewriteSettings()

    def enabled_for(self, provider: object) -> bool:
        return self.settings.mode != "off" and bool(getattr(provider, "supports_query_rewrite", False))

    def trigger(self, *, own_terms: list[QueryTerm], matched: set[str], has_passages: bool) -> str | None:
        if self.settings.mode == "off" or not own_terms:
            return None
        if self.settings.mode == "always":
            return "always"
        if not has_passages:
            return "no_local_passages"
        if reportable_terms([t for t in own_terms if t.stem not in matched]):
            return "absent_terms"
        return None

    async def rewrite(
        self,
        provider: object,
        *,
        question: str,
        referent: str,
        own_terms: list[QueryTerm],
        matched: set[str],
        vocabulary: tuple[str, ...],
        trigger: str,
    ) -> RewriteResult:
        started = time.perf_counter()
        result = RewriteResult(mode=self.settings.mode, trigger=trigger)
        absent = tuple(t.original for t in reportable_terms([t for t in own_terms if t.stem not in matched]))
        request = QueryRewriteRequest(
            question=question,
            referent=referent,
            absent_terms=absent[:6],
            vocabulary=vocabulary[: max(0, self.settings.vocabulary)],
        )
        model = cast(QueryRewritingAIProvider, provider)
        phrasings: list[str] | None = None
        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                result.model_calls += 1
                raw = await model.rewrite_query(request, max_chars=self.settings.context_chars)
                try:
                    phrasings = parse_rewrite_reply(raw)
                except RewriteProtocolError as exc:
                    if exc.kind != "syntax" or not self.settings.repair:
                        raise
                    result.model_calls += 1
                    result.repaired = True
                    raw = await model.rewrite_query(
                        replace(request, repair=REPAIR_NOTE), max_chars=self.settings.context_chars
                    )
                    phrasings = parse_rewrite_reply(raw)
        except TimeoutError:
            result.error = "timeout"
        except AIProviderError as exc:
            result.error = exc.code
        except RewriteProtocolError as exc:
            result.error = exc.detail
        if phrasings:
            result.queries = self._accept(phrasings, own_terms, result)
        result.elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        logger.info(
            "rewrite trigger=%s calls=%d repaired=%s error=%s queries=%d rejected=%d",
            trigger,
            result.model_calls,
            result.repaired,
            result.error or "-",
            len(result.queries),
            result.rejected,
        )
        return result

    def _accept(
        self, phrasings: list[str], own_terms: list[QueryTerm], result: RewriteResult
    ) -> tuple[str, ...]:
        """Each phrasing is search text only: sanitized like a gate query (no URLs, operators stripped, identifiers
        of the question kept); one that adds no word to the question is dropped (it would search the same)."""
        entities = [t.original for t in own_terms if t.is_entity_like]
        own = {t.stem for t in own_terms}
        accepted: list[str] = []
        for phrasing in phrasings:
            safe, _why = sanitize_query(phrasing, entities)
            stems = {t.stem for t in analyze_query(safe)} if safe else set()
            if safe is None or not stems or stems <= own:
                result.rejected += 1
            elif safe.casefold() not in {a.casefold() for a in accepted}:
                accepted.append(safe)
        return tuple(accepted[: max(1, min(self.settings.max_queries, 3))])
