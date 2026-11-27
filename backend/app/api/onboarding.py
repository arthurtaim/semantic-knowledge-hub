"""M8 knowledge onboarding routes (docs/KNOWLEDGE_ONBOARDING.md). Every route needs `create_proposal` (the same right
as the single-file import); a batch belongs to the server-side actor that uploaded it — another user's batch is 404.
Nothing here writes knowledge, the index or the graph; `confirm` creates ordinary DRAFT proposals."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request

from app.api.deps import get_container
from app.api.multipart import MultipartError, read_form
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.onboarding import (
    BatchListItem,
    BatchOut,
    BatchPreview,
    ConfirmRequest,
    ConfirmResult,
    ItemDetail,
    ItemPatch,
    OnboardingCapabilities,
    SelectionRequest,
    SuggestRequest,
    SuggestResult,
)
from app.errors import ApiError

router = APIRouter(prefix="/api/onboarding", tags=["onboarding"])

BatchId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
ItemId = Annotated[str, Path(pattern=r"^[0-9a-f]{16}$")]
FORM_OVERHEAD = 256 * 1024
Writer = Annotated[UserContext, Depends(require(Action.create_proposal))]
Box = Annotated[Container, Depends(get_container)]


@router.get("/capabilities", response_model=OnboardingCapabilities)
async def capabilities(container: Box, user: Writer) -> OnboardingCapabilities:
    """Formats, size limits, parser availability and whether model suggestions are available."""
    return container.onboarding.capabilities()


@router.post("/batches", response_model=BatchOut, status_code=201)
async def create_batch(request: Request, container: Box, user: Writer) -> BatchOut:
    """multipart/form-data: `files` (one ZIP, or several files — a file name may carry its folder path), optional
    `source_kind` (`zip` | `files` | `folder`). Analysed at once (deterministic, bounded); nothing is written to the
    knowledge base."""
    service = container.onboarding
    try:
        form = await read_form(
            request,
            max_bytes=service.limits.upload_bytes + FORM_OVERHEAD,
            max_parts=service.limits.max_files + 4,
        )
    except MultipartError as exc:
        raise ApiError(
            422, "invalid_multipart", str(exc) or "Некорректное тело multipart/form-data."
        ) from exc
    if form.truncated:
        raise ApiError(
            413,
            "upload_too_large",
            f"Загрузка больше {service.limits.upload_bytes // (1024 * 1024)} МБ или файлов "
            "слишком много: разделите пакет.",
        )
    kind = form.field("source_kind") or "files"
    if kind not in ("zip", "files", "folder"):
        raise ApiError(422, "validation_failed", "source_kind: zip, files или folder.")
    ingested = service.ingest_upload(form.parts, kind)
    return await service.create_batch(user, ingested)


@router.get("/batches", response_model=list[BatchListItem])
async def list_batches(container: Box, user: Writer) -> list[BatchListItem]:
    """This user's recent batches (to resume after a reload)."""
    return container.onboarding.list_batches(user)


@router.get("/batches/{batch_id}", response_model=BatchOut)
async def get_batch(batch_id: BatchId, container: Box, user: Writer) -> BatchOut:
    return container.onboarding.get_batch(user, batch_id)


@router.get("/batches/{batch_id}/items/{item_id}", response_model=ItemDetail)
async def get_item(batch_id: BatchId, item_id: ItemId, container: Box, user: Writer) -> ItemDetail:
    """Diagnostics, suggestions with evidence, relation candidates, sanitized preview, the diff of an UPDATE."""
    return container.onboarding.get_item(user, batch_id, item_id)


@router.patch("/batches/{batch_id}/items/{item_id}", response_model=ItemDetail)
async def update_item(
    batch_id: BatchId, item_id: ItemId, payload: ItemPatch, container: Box, user: Writer
) -> ItemDetail:
    """The person's decisions for one file (`expected_revision`: a stale edit is 409)."""
    return container.onboarding.update_item(user, batch_id, item_id, payload)


@router.post("/batches/{batch_id}/suggest", response_model=SuggestResult)
async def suggest(batch_id: BatchId, payload: SuggestRequest, container: Box, user: Writer) -> SuggestResult:
    """Model suggestions for up to 10 files (bounded); without a model `unavailable`, never invented values."""
    return await container.onboarding.suggest(user, batch_id, payload.item_ids)


@router.post("/batches/{batch_id}/preview", response_model=BatchPreview)
async def preview(batch_id: BatchId, payload: SelectionRequest, container: Box, user: Writer) -> BatchPreview:
    """What a confirm of these files would create — side-effect free, with the fingerprint confirm requires."""
    return await container.onboarding.preview(user, batch_id, payload.item_ids)


@router.post("/batches/{batch_id}/confirm", response_model=ConfirmResult)
async def confirm(batch_id: BatchId, payload: ConfirmRequest, container: Box, user: Writer) -> ConfirmResult:
    """Create DRAFT proposals of the selected files (never approved). A repeated key returns the same result."""
    return await container.onboarding.confirm(user, batch_id, payload)


@router.post("/batches/{batch_id}/cancel", response_model=BatchOut)
async def cancel(batch_id: BatchId, container: Box, user: Writer) -> BatchOut:
    """Close the batch and drop its staged text; drafts already created stay ordinary drafts."""
    return container.onboarding.cancel(user, batch_id)
