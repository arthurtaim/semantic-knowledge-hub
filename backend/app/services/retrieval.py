"""One retrieval pipeline for the catalog search, /api/search and the assistant (M5.6.2 §B).

    query → normalise + dictionary expansion → candidates:
        a) exact document id   b) exact title / alias   c) FTS5 (id, title, aliases, tags, headings, body)
    → merge + deterministic score → bounded expansion over DECLARED typed relations → status policy
    → ranked hits with `why matched` reasons (and, for the assistant, cite-ready passages).

Status is a filter (eligibility), never a score that lexical similarity could outweigh: callers pass the
allowed statuses in `SearchFilters`. Inside the catalog (all statuses visible) a deprecated document is
ranked below an equally relevant current one, never removed.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, replace

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.search.base import ChunkHit, DocumentHit, SearchFilters, SearchProvider
from app.domain.dictionary import SearchDictionary
from app.domain.models import DocStatus, DocumentRecord, RelationType
from app.domain.text import QueryTerm, analyze_query, term_matches_text, tokenize

ID_CANDIDATE_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+")
FTS_CANDIDATES = 200
EXPANSION_BUDGET = 5
EXPANSION_SEEDS = 3
EXPANSION_RELATIONS = frozenset(r for r in RelationType if r is not RelationType.references)

TIER_EXACT_ID = 1000.0
TIER_EXACT_TITLE = 500.0
TIER_TITLE_PHRASE = 150.0
TITLE_TERM_BONUS = 30.0  # × share of query terms found in title/aliases
TAG_BONUS = 4.0
DEPRECATED_FACTOR = 0.6  # catalog only: below an equally relevant current document
WORDS_CACHE_MAX = 4096  # tokenized documents kept between requests (keyed by id + revision)


def normalize(text: str) -> str:
    """NFKC + casefold + ё→е + punctuation-insensitive spacing (exact title/alias comparison)."""
    folded = unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")
    return " ".join(re.sub(r"[^\w]+", " ", folded).split())


@dataclass(frozen=True)
class QueryAnalysis:
    text: str
    normalized: str
    terms: list[QueryTerm]
    notes: list[str]
    id_candidates: list[str]


@dataclass
class RankedHit:
    document_id: str
    score: float
    reasons: list[str] = field(default_factory=list)
    matched_fields: list[str] = field(default_factory=list)
    hit: DocumentHit | None = None
    via: str | None = None  # graph expansion: the seed document id

    def add(self, reason: str, field_name: str | None = None) -> None:
        if reason not in self.reasons:
            self.reasons.append(reason)
        if field_name and field_name not in self.matched_fields:
            self.matched_fields.append(field_name)


@dataclass(frozen=True)
class Passage:
    document: DocumentRecord
    section: str | None
    section_anchor: str | None
    text: str
    rank: int  # document rank in the retrieval result


class RetrievalService:
    def __init__(self, search: SearchProvider, dictionary: SearchDictionary) -> None:
        self._search = search
        self._dictionary = dictionary
        # Tokens of title + body per (id, revision): explaining a synonym match must not re-tokenize every
        # candidate's body for every expanded term. A new revision is a new key; the cache is bounded.
        self._words: dict[tuple[str, str], list[str]] = {}

    @property
    def dictionary(self) -> SearchDictionary:
        return self._dictionary

    def analyze(self, query: str) -> QueryAnalysis:
        terms, notes = self._dictionary.expand(analyze_query(query))
        ids = list(dict.fromkeys(m.group(0) for m in ID_CANDIDATE_RE.finditer(query)))
        return QueryAnalysis(
            text=query, normalized=normalize(query), terms=terms, notes=notes, id_candidates=ids
        )

    @staticmethod
    def _passes(doc: DocumentRecord, filters: SearchFilters) -> bool:
        checks = (
            (filters.statuses, doc.status.value),
            (filters.types, doc.type.value),
            (filters.owners, doc.owner),
            (filters.sources, doc.source),
        )
        if any(values is not None and value not in values for values, value in checks):
            return False
        return not filters.tags or filters.tags.issubset(set(doc.tags))

    def rank_documents(
        self,
        snapshot: KnowledgeSnapshot,
        analysis: QueryAnalysis,
        filters: SearchFilters,
        limit: int,
        *,
        expand_graph: bool = True,
        catalog: bool = True,
    ) -> list[RankedHit]:
        ranked: dict[str, RankedHit] = {}

        def entry(doc: DocumentRecord) -> RankedHit:
            return ranked.setdefault(doc.id, RankedHit(document_id=doc.id, score=0.0))

        # a) exact document id
        for candidate in analysis.id_candidates:
            doc = snapshot.get(candidate)
            if doc is not None and self._passes(doc, filters):
                hit = entry(doc)
                hit.score += TIER_EXACT_ID
                hit.add("Точное совпадение идентификатора", "id")
        # b) exact title / alias (normalised), or the whole query as a phrase inside the title
        if analysis.normalized:
            words = analysis.normalized.split()
            for doc in snapshot.documents.values():
                if not self._passes(doc, filters):
                    continue
                title = normalize(doc.title)
                aliases = [normalize(a) for a in doc.aliases]
                if analysis.normalized == title:
                    entry(doc).score += TIER_EXACT_TITLE
                    entry(doc).add("Точное совпадение названия", "title")
                elif analysis.normalized in aliases:
                    entry(doc).score += TIER_EXACT_TITLE
                    entry(doc).add("Совпадение с альтернативным названием", "alias")
                elif len(words) >= 2 and (
                    f" {analysis.normalized} " in f" {title} "
                    or any(f" {analysis.normalized} " in f" {a} " for a in aliases)
                ):
                    entry(doc).score += TIER_TITLE_PHRASE
                    entry(doc).add("Запрос — часть названия", "title")
        # c) full text (AND of terms, each term an OR of its dictionary spellings), then OR as a fallback
        terms = analysis.terms
        if terms:
            # Scores only: snippets are fetched later for the hits actually shown (`with_snippets`).
            fts = self._search.search_documents(terms, filters, FTS_CANDIDATES, mode="and", snippets=False)
            or_only: set[str] = set()
            if len(fts) < limit and len(terms) > 1:
                # Not enough documents contain every term: documents with some of them, at half weight.
                seen = {h.document_id for h in fts}
                extra = [
                    h
                    for h in self._search.search_documents(
                        terms, filters, FTS_CANDIDATES, mode="or", snippets=False
                    )
                    if h.document_id not in seen
                ]
                fts = [*fts, *extra]
                or_only = {h.document_id for h in extra}
            for fts_hit in fts:
                doc = snapshot.get(fts_hit.document_id)
                if doc is None:
                    continue
                hit = entry(doc)
                hit.score += fts_hit.score * (0.5 if fts_hit.document_id in or_only else 1.0)
                hit.hit = hit.hit or fts_hit
                self._explain_terms(doc, terms, hit)
        for expanded in (t for t in terms if t.expansion):
            label = "Аббревиатура" if (expanded.expansion or "").startswith("abbr") else "Синоним"
            for hit in ranked.values():
                doc = snapshot.get(hit.document_id)
                if doc is not None and term_matches_text(expanded, self._doc_words(doc)):
                    hit.add(f"{label}: «{expanded.original}» и равнозначные написания")
        if catalog:
            for hit in ranked.values():
                doc = snapshot.get(hit.document_id)
                if doc is not None and doc.status == DocStatus.deprecated and hit.score < TIER_EXACT_TITLE:
                    hit.score *= DEPRECATED_FACTOR
        ordered = sorted(ranked.values(), key=lambda h: (-round(h.score, 6), h.document_id))
        if expand_graph and ordered:
            ordered += self._expand(snapshot, ordered, filters, ranked)
        return ordered[:limit] if limit else ordered

    def with_snippets(self, analysis: QueryAnalysis, hits: list[RankedHit]) -> None:
        """Attach the highlighted snippet (best matching section) to the hits that will be displayed."""
        wanted = [h.document_id for h in hits if h.hit is not None and not h.hit.excerpt]
        found = self._search.document_snippets(analysis.terms, wanted) if wanted else {}
        for h in hits:
            snip = found.get(h.document_id)
            if snip is not None and h.hit is not None:
                h.hit = replace(snip, score=h.hit.score)

    def _doc_words(self, doc: DocumentRecord) -> list[str]:
        key = (doc.id, doc.revision)
        words = self._words.get(key)
        if words is None:
            if len(self._words) >= WORDS_CACHE_MAX:
                self._words.clear()
            words = self._words[key] = tokenize(f"{doc.title} {doc.body}")
        return words

    @staticmethod
    def _explain_terms(doc: DocumentRecord, terms: list[QueryTerm], hit: RankedHit) -> None:
        title_words = tokenize(" ".join([doc.title, *doc.aliases]))
        in_title = [t for t in terms if term_matches_text(t, title_words)]
        if in_title:
            hit.score += TITLE_TERM_BONUS * len(in_title) / len(terms)
            hit.add("Слова запроса в названии: " + ", ".join(t.original for t in in_title[:4]), "title")
        in_tags = [t for t in terms if term_matches_text(t, list(doc.tags))]
        if in_tags:
            hit.score += TAG_BONUS * len(in_tags)
            matched = sorted({tg for tg in doc.tags if any(term_matches_text(t, [tg]) for t in in_tags)})
            hit.add("Теги: " + ", ".join(matched)[:80], "tags")
        hit.add("Совпадение в тексте документа", "content")

    def _expand(
        self,
        snapshot: KnowledgeSnapshot,
        ordered: list[RankedHit],
        filters: SearchFilters,
        ranked: dict[str, RankedHit],
    ) -> list[RankedHit]:
        """Bounded expansion: documents linked by DECLARED typed relations to the best direct hits.
        They are placed after every direct hit and say which document and relation brought them in."""
        floor = min(h.score for h in ordered)
        added: list[RankedHit] = []
        for seed in ordered[:EXPANSION_SEEDS]:
            doc = snapshot.get(seed.document_id)
            if doc is None:
                continue
            for rel in doc.relations:
                if len(added) >= EXPANSION_BUDGET:
                    return added
                if rel.type not in EXPANSION_RELATIONS:
                    continue
                target = snapshot.get(rel.target)
                if target is None or target.id in ranked or not self._passes(target, filters):
                    continue
                if any(a.document_id == target.id for a in added):
                    continue
                expansion = RankedHit(
                    document_id=target.id, score=round(floor * 0.5 - len(added) * 0.01, 4), via=doc.id
                )
                expansion.add(f"Связан с {doc.id} ({rel.type.value})", "related")
                added.append(expansion)
        return added

    def passages(
        self,
        snapshot: KnowledgeSnapshot,
        analysis: QueryAnalysis,
        filters: SearchFilters,
        *,
        max_documents: int = 4,
        max_passages: int = 6,
    ) -> tuple[list[Passage], list[RankedHit]]:
        """Cite-ready passages for the assistant: the best sections of the best ELIGIBLE documents,
        one per document first (diversity), then second sections. `filters` must carry the allowed statuses."""
        ranked = self.rank_documents(
            snapshot, analysis, filters, max_documents, expand_graph=False, catalog=False
        )
        if not ranked:
            return [], []
        chunks: dict[str, list[ChunkHit]] = {}
        if analysis.terms:
            for chunk in self._search.search_chunks(analysis.terms, filters, 60):
                chunks.setdefault(chunk.document_id, []).append(chunk)
        result: list[Passage] = []
        for round_no in range(2):
            for rank, hit in enumerate(ranked):
                doc = snapshot.get(hit.document_id)
                if doc is None or len(result) >= max_passages:
                    continue
                doc_chunks = chunks.get(doc.id, [])
                if round_no < len(doc_chunks):
                    c = doc_chunks[round_no]
                    result.append(Passage(doc, c.section, c.section_anchor, c.text, rank))
                elif not doc_chunks and {"id", "title", "alias"} & set(hit.matched_fields):
                    # Found by id/title only: quote the opening sections.
                    sections = [s for s in doc.sections if s.text]
                    if round_no < len(sections):
                        s = sections[round_no]
                        result.append(Passage(doc, s.heading, s.anchor, s.text, rank))
        return result[:max_passages], ranked
