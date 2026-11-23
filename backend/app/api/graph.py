"""Knowledge graph API (read-only, bounded): overview, neighbourhood, path, legend.

All limits are enforced here regardless of what the client asks for (`limit=99999999` is clamped).
Nodes come only from the requester's knowledge snapshot, so the graph never shows what the catalog would
not show. Query/evidence overlays live in app.api.discovery.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel

from app.api.deps import get_container
from app.authz import Action, require
from app.container import Container
from app.domain.models import DocStatus, DocType, RelationType, UserContext
from app.errors import ApiError
from app.services import graph as g

router = APIRouter(prefix="/api/graph", tags=["graph"])

NodeIdPath = Annotated[str, Path(min_length=3, max_length=200, pattern=r"^[A-Za-z_]+:[A-Za-z0-9_.:@-]+$")]


class GraphNodeOut(BaseModel):
    id: str
    kind: str
    label: str
    document_id: str | None
    doc_type: str | None
    status: str | None
    owner: str | None
    source_kind: str
    revision: str | None
    version: str | None
    url: str | None
    synthetic: bool
    expires_at: str | None
    degree: int


class GraphEdgeOut(BaseModel):
    id: str
    source: str
    target: str
    type: str
    origin: str
    verified: bool
    declared_in: str | None
    field: str | None
    path: str | None
    revision: str | None
    status: str
    expires_at: str | None


class SubgraphOut(BaseModel):
    nodes: list[GraphNodeOut]
    edges: list[GraphEdgeOut]
    total_nodes: int
    total_edges: int
    partial: bool
    generation: str
    next_cursor: int | None = None
    focus: str | None = None
    limits: dict[str, int]


class PathOut(BaseModel):
    found: bool
    nodes: list[GraphNodeOut]
    edges: list[GraphEdgeOut]
    generation: str


class LegendOut(BaseModel):
    kinds: dict[str, str]
    relations: dict[str, str]
    origins: dict[str, str]
    limits: dict[str, int]


class DiagnosticsOut(BaseModel):
    generation: str
    nodes: int
    edges: int
    edges_by_type: dict[str, int]
    dangling: list[GraphEdgeOut]
    orphans: list[str]


LIMITS = {
    "overview_default": g.OVERVIEW_DEFAULT,
    "overview_max": g.OVERVIEW_MAX,
    "neighbours_max": g.NEIGHBOURS_MAX,
    "depth_max": g.DEPTH_MAX,
    "path_depth_max": g.PATH_DEPTH_MAX,
}


def _node(n: g.GraphNode) -> GraphNodeOut:
    return GraphNodeOut(**n.__dict__)


def _edge(e: g.GraphEdge) -> GraphEdgeOut:
    return GraphEdgeOut(**e.__dict__)


def _subgraph(s: g.Subgraph) -> SubgraphOut:
    return SubgraphOut(
        nodes=[_node(n) for n in s.nodes],
        edges=[_edge(e) for e in s.edges],
        total_nodes=s.total_nodes,
        total_edges=s.total_edges,
        partial=s.partial,
        generation=s.generation,
        next_cursor=s.next_cursor,
        focus=s.focus,
        limits=LIMITS,
    )


def _csv(value: str | None, allowed: set[str], name: str) -> frozenset[str] | None:
    if not value:
        return None
    items = {v.strip() for v in value.split(",") if v.strip()}
    unknown = items - allowed
    if unknown:
        raise ApiError(
            400, "invalid_filter", f"Недопустимое значение фильтра {name}: {', '.join(sorted(unknown))}."
        )
    return frozenset(items)


_KINDS = set(g.KIND_LABELS)
_RELATIONS = {r.value for r in RelationType}
_STATUSES = {s.value for s in DocStatus}
_TYPES = {t.value for t in DocType}


def _filter(
    kind: str | None, relation: str | None, status: str | None, type_: str | None, q: str, deprecated: bool
) -> g.GraphFilter:
    return g.GraphFilter(
        kinds=_csv(kind, _KINDS, "kind"),
        relations=_csv(relation, _RELATIONS, "relation"),
        statuses=_csv(status, _STATUSES, "status"),
        doc_types=_csv(type_, _TYPES, "type"),
        query=q.strip(),
        include_deprecated=deprecated,
    )


@router.get("/legend", response_model=LegendOut)
async def legend(user: Annotated[UserContext, Depends(require(Action.read_knowledge))]) -> LegendOut:
    return LegendOut(kinds=g.KIND_LABELS, relations=g.RELATION_LABELS, origins=g.ORIGIN_LABELS, limits=LIMITS)


@router.get("/overview", response_model=SubgraphOut)
async def overview(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    limit: Annotated[int, Query(ge=1, le=100_000)] = g.OVERVIEW_DEFAULT,
    kind: Annotated[str | None, Query(max_length=200)] = None,
    relation: Annotated[str | None, Query(max_length=300)] = None,
    status: Annotated[str | None, Query(max_length=200)] = None,
    type: Annotated[str | None, Query(max_length=200)] = None,
    q: Annotated[str, Query(max_length=100)] = "",
    deprecated: bool = True,
) -> SubgraphOut:
    graph = await container.graph.graph(user)
    return _subgraph(g.overview(graph, _filter(kind, relation, status, type, q, deprecated), limit))


@router.get("/nodes/{node_id}/neighbors", response_model=SubgraphOut)
async def neighbours(
    node_id: NodeIdPath,
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    depth: Annotated[int, Query(ge=1, le=100)] = 1,
    direction: Literal["out", "in", "both"] = "both",
    relation: Annotated[str | None, Query(max_length=300)] = None,
    limit: Annotated[int, Query(ge=1, le=100_000)] = 100,
    cursor: Annotated[int, Query(ge=0, le=100_000)] = 0,
    deprecated: bool = True,
) -> SubgraphOut:
    graph = await container.graph.graph(user)
    flt = _filter(None, relation, None, None, "", deprecated)
    result = g.neighbours(
        graph, node_id, depth=depth, direction=direction, flt=flt, limit=limit, cursor=cursor
    )
    if result is None:
        # Unknown and not-visible nodes are indistinguishable on purpose.
        raise ApiError(404, "graph_node_not_found", "Узел графа не найден.")
    return _subgraph(result)


@router.get("/path", response_model=PathOut)
async def path(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
    source: Annotated[str, Query(min_length=3, max_length=200)],
    target: Annotated[str, Query(min_length=3, max_length=200)],
    max_depth: Annotated[int, Query(ge=1, le=100)] = g.PATH_DEPTH_MAX,
    directed: bool = False,
    relation: Annotated[str | None, Query(max_length=300)] = None,
) -> PathOut:
    graph = await container.graph.graph(user)
    flt = _filter(None, relation, None, None, "", True)
    chain = g.shortest_path(graph, source, target, max_depth=max_depth, directed=directed, flt=flt)
    if not chain:
        start = [graph.nodes[source]] if source == target and source in graph.nodes else []
        return PathOut(
            found=bool(start), nodes=[_node(n) for n in start], edges=[], generation=graph.generation
        )
    node_ids = [source]
    for edge in chain:
        node_ids.append(edge.target if edge.source == node_ids[-1] else edge.source)
    return PathOut(
        found=True,
        nodes=[_node(graph.nodes[i]) for i in node_ids],
        edges=[_edge(e) for e in chain],
        generation=graph.generation,
    )


@router.get("/diagnostics", response_model=DiagnosticsOut)
async def diagnostics(
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> DiagnosticsOut:
    graph = await container.graph.graph(user)
    counts: dict[str, int] = {}
    for edge in graph.edges:
        counts[edge.type] = counts.get(edge.type, 0) + 1
    linked = {e.source for e in graph.edges} | {e.target for e in graph.edges}
    orphans = sorted(n.document_id for n in graph.nodes.values() if n.document_id and n.id not in linked)
    return DiagnosticsOut(
        generation=graph.generation,
        nodes=len(graph.nodes),
        edges=len(graph.edges),
        edges_by_type=dict(sorted(counts.items())),
        dangling=[_edge(e) for e in graph.dangling[:200]],
        orphans=orphans,
    )
