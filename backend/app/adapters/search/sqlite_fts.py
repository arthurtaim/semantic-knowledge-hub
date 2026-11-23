"""SQLite FTS5 search index. Derived state only: always rebuildable from the repository."""

from __future__ import annotations

import logging
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.search.base import ChunkHit, DocumentHit, SearchFilters
from app.domain.models import DocumentRecord, HighlightSegment, IntegrationStatus
from app.domain.text import QueryTerm, fts_query, fts_term, strip_control

logger = logging.getLogger("skh.search")

SCHEMA_VERSION = "4"
_HL_START, _HL_END = "\x02", "\x03"
_TOKENIZER = "unicode61 remove_diacritics 2"
_FILTER_COLUMNS = ("status", "type", "owner", "source")
# Column order matters for bm25() weights and snippet() column index.
_DOC_WEIGHTS = "0, 0, 0, 0, 0, 0, 10.0, 6.0, 4.0, 1.5, 2.0, 1.0"
_CHUNK_WEIGHTS = "0, 0, 0, 0, 0, 0, 0, 0, 0, 3.0, 1.0"
_CHUNK_TEXT_COL = 10


class SearchIndexError(RuntimeError):
    pass


def fts5_available() -> bool:
    try:
        conn = sqlite3.connect(":memory:")
        conn.execute(f"CREATE VIRTUAL TABLE t USING fts5(x, tokenize='{_TOKENIZER}')")
        conn.close()
    except sqlite3.OperationalError:
        return False
    return True


def segments_from_snippet(snippet: str) -> list[HighlightSegment]:
    segments: list[HighlightSegment] = []
    rest = snippet
    while rest:
        start = rest.find(_HL_START)
        if start == -1:
            segments.append(HighlightSegment(text=rest))
            break
        if start > 0:
            segments.append(HighlightSegment(text=rest[:start]))
        end = rest.find(_HL_END, start + 1)
        if end == -1:
            segments.append(HighlightSegment(text=rest[start + 1 :], highlight=True))
            break
        segments.append(HighlightSegment(text=rest[start + 1 : end], highlight=True))
        rest = rest[end + 1 :]
    return [s for s in segments if s.text]


def _clean(text: str) -> str:
    return strip_control(text).replace(_HL_START, "").replace(_HL_END, "")


class SqliteFtsSearchProvider:
    def __init__(self, index_path: Path | str) -> None:
        if not fts5_available():
            raise SearchIndexError("SQLite в этой среде собран без FTS5; поиск недоступен.")
        self._path = str(index_path)
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._indexed_version: str | None = None
        self._indexed_at: datetime | None = None
        self._doc_count = 0
        self._ensure_schema()

    # --- schema / indexing -----------------------------------------------------------------------
    def _ensure_schema(self) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            row = self._conn.execute("SELECT value FROM index_meta WHERE key='schema'").fetchone()
            if row is None or row[0] != SCHEMA_VERSION:
                self._conn.execute("DROP TABLE IF EXISTS docs")
                self._conn.execute("DROP TABLE IF EXISTS chunks")
                self._conn.execute("DROP TABLE IF EXISTS doc_versions")
                self._conn.execute("DELETE FROM index_meta")
                self._conn.execute(
                    "INSERT INTO index_meta(key, value) VALUES ('schema', ?)", (SCHEMA_VERSION,)
                )
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5("
                "doc_id UNINDEXED, status UNINDEXED, type UNINDEXED, owner UNINDEXED, source UNINDEXED, "
                "tags_raw UNINDEXED, id_text, title, tags, related, summary, body, "
                f"tokenize='{_TOKENIZER}')"
            )
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5("
                "doc_id UNINDEXED, status UNINDEXED, type UNINDEXED, owner UNINDEXED, source UNINDEXED, "
                "tags_raw UNINDEXED, section UNINDEXED, anchor UNINDEXED, ordinal UNINDEXED, heading, text, "
                f"tokenize='{_TOKENIZER}')"
            )
            # One row per indexed document: which source revision the index holds (provenance).
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS doc_versions (doc_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
                "revision TEXT NOT NULL, fingerprint TEXT NOT NULL, indexed_at TEXT NOT NULL)"
            )

    @staticmethod
    def _fingerprint(doc: DocumentRecord) -> str:
        # Everything that is indexed or filtered on; a new revision always changes it.
        return "|".join(
            (doc.source, doc.revision, doc.status.value, doc.type.value, doc.owner, ",".join(doc.tags))
        )

    def _insert(self, doc: DocumentRecord) -> None:
        filters = (doc.id, doc.status.value, doc.type.value, doc.owner, doc.source)
        tags_raw = "|" + "|".join(doc.tags) + "|"
        self._conn.execute(
            "INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                *filters,
                tags_raw,
                doc.id,
                _clean(doc.title),
                " ".join(doc.tags),
                " ".join(doc.related_ids),
                _clean(doc.summary or ""),
                _clean("\n".join(s.text for s in doc.sections)),
            ),
        )
        for ordinal, section in enumerate(doc.sections):
            if not section.text:
                continue
            self._conn.execute(
                "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    *filters,
                    tags_raw,
                    section.heading,
                    section.anchor,
                    ordinal,
                    _clean(section.heading),
                    _clean(section.text),
                ),
            )

    def sync(self, snapshot: KnowledgeSnapshot) -> None:
        """Incremental: re-index documents whose revision changed, drop documents that disappeared
        from the source, keep exactly one entry per document id."""
        if snapshot.version == self._indexed_version:
            return
        now = datetime.now(UTC).isoformat()
        with self._lock, self._conn:
            indexed = {
                row[0]: row[1] for row in self._conn.execute("SELECT doc_id, fingerprint FROM doc_versions")
            }
            wanted = {doc.id: doc for doc in snapshot.documents.values()}
            removed = [doc_id for doc_id in indexed if doc_id not in wanted]
            changed = [doc for doc_id, doc in wanted.items() if indexed.get(doc_id) != self._fingerprint(doc)]
            for doc_id in [*removed, *(d.id for d in changed)]:
                self._conn.execute("DELETE FROM docs WHERE doc_id = ?", (doc_id,))
                self._conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
                self._conn.execute("DELETE FROM doc_versions WHERE doc_id = ?", (doc_id,))
            for doc in changed:
                self._insert(doc)
                self._conn.execute(
                    "INSERT INTO doc_versions(doc_id, source, revision, fingerprint, indexed_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (doc.id, doc.source, doc.revision, self._fingerprint(doc), now),
                )
            for key, value in (("version", snapshot.version), ("indexed_at", now)):
                self._conn.execute(
                    "INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)", (key, value)
                )
        self._indexed_version = snapshot.version
        self._indexed_at = datetime.fromisoformat(now)
        self._doc_count = len(wanted)
        logger.info(
            "search index synced: %d document(s), %d re-indexed, %d removed",
            self._doc_count,
            len(changed),
            len(removed),
        )

    def indexed_revisions(self) -> dict[str, str]:
        """Document id -> source revision currently held by the index."""
        with self._lock:
            return {r[0]: r[1] for r in self._conn.execute("SELECT doc_id, revision FROM doc_versions")}

    def index_info(self) -> tuple[str | None, int, datetime | None]:
        return self._indexed_version, self._doc_count, self._indexed_at

    # --- querying ------------------------------------------------------------------------------
    @staticmethod
    def _filter_sql(filters: SearchFilters, table: str) -> tuple[str, list[str]]:
        clauses: list[str] = []
        params: list[str] = []
        for column, values in (
            ("status", filters.statuses),
            ("type", filters.types),
            ("owner", filters.owners),
            ("source", filters.sources),
        ):
            if values is None:
                continue
            if not values:
                clauses.append("0")
                continue
            placeholders = ", ".join("?" for _ in values)
            clauses.append(f"{table}.{column} IN ({placeholders})")
            params.extend(sorted(values))
        if filters.tags:
            for tag in sorted(filters.tags):
                clauses.append(f"{table}.tags_raw LIKE ? ESCAPE '\\'")
                escaped = tag.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                params.append(f"%|{escaped}|%")
        return ("".join(f" AND {c}" for c in clauses), params)

    def search_documents(
        self, terms: list[QueryTerm], filters: SearchFilters, limit: int, *, mode: str = "and"
    ) -> list[DocumentHit]:
        if not terms:
            return []
        match = fts_query(terms, mode=mode)
        snippet_match = fts_query(terms, mode="or")
        where, params = self._filter_sql(filters, "docs")
        sql = (
            f"SELECT doc_id, bm25(docs, {_DOC_WEIGHTS}) AS score FROM docs "
            f"WHERE docs MATCH ?{where} ORDER BY score, doc_id LIMIT ?"
        )
        hits: list[DocumentHit] = []
        with self._lock:
            rows = self._conn.execute(sql, [match, *params, limit]).fetchall()
            for doc_id, score in rows:
                chunk = self._conn.execute(
                    f"SELECT section, anchor, snippet(chunks, {_CHUNK_TEXT_COL}, ?, ?, '…', 28) "
                    f"FROM chunks WHERE chunks MATCH ? AND chunks.doc_id = ? "
                    f"ORDER BY bm25(chunks, {_CHUNK_WEIGHTS}), CAST(ordinal AS INTEGER) LIMIT 1",
                    (_HL_START, _HL_END, snippet_match, doc_id),
                ).fetchone()
                if chunk is None:
                    hits.append(DocumentHit(document_id=doc_id, score=round(-float(score), 4), excerpt=""))
                    continue
                section, anchor, snippet = chunk
                segments = segments_from_snippet(snippet)
                hits.append(
                    DocumentHit(
                        document_id=doc_id,
                        score=round(-float(score), 4),
                        excerpt="".join(s.text for s in segments),
                        segments=segments,
                        section=section or None,
                        section_anchor=anchor or None,
                    )
                )
        return hits

    def search_chunks(self, terms: list[QueryTerm], filters: SearchFilters, limit: int) -> list[ChunkHit]:
        if not terms:
            return []
        where, params = self._filter_sql(filters, "chunks")
        sql = (
            f"SELECT doc_id, section, anchor, text, bm25(chunks, {_CHUNK_WEIGHTS}) AS score FROM chunks "
            f"WHERE chunks MATCH ?{where} ORDER BY score, doc_id, CAST(ordinal AS INTEGER) LIMIT ?"
        )
        with self._lock:
            rows = self._conn.execute(sql, [fts_query(terms, mode="or"), *params, limit]).fetchall()
        return [
            ChunkHit(
                document_id=r[0], section=r[1], section_anchor=r[2], text=r[3], score=round(-float(r[4]), 4)
            )
            for r in rows
        ]

    def matching_document_ids(self, term: QueryTerm, filters: SearchFilters) -> set[str]:
        """Documents whose quotable content (section headings/text) contains the term."""
        where, params = self._filter_sql(filters, "chunks")
        with self._lock:
            rows = self._conn.execute(
                f"SELECT DISTINCT doc_id FROM chunks WHERE chunks MATCH ?{where}", [fts_term(term), *params]
            ).fetchall()
        return {r[0] for r in rows}

    def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="search_index",
            title="Поисковый индекс",
            kind="search",
            state="connected",
            capabilities=["full_text", "snippets", "filters", "rebuildable"],
            human_readable_message=(
                f"SQLite FTS5, проиндексировано документов: {self._doc_count}. "
                "Индекс производный и перестраивается из источника."
            ),
            details={"backend": "sqlite_fts5", "documents": str(self._doc_count)},
        )

    def close(self) -> None:
        with self._lock:
            self._conn.close()
