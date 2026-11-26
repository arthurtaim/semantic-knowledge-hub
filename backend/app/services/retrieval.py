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

import math
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
# Boilerplate: a body line repeated verbatim in at least this many documents AND this share of the reader's snapshot
# (e.g. the disclaimer every synthetic document opens with) carries no evidence for any particular question.
BOILERPLATE_MIN_DOCUMENTS = 5
BOILERPLATE_MIN_SHARE = 0.05
BOILERPLATE_CACHE_MAX = 16
# Passage packing v2 (see `passages`): every matching section of the (few) context documents is a candidate. When a
# document's evidence is completed, a question word already shown from ANOTHER document counts REPEATED_WORD_FACTOR,
# one the document itself already shows counts CORROBORATION_FACTOR (a second section saying the same is still worth
# a slot of the best document more than an unrelated word of a weaker one).
SECTION_CANDIDATES = 400
REPEATED_WORD_FACTOR = 0.5
CORROBORATION_FACTOR = 0.25


def only_boilerplate(text: str, common: frozenset[str]) -> bool:
    lines = [line for line in (normalize(raw) for raw in text.splitlines()) if line]
    return bool(lines) and all(line in common for line in lines)


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
class _Section:
    """A candidate section for the assistant's context (passage packing v2)."""

    rank: int  # rank of its document in the retrieval result
    position: int  # BM25 order among the candidate sections (0 = best)
    document_id: str
    chunk: ChunkHit
    matched: frozenset[int]  # indexes of the question terms the heading or text contains


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
        # Boilerplate lines per reader's snapshot (version + visible ids): computed once per generation.
        self._boilerplate: dict[tuple[str, int], frozenset[str]] = {}

    @property
    def dictionary(self) -> SearchDictionary:
        return self._dictionary

    def boilerplate(self, snapshot: KnowledgeSnapshot) -> frozenset[str]:
        """Normalized body lines repeated in many documents of THIS reader's snapshot (corpus statistics, no
        keywords): a banner, a disclaimer or a stock sentence is the same in every document and answers nothing."""
        key = (snapshot.version, hash(frozenset(snapshot.documents)))
        cached = self._boilerplate.get(key)
        if cached is not None:
            return cached
        counts: dict[str, int] = {}
        for doc in snapshot.documents.values():
            lines = {normalize(line) for section in doc.sections for line in section.text.splitlines()}
            for line in lines - {""}:
                counts[line] = counts.get(line, 0) + 1
        threshold = max(BOILERPLATE_MIN_DOCUMENTS, int(len(snapshot.documents) * BOILERPLATE_MIN_SHARE) + 1)
        result = frozenset(line for line, n in counts.items() if n >= threshold)
        if len(self._boilerplate) >= BOILERPLATE_CACHE_MAX:
            self._boilerplate.clear()
        self._boilerplate[key] = result
        return result

    def is_boilerplate(self, snapshot: KnowledgeSnapshot, text: str) -> bool:
        """True when every line of `text` is corpus-wide boilerplate: such a passage is never offered as evidence."""
        return only_boilerplate(text, self.boilerplate(snapshot))

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
        """Cite-ready passages for the assistant from the best ELIGIBLE documents (`filters` carries the allowed
        statuses). Passage packing v2 (docs/SEARCH_SYNC_TEMPLATES.md «Passage packing v2»):

        * candidates — EVERY section of the context documents that contains a question word (v1 took the 60 best
          sections of the whole corpus, so a relevant section of a context document could be cut off);
        * a document the question names by its exact id is the subject: its sections are packed first (both steps
          below), the other documents only take the slots left;
        * first, one section per document in document order: its best section by BM25 (diversity);
        * then the remaining slots, one at a time: the section with the largest gain — the rare-weighted question
          words it adds to its OWN document's passages (a word already shown from another document counts
          REPEATED_WORD_FACTOR; a word its document already shows counts CORROBORATION_FACTOR), divided by
          (1 + document rank). Ties: the document with fewer passages, then rank, then BM25.

        So a question whose parts are answered in different sections of the best document gets those sections
        (v1 always took the two BM25-best ones). Corpus-wide boilerplate is never a candidate."""
        ranked = self.rank_documents(
            snapshot, analysis, filters, max_documents, expand_graph=False, catalog=False
        )
        if not ranked:
            return [], []
        common = self.boilerplate(snapshot)
        terms = analysis.terms
        weights = self.term_weights(snapshot, terms, filters)
        rank_of = {hit.document_id: rank for rank, hit in enumerate(ranked)}
        candidates: list[_Section] = []
        if terms:
            found = self._search.search_chunks(terms, filters, SECTION_CANDIDATES, document_ids=list(rank_of))
            for position, chunk in enumerate(found):
                if chunk.document_id not in rank_of or only_boilerplate(chunk.text, common):
                    continue
                words = tokenize(f"{chunk.section} {chunk.text}")
                matched = frozenset(i for i, t in enumerate(terms) if term_matches_text(t, words))
                candidates.append(
                    _Section(rank_of[chunk.document_id], position, chunk.document_id, chunk, matched)
                )
        with_sections = {c.document_id for c in candidates}
        for rank, hit in enumerate(ranked):
            doc = snapshot.get(hit.document_id)
            if (
                doc is None
                or doc.id in with_sections
                or not {"id", "title", "alias"} & set(hit.matched_fields)
            ):
                continue
            # Found by id/title only (no section contains a question word): its opening sections, in order.
            opening = [s for s in doc.sections if s.text and not only_boilerplate(s.text, common)][:2]
            for ordinal, s in enumerate(opening):
                chunk = ChunkHit(doc.id, s.heading, s.anchor, s.text, 0.0, ordinal)
                candidates.append(_Section(rank, SECTION_CANDIDATES + ordinal, doc.id, chunk, frozenset()))

        chosen: list[_Section] = []
        shown_by: dict[str, set[int]] = {}  # question words each document's chosen passages contain
        shown: set[int] = set()

        def take(section: _Section) -> None:
            chosen.append(section)
            shown_by.setdefault(section.document_id, set()).update(section.matched)
            shown.update(section.matched)

        def gain(section: _Section) -> float:
            own_words = shown_by.get(section.document_id, set())
            raw = sum(
                weights[i]
                * (CORROBORATION_FACTOR if i in own_words else REPEATED_WORD_FACTOR if i in shown else 1.0)
                for i in section.matched
            )
            return round(raw / (1 + section.rank), 6)

        def pack(documents: set[str]) -> None:
            for rank, hit in enumerate(ranked):  # one section per document first: its BM25-best (diversity)
                own = [c for c in candidates if c.rank == rank]
                has_one = any(c.document_id == hit.document_id for c in chosen)
                if hit.document_id in documents and own and not has_one and len(chosen) < max_passages:
                    take(min(own, key=lambda c: c.position))
            while len(chosen) < max_passages:  # then the largest gain, one section at a time
                remaining = [c for c in candidates if c.document_id in documents and c not in chosen]
                if not remaining:
                    break
                per_document = {d: sum(1 for c in chosen if c.document_id == d) for d in rank_of}
                take(
                    max(
                        remaining, key=lambda c: (gain(c), -per_document[c.document_id], -c.rank, -c.position)
                    )
                )

        # A document the question names by its exact id is its subject: its matching sections come first, the other
        # documents only take the slots left (otherwise lexically similar documents — which mention that id — would
        # share the context with it and an answer about FLOW-001 could lead with another flow).
        named = {hit.document_id for hit in ranked if "id" in hit.matched_fields}
        if named:
            pack(named)
        pack(set(rank_of))

        result: list[Passage] = []
        for section in chosen:
            doc = snapshot.get(section.document_id)
            if doc is not None:
                c = section.chunk
                result.append(Passage(doc, c.section, c.section_anchor, c.text, section.rank))
        return result, ranked

    def term_weights(
        self, snapshot: KnowledgeSnapshot, terms: list[QueryTerm], filters: SearchFilters
    ) -> list[float]:
        """Inverse document frequency of every question term within the documents this request may use
        (corpus statistics of the reader's eligible snapshot, no keyword list): log((N + 1) / (df + 1)) + 1."""
        if not terms:
            return []
        eligible = sum(1 for doc in snapshot.documents.values() if self._passes(doc, filters))
        return [
            math.log((eligible + 1) / (len(self._search.matching_document_ids(t, filters)) + 1)) + 1.0
            for t in terms
        ]
