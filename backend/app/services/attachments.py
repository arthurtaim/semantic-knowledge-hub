"""Assistant attachments (UI v2, docs/ui-v2/specs/02_ASSISTANT.md §3): files a user attaches to ONE conversation.

    upload (bounded multipart) -> type by extension AND content (executables refused) -> limits
      -> text extraction in a worker thread with a deadline (zip-bomb guard for docx/xlsx)
      -> extracted text stored per (user, conversation) in the app-state SQLite, with an expiry
    ask -> fragments of the attachment become a SEPARATE evidence group (source_type "attachment")

Only the extracted text is kept, never the original bytes; the user's file name never touches the filesystem;
file contents are never logged. Attachments are not indexed into the knowledge-base search, the graph or the
discovery memory, and they are visible only inside their conversation (and only to their uploader).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import re
import sqlite3
import threading
import time
import unicodedata
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from app.domain.models import ATTACHMENT_ID_PATTERN, CONVERSATION_ID_PATTERN, UserContext
from app.domain.text import strip_control, term_matches_text, tokenize
from app.errors import ApiError

logger = logging.getLogger("skh.attachments")

AttachmentKind = Literal["md", "txt", "csv", "json", "yaml", "sql", "pdf", "docx", "xlsx"]
AttachmentStatus = Literal["ready", "error"]
AttachmentErrorCode = Literal["unsupported_type", "too_large", "limit_reached", "unreadable"]
UnitKind = Literal["line", "page", "paragraph", "row"]

MIB = 1024 * 1024
EXTENSIONS: dict[str, AttachmentKind] = {
    "md": "md",
    "markdown": "md",
    "txt": "txt",
    "csv": "csv",
    "json": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "sql": "sql",
    "pdf": "pdf",
    "docx": "docx",
    "xlsx": "xlsx",
}
TEXT_KINDS: frozenset[AttachmentKind] = frozenset({"md", "txt", "csv", "json", "yaml", "sql"})
MIME_TYPES: dict[AttachmentKind, str] = {
    "md": "text/markdown",
    "txt": "text/plain",
    "csv": "text/csv",
    "json": "application/json",
    "yaml": "application/yaml",
    "sql": "application/sql",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
# Magic numbers of executables: PE/DOS (checked together with binary header bytes), ELF, Mach-O (32/64, both
# byte orders), universal binaries / Java classes, WebAssembly; plus scripts with a shebang.
_EXECUTABLE_MAGIC = (
    b"\x7fELF",
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\x00asm",
)
_EXECUTABLE_EXTENSIONS = frozenset(
    {"exe", "dll", "com", "scr", "msi", "bat", "cmd", "ps1", "sh", "vbs", "js", "jar", "app", "so", "dylib"}
)
_MIME_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$")
_CONVERSATION_RE = re.compile(CONVERSATION_ID_PATTERN)
_ATTACHMENT_RE = re.compile(ATTACHMENT_ID_PATTERN)


@dataclass(frozen=True)
class AttachmentLimits:
    files_per_conversation: int = 10
    files_per_user: int = 100  # ready attachments over all conversations (bounds the stored text)
    file_bytes: int = 20 * MIB
    text_chars: int = 300_000
    units: int = 50_000  # lines / rows / paragraphs kept
    pdf_pages: int = 500
    sheets: int = 50
    cell_chars: int = 2_000
    name_chars: int = 120
    zip_entries: int = 2_000
    zip_entry_bytes: int = 100 * MIB
    zip_total_bytes: int = 200 * MIB
    zip_ratio: int = 300  # compression ratio allowed for entries larger than 10 MiB
    extract_seconds: float = 20.0
    # Assistant context taken from attachments for one answer (a separate budget from the team documents).
    context_chars: int = 4_000
    passages_per_file: int = 3
    passage_chars: int = 1_500


@dataclass(frozen=True)
class Unit:
    """One line / page line / paragraph / table row of extracted text with its human locator parts."""

    scope: str  # "" | "лист Fields" | "таблица 1"
    kind: UnitKind
    n: int
    text: str


@dataclass
class Extracted:
    units: list[Unit]
    summary: str
    truncated: bool = False


class _Rejected(Exception):
    """Internal control flow: a file is not accepted; carries the public error code."""

    def __init__(self, code: AttachmentErrorCode) -> None:
        super().__init__(code)
        self.code: AttachmentErrorCode = code


class AttachmentInfo(BaseModel):
    """API shape of an attachment (POST /api/assistant/attachments)."""

    id: str
    conversation_id: str
    name: str
    size: int
    mime: str
    status: AttachmentStatus
    summary: str | None = None  # «3 листа», «12 страниц», «1 240 строк»
    error_code: AttachmentErrorCode | None = None
    expires_at: datetime | None = None  # null for an error result: nothing was stored


@dataclass(frozen=True)
class StoredAttachment:
    id: str
    conversation_id: str
    name: str
    kind: AttachmentKind
    size: int
    mime: str
    summary: str
    units: tuple[Unit, ...]
    content_hash: str
    expires_at: float


@dataclass(frozen=True)
class AttachmentFragment:
    """A window of consecutive units handed to the assistant as one passage."""

    attachment: StoredAttachment
    units: tuple[Unit, ...] = field(default_factory=tuple)


# --- Russian plurals and grouped numbers --------------------------------------------------------------------

LINES = ("строка", "строки", "строк")
PAGES = ("страница", "страницы", "страниц")
SHEETS = ("лист", "листа", "листов")
PARAGRAPHS = ("абзац", "абзаца", "абзацев")
TABLES = ("таблица", "таблицы", "таблиц")


def group_thousands(n: int) -> str:
    """1240 → «1 240» (no-break space as the group separator, so the number never wraps)."""
    return f"{n:,}".replace(",", " ")


def ru_count(n: int, forms: tuple[str, str, str]) -> str:
    """«1 строка», «3 листа», «12 страниц», «1 240 строк», «21 абзац»."""
    tens, units = abs(n) % 100, abs(n) % 10
    if 10 < tens < 20:
        form = forms[2]
    elif units == 1:
        form = forms[0]
    elif 2 <= units <= 4:
        form = forms[1]
    else:
        form = forms[2]
    return f"{group_thousands(n)} {form}"


_SINGULAR = {"line": "строка", "page": "стр.", "paragraph": "абзац", "row": "строка"}
_PLURAL = {"line": "строки", "page": "стр.", "paragraph": "абзацы", "row": "строки"}


def format_locator(first: Unit, last: Unit | None = None) -> str:
    """«строка 1», «стр. 4», «лист Fields, строка 12», ranges «строки 3–5»."""
    if last is None or last.n == first.n or last.scope != first.scope or last.kind != first.kind:
        label = f"{_SINGULAR[first.kind]} {first.n}"
    else:
        label = f"{_PLURAL[first.kind]} {first.n}–{last.n}"
    return f"{first.scope}, {label}" if first.scope else label


# --- names, types and content checks ------------------------------------------------------------------------


def sanitize_name(raw: str | None, limit: int = 120) -> str:
    """A display name only (never a path): last path segment, no control or bidi characters, bounded."""
    name = unicodedata.normalize("NFC", raw or "")
    name = re.split(r"[\\/]", name)[-1]
    name = "".join(ch for ch in name if unicodedata.category(ch)[0] != "C")
    name = " ".join(name.split()).strip(" .")
    if not name:
        return "файл"
    if len(name) > limit:
        stem, dot, ext = name.rpartition(".")
        if dot and 0 < len(ext) <= 10:
            name = stem[: limit - len(ext) - 2].rstrip() + "…." + ext
        else:
            name = name[: limit - 1].rstrip() + "…"
    return name


def extension_of(name: str) -> str:
    _, dot, ext = name.rpartition(".")
    return ext.casefold() if dot else ""


def looks_executable(data: bytes) -> bool:
    head = data[:64]
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    if head.startswith(b"#!"):
        return True
    if head.startswith(b"MZ") and b"\x00" in head:  # DOS/PE header (a text line "MZ…" has no NUL bytes)
        return True
    return any(head.startswith(magic) for magic in _EXECUTABLE_MAGIC)


def _declared_mime(content_type: str) -> str:
    value = content_type.strip().casefold()
    return value if _MIME_RE.match(value) else "application/octet-stream"


def _decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError as exc:
            raise _Rejected("unreadable") from exc
    if b"\x00" in data[:8192]:
        raise _Rejected("unreadable")  # binary content under a text extension
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("cp1251")  # common for Russian CSV exports
    except UnicodeDecodeError as exc:
        raise _Rejected("unreadable") from exc


class _Collector:
    """Accumulates units within the text / unit budget."""

    def __init__(self, limits: AttachmentLimits) -> None:
        self.limits = limits
        self.units: list[Unit] = []
        self.chars = 0
        self.truncated = False

    @property
    def full(self) -> bool:
        return self.truncated

    def add(self, scope: str, kind: UnitKind, n: int, text: str) -> None:
        # One unit is one line of the stored text (a paragraph's soft line breaks become spaces).
        text = strip_control(text).replace("\n", " ").strip()
        if not text or self.truncated:
            return
        if len(self.units) >= self.limits.units or self.chars + len(text) > self.limits.text_chars:
            self.truncated = True
            return
        self.units.append(Unit(scope, kind, n, text))
        self.chars += len(text)


def _extract_text(data: bytes, limits: AttachmentLimits) -> Extracted:
    text = _decode_text(data).replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    out = _Collector(limits)
    for number, line in enumerate(lines, start=1):
        out.add("", "line", number, line)
        if out.full:
            break
    return Extracted(out.units, ru_count(len(lines), LINES), out.truncated)


def _guard_zip(data: bytes, limits: AttachmentLimits) -> None:
    """docx/xlsx are zip archives: refuse decompression bombs and archives carrying macros or executables
    before any parser opens them."""
    if not data.startswith(b"PK\x03\x04"):
        raise _Rejected("unreadable")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError) as exc:
        raise _Rejected("unreadable") from exc
    with archive:
        entries = archive.infolist()
        if len(entries) > limits.zip_entries:
            raise _Rejected("unreadable")
        total = 0
        for entry in entries:
            name = entry.filename.casefold()
            if name.endswith("vbaproject.bin") or extension_of(name) in _EXECUTABLE_EXTENSIONS:
                raise _Rejected("unsupported_type")
            total += entry.file_size
            if entry.file_size > limits.zip_entry_bytes or total > limits.zip_total_bytes:
                raise _Rejected("unreadable")
            if (
                entry.file_size > 10 * MIB
                and entry.compress_size
                and entry.file_size / entry.compress_size > limits.zip_ratio
            ):
                raise _Rejected("unreadable")


def _extract_pdf(data: bytes, limits: AttachmentLimits) -> Extracted:
    if b"%PDF-" not in data[:1024]:
        raise _Rejected("unreadable")
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted and not reader.decrypt(""):
        raise _Rejected("unreadable")
    pages = len(reader.pages)
    out = _Collector(limits)
    for index in range(min(pages, limits.pdf_pages)):
        text = reader.pages[index].extract_text() or ""
        for line in text.split("\n"):
            out.add("", "page", index + 1, line)
        if out.full:
            break
    if not out.units:
        raise _Rejected("unreadable")  # e.g. a scan without a text layer
    return Extracted(out.units, ru_count(pages, PAGES), out.truncated or pages > limits.pdf_pages)


def _extract_docx(data: bytes, limits: AttachmentLimits) -> Extracted:
    _guard_zip(data, limits)
    from docx import Document
    from docx.table import Table

    document = Document(io.BytesIO(data))
    out = _Collector(limits)
    paragraphs = tables = 0
    for block in document.iter_inner_content():
        if isinstance(block, Table):
            tables += 1
            for row_number, row in enumerate(block.rows, start=1):
                cells: list[str] = []
                for cell in row.cells:  # merged cells repeat: keep each text once per row
                    value = " ".join(cell.text.split())
                    if value and (not cells or cells[-1] != value):
                        cells.append(value[: limits.cell_chars])
                out.add(f"таблица {tables}", "row", row_number, " | ".join(cells))
        else:
            if block.text.strip():
                paragraphs += 1
                out.add("", "paragraph", paragraphs, block.text)
        if out.full:
            break
    if not out.units:
        raise _Rejected("unreadable")
    summary = ru_count(paragraphs, PARAGRAPHS) + (f", {ru_count(tables, TABLES)}" if tables else "")
    return Extracted(out.units, summary, out.truncated)


def _cell_text(value: Any, limit: int) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if hasattr(value, "isoformat"):
        return str(value.isoformat())
    return " ".join(str(value).split())[:limit]


def _extract_xlsx(data: bytes, limits: AttachmentLimits) -> Extracted:
    _guard_zip(data, limits)
    from openpyxl import load_workbook  # type: ignore[import-untyped]  # no stubs; not a dependency to add

    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
    try:
        sheet_count = len(workbook.sheetnames)
        out = _Collector(limits)
        for sheet in workbook.worksheets[: limits.sheets]:
            scope = "лист " + sanitize_name(str(sheet.title), 60)
            for row_number, row in enumerate(sheet.iter_rows(values_only=True), start=1):
                values = [_cell_text(v, limits.cell_chars) for v in row]
                while values and not values[-1]:
                    values.pop()
                if any(values):
                    out.add(scope, "row", row_number, " | ".join(values))
                if out.full:
                    break
            if out.full:
                break
    finally:
        workbook.close()
    if not out.units:
        raise _Rejected("unreadable")
    return Extracted(out.units, ru_count(sheet_count, SHEETS), out.truncated or sheet_count > limits.sheets)


def extract(kind: AttachmentKind, data: bytes, limits: AttachmentLimits) -> Extracted:
    """Text of a file of a supported kind. Raises _Rejected; any parser failure is `unreadable`."""
    try:
        if kind in TEXT_KINDS:
            return _extract_text(data, limits)
        if kind == "pdf":
            return _extract_pdf(data, limits)
        if kind == "docx":
            return _extract_docx(data, limits)
        return _extract_xlsx(data, limits)
    except _Rejected:
        raise
    except Exception as exc:  # parsers raise many types; the content is never logged
        logger.info("attachment unreadable kind=%s error=%s", kind, type(exc).__name__)
        raise _Rejected("unreadable") from exc


# --- storage ---------------------------------------------------------------------------------------------------


class AttachmentStore:
    """Extracted text per (actor, conversation) in the app-state SQLite; expired rows are purged on access."""

    def __init__(self, path: Path | str) -> None:
        self._lock = threading.Lock()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        with self._conn:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS assistant_attachments (id TEXT PRIMARY KEY, actor TEXT NOT NULL, "
                "conversation_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, "
                "mime TEXT NOT NULL, summary TEXT NOT NULL, units_json TEXT NOT NULL, content_hash TEXT NOT NULL, "
                "created_ts REAL NOT NULL, expires_ts REAL NOT NULL)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS assistant_attachments_conv "
                "ON assistant_attachments (actor, conversation_id)"
            )

    def purge(self, now: float) -> int:
        with self._lock, self._conn:
            return self._conn.execute(
                "DELETE FROM assistant_attachments WHERE expires_ts <= ?", (now,)
            ).rowcount

    def insert_if_room(
        self, actor: str, item: StoredAttachment, created: float, per_conversation: int, per_user: int
    ) -> bool:
        """Count and insert atomically, so concurrent uploads cannot exceed the limits."""
        units = json.dumps([[u.scope, u.kind, u.n, u.text] for u in item.units], ensure_ascii=False)
        with self._lock, self._conn:
            in_conversation, for_user = self._conn.execute(
                "SELECT SUM(conversation_id = ?), COUNT(*) FROM assistant_attachments WHERE actor = ?",
                (item.conversation_id, actor),
            ).fetchone()
            if (in_conversation or 0) >= per_conversation or (for_user or 0) >= per_user:
                return False
            self._conn.execute(
                "INSERT INTO assistant_attachments (id, actor, conversation_id, name, kind, size, mime, summary, "
                "units_json, content_hash, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item.id,
                    actor,
                    item.conversation_id,
                    item.name,
                    item.kind,
                    item.size,
                    item.mime,
                    item.summary,
                    units,
                    item.content_hash,
                    created,
                    item.expires_at,
                ),
            )
            return True

    def count(self, actor: str, conversation_id: str) -> tuple[int, int]:
        with self._lock:
            in_conversation, for_user = self._conn.execute(
                "SELECT SUM(conversation_id = ?), COUNT(*) FROM assistant_attachments WHERE actor = ?",
                (conversation_id, actor),
            ).fetchone()
        return int(in_conversation or 0), int(for_user or 0)

    def get(
        self, actor: str, conversation_id: str, attachment_id: str, now: float
    ) -> StoredAttachment | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, conversation_id, name, kind, size, mime, summary, units_json, content_hash, expires_ts "
                "FROM assistant_attachments WHERE id = ? AND actor = ? AND conversation_id = ? AND expires_ts > ?",
                (attachment_id, actor, conversation_id, now),
            ).fetchone()
        if row is None:
            return None
        units = tuple(Unit(str(s), k, int(n), str(t)) for s, k, n, t in json.loads(row[7]))
        return StoredAttachment(
            id=row[0],
            conversation_id=row[1],
            name=row[2],
            kind=row[3],
            size=int(row[4]),
            mime=row[5],
            summary=row[6],
            units=units,
            content_hash=row[8],
            expires_at=float(row[9]),
        )

    def delete(self, actor: str, attachment_id: str) -> bool:
        with self._lock, self._conn:
            return (
                self._conn.execute(
                    "DELETE FROM assistant_attachments WHERE id = ? AND actor = ?", (attachment_id, actor)
                ).rowcount
                > 0
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()


# --- service ---------------------------------------------------------------------------------------------------


def _iso(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, UTC).replace(microsecond=0)


def new_attachment_id() -> str:
    return f"ATT-{uuid.uuid4().hex[:16]}"


def valid_conversation_id(value: str | None) -> bool:
    return bool(value) and _CONVERSATION_RE.match(value or "") is not None


class AttachmentService:
    def __init__(
        self,
        store: AttachmentStore,
        *,
        ttl_seconds: float,
        limits: AttachmentLimits | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self.ttl_seconds = ttl_seconds
        self.limits = limits or AttachmentLimits()
        self.clock = clock

    def _error(
        self, conversation_id: str, name: str, size: int, mime: str, code: AttachmentErrorCode
    ) -> AttachmentInfo:
        logger.info("attachment rejected code=%s size=%d", code, size)
        return AttachmentInfo(
            id=new_attachment_id(),
            conversation_id=conversation_id,
            name=name,
            size=size,
            mime=mime,
            status="error",
            error_code=code,
        )

    def too_large(
        self, conversation_id: str, filename: str | None, content_type: str, size: int
    ) -> AttachmentInfo:
        name = sanitize_name(filename, self.limits.name_chars)
        return self._error(conversation_id, name, size, _declared_mime(content_type), "too_large")

    async def upload(
        self, user: UserContext, conversation_id: str, filename: str | None, content_type: str, data: bytes
    ) -> AttachmentInfo:
        """Validate, extract and store one file. Every rejection is an `error` result (nothing stored)."""
        now = self.clock()
        self._store.purge(now)
        limits = self.limits
        name = sanitize_name(filename, limits.name_chars)
        size = len(data)
        kind = EXTENSIONS.get(extension_of(name))
        mime = MIME_TYPES[kind] if kind else _declared_mime(content_type)
        if size > limits.file_bytes:
            return self._error(conversation_id, name, size, mime, "too_large")
        if kind is None or looks_executable(data):
            return self._error(conversation_id, name, size, _declared_mime(content_type), "unsupported_type")
        in_conversation, for_user = self._store.count(user.user_id, conversation_id)
        if in_conversation >= limits.files_per_conversation or for_user >= limits.files_per_user:
            return self._error(conversation_id, name, size, mime, "limit_reached")
        if size == 0:
            return self._error(conversation_id, name, size, mime, "unreadable")
        try:
            extracted = await asyncio.wait_for(
                asyncio.to_thread(extract, kind, data, limits), timeout=limits.extract_seconds
            )
        except _Rejected as exc:
            return self._error(conversation_id, name, size, mime, exc.code)
        except TimeoutError:
            return self._error(conversation_id, name, size, mime, "unreadable")
        summary = extracted.summary + (", текст сокращён" if extracted.truncated else "")
        joined = "\n".join(u.text for u in extracted.units)
        item = StoredAttachment(
            id=new_attachment_id(),
            conversation_id=conversation_id,
            name=name,
            kind=kind,
            size=size,
            mime=mime,
            summary=summary,
            units=tuple(extracted.units),
            content_hash=hashlib.sha256(joined.encode("utf-8")).hexdigest(),
            expires_at=now + self.ttl_seconds,
        )
        if not self._store.insert_if_room(
            user.user_id, item, now, limits.files_per_conversation, limits.files_per_user
        ):
            return self._error(conversation_id, name, size, mime, "limit_reached")
        logger.info("attachment stored kind=%s size=%d units=%d", kind, size, len(item.units))
        return AttachmentInfo(
            id=item.id,
            conversation_id=conversation_id,
            name=name,
            size=size,
            mime=mime,
            status="ready",
            summary=summary,
            expires_at=_iso(item.expires_at),
        )

    def delete(self, user: UserContext, attachment_id: str) -> bool:
        self._store.purge(self.clock())
        return self._store.delete(user.user_id, attachment_id)

    def resolve(
        self, user: UserContext, conversation_id: str | None, attachment_ids: list[str]
    ) -> list[StoredAttachment]:
        """The caller's ready attachments of THIS conversation, in the requested order. Unknown, expired,
        deleted and foreign ids are indistinguishable on purpose: 404 attachment_not_found."""
        now = self.clock()
        self._store.purge(now)
        found: list[StoredAttachment] = []
        for attachment_id in dict.fromkeys(attachment_ids):
            item = (
                self._store.get(user.user_id, conversation_id, attachment_id, now)
                if conversation_id and _ATTACHMENT_RE.match(attachment_id)
                else None
            )
            if item is None:
                raise ApiError(
                    404,
                    "attachment_not_found",
                    "Вложение не найдено в этом диалоге или срок его хранения истёк. Прикрепите файл заново.",
                    {"attachment_id": attachment_id},
                )
            found.append(item)
        return found

    def close(self) -> None:
        self._store.close()


# --- fragments for one answer ----------------------------------------------------------------------------------


def head_text(attachment: StoredAttachment, max_chars: int = 300) -> str:
    """The first line / header row of the file (used to look for the same terms in the knowledge base)."""
    return attachment.units[0].text[:max_chars] if attachment.units else ""


def select_fragments(
    attachment: StoredAttachment,
    terms: list[Any],
    *,
    max_passages: int,
    max_chars: int,
    passage_chars: int = 1_500,
) -> list[AttachmentFragment]:
    """Deterministic choice of what the assistant sees from one file: always the first unit (the header line),
    then windows around the units that contain the question terms; adjacent windows merge. `max_chars` bounds
    the file, `passage_chars` each fragment."""
    units = attachment.units
    if not units or max_chars <= 0:
        return []
    scores = [sum(1 for t in terms if term_matches_text(t, tokenize(u.text))) for u in units]
    ranked = sorted((i for i, s in enumerate(scores) if s > 0), key=lambda i: (-scores[i], i))
    windows: list[tuple[int, int]] = [(0, 0)]
    for index in ranked:
        if len(windows) >= max_passages:
            break
        windows.append((max(index - 1, 0), min(index + 1, len(units) - 1)))
    if len(windows) == 1:  # nothing matched (or no terms): the head of the file
        windows = [(0, len(units) - 1)]
    merged: list[list[int]] = []
    for start, end in sorted(windows):
        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    fragments: list[AttachmentFragment] = []
    budget = max_chars
    for start, end in merged[:max_passages]:
        chosen: list[Unit] = []
        used = 0
        for unit in units[start : end + 1]:
            if used + len(unit.text) > min(budget, passage_chars):
                break
            chosen.append(unit)
            used += len(unit.text) + 1
        if not chosen and budget > 0:  # one very long unit: keep its beginning
            first = units[start]
            chosen = [Unit(first.scope, first.kind, first.n, first.text[: min(budget, passage_chars) - 1])]
            used = len(chosen[0].text) + 1
        if chosen and chosen[0].text:
            fragments.append(AttachmentFragment(attachment, tuple(chosen)))
            budget -= used
        if budget <= 0:
            break
    return fragments
