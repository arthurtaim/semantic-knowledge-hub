"""Bounded `multipart/form-data` reader built on the standard library only.

`python-multipart` is not a dependency, so FastAPI's `UploadFile` / `Form` are not used. This module is the
single place to swap for it later: `read_form` reads the request stream with a HARD byte cap BEFORE anything is
parsed, splits the parts on the boundary as bytes (binary-safe) and hands only the part headers to the stdlib
`email` header parser. Nothing is written to disk and part contents are never logged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from email.parser import HeaderParser
from email.policy import HTTP

from starlette.requests import Request

MAX_HEADER_BYTES = 8 * 1024  # headers of one part
PREFIX_BYTES = 64 * 1024  # what is read of a body whose declared length is already over the cap


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
    message = HeaderParser(policy=HTTP).parsestr(f"Content-Type: {content_type}\r\n\r\n")
    if message.get_content_type() != "multipart/form-data":
        raise MultipartError("Ожидается multipart/form-data.")
    boundary = message.get_param("boundary")
    if not isinstance(boundary, str) or not 1 <= len(boundary) <= 70 or not boundary.isascii():
        raise MultipartError("Некорректная граница multipart.")
    return boundary.encode("ascii")


def _part(header_block: bytes, data: bytes) -> FormPart:
    if len(header_block) > MAX_HEADER_BYTES:
        raise MultipartError("Слишком длинные заголовки части multipart.")
    headers = HeaderParser(policy=HTTP).parsestr(header_block.decode("utf-8", errors="replace"))
    if headers.get_content_disposition() != "form-data":
        raise MultipartError("Часть multipart без Content-Disposition: form-data.")
    name = headers.get_param("name", header="content-disposition")
    if not isinstance(name, str) or not name:
        raise MultipartError("Часть multipart без имени поля.")
    filename = headers.get_filename()
    content_type = headers.get_content_type() if headers.get("content-type") else ""
    return FormPart(name=name, filename=filename, content_type=content_type, data=data)


def parse_parts(
    body: bytes, boundary: bytes, *, complete: bool, max_parts: int = 8
) -> tuple[list[FormPart], FormPart | None]:
    """Split a (possibly truncated) body into parts. Returns the complete parts and the part that was cut
    (only when `complete` is False and its headers were fully received)."""
    segments = (b"\r\n" + body).split(b"\r\n--" + boundary)
    if len(segments) < 2:
        raise MultipartError("В теле нет ни одной части multipart.")
    parts: list[FormPart] = []
    closed = False
    for index, segment in enumerate(segments[1:], start=1):
        last = index == len(segments) - 1
        if segment.startswith(b"--"):
            closed = True
            break
        line_end = segment.find(b"\r\n")
        head_end = segment.find(b"\r\n\r\n", max(line_end, 0))
        if line_end < 0 or segment[:line_end].strip(b" \t") or head_end < 0:
            if last and not complete:
                return parts, None  # the cut fell inside this part's headers
            raise MultipartError("Повреждённая часть multipart.")
        part = _part(segment[line_end + 2 : head_end + 4], segment[head_end + 4 :])
        if last and not complete:
            return parts, part
        parts.append(part)
        if len(parts) > max_parts:
            raise MultipartError("Слишком много частей multipart.")
    if not closed:
        raise MultipartError("Нет завершающей границы multipart.")
    return parts, None


async def read_form(request: Request, *, max_bytes: int, max_parts: int = 8) -> FormData:
    """Read at most `max_bytes` of the body, then parse it. A larger body is not read to the end: the result is
    `truncated` (the caller reports `too_large`), with the parts that fit before the cut."""
    boundary = boundary_of(request.headers.get("content-type", ""))
    raw_length = request.headers.get("content-length", "")
    declared = int(raw_length) if raw_length.isdigit() else None
    # A body already declared too large is read only far enough to find the small fields and the file name.
    limit = PREFIX_BYTES if declared is not None and declared > max_bytes else max_bytes
    body = bytearray()
    truncated = False
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            truncated = True
            del body[limit:]
            break
    parts, partial = parse_parts(bytes(body), boundary, complete=not truncated, max_parts=max_parts)
    return FormData(parts=parts, truncated=truncated, partial=partial, declared_length=declared)
