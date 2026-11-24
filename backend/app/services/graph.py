"""Knowledge graph: typed, directed, provenance-carrying edges between documents (and templates).

The canonical graph is a projection of ONE knowledge snapshot (the same one the catalog and the search
index serve): nodes are documents the user may read, edges are relations the documents DECLARE in their
frontmatter (`relations:` / `related_ids`). Nothing is inferred from free text or by a model. Edges whose
target is missing are kept apart as `dangling` diagnostics and never returned as active edges.

Temporary overlays (external Confluence pages and query evidence, M5.6.2 §G) are merged at read time by
the caller and are never written into the canonical graph.

Every API result is bounded: overview ≤ 200 nodes, neighbourhood depth ≤ 2, path depth ≤ 6.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from app.adapters.knowledge.base import KnowledgeSnapshot
from app.domain.models import (
    DeclaredRelation,
    DocStatus,
    DocType,
    DocumentRecord,
    RelationType,
    UserContext,
)

if TYPE_CHECKING:
    from app.services.knowledge import KnowledgeService

NodeKind = Literal[
    "document",
    "source_system",
    "integration",
    "semantic_entity",
    "dataset",
    "template",
    "external_page",
    "query_context",
]
EdgeOrigin = Literal[
    "canonical_metadata", "verified_registry", "external_discovery", "query_trace", "ai_suggestion"
]
Direction = Literal["out", "in", "both"]

OVERVIEW_DEFAULT = 150
OVERVIEW_MAX = 200
NEIGHBOURS_MAX = 200
DEPTH_MAX = 2
PATH_DEPTH_MAX = 6

KIND_BY_TYPE: dict[DocType, NodeKind] = {
    DocType.source: "source_system",
    DocType.integration: "integration",
    DocType.domain: "semantic_entity",
    DocType.dataset: "dataset",
}

KIND_LABELS: dict[str, str] = {
    "document": "Документ",
    "source_system": "Система-источник",
    "integration": "Интеграция",
    "semantic_entity": "Сущность / модель",
    "dataset": "Датасет",
    "template": "Шаблон",
    "external_page": "Внешняя страница Confluence",
    "query_context": "Контекст вопроса",
}
RELATION_LABELS: dict[str, str] = {
    RelationType.references.value: "ссылается на",
    RelationType.depends_on.value: "зависит от",
    RelationType.consumes.value: "получает данные из",
    RelationType.produces.value: "создаёт / наполняет",
    RelationType.maps_to.value: "отображается в",
    RelationType.derived_from.value: "построен на основе",
    RelationType.describes.value: "описывает",
    RelationType.constrains.value: "ограничивает",
    RelationType.supersedes.value: "заменяет",
    RelationType.uses_template.value: "использует шаблон",
    "retrieved_for": "найдена для вопроса",
    "cited_in": "процитирована в ответе",
}
ORIGIN_LABELS: dict[str, str] = {
    "canonical_metadata": "Подтверждённая связь из метаданных документа",
    "verified_registry": "Связь из реестра шаблонов",
    "external_discovery": "Временная связь: найдено во внешнем источнике",
    "query_trace": "След конкретного вопроса: найдено / использовано / процитировано",
    "ai_suggestion": "Предложение ИИ (не подтверждено)",
}


@dataclass(frozen=True)
class GraphNode:
    id: str
    kind: NodeKind
    label: str
    document_id: str | None = None
    doc_type: str | None = None
    status: str | None = None
    owner: str | None = None
    source_kind: str = "local_markdown"
    revision: str | None = None
    version: str | None = None
    url: str | None = None
    synthetic: bool = False
    expires_at: str | None = None
    degree: int = 0


@dataclass(frozen=True)
class GraphEdge:
    id: str
    source: str
    target: str
    type: str
    origin: EdgeOrigin
    verified: bool
    declared_in: str | None  # document id that declares the edge
    field: str | None  # frontmatter field (provenance)
    path: str | None  # repository-relative file
    revision: str | None  # revision of the declaring document
    status: Literal["active", "dangling"] = "active"
    expires_at: str | None = None
    feedback: str | None = None  # query edges: relevant / irrelevant / unsure / unrated
    # Every place that declares this edge: `related_ids`, `relations.<type>`, `body:<line>` (WikiLink).
    provenance: tuple[str, ...] = ()


@dataclass
class CanonicalGraph:
    generation: str
    nodes: dict[str, GraphNode]
    edges: list[GraphEdge]
    dangling: list[GraphEdge]
    out_adj: dict[str, list[GraphEdge]] = field(default_factory=dict)
    in_adj: dict[str, list[GraphEdge]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for edge in self.edges:
            self.out_adj.setdefault(edge.source, []).append(edge)
            self.in_adj.setdefault(edge.target, []).append(edge)


def doc_node_id(document_id: str) -> str:
    return f"doc:{document_id}"


def template_node_id(template_id: str) -> str:
    return f"template:{template_id}"


def _node_for(doc: DocumentRecord) -> GraphNode:
    return GraphNode(
        id=doc_node_id(doc.id),
        kind=KIND_BY_TYPE.get(doc.type, "document"),
        label=doc.title,
        document_id=doc.id,
        doc_type=doc.type.value,
        status=doc.status.value,
        owner=doc.owner,
        source_kind="gitlab_approved" if doc.source == "gitlab" else "local_markdown",
        revision=doc.revision,
        version=doc.version,
        url=f"/documents/{doc.id}",
        synthetic=doc.synthetic or doc.is_demo,
    )


def build_canonical_graph(
    snapshot: KnowledgeSnapshot, generation: str, templates: dict[str, tuple[str, int]] | None = None
) -> CanonicalGraph:
    """`templates`: registry entries template_id -> (title, current version)."""
    docs = {d.id.lower(): d for d in snapshot.documents.values()}
    nodes: dict[str, GraphNode] = {doc_node_id(d.id): _node_for(d) for d in docs.values()}
    for template_id, (title, version) in (templates or {}).items():
        nodes[template_node_id(template_id)] = GraphNode(
            id=template_node_id(template_id),
            kind="template",
            label=f"{title} (v{version})",
            source_kind="template_registry",
            version=str(version),
            url="/documents/new",
        )
    edges: list[GraphEdge] = []
    dangling: list[GraphEdge] = []
    for doc in sorted(docs.values(), key=lambda d: d.id):
        source_id = doc_node_id(doc.id)
        # One edge per (source, type, target); every declaring place is kept as provenance, so a
        # `related_ids` entry and an inline WikiLink to the same document are shown once.
        pending: dict[tuple[str, str], tuple[DeclaredRelation, list[str]]] = {}
        for rel in doc.relations:
            where = f"body:{rel.line}" if rel.field == "body" and rel.line else rel.field
            key = (rel.type.value, rel.target.lower())
            if key in pending:
                pending[key][1].append(where)
            else:
                pending[key] = (rel, [where])
        for rel, provenance in pending.values():
            target_doc = docs.get(rel.target.lower())
            target_id = doc_node_id(target_doc.id if target_doc else rel.target)
            edge = GraphEdge(
                id=f"edge:{doc.id}:{rel.type.value}:{target_doc.id if target_doc else rel.target}",
                source=source_id,
                target=target_id,
                type=rel.type.value,
                origin="canonical_metadata",
                verified=True,
                declared_in=doc.id,
                field=rel.field,
                path=doc.path,
                revision=doc.revision,
                status="active" if target_doc else "dangling",
                provenance=tuple(dict.fromkeys(provenance)),
            )
            (edges if target_doc else dangling).append(edge)
        if doc.template_id and template_node_id(doc.template_id) in nodes:
            edges.append(
                GraphEdge(
                    id=f"edge:{doc.id}:uses_template:{doc.template_id}",
                    source=source_id,
                    target=template_node_id(doc.template_id),
                    type=RelationType.uses_template.value,
                    origin="verified_registry",
                    verified=True,
                    declared_in=doc.id,
                    field="template",
                    path=doc.path,
                    revision=doc.revision,
                )
            )
    degree: dict[str, int] = {}
    for edge in edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1
    nodes = {k: _with_degree(n, degree.get(k, 0)) for k, n in nodes.items()}
    return CanonicalGraph(generation=generation, nodes=nodes, edges=edges, dangling=dangling)


def _with_degree(node: GraphNode, degree: int) -> GraphNode:
    return GraphNode(**{**node.__dict__, "degree": degree})


@dataclass(frozen=True)
class GraphFilter:
    kinds: frozenset[str] | None = None
    statuses: frozenset[str] | None = None
    doc_types: frozenset[str] | None = None
    relations: frozenset[str] | None = None
    query: str = ""
    include_deprecated: bool = True

    def node_ok(self, node: GraphNode) -> bool:
        if self.kinds is not None and node.kind not in self.kinds:
            return False
        if self.statuses is not None and node.status is not None and node.status not in self.statuses:
            return False
        if self.doc_types is not None and node.doc_type is not None and node.doc_type not in self.doc_types:
            return False
        if not self.include_deprecated and node.status == DocStatus.deprecated.value:
            return False
        if self.query:
            needle = self.query.casefold()
            haystack = f"{node.label} {node.document_id or ''}".casefold()
            return needle in haystack
        return True

    def edge_ok(self, edge: GraphEdge) -> bool:
        return self.relations is None or edge.type in self.relations


@dataclass
class Subgraph:
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    total_nodes: int
    total_edges: int
    partial: bool
    generation: str
    next_cursor: int | None = None
    focus: str | None = None


def overview(graph: CanonicalGraph, flt: GraphFilter, limit: int = OVERVIEW_DEFAULT) -> Subgraph:
    limit = max(1, min(limit, OVERVIEW_MAX))
    candidates = [n for n in graph.nodes.values() if flt.node_ok(n)]
    # Most connected first: the overview shows the backbone; the rest is reached by search / expansion.
    candidates.sort(key=lambda n: (-n.degree, n.kind, n.label.casefold(), n.id))
    chosen = candidates[:limit]
    ids = {n.id for n in chosen}
    edges = [e for e in graph.edges if e.source in ids and e.target in ids and flt.edge_ok(e)]
    matching_edges = [
        e
        for e in graph.edges
        if flt.edge_ok(e) and flt.node_ok(graph.nodes[e.source]) and flt.node_ok(graph.nodes[e.target])
    ]
    return Subgraph(
        nodes=chosen,
        edges=edges,
        total_nodes=len(candidates),
        total_edges=len(matching_edges),
        partial=len(candidates) > len(chosen),
        generation=graph.generation,
    )


def _adjacent(graph: CanonicalGraph, node_id: str, direction: Direction, flt: GraphFilter) -> list[GraphEdge]:
    out = graph.out_adj.get(node_id, []) if direction in ("out", "both") else []
    inc = graph.in_adj.get(node_id, []) if direction in ("in", "both") else []
    return [e for e in (*out, *inc) if flt.edge_ok(e)]


def neighbours(
    graph: CanonicalGraph,
    node_id: str,
    *,
    depth: int = 1,
    direction: Direction = "both",
    flt: GraphFilter | None = None,
    limit: int = 100,
    cursor: int = 0,
) -> Subgraph | None:
    """Bounded BFS around a node. Pagination is over the discovered neighbour list (stable order)."""
    if node_id not in graph.nodes:
        return None
    flt = flt or GraphFilter()
    depth = max(1, min(depth, DEPTH_MAX))
    limit = max(1, min(limit, NEIGHBOURS_MAX))
    seen = {node_id}
    order: list[str] = []
    frontier = deque([(node_id, 0)])
    while frontier:
        current, level = frontier.popleft()
        if level >= depth:
            continue
        for edge in sorted(_adjacent(graph, current, direction, flt), key=lambda e: e.id):
            other = edge.target if edge.source == current else edge.source
            if other in seen or other not in graph.nodes or not flt.node_ok(graph.nodes[other]):
                continue
            seen.add(other)
            order.append(other)
            frontier.append((other, level + 1))
    page = order[cursor : cursor + limit]
    ids = {node_id, *page}
    edges = [e for e in graph.edges if e.source in ids and e.target in ids and flt.edge_ok(e)]
    nodes = [graph.nodes[node_id], *(graph.nodes[i] for i in page)]
    next_cursor = cursor + limit if cursor + limit < len(order) else None
    return Subgraph(
        nodes=nodes,
        edges=edges,
        total_nodes=len(order) + 1,
        total_edges=len(edges),
        partial=next_cursor is not None,
        generation=graph.generation,
        next_cursor=next_cursor,
        focus=node_id,
    )


def shortest_path(
    graph: CanonicalGraph,
    source: str,
    target: str,
    *,
    max_depth: int = PATH_DEPTH_MAX,
    directed: bool = False,
    flt: GraphFilter | None = None,
) -> list[GraphEdge] | None:
    """Shortest chain of declared edges (undirected by default). None if no path within max_depth."""
    if source not in graph.nodes or target not in graph.nodes:
        return None
    flt = flt or GraphFilter()
    max_depth = max(1, min(max_depth, PATH_DEPTH_MAX))
    previous: dict[str, tuple[str, GraphEdge] | None] = {source: None}
    frontier = deque([(source, 0)])
    while frontier:
        current, level = frontier.popleft()
        if current == target:
            break
        if level >= max_depth:
            continue
        for edge in sorted(_adjacent(graph, current, "out" if directed else "both", flt), key=lambda e: e.id):
            other = edge.target if edge.source == current else edge.source
            if other in previous or not flt.node_ok(graph.nodes[other]):
                continue
            previous[other] = (current, edge)
            frontier.append((other, level + 1))
    if target not in previous:
        return None
    chain: list[GraphEdge] = []
    node = target
    while (step := previous[node]) is not None:
        node, edge = step
        chain.append(edge)
    return list(reversed(chain))


class GraphService:
    """Caches the canonical graph per knowledge generation (one rebuild per snapshot change)."""

    def __init__(
        self, knowledge: KnowledgeService, templates: Callable[[], dict[str, tuple[str, int]]]
    ) -> None:
        self._knowledge = knowledge
        self._templates = templates
        self._cache: tuple[tuple[str, str], CanonicalGraph] | None = None

    async def graph(self, user: UserContext) -> CanonicalGraph:
        snapshot = await self._knowledge.snapshot(user)
        templates = self._templates()
        generation = self._knowledge.generation_label(snapshot)
        key = (generation, repr(sorted(templates.items())))
        if self._cache is None or self._cache[0] != key:
            self._cache = (key, build_canonical_graph(snapshot, generation, templates))
        return self._cache[1]
