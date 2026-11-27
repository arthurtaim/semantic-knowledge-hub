"""M8 knowledge onboarding orchestration (docs/KNOWLEDGE_ONBOARDING.md).

    POST batches (ZIP / folder / files) → bounded ingestion → per-file deterministic analysis → ONE stored batch
    PATCH item (expected_revision)        → the person's decisions (fields, exclusion, selected relation candidates)
    POST suggest (≤ 10 items)             → optional, bounded model suggestions (verified evidence or dropped)
    POST preview                          → side-effect-free plan + fingerprint
    POST confirm (fingerprint, key)       → ordinary DRAFT proposals through ProposalService (create_imported /
                                            create_new_document / create for an UPDATE), per-item durable outcomes,
                                            idempotent per item (`client_request_id`) and per call (key)
    POST cancel                           → the batch is closed and its staged text dropped

Nothing here writes knowledge, the index or the graph: a draft becomes canonical only after the existing review →
GitLab merge → sync. A draft is never `approved` by onboarding.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.models import DocType, UserContext
from app.domain.onboarding import (
    EDITABLE_FIELDS,
    BatchCounts,
    BatchListItem,
    BatchOut,
    BatchPreview,
    CandidateLink,
    ConfirmRequest,
    ConfirmResult,
    Diagnostic,
    DraftOutcome,
    ExistingDocRef,
    FieldSuggestion,
    ItemDecisions,
    ItemDetail,
    ItemPatch,
    ItemSummary,
    OnboardingCapabilities,
    PlannedItem,
    SuggestResult,
)
from app.domain.proposals import DraftCreate, NewDocumentDraftCreate, NewDocumentMetadata
from app.errors import ApiError
from app.services.attachments import AttachmentLimits
from app.services.knowledge import KnowledgeService
from app.services.metadata import MetadataService
from app.services.onboarding.analysis import ItemAnalysis, analyze_file, resolve_batch
from app.services.onboarding.ingest import MIB, Ingested, IngestLimits, read_zip
from app.services.onboarding.parsing import BINARY_FORMATS, TEXT_FORMATS, parser_available
from app.services.onboarding.store import OnboardingStore
from app.services.proposals import ProposalService

logger = logging.getLogger("skh.onboarding")

CLOSED = ("rejected", "expired")
REASON = "Массовый импорт {batch}: файл «{path}»"


def _now() -> datetime:
    return datetime.now(UTC)


def _diag(severity: str, code: str, message: str, fld: str | None = None) -> Diagnostic:
    return Diagnostic(severity=severity, code=code, message=message, field=fld)


class OnboardingService:
    def __init__(
        self,
        store: OnboardingStore,
        *,
        knowledge: KnowledgeService,
        metadata: MetadataService,
        proposals: ProposalService,
        limits: IngestLimits,
        ttl_hours: int,
        ai_items: int,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._store = store
        self._knowledge = knowledge
        self._metadata = metadata
        self._proposals = proposals
        self.limits = limits
        self._ttl = timedelta(hours=ttl_hours)
        self.ai_items = ai_items
        self._clock = clock
        self._locks: dict[str, asyncio.Lock] = {}
        self._parse_limits = AttachmentLimits(file_bytes=limits.file_bytes)
        self.suggester: Any = None  # set by the container: OnboardingSuggester (model suggestions), optional

    @property
    def knowledge(self) -> KnowledgeService:
        return self._knowledge

    @property
    def store(self) -> OnboardingStore:
        return self._store

    # --- capabilities --------------------------------------------------------------------------------------
    @property
    def ai_available(self) -> bool:
        return (
            self.suggester is not None
            and bool(getattr(self.suggester, "available", False))
            and self.ai_items > 0
        )

    def capabilities(self) -> OnboardingCapabilities:
        return OnboardingCapabilities(
            formats=[*TEXT_FORMATS, *BINARY_FORMATS, ".zip"],
            parsers={
                kind: "available" if parser_available(kind) else "unavailable"
                for kind in ("markdown", "text", *BINARY_FORMATS.values())
            },
            upload_mb=self.limits.upload_bytes // MIB,
            expanded_mb=self.limits.expanded_bytes // MIB,
            max_files=self.limits.max_files,
            file_mb=self.limits.file_bytes // MIB,
            ttl_hours=int(self._ttl.total_seconds() // 3600),
            ai_available=self.ai_available,
            ai_items_per_batch=self.ai_items,
        )

    # --- create ----------------------------------------------------------------------------------------------
    async def create_batch(self, user: UserContext, ingested: Ingested) -> BatchOut:
        if not ingested.files:
            raise ApiError(422, "upload_empty", "Не выбрано ни одного файла.")
        if len(ingested.files) > self.limits.max_files:
            raise ApiError(
                413, "too_many_files", f"В пакете больше {self.limits.max_files} файлов: разделите его."
            )
        self._expire()
        snapshot = await self._knowledge.snapshot(user)
        analysed: list[ItemAnalysis] = []
        for ordinal, incoming in enumerate(ingested.files):
            analysed.append(await analyze_file(user, incoming, ordinal, self._metadata, self._parse_limits))
        resolve_batch(analysed, snapshot, self._proposals._store.open_create_ids())
        now = self._clock()
        batch_id = uuid.uuid4().hex
        upload_hash = hashlib.sha256("".join(i.checksum for i in analysed).encode()).hexdigest()
        self._store.insert_batch(
            {
                "id": batch_id,
                "actor": user.user_id,
                "source_kind": ingested.source_kind,
                "state": "parsed",
                "file_count": len(analysed),
                "bytes_total": ingested.bytes_total,
                "upload_hash": upload_hash,
                "revision": 1,
                "created_at": now.isoformat(),
                "expires_at": (now + self._ttl).isoformat(),
                "expires_ts": (now + self._ttl).timestamp(),
            },
            [
                {
                    "id": i.item_id,
                    "batch_id": batch_id,
                    "ord": n,
                    "path": i.path,
                    "size": i.size,
                    "checksum": i.checksum,
                    "media_type": i.parsed.media_type,
                    "parser": i.parsed.parser,
                    "parse_status": i.parsed.status,
                    "analysis_json": json.dumps(i.analysis, ensure_ascii=False, default=str),
                    "content": i.content,
                    "decisions_json": json.dumps(i.decisions, ensure_ascii=False),
                    "ai_json": json.dumps({"state": "none"}),
                    "revision": 1,
                    "outcome_json": None,
                }
                for n, i in enumerate(analysed)
            ],
        )
        logger.info(
            "onboarding batch created id=%s files=%d parsed=%d kind=%s",
            batch_id,
            len(analysed),
            sum(1 for i in analysed if i.parsed.status == "parsed"),
            ingested.source_kind,
        )
        return self.get_batch(user, batch_id)

    def ingest_upload(self, parts: list[Any], source_kind: str) -> Ingested:
        """Form parts → files; a ZIP part is unpacked (bounded), every other part is one file (its name may carry
        the folder path the browser reported)."""
        from app.services.onboarding.ingest import _add, is_zip

        out = Ingested(source_kind=source_kind)
        seen: dict[str, str] = {}
        files = [p for p in parts if p.filename is not None]
        if not files or all(not p.data for p in files):
            raise ApiError(422, "upload_empty", "Не выбрано ни одного файла.")
        for part in files:
            if is_zip(part.filename, part.data):
                out.source_kind = "zip" if len(files) == 1 else source_kind
                read_zip(part.data, self.limits, out, seen)
            else:
                if len(out.files) >= self.limits.max_files:
                    raise ApiError(413, "too_many_files", f"В пакете больше {self.limits.max_files} файлов.")
                _add(out, seen, part.filename or "", part.data, self.limits)
        if out.bytes_total > self.limits.expanded_bytes:
            raise ApiError(
                413, "archive_too_large", f"Файлы занимают больше {self.limits.expanded_bytes // MIB} МБ."
            )
        return out

    # --- read ------------------------------------------------------------------------------------------------
    def _expire(self) -> None:
        self._store.expire(self._clock().timestamp())

    def _batch_row(self, user: UserContext, batch_id: str) -> Any:
        self._expire()
        row = self._store.batch(batch_id) if len(batch_id) == 32 else None
        if row is None or row["actor"] != user.user_id:  # another user's batch is the same answer as none
            raise ApiError(404, "batch_not_found", "Пакет импорта не найден.")
        return row

    def _open_batch(self, user: UserContext, batch_id: str) -> Any:
        row = self._batch_row(user, batch_id)
        if row["state"] == "expired":
            raise ApiError(410, "staging_expired", "Срок хранения пакета истёк: загрузите файлы заново.")
        if row["state"] == "rejected":
            raise ApiError(409, "batch_closed", "Пакет отменён.")
        return row

    @staticmethod
    def _decisions(row: Any) -> ItemDecisions:
        return ItemDecisions.model_validate(json.loads(row["decisions_json"] or "{}"))

    def _summary(self, row: Any) -> ItemSummary:
        a = json.loads(row["analysis_json"])
        d = self._decisions(row)
        outcome = (
            DraftOutcome.model_validate(json.loads(row["outcome_json"])) if row["outcome_json"] else None
        )
        parse_status = row["parse_status"]
        status: str
        if outcome is not None:
            status = outcome.state
        elif parse_status in ("invalid", "unsupported"):
            status = parse_status
        elif d.excluded:
            status = "skipped"
        elif d.reviewed:
            status = "reviewed"
        else:
            status = parse_status
        diagnostics = a.get("diagnostics") or []
        operation = (
            "skip"
            if d.excluded or parse_status in ("invalid", "unsupported")
            else (d.operation or a.get("operation") or "create")
        )
        ai = json.loads(row["ai_json"] or "{}")
        title = d.fields.get("title") or a.get("title") or ""
        return ItemSummary(
            item_id=row["id"],
            path=row["path"],
            display_name=row["path"].rsplit("/", 1)[-1],
            size=row["size"],
            media_type=row["media_type"],
            parser=row["parser"],
            parse_status=parse_status,
            status=status,
            proposed_operation=operation,
            document_id=a.get("document_id"),
            title=str(title),
            template_id=d.fields.get("template_id", a.get("template_id")),
            doc_type=d.fields.get("type", a.get("doc_type")),
            existing_doc=ExistingDocRef.model_validate(a["existing_doc"]) if a.get("existing_doc") else None,
            duplicates=a.get("duplicates") or [],
            errors=sum(1 for x in diagnostics if x["severity"] == "error"),
            warnings=sum(1 for x in diagnostics if x["severity"] == "warning"),
            links=len(a.get("links") or []),
            needs_review=parse_status == "parsed"
            and not d.reviewed
            and (not a.get("has_valid_yaml") or operation == "update"),
            excluded=d.excluded,
            ai_state=ai.get("state", "none"),
            revision=row["revision"],
            outcome=outcome,
        )

    @staticmethod
    def _counts(items: list[ItemSummary]) -> BatchCounts:
        counts = BatchCounts(total=len(items))
        for i in items:
            if i.parse_status in ("parsed", "conflict", "duplicate", "invalid", "unsupported"):
                setattr(counts, i.parse_status, getattr(counts, i.parse_status) + 1)
            counts.updates += int(i.proposed_operation == "update")
            counts.excluded += int(i.excluded)
            if i.outcome is not None:
                setattr(counts, i.outcome.state, getattr(counts, i.outcome.state) + 1)
        return counts

    def get_batch(self, user: UserContext, batch_id: str) -> BatchOut:
        row = self._batch_row(user, batch_id)
        items = [self._summary(r) for r in self._store.items(batch_id)]
        return BatchOut(
            batch_id=row["id"],
            state=row["state"],
            source_kind=row["source_kind"],
            created_at=datetime.fromisoformat(row["created_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
            file_count=row["file_count"],
            bytes_total=row["bytes_total"],
            revision=row["revision"],
            counts=self._counts(items),
            items=items,
            ai_available=self.ai_available,
        )

    def list_batches(self, user: UserContext) -> list[BatchListItem]:
        self._expire()
        out = []
        for row in self._store.batches_of(user.user_id):
            items = [self._summary(r) for r in self._store.items(row["id"])]
            out.append(
                BatchListItem(
                    batch_id=row["id"],
                    state=row["state"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    expires_at=datetime.fromisoformat(row["expires_at"]),
                    file_count=row["file_count"],
                    counts=self._counts(items),
                )
            )
        return out

    def _item_row(self, user: UserContext, batch_id: str, item_id: str) -> Any:
        self._batch_row(user, batch_id)
        row = self._store.item(batch_id, item_id)
        if row is None:
            raise ApiError(404, "item_not_found", "Файл в пакете не найден.")
        return row

    def get_item(self, user: UserContext, batch_id: str, item_id: str) -> ItemDetail:
        row = self._item_row(user, batch_id, item_id)
        a = json.loads(row["analysis_json"])
        d = self._decisions(row)
        fields = [FieldSuggestion.model_validate(f) for f in a.get("fields") or []]
        ai = json.loads(row["ai_json"] or "{}")
        fields += [
            FieldSuggestion.model_validate(s) for s in ai.get("suggestions") or []
        ]  # never applied by itself
        for name, value in d.fields.items():  # the person's edits are values of origin `user`
            fields = [f for f in fields if f.field != name or f.origin == "model"]
            fields.append(FieldSuggestion(field=name, value=value, origin="user", needs_review=False))
        links = [CandidateLink.model_validate(link) for link in a.get("links") or []]
        if d.selected_links is not None:  # the person decided: exactly these
            chosen = set(d.selected_links)
            for link in links:
                link.selected_by_user = link.link_id in chosen
        summary = self._summary(row)
        return ItemDetail(
            **summary.model_dump(),
            checksum_sha256=row["checksum"],
            diagnostics=[Diagnostic.model_validate(x) for x in a.get("diagnostics") or []],
            fields=fields,
            candidate_links=links,
            decisions=d,
            body_preview=a.get("body_preview") or "",
            preview_html=a.get("preview_html") or "",
            diff=a.get("diff"),
            diff_stats=a.get("diff_stats"),
            ai_note=ai.get("note"),
        )

    # --- decisions -------------------------------------------------------------------------------------------
    def update_item(self, user: UserContext, batch_id: str, item_id: str, patch: ItemPatch) -> ItemDetail:
        self._open_batch(user, batch_id)
        row = self._item_row(user, batch_id, item_id)
        if row["outcome_json"] and json.loads(row["outcome_json"]).get("state") == "draft_created":
            raise ApiError(409, "item_confirmed", "Черновик по этому файлу уже создан: правьте сам черновик.")
        if row["revision"] != patch.expected_revision:
            raise ApiError(
                409,
                "stale_revision",
                "Файл уже изменили в другой вкладке: обновите страницу.",
                {"current_revision": row["revision"]},
            )
        a = json.loads(row["analysis_json"])
        d = self._decisions(row)
        if patch.excluded is not None:
            if not patch.excluded and row["parse_status"] in ("invalid", "unsupported"):
                raise ApiError(422, "item_not_importable", "Этот файл нельзя импортировать: см. диагностику.")
            d.excluded = patch.excluded
        if patch.operation is not None:
            allowed = {"skip"} | ({"update"} if a.get("existing_doc") else {"create"})
            if patch.operation not in allowed:
                raise ApiError(422, "operation_invalid", "Для этого файла такая операция недоступна.")
            d.operation = patch.operation
            if patch.operation == "skip":
                d.excluded = True
            elif patch.excluded is None:
                d.excluded = False
        if patch.fields is not None:
            if (d.operation or a.get("operation")) == "update" and patch.fields:
                raise ApiError(
                    422,
                    "update_fields_locked",
                    "Изменение существующего документа создаётся из файла как есть; поля правьте в черновике после "
                    "создания.",
                )
            d.fields = {**d.fields, **self._validate_fields(patch.fields)}
        if patch.selected_links is not None:
            links = {link["link_id"]: link for link in a.get("links") or []}
            for link_id in patch.selected_links:
                link = links.get(link_id)
                if link is None:
                    raise ApiError(422, "link_unknown", "Такой связи в файле нет.")
                if link["resolve_state"] not in ("resolved", "in_batch"):
                    raise ApiError(
                        422, "link_unresolved", "Связь не разрешена (документ не найден или неоднозначен)."
                    )
            d.selected_links = list(dict.fromkeys(patch.selected_links))
        if patch.reviewed is not None:
            d.reviewed = patch.reviewed
        if not self._store.update_item(
            batch_id, item_id, patch.expected_revision, decisions_json=d.model_dump_json()
        ):
            raise ApiError(409, "stale_revision", "Файл уже изменили: обновите страницу.")
        self._store.set_batch(batch_id, state="review", bump=False)
        return self.get_item(user, batch_id, item_id)

    def _validate_fields(self, fields: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, value in fields.items():
            if name not in EDITABLE_FIELDS:
                raise ApiError(422, "field_not_editable", f"Поле {name} нельзя менять при импорте.")
            if name in ("tags", "related_ids"):
                if not isinstance(value, list) or not all(
                    isinstance(v, str) and 0 < len(v) <= 128 for v in value
                ):
                    raise ApiError(422, "field_invalid", f"{name}: нужен список строк.", {"field": name})
                out[name] = list(dict.fromkeys(v.strip() for v in value if v.strip()))[:50]
            elif name == "type":
                if value not in {t.value for t in DocType}:
                    raise ApiError(422, "field_invalid", "Неизвестный тип документа.", {"field": name})
                out[name] = value
            elif name == "template_id":
                if value is not None and self._metadata._authoring.registry.get(str(value)) is None:
                    raise ApiError(422, "field_invalid", "Такого шаблона нет.", {"field": name})
                out[name] = value
            else:
                if value is not None and (
                    not isinstance(value, str) or len(value) > (1000 if name == "summary" else 300)
                ):
                    raise ApiError(
                        422, "field_invalid", f"{name}: слишком длинное или не текст.", {"field": name}
                    )
                out[name] = value.strip() if isinstance(value, str) else value
        if "title" in out and not out["title"]:
            raise ApiError(422, "field_invalid", "Название не может быть пустым.", {"field": "title"})
        return out

    # --- plan / preview --------------------------------------------------------------------------------------
    @staticmethod
    def _value(a: dict[str, Any], d: ItemDecisions, name: str) -> Any:
        if name in d.fields:
            return d.fields[name]
        for f in a.get("fields") or []:  # deterministic suggestions; a model's one counts only once accepted
            if f["field"] == name and f["origin"] != "model":
                return f["value"]
        return None

    async def _plan(self, user: UserContext, batch_id: str, item_ids: list[str]) -> BatchPreview:
        row = self._open_batch(user, batch_id)
        rows = {r["id"]: r for r in self._store.items(batch_id)}
        unknown = [i for i in item_ids if i not in rows]
        if unknown:
            raise ApiError(
                422, "item_unknown", "В выборе есть файлы не из этого пакета.", {"item_ids": unknown}
            )
        snapshot = await self._knowledge.snapshot(user)
        planned: list[PlannedItem] = []
        blocked: list[PlannedItem] = []
        targets: dict[str, str] = {}
        fingerprint_parts: list[str] = [str(row["revision"])]
        for item_id in dict.fromkeys(item_ids):
            r = rows[item_id]
            a = json.loads(r["analysis_json"])
            d = self._decisions(r)
            errors: list[Diagnostic] = []
            outcome = json.loads(r["outcome_json"]) if r["outcome_json"] else None
            operation = d.operation or a.get("operation") or "create"
            if r["parse_status"] in ("invalid", "unsupported"):
                errors.append(
                    _diag("error", "item_not_importable", "Файл не разобран: импортировать нельзя.")
                )
            if d.excluded or operation == "skip":
                errors.append(_diag("error", "item_excluded", "Файл исключён из импорта."))
            if r["content"] is None and not (outcome and outcome.get("state") == "draft_created"):
                errors.append(
                    _diag("error", "staging_missing", "Текст файла больше не хранится: загрузите заново.")
                )
            title = str(self._value(a, d, "title") or "").strip()
            if not title:
                errors.append(_diag("error", "title_missing", "Укажите название.", "title"))
            doc_id = a.get("document_id")
            existing_rev = ""
            if operation == "update":
                existing = snapshot.get(doc_id or "")
                if existing is None:
                    errors.append(
                        _diag("error", "update_target_missing", "Документ для изменения больше не доступен.")
                    )
                else:
                    existing_rev = existing.revision
                    base = (a.get("existing_doc") or {}).get("revision")
                    if base != existing.revision:
                        errors.append(
                            _diag(
                                "error",
                                "revision_conflict",
                                f"{doc_id} изменился после загрузки: загрузите файл заново.",
                            )
                        )
            if doc_id and operation == "create":
                if doc_id in targets:
                    errors.append(
                        _diag(
                            "error",
                            "duplicate_target",
                            f"ID {doc_id} выбран дважды (и в «{targets[doc_id]}»).",
                            "id",
                        )
                    )
                targets.setdefault(doc_id, r["path"])
            related = self._related_ids(a, d)
            plan = PlannedItem(
                item_id=item_id,
                path=r["path"],
                operation="update" if operation == "update" else "create",
                document_id=doc_id,
                title=title,
                template_id=self._value(a, d, "template_id"),
                related_ids=related,
                errors=errors,
            )
            (blocked if errors else planned).append(plan)
            fingerprint_parts.append(f"{item_id}:{r['revision']}:{existing_rev}")
        fingerprint = hashlib.sha256("|".join(fingerprint_parts).encode()).hexdigest()
        selected = set(item_ids)
        skipped = [self._summary(r) for r in rows.values() if r["id"] not in selected]
        return BatchPreview(
            batch_id=batch_id,
            revision=row["revision"],
            fingerprint=fingerprint,
            planned=planned,
            blocked=blocked,
            skipped=skipped,
            creates=sum(1 for p in planned if p.operation == "create"),
            updates=sum(1 for p in planned if p.operation == "update"),
        )

    @staticmethod
    def _related_ids(a: dict[str, Any], d: ItemDecisions) -> list[str]:
        links = {link["link_id"]: link for link in a.get("links") or []}
        if "related_ids" in d.fields:
            chosen = list(d.fields["related_ids"])
        else:
            chosen = list(a.get("yaml_related_ids") or [])
        selected = (
            d.selected_links
            if d.selected_links is not None
            else [k for k, v in links.items() if v.get("selected_by_user")]
        )
        for link_id in selected:
            link = links.get(link_id)
            if link and link["resolve_state"] in ("resolved", "in_batch"):
                chosen.append(link["target_document_id"])
        own = a.get("document_id")
        return [x for x in dict.fromkeys(chosen) if x and x != own][:50]

    async def preview(self, user: UserContext, batch_id: str, item_ids: list[str]) -> BatchPreview:
        """Side-effect free: nothing is created, the batch revision does not move."""
        return await self._plan(user, batch_id, item_ids)

    # --- confirm ---------------------------------------------------------------------------------------------
    def _lock(self, batch_id: str) -> asyncio.Lock:
        return self._locks.setdefault(batch_id, asyncio.Lock())

    async def confirm(self, user: UserContext, batch_id: str, req: ConfirmRequest) -> ConfirmResult:
        request_hash = hashlib.sha256(
            json.dumps({"items": sorted(set(req.item_ids)), "fp": req.fingerprint}).encode()
        ).hexdigest()
        async with self._lock(batch_id):
            self._batch_row(user, batch_id)
            stored = self._store.confirmation(batch_id, req.idempotency_key)
            if (
                stored is not None
            ):  # a retried confirm (double click, lost answer): the same result, nothing new
                if stored["request_hash"] != request_hash:
                    raise ApiError(
                        409,
                        "idempotency_key_reused",
                        "Ключ подтверждения уже использован для другого выбора.",
                    )
                result = ConfirmResult.model_validate(json.loads(stored["result_json"]))
                return result.model_copy(update={"replayed": True})
            row = self._open_batch(user, batch_id)
            if row["revision"] != req.expected_revision:
                raise ApiError(
                    409,
                    "stale_revision",
                    "Пакет изменился: проверьте выбор заново.",
                    {"current_revision": row["revision"]},
                )
            plan = await self._plan(user, batch_id, req.item_ids)
            if plan.fingerprint != req.fingerprint:
                raise ApiError(
                    409,
                    "fingerprint_mismatch",
                    "План импорта устарел (изменились файлы или документы): проверьте выбор заново.",
                )
            if plan.blocked:
                raise ApiError(
                    422,
                    "selection_invalid",
                    "Часть выбранных файлов нельзя создать как есть.",
                    {"blocked": [b.model_dump() for b in plan.blocked]},
                )
            outcomes: dict[str, DraftOutcome] = {}
            for item in plan.planned:
                outcomes[item.item_id] = await self._create_one(user, batch_id, item)
                self._store.set_outcome(batch_id, item.item_id, outcomes[item.item_id].model_dump())
            failed = sum(1 for o in outcomes.values() if o.state == "draft_failed")
            state = "partially_confirmed" if failed else "confirmed"
            self._store.set_batch(batch_id, state=state)
            result = ConfirmResult(
                batch_id=batch_id,
                state=state,
                outcomes=outcomes,
                created=len(outcomes) - failed,
                failed=failed,
            )
            self._store.put_confirmation(
                batch_id,
                req.idempotency_key,
                request_hash,
                result.model_dump(mode="json"),
                self._clock().isoformat(),
            )
            logger.info("onboarding confirm batch=%s created=%d failed=%d", batch_id, result.created, failed)
            return result

    async def _create_one(self, user: UserContext, batch_id: str, item: PlannedItem) -> DraftOutcome:
        row = self._store.item(batch_id, item.item_id)
        assert row is not None
        if row["outcome_json"]:
            previous = DraftOutcome.model_validate(json.loads(row["outcome_json"]))
            if previous.state == "draft_created":  # confirmed before: never a second draft
                return previous
        a = json.loads(row["analysis_json"])
        d = self._decisions(row)
        content = row["content"] or ""
        reason = REASON.format(batch=batch_id[:8], path=row["path"])[:2000]
        request_id = (
            f"onb-{batch_id[:16]}-{item.item_id[:16]}"  # per item: a crash/retry finds the same draft
        )
        try:
            if item.operation == "update":
                existing = a["existing_doc"]
                detail = await self._proposals.create(
                    user,
                    DraftCreate(
                        document_id=existing["document_id"],
                        base_revision=existing["revision"],
                        proposed_content=content,
                        reason=reason,
                        origin="import",
                        client_request_id=request_id,
                    ),
                )
            elif (
                a.get("has_valid_yaml")
                and not d.fields
                and set(item.related_ids) == set(a.get("yaml_related_ids") or [])
            ):
                detail = await self._proposals.create_imported(
                    user, content, reason=reason, client_request_id=request_id
                )
            else:
                doc_type = self._value(a, d, "type") or a.get("doc_type")
                metadata = NewDocumentMetadata(
                    id=a.get("document_id") or "",
                    title=item.title,
                    owner=str(self._value(a, d, "owner") or ""),
                    tags=[str(t) for t in (self._value(a, d, "tags") or [])][:30],
                    related_ids=item.related_ids,
                    summary=(str(self._value(a, d, "summary"))[:1000] or None)
                    if self._value(a, d, "summary")
                    else None,
                    type=DocType(doc_type)
                    if doc_type in {t.value for t in DocType} and not item.template_id
                    else None,
                )
                body = (a.get("body") or content).strip("\n") + "\n"
                detail = await self._proposals.create_new_document(
                    user,
                    NewDocumentDraftCreate(
                        template_id=item.template_id,
                        metadata=metadata,
                        body=body,
                        reason=reason,
                        origin="import",
                        client_request_id=request_id,
                    ),
                )
        except ApiError as exc:
            return DraftOutcome(
                state="draft_failed",
                operation=item.operation,
                code=exc.code,
                message=exc.message,
                document_id=item.document_id,
            )
        return DraftOutcome(
            state="draft_created",
            proposal_id=detail.id,
            document_id=detail.document_id,
            operation=item.operation,
        )

    # --- model suggestions (bounded, optional) ------------------------------------------------------------
    async def suggest(self, user: UserContext, batch_id: str, item_ids: list[str]) -> SuggestResult:
        """Model suggestions for up to 10 files. Without a model: `unavailable`, the deterministic analysis stays."""
        self._open_batch(user, batch_id)
        rows = {r["id"]: r for r in self._store.items(batch_id)}
        unknown = [i for i in item_ids if i not in rows]
        if unknown:
            raise ApiError(
                422, "item_unknown", "В выборе есть файлы не из этого пакета.", {"item_ids": unknown}
            )
        states: dict[str, str] = {}
        note = None
        if not self.ai_available:
            note = "AI_UNAVAILABLE: языковая модель не подключена — предложения только по правилам."
            for item_id in item_ids:
                states[item_id] = "unavailable"
        else:
            states, note = await self.suggester.run(self, user, batch_id, [rows[i] for i in item_ids])
        revision = self._store.set_batch(batch_id, state="review")
        return SuggestResult(batch_id=batch_id, revision=revision, states=states, note=note)

    # --- cancel ----------------------------------------------------------------------------------------------
    def cancel(self, user: UserContext, batch_id: str) -> BatchOut:
        self._open_batch(user, batch_id)
        self._store.drop_content(batch_id)
        self._store.set_batch(batch_id, state="rejected")
        logger.info("onboarding batch cancelled id=%s", batch_id)
        return self.get_batch(user, batch_id)
