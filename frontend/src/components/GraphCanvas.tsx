import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { GraphEdge, GraphNode } from "../api/types";
import {
  isUnconfirmedEdge,
  nodeShapePath,
  nodeStatusClass,
  nodeStatusText,
  shortLabel,
  type GraphLabels,
  type Layout,
} from "../lib/graph";
import { pluralRu } from "../lib/labels";

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
/** Above this many nodes only the most connected, the selected and the highlighted ones carry a text label. */
const ALL_LABELS_UP_TO = 40;
const TOP_LABELS = 10;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

function fitView(layout: Layout, size: Size): View {
  const { minX, minY, maxX, maxY } = layout.bounds;
  // Room for labels to the right of the nodes and a margin around.
  const width = maxX - minX + 140;
  const height = maxY - minY + 60;
  const k = clampZoom(Math.min(size.w / width, size.h / height, 1.8));
  const cx = (minX + maxX + 120) / 2;
  const cy = (minY + maxY) / 2;
  return { x: size.w / 2 - k * cx, y: size.h / 2 - k * cy, k };
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Layout;
  /** The focus node or the question: drawn larger, always labelled. */
  center: string | null;
  selectedId: string | null;
  matches: ReadonlySet<string>;
  labels: GraphLabels;
  onSelect: (id: string | null) => void;
  /** A new `nonce` centres the view on `id` and moves keyboard focus to that node. */
  focusRequest: { id: string; nonce: number } | null;
}

/**
 * Static SVG rendering of a laid-out graph with pan (drag, arrows), zoom (wheel, + / −) and keyboard
 * selection of nodes (Tab, Enter / Space). Nothing animates: the layout is computed before rendering.
 */
export function GraphCanvas({ nodes, edges, layout, center, selectedId, matches, labels, onSelect, focusRequest }: GraphCanvasProps) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const [view, setView] = useState<View>(() => fitView(layout, DEFAULT_SIZE));
  const drag = useRef<{ pointer: number; startX: number; startY: number; viewX: number; viewY: number } | null>(null);

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

  // A new layout or a resized canvas shows the whole graph again.
  useEffect(() => setView(fitView(layout, size)), [layout, size]);

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
    const point = layout.positions.get(focusRequest.id);
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
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!selectedId) return set;
    for (const e of edges) {
      if (e.source === selectedId) set.add(e.target);
      if (e.target === selectedId) set.add(e.source);
    }
    return set;
  }, [edges, selectedId]);
  const labelled = useMemo(() => {
    if (nodes.length <= ALL_LABELS_UP_TO) return new Set(nodes.map((n) => n.id));
    const top = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, TOP_LABELS);
    const set = new Set(top.map((n) => n.id));
    if (center) set.add(center);
    if (selectedId) set.add(selectedId);
    for (const id of matches) set.add(id);
    for (const id of neighbours) set.add(id);
    return set;
  }, [nodes, center, selectedId, matches, neighbours]);

  /** Parallel edges between one pair (e.g. "found" and "cited") are drawn as separate curves. */
  const edgePaths = useMemo(() => {
    const groups = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const paths = new Map<string, string>();
    for (const [key, group] of groups) {
      const [a = "", b = ""] = key.split("|");
      const pa = layout.positions.get(a);
      const pb = layout.positions.get(b);
      if (!pa || !pb) continue;
      const nx = -(pb.y - pa.y);
      const ny = pb.x - pa.x;
      const nlen = Math.hypot(nx, ny) || 1;
      group.forEach((edge, index) => {
        const s = layout.positions.get(edge.source);
        const t = layout.positions.get(edge.target);
        if (!s || !t) return;
        const rs = layout.radius.get(edge.source) ?? 8;
        const rt = (layout.radius.get(edge.target) ?? 8) + 4;
        const offset = (index - (group.length - 1) / 2) * 26;
        const cx = (s.x + t.x) / 2 + (nx / nlen) * offset;
        const cy = (s.y + t.y) / 2 + (ny / nlen) * offset;
        const toward = (from: { x: number; y: number }, to: { x: number; y: number }, distance: number) => {
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: from.x + (dx / len) * distance, y: from.y + (dy / len) * distance };
        };
        const start = toward(s, offset === 0 ? t : { x: cx, y: cy }, rs);
        const end = toward(t, offset === 0 ? s : { x: cx, y: cy }, rt);
        paths.set(
          edge.id,
          offset === 0
            ? `M${start.x.toFixed(1)},${start.y.toFixed(1)}L${end.x.toFixed(1)},${end.y.toFixed(1)}`
            : `M${start.x.toFixed(1)},${start.y.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
        );
      });
    }
    return paths;
  }, [edges, layout]);

  const zoomBy = (factor: number) => zoomAround(factor, size.w / 2, size.h / 2);
  const showAll = () => setView(fitView(layout, size));

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
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
    if (!action || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    action();
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || (event.target as Element).closest("[data-node-id]")) return;
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    setView((v) => ({ ...v, x: d.viewX + event.clientX - d.startX, y: d.viewY + event.clientY - d.startY }));
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  const ordered = selectedId && byId.has(selectedId) ? [...nodes.filter((n) => n.id !== selectedId), byId.get(selectedId) as GraphNode] : nodes;
  const fontSize = 12 / view.k;
  const hintId = `graph-hint-${uid}`;

  return (
    <div className="graph-canvas">
      <div className="graph-canvas__bar">
        <p className="graph-canvas__count">
          {nodes.length} {pluralRu(nodes.length, "узел", "узла", "узлов")} · {edges.length}{" "}
          {pluralRu(edges.length, "связь", "связи", "связей")}
        </p>
        <div className="graph-canvas__zoom" role="group" aria-label="Масштаб схемы">
          <button type="button" className="button button--quiet" onClick={() => zoomBy(1.25)}>
            Увеличить
          </button>
          <button type="button" className="button button--quiet" onClick={() => zoomBy(0.8)}>
            Уменьшить
          </button>
          <button type="button" className="button button--quiet" onClick={showAll}>
            Показать всё
          </button>
        </div>
      </div>
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
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <marker
            id={`arrow-${uid}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0,0L10,5L0,10Z" className="graph-arrow" />
          </marker>
          <marker
            id={`arrow-on-${uid}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0,0L10,5L0,10Z" className="graph-arrow graph-arrow--on" />
          </marker>
        </defs>
        <g transform={`translate(${view.x.toFixed(2)},${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`}>
          <g className="graph-edges">
            {edges.map((edge) => {
              const d = edgePaths.get(edge.id);
              if (!d) return null;
              const incident = selectedId !== null && (edge.source === selectedId || edge.target === selectedId);
              const faded = selectedId !== null && !incident;
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              return (
                <path
                  key={edge.id}
                  d={d}
                  className={`graph-edge${isUnconfirmedEdge(edge) ? " graph-edge--unconfirmed" : ""}${incident ? " is-incident" : ""}${faded ? " is-faded" : ""}`}
                  markerEnd={`url(#${incident ? `arrow-on-${uid}` : `arrow-${uid}`})`}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>
                    {`${source?.label ?? edge.source} — ${labels.relation(edge.type)} — ${target?.label ?? edge.target}. ${labels.origin(edge.origin)}`}
                  </title>
                </path>
              );
            })}
          </g>
          <g className="graph-nodes">
            {ordered.map((node) => {
              const point = layout.positions.get(node.id);
              if (!point) return null;
              const r = layout.radius.get(node.id) ?? 8;
              const selected = node.id === selectedId;
              const faded = selectedId !== null && !selected && !neighbours.has(node.id);
              const status = nodeStatusText(node);
              const degree = localDegree.get(node.id) ?? 0;
              const name = `${node.label}. ${labels.kind(node.kind)}${status ? `, ${status}` : ""}. Связей на схеме: ${degree}`;
              const classes = [
                "graph-node",
                `graph-node--${node.kind}`,
                `graph-node--status-${nodeStatusClass(node)}`,
                node.id === center ? "is-center" : "",
                selected ? "is-selected" : "",
                matches.has(node.id) ? "is-match" : "",
                faded ? "is-faded" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  className={classes}
                  transform={`translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`}
                  role="button"
                  tabIndex={0}
                  aria-label={name}
                  aria-pressed={selected}
                  onClick={() => onSelect(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect(node.id);
                    }
                  }}
                >
                  <circle className="graph-node__ring" r={r + 6} vectorEffect="non-scaling-stroke" />
                  <path className="graph-node__shape" d={nodeShapePath(node.kind, r)} vectorEffect="non-scaling-stroke" />
                  {labelled.has(node.id) ? (
                    <text
                      className="graph-node__label"
                      x={r + 5}
                      y={fontSize * 0.35}
                      fontSize={fontSize}
                      strokeWidth={3 / view.k}
                      aria-hidden="true"
                    >
                      {shortLabel(node.label)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <p id={hintId} className="graph-canvas__hint">
        Перетаскивайте схему мышью, масштаб — колесом. С клавиатуры: Tab — к узлам, Enter или пробел — выбрать, + и − —
        масштаб, стрелки — сдвиг, 0 — показать всё, Escape — снять выбор.
      </p>
    </div>
  );
}
