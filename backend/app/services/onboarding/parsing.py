"""One staged file → its text, parser and diagnostics (M8). Markdown / text are decoded here; PDF and DOCX reuse the
assistant attachments extractors (zip-bomb guard, page / paragraph caps) and always carry a «check the text»
diagnostic — extracted text of a PDF is never presented as reliable. A parser that cannot be imported makes the file
`unsupported`, never a fake «parsed»."""

from __future__ import annotations

import importlib.util
import unicodedata
from dataclasses import dataclass, field

from app.domain.onboarding import Diagnostic, ParseStatus
from app.services.attachments import AttachmentLimits, extract, looks_executable

TEXT_FORMATS = {".md": "markdown", ".markdown": "markdown", ".txt": "text"}
BINARY_FORMATS = {".pdf": "pdf", ".docx": "docx"}
MEDIA_TYPES = {
    "markdown": "text/markdown",
    "text": "text/plain",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_PARSER_MODULE = {"pdf": "pypdf", "docx": "docx"}


@dataclass
class Parsed:
    parser: str  # markdown | text | pdf | docx | none
    media_type: str
    status: ParseStatus  # parsed | invalid | unsupported
    text: str = ""
    diagnostics: list[Diagnostic] = field(default_factory=list)


def parser_available(kind: str) -> bool:
    module = _PARSER_MODULE.get(kind)
    return module is None or importlib.util.find_spec(module) is not None


def extension(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return ("." + name.rsplit(".", 1)[-1].casefold()) if "." in name else ""


def _diag(severity: str, code: str, message: str) -> Diagnostic:
    return Diagnostic(severity=severity, code=code, message=message)


def _decode(data: bytes) -> tuple[str | None, list[Diagnostic]]:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return data.decode("utf-16"), [
                _diag("info", "encoding_utf16", "Кодировка UTF-16 — текст перекодирован.")
            ]
        except UnicodeDecodeError:
            return None, [_diag("error", "encoding_error", "Файл в UTF-16 повреждён.")]
    if b"\x00" in data[:8192]:
        return None, [_diag("error", "binary_content", "Двоичные данные под текстовым расширением.")]
    try:
        return data.decode("utf-8-sig"), []
    except UnicodeDecodeError:
        pass
    try:
        text = data.decode("cp1251")
    except UnicodeDecodeError:
        return None, [
            _diag("error", "encoding_error", "Не удалось определить кодировку: сохраните файл в UTF-8.")
        ]
    return text, [
        _diag("warning", "encoding_guessed", "Файл не в UTF-8: прочитан как Windows-1251 — проверьте текст.")
    ]


def normalize_text(text: str) -> str:
    return unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n")).strip("﻿")


def parse_file(path: str, data: bytes, limits: AttachmentLimits) -> Parsed:
    ext = extension(path)
    if looks_executable(data):
        return Parsed(
            "none",
            "application/octet-stream",
            "invalid",
            diagnostics=[
                _diag("error", "executable_content", "Похоже на исполняемый файл: не импортируется.")
            ],
        )
    if ext in TEXT_FORMATS:
        kind = TEXT_FORMATS[ext]
        text, diagnostics = _decode(data)
        if text is None:
            return Parsed(kind, MEDIA_TYPES[kind], "invalid", diagnostics=diagnostics)
        text = normalize_text(text)
        if not text.strip():
            return Parsed(
                kind, MEDIA_TYPES[kind], "invalid", diagnostics=[_diag("error", "empty_file", "Файл пуст.")]
            )
        if kind == "text":
            diagnostics.append(
                _diag("info", "plain_text", "Простой текст: оформление Markdown не распознаётся.")
            )
        return Parsed(kind, MEDIA_TYPES[kind], "parsed", text=text, diagnostics=diagnostics)
    if ext in BINARY_FORMATS:
        kind = BINARY_FORMATS[ext]
        if not parser_available(kind):
            return Parsed(
                kind,
                MEDIA_TYPES[kind],
                "unsupported",
                diagnostics=[
                    _diag(
                        "error", "parser_unavailable", f"Разбор {kind.upper()} недоступен в этой установке."
                    )
                ],
            )
        try:
            extracted = extract(kind, data, limits)  # type: ignore[arg-type]
        except Exception:  # the extractor raises its own refusal type; the content is never logged
            return Parsed(
                kind,
                MEDIA_TYPES[kind],
                "invalid",
                diagnostics=[
                    _diag(
                        "error",
                        "parse_failed",
                        f"Не удалось извлечь текст из {kind.upper()}: файл повреждён или защищён.",
                    )
                ],
            )
        text = normalize_text("\n".join(u.text for u in extracted.units if u.text.strip()))
        if not text.strip():
            return Parsed(
                kind,
                MEDIA_TYPES[kind],
                "invalid",
                diagnostics=[
                    _diag("error", "no_text", f"В {kind.upper()} нет извлекаемого текста (например, скан).")
                ],
            )
        diagnostics = [
            _diag(
                "warning",
                "extracted_text",
                f"Текст извлечён из {kind.upper()} ({extracted.summary}): структура, таблицы и формулы могут "
                "потеряться — проверьте текст перед созданием черновика.",
            )
        ]
        if extracted.truncated:
            diagnostics.append(
                _diag("warning", "truncated", "Извлечена только часть текста (ограничение объёма).")
            )
        return Parsed(kind, MEDIA_TYPES[kind], "parsed", text=text, diagnostics=diagnostics)
    return Parsed(
        "none",
        "application/octet-stream",
        "unsupported",
        diagnostics=[
            _diag(
                "error",
                "unsupported_format",
                f"Формат «{ext or 'без расширения'}» не поддерживается: md, markdown, txt, pdf, docx.",
            )
        ],
    )
