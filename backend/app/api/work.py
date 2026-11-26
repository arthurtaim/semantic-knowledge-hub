"""M6 Work Management API (docs/API_CONTRACTS.md «v0.7», docs/WORK_MANAGEMENT.md).

Every route declares exactly one Action through `require()` (the global AuthorizationPolicy); the service then
applies the project-scoped gate. The principal is derived on the server: identity from `get_user`, the request id,
and whether the request came through the public gateway (`X-SKH-Exposure`, which can only RESTRICT access).
Path ids accept the internal id or the human key (`ARIS`, `ARIS-12`) for deep links.

Routes are plain `def`: FastAPI runs them in its thread pool, and the work database gives each request its own
connection and transaction. The principal also carries the reader's CURRENT knowledge snapshot (resolved here, on the
event loop): task ↔ document links are shown and counted only against it, so a hidden or deleted document never
leaks a title, a revision or a count. When the knowledge source is down the work module keeps working; document
facts are then reported as unverifiable, never guessed.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request

from app.adapters.knowledge.base import RepositoryUnavailableError
from app.api.deps import csv_values, get_container
from app.authz import Action, ensure_allowed, require
from app.container import Container
from app.domain.models import UserContext
from app.errors import request_id_of
from app.work.ai import Idempotency, request_hash
from app.work.links import DocumentScope
from app.work.models import (
    PAGE_MAX,
    ActivityPage,
    AssigneeRef,
    DependencyCreate,
    DependencyMutation,
    DependencyRemoved,
    DocumentTasks,
    GanttOut,
    ProjectCreate,
    ProjectDocuments,
    ProjectList,
    ProjectMembers,
    ProjectOut,
    ProjectStatus,
    ProjectUpdate,
    ScheduleApplyRequest,
    ScheduleApplyResult,
    SchedulePreview,
    SchedulePreviewRequest,
    TaskArchiveResult,
    TaskCreate,
    TaskDependencies,
    TaskLinkCreate,
    TaskLinkOut,
    TaskLinkRemoved,
    TaskLinks,
    TaskOut,
    TaskPage,
    TaskPriority,
    TaskStatus,
    TaskUpdate,
    WorkCapabilities,
    WorkChangeApply,
    WorkChangeApplyResult,
    WorkChangeCreate,
    WorkChangeProposalOut,
    WorkChangeRevise,
    WorkChangeSelection,
    WorkPlanCreate,
    WorkProposalApply,
    WorkProposalApplyResult,
    WorkProposalEdits,
    WorkProposalOut,
    WorkProposalRevise,
)
from app.work.permissions import EXPOSURE_HEADER, WorkPrincipal

router = APIRouter(prefix="/api", tags=["work"])

ContainerDep = Annotated[Container, Depends(get_container)]


def acting(action: Action) -> Callable[..., Awaitable[WorkPrincipal]]:
    """`require(action)` + the server-derived work principal (never a client-supplied actor or role)."""
    required = require(action)

    # A default (not `Annotated`): with postponed annotations a closure variable cannot be resolved by FastAPI.
    async def dependency(request: Request, user: UserContext = Depends(required)) -> WorkPrincipal:  # noqa: B008
        return await work_principal(request, get_container(request), user)

    return dependency


async def work_principal(
    request: Request, container: Container, user: UserContext, *, with_documents: bool = True
) -> WorkPrincipal:
    """THE one builder of a work principal (M6 routes and the M7 chat work skills alike): the server identity, the
    request id, the gateway exposure marker (which can only RESTRICT access) and the reader's current documents.
    `with_documents=False` (capability checks only, e.g. the skill catalog) leaves the documents unresolved."""
    return WorkPrincipal(
        user=user,
        request_id=request_id_of(request),
        exposed=bool(request.headers.get(EXPOSURE_HEADER)),
        exposure=(request.headers.get(EXPOSURE_HEADER) or "").strip().lower()[:32] or None,
        documents=await reader_documents(container, user) if with_documents else None,
    )


async def reader_documents(container: Container, user: UserContext) -> DocumentScope:
    """The documents this identity may read now — its own knowledge snapshot (the repository is the access
    boundary). Without `read_knowledge` the reader sees no document at all; a source that is down gives an
    «unavailable» scope (the work module keeps working, document facts are not shown)."""
    if not container.policy.allows(user, Action.read_knowledge):
        return DocumentScope(available=True, documents={}, generation=None)
    try:
        snapshot = await container.knowledge.snapshot(user)
    except RepositoryUnavailableError:
        return DocumentScope.unavailable()
    return DocumentScope.from_snapshot(snapshot, container.knowledge.generation_label(snapshot))


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
    document: Annotated[str | None, Query(max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")] = None,
    sort: Literal[
        "key", "title", "status", "priority", "start_date", "due_date", "updated_at", "sort_order"
    ] = "sort_order",
    order: Literal["asc", "desc"] = "asc",
    limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 200,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> TaskPage:
    """Filters: `status`/`priority` (comma lists), `assignee` (id or `none`), `parent` (id or `root`), `q` (title or
    key, case-insensitive), `milestone`, `scheduled`, `overdue`, `blocked`, `include_archived`, `document` (a linked
    document the reader can see; a hidden one matches nothing)."""
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
        document=document,
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


# --- dependencies ----------------------------------------------------------------------------------------------
@router.get("/tasks/{task_id}/dependencies", response_model=TaskDependencies)
def task_dependencies(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    task_id: str,
) -> TaskDependencies:
    return container.work.dependencies(principal, task_id)


@router.post("/tasks/{task_id}/dependencies", response_model=DependencyMutation, status_code=201)
def add_dependency(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.schedule_task))],
    task_id: str,
    body: DependencyCreate,
) -> DependencyMutation:
    """FS, lag 0, same project, acyclic. A dependency the current dates already violate is refused with
    `422 schedule_conflict` — add it through the schedule preview (`add_dependencies`) to shift the dependants."""
    return container.work.add_dependency(principal, task_id, body)


@router.delete("/tasks/{task_id}/dependencies/{dependency_id}", response_model=DependencyRemoved)
def remove_dependency(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.schedule_task))],
    task_id: str,
    dependency_id: str,
    expected_plan_revision: Annotated[int | None, Query(ge=1)] = None,
) -> DependencyRemoved:
    return container.work.remove_dependency(principal, task_id, dependency_id, expected_plan_revision)


# --- gantt / schedule ------------------------------------------------------------------------------------------
@router.get("/projects/{project_id}/gantt", response_model=GanttOut)
def project_gantt(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    project_id: str,
) -> GanttOut:
    """Tasks (tree order), dependencies and violations from ONE snapshot, with its `plan_revision`."""
    return container.work.gantt(principal, project_id)


@router.post("/projects/{project_id}/schedule/preview", response_model=SchedulePreview)
def schedule_preview(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.schedule_task))],
    project_id: str,
    body: SchedulePreviewRequest,
) -> SchedulePreview:
    """The consequences of a drag/resize or new dependencies BEFORE anything changes: operations (diff with
    reasons), conflicts, warnings, blocked (unscheduled) tasks. Writes no task, revision or audit event."""
    return container.work.preview(principal, project_id, body)


@router.post("/projects/{project_id}/schedule/apply", response_model=ScheduleApplyResult)
def schedule_apply(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.schedule_task))],
    project_id: str,
    body: ScheduleApplyRequest,
) -> ScheduleApplyResult:
    """Atomic apply of a confirmed preview: `409 stale_schedule` when anything changed since, `422 schedule_conflict`
    when it has conflicts or unaccepted warnings; a replay with the same `client_request_id` returns the first
    result (`replayed: true`) and writes nothing."""
    return container.work.apply(principal, project_id, body)


# --- task ↔ document links (Step 4) ----------------------------------------------------------------------------
@router.get("/tasks/{task_id}/links", response_model=TaskLinks)
def task_links(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    task_id: str,
) -> TaskLinks:
    """Documents of a task, read from the reader's CURRENT knowledge snapshot: title, status and revision now,
    `revision_changed` / `deprecated` marks; a document the reader cannot see is `unavailable` with no details."""
    return container.work.task_links(principal, task_id)


@router.post("/tasks/{task_id}/links", response_model=TaskLinkOut, status_code=201)
def link_document(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.edit_task))],
    task_id: str,
    body: TaskLinkCreate,
) -> TaskLinkOut:
    """Link to a document visible to the reader (`404` otherwise); the server records the revision it sees. Not a
    knowledge-graph relation: the document is never changed."""
    return container.work.link_document(principal, task_id, body)


@router.delete("/tasks/{task_id}/links/{link_id}", response_model=TaskLinkRemoved)
def unlink_document(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.edit_task))],
    task_id: str,
    link_id: Annotated[str, Path(max_length=64, pattern=r"^[A-Za-z0-9_-]+$")],
) -> TaskLinkRemoved:
    return container.work.unlink_document(principal, task_id, link_id)


@router.post("/tasks/{task_id}/links/{link_id}/acknowledge", response_model=TaskLinkOut)
def acknowledge_link(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.edit_task))],
    task_id: str,
    link_id: Annotated[str, Path(max_length=64, pattern=r"^[A-Za-z0-9_-]+$")],
) -> TaskLinkOut:
    """A person checked a changed document: the link records its current revision (never done automatically)."""
    return container.work.acknowledge_link(principal, task_id, link_id)


@router.get("/projects/{project_id}/documents", response_model=ProjectDocuments)
def project_documents(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    project_id: str,
) -> ProjectDocuments:
    """Documents linked to the project's tasks (visible ones only): the document filter of List / Board / Gantt."""
    return container.work.project_documents(principal, project_id)


@router.get("/documents/{document_id}/tasks", response_model=DocumentTasks)
def document_tasks(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.view_tasks))],
    document_id: Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")],
) -> DocumentTasks:
    """Back-links of a document: active tasks linked to it, from projects this reader may view. A document the
    reader cannot see is `404 document_not_found` (as for its links)."""
    ensure_allowed(container.policy, principal.user, Action.read_knowledge)
    return container.work.document_tasks(principal, document_id)


# --- AI task-plan proposals (Step 5) ---------------------------------------------------------------------------
ProposalId = Annotated[str, Path(min_length=5, max_length=40, pattern=r"^WAP-[0-9a-f]{16}$")]


@router.post("/work-ai/proposals", response_model=WorkProposalOut, status_code=201)
async def create_work_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    body: WorkPlanCreate,
) -> WorkProposalOut:
    """«AI план»: a typed task-plan PROPOSAL from documents of the knowledge base. Writes NO task: the proposal is
    stored for review. The gate is checked before any model call; `503 feature_unavailable` without a planning-capable
    AI provider; `422 proposal_invalid` when the model's plan has unknown ids or a cycle (nothing stored)."""
    return await container.work_ai.propose(principal, body)


@router.get("/work-ai/proposals/{proposal_id}", response_model=WorkProposalOut)
def get_work_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ProposalId,
) -> WorkProposalOut:
    """The proposal with its current state: `ready`, or `stale` with reasons (plan changed, a source document changed
    or is unavailable, expired) — a stale proposal cannot be applied."""
    return container.work_ai.get(principal, proposal_id)


@router.post("/work-ai/proposals/{proposal_id}/preview", response_model=WorkProposalOut)
def preview_work_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ProposalId,
    body: WorkProposalEdits,
) -> WorkProposalOut:
    """The reviewed plan (edits, dropped tasks/dependencies, start) with dates computed by the server; writes nothing."""
    return container.work_ai.preview(principal, proposal_id, body)


@router.post("/work-ai/proposals/{proposal_id}/apply", response_model=WorkProposalApplyResult)
def apply_work_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.apply_work_proposal))],
    proposal_id: ProposalId,
    body: WorkProposalApply,
) -> WorkProposalApplyResult:
    """Explicit Accept: the stored proposal + the person's edits, re-validated and written in ONE transaction (tasks,
    FS dependencies, links to its verified sources, audit). `409 proposal_stale` when anything it was based on
    changed; a replay with the same `client_request_id` returns the first result."""
    return container.work_ai.apply(principal, proposal_id, body)


@router.post("/work-ai/proposals/{proposal_id}/revise", response_model=WorkProposalOut, status_code=201)
async def revise_work_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ProposalId,
    body: WorkProposalRevise,
) -> WorkProposalOut:
    """M7 refinement: a NEW proposal from this one (its validated plan + the same sources) and the instruction. The
    refined proposal is never changed or applied; `409 proposal_stale` when it is applied / rejected / stale, all
    checked before any model call. A replay with the same `client_request_id` returns the proposal already stored."""
    idempotency = (
        Idempotency(
            scope=f"proposal_revise:{proposal_id}",
            key=body.client_request_id,
            request_hash=request_hash({"instruction": body.instruction}),
        )
        if body.client_request_id
        else None
    )
    return await container.work_ai.revise(principal, proposal_id, body.instruction, idempotency=idempotency)


@router.post("/work-ai/proposals/{proposal_id}/reject", response_model=WorkProposalOut)
def reject_work_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ProposalId,
) -> WorkProposalOut:
    """Reject: the proposal is closed; no task is created."""
    return container.work_ai.reject(principal, proposal_id)


# --- M7: change-set proposals for EXISTING tasks (docs/WORK_CHAT_SKILLS.md) --------------------------------------------
ChangeProposalId = Annotated[str, Path(min_length=5, max_length=40, pattern=r"^WCP-[0-9a-f]{16}$")]


@router.post("/work-ai/change-proposals", response_model=WorkChangeProposalOut, status_code=201)
async def create_change_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    body: WorkChangeCreate,
) -> WorkChangeProposalOut:
    """«Предложить изменения задач»: a typed change-set PROPOSAL for existing tasks (title, description, status,
    priority, due_date). Writes NO task. The gate (`propose_work` + `edit_task` on the project) is checked before any
    model call; `503 feature_unavailable` without a capable AI provider; `502 ai_invalid_response` for a malformed reply
    and `422 proposal_invalid` when nothing valid is left (nothing stored)."""
    return await container.work_changes.propose(principal, body)


@router.get("/work-ai/change-proposals/{proposal_id}", response_model=WorkChangeProposalOut)
def get_change_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ChangeProposalId,
) -> WorkChangeProposalOut:
    """The change-set with its CURRENT state: `ready`, or `stale` with reasons (the plan or a task changed, a task was
    archived or is no longer visible, a source changed, expired) — a stale change-set cannot be applied."""
    return container.work_changes.get(principal, proposal_id)


@router.post("/work-ai/change-proposals/{proposal_id}/preview", response_model=WorkChangeProposalOut)
def preview_change_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ChangeProposalId,
    body: WorkChangeSelection,
) -> WorkChangeProposalOut:
    """The change-set with only the chosen operations included, re-read from the current state; writes nothing."""
    return container.work_changes.preview(principal, proposal_id, body)


@router.post("/work-ai/change-proposals/{proposal_id}/apply", response_model=WorkChangeApplyResult)
def apply_change_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.apply_work_proposal))],
    proposal_id: ChangeProposalId,
    body: WorkChangeApply,
) -> WorkChangeApplyResult:
    """Explicit «Применить изменения»: the chosen operations, re-validated and written in ONE transaction (one version
    bump per task, one plan-revision bump, audit). `409 proposal_stale` when anything it was based on changed (nothing
    written); a replay with the same `client_request_id` returns the first result."""
    ensure_allowed(container.policy, principal.user, Action.edit_task)
    return container.work_changes.apply(principal, proposal_id, body)


@router.post(
    "/work-ai/change-proposals/{proposal_id}/revise", response_model=WorkChangeProposalOut, status_code=201
)
async def revise_change_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ChangeProposalId,
    body: WorkChangeRevise,
) -> WorkChangeProposalOut:
    """A NEW change-set from this one and the instruction; this one is never changed or applied."""
    idempotency = (
        Idempotency(
            scope=f"change_revise:{proposal_id}",
            key=body.client_request_id,
            request_hash=request_hash({"instruction": body.instruction}),
        )
        if body.client_request_id
        else None
    )
    return await container.work_changes.revise(
        principal, proposal_id, body.instruction, idempotency=idempotency
    )


@router.post("/work-ai/change-proposals/{proposal_id}/reject", response_model=WorkChangeProposalOut)
def reject_change_proposal(
    container: ContainerDep,
    principal: Annotated[WorkPrincipal, Depends(acting(Action.propose_work))],
    proposal_id: ChangeProposalId,
) -> WorkChangeProposalOut:
    """Reject: the change-set is closed; no task changes. A second reject is `409 proposal_stale`."""
    return container.work_changes.reject(principal, proposal_id)
