"""Metadata without YAML (M5.6.3): document types, import preview / staging, import as a draft."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.proposals import (
    MAX_PROPOSED_CHARS,
    NewDocumentDraftCreate,
    NewDocumentMetadata,
    ProposalDetail,
)
from app.domain.schema import split_frontmatter
from app.services.metadata import DocumentTypeInfo, ImportPreview, ImportPreviewRequest, StagingItem

router = APIRouter(prefix="/api", tags=["metadata"])


class ImportCreateRequest(BaseModel):
    """Create a DRAFT from imported Markdown. `keep_original_metadata`: the file's valid YAML is kept
    verbatim (stable ID); otherwise the accepted metadata fields generate the YAML."""

    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=MAX_PROPOSED_CHARS)
    keep_original_metadata: bool = False
    template_id: str | None = Field(default=None, min_length=1, max_length=40)
    metadata: NewDocumentMetadata | None = None
    reason: str = Field(min_length=3, max_length=2000)
    client_request_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")


@router.get("/document-types", response_model=list[DocumentTypeInfo])
async def document_types(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> list[DocumentTypeInfo]:
    """Document types, the active templates that create each, and which fields the server owns."""
    return container.metadata.document_types()


@router.get("/documents/import/staging", response_model=list[StagingItem])
async def import_staging(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> list[StagingItem]:
    """Files of the knowledge root without valid YAML: not indexed, not cited — waiting for metadata review."""
    return await container.metadata.staging(user)


@router.post("/documents/import/preview", response_model=ImportPreview)
async def import_preview(
    payload: ImportPreviewRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ImportPreview:
    """What an import would create: kept / generated / suggested / missing fields. Writes nothing."""
    return await container.metadata.import_preview(user, payload)


@router.post("/documents/import", response_model=ProposalDetail, status_code=201)
async def import_document(
    payload: ImportCreateRequest,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.create_proposal))],
) -> ProposalDetail:
    """A draft proposal (origin `import`). Approved only through the usual review and merge."""
    content = payload.content.replace("\r\n", "\n").replace("\r", "\n")
    if payload.keep_original_metadata:
        return await container.proposals.create_imported(
            user, content, reason=payload.reason, client_request_id=payload.client_request_id
        )
    body = content
    if content.lstrip("﻿").startswith("---"):
        try:
            _, body = split_frontmatter(content)
        except ValueError:
            body = content.split("---", 2)[-1] if content.count("---") >= 2 else content
    if payload.template_id is None or payload.metadata is None:
        from app.errors import ApiError

        raise ApiError(422, "validation_failed", "Без исходного YAML нужны template_id и metadata.")
    return await container.proposals.create_new_document(
        user,
        NewDocumentDraftCreate(
            template_id=payload.template_id,
            metadata=payload.metadata,
            body=body.strip("\n") + "\n",
            reason=payload.reason,
            origin="import",
            client_request_id=payload.client_request_id,
        ),
    )
