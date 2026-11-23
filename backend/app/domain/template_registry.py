"""Versioned template registry (M5.6.2 §D).

Sources: the active templates `<templates_dir>/*.md` (each declares `version:`) and older versions kept in
`<templates_dir>/history/<template_id>.v<N>.md`. The registry remembers every (template, version,
checksum) it has seen in SQLite, so:

- a NEW template file appears in the list after a reload (no UI change, no code change);
- a CHANGED template is a new version: if the file kept its declared version but its content changed, the
  registry assigns the next free version number itself (a silent overwrite is impossible);
- an old version stays readable: drafts store (template_id, template_version) and are validated against
  exactly that version, never migrated silently;
- a REMOVED template disappears from the list for new documents, but its versions remain readable.

The registry reloads when the directory changes (checked at most every `refresh_seconds`) and on an
explicit knowledge sync.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.domain.models import DocType
from app.domain.templates import DocumentTemplate, TemplateError, parse_template_file

logger = logging.getLogger("skh.templates.registry")


@dataclass(frozen=True)
class TemplateVersionInfo:
    template_id: str
    version: int
    checksum: str
    origin: str  # active | history
    first_seen: str
    active: bool


@dataclass(frozen=True)
class RegistryReload:
    added: list[str]
    new_versions: list[str]  # "<id>@v<N>"
    removed: list[str]
    auto_bumped: list[str]
    errors: list[str]
    label: str


def _serialize(template: DocumentTemplate) -> str:
    data = asdict(template)
    data["doc_type"] = template.doc_type.value
    return json.dumps(data, ensure_ascii=False)


def _deserialize(raw: str) -> DocumentTemplate:
    data = json.loads(raw)
    data["doc_type"] = DocType(data["doc_type"])
    data["default_tags"] = tuple(data["default_tags"])
    data["sections"] = tuple(data["sections"])
    return DocumentTemplate(**data)


class TemplateRegistry:
    def __init__(self, directory: Path, state_path: Path | str, *, refresh_seconds: float = 2.0) -> None:
        self._dir = directory
        self._refresh = refresh_seconds
        self._lock = threading.Lock()
        path = str(state_path)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        with self._conn:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS template_versions (template_id TEXT NOT NULL, version INTEGER NOT NULL, "
                "checksum TEXT NOT NULL, origin TEXT NOT NULL, template_json TEXT NOT NULL, first_seen TEXT NOT NULL, "
                "PRIMARY KEY (template_id, version))"
            )
        self._active: dict[str, DocumentTemplate] = {}
        self._fingerprint = ""
        self._checked = 0.0
        self.last_reload: RegistryReload | None = None
        self.reload()

    # --- scanning ---------------------------------------------------------------------------------
    def _files(self) -> tuple[list[Path], list[Path]]:
        if not self._dir.is_dir():
            return [], []
        active = sorted(p for p in self._dir.glob("*.md") if p.is_file() and not p.is_symlink())
        history_dir = self._dir / "history"
        history = (
            sorted(p for p in history_dir.glob("*.md") if p.is_file() and not p.is_symlink())
            if history_dir.is_dir()
            else []
        )
        return active, history

    def _fingerprint_of(self, files: list[Path]) -> str:
        digest = hashlib.sha256()
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                continue
            digest.update(f"{path.name}|{stat.st_mtime_ns}|{stat.st_size}\n".encode())
        return digest.hexdigest()[:16]

    def _resolve(self, template: DocumentTemplate, origin: str, auto_bumped: list[str]) -> DocumentTemplate:
        """Record (id, version, checksum); returns the template with its RESOLVED version."""
        rows = self._conn.execute(
            "SELECT version, checksum FROM template_versions WHERE template_id = ?", (template.id,)
        ).fetchall()
        for version, checksum in rows:
            if checksum == template.checksum:
                return DocumentTemplate(**{**asdict(template), "version": version})
        taken = {version for version, _ in rows}
        version = template.version
        if version in taken:
            version = max(taken) + 1
            auto_bumped.append(f"{template.id}@v{version}")
            logger.warning(
                "template %s changed without a new version: registered as v%d", template.id, version
            )
        resolved = DocumentTemplate(**{**asdict(template), "version": version})
        self._conn.execute(
            "INSERT INTO template_versions(template_id, version, checksum, origin, template_json, first_seen) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                template.id,
                version,
                template.checksum,
                origin,
                _serialize(resolved),
                datetime.now(UTC).isoformat(timespec="seconds"),
            ),
        )
        return resolved

    def reload(self, *, force: bool = True) -> RegistryReload:
        with self._lock:
            active_files, history_files = self._files()
            fingerprint = self._fingerprint_of([*active_files, *history_files])
            if not force and fingerprint == self._fingerprint and self.last_reload is not None:
                return self.last_reload
            before = {tid: t.version for tid, t in self._active.items()}
            errors: list[str] = []
            auto_bumped: list[str] = []
            active: dict[str, DocumentTemplate] = {}
            with self._conn:
                for path in history_files:  # older versions first, so declared numbers are kept
                    try:
                        self._resolve(parse_template_file(path), "history", auto_bumped)
                    except (TemplateError, OSError, UnicodeDecodeError) as exc:
                        errors.append(f"history/{path.name}: {exc}")
                for path in active_files:
                    try:
                        template = self._resolve(parse_template_file(path), "active", auto_bumped)
                    except (TemplateError, OSError, UnicodeDecodeError) as exc:
                        errors.append(f"{path.name}: {exc}")
                        logger.error("template %s skipped: %s", path.name, exc)
                        continue
                    if template.id in active:
                        errors.append(f"{path.name}: duplicate template_id {template.id}")
                        continue
                    active[template.id] = template
            self._active = dict(sorted(active.items(), key=lambda item: (item[1].order, item[0])))
            self._fingerprint = fingerprint
            self._checked = time.monotonic()
            result = RegistryReload(
                added=sorted(set(active) - set(before)),
                new_versions=sorted(
                    f"{tid}@v{t.version}"
                    for tid, t in active.items()
                    if tid in before and before[tid] != t.version
                ),
                removed=sorted(set(before) - set(active)),
                auto_bumped=auto_bumped,
                errors=errors,
                label=self._label(),
            )
            self.last_reload = result
            if result.added or result.new_versions or result.removed:
                logger.info(
                    "template registry %s: +%s new versions %s -%s",
                    result.label,
                    result.added,
                    result.new_versions,
                    result.removed,
                )
            return result

    def _maybe_reload(self) -> None:
        if time.monotonic() - self._checked >= self._refresh:
            self.reload(force=False)
            self._checked = time.monotonic()

    def _label(self) -> str:
        digest = hashlib.sha256()
        for tid, t in sorted(self._active.items()):
            digest.update(f"{tid}@{t.version}:{t.checksum}\n".encode())
        return f"t{len(self._active)}:{digest.hexdigest()[:10]}"

    # --- queries ------------------------------------------------------------------------------------
    @property
    def label(self) -> str:
        self._maybe_reload()
        return self._label()

    def active(self) -> dict[str, DocumentTemplate]:
        """Templates offered for NEW documents (current version of every present file)."""
        self._maybe_reload()
        return dict(self._active)

    def get(self, template_id: str, version: int | None = None) -> DocumentTemplate | None:
        """A specific version (any, including removed templates); None = the current version."""
        self._maybe_reload()
        if version is None:
            return self._active.get(template_id)
        with self._lock:
            row = self._conn.execute(
                "SELECT template_json FROM template_versions WHERE template_id = ? AND version = ?",
                (template_id, version),
            ).fetchone()
        return _deserialize(row[0]) if row else None

    def versions(self, template_id: str) -> list[TemplateVersionInfo]:
        self._maybe_reload()
        current = self._active.get(template_id)
        with self._lock:
            rows = self._conn.execute(
                "SELECT version, checksum, origin, first_seen FROM template_versions WHERE template_id = ? "
                "ORDER BY version",
                (template_id,),
            ).fetchall()
        return [
            TemplateVersionInfo(
                template_id=template_id,
                version=v,
                checksum=c,
                origin=o,
                first_seen=f,
                active=current is not None and current.version == v,
            )
            for v, c, o, f in rows
        ]

    def graph_entries(self) -> dict[str, tuple[str, int]]:
        return {tid: (t.title, t.version) for tid, t in self.active().items()}

    def close(self) -> None:
        with self._lock:
            self._conn.close()
