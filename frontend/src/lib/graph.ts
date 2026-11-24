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
import type { GraphEdge, GraphFeedback, GraphLegend, GraphNode, GraphSourceKind, Subgraph } from "../api/types";
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

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Layout {
  positions: Map<string, Point>;
  radius: Map<string, number>;
  /** Radius of the circle around each node's shape: a diamond or a triangle reaches beyond its `radius`. */
  extent: Map<string, number>;
  bounds: Bounds;
}

export interface LayoutOptions {
  /**
   * Nodes the user placed by hand: they stay exactly there (d3 `fx/fy`) and the rest is laid out around them,
   * e.g. after more neighbours were loaded.
   */
  pinned?: ReadonlyMap<string, Point>;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: string;
  label: string;
  /** Radius of the circle around the shape. */
  ext: number;
}

/**
 * Ticks of the synchronous simulation: d3's default cooling (alpha 1 → 0.001 in 300 ticks) for ordinary graphs; a
 * big graph cools faster in fewer ticks so that 200 nodes stay well under 300 ms.
 */
const LAYOUT_TICKS = 300;
const BIG_GRAPH_TICKS = 200;
/** Above this many nodes collision runs only in the last `LATE_COLLIDE_TICKS` ticks. */
const BIG_GRAPH_COLLIDE = 120;
const LATE_COLLIDE_TICKS = 70;
const layoutTicks = (count: number) =>
  count <= 100 ? LAYOUT_TICKS : Math.round(LAYOUT_TICKS - ((LAYOUT_TICKS - BIG_GRAPH_TICKS) * Math.min(count - 100, 100)) / 100);
/** Free space kept between two shapes after the layout (graph units). */
export const NODE_GAP = 6;
/** Typed relations (depends_on, consumes…) pull their ends closer than a plain reference. */
const LINK_DISTANCE: Record<string, number> = { references: 92, uses_template: 84, retrieved_for: 120, cited_in: 120 };
const TYPED_LINK_DISTANCE = 64;
/** Up to this many nodes every node carries a label, so they get more room. */
export const SPARSE_GRAPH = 40;

export function nodeRadius(node: GraphNode, localDegree: number, central: boolean): number {
  if (central) return 15;
  const degree = Math.max(node.degree, localDegree);
  return Math.round((7 + Math.min(8, Math.sqrt(degree) * 1.7)) * 10) / 10;
}

/** The circle around a node shape of radius `r` (see `nodeShapePath`). */
export function nodeExtent(kind: string, r: number): number {
  switch (kind) {
    case "semantic_entity":
      return r;
    case "integration":
    case "source_system":
      return r * 1.3;
    case "dataset":
      return r * 1.2;
    case "template":
    case "query_context":
      return r * 1.15;
    case "external_page":
      return r * 1.35;
    default:
      return r * 1.28;
  }
}

interface Pair {
  source: string;
  target: string;
  type: string;
}

/** Steps from `center` to every reachable node, following edges in both directions. */
function depthsFrom(center: string, pairs: Pair[]): Map<string, number> {
  const adjacent = new Map<string, string[]>();
  for (const p of pairs) {
    adjacent.set(p.source, [...(adjacent.get(p.source) ?? []), p.target]);
    adjacent.set(p.target, [...(adjacent.get(p.target) ?? []), p.source]);
  }
  const depth = new Map<string, number>([[center, 0]]);
  let frontier = [center];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) ?? []) {
        if (depth.has(other)) continue;
        depth.set(other, (depth.get(id) ?? 0) + 1);
        next.push(other);
      }
    }
    frontier = next;
  }
  return depth;
}

const kindRank = (kind: string) => {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
};
const byKindThenLabel = (a: { kind: string; label: string; id: string }, b: { kind: string; label: string; id: string }) =>
  kindRank(a.kind) - kindRank(b.kind) || a.label.localeCompare(b.label, "ru") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Pushes overlapping shapes apart until every pair keeps `gap` between their circles. Fixed nodes (the centre,
 * pinned ones) never move; a pair of fixed nodes is left as the user placed it.
 */
function separate(nodes: SimNode[], gap: number, rounds = 80): void {
  for (let round = 0; round < rounds; round += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i] as SimNode;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j] as SimNode;
        const aFixed = a.fx != null;
        const bFixed = b.fx != null;
        if (aFixed && bFixed) continue;
        let dx = (b.x ?? 0) - (a.x ?? 0);
        let dy = (b.y ?? 0) - (a.y ?? 0);
        let distance = Math.hypot(dx, dy);
        const min = a.ext + b.ext + gap;
        if (distance >= min) continue;
        if (distance < 1e-6) {
          // Same point: separate along a direction that depends only on the order (deterministic).
          const angle = ((i * 7 + j * 13) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const push = min - distance + 0.01;
        const ux = dx / distance;
        const uy = dy / distance;
        const shareA = aFixed ? 0 : bFixed ? 1 : 0.5;
        const shareB = 1 - shareA;
        a.x = (a.x ?? 0) - ux * push * shareA;
        a.y = (a.y ?? 0) - uy * push * shareA;
        b.x = (b.x ?? 0) + ux * push * shareB;
        b.y = (b.y ?? 0) + uy * push * shareB;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/**
 * Unlinked nodes (an unused template) are not scattered by the forces: they sit in tidy rings around the laid
 * out graph (an ellipse following its proportions), or — when nothing is linked — in a compact sunflower disc.
 */
function placeIsolated(isolated: SimNode[], placed: SimNode[], center: Point): void {
  if (isolated.length === 0) return;
  const spacing = Math.max(...isolated.map((n) => n.ext)) * 2 + 30;
  if (placed.length === 0) {
    isolated.forEach((node, index) => {
      if (node.fx != null) return;
      const r = spacing * 0.62 * Math.sqrt(index);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      node.x = center.x + r * Math.cos(angle);
      node.y = center.y + r * Math.sin(angle);
    });
    return;
  }
  let rx = 0;
  let ry = 0;
  for (const n of placed) {
    rx = Math.max(rx, Math.abs((n.x ?? 0) - center.x) + n.ext);
    ry = Math.max(ry, Math.abs((n.y ?? 0) - center.y) + n.ext);
  }
  let start = 0;
  let ring = 0;
  while (start < isolated.length) {
    const a = rx + 56 + ring * spacing;
    const b = ry + 56 + ring * spacing;
    // Ramanujan's approximation of an ellipse's perimeter.
    const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const capacity = Math.max(1, Math.floor(perimeter / spacing));
    const chunk = isolated.slice(start, start + capacity);
    chunk.forEach((node, index) => {
      if (node.fx != null) return;
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / chunk.length + ring * 0.35;
      node.x = center.x + a * Math.cos(angle);
      node.y = center.y + b * Math.sin(angle);
    });
    start += capacity;
    ring += 1;
  }
}

/**
 * A radial tree around a centre (a neighbourhood's focus, an answer's question): depth 1 on the first ring,
 * depth 2 on the second, every node inside the angular sector of its parent and sectors proportional to the size
 * of their branch — branches do not cross and the rings stay evenly filled. In an answer graph the cited
 * documents form the first ring and the sources found but not cited sit just outside it.
 */
function radialPlacement(
  nodes: SimNode[],
  centerId: string,
  pairs: Pair[],
  depth: ReadonlyMap<string, number>,
  cited: ReadonlySet<string> | null,
  room: number,
): void {
  const adjacent = new Map<string, string[]>();
  for (const p of pairs) {
    adjacent.set(p.source, [...(adjacent.get(p.source) ?? []), p.target]);
    adjacent.set(p.target, [...(adjacent.get(p.target) ?? []), p.source]);
  }
  const levels: SimNode[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (d === undefined || d === 0) continue;
    (levels[d] ??= []).push(n);
  }
  // First ring: start with the most connected node, then always take the one that shares the most neighbours
  // with the previous one — related documents sit side by side.
  const remaining = [...(levels[1] ?? [])].sort(
    (a, b) => (adjacent.get(b.id)?.length ?? 0) - (adjacent.get(a.id)?.length ?? 0) || byKindThenLabel(a, b),
  );
  const first: SimNode[] = [];
  while (remaining.length > 0) {
    let pick = 0;
    const previous = first[first.length - 1];
    if (previous) {
      const near = new Set(adjacent.get(previous.id) ?? []);
      let best = -1;
      remaining.forEach((n, index) => {
        const shared = (adjacent.get(n.id) ?? []).filter((id) => near.has(id) && id !== centerId).length + (near.has(n.id) ? 2 : 0);
        if (shared > best) {
          best = shared;
          pick = index;
        }
      });
    }
    first.push(remaining.splice(pick, 1)[0] as SimNode);
  }
  levels[1] = first;
  // Deeper rings: each node hangs under its first neighbour (in ring order) one step closer to the centre.
  const order = new Map(first.map((n, index) => [n.id, index]));
  const children = new Map<string, SimNode[]>();
  for (let d = 2; d < levels.length; d += 1) {
    for (const n of [...(levels[d] ?? [])].sort(byKindThenLabel)) {
      const parent = (adjacent.get(n.id) ?? [])
        .filter((id) => depth.get(id) === d - 1)
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
      if (parent) children.set(parent, [...(children.get(parent) ?? []), n]);
    }
    const level = (levels[d - 1] ?? []).flatMap((p) => children.get(p.id) ?? []);
    levels[d] = level;
    level.forEach((n, index) => order.set(n.id, index));
  }
  // Branch weights, from the outermost ring in.
  const weight = new Map<string, number>();
  for (let d = levels.length - 1; d >= 1; d -= 1) {
    for (const n of levels[d] ?? []) {
      const sum = (children.get(n.id) ?? []).reduce((total, c) => total + (weight.get(c.id) ?? 1), 0);
      weight.set(n.id, Math.max(d === 1 ? 1.5 : 1, sum));
    }
  }
  // Sectors and radii: every ring is wide enough for its nodes and their labels. The first ring is spread
  // nearly evenly (a big branch widens its sector only by the square root of its size).
  const sector = new Map<string, [number, number]>();
  const firstWeight = (n: SimNode) => 1 + Math.sqrt(Math.max(0, (weight.get(n.id) ?? 1) - 1));
  const total = first.reduce((sum, n) => sum + firstWeight(n), 0);
  let start = -Math.PI / 2 - (Math.PI * (first[0] ? firstWeight(first[0]) : 1)) / Math.max(total, 1);
  for (const n of first) {
    const span = (2 * Math.PI * firstWeight(n)) / Math.max(total, 1);
    sector.set(n.id, [start, start + span]);
    start += span;
  }
  const spacingOf = (level: SimNode[]) => (Math.max(0, ...level.map((n) => n.ext)) * 2 + 34) * room;
  const minSpan = (level: SimNode[]) =>
    Math.min(Math.PI, ...level.map((n) => {
      const [a, b] = sector.get(n.id) ?? [0, 2 * Math.PI];
      return b - a;
    }));
  const radius: number[] = [0];
  /** Outer rings alternate between two radii where a branch is crowded: twice the room for labels. */
  const stagger = new Set<string>();
  for (let d = 1; d < levels.length; d += 1) {
    const level = levels[d] ?? [];
    if (d >= 2) {
      // Split each parent's sector among its children by weight.
      for (const parent of levels[d - 1] ?? []) {
        const list = children.get(parent.id) ?? [];
        const [a, b] = sector.get(parent.id) ?? [0, 0];
        const sum = list.reduce((s, c) => s + (weight.get(c.id) ?? 1), 0);
        let from = a;
        for (const c of list) {
          const span = ((b - a) * (weight.get(c.id) ?? 1)) / Math.max(sum, 1);
          sector.set(c.id, [from, from + span]);
          from += span;
        }
      }
    }
    const step = (d === 1 ? 150 : 140) * room;
    const needed = level.length > 1 ? spacingOf(level) / minSpan(level) : 0;
    const r = Math.max((radius[d - 1] ?? 0) + step, d === 1 ? needed : needed / 2);
    radius[d] = r;
    if (d >= 2 && needed > r) {
      for (const parent of levels[d - 1] ?? []) {
        (children.get(parent.id) ?? []).forEach((c, index) => {
          if (index % 2 === 1) stagger.add(c.id);
        });
      }
    }
  }
  // With a second ring the first one moves out to about half its radius: room for the labels in between.
  if (radius.length > 2) radius[1] = Math.max(radius[1] ?? 0, Math.min((radius[2] ?? 0) - 90 * room, 0.55 * (radius[2] ?? 0)));
  const outside = 70 * room;
  for (let d = 1; d < levels.length; d += 1) {
    for (const n of levels[d] ?? []) {
      if (n.fx != null) continue;
      const [a, b] = sector.get(n.id) ?? [0, 0];
      const angle = (a + b) / 2;
      const r =
        (radius[d] ?? 0) +
        (d === 1 && cited && !cited.has(n.id) ? outside : 0) +
        (d >= 2 && cited ? outside : 0) +
        (stagger.has(n.id) ? 0.55 * 140 * room : 0);
      n.x = r * Math.cos(angle);
      n.y = r * Math.sin(angle);
    }
  }
}

/** The kind whose region is the middle of the whole-base map: plain documents reference every other kind. */
const HUB_KIND = "document";
/** Radius of a kind's region per √(node count), in graph units (a node with its label room takes ~45 × 45). */
const REGION_SPACING = 27;
/** Free space between two regions. */
const REGION_GAP = 56;
/** Pull of every node towards its kind's region: strong enough to form regions, weak enough for links inside them. */
const REGION_PULL = 0.2;
/** A link between two kinds pulls this much of its usual strength: it does not drag the regions into one another. */
const CROSS_KIND_LINK = 0.2;

/**
 * Where each kind's region is on the whole-base map: documents in the middle, the other kinds around them on a
 * landscape ellipse in `KIND_ORDER` (source systems next to integrations, integrations next to entities…), each
 * region given an arc that matches its size. One kind alone sits in the middle.
 */
export function kindRegions(counts: ReadonlyMap<string, number>): Map<string, Point> {
  const kinds = [...counts.keys()].filter((k) => (counts.get(k) ?? 0) > 0).sort((a, b) => kindRank(a) - kindRank(b));
  const regions = new Map<string, Point>();
  if (kinds.length === 0) return regions;
  const size = (kind: string) => REGION_SPACING * Math.sqrt(counts.get(kind) ?? 1);
  const hub: string | null = kinds.length === 1 ? (kinds[0] as string) : kinds.includes(HUB_KIND) ? HUB_KIND : null;
  if (hub) regions.set(hub, { x: 0, y: 0 });
  const ring = kinds.filter((k) => k !== hub);
  if (ring.length === 0) return regions;
  const total = ring.reduce((sum, k) => sum + size(k), 0);
  const hubSize = hub ? size(hub) : 0;
  // Far enough from the middle region, and neighbours on the ring do not touch.
  let radius = hubSize + Math.max(...ring.map(size)) + REGION_GAP;
  let angle = -Math.PI / 2;
  const arcs = ring.map((kind) => {
    const span = (2 * Math.PI * size(kind)) / total;
    const middle = angle + span / 2;
    angle += span;
    return { kind, middle, span };
  });
  if (ring.length > 1) {
    arcs.forEach((arc, index) => {
      const next = arcs[(index + 1) % arcs.length] as (typeof arcs)[number];
      const between = Math.min(Math.PI, (arc.span + next.span) / 2);
      radius = Math.max(radius, (size(arc.kind) + size(next.kind) + REGION_GAP) / (2 * Math.sin(between / 2)));
    });
  }
  // A landscape map: wider than tall, like the canvas.
  for (const arc of arcs) regions.set(arc.kind, { x: radius * 1.3 * Math.cos(arc.middle), y: radius * 0.8 * Math.sin(arc.middle) });
  return regions;
}

/** Force-directed placement of a map without a centre (the whole base), each kind gathered in its own region. */
function forcePlacement(nodes: SimNode[], pairs: Pair[], previous: ReadonlyMap<string, Point> | undefined, sparse: boolean): void {
  const room = sparse ? 1.3 : 1;
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const regions = kindRegions(counts);
  const regionOf = (n: SimNode): Point => regions.get(n.kind) ?? { x: 0, y: 0 };
  let reused = 0;
  const seated = new Map<string, number>();
  for (const n of nodes) {
    if (n.fx != null) continue;
    const before = previous?.get(n.id);
    if (before) {
      n.x = before.x;
      n.y = before.y;
      reused += 1;
      continue;
    }
    // Start inside the node's region (a sunflower disc in input order): the forces only refine it.
    const index = seated.get(n.kind) ?? 0;
    seated.set(n.kind, index + 1);
    const centre = regionOf(n);
    const r = 14 * Math.sqrt(index + 0.5);
    const a = index * Math.PI * (3 - Math.sqrt(5));
    n.x = centre.x + r * Math.cos(a);
    n.y = centre.y + r * Math.sin(a);
  }
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const links: SimulationLinkDatum<SimNode>[] = pairs.map((p) => ({ source: p.source, target: p.target, type: p.type }));
  const typeOf = (link: SimulationLinkDatum<SimNode>) => (link as SimulationLinkDatum<SimNode> & { type: string }).type;
  const endKind = (end: SimulationLinkDatum<SimNode>["source"]) =>
    typeof end === "object" ? end.kind : kindOf.get(String(end));
  const linkForce = forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
    .id((d) => d.id)
    .distance((link) => (LINK_DISTANCE[typeOf(link)] ?? TYPED_LINK_DISTANCE) * room);
  // d3's default strength (1 / the smaller degree), halved for plain references: typed relations shape the map;
  // a link between two kinds pulls less, so that the regions stay apart.
  const defaultStrength = linkForce.strength();
  linkForce.strength((link, index, all) => {
    const base = typeof defaultStrength === "function" ? defaultStrength(link, index, all) : defaultStrength;
    const typed = typeOf(link) === "references" ? base * 0.5 : base;
    return endKind(link.source) === endKind(link.target) ? typed : typed * CROSS_KIND_LINK;
  });
  const count = nodes.length;
  const collide = forceCollide<SimNode>()
    .radius((d) => d.ext + (sparse ? 22 : 12))
    .iterations(sparse ? 2 : 1);
  // A big map settles its shape first and resolves collisions only while cooling down (the costliest force).
  const late = count > BIG_GRAPH_COLLIDE;
  const simulation = forceSimulation<SimNode>(nodes)
    .force("link", linkForce)
    // Bigger maps repel harder, so that their nodes and labels get room.
    .force("charge", forceManyBody<SimNode>().strength(sparse ? -420 : -(160 + Math.min(count, 300) * 1.8)).distanceMax(700))
    .force("collide", late ? null : collide)
    // Every node is pulled towards its kind's region (the regions lie on a landscape ellipse).
    .force("x", forceX<SimNode>((d) => regionOf(d).x).strength(REGION_PULL))
    .force("y", forceY<SimNode>((d) => regionOf(d).y).strength(REGION_PULL))
    .stop();
  const ticks = layoutTicks(count);
  simulation.alphaDecay(1 - Math.pow(0.001, 1 / ticks));
  if (count > 0 && reused >= count / 2) simulation.alpha(0.35);
  if (late) {
    simulation.tick(ticks - LATE_COLLIDE_TICKS);
    simulation.force("collide", collide).tick(LATE_COLLIDE_TICKS);
  } else {
    simulation.tick(ticks);
  }
  // Re-centre on the centroid (unless the user pinned nodes: then the map stays where they put it).
  if (count > 0 && !nodes.some((n) => n.fx != null)) {
    const cx = nodes.reduce((sum, n) => sum + (n.x ?? 0), 0) / count;
    const cy = nodes.reduce((sum, n) => sum + (n.y ?? 0), 0) / count;
    for (const n of nodes) {
      n.x = (n.x ?? 0) - cx;
      n.y = (n.y ?? 0) - cy;
    }
  }
}

/**
 * The layout of a map, computed synchronously before drawing (no animation) and deterministic.
 *
 * - With a centre (a neighbourhood's focus, an answer's question): the centre at (0, 0) and its neighbours on
 *   rings by distance — a radial tree (`radialPlacement`).
 * - Without one (the whole base): a force-directed layout grouped by kind (d3-force, seeded): every kind has its
 *   region (`kindRegions`: documents in the middle, the other kinds around them), each node starts in its region
 *   and `forceX` / `forceY` keep it there, links between two kinds pull less than links inside one; collision
 *   keeps the whole shape plus room for a label, bigger graphs repel harder, typed relations are shorter than
 *   plain references; `previous` keeps nodes already shown roughly in place.
 * - Unlinked nodes (and nodes cut off from the centre by a filter) sit in a tidy ring at the edge.
 * - `options.pinned` keeps manually placed nodes exactly where they are; a final pass guarantees that no two
 *   shapes overlap.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  center: string | null,
  previous?: ReadonlyMap<string, Point>,
  options: LayoutOptions = {},
): Layout {
  const pinned = options.pinned;
  const ids = new Set(nodes.map((n) => n.id));
  const pairs: Pair[] = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e) => ({ source: e.source, target: e.target, type: e.type }));
  const localDegree = new Map<string, number>();
  for (const p of pairs) {
    localDegree.set(p.source, (localDegree.get(p.source) ?? 0) + 1);
    localDegree.set(p.target, (localDegree.get(p.target) ?? 0) + 1);
  }
  const hasCenter = center !== null && ids.has(center);
  const depth = hasCenter ? depthsFrom(center, pairs) : new Map<string, number>();

  const radius = new Map<string, number>();
  const extent = new Map<string, number>();
  const all: SimNode[] = nodes.map((n) => {
    const r = nodeRadius(n, localDegree.get(n.id) ?? 0, n.id === center);
    const ext = nodeExtent(n.kind, r);
    radius.set(n.id, r);
    extent.set(n.id, ext);
    const node: SimNode = { id: n.id, kind: n.kind, label: n.label, ext };
    const pin = pinned?.get(n.id);
    if (pin) {
      node.x = node.fx = pin.x;
      node.y = node.fy = pin.y;
    } else if (hasCenter && n.id === center) {
      node.x = node.fx = 0;
      node.y = node.fy = 0;
    }
    return node;
  });
  const placed = all.filter((n) => (hasCenter ? depth.has(n.id) : (localDegree.get(n.id) ?? 0) > 0));
  const isolated = all.filter((n) => !placed.includes(n)).sort(byKindThenLabel);

  if (hasCenter) {
    const question = nodes.find((n) => n.id === center)?.kind === "query_context";
    const cited = question ? new Set(pairs.filter((p) => p.target === center && p.type === "cited_in").map((p) => p.source)) : null;
    radialPlacement(placed, center, pairs, depth, cited, placed.length <= SPARSE_GRAPH ? 1.3 : 1);
  } else {
    forcePlacement(placed, pairs, previous, placed.length <= SPARSE_GRAPH);
  }
  placeIsolated(
    isolated.filter((n) => n.fx == null),
    placed,
    { x: 0, y: 0 },
  );
  separate(all, NODE_GAP);

  const positions = new Map<string, Point>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of all) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    positions.set(n.id, { x, y });
    minX = Math.min(minX, x - n.ext);
    minY = Math.min(minY, y - n.ext);
    maxX = Math.max(maxX, x + n.ext);
    maxY = Math.max(maxY, y + n.ext);
  }
  if (all.length === 0) {
    minX = minY = -1;
    maxX = maxY = 1;
  }
  return { positions, radius, extent, bounds: { minX, minY, maxX, maxY } };
}

/** The layout's positions with manual ones on top: final position = override ?? layout. */
export function mergePositions(layout: ReadonlyMap<string, Point>, overrides: ReadonlyMap<string, Point>): Map<string, Point> {
  if (overrides.size === 0) return new Map(layout);
  const merged = new Map(layout);
  for (const [id, point] of overrides) if (merged.has(id)) merged.set(id, point);
  return merged;
}

export function boundsOf(positions: ReadonlyMap<string, Point>, extent: ReadonlyMap<string, number>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, p] of positions) {
    const e = extent.get(id) ?? 8;
    minX = Math.min(minX, p.x - e);
    minY = Math.min(minY, p.y - e);
    maxX = Math.max(maxX, p.x + e);
    maxY = Math.max(maxY, p.y + e);
  }
  return positions.size === 0 ? { minX: -1, minY: -1, maxX: 1, maxY: 1 } : { minX, minY, maxX, maxY };
}

// --- edges -------------------------------------------------------------------------------------------------

/**
 * Signed offset of every edge from the straight line between its ends: parallel edges of one pair (e.g.
 * «ссылается на» and «зависит от», or «найдена» and «процитирована») fan out as separate curves.
 */
export function edgeOffsets(edges: GraphEdge[], step = 18): Map<string, number> {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    group.forEach((edge, index) => {
      const offset = (index - (group.length - 1) / 2) * step;
      // Relative to source → target: an edge of the pair drawn the other way bends with the same side.
      offsets.set(edge.id, edge.source < edge.target ? offset : -offset);
    });
  }
  return offsets;
}

export interface EdgeGeometry {
  d: string;
  /** Middle of the drawn curve: the place of the relation label. */
  mid: Point;
}

/**
 * An edge from the rim of the source shape to just before the rim of the target, where the arrow points
 * (`sourceGap` and `targetGap` are the shapes' extents plus a small margin).
 */
export function edgeGeometry(s: Point, t: Point, sourceGap: number, targetGap: number, offset: number): EdgeGeometry {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const length = Math.hypot(dx, dy) || 1;
  const cx = (s.x + t.x) / 2 + (-dy / length) * offset;
  const cy = (s.y + t.y) / 2 + (dx / length) * offset;
  const toward = (from: Point, to: Point, distance: number): Point => {
    const ux = to.x - from.x;
    const uy = to.y - from.y;
    const l = Math.hypot(ux, uy) || 1;
    const d = Math.min(distance, l * 0.45);
    return { x: from.x + (ux / l) * d, y: from.y + (uy / l) * d };
  };
  const curved = offset !== 0;
  const control = { x: cx, y: cy };
  const start = toward(s, curved ? control : t, sourceGap);
  const end = toward(t, curved ? control : s, targetGap);
  const f = (v: number) => v.toFixed(1);
  if (!curved) {
    return { d: `M${f(start.x)},${f(start.y)}L${f(end.x)},${f(end.y)}`, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
  }
  return {
    d: `M${f(start.x)},${f(start.y)}Q${f(cx)},${f(cy)} ${f(end.x)},${f(end.y)}`,
    mid: { x: 0.25 * start.x + 0.5 * cx + 0.25 * end.x, y: 0.25 * start.y + 0.5 * cy + 0.25 * end.y },
  };
}

// --- labels: placed in screen space, overlapping ones hidden by priority ----------------------------------------

export const LABEL_FONT_SIZE = 11.5;
export const EDGE_LABEL_FONT_SIZE = 11;
export const LABEL_HEIGHT = 15;

const NARROW_CHARS = new Set(" .,:;'|!iljtfrI1()[]/«»\"-");
const WIDE_CHARS = new Set("mwMWшщжмюыфШЩЖМЮЫФ—→");

/** Width of a label in px, estimated from Inter's proportions (no layout or canvas needed, also in tests). */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    if (NARROW_CHARS.has(ch)) em += 0.3;
    else if (WIDE_CHARS.has(ch)) em += 0.78;
    else if (/[A-ZА-ЯЁ]/.test(ch)) em += 0.66;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else em += 0.55;
  }
  return Math.ceil(em * fontSize * (bold ? 1.06 : 1)) + 2;
}

export type LabelSide = "right" | "left" | "below" | "above" | "center";

export interface LabelRequest {
  /** Unique key (node and edge labels share one placement). */
  key: string;
  /** Anchor in screen units: the node centre, or the middle of an edge. */
  x: number;
  y: number;
  /** Screen radius of the node (0 for an edge label). */
  ext: number;
  width: number;
  height: number;
  /** Sides to try, in order. */
  sides: LabelSide[];
  /** The obstacle that belongs to this label (its own node) is ignored. */
  own?: string;
  /** Placed even if it overlaps (the selected node is always named). */
  force?: boolean;
}

export interface LabelObstacle {
  id: string;
  x: number;
  y: number;
  r: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function labelBox(request: Pick<LabelRequest, "x" | "y" | "ext" | "width" | "height">, side: LabelSide): Box {
  const { x, y, ext, width: w, height: h } = request;
  switch (side) {
    case "right":
      return { x0: x + ext + 4, y0: y - h / 2, x1: x + ext + 4 + w, y1: y + h / 2 };
    case "left":
      return { x0: x - ext - 4 - w, y0: y - h / 2, x1: x - ext - 4, y1: y + h / 2 };
    case "below":
      return { x0: x - w / 2, y0: y + ext + 2, x1: x + w / 2, y1: y + ext + 2 + h };
    case "above":
      return { x0: x - w / 2, y0: y - ext - 2 - h, x1: x + w / 2, y1: y - ext - 2 };
    default:
      return { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
  }
}

const boxesOverlap = (a: Box, b: Box, margin: number) =>
  a.x0 < b.x1 + margin && b.x0 < a.x1 + margin && a.y0 < b.y1 + margin && b.y0 < a.y1 + margin;

const boxHitsCircle = (box: Box, c: LabelObstacle) => {
  const nx = Math.max(box.x0, Math.min(c.x, box.x1));
  const ny = Math.max(box.y0, Math.min(c.y, box.y1));
  return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.r * c.r;
};

const boxInside = (box: Box, area: Box) => box.x0 >= area.x0 && box.x1 <= area.x1 && box.y0 >= area.y0 && box.y1 <= area.y1;

/**
 * Greedy label placement: requests come in priority order (selected > hovered > neighbours > by degree); each
 * takes the first side that stays inside `area`, overlaps no label placed before it and covers no obstacle (a
 * node other than its own); a label that fits nowhere is hidden (the full name stays in the node's title and
 * accessible name).
 */
export function placeLabels(requests: LabelRequest[], obstacles: LabelObstacle[], area?: Box, margin = 2): Map<string, LabelSide> {
  const placed: Box[] = [];
  const result = new Map<string, LabelSide>();
  for (const request of requests) {
    let chosen: LabelSide | null = null;
    for (const side of request.sides) {
      const box = labelBox(request, side);
      if (area && !boxInside(box, area)) continue;
      if (placed.some((other) => boxesOverlap(box, other, margin))) continue;
      if (obstacles.some((o) => o.id !== request.own && boxHitsCircle(box, o))) continue;
      chosen = side;
      break;
    }
    if (chosen === null && request.force) chosen = request.sides[0] ?? "right";
    if (chosen === null) continue;
    result.set(request.key, chosen);
    placed.push(labelBox(request, chosen));
  }
  return result;
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
