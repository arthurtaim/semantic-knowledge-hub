import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { GraphEdge, GraphNode } from "../api/types";
import {
  boundsOf,
  EDGE_LABEL_FONT_SIZE,
  edgeGeometry,
  edgeOffsets,
  estimateTextWidth,
  isUnconfirmedEdge,
  LABEL_FONT_SIZE,
  LABEL_HEIGHT,
  mergePositions,
  nodeShapePath,
  nodeStatusClass,
  nodeStatusText,
  placeLabels,
  shortLabel,
  SPARSE_GRAPH,
  type Bounds,
  type EdgeGeometry,
  type GraphLabels,
  type LabelRequest,
  type LabelSide,
  type Layout,
  type Point,
} from "../lib/graph";
import { pluralRu } from "../lib/labels";
import { Button, IconButton } from "./ui/Button";
import { Popover } from "./ui/Popover";

interface View {
  x: number;
  y: number;
  k: number;
}

interface Size {
  w: number;
  h: number;
}

const DEFAULT_SIZE: Size = { w: 960, h: 560 };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const PAN_STEP = 48;
/** A press that moves less than this (screen px) is a click; beyond it the node is dragged. */
export const DRAG_THRESHOLD = 4;
/** Alt + arrow moves the selected node by this many screen px (Shift: the larger step). */
export const MOVE_STEP = 10;
export const MOVE_STEP_LARGE = 40;
/** Above this many nodes only the most connected, the selected, the hovered and their neighbours are labelled. */
const TOP_LABELS = 12;
const ANNOUNCEMENT_MS = 4000;
export const MOVED_MESSAGE = "Узел перемещён вручную. Остальные остались на месте.";
export const MOVED_BY_KEYBOARD = "Узел перемещён";
/** Room kept around the fitted graph (screen px): labels at the sides, the legend and controls at the bottom. */
const FIT_MARGIN = { x: 72, top: 36, bottom: 64 };

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/**
 * The whole graph in view. `reserve` is the open legend in the bottom-left corner: the graph goes either above it
 * or to its right, whichever leaves it larger.
 */
function fitView(bounds: Bounds, size: Size, reserve: Size = { w: 0, h: 0 }): View {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const fit = (left: number, right: number, top: number, bottom: number): View => {
    const availableW = Math.max(80, size.w - left - right);
    const availableH = Math.max(80, size.h - top - bottom);
    const k = clampZoom(Math.min(availableW / width, availableH / height, 1.6));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return { x: left + availableW / 2 - k * cx, y: top + availableH / 2 - k * cy, k };
  };
  const plain = fit(FIT_MARGIN.x, FIT_MARGIN.x, FIT_MARGIN.top, FIT_MARGIN.bottom);
  if (reserve.w <= 0 || reserve.h <= 0) return plain;
  const above = fit(FIT_MARGIN.x, FIT_MARGIN.x, FIT_MARGIN.top, Math.max(FIT_MARGIN.bottom, reserve.h + 24));
  const beside = fit(Math.max(FIT_MARGIN.x, reserve.w + 72), FIT_MARGIN.x, FIT_MARGIN.top, FIT_MARGIN.bottom);
  return beside.k > above.k ? beside : above;
}

const viewTransform = (v: View) => `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.k.toFixed(4)})`;
const nodeTransform = (p: Point) => `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`;

/** Where a node label sits relative to its node (graph units), matching `labelBox` in screen space. */
function labelOffset(side: LabelSide, ext: number, k: number): { x: number; y: number; anchor: "start" | "end" | "middle" } {
  const font = LABEL_FONT_SIZE / k;
  switch (side) {
    case "left":
      return { x: -(ext + 4 / k), y: font * 0.35, anchor: "end" };
    case "below":
      return { x: 0, y: ext + 2 / k + font * 0.95, anchor: "middle" };
    case "above":
      return { x: 0, y: -(ext + 2 / k) - font * 0.3, anchor: "middle" };
    default:
      return { x: ext + 4 / k, y: font * 0.35, anchor: "start" };
  }
}

// --- memoised pieces: a pan or a drag never re-renders them ------------------------------------------------

interface EdgeViewProps {
  edge: GraphEdge;
  d: string;
  lit: boolean;
  faded: boolean;
  title: string;
  marker: string;
}

const EdgeView = memo(function EdgeView({ edge, d, lit, faded, title, marker }: EdgeViewProps) {
  return (
    <path
      data-edge-id={edge.id}
      d={d}
      className={`graph-edge${isUnconfirmedEdge(edge) ? " graph-edge--unconfirmed" : ""}${lit ? " is-lit" : ""}${faded ? " is-faded" : ""}`}
      markerEnd={`url(#${marker})`}
      vectorEffect="non-scaling-stroke"
    >
      <title>{title}</title>
    </path>
  );
});

interface NodeViewProps {
  node: GraphNode;
  point: Point;
  r: number;
  ext: number;
  name: string;
  selected: boolean;
  isCenter: boolean;
  match: boolean;
  faded: boolean;
  lit: boolean;
}

const NodeView = memo(function NodeView({ node, point, r, ext, name, selected, isCenter, match, faded, lit }: NodeViewProps) {
  const classes = [
    "graph-node",
    `graph-node--${node.kind}`,
    `graph-node--status-${nodeStatusClass(node)}`,
    isCenter ? "is-center" : "",
    selected ? "is-selected" : "",
    match ? "is-match" : "",
    faded ? "is-faded" : "",
    lit ? "is-lit" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <g
      data-node-id={node.id}
      className={classes}
      transform={nodeTransform(point)}
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-pressed={selected}
    >
      <title>{node.label}</title>
      <circle className="graph-node__ring" r={ext + 5} vectorEffect="non-scaling-stroke" />
      <path className="graph-node__shape" d={nodeShapePath(node.kind, r)} vectorEffect="non-scaling-stroke" />
    </g>
  );
});

interface NodeLabelProps {
  id: string;
  text: string;
  point: Point;
  side: LabelSide;
  ext: number;
  k: number;
  bold: boolean;
  faded: boolean;
  deprecated: boolean;
}

const NodeLabel = memo(function NodeLabel({ id, text, point, side, ext, k, bold, faded, deprecated }: NodeLabelProps) {
  const offset = labelOffset(side, ext, k);
  return (
    <text
      data-label-for={id}
      className={`graph-label${bold ? " is-strong" : ""}${faded ? " is-faded" : ""}${deprecated ? " is-deprecated" : ""}`}
      transform={nodeTransform(point)}
      x={offset.x}
      y={offset.y}
      textAnchor={offset.anchor}
      fontSize={LABEL_FONT_SIZE / k}
      strokeWidth={3.5 / k}
      aria-hidden="true"
    >
      {text}
    </text>
  );
});

// --- the canvas ------------------------------------------------------------------------------------------

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Layout;
  /** Manually placed nodes: final position = override ?? layout. */
  overrides: ReadonlyMap<string, Point>;
  /** A node was dragged (or moved with Alt + arrows) to `point`; nothing else moves. */
  onMoveNode: (id: string, point: Point) => void;
  /** «Сбросить расположение»: forget the manual positions of this view and lay it out again. */
  onResetLayout: () => void;
  /** The focus node or the question: drawn larger, always labelled. */
  center: string | null;
  selectedId: string | null;
  matches: ReadonlySet<string>;
  labels: GraphLabels;
  onSelect: (id: string | null) => void;
  /** A new `nonce` centres the view on `id` and moves keyboard focus to that node. */
  focusRequest: { id: string; nonce: number } | null;
  /** The legend, drawn over the canvas in the bottom-left corner. */
  legend?: ReactNode;
  /**
   * The whole base («Вся база»): edges stay faint until one of their nodes is hovered or selected. A neighbourhood
   * or an answer graph is small and always has its centre selected, so its edges are drawn as before.
   */
  overview?: boolean;
}

type Gesture =
  | { kind: "pan"; pointer: number; startX: number; startY: number; view: View; next: View | null }
  | {
      kind: "node";
      pointer: number;
      id: string;
      element: Element;
      startX: number;
      startY: number;
      start: View;
      origin: Point;
      point: Point;
      dragging: boolean;
      parts: DragParts | null;
    };

interface DragParts {
  node: SVGGElement | null;
  label: SVGTextElement | null;
  edges: { edge: GraphEdge; path: SVGPathElement | null; label: SVGTextElement | null }[];
}

/** Pointer capture keeps a drag going outside the element; if the browser refuses it, the drag still works. */
function capture(element: Element, pointerId: number, on: boolean) {
  try {
    if (on) element.setPointerCapture?.(pointerId);
    else if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // An inactive pointer id (a synthetic event): no capture.
  }
}

const requestFrame = (callback: () => void): number =>
  typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 16);
const cancelFrame = (handle: number) => {
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
  window.clearTimeout(handle);
};

/**
 * The knowledge map as SVG: pan (drag the background, arrows), zoom (wheel, − / Вписать / +), nodes moved by
 * dragging (pointer capture, 4 px threshold, one animation frame per move, DOM updated directly — no React
 * render per frame, no relayout), hover and selection highlight, labels placed without overlaps, keyboard
 * selection (Tab, Enter / Space) and Alt + arrows to move the selected node.
 */
export function GraphCanvas({
  nodes,
  edges,
  layout,
  overrides,
  onMoveNode,
  onResetLayout,
  center,
  selectedId,
  matches,
  labels,
  onSelect,
  focusRequest,
  legend,
  overview = false,
}: GraphCanvasProps) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const positions = useMemo(() => mergePositions(layout.positions, overrides), [layout, overrides]);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => fitView(boundsOf(positions, layout.extent), DEFAULT_SIZE));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [hovered, setHovered] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; nonce: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const pendingTask = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const element = svgRef.current;
    if (!element) return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize((previous) =>
          Math.abs(previous.w - rect.width) < 1 && Math.abs(previous.h - rect.height) < 1 ? previous : { w: rect.width, h: rect.height },
        );
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** The open legend's size: the fitted graph keeps clear of it. */
  const legendReserve = useCallback((): Size => {
    const legendElement = containerRef.current?.querySelector(".graph-legend.is-open");
    const rect = legendElement?.getBoundingClientRect();
    return rect ? { w: rect.width, h: rect.height } : { w: 0, h: 0 };
  }, []);
  const fitAll = useCallback(
    (at: Size) => setView(fitView(boundsOf(positionsRef.current, layout.extent), at, legendReserve())),
    [layout.extent, legendReserve],
  );

  // A new layout (other data, a reset) or a resized canvas shows the whole graph; manual positions stay.
  useEffect(() => fitAll(size), [layout, size, fitAll]);

  useEffect(() => {
    if (!announcement) return undefined;
    const timer = window.setTimeout(() => setAnnouncement(null), ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelFrame(frame.current);
    },
    [],
  );

  const zoomAround = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const k = clampZoom(v.k * factor);
      const ratio = k / v.k;
      return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
    });
  }, []);

  // React registers wheel listeners as passive; the page must not scroll while zooming the canvas.
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAround(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  useEffect(() => {
    if (!focusRequest) return;
    const point = positionsRef.current.get(focusRequest.id);
    if (point) {
      setView((v) => {
        const k = Math.max(v.k, 1);
        return { k, x: size.w / 2 - k * point.x, y: size.h / 2 - k * point.y };
      });
    }
    const target = Array.from(svgRef.current?.querySelectorAll<SVGGElement>("[data-node-id]") ?? []).find(
      (element) => element.dataset.nodeId === focusRequest.id,
    );
    target?.focus();
    // Only a new request moves the view; later layout or size changes do not repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const localDegree = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    return degree;
  }, [edges]);
  const incident = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      map.set(e.source, [...(map.get(e.source) ?? []), e]);
      if (e.target !== e.source) map.set(e.target, [...(map.get(e.target) ?? []), e]);
    }
    return map;
  }, [edges]);
  const offsets = useMemo(() => edgeOffsets(edges), [edges]);
  const extentOf = useCallback((id: string) => layout.extent.get(id) ?? 8, [layout.extent]);
  const geometryOf = useCallback(
    (edge: GraphEdge, at: (id: string) => Point | undefined): EdgeGeometry | null => {
      const s = at(edge.source);
      const t = at(edge.target);
      if (!s || !t) return null;
      return edgeGeometry(s, t, extentOf(edge.source) + 1, extentOf(edge.target) + 3, offsets.get(edge.id) ?? 0);
    },
    [extentOf, offsets],
  );
  const geometry = useMemo(() => {
    const map = new Map<string, EdgeGeometry>();
    for (const e of edges) {
      const g = geometryOf(e, (id) => positions.get(id));
      if (g) map.set(e.id, g);
    }
    return map;
  }, [edges, positions, geometryOf]);

  // Highlight: the hovered node, otherwise the selected one, with its edges and neighbours.
  const active = hovered && byId.has(hovered) ? hovered : selectedId && byId.has(selectedId) ? selectedId : null;
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!active) return set;
    for (const e of incident.get(active) ?? []) set.add(e.source === active ? e.target : e.source);
    return set;
  }, [incident, active]);
  const isFaded = useCallback((id: string) => active !== null && id !== active && !neighbours.has(id), [active, neighbours]);

  // Labels: priority (selected > hovered > centre > search matches > neighbours > edge types > by degree), placed
  // in screen space; a label that would overlap another label, cover another labelled node or leave the map's
  // area is hidden.
  const k = view.k;
  const placement = useMemo(() => {
    const top = new Set(
      [...nodes]
        .sort((a, b) => (localDegree.get(b.id) ?? 0) - (localDegree.get(a.id) ?? 0) || b.degree - a.degree)
        .slice(0, TOP_LABELS)
        .map((n) => n.id),
    );
    const all = nodes.length <= SPARSE_GRAPH;
    const priority = (id: string): number | null => {
      if (id === selectedId) return 0;
      if (id === hovered) return 1;
      if (id === center) return 2;
      if (matches.has(id)) return 3;
      if (neighbours.has(id)) return 4;
      if (all || top.has(id)) return 6;
      return null;
    };
    const ranked: { request: LabelRequest; rank: number; degree: number }[] = [];
    for (const node of nodes) {
      if (isFaded(node.id) && node.id !== selectedId) continue;
      const rank = priority(node.id);
      const p = positions.get(node.id);
      if (rank === null || !p) continue;
      const bold = node.id === selectedId || node.id === center;
      ranked.push({
        rank,
        degree: localDegree.get(node.id) ?? 0,
        request: {
          key: `n:${node.id}`,
          x: p.x * k,
          y: p.y * k,
          ext: extentOf(node.id) * k,
          width: estimateTextWidth(shortLabel(node.label), LABEL_FONT_SIZE, bold),
          height: LABEL_HEIGHT,
          sides: ["right", "left", "below", "above"],
          own: node.id,
          force: rank === 0 && !isFaded(node.id),
        },
      });
    }
    if (active) {
      for (const edge of incident.get(active) ?? []) {
        const g = geometry.get(edge.id);
        if (!g) continue;
        ranked.push({
          rank: 5,
          degree: 0,
          request: {
            key: `e:${edge.id}`,
            x: g.mid.x * k,
            y: g.mid.y * k,
            ext: 0,
            width: estimateTextWidth(labels.relation(edge.type), EDGE_LABEL_FONT_SIZE),
            height: LABEL_HEIGHT - 1,
            sides: ["center"],
          },
        });
      }
    }
    ranked.sort((a, b) => a.rank - b.rank || b.degree - a.degree);
    // A label may cross edges and unlabelled nodes (its halo keeps it readable) but never covers a labelled one.
    const obstacles = ranked
      .filter((r) => r.request.own)
      .map((r) => ({ id: r.request.own ?? "", x: r.request.x, y: r.request.y, r: r.request.ext + 1 }));
    const b = boundsOf(positions, layout.extent);
    const area = {
      x0: b.minX * k - (FIT_MARGIN.x - 6),
      y0: b.minY * k - (FIT_MARGIN.top - 6),
      x1: b.maxX * k + (FIT_MARGIN.x - 6),
      y1: b.maxY * k + (FIT_MARGIN.top - 6),
    };
    return placeLabels(
      ranked.map((r) => r.request),
      obstacles,
      area,
    );
  }, [nodes, positions, layout.extent, k, selectedId, hovered, center, matches, neighbours, isFaded, localDegree, extentOf, active, incident, geometry, labels]);

  // --- drawing (memoised layers: a pan only changes the viewport transform) -------------------------------

  const marker = `arrow-${uid}`;
  const markerLit = `arrow-lit-${uid}`;
  const edgeLayer = useMemo(
    () => (
      <g className={`graph-edges${overview ? " graph-edges--quiet" : ""}`}>
        {edges.map((edge) => {
          const g = geometry.get(edge.id);
          if (!g) return null;
          const lit = active !== null && (edge.source === active || edge.target === active);
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          return (
            <EdgeView
              key={edge.id}
              edge={edge}
              d={g.d}
              lit={lit}
              faded={active !== null && !lit}
              marker={lit ? markerLit : marker}
              title={`${source?.label ?? edge.source} — ${labels.relation(edge.type)} — ${target?.label ?? edge.target}. ${labels.origin(edge.origin)}`}
            />
          );
        })}
      </g>
    ),
    [edges, geometry, active, byId, labels, marker, markerLit, overview],
  );

  const edgeLabelLayer = useMemo(
    () => (
      <g className="graph-edge-labels" aria-hidden="true">
        {(active ? (incident.get(active) ?? []) : []).map((edge) => {
          const g = geometry.get(edge.id);
          if (!g || !placement.has(`e:${edge.id}`)) return null;
          return (
            <text
              key={edge.id}
              data-edge-label={edge.id}
              className="graph-edge-label"
              x={g.mid.x}
              y={g.mid.y + (EDGE_LABEL_FONT_SIZE / k) * 0.35}
              textAnchor="middle"
              fontSize={EDGE_LABEL_FONT_SIZE / k}
              strokeWidth={3.5 / k}
            >
              {labels.relation(edge.type)}
            </text>
          );
        })}
      </g>
    ),
    [active, incident, geometry, placement, labels, k],
  );

  const ordered = useMemo(
    () => (selectedId && byId.has(selectedId) ? [...nodes.filter((n) => n.id !== selectedId), byId.get(selectedId) as GraphNode] : nodes),
    [nodes, selectedId, byId],
  );
  const nodeLayer = useMemo(
    () => (
      <g className="graph-nodes">
        {ordered.map((node) => {
          const point = positions.get(node.id);
          if (!point) return null;
          const status = nodeStatusText(node);
          const degree = localDegree.get(node.id) ?? 0;
          return (
            <NodeView
              key={node.id}
              node={node}
              point={point}
              r={layout.radius.get(node.id) ?? 8}
              ext={extentOf(node.id)}
              name={`${node.label}. ${labels.kind(node.kind)}${status ? `, ${status}` : ""}. Связей на схеме: ${degree}`}
              selected={node.id === selectedId}
              isCenter={node.id === center}
              match={matches.has(node.id)}
              faded={isFaded(node.id)}
              lit={active !== null && !isFaded(node.id)}
            />
          );
        })}
      </g>
    ),
    [ordered, positions, localDegree, layout.radius, extentOf, labels, selectedId, center, matches, isFaded, active],
  );

  const labelLayer = useMemo(
    () => (
      <g className="graph-labels">
        {ordered.map((node) => {
          const side = placement.get(`n:${node.id}`);
          const point = positions.get(node.id);
          if (!side || !point) return null;
          return (
            <NodeLabel
              key={node.id}
              id={node.id}
              text={shortLabel(node.label)}
              point={point}
              side={side}
              ext={extentOf(node.id)}
              k={k}
              bold={node.id === selectedId || node.id === center}
              faded={isFaded(node.id)}
              deprecated={node.status === "deprecated"}
            />
          );
        })}
      </g>
    ),
    [ordered, placement, positions, extentOf, k, selectedId, center, isFaded],
  );

  // --- interaction ------------------------------------------------------------------------------------------

  const announce = (text: string) => setAnnouncement({ text, nonce: Date.now() });

  /** At most one paint per animation frame; the latest task wins. */
  function schedule(task: () => void) {
    pendingTask.current = task;
    if (frame.current !== null) return;
    const handle = requestFrame(() => {
      frame.current = null;
      const next = pendingTask.current;
      pendingTask.current = null;
      next?.();
    });
    // A frame callback may run at once (tests): then nothing is pending.
    if (pendingTask.current !== null) frame.current = handle;
  }

  function flushFrame() {
    if (frame.current !== null) {
      cancelFrame(frame.current);
      frame.current = null;
    }
    pendingTask.current = null;
  }

  function collectParts(id: string): DragParts {
    const svg = svgRef.current;
    const find = <T extends Element>(selector: string, key: string, value: string): T | null =>
      Array.from(svg?.querySelectorAll<T & HTMLOrSVGElement>(selector) ?? []).find((el) => el.dataset[key] === value) ?? null;
    const paths = new Map(
      Array.from(svg?.querySelectorAll<SVGPathElement>("[data-edge-id]") ?? []).map((el) => [el.dataset.edgeId ?? "", el]),
    );
    const edgeLabels = new Map(
      Array.from(svg?.querySelectorAll<SVGTextElement>("[data-edge-label]") ?? []).map((el) => [el.dataset.edgeLabel ?? "", el]),
    );
    return {
      node: find<SVGGElement>("[data-node-id]", "nodeId", id),
      label: find<SVGTextElement>("[data-label-for]", "labelFor", id),
      edges: (incident.get(id) ?? []).map((edge) => ({ edge, path: paths.get(edge.id) ?? null, label: edgeLabels.get(edge.id) ?? null })),
    };
  }

  /** Moves the dragged node, its label, its edges and their labels in the DOM (one animation frame). */
  function paintDrag(id: string, point: Point, parts: DragParts) {
    const transform = nodeTransform(point);
    parts.node?.setAttribute("transform", transform);
    parts.label?.setAttribute("transform", transform);
    const at = (other: string) => (other === id ? point : positionsRef.current.get(other));
    const fontShift = (EDGE_LABEL_FONT_SIZE / viewRef.current.k) * 0.35;
    for (const { edge, path, label } of parts.edges) {
      const g = geometryOf(edge, at);
      if (!g) continue;
      path?.setAttribute("d", g.d);
      label?.setAttribute("x", g.mid.x.toFixed(1));
      label?.setAttribute("y", (g.mid.y + fontShift).toFixed(1));
    }
  }

  function toGraph(clientX: number, clientY: number, v: View): Point {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - v.x) / v.k, y: (clientY - (rect?.top ?? 0) - v.y) / v.k };
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || gesture.current) return;
    suppressClick.current = false;
    const nodeElement = (event.target as Element).closest<SVGGElement>("[data-node-id]");
    const id = nodeElement?.dataset.nodeId;
    const origin = id ? positionsRef.current.get(id) : undefined;
    if (nodeElement && id && origin) {
      // The node takes the pointer: the background does not start panning.
      event.stopPropagation();
      capture(nodeElement, event.pointerId, true);
      gesture.current = {
        kind: "node",
        pointer: event.pointerId,
        id,
        element: nodeElement,
        startX: event.clientX,
        startY: event.clientY,
        start: viewRef.current,
        origin,
        point: origin,
        dragging: false,
        parts: null,
      };
      return;
    }
    gesture.current = { kind: "pan", pointer: event.pointerId, startX: event.clientX, startY: event.clientY, view: viewRef.current, next: null };
    capture(event.currentTarget, event.pointerId, true);
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (g.kind === "pan") {
      g.next = { ...g.view, x: g.view.x + dx, y: g.view.y + dy };
      schedule(() => {
        if (gesture.current === g && g.next) setView(g.next);
      });
      return;
    }
    if (!g.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.dragging = true;
      g.parts = collectParts(g.id);
      svgRef.current?.classList.add("is-dragging");
    }
    // Screen → graph with the current zoom and pan: the point under the cursor stays under the cursor.
    const from = toGraph(g.startX, g.startY, g.start);
    const to = toGraph(event.clientX, event.clientY, g.start);
    g.point = { x: g.origin.x + to.x - from.x, y: g.origin.y + to.y - from.y };
    schedule(() => {
      if (gesture.current === g && g.parts) paintDrag(g.id, g.point, g.parts);
    });
  }

  function endGesture(event: PointerEvent<SVGSVGElement>, cancelled: boolean) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    flushFrame();
    if (g.kind === "pan") {
      capture(event.currentTarget, event.pointerId, false);
      setView(cancelled ? g.view : (g.next ?? g.view));
      return;
    }
    capture(g.element, event.pointerId, false);
    if (!g.dragging) return; // a click: the click event selects the node
    svgRef.current?.classList.remove("is-dragging");
    if (cancelled) {
      if (g.parts) paintDrag(g.id, g.origin, g.parts);
      return;
    }
    if (g.parts) paintDrag(g.id, g.point, g.parts);
    suppressClick.current = true;
    onMoveNode(g.id, g.point);
    announce(MOVED_MESSAGE);
  }

  function onClick(event: MouseEvent<SVGSVGElement>) {
    const id = (event.target as Element).closest<SVGGElement>("[data-node-id]")?.dataset.nodeId;
    if (!id) return;
    if (suppressClick.current) {
      // The press was a drag: it moved the node and does not select it.
      suppressClick.current = false;
      return;
    }
    onSelect(id);
  }

  function onPointerOver(event: PointerEvent<SVGSVGElement>) {
    if (gesture.current) return;
    const id = (event.target as Element).closest<SVGGElement>("[data-node-id]")?.dataset.nodeId ?? null;
    setHovered((previous) => (previous === id ? previous : id));
  }

  const zoomBy = (factor: number) => zoomAround(factor, size.w / 2, size.h / 2);
  const showAll = () => fitAll(size);

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const nodeId = (event.target as Element).closest<SVGGElement>("[data-node-id]")?.dataset.nodeId;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (nodeId && plain && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onSelect(nodeId);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = arrows[event.key];
    if (direction && event.altKey && !event.ctrlKey && !event.metaKey) {
      // WCAG 2.5.7: the same move as a drag, without dragging.
      const point = selectedId ? positions.get(selectedId) : undefined;
      if (!selectedId || !point) return;
      event.preventDefault();
      const step = (event.shiftKey ? MOVE_STEP_LARGE : MOVE_STEP) / view.k;
      onMoveNode(selectedId, { x: point.x + direction[0] * step, y: point.y + direction[1] * step });
      announce(MOVED_BY_KEYBOARD);
      return;
    }
    const actions: Record<string, () => void> = {
      "+": () => zoomBy(1.25),
      "=": () => zoomBy(1.25),
      "-": () => zoomBy(0.8),
      _: () => zoomBy(0.8),
      "0": showAll,
      ArrowLeft: () => setView((v) => ({ ...v, x: v.x + PAN_STEP })),
      ArrowRight: () => setView((v) => ({ ...v, x: v.x - PAN_STEP })),
      ArrowUp: () => setView((v) => ({ ...v, y: v.y + PAN_STEP })),
      ArrowDown: () => setView((v) => ({ ...v, y: v.y - PAN_STEP })),
      Escape: () => onSelect(null),
    };
    const action = actions[event.key];
    if (!action || !plain) return;
    event.preventDefault();
    action();
  }

  const hintId = `graph-hint-${uid}`;
  const hint =
    "Перетащите узел, чтобы сдвинуть его; перетаскивание фона сдвигает схему, колесо меняет масштаб. С клавиатуры: Tab — к узлам, Enter или пробел — выбрать, Alt + стрелки — сдвинуть выбранный узел (с Shift — дальше), + и − — масштаб, стрелки — сдвиг схемы, 0 — вписать, Escape — снять выбор.";
  const hasOverrides = overrides.size > 0;

  return (
    <div className="graph-canvas" ref={containerRef}>
      <svg
        ref={svgRef}
        className="graph-canvas__svg"
        role="group"
        aria-label={`Схема графа: ${nodes.length} ${pluralRu(nodes.length, "узел", "узла", "узлов")}, ${edges.length} ${pluralRu(edges.length, "связь", "связи", "связей")}`}
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endGesture(event, false)}
        onPointerCancel={(event) => endGesture(event, true)}
        onPointerOver={onPointerOver}
        onPointerLeave={() => {
          if (!gesture.current) setHovered(null);
        }}
        onClick={onClick}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth={7 / k}
            markerHeight={7 / k}
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0,1L9,5L0,9Z" className="graph-arrow" />
          </marker>
          <marker
            id={markerLit}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth={8 / k}
            markerHeight={8 / k}
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0,1L9,5L0,9Z" className="graph-arrow graph-arrow--lit" />
          </marker>
        </defs>
        <g className="graph-viewport" transform={viewTransform(view)}>
          {edgeLayer}
          {edgeLabelLayer}
          {nodeLayer}
          {labelLayer}
        </g>
      </svg>
      <p id={hintId} className="visually-hidden">
        {hint}
      </p>
      {legend}
      <div className="graph-controls">
        <Button size="sm" icon="history" className="graph-controls__reset" disabled={!hasOverrides} onClick={onResetLayout}>
          Сбросить расположение
        </Button>
        <div className="graph-controls__row">
          <Popover
            id={`graph-help-${uid}`}
            side="top"
            align="end"
            trigger={(props) => <IconButton {...props} icon="info" label="Как управлять схемой" size="sm" variant="secondary" />}
          >
            <p>{hint}</p>
          </Popover>
          <div className="graph-zoom" role="group" aria-label="Масштаб схемы">
            <button type="button" className="graph-zoom__button" aria-label="Уменьшить" onClick={() => zoomBy(0.8)}>
              <span aria-hidden="true">−</span>
            </button>
            <button type="button" className="graph-zoom__button graph-zoom__fit" onClick={showAll}>
              Вписать
            </button>
            <button type="button" className="graph-zoom__button" aria-label="Увеличить" onClick={() => zoomBy(1.25)}>
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
      </div>
      <div className={`graph-toast${announcement ? " is-visible" : ""}`} role="status" aria-live="polite">
        {announcement?.text ?? ""}
      </div>
    </div>
  );
}
