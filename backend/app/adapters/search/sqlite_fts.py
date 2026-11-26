"""SQLite FTS5 search index. Derived state only: always rebuildable from the repository."""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.adapters.search.base import ChunkHit, DocumentHit, SearchFilters
from app.domain.models import DocumentRecord, HighlightSegment, IntegrationStatus
from app.domain.text import QueryTerm, fts_query, fts_term, strip_control

logger = logging.getLogger("skh.search")

SCHEMA_VERSION = "6"
_HL_START, _HL_END = "\x02", "\x03"
_TOKENIZER = "unicode61 remove_diacritics 2"
_FILTER_COLUMNS = ("status", "type", "owner", "source")
# Column order matters for bm25() weights and snippet() column index:
# doc_id status type owner source tags_raw | id_text title aliases tags related summary headings body
_DOC_WEIGHTS = "0, 0, 0, 0, 0, 0, 10.0, 8.0, 6.0, 4.0, 1.0, 2.0, 3.0, 1.0"
_CHUNK_WEIGHTS = "0, 0, 0, 0, 0, 0, 0, 0, 0, 3.0, 1.0"
_CHUNK_TEXT_COL = 10


class SearchIndexError(RuntimeError):
    pass


@dataclass(frozen=True)
class IndexSyncResult:
    """Structured outcome of one index synchronisation (M5.6.2 §C5)."""

    generation: int
    applied: bool  # False: the snapshot was already indexed (no-op)
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    renamed: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    unchanged: int = 0
    rejected: list[dict[str, str]] = field(default_factory=list)  # invalid / duplicate files (not indexed)
    checksum: str = ""
    elapsed_ms: float = 0.0
    full_rebuild: bool = False
    finished_at: str = ""
    seq: int = field(default_factory=time.monotonic_ns)  # ordering of results within one process

    def as_dict(self) -> dict[str, object]:
        return dict(self.__dict__)


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
        self._generation = 0
        self._checksum = ""
        self.last_result: IndexSyncResult | None = None
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
                "tags_raw UNINDEXED, id_text, title, aliases, tags, related, summary, headings, body, "
                f"tokenize='{_TOKENIZER}')"
            )
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5("
                "doc_id UNINDEXED, status UNINDEXED, type UNINDEXED, owner UNINDEXED, source UNINDEXED, "
                "tags_raw UNINDEXED, section UNINDEXED, anchor UNINDEXED, ordinal UNINDEXED, heading, text, "
                f"tokenize='{_TOKENIZER}')"
            )
            # Manifest: one row per indexed document — which source revision and file the index holds.
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS doc_versions (doc_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
                "revision TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, indexed_at TEXT NOT NULL, "
                "generation INTEGER NOT NULL)"
            )
            row = self._conn.execute("SELECT value FROM index_meta WHERE key='generation'").fetchone()
            self._generation = int(row[0]) if row else 0

    @staticmethod
    def _fingerprint(doc: DocumentRecord) -> str:
        # Everything that is indexed or filtered on; a new revision always changes it.
        return "|".join(
            (
                doc.source,
                doc.revision,
                doc.status.value,
                doc.type.value,
                doc.owner,
                ",".join(doc.tags),
                doc.path,  # a rename keeps the revision but must refresh the locator
            )
        )

    def _insert(self, doc: DocumentRecord) -> None:
        filters = (doc.id, doc.status.value, doc.type.value, doc.owner, doc.source)
        tags_raw = "|" + "|".join(doc.tags) + "|"
        self._conn.execute(
            "INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                *filters,
                tags_raw,
                doc.id,
                _clean(doc.title),
                _clean(" ; ".join(doc.aliases)),
                " ".join(doc.tags),
                " ".join(r.target for r in doc.relations),
                _clean(doc.summary or ""),
                _clean("\n".join(s.heading for s in doc.sections if s.heading)),
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

    @staticmethod
    def snapshot_checksum(snapshot: KnowledgeSnapshot) -> str:
        """Order-independent checksum of what the index must hold: ids, revisions, paths and edges.
        Equal for an incremental sync and a full rebuild of the same snapshot."""
        digest = hashlib.sha256()
        for doc in sorted(snapshot.documents.values(), key=lambda d: d.id.lower()):
            edges = ",".join(f"{r.type.value}>{r.target}" for r in doc.relations)
            digest.update(f"{doc.id}|{doc.revision}|{doc.path}|{doc.status.value}|{edges}\n".encode())
        return digest.hexdigest()[:16]

    def sync(self, snapshot: KnowledgeSnapshot, *, full: bool = False) -> IndexSyncResult:
        """Apply the snapshot to the index in ONE transaction (readers see the old or the new generation,
        never a mix). Incremental by fingerprint; `full` drops everything and re-indexes (repair).
        A failure rolls the transaction back and leaves the previous generation active."""
        started = time.perf_counter()
        rejected = [
            {"path": i.path, "code": i.code, "document_id": i.document_id or ""}
            for i in snapshot.issues
            if i.code not in ("symlink_skipped",)
        ]
        if snapshot.version == self._indexed_version and not full:
            return IndexSyncResult(  # no-op: the caller decides whether to report it
                generation=self._generation,
                applied=False,
                unchanged=self._doc_count,
                rejected=rejected,
                checksum=self._checksum,
                finished_at=datetime.now(UTC).isoformat(timespec="seconds"),
            )
        now = datetime.now(UTC).isoformat()
        checksum = self.snapshot_checksum(snapshot)
        with self._lock, self._conn:
            if full:
                self._conn.execute("DELETE FROM docs")
                self._conn.execute("DELETE FROM chunks")
                self._conn.execute("DELETE FROM doc_versions")
            indexed = {
                row[0]: (row[1], row[2], row[3])
                for row in self._conn.execute("SELECT doc_id, fingerprint, revision, path FROM doc_versions")
            }
            wanted = {doc.id: doc for doc in snapshot.documents.values()}
            removed = sorted(doc_id for doc_id in indexed if doc_id not in wanted)
            added: list[str] = []
            updated: list[str] = []
            renamed: list[str] = []
            changed: list[DocumentRecord] = []
            for doc_id, doc in sorted(wanted.items()):
                before = indexed.get(doc_id)
                if before is None:
                    added.append(doc_id)
                    changed.append(doc)
                elif before[0] != self._fingerprint(doc):
                    changed.append(doc)
                    if before[1] == doc.revision and before[2] != doc.path:
                        renamed.append(doc_id)
                    else:
                        updated.append(doc_id)
            for doc_id in [*removed, *(d.id for d in changed)]:
                self._conn.execute("DELETE FROM docs WHERE doc_id = ?", (doc_id,))
                self._conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
                self._conn.execute("DELETE FROM doc_versions WHERE doc_id = ?", (doc_id,))
            generation = self._generation + (
                1 if (changed or removed or full or self._generation == 0) else 0
            )
            for doc in changed:
                self._insert(doc)
                self._conn.execute(
                    "INSERT INTO doc_versions(doc_id, source, revision, path, fingerprint, indexed_at, generation) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (doc.id, doc.source, doc.revision, doc.path, self._fingerprint(doc), now, generation),
                )
            for key, value in (
                ("version", snapshot.version),
                ("indexed_at", now),
                ("generation", str(generation)),
                ("checksum", checksum),
            ):
                self._conn.execute(
                    "INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)", (key, value)
                )
        self._indexed_version = snapshot.version
        self._indexed_at = datetime.fromisoformat(now)
        self._doc_count = len(wanted)
        self._generation = generation
        self._checksum = checksum
        result = IndexSyncResult(
            generation=generation,
            applied=True,
            added=added,
            updated=updated,
            renamed=renamed,
            deleted=removed,
            unchanged=len(wanted) - len(changed),
            rejected=rejected,
            checksum=checksum,
            elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
            full_rebuild=full,
            finished_at=datetime.now(UTC).isoformat(timespec="seconds"),
        )
        self.last_result = result
        logger.info(
            "search index generation %d: %d document(s), +%d ~%d >%d -%d, %d rejected, %.1f ms",
            generation,
            self._doc_count,
            len(added),
            len(updated),
            len(renamed),
            len(removed),
            len(rejected),
            result.elapsed_ms,
        )
        return result

    @property
    def generation(self) -> int:
        return self._generation

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
        self,
        terms: list[QueryTerm],
        filters: SearchFilters,
        limit: int,
        *,
        mode: str = "and",
        snippets: bool = True,
    ) -> list[DocumentHit]:
        if not terms:
            return []
        match = fts_query(terms, mode=mode)
        where, params = self._filter_sql(filters, "docs")
        sql = (
            f"SELECT doc_id, bm25(docs, {_DOC_WEIGHTS}) AS score FROM docs "
            f"WHERE docs MATCH ?{where} ORDER BY score, doc_id LIMIT ?"
        )
        with self._lock:
            rows = self._conn.execute(sql, [match, *params, limit]).fetchall()
            found = self._snippets(terms, [r[0] for r in rows]) if snippets else {}
        hits: list[DocumentHit] = []
        for doc_id, score in rows:
            snip = found.get(doc_id)
            if snip is None:
                hits.append(DocumentHit(document_id=doc_id, score=round(-float(score), 4), excerpt=""))
            else:
                hits.append(replace(snip, score=round(-float(score), 4)))
        return hits

    def document_snippets(self, terms: list[QueryTerm], document_ids: list[str]) -> dict[str, DocumentHit]:
        if not terms or not document_ids:
            return {}
        with self._lock:
            return self._snippets(terms, document_ids)

    def _snippets(self, terms: list[QueryTerm], document_ids: list[str]) -> dict[str, DocumentHit]:
        """One query per document (only for the documents actually shown); caller holds the lock."""
        snippet_match = fts_query(terms, mode="or")
        found: dict[str, DocumentHit] = {}
        for doc_id in document_ids:
            chunk = self._conn.execute(
                f"SELECT section, anchor, snippet(chunks, {_CHUNK_TEXT_COL}, ?, ?, '…', 28) "
                f"FROM chunks WHERE chunks MATCH ? AND chunks.doc_id = ? "
                f"ORDER BY bm25(chunks, {_CHUNK_WEIGHTS}), CAST(ordinal AS INTEGER) LIMIT 1",
                (_HL_START, _HL_END, snippet_match, doc_id),
            ).fetchone()
            if chunk is None:
                continue
            section, anchor, snippet = chunk
            segments = segments_from_snippet(snippet)
            found[doc_id] = DocumentHit(
                document_id=doc_id,
                score=0.0,
                excerpt="".join(s.text for s in segments),
                segments=segments,
                section=section or None,
                section_anchor=anchor or None,
            )
        return found

    def search_chunks(
        self,
        terms: list[QueryTerm],
        filters: SearchFilters,
        limit: int,
        *,
        document_ids: list[str] | None = None,
    ) -> list[ChunkHit]:
        if not terms or (document_ids is not None and not document_ids):
            return []
        where, params = self._filter_sql(filters, "chunks")
        if document_ids is not None:
            where += f" AND chunks.doc_id IN ({', '.join('?' for _ in document_ids)})"
            params = [*params, *document_ids]
        sql = (
            f"SELECT doc_id, section, anchor, text, bm25(chunks, {_CHUNK_WEIGHTS}) AS score, "
            f"CAST(ordinal AS INTEGER) FROM chunks "
            f"WHERE chunks MATCH ?{where} ORDER BY score, doc_id, CAST(ordinal AS INTEGER) LIMIT ?"
        )
        with self._lock:
            rows = self._conn.execute(sql, [fts_query(terms, mode="or"), *params, limit]).fetchall()
        return [
            ChunkHit(
                document_id=r[0],
                section=r[1],
                section_anchor=r[2],
                text=r[3],
                score=round(-float(r[4]), 4),
                ordinal=int(r[5]),
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
