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
from app.services.discovery import acl_scope_key

router = APIRouter(prefix="/api/graph", tags=["graph"])

NODE_ID_PATTERN = r"^[A-Za-z_]+:[A-Za-z0-9_.:@-]+$"
NodeIdPath = Annotated[str, Path(min_length=3, max_length=200, pattern=NODE_ID_PATTERN)]
NodeIdQuery = Annotated[str, Query(min_length=3, max_length=200, pattern=NODE_ID_PATTERN)]


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
    feedback: str | None = None
    provenance: list[str] = []


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
    return GraphEdgeOut(**{**e.__dict__, "provenance": list(e.provenance)})


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
    source: NodeIdQuery,
    target: NodeIdQuery,
    max_depth: Annotated[int, Query(ge=1, le=100)] = g.PATH_DEPTH_MAX,
    directed: bool = False,
    relation: Annotated[str | None, Query(max_length=300)] = None,
) -> PathOut:
    graph = await container.graph.graph(user)
    if source not in graph.nodes or target not in graph.nodes:
        # As /neighbors: a node that is unknown or not visible is an error, never «no path» (audit SYS-001).
        raise ApiError(404, "graph_node_not_found", "Узел графа не найден.")
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


QUERY_EXTERNAL_REVALIDATE = 6
QUERY_CONTEXT_NEIGHBOURS = 10


@router.get("/query/{trace_id}", response_model=SubgraphOut)
async def query_graph(
    trace_id: Annotated[str, Path(pattern=r"^TRACE-[0-9a-f]{16}$")],
    container: Annotated[Container, Depends(get_container)],
    user: Annotated[UserContext, Depends(require(Action.read_knowledge))],
) -> SubgraphOut:
    """Evidence graph of ONE answer: question → sources found / used / cited → related documents.

    Visible only within the requester's scope. External pages are re-validated now (still readable, same
    version); a revoked, deleted or changed page is hidden — node, edges and counts — and its discovery
    links are invalidated. Local documents that left the knowledge base are hidden too."""
    if container.discovery is None:
        raise ApiError(503, "discovery_disabled", "Память поиска отключена конфигурацией.")
    trace = container.discovery.trace(trace_id, acl_scope_key(user))
    if trace is None:
        raise ApiError(404, "trace_not_found", "След запроса не найден или срок хранения истёк.")
    graph = await container.graph.graph(user)
    query_node = g.GraphNode(
        id=f"query:{trace.trace_id}",
        kind="query_context",
        label="Вопрос"
        + (f": {trace.query_text[:80]}" if trace.query_text else f" ({', '.join(trace.intent[:5])})"),
        source_kind="query_trace",
        expires_at=trace.expires_at,
    )
    nodes: dict[str, g.GraphNode] = {query_node.id: query_node}
    edges: list[g.GraphEdge] = []
    cited_docs: list[str] = []
    revalidated = 0
    for source in trace.sources:
        if source["source_kind"] == "confluence_mcp":
            if revalidated >= QUERY_EXTERNAL_REVALIDATE:
                continue
            revalidated += 1
            ok = container.external is not None and await container.external.revalidate(
                user, source["page_id"], source["version"]
            )
            if not ok:
                base = source["source_id"].rsplit(":", 1)[0]
                container.discovery.invalidate_source(base, "revoked_deleted_or_changed")
                continue
            node = g.GraphNode(
                id=f"ext:{source['source_id']}",
                kind="external_page",
                label=source["title"],
                source_kind="confluence_mcp",
                status=source["status"] or "unknown",
                version=source["version"],
                url=f"/corporate/{source['page_id']}",
                synthetic=True,
                expires_at=source["expires_at"],
            )
        else:
            document_id = source["source_id"].split(":", 1)[1]
            existing = graph.nodes.get(g.doc_node_id(document_id))
            if existing is None:
                continue  # left the knowledge base since the answer
            node = existing
            if source["cited"]:
                cited_docs.append(node.id)
        nodes[node.id] = node
        edges.append(
            g.GraphEdge(
                id=f"edge:{trace.trace_id}:retrieved_for:{node.id}",
                source=node.id,
                target=query_node.id,
                type="retrieved_for",
                origin="query_trace",
                verified=False,
                declared_in=None,
                field=", ".join(source["fragment_ids"][:6]) or None,
                path=None,
                revision=source["version"],
                expires_at=source["expires_at"],
                feedback=source["feedback"],
            )
        )
        if source["cited"]:
            edges.append(
                g.GraphEdge(
                    id=f"edge:{trace.trace_id}:cited_in:{node.id}",
                    source=node.id,
                    target=query_node.id,
                    type="cited_in",
                    origin="query_trace",
                    verified=True,
                    declared_in=None,
                    field=None,
                    path=None,
                    revision=source["version"],
                    expires_at=source["expires_at"],
                    feedback=source["feedback"],
                )
            )
    # Related documents of the cited ones (declared edges only), bounded.
    added = 0
    for doc_node in cited_docs:
        for edge in [*graph.out_adj.get(doc_node, []), *graph.in_adj.get(doc_node, [])]:
            other = edge.target if edge.source == doc_node else edge.source
            if other not in nodes and added < QUERY_CONTEXT_NEIGHBOURS and other in graph.nodes:
                nodes[other] = graph.nodes[other]
                added += 1
    edges += [e for e in graph.edges if e.source in nodes and e.target in nodes]
    return _subgraph(
        g.Subgraph(
            nodes=list(nodes.values()),
            edges=edges,
            total_nodes=len(nodes),
            total_edges=len(edges),
            partial=False,
            generation=graph.generation,
            focus=query_node.id,
        )
    )
