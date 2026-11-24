"""Bounded `multipart/form-data` reader on python-multipart's streaming parser.

FastAPI's `UploadFile` / `Form` are not used on purpose: Starlette spools file parts to a temporary file and does
not cap a file's size. Here the request stream is fed chunk by chunk into `python_multipart.MultipartParser`, and
a HARD byte cap is checked BEFORE each chunk is parsed: a larger body is cut at the cap and the rest is never
read. Parts are collected in memory only — nothing is written to disk, the client's file name is a display value
and part contents are never logged (the parser's own warnings quote body bytes, so its logger is silenced, and
its error texts are never passed on).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from python_multipart import MultipartParser
from python_multipart.exceptions import FormParserError
from python_multipart.multipart import parse_options_header
from starlette.requests import Request

if TYPE_CHECKING:
    from python_multipart.multipart import MultipartCallbacks

MAX_HEADER_BYTES = 8 * 1024  # one header line of a part
MAX_HEADER_COUNT = 8  # headers of one part
PREFIX_BYTES = 64 * 1024  # what is read of a body whose declared length is already over the cap

# python-multipart logs parse problems with the offending byte of the body; nothing of a body is logged here.
logging.getLogger("python_multipart").setLevel(logging.CRITICAL)


class MultipartError(ValueError):
    """The body is not a well-formed multipart/form-data payload."""


@dataclass(frozen=True)
class FormPart:
    name: str
    filename: str | None
    content_type: str  # "" when the part did not declare one
    data: bytes


@dataclass(frozen=True)
class FormData:
    parts: list[FormPart] = field(default_factory=list)
    # The body exceeded the cap: only the parts completed before the cut are in `parts`; `partial` is the part
    # that was cut (its headers are known, its data is incomplete).
    truncated: bool = False
    partial: FormPart | None = None
    declared_length: int | None = None

    def field(self, name: str) -> str | None:
        part = next((p for p in self.parts if p.name == name and p.filename is None), None)
        if part is None:
            return None
        return part.data.decode("utf-8", errors="replace")

    def file(self, name: str) -> FormPart | None:
        return next((p for p in self.parts if p.name == name and p.filename is not None), None)


def boundary_of(content_type: str) -> bytes:
    media_type, params = parse_options_header(content_type)
    if media_type != b"multipart/form-data":
        raise MultipartError("Ожидается multipart/form-data.")
    boundary = params.get(b"boundary", b"")
    if not 1 <= len(boundary) <= 70 or not boundary.isascii():
        raise MultipartError("Некорректная граница multipart.")
    return boundary


class _PartBuilder:
    """Headers and data of the part being read."""

    def __init__(self) -> None:
        self.headers: dict[str, bytes] = {}  # raw values: parameters are decoded as UTF-8 after parsing
        self.header_name = bytearray()
        self.header_value = bytearray()
        self.data = bytearray()
        self.headers_done = False

    def end_header(self) -> None:
        name = self.header_name.decode("latin-1").strip().lower()
        self.headers[name] = bytes(self.header_value).strip()
        self.header_name.clear()
        self.header_value.clear()

    def build(self) -> FormPart:
        # Bytes in, bytes out (latin-1 round trip); browsers send the file name as raw UTF-8 (RFC 7578 §4.2).
        disposition, params = parse_options_header(self.headers.get("content-disposition", b""))
        if disposition != b"form-data":
            raise MultipartError("Часть multipart без Content-Disposition: form-data.")
        name = params.get(b"name", b"").decode("utf-8", errors="replace")
        if not name:
            raise MultipartError("Часть multipart без имени поля.")
        raw_filename = params.get(b"filename")
        content_type = self.headers.get("content-type", b"")
        return FormPart(
            name=name,
            filename=raw_filename.decode("utf-8", errors="replace") if raw_filename is not None else None,
            content_type=parse_options_header(content_type)[0].decode("latin-1") if content_type else "",
            data=bytes(self.data),
        )


class FormReader:
    """Feeds body chunks to the streaming parser under a byte cap. `feed` returns False once the cap is reached
    (stop reading: the body is `truncated`); `result` returns the parts, or raises `MultipartError`."""

    def __init__(
        self,
        content_type: str,
        *,
        max_bytes: int,
        declared_length: int | None = None,
        max_parts: int = 8,
    ) -> None:
        # A body already declared too large is read only far enough to find the small fields and the file name.
        self._limit = (
            PREFIX_BYTES if declared_length is not None and declared_length > max_bytes else max_bytes
        )
        self._declared = declared_length
        self._max_parts = max_parts
        self._received = 0
        self._truncated = False
        self._ended = False
        self._parts: list[FormPart] = []
        self._current: _PartBuilder | None = None
        callbacks: MultipartCallbacks = {
            "on_part_begin": self._part_begin,
            "on_header_field": self._header_field,
            "on_header_value": self._header_value,
            "on_header_end": self._header_end,
            "on_headers_finished": self._headers_finished,
            "on_part_data": self._part_data,
            "on_part_end": self._part_end,
            "on_end": self._end,
        }
        self._parser = MultipartParser(
            boundary_of(content_type),
            callbacks,
            max_size=self._limit,
            max_header_count=MAX_HEADER_COUNT,
            max_header_size=MAX_HEADER_BYTES,
        )

    # --- parser callbacks (an exception raised here stops `write`) -----------------------------------------
    def _part(self) -> _PartBuilder:
        if self._current is None:  # the parser always begins a part first
            raise MultipartError("Повреждённая часть multipart.")
        return self._current

    def _part_begin(self) -> None:
        if len(self._parts) >= self._max_parts:
            raise MultipartError("Слишком много частей multipart.")
        self._current = _PartBuilder()

    def _header_field(self, data: bytes, start: int, end: int) -> None:
        self._part().header_name.extend(data[start:end])

    def _header_value(self, data: bytes, start: int, end: int) -> None:
        self._part().header_value.extend(data[start:end])

    def _header_end(self) -> None:
        self._part().end_header()

    def _headers_finished(self) -> None:
        part = self._part()
        part.headers_done = True
        part.build()  # checks the headers before the data streams in

    def _part_data(self, data: bytes, start: int, end: int) -> None:
        self._part().data.extend(data[start:end])

    def _part_end(self) -> None:
        self._parts.append(self._part().build())
        self._current = None

    def _end(self) -> None:
        self._ended = True

    # --- reading ---------------------------------------------------------------------------------------------
    def feed(self, chunk: bytes) -> bool:
        if self._truncated or not chunk:
            return not self._truncated
        room = self._limit - self._received
        if len(chunk) > room:
            chunk = chunk[:room]
            self._truncated = True
        self._received += len(chunk)
        try:
            self._parser.write(chunk)
        except FormParserError as exc:  # the parser's text quotes body bytes: never passed on
            raise MultipartError("Повреждённое тело multipart.") from exc
        return not self._truncated

    def result(self) -> FormData:
        if self._truncated:
            current = self._current
            partial = current.build() if current is not None and current.headers_done else None
            return FormData(
                parts=list(self._parts), truncated=True, partial=partial, declared_length=self._declared
            )
        self._parser.finalize()
        if not self._ended:
            if not self._parts and self._current is None:
                raise MultipartError("В теле нет ни одной части multipart.")
            raise MultipartError("Нет завершающей границы multipart.")
        return FormData(parts=list(self._parts), declared_length=self._declared)


async def read_form(request: Request, *, max_bytes: int, max_parts: int = 8) -> FormData:
    """Read at most `max_bytes` of the body while parsing it. A larger body is not read to the end: the result
    is `truncated` (the caller reports `too_large`), with the parts that fit before the cut."""
    raw_length = request.headers.get("content-length", "")
    reader = FormReader(
        request.headers.get("content-type", ""),
        max_bytes=max_bytes,
        declared_length=int(raw_length) if raw_length.isdigit() else None,
        max_parts=max_parts,
    )
    async for chunk in request.stream():
        if not reader.feed(chunk):
            break
    return reader.result()
