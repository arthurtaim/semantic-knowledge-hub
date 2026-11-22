"""M5 publication of merged GitLab documents to Confluence Data Center (docs/CONFLUENCE_SYNC_RUNBOOK.md).

The target space and parent page come only from configuration; no route accepts a page ID. A dry-run
performs read requests only; `publish` is a separate, explicit step and is refused while writes are
disabled by configuration."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.domain.publications import DocumentPublicationStatus, PublicationJobDetail, PublicationJobList

router = APIRouter(tags=["publications"])
DocId = Annotated[str, Path(min_length=1, max_length=128)]
JobId = Annotated[str, Path(min_length=1, max_length=64)]


@router.get("/api/documents/{document_id}/publication", response_model=DocumentPublicationStatus)
async def document_publication(
    document_id: DocId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> DocumentPublicationStatus:
    return await container.publications.document_status(user, document_id)


@router.post("/api/documents/{document_id}/publication/prepare", response_model=PublicationJobDetail)
async def prepare_publication(
    document_id: DocId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.prepare_publication))],
) -> PublicationJobDetail:
    """Create (or reuse) the job for the current GitLab revision and run a dry-run (reads only)."""
    return await container.publications.prepare(user, document_id)


@router.get("/api/publications/jobs", response_model=PublicationJobList)
async def list_publication_jobs(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    document_id: Annotated[str | None, Query(max_length=128)] = None,
) -> PublicationJobList:
    return await container.publications.list_jobs(document_id)


@router.get("/api/publications/jobs/{job_id}", response_model=PublicationJobDetail)
async def get_publication_job(
    job_id: JobId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> PublicationJobDetail:
    return await container.publications.get_job(job_id)


@router.post("/api/publications/jobs/{job_id}/dry-run", response_model=PublicationJobDetail)
async def dry_run_publication(
    job_id: JobId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.prepare_publication))],
) -> PublicationJobDetail:
    return await container.publications.dry_run(user, job_id)


@router.post("/api/publications/jobs/{job_id}/publish", response_model=PublicationJobDetail)
async def publish(
    job_id: JobId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.publish_confluence))],
) -> PublicationJobDetail:
    """Create/update the Confluence page exactly as previewed (re-checked first)."""
    return await container.publications.publish(user, job_id)


@router.post("/api/publications/jobs/{job_id}/reconcile", response_model=PublicationJobDetail)
async def reconcile_publication(
    job_id: JobId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.prepare_publication))],
) -> PublicationJobDetail:
    """Inspect Confluence after an unconfirmed/failed write, then refresh the preview. Never writes."""
    return await container.publications.reconcile(user, job_id)


@router.post("/api/publications/jobs/{job_id}/acknowledge-manual-edit", response_model=PublicationJobDetail)
async def acknowledge_manual_edit(
    job_id: JobId,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.publish_confluence))],
) -> PublicationJobDetail:
    """Human decision after reviewing a manual-edit diff: take the current page as the new baseline.
    Nothing is written; the refreshed preview shows what a publication would replace."""
    return await container.publications.acknowledge_manual_edit(user, job_id)
