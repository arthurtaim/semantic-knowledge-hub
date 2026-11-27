"""Untrusted upload → bounded in-memory files (M8, docs/KNOWLEDGE_ONBOARDING.md «Безопасность»).

Nothing is written to disk: a ZIP is read entry by entry with caps on the count, every size, the total expanded size
and the compression ratio; a path is a DISPLAY value checked for traversal (`..`, absolute, drive letters,
`%2e%2e`, backslashes), control characters, depth and Unicode confusable collisions. Symlinks, special files,
encrypted entries and nested archives are refused. A refused entry stays visible as a refused item (no silent
omission) but its bytes are never kept.
"""

from __future__ import annotations

import io
import stat
import unicodedata
import urllib.parse
import zipfile
from dataclasses import dataclass, field

from app.errors import ApiError

MIB = 1024 * 1024
MAX_DEPTH = 8
MAX_PATH_CHARS = 255
NESTED_ARCHIVES = (".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".jar")
_CHUNK = 64 * 1024


@dataclass(frozen=True)
class IngestLimits:
    upload_bytes: int = 20 * MIB
    expanded_bytes: int = 100 * MIB
    max_files: int = 200
    file_bytes: int = 10 * MIB
    max_ratio: int = 50


@dataclass(frozen=True)
class IncomingFile:
    path: str  # the safe display path (NFC, «/»-separated); never a filesystem destination
    data: bytes | None  # None: refused (see `refused`)
    refused: str | None = None  # error code of a refused entry
    refused_message: str | None = None


@dataclass
class Ingested:
    source_kind: str
    files: list[IncomingFile] = field(default_factory=list)

    @property
    def bytes_total(self) -> int:
        return sum(len(f.data) for f in self.files if f.data is not None)


def _refuse(path: str, code: str, message: str) -> IncomingFile:
    return IncomingFile(path=path, data=None, refused=code, refused_message=message)


def display_path(raw: str) -> str:
    """A readable, bounded label of an untrusted name (never used as a filesystem path)."""
    text = "".join(ch if ch.isprintable() else "?" for ch in unicodedata.normalize("NFC", raw))
    return text[:MAX_PATH_CHARS] or "без имени"


def safe_path(raw: str) -> tuple[str | None, str | None]:
    """(normalized path, None) or (None, refusal message). The path is relative, «/»-separated, NFC."""
    if not raw or not raw.strip():
        return None, "Пустое имя файла."
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw):
        return None, "Имя содержит управляющие символы."
    decoded = urllib.parse.unquote(raw)
    candidate = unicodedata.normalize("NFC", decoded).replace("\\", "/")
    if (
        candidate.startswith("/")
        or (len(candidate) > 1 and candidate[1] == ":")
        or candidate.startswith("//")
    ):
        return None, "Абсолютный путь запрещён."
    parts = [p for p in candidate.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None, "Выход за пределы архива («..») запрещён."
    if not parts:
        return None, "Пустой путь."
    if len(parts) > MAX_DEPTH:
        return None, f"Слишком глубокая вложенность папок (больше {MAX_DEPTH})."
    path = "/".join(parts)
    if len(path) > MAX_PATH_CHARS:
        return None, f"Путь длиннее {MAX_PATH_CHARS} символов."
    return path, None


def _collision_key(path: str) -> str:
    """Paths that look the same to a person (case, compatibility forms) collide."""
    return unicodedata.normalize("NFKC", path).casefold()


def _is_nested_archive(path: str) -> bool:
    return path.casefold().endswith(NESTED_ARCHIVES)


def _add(out: Ingested, seen: dict[str, str], raw_name: str, data: bytes, limits: IngestLimits) -> None:
    path, problem = safe_path(raw_name)
    label = path or display_path(raw_name)
    if path is None:
        out.files.append(_refuse(label, "unsafe_path", problem or "Небезопасный путь."))
        return
    key = _collision_key(path)
    if key in seen:
        out.files.append(
            _refuse(label, "path_collision", f"Имя совпадает с «{seen[key]}» (регистр или похожие символы).")
        )
        return
    seen[key] = path
    if _is_nested_archive(path):
        out.files.append(_refuse(label, "nested_archive", "Вложенные архивы не распаковываются."))
        return
    if len(data) > limits.file_bytes:
        out.files.append(_refuse(label, "file_too_large", f"Файл больше {limits.file_bytes // MIB} МБ."))
        return
    out.files.append(IncomingFile(path=path, data=data))


def _too_many(limits: IngestLimits) -> ApiError:
    return ApiError(413, "too_many_files", f"В пакете больше {limits.max_files} файлов: разделите его.")


def read_zip(data: bytes, limits: IngestLimits, out: Ingested, seen: dict[str, str]) -> None:
    """Entries of one uploaded ZIP into `out`. Archive-level problems are 4xx; entry-level ones are refused items."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, EOFError) as exc:
        raise ApiError(422, "archive_corrupt", "Архив повреждён или это не ZIP.") from exc
    entries = [i for i in infos if not i.is_dir()]
    if not entries:
        raise ApiError(422, "upload_empty", "В архиве нет файлов.")
    if any(i.flag_bits & 0x1 for i in entries):
        raise ApiError(422, "archive_encrypted", "Архив зашифрован: загрузите архив без пароля.")
    if len(entries) + len(out.files) > limits.max_files:
        raise _too_many(limits)
    declared = sum(i.file_size for i in entries)
    if declared > limits.expanded_bytes:
        raise ApiError(
            413,
            "archive_too_large",
            f"После распаковки больше {limits.expanded_bytes // MIB} МБ: разделите архив.",
        )
    expanded = 0
    for info in entries:
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_IFMT(mode) and not stat.S_ISREG(mode):  # type bits present and not a regular file
            label = display_path(info.filename)
            kind = "символическая ссылка" if stat.S_ISLNK(mode) else "специальный файл"
            out.files.append(_refuse(label, "special_file", f"Запрещено: {kind}."))
            continue
        if (
            info.compress_size
            and info.file_size / info.compress_size > limits.max_ratio
            and info.file_size > MIB
        ):
            raise ApiError(
                413,
                "archive_ratio_exceeded",
                "Подозрительно высокая степень сжатия (похоже на zip-бомбу): архив не распакован.",
            )
        if info.file_size > limits.file_bytes:
            out.files.append(
                _refuse(
                    display_path(info.filename),
                    "file_too_large",
                    f"Файл больше {limits.file_bytes // MIB} МБ.",
                )
            )
            continue
        try:
            with archive.open(info) as handle:
                buf = bytearray()
                while chunk := handle.read(_CHUNK):
                    buf += chunk
                    if len(buf) > info.file_size or len(buf) > limits.file_bytes:
                        raise ApiError(
                            413, "archive_ratio_exceeded", "Размер файла в архиве не совпадает с объявленным."
                        )
        except ApiError:
            raise
        except (zipfile.BadZipFile, RuntimeError, ValueError, EOFError, OSError, NotImplementedError) as exc:
            raise ApiError(422, "archive_corrupt", "Архив повреждён: файл не читается.") from exc
        expanded += len(buf)
        if expanded > limits.expanded_bytes:
            raise ApiError(
                413, "archive_too_large", f"После распаковки больше {limits.expanded_bytes // MIB} МБ."
            )
        _add(out, seen, info.filename, bytes(buf), limits)


def is_zip(name: str | None, data: bytes) -> bool:
    return data.startswith(b"PK\x03\x04") or bool(name and name.casefold().endswith(".zip"))
