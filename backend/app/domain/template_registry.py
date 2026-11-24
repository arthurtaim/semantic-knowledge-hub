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

Template Studio (docs/TEMPLATE_HUB.md «Template Studio») keeps app-managed templates in the SAME state database
(`template_studio`, `template_studio_events`; versions in `template_versions` with origin `studio`), never in files:

- a template CREATED in the studio owns its id; a shipped file with that id is ignored and reported;
- editing a SHIPPED template ADOPTS it: from then on the studio says which version is current, and the file's
  catalogue text no longer overwrites the stored versions;
- a later release that ships a new version of an adopted template registers that version (readable) and reports it
  as `shipped_update` — it never becomes current silently; a person activates it or keeps the studio version;
- an open draft is not a version: documents can neither start from it nor pin it. Activation turns it into a
  version (or corrects the catalogue text of the current one when the schema did not change);
- every studio write checks `expected_revision` (optimistic lock) and writes an event (author, time, action).
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from app.domain.models import DocType
from app.domain.templates import DocumentTemplate, TemplateError, parse_template_file, schema_checksum

logger = logging.getLogger("skh.templates.registry")


@dataclass(frozen=True)
class TemplateVersionInfo:
    template_id: str
    version: int
    checksum: str
    origin: str  # active | history (shipped files) | studio (activated in Template Studio)
    first_seen: str
    active: bool


@dataclass(frozen=True)
class StudioRecord:
    """Template Studio state of one template (a row of `template_studio`)."""

    template_id: str
    kind: str  # created (born in the studio) | adopted (a shipped template edited in the studio)
    active_version: int | None  # None: a new template that was never activated (only its draft exists)
    revision: int  # optimistic lock, +1 on every studio write
    shipped_version: int | None  # adopted: the shipped version the studio last saw or acknowledged
    draft_json: str | None  # the open draft (a TemplateSpec as JSON)
    draft_base_version: int | None  # the current version when the draft was started
    draft_by: str | None
    draft_at: str | None
    created_by: str
    created_at: str
    updated_by: str
    updated_at: str
    ai_proposal_id: str | None


@dataclass(frozen=True)
class StudioEvent:
    at: str
    actor: str
    action: str  # created | adopted | draft_saved | draft_discarded | deleted | activated | info_updated | reactivated | shipped_acknowledged
    version: int | None
    revision: int
    summary: str


class StudioConflictError(Exception):
    """A studio write lost a race or refers to a state that no longer exists (HTTP 409)."""

    def __init__(self, code: str, message: str, current_revision: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.current_revision = current_revision


_STUDIO_COLUMNS = (
    "template_id, kind, active_version, revision, shipped_version, draft_json, draft_base_version, draft_by, "
    "draft_at, created_by, created_at, updated_by, updated_at, ai_proposal_id"
)
_STUDIO_INSERT = (
    "INSERT INTO template_studio(template_id, kind, active_version, revision, shipped_version, draft_json, "
    "draft_base_version, draft_by, draft_at, created_by, created_at, updated_by, updated_at, ai_proposal_id) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


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


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _deserialize(raw: str) -> DocumentTemplate:
    data = json.loads(raw)
    data["doc_type"] = DocType(data["doc_type"])
    for key in (
        "default_tags",
        "sections",
        "labels",
        "optional_sections",
        "required_metadata",
        "optional_metadata",
        "validation",
    ):
        if key in data:  # rows written by older builds lack the Template Hub fields: defaults apply
            data[key] = tuple(data[key])
    known = DocumentTemplate.__dataclass_fields__
    return DocumentTemplate(**{k: v for k, v in data.items() if k in known})


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
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS template_studio (template_id TEXT PRIMARY KEY, kind TEXT NOT NULL, "
                "active_version INTEGER, revision INTEGER NOT NULL, shipped_version INTEGER, draft_json TEXT, "
                "draft_base_version INTEGER, draft_by TEXT, draft_at TEXT, created_by TEXT NOT NULL, "
                "created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, ai_proposal_id TEXT)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS template_studio_events (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "template_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, "
                "version INTEGER, revision INTEGER NOT NULL, summary TEXT NOT NULL)"
            )
        self._active: dict[str, DocumentTemplate] = {}
        self._shipped: dict[str, DocumentTemplate] = {}  # current version of every shipped file (resolved)
        self._file_ids: dict[str, str] = {}  # active file name -> template id (last successful parse)
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

    def _resolve(
        self, template: DocumentTemplate, origin: str, auto_bumped: list[str], *, keep_text: bool = False
    ) -> DocumentTemplate:
        """Record (id, version, checksum); returns the template with its RESOLVED version. `keep_text`: the template is
        adopted by the studio — the stored catalogue text of an existing version is not overwritten by the file."""
        rows = self._conn.execute(
            "SELECT version, checksum, template_json FROM template_versions WHERE template_id = ?",
            (template.id,),
        ).fetchall()
        for version, checksum, stored in rows:
            # Same schema = same version. Rows of older builds carry a raw-file checksum: compare schemas.
            if checksum == template.checksum or schema_checksum(_deserialize(stored)) == template.checksum:
                resolved = DocumentTemplate(**{**asdict(template), "version": version})
                if keep_text:
                    return resolved
                if checksum != template.checksum or stored != _serialize(resolved):
                    self._conn.execute(  # keep the catalogue text of this version current
                        "UPDATE template_versions SET checksum = ?, template_json = ? "
                        "WHERE template_id = ? AND version = ?",
                        (template.checksum, _serialize(resolved), template.id, version),
                    )
                return resolved
        taken = {version for version, _, _ in rows}
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
                _now(),
            ),
        )
        return resolved

    def _stored(self, template_id: str, version: int) -> DocumentTemplate | None:
        row = self._conn.execute(
            "SELECT template_json FROM template_versions WHERE template_id = ? AND version = ?",
            (template_id, version),
        ).fetchone()
        return _deserialize(row[0]) if row else None

    def _studio_stamp(self) -> str:
        count, total = self._conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(revision), 0) FROM template_studio"
        ).fetchone()
        return f"{count}:{total}"

    def reload(self, *, force: bool = True) -> RegistryReload:
        with self._lock:
            return self._reload_locked(force=force)

    def _reload_locked(self, *, force: bool) -> RegistryReload:
        active_files, history_files = self._files()
        fingerprint = f"{self._fingerprint_of([*active_files, *history_files])}|{self._studio_stamp()}"
        if not force and fingerprint == self._fingerprint and self.last_reload is not None:
            return self.last_reload
        before = {tid: t.version for tid, t in self._active.items()}
        errors: list[str] = []
        auto_bumped: list[str] = []
        active: dict[str, DocumentTemplate] = {}
        shipped: dict[str, DocumentTemplate] = {}
        studio = {r.template_id: r for r in self._studio_rows()}

        def owned_by_studio(template: DocumentTemplate, name: str) -> bool:
            record = studio.get(template.id)
            if record is not None and record.kind == "created":
                errors.append(
                    f"{name}: template_id {template.id} создан в студии шаблонов — файл не используется"
                )
                return True
            return False

        with self._conn:
            for path in history_files:  # older versions first, so declared numbers are kept
                try:
                    parsed = parse_template_file(path)
                    if not owned_by_studio(parsed, f"history/{path.name}"):
                        self._resolve(parsed, "history", auto_bumped, keep_text=parsed.id in studio)
                except (TemplateError, OSError, UnicodeDecodeError) as exc:
                    errors.append(f"history/{path.name}: {exc}")
            file_ids: dict[str, str] = {}
            for path in active_files:
                try:
                    parsed = parse_template_file(path)
                    if owned_by_studio(parsed, path.name):
                        continue
                    template = self._resolve(parsed, "active", auto_bumped, keep_text=parsed.id in studio)
                except (TemplateError, OSError, UnicodeDecodeError) as exc:
                    # An invalid revision never disables the version that was active before it.
                    previous_id = self._file_ids.get(path.name)
                    previous = self._shipped.get(previous_id) if previous_id else None
                    if previous is not None and previous.id not in shipped:
                        shipped[previous.id] = previous
                        file_ids[path.name] = previous.id
                        errors.append(f"{path.name}: {exc} — оставлена действующая v{previous.version}")
                    else:
                        errors.append(f"{path.name}: {exc}")
                    logger.error("template %s not activated: %s", path.name, exc)
                    continue
                if template.id in shipped:
                    errors.append(f"{path.name}: duplicate template_id {template.id}")
                    continue
                shipped[template.id] = template
                file_ids[path.name] = template.id
        for tid, template in shipped.items():
            if tid not in studio:
                active[tid] = template
        for tid, record in studio.items():  # the studio says which version is current
            if record.active_version is None:
                continue
            current = self._stored(tid, record.active_version)
            if current is not None:
                active[tid] = current
            else:
                errors.append(f"studio/{tid}: нет сохранённой версии v{record.active_version}")
        self._file_ids = file_ids
        self._shipped = shipped
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

    # --- Template Studio: state -------------------------------------------------------------------------------
    def _studio_rows(self, template_id: str | None = None) -> list[StudioRecord]:
        sql = f"SELECT {_STUDIO_COLUMNS} FROM template_studio"  # noqa: S608 - constant column list
        if template_id is None:
            rows = self._conn.execute(sql).fetchall()
        else:
            rows = self._conn.execute(sql + " WHERE template_id = ?", (template_id,)).fetchall()
        return [StudioRecord(*row) for row in rows]

    def studio_record(self, template_id: str) -> StudioRecord | None:
        self._maybe_reload()
        with self._lock:
            rows = self._studio_rows(template_id)
        return rows[0] if rows else None

    def studio_records(self) -> dict[str, StudioRecord]:
        self._maybe_reload()
        with self._lock:
            return {r.template_id: r for r in self._studio_rows()}

    def studio_events(self, template_id: str, limit: int = 200) -> list[StudioEvent]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT at, actor, action, version, revision, summary FROM template_studio_events "
                "WHERE template_id = ? ORDER BY id DESC LIMIT ?",
                (template_id, limit),
            ).fetchall()
        return [StudioEvent(*row) for row in rows]

    def revision(self, template_id: str) -> int:
        """The optimistic-lock revision a studio write must name (0: the studio never touched the template)."""
        record = self.studio_record(template_id)
        return record.revision if record else 0

    def shipped(self, template_id: str) -> DocumentTemplate | None:
        """The current version of the shipped file (None for studio-born or removed templates)."""
        self._maybe_reload()
        return self._shipped.get(template_id)

    def shipped_update(self, template_id: str) -> int | None:
        """A shipped version of an ADOPTED template that is neither current nor acknowledged (a release brought it)."""
        record = self.studio_record(template_id)
        shipped = self._shipped.get(template_id)
        if record is None or record.kind != "adopted" or shipped is None:
            return None
        if shipped.version in (record.shipped_version, record.active_version):
            return None
        return shipped.version

    def _known_ids_locked(self) -> set[str]:
        ids = {r[0] for r in self._conn.execute("SELECT DISTINCT template_id FROM template_versions")}
        ids |= {r[0] for r in self._conn.execute("SELECT template_id FROM template_studio")}
        return ids | set(self._shipped)

    def known_ids(self) -> set[str]:
        """Every template id ever seen: shipped (also removed ones), activated or drafted in the studio."""
        self._maybe_reload()
        with self._lock:
            return self._known_ids_locked()

    # --- Template Studio: writes (each: optimistic lock + an event, one transaction) -----------------------------
    def _event(
        self, template_id: str, actor: str, action: str, version: int | None, revision: int, summary: str
    ) -> None:
        self._conn.execute(
            "INSERT INTO template_studio_events(template_id, at, actor, action, version, revision, summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (template_id, _now(), actor, action, version, revision, summary[:500]),
        )

    def _check(self, template_id: str, expected_revision: int) -> StudioRecord | None:
        rows = self._studio_rows(template_id)
        record = rows[0] if rows else None
        current = record.revision if record else 0
        if current != expected_revision:
            who = f": {record.updated_by}, {record.updated_at}" if record else ""
            raise StudioConflictError(
                "template_conflict",
                f"Шаблон уже изменён{who} (ревизия {current}, у вас {expected_revision}). Обновите редактор: "
                "несохранённые правки останутся на странице, сравните их с новой версией.",
                current,
            )
        return record

    def _adopt(self, template_id: str, actor: str) -> StudioRecord:
        """The first studio write to a shipped template: from now on the studio says which version is current."""
        current = self._active.get(template_id)
        shipped = self._shipped.get(template_id)
        if current is None or shipped is None:
            raise StudioConflictError("template_not_found", "Шаблон не найден.")
        now = _now()
        self._conn.execute(
            _STUDIO_INSERT,
            (
                template_id,
                "adopted",
                current.version,
                0,
                shipped.version,
                None,
                None,
                None,
                None,
                actor,
                now,
                actor,
                now,
                None,
            ),
        )
        self._event(
            template_id,
            actor,
            "adopted",
            current.version,
            0,
            f"Шаблон из поставки (v{shipped.version}) взят в студию",
        )
        return self._studio_rows(template_id)[0]

    def _bump(self, template_id: str, expected_revision: int, actor: str, **columns: object) -> int:
        assignments = "".join(
            f"{name} = ?, " for name in columns
        )  # names come from code, never from a request
        cursor = self._conn.execute(
            f"UPDATE template_studio SET {assignments}revision = revision + 1, updated_by = ?, updated_at = ? "  # noqa: S608
            "WHERE template_id = ? AND revision = ?",
            (*columns.values(), actor, _now(), template_id, expected_revision),
        )
        if cursor.rowcount != 1:
            raise StudioConflictError("template_conflict", "Шаблон уже изменён. Обновите редактор.", None)
        return expected_revision + 1

    def _same_schema_version(self, template_id: str, checksum: str) -> int | None:
        rows = self._conn.execute(
            "SELECT version, checksum, template_json FROM template_versions WHERE template_id = ? ORDER BY version",
            (template_id,),
        ).fetchall()
        for version, stored_checksum, stored in rows:
            if stored_checksum == checksum or schema_checksum(_deserialize(stored)) == checksum:
                return int(version)
        return None

    def studio_create(
        self, template_id: str, draft_json: str, *, actor: str, ai_proposal_id: str | None = None
    ) -> StudioRecord:
        """A new template: only its draft exists until the first activation (it is not offered to documents)."""
        with self._lock:
            self._reload_locked(force=False)
            try:
                with self._conn:
                    if template_id in self._known_ids_locked():
                        raise StudioConflictError(
                            "template_id_taken",
                            f"Шаблон с ID «{template_id}» уже есть (в поставке или в студии).",
                        )
                    now = _now()
                    self._conn.execute(
                        _STUDIO_INSERT,
                        (
                            template_id,
                            "created",
                            None,
                            1,
                            None,
                            draft_json,
                            None,
                            actor,
                            now,
                            actor,
                            now,
                            actor,
                            now,
                            ai_proposal_id,
                        ),
                    )
                    summary = "Создан черновик шаблона" + (" по предложению ИИ" if ai_proposal_id else "")
                    self._event(template_id, actor, "created", None, 1, summary)
            except sqlite3.IntegrityError as exc:
                raise StudioConflictError(
                    "template_id_taken", f"Шаблон с ID «{template_id}» уже есть."
                ) from exc
            self._reload_locked(force=True)
            return self._studio_rows(template_id)[0]

    def studio_save_draft(
        self, template_id: str, draft_json: str, *, expected_revision: int, actor: str, summary: str
    ) -> StudioRecord:
        """Save the open draft. The current version stays current; documents never see the draft."""
        with self._lock:
            self._reload_locked(force=False)
            with self._conn:
                record = self._check(template_id, expected_revision)
                if record is None:
                    record = self._adopt(template_id, actor)
                base = record.draft_base_version if record.draft_json is not None else record.active_version
                revision = self._bump(
                    template_id,
                    record.revision,
                    actor,
                    draft_json=draft_json,
                    draft_base_version=base,
                    draft_by=actor,
                    draft_at=_now(),
                )
                self._event(template_id, actor, "draft_saved", None, revision, summary)
            self._reload_locked(force=True)
            return self._studio_rows(template_id)[0]

    def studio_discard_draft(
        self, template_id: str, *, expected_revision: int, actor: str
    ) -> StudioRecord | None:
        """Drop the open draft; a template that was never activated disappears with it (None)."""
        with self._lock:
            self._reload_locked(force=False)
            with self._conn:
                record = self._check(template_id, expected_revision)
                if record is None or record.draft_json is None:
                    raise StudioConflictError(
                        "template_draft_missing", "Открытого черновика нет.", expected_revision
                    )
                if record.active_version is None:
                    self._conn.execute(
                        "DELETE FROM template_studio WHERE template_id = ? AND revision = ?",
                        (template_id, expected_revision),
                    )
                    self._event(
                        template_id,
                        actor,
                        "deleted",
                        None,
                        expected_revision + 1,
                        "Черновик нового шаблона удалён",
                    )
                else:
                    revision = self._bump(
                        template_id,
                        expected_revision,
                        actor,
                        draft_json=None,
                        draft_base_version=None,
                        draft_by=None,
                        draft_at=None,
                    )
                    self._event(template_id, actor, "draft_discarded", None, revision, "Черновик удалён")
            self._reload_locked(force=True)
            rows = self._studio_rows(template_id)
            return rows[0] if rows else None

    def studio_activate_draft(
        self,
        template_id: str,
        candidate: DocumentTemplate,
        *,
        expected_revision: int,
        actor: str,
        note: str = "",
    ) -> tuple[str, int]:
        """Activate the open draft (the caller validated it at `expected_revision`). Returns (action, version):
        `info_updated` — same schema: the catalogue text of the current version is corrected in place;
        `reactivated` — the schema of an older version: that version becomes current again;
        `activated` — a new schema: the next free version number, now current. Documents keep their pins."""
        with self._lock:
            self._reload_locked(force=False)
            with self._conn:
                record = self._check(template_id, expected_revision)
                if record is None or record.draft_json is None:
                    raise StudioConflictError(
                        "template_draft_missing", "Открытого черновика нет.", expected_revision
                    )
                current = self._stored(template_id, record.active_version) if record.active_version else None
                if current is not None and current.checksum == candidate.checksum:
                    action, version = "info_updated", current.version
                else:
                    same = self._same_schema_version(template_id, candidate.checksum)
                    if same is not None:
                        action, version = "reactivated", same
                    else:
                        taken = self._conn.execute(
                            "SELECT COALESCE(MAX(version), 0) FROM template_versions WHERE template_id = ?",
                            (template_id,),
                        ).fetchone()[0]
                        action, version = "activated", int(taken) + 1
                stored = replace(candidate, version=version)
                if action == "activated":
                    self._conn.execute(
                        "INSERT INTO template_versions(template_id, version, checksum, origin, template_json, first_seen) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (template_id, version, stored.checksum, "studio", _serialize(stored), _now()),
                    )
                else:
                    self._conn.execute(
                        "UPDATE template_versions SET checksum = ?, template_json = ? WHERE template_id = ? AND version = ?",
                        (stored.checksum, _serialize(stored), template_id, version),
                    )
                revision = self._bump(
                    template_id,
                    expected_revision,
                    actor,
                    active_version=version,
                    draft_json=None,
                    draft_base_version=None,
                    draft_by=None,
                    draft_at=None,
                )
                summary = {
                    "info_updated": f"Информационные поля v{version} обновлены (новая версия не нужна)",
                    "reactivated": f"Структура совпала с v{version}: действующей снова стала v{version}",
                    "activated": f"Активирована v{version}",
                }[action]
                self._event(
                    template_id, actor, action, version, revision, f"{summary}{'. ' + note if note else ''}"
                )
            self._reload_locked(force=True)
            logger.info("template studio %s: %s v%d by %s", template_id, action, version, actor)
            return action, version

    def studio_activate_version(
        self, template_id: str, version: int, *, expected_revision: int, actor: str
    ) -> StudioRecord:
        """Make an existing version current: a rollback, or the version a release shipped (resolves the conflict)."""
        with self._lock:
            self._reload_locked(force=False)
            with self._conn:
                record = self._check(template_id, expected_revision)
                if self._stored(template_id, version) is None:
                    raise StudioConflictError("template_version_not_found", "Такой версии шаблона нет.")
                if record is None:
                    record = self._adopt(template_id, actor)
                if record.active_version == version:
                    raise StudioConflictError(
                        "template_version_active", f"v{version} уже действует.", record.revision
                    )
                columns: dict[str, object] = {"active_version": version}
                shipped = self._shipped.get(template_id)
                if shipped is not None and shipped.version == version:
                    columns["shipped_version"] = version
                revision = self._bump(template_id, record.revision, actor, **columns)
                previous = f" (была v{record.active_version})" if record.active_version else ""
                self._event(
                    template_id,
                    actor,
                    "activated",
                    version,
                    revision,
                    f"Действующей стала v{version}{previous}",
                )
            self._reload_locked(force=True)
            return self._studio_rows(template_id)[0]

    def studio_acknowledge_shipped(
        self, template_id: str, *, expected_revision: int, actor: str
    ) -> StudioRecord:
        """Keep the studio version; the shipped update stays readable in the history."""
        with self._lock:
            self._reload_locked(force=False)
            with self._conn:
                record = self._check(template_id, expected_revision)
                shipped = self._shipped.get(template_id)
                if (
                    record is None
                    or record.kind != "adopted"
                    or shipped is None
                    or shipped.version in (record.shipped_version, record.active_version)
                ):
                    raise StudioConflictError(
                        "template_no_shipped_update", "Новой версии из поставки нет.", expected_revision
                    )
                revision = self._bump(template_id, expected_revision, actor, shipped_version=shipped.version)
                self._event(
                    template_id,
                    actor,
                    "shipped_acknowledged",
                    shipped.version,
                    revision,
                    f"Версия v{shipped.version} из поставки просмотрена; действующей осталась v{record.active_version}",
                )
            self._reload_locked(force=True)
            return self._studio_rows(template_id)[0]
