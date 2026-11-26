"""External (Confluence MCP) evidence for the assistant: federated retrieval without importing pages.

    question — or 1–2 FOCUSED queries of the evidence gate (Adaptive RAG, docs/ADAPTIVE_RAG.md) —
    → connector.search (ACL-filtered by the source, ≤ N candidates in total, 1 MCP call per query)
    → candidate ranking (lexical + bounded discovery hints of the same scope/intent)
    → de-duplication with the curated base (verified mapping, never by a similar title)
    → ≤ M page fetches (bounded cache keyed by instance/page/VERSION/ACL scope/render+policy version)
    → structured text → fragments → only fragments that actually contain the question's (or the gap's) terms
    → bounded, cite-ready fragments with namespaced ids `confluence:<instance>:<page>:<version>`.

Guarantees (M5.6.2 Appendix 5 §5): a cached fragment is reused ONLY when the page appears again in a fresh,
ACL-filtered search for the same scope with the same version — a revoked, deleted or updated page can never
be served from the cache; TTL is an upper bound, not a permission. MCP calls are bounded by a shared
semaphore, per-call timeouts, a per-request deadline and a circuit breaker; any failure degrades to
local-only with a visible warning, never a 500.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import OrderedDict, deque
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, TypeVar

from app.adapters.corporate.base import (
    ConnectorUnavailableError,
    CorporateKnowledgeConnector,
    CorporatePage,
    CorporatePageNotFoundError,
)
from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.external_text import Fragment, fragments, storage_to_text
from app.domain.models import DocStatus, UserContext
from app.domain.text import QueryTerm, term_matches_text, tokenize
from app.services.discovery import DiscoveryStore, acl_scope_key

logger = logging.getLogger("skh.external")

RENDER_VERSION = "r1"
POLICY_VERSION = "ext-v1"  # part of the page cache key: cached fragments do not depend on the queries
MAX_QUERIES = 2
T = TypeVar("T")


@dataclass(frozen=True)
class ExternalLimits:
    candidates: int = 10
    fetches: int = 3
    fragments: int = 6
    context_chars: int = 16_000
    cache_pages: int = 100
    cache_ttl_seconds: int = 24 * 3600
    concurrency: int = 2
    timeout_seconds: float = 5.0
    deadline_seconds: float = 12.0
    breaker_failures: int = 5
    breaker_reset_seconds: float = 60.0
    max_page_chars: int = 20_000


@dataclass
class ExternalFragment:
    source_id: str  # confluence:<instance>:<page>:<version>
    source_base: str  # confluence:<instance>:<page>
    page_id: str
    instance: str
    version: str
    title: str
    status: str  # approved | draft | unknown — as the source states it
    uri: str
    fragment_id: str
    heading: str | None
    anchor: str | None
    text: str
    content_hash: str
    retrieved_at: datetime
    from_cache: bool
    score: float
    is_mock: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class ExternalRetrieval:
    called: bool
    trigger: str
    fragments: list[ExternalFragment] = field(default_factory=list)
    candidates: int = 0
    fetched: int = 0
    cache_hits: int = 0
    mcp_calls: int = 0
    rejected: list[dict[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    degraded: bool = False
    elapsed_ms: float = 0.0
    searches: int = 0  # MCP search calls (1, or one per focused query)
    focused: bool = False  # searched with the gate's focused queries instead of the question

    @property
    def outcome(self) -> str:
        """What can honestly be said about the external source for this answer (never «it is not there»):
        found · no_match (the search returned nothing visible) · insufficient_evidence (pages found, none states the
        sought terms) · denied (candidates were no longer readable) · source_unavailable (timeout, error, breaker)."""
        if self.degraded:
            return "source_unavailable"
        if self.fragments:
            return "found"
        if self.candidates == 0:
            return "no_match"
        if self.rejected and all(r["reason"] == "not_found_or_revoked" for r in self.rejected):
            return "denied"
        return "insufficient_evidence"

    def summary(self) -> dict[str, Any]:
        return {
            "called": self.called,
            "trigger": self.trigger,
            "outcome": self.outcome if self.called else None,
            "searches": self.searches,
            "focused": self.focused,
            "candidates": self.candidates,
            "fetched": self.fetched,
            "cache_hits": self.cache_hits,
            "mcp_calls": self.mcp_calls,
            "fragments": len(self.fragments),
            "rejected": self.rejected[:20],
            "degraded": self.degraded,
            "elapsed_ms": self.elapsed_ms,
            "policy_version": POLICY_VERSION,
        }


@dataclass
class _CacheEntry:
    fragments: list[Fragment]
    page: CorporatePage
    stored_at: float
    truncated: bool = False


def _truncation_warning(page: CorporatePage) -> str:
    return f"Страница «{page.title}» слишком большая: использована только её начальная часть."


class _Breaker:
    def __init__(self, failures: int, reset_seconds: float) -> None:
        self._limit = failures
        self._reset = reset_seconds
        self._failures = 0
        self._opened_at: float | None = None

    @property
    def state(self) -> str:
        if self._opened_at is None:
            return "closed"
        return "half_open" if time.monotonic() - self._opened_at >= self._reset else "open"

    def allow(self) -> bool:
        return self.state != "open"

    def success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def failure(self) -> None:
        self._failures += 1
        if self._failures >= self._limit:
            self._opened_at = time.monotonic()


class ExternalEvidenceService:
    def __init__(
        self,
        connector: CorporateKnowledgeConnector,
        discovery: DiscoveryStore | None,
        limits: ExternalLimits,
    ) -> None:
        self._connector = connector
        self._discovery = discovery
        self.limits = limits
        self._semaphore = asyncio.Semaphore(limits.concurrency)
        self._cache: OrderedDict[tuple[str, ...], _CacheEntry] = OrderedDict()
        self._breaker = _Breaker(limits.breaker_failures, limits.breaker_reset_seconds)
        self._latencies: deque[float] = deque(maxlen=500)
        self.counters: dict[str, int] = {
            "requests": 0,
            "mcp_calls": 0,
            "cache_hits": 0,
            "cache_misses": 0,
            "timeouts": 0,
            "errors": 0,
            "rejected": 0,
            "revoked_or_deleted": 0,
            "evicted": 0,
        }
        self._concurrent = 0
        self.max_concurrent_seen = 0

    @property
    def enabled(self) -> bool:
        return bool(getattr(self._connector, "enabled", False))

    # --- bounded calls ---------------------------------------------------------------------------
    async def _call(self, awaitable: Awaitable[T], result: ExternalRetrieval) -> T:
        async with self._semaphore:
            self._concurrent += 1
            self.max_concurrent_seen = max(self.max_concurrent_seen, self._concurrent)
            try:
                result.mcp_calls += 1
                self.counters["mcp_calls"] += 1
                return await asyncio.wait_for(awaitable, timeout=self.limits.timeout_seconds)
            finally:
                self._concurrent -= 1

    # --- cache -----------------------------------------------------------------------------------
    def _key(self, page: CorporatePage, scope: str) -> tuple[str, ...]:
        return (page.instance or "-", page.page_id, page.version, scope, RENDER_VERSION, POLICY_VERSION)

    def _sweep(self) -> None:
        if self.limits.cache_ttl_seconds <= 0:
            self._cache.clear()
            return
        horizon = time.monotonic() - self.limits.cache_ttl_seconds
        for key in [k for k, e in self._cache.items() if e.stored_at < horizon]:
            del self._cache[key]
            self.counters["evicted"] += 1

    def purge_page(self, instance: str, page_id: str, *, keep_version: str | None = None) -> int:
        keys = [
            k for k in self._cache if k[0] == (instance or "-") and k[1] == page_id and k[2] != keep_version
        ]
        for key in keys:
            del self._cache[key]
        return len(keys)

    def purge_all(self) -> int:
        count = len(self._cache)
        self._cache.clear()
        return count

    def _store(self, key: tuple[str, ...], entry: _CacheEntry) -> None:
        if self.limits.cache_pages <= 0:
            return
        self._cache[key] = entry
        self._cache.move_to_end(key)
        while len(self._cache) > self.limits.cache_pages:
            self._cache.popitem(last=False)
            self.counters["evicted"] += 1

    # --- retrieval -------------------------------------------------------------------------------
    @staticmethod
    def _source_base(page: CorporatePage) -> str:
        return f"confluence:{page.instance or 'default'}:{page.page_id}"

    @staticmethod
    def _matched(terms: list[QueryTerm], text: str) -> list[QueryTerm]:
        words = tokenize(text)
        return [t for t in terms if term_matches_text(t, words)]

    async def retrieve(
        self,
        user: UserContext,
        question: str,
        terms: list[QueryTerm],
        snapshot: KnowledgeSnapshot | None,
        *,
        trigger: str,
        queries: Sequence[str] = (),
        focus: list[list[QueryTerm]] | None = None,
    ) -> ExternalRetrieval:
        """`queries`: up to MAX_QUERIES focused search texts (empty: the question is the search text, as before);
        `focus`: the terms of each query — a candidate or a fragment is relevant when it answers ONE of them (two
        aspects of a question are two queries); without it, the question's `terms` are the only group (as before).
        `terms` stay the intent of discovery hints. Fetch, fragment, context and deadline limits are shared by all
        queries of the answer."""
        started = time.perf_counter()
        result = ExternalRetrieval(called=True, trigger=trigger, focused=bool(queries))
        self.counters["requests"] += 1
        self._sweep()
        if not self.enabled:
            result.called = False
            return result
        if not self._breaker.allow():
            result.degraded = True
            result.warnings.append(
                "Корпоративный источник временно отключён после серии ошибок — ответ построен по документам команды."
            )
            return result
        try:
            async with asyncio.timeout(self.limits.deadline_seconds):
                groups = [g for g in (focus or [])[:MAX_QUERIES] if g] or [terms]
                await self._retrieve(
                    user, list(queries[:MAX_QUERIES]) or [question], terms, groups, snapshot, result
                )
            self._breaker.success()
        except TimeoutError:
            self.counters["timeouts"] += 1
            self._breaker.failure()
            result.degraded = True
            result.warnings.append(
                "Корпоративный источник не ответил вовремя — ответ построен по документам команды и может быть неполным."
            )
        except ConnectorUnavailableError as exc:
            self.counters["errors"] += 1
            self._breaker.failure()
            result.degraded = True
            result.warnings.append(
                f"Корпоративный источник недоступен ({exc.code}) — использованы документы команды."
            )
        result.elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        self._latencies.append(result.elapsed_ms)
        return result

    async def _search(
        self, queries: list[str], user: UserContext, result: ExternalRetrieval
    ) -> list[CorporatePage]:
        """One MCP search per query; results interleaved by rank, de-duplicated by page, ≤ `candidates` in total."""
        lists: list[list[CorporatePage]] = []
        for query in queries:
            result.searches += 1
            found = await self._call(
                self._connector.search(query, user, limit=self.limits.candidates), result
            )
            lists.append(list(found[: self.limits.candidates]))
        merged: list[CorporatePage] = []
        seen: set[tuple[str, str]] = set()
        for index in range(max((len(found) for found in lists), default=0)):
            for found in lists:
                if index < len(found):
                    page = found[index]
                    key = (page.instance or "-", page.page_id)
                    if key not in seen:
                        seen.add(key)
                        merged.append(page)
        return merged[: self.limits.candidates]

    async def _retrieve(
        self,
        user: UserContext,
        queries: list[str],
        intent_terms: list[QueryTerm],
        groups: list[list[QueryTerm]],
        snapshot: KnowledgeSnapshot | None,
        result: ExternalRetrieval,
    ) -> None:
        scope = acl_scope_key(user)
        candidates = await self._search(queries, user, result)
        result.candidates = len(candidates)
        if not candidates or not any(groups):
            return
        intent = sorted({t.stem for t in intent_terms})
        hints = self._discovery.hints(intent, scope) if self._discovery else {}
        invalidated = self._discovery.invalidated() if self._discovery else set()

        def weight(group: list[QueryTerm], matched: list[QueryTerm]) -> float:
            # Identifiers and acronyms weigh double.
            return sum(2 if t.is_entity_like else 1 for t in matched) / sum(
                2 if t.is_entity_like else 1 for t in group
            )

        ranked: list[tuple[float, int, CorporatePage, list[str]]] = []
        for position, page in enumerate(candidates):
            base = self._source_base(page)
            if base in invalidated and self._discovery is not None:
                self._discovery.clear_invalidation(base)  # visible again in a fresh, ACL-filtered search
            head = f"{page.title} {' '.join(page.labels)} {page.body[:2000]}"
            group, matched = max(
                ((g, self._matched(g, head)) for g in groups if g), key=lambda item: weight(*item)
            )
            if not matched:
                self._reject(result, page, "irrelevant_metadata")
                continue
            hint = hints.get(base, 0.0)
            reasons = [f"совпало слов: {len(matched)} из {len(group)}"]
            if hint:
                reasons.append("приоритет по отзывам на похожий вопрос" if hint > 0 else "понижен по отзывам")
            # The best-answered query decides; ties keep the source's own ranking.
            ranked.append((weight(group, matched) + 0.25 * hint, position, page, reasons))
        ranked.sort(key=lambda item: (-item[0], item[1]))

        selected: list[ExternalFragment] = []
        budget = self.limits.context_chars
        for score, _position, candidate, reasons in ranked[: self.limits.fetches]:
            if score <= 0:
                self._reject(result, candidate, "lowered_by_feedback")
                continue
            canonical = candidate.canonical_document_id
            if canonical and snapshot is not None:
                doc = snapshot.get(canonical)
                if doc is not None and doc.status == DocStatus.approved:
                    self._reject(result, candidate, f"duplicate_of:{doc.id}")
                    continue
            entry = await self._page(candidate, user, scope, result)
            if entry is None:
                continue
            page = entry.page
            best: list[tuple[int, Fragment]] = []
            for frag in entry.fragments:
                text = f"{frag.heading or ''} {frag.text}"
                found = [(g, self._matched(g, text)) for g in groups if g]
                # Relevant when it states at least half of ONE query's words (or names its identifier).
                if any(
                    len(m) >= max(1, math.ceil(len(g) / 2)) or any(t.is_entity_like for t in m)
                    for g, m in found
                ):
                    best.append((max(len(m) for _g, m in found), frag))
            if not best:
                self._reject(result, page, "irrelevant_text")
                continue
            best.sort(key=lambda item: (-item[0], item[1].fragment_id))
            for count, frag in best[:2]:
                if len(selected) >= self.limits.fragments or budget <= 0:
                    break
                text = frag.text[: min(1500, budget)]
                budget -= len(text)
                selected.append(
                    ExternalFragment(
                        source_id=f"{self._source_base(page)}:{page.version}",
                        source_base=self._source_base(page),
                        page_id=page.page_id,
                        instance=page.instance or "default",
                        version=page.version,
                        title=page.title,
                        status=page.status or "unknown",
                        uri=page.source_uri,
                        fragment_id=frag.fragment_id,
                        heading=frag.heading,
                        anchor=frag.anchor,
                        text=text,
                        content_hash=frag.content_hash,
                        retrieved_at=datetime.fromtimestamp(time.time(), tz=UTC),
                        from_cache=entry is not None and result.cache_hits > 0,
                        score=round(score + count / 10, 4),
                        is_mock=page.is_mock,
                        reasons=reasons,
                    )
                )
        result.fragments = selected

    def _reject(self, result: ExternalRetrieval, page: CorporatePage, reason: str) -> None:
        self.counters["rejected"] += 1
        result.rejected.append({"page_id": page.page_id, "version": page.version, "reason": reason})

    async def _page(
        self, candidate: CorporatePage, user: UserContext, scope: str, result: ExternalRetrieval
    ) -> _CacheEntry | None:
        key = self._key(candidate, scope)
        cached = self._cache.get(key)
        if cached is not None:
            # The candidate came from a FRESH, ACL-filtered search with the same version: safe to reuse.
            self._cache.move_to_end(key)
            result.cache_hits += 1
            self.counters["cache_hits"] += 1
            if cached.truncated:
                result.warnings.append(_truncation_warning(cached.page))
            return cached
        self.counters["cache_misses"] += 1
        try:
            page = await self._call(self._connector.get_page(candidate.page_id, user), result)
        except CorporatePageNotFoundError:
            # Deleted or no longer readable: drop every cached version and hide derived overlays.
            self.counters["revoked_or_deleted"] += 1
            self.purge_page(candidate.instance, candidate.page_id)
            if self._discovery:
                self._discovery.invalidate_source(self._source_base(candidate), "revoked_or_deleted")
            self._reject(result, candidate, "not_found_or_revoked")
            return None
        result.fetched += 1
        if page.version != candidate.version:
            logger.info(
                "page %s changed between search and fetch: v%s → v%s",
                page.page_id,
                candidate.version,
                page.version,
            )
        self.purge_page(page.instance, page.page_id, keep_version=page.version)  # older versions are stale
        text, truncated = storage_to_text(page.storage or page.body, max_chars=self.limits.max_page_chars)
        if truncated:
            result.warnings.append(_truncation_warning(page))
        entry = _CacheEntry(
            fragments=fragments(text), page=page, stored_at=time.monotonic(), truncated=truncated
        )
        self._store(self._key(page, scope), entry)
        return entry

    async def revalidate(self, user: UserContext, page_id: str, version: str) -> bool:
        """Is this page still readable for the user, in this version? (used by the query graph)"""
        if not self.enabled or not self._breaker.allow():
            return False
        probe = ExternalRetrieval(called=True, trigger="revalidate")
        try:
            page = await self._call(self._connector.get_page(page_id, user), probe)
        except (CorporatePageNotFoundError, ConnectorUnavailableError, TimeoutError):
            return False
        return page.version == version

    def stats(self) -> dict[str, Any]:
        latencies = sorted(self._latencies)

        def pct(p: float) -> float | None:
            if not latencies:
                return None
            return latencies[min(len(latencies) - 1, round(p / 100 * (len(latencies) - 1)))]

        return {
            **self.counters,
            "cache_pages": len(self._cache),
            "cache_limit": self.limits.cache_pages,
            "cache_ttl_seconds": self.limits.cache_ttl_seconds,
            "breaker": self._breaker.state,
            "max_concurrent_seen": self.max_concurrent_seen,
            "concurrency_limit": self.limits.concurrency,
            "latency_p50_ms": pct(50),
            "latency_p95_ms": pct(95),
            "limits": self.limits.__dict__,
        }
