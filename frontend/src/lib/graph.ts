import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphFeedback, GraphLegend, GraphNode, GraphOrigin, GraphSourceKind, Subgraph } from "../api/types";
import { STATUS_LABEL } from "./labels";

// --- labels (the legend endpoint is authoritative; these are the offline fallback and must match it) ---

export const KIND_LABEL: Record<string, string> = {
  document: "Документ",
  source_system: "Система-источник",
  integration: "Интеграция",
  semantic_entity: "Сущность / модель",
  dataset: "Датасет",
  template: "Шаблон",
  external_page: "Внешняя страница Confluence",
  query_context: "Контекст вопроса",
};

export const RELATION_LABEL: Record<string, string> = {
  references: "ссылается на",
  depends_on: "зависит от",
  consumes: "получает данные из",
  produces: "создаёт / наполняет",
  maps_to: "отображается в",
  derived_from: "построен на основе",
  describes: "описывает",
  constrains: "ограничивает",
  supersedes: "заменяет",
  uses_template: "использует шаблон",
  retrieved_for: "найдена для вопроса",
  cited_in: "процитирована в ответе",
};

export const ORIGIN_LABEL: Record<string, string> = {
  canonical_metadata: "Подтверждённая связь из метаданных документа",
  verified_registry: "Связь из реестра шаблонов",
  external_discovery: "Временная связь: найдено во внешнем источнике",
  query_trace: "След конкретного вопроса: найдено / использовано / процитировано",
  ai_suggestion: "Предложение ИИ (не подтверждено)",
};

export const SOURCE_KIND_LABEL: Record<GraphSourceKind, string> = {
  local_markdown: "Локальный workspace (Markdown)",
  gitlab_approved: "GitLab, утверждённая ветка",
  template_registry: "Реестр шаблонов",
  confluence_mcp: "Confluence через MCP, только чтение",
  query_trace: "След ответа (временный)",
};

export const FEEDBACK_LABEL: Record<GraphFeedback, string> = {
  relevant: "подошёл",
  irrelevant: "не подошёл",
  unsure: "не уверен",
  unrated: "без отзыва",
};

/** Edges that are not confirmed knowledge: drawn dashed, labelled as temporary or unconfirmed. */
const UNCONFIRMED_ORIGINS = new Set<string>(["query_trace", "external_discovery", "ai_suggestion"]);
export const isUnconfirmedEdge = (edge: Pick<GraphEdge, "origin">): boolean => UNCONFIRMED_ORIGINS.has(edge.origin);

export const KIND_ORDER = Object.keys(KIND_LABEL);
export const ORIGIN_ORDER: GraphOrigin[] = [
  "canonical_metadata",
  "verified_registry",
  "external_discovery",
  "query_trace",
  "ai_suggestion",
];

export interface GraphLabels {
  kind: (kind: string) => string;
  relation: (type: string) => string;
  origin: (origin: string) => string;
}

export function graphLabels(legend: GraphLegend | null): GraphLabels {
  return {
    kind: (kind) => legend?.kinds[kind] ?? KIND_LABEL[kind] ?? kind,
    relation: (type) => legend?.relations[type] ?? RELATION_LABEL[type] ?? type,
    origin: (origin) => legend?.origins[origin] ?? ORIGIN_LABEL[origin] ?? origin,
  };
}

/** Status in words. An external page's own status is never presented as approved team knowledge. */
export function nodeStatusText(node: GraphNode): string | null {
  if (node.kind === "external_page") {
    if (node.status === "approved") return "Confluence: утверждена (статус не подтверждён командой)";
    if (node.status === "draft") return "Confluence: черновик, статус не подтверждён";
    return "статус не подтверждён";
  }
  if (!node.status) return null;
  return STATUS_LABEL[node.status as keyof typeof STATUS_LABEL] ?? node.status;
}

/** CSS modifier for the outline of a node: solid approved, dotted in review, dashed draft, struck deprecated. */
export function nodeStatusClass(node: GraphNode): string {
  if (node.kind === "external_page") return "external";
  if (node.kind === "query_context") return "query";
  if (node.kind === "template") return "template";
  return node.status && node.status in STATUS_LABEL ? node.status : "none";
}

/** ID shown to people: the document ID, otherwise the node ID without the `doc:` prefix. */
export function nodeDisplayId(node: GraphNode): string {
  return node.document_id ?? node.id;
}

/** Only canonical nodes (documents and templates) have a neighbourhood on the server. */
export function canExpand(node: GraphNode): boolean {
  return node.id.startsWith("doc:") || node.id.startsWith("template:");
}

/** URL value for `?focus=`: the plain document ID for documents, the node ID otherwise. */
export function focusParam(node: GraphNode): string {
  return node.id.startsWith("doc:") && node.document_id ? node.document_id : node.id;
}

// --- URL state ---------------------------------------------------------------------------------------

export const TRACE_PATTERN = /^TRACE-[0-9a-f]{16}$/;

export type GraphMode =
  | { kind: "global" }
  | { kind: "local"; focus: string; depth: 1 | 2 }
  | { kind: "trace"; trace: string };

/** Reads the mode from the URL. Only IDs go into the URL — never the text of a question. */
export function graphModeFrom(params: URLSearchParams): GraphMode {
  const trace = params.get("trace");
  if (trace) return { kind: "trace", trace };
  const focus = params.get("focus")?.trim();
  if (focus) {
    return { kind: "local", focus: focus.includes(":") ? focus : `doc:${focus}`, depth: params.get("depth") === "2" ? 2 : 1 };
  }
  return { kind: "global" };
}

export interface GraphFilters {
  kind: string;
  relation: string;
  status: string;
}

export function graphFiltersFrom(params: URLSearchParams): GraphFilters {
  return { kind: params.get("kind") ?? "", relation: params.get("relation") ?? "", status: params.get("status") ?? "" };
}

// --- merging pages and client-side filters ------------------------------------------------------------

export function mergeSubgraphs(base: Subgraph, pages: Subgraph[]): Subgraph {
  const last = pages[pages.length - 1];
  if (!last) return base;
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const edges = new Map(base.edges.map((e) => [e.id, e]));
  for (const page of pages) {
    for (const n of page.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of page.edges) if (!edges.has(e.id)) edges.set(e.id, e);
  }
  return {
    ...base,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    partial: last.partial,
    next_cursor: last.next_cursor,
    total_nodes: Math.max(base.total_nodes, last.total_nodes),
  };
}

/**
 * Applies kind / status / relation filters on the client (the overview is also filtered by the server).
 * The centre node (focus or question) always stays; edges keep only visible ends.
 */
export function filterGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  filters: GraphFilters,
  keep: string | null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const visible = nodes.filter(
    (n) =>
      n.id === keep ||
      // As on the server: a node without a status (a template) is not hidden by a status filter.
      ((!filters.kind || n.kind === filters.kind) && (!filters.status || n.status === null || n.status === filters.status)),
  );
  const ids = new Set(visible.map((n) => n.id));
  return {
    nodes: visible,
    edges: edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target) && (!filters.relation || e.type === filters.relation),
    ),
  };
}

// --- layout ------------------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Layout {
  positions: Map<string, Point>;
  radius: Map<string, number>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  r: number;
}

const LAYOUT_TICKS = 300;

export function nodeRadius(node: GraphNode, localDegree: number, central: boolean): number {
  if (central) return 15;
  const degree = Math.max(node.degree, localDegree);
  return Math.round((7 + Math.min(8, Math.sqrt(degree) * 1.7)) * 10) / 10;
}

/**
 * Force-directed layout computed synchronously for a fixed number of ticks (no animation, deterministic:
 * d3 places new nodes on a phyllotaxis spiral by input order). The centre node is pinned at (0, 0);
 * `previous` keeps nodes that were already shown roughly where they were.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  center: string | null,
  previous?: Map<string, Point>,
): Layout {
  const localDegree = new Map<string, number>();
  for (const e of edges) {
    localDegree.set(e.source, (localDegree.get(e.source) ?? 0) + 1);
    localDegree.set(e.target, (localDegree.get(e.target) ?? 0) + 1);
  }
  const sim: SimNode[] = nodes.map((n) => {
    const r = nodeRadius(n, localDegree.get(n.id) ?? 0, n.id === center);
    const before = previous?.get(n.id);
    const node: SimNode = { id: n.id, r };
    if (n.id === center) {
      node.fx = 0;
      node.fy = 0;
    } else if (before) {
      node.x = before.x;
      node.y = before.y;
    }
    return node;
  });
  const ids = new Set(sim.map((n) => n.id));
  const links: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e) => ({ source: e.source, target: e.target }));
  const dense = nodes.length > 60;
  const linked = new Set(links.flatMap((l) => [String(l.source), String(l.target)]));
  // Unlinked nodes (e.g. an unused template) are pulled in harder so that they do not shrink the fitted view.
  const pull = (base: number) => (d: SimNode) => (linked.has(d.id) ? base : base * 4);
  const simulation = forceSimulation<SimNode>(sim)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((d) => d.id)
        .distance(dense ? 70 : 130),
    )
    .force("charge", forceManyBody<SimNode>().strength(dense ? -240 : -520).distanceMax(800))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + (dense ? 12 : 26)))
    .force("x", forceX<SimNode>(0).strength(pull(dense ? 0.06 : 0.04)))
    .force("y", forceY<SimNode>(0).strength(pull(dense ? 0.09 : 0.07)))
    .stop();
  simulation.tick(LAYOUT_TICKS);

  const positions = new Map<string, Point>();
  const radius = new Map<string, number>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of sim) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    positions.set(n.id, { x, y });
    radius.set(n.id, n.r);
    minX = Math.min(minX, x - n.r);
    minY = Math.min(minY, y - n.r);
    maxX = Math.max(maxX, x + n.r);
    maxY = Math.max(maxY, y + n.r);
  }
  if (sim.length === 0) {
    minX = minY = -1;
    maxX = maxY = 1;
  }
  return { positions, radius, bounds: { minX, minY, maxX, maxY } };
}

// --- shapes: the kind of a node is carried by its shape (and by text), never by colour alone ---------------

function polygon(points: number, r: number, rotation = -Math.PI / 2, inner?: number): string {
  const total = inner ? points * 2 : points;
  const parts: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const radius = inner && i % 2 === 1 ? inner : r;
    const angle = rotation + (i * 2 * Math.PI) / total;
    parts.push(`${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `M${parts.join("L")}Z`;
}

/** SVG path of a node shape centred at (0, 0). */
export function nodeShapePath(kind: string, r: number): string {
  switch (kind) {
    case "semantic_entity":
      return `M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
    case "integration":
      return polygon(4, r * 1.3);
    case "source_system":
      return polygon(3, r * 1.3);
    case "dataset": {
      // A cylinder (a stored table): body with a visible top ellipse.
      const w = r * 0.95;
      const h = r * 1.1;
      const e = r * 0.38;
      return `M${-w},${-h + e}A${w},${e} 0 0,1 ${w},${-h + e}V${h - e}A${w},${e} 0 0,1 ${-w},${h - e}Z M${-w},${-h + e}A${w},${e} 0 0,0 ${w},${-h + e}`;
    }
    case "template":
      return polygon(5, r * 1.15);
    case "external_page": {
      // A page with a folded corner.
      const s = r * 0.95;
      const fold = s * 0.7;
      return `M${-s},${-s}H${s - fold}L${s},${-s + fold}V${s}H${-s}Z M${s - fold},${-s}V${-s + fold}H${s}`;
    }
    case "query_context":
      return polygon(8, r * 1.15, -Math.PI / 2, r * 0.62);
    default: {
      const s = r * 0.9;
      return `M${-s},${-s}H${s}V${s}H${-s}Z`;
    }
  }
}

/** Short label for the canvas; the full title stays in the accessible name and the details panel. */
export function shortLabel(text: string, max = 34): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
