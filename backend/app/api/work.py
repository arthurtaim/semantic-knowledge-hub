"""M6 Work Management API (docs/API_CONTRACTS.md «v0.7», docs/WORK_MANAGEMENT.md).

Every route declares exactly one Action through `require()` (the global AuthorizationPolicy); the service then
applies the project-scoped gate. The principal is derived on the server: identity from `get_user`, the request id,
and whether the request came through the public gateway (`X-SKH-Exposure`, which can only RESTRICT access).
Path ids accept the internal id or the human key (`ARIS`, `ARIS-12`) for deep links.

Routes are plain `def`: FastAPI runs them in its thread pool, and the work database gives each request its own
connection and transaction.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import csv_values, get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import UserContext
from app.errors import request_id_of
from app.work.models import (
    PAGE_MAX,
    ActivityPage,
    AssigneeRef,
    ProjectCreate,
    ProjectList,
    ProjectMembers,
    ProjectOut,
    ProjectStatus,
    ProjectUpdate,
    TaskArchiveResult,
    TaskCreate,
    TaskOut,
    TaskPage,
    TaskPriority,
    TaskStatus,
    TaskUpdate,
    WorkCapabilities,
)
from app.work.permissions import EXPOSURE_HEADER, WorkPrincipal

router = APIRouter(prefix="/api", tags=["work"])

ContainerDep = Annotated[Container, Depends(get_container)]


def acting(action: Action) -> Callable[..., Awaitable[WorkPrincipal]]:
    """`require(action)` + the server-derived work principal (never a client-supplied actor or role)."""
    required = require(action)

    # A default (not `Annotated`): with postponed annotations a closure variable cannot be resolved by FastAPI.
    async def dependency(request: Request, user: UserContext = Depends(required)) -> WorkPrincipal:  # noqa: B008
        return WorkPrincipal(
            user=user, request_id=request_id_of(request), exposed=bool(request.headers.get(EXPOSURE_HEADER))
        )

    return dependency


# --- capabilities / directory ----------------------------------------------------------------------------------
@router.get("/work/capabilities", response_model=WorkCapabilities)
def work_capabilities(
    container: ContainerDep, principal: Annotated[WorkPrincipal, Depends(acting(Action.view_projects))]
) -> WorkCapabilities:
    """Mode (local single operator / read-only / membership), what this principal may do, calendar, limits."""
    return container.work.capabilities(principal)


@router.get("/work/assignees", response_model=list[AssigneeRef])
def work_assignees(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_projects))],
    project_id: Annotated[str | None, Query(max_length=64, pattern=r"^[A-Za-z0-9_-]+$")] = None,
) -> list[AssigneeRef]:
    """Selectable assignees: the local operator + synthetic fixture roles (local demo), or project members."""
    return container.work.assignees(principal, project_id)


# --- projects --------------------------------------------------------------------------------------------------
@router.get("/projects", response_model=ProjectList)
def list_projects(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_projects))],
    status: Annotated[str | None, Query(max_length=200)] = None,
    include_archived: bool = False,
) -> ProjectList:
    statuses = csv_values(status, [s.value for s in ProjectStatus], name="status")
    return container.work.list_projects(principal, include_archived=include_archived, statuses=statuses)


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.manage_project))],
    body: ProjectCreate,
) -> ProjectOut:
    return container.work.create_project(principal, body)


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_projects))],
    project_id: str,
) -> ProjectOut:
    return container.work.get_project(principal, project_id)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.manage_project))],
    project_id: str,
    body: ProjectUpdate,
) -> ProjectOut:
    return container.work.update_project(principal, project_id, body)


@router.get("/projects/{project_id}/members", response_model=ProjectMembers)
def project_members(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_projects))],
    project_id: str,
) -> ProjectMembers:
    return container.work.members(principal, project_id)


@router.get("/projects/{project_id}/activity", response_model=ActivityPage)
def project_activity(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_work_audit))],
    project_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_seq: Annotated[int | None, Query(ge=1)] = None,
) -> ActivityPage:
    return container.work.project_activity(principal, project_id, limit=limit, before_seq=before_seq)


# --- tasks -----------------------------------------------------------------------------------------------------
@router.get("/projects/{project_id}/tasks", response_model=TaskPage)
def list_tasks(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    project_id: str,
    status: Annotated[str | None, Query(max_length=200)] = None,
    priority: Annotated[str | None, Query(max_length=200)] = None,
    assignee: Annotated[str | None, Query(max_length=64, pattern=r"^[A-Za-z0-9._@-]+$")] = None,
    parent: Annotated[str | None, Query(max_length=64, pattern=r"^[A-Za-z0-9_-]+$")] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    milestone: bool | None = None,
    scheduled: bool | None = None,
    overdue: bool | None = None,
    blocked: bool | None = None,
    include_archived: bool = False,
    sort: Literal[
        "key", "title", "status", "priority", "start_date", "due_date", "updated_at", "sort_order"
    ] = "sort_order",
    order: Literal["asc", "desc"] = "asc",
    limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 200,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> TaskPage:
    """Filters: `status`/`priority` (comma lists), `assignee` (id or `none`), `parent` (id or `root`), `q` (title or
    key, case-insensitive), `milestone`, `scheduled`, `overdue`, `blocked`, `include_archived`."""
    return container.work.list_tasks(
        principal,
        project_id,
        statuses=csv_values(status, [s.value for s in TaskStatus], name="status"),
        priorities=csv_values(priority, [p.value for p in TaskPriority], name="priority"),
        assignee=assignee,
        parent=parent,
        q=q,
        milestone=milestone,
        scheduled=scheduled,
        overdue=overdue,
        blocked=blocked,
        include_archived=include_archived,
        sort=sort,
        order=order,
        limit=limit,
        offset=offset,
    )


@router.post("/projects/{project_id}/tasks", response_model=TaskOut, status_code=201)
def create_task(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.create_task))],
    project_id: str,
    body: TaskCreate,
) -> TaskOut:
    return container.work.create_task(principal, project_id, body)


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    task_id: str,
) -> TaskOut:
    return container.work.get_task(principal, task_id)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.edit_task))],
    task_id: str,
    body: TaskUpdate,
) -> TaskOut:
    return container.work.update_task(principal, task_id, body)


@router.delete("/tasks/{task_id}", response_model=TaskArchiveResult)
def archive_task(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.edit_task))],
    task_id: str,
    expected_version: Annotated[int, Query(ge=1)],
    cascade: bool = False,
) -> TaskArchiveResult:
    """Archive (soft delete), never a hard delete. Active subtasks need `cascade=true`; the task's dependencies are
    removed (audited); audit history and document links stay."""
    return container.work.archive_task(principal, task_id, expected_version, cascade)


@router.post("/tasks/{task_id}/restore", response_model=TaskOut)
def restore_task(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.edit_task))],
    task_id: str,
    expected_version: Annotated[int, Query(ge=1)],
) -> TaskOut:
    """Undo an archive: the task and the subtasks archived by the same operation (not their old dependencies)."""
    return container.work.restore_task(principal, task_id, expected_version)


@router.get("/tasks/{task_id}/activity", response_model=ActivityPage)
def task_activity(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_work_audit))],
    task_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_seq: Annotated[int | None, Query(ge=1)] = None,
) -> ActivityPage:
    return container.work.task_activity(principal, task_id, limit=limit, before_seq=before_seq)
