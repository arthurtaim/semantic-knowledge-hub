import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import css from "../styles/app.css?raw";
import type { GraphEdge, GraphNode, GraphNodeKind, GraphRelation } from "../api/types";
import { DRAG_THRESHOLD, GraphCanvas, MOVE_STEP, MOVE_STEP_LARGE } from "../components/GraphCanvas";
import { GraphLegendView } from "../components/GraphDetails";
import {
  estimateTextWidth,
  graphLabels,
  LABEL_FONT_SIZE,
  LABEL_HEIGHT,
  labelBox,
  layoutGraph,
  nodeExtent,
  topByDegree,
  type Box,
  type LabelSide,
  type Layout,
  type Point,
} from "../lib/graph";
import demo from "./graphDemo.json";

/*
 * Direct node dragging on the knowledge map (docs/ui-v2/specs/04_KNOWLEDGE_GRAPH.md §2): a press is a click until
 * the pointer moves more than 4 px; a drag moves only that node (exactly with the cursor, at any zoom), never
 * selects it and never re-renders the canvas per move; the background still pans, the wheel still zooms.
 * jsdom has no PointerEvent and no layout, so the canvas uses its default size (960 × 560) and the test
 * provides a minimal PointerEvent.
 */

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  // Paint at once instead of on the next animation frame.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function node(id: string, kind: GraphNodeKind = "document"): GraphNode {
  return {
    id,
    kind,
    label: `Документ ${id}`,
    document_id: id,
    doc_type: null,
    status: "approved",
    owner: null,
    source_kind: "local_markdown",
    revision: null,
    version: null,
    url: null,
    synthetic: true,
    expires_at: null,
    degree: 1,
  };
}

function edge(source: string, target: string): GraphEdge {
  return {
    id: `edge:${source}:${target}`,
    source,
    target,
    type: "depends_on",
    origin: "canonical_metadata",
    verified: true,
    declared_in: null,
    field: null,
    path: null,
    revision: null,
    status: "active",
    expires_at: null,
    feedback: null,
  };
}

const NODES = [node("A"), node("B"), node("C", "integration")];
const EDGES = [edge("A", "B"), edge("B", "C")];
const START = new Map<string, Point>([
  ["A", { x: 0, y: 0 }],
  ["B", { x: 200, y: 0 }],
  ["C", { x: 100, y: 160 }],
]);

function fixedLayout(positions = START): Layout {
  const radius = new Map(NODES.map((n) => [n.id, 10]));
  const extent = new Map(NODES.map((n) => [n.id, nodeExtent(n.kind, 10)]));
  return { positions, radius, extent, bounds: { minX: -13, minY: -13, maxX: 213, maxY: 173 } };
}

interface HarnessProps {
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, point: Point) => void;
  selectedId?: string | null;
  onRender?: () => void;
  overview?: boolean;
  withLegend?: boolean;
}

/** The canvas with its manual positions held like the page holds them. */
function Harness({ onSelect = () => {}, onMove = () => {}, selectedId = null, onRender, overview, withLegend }: HarnessProps) {
  const [overrides, setOverrides] = useState<Map<string, Point>>(new Map());
  const [layout] = useState(() => fixedLayout());
  const canvas = (
    <GraphCanvas
      nodes={NODES}
      edges={EDGES}
      layout={layout}
      overrides={overrides}
      onMoveNode={(id, point) => {
        onMove(id, point);
        setOverrides((previous) => new Map(previous).set(id, point));
      }}
      onResetLayout={() => setOverrides(new Map())}
      center={null}
      selectedId={selectedId}
      matches={new Set()}
      labels={graphLabels(null)}
      onSelect={onSelect}
      focusRequest={null}
      overview={overview}
      legend={withLegend ? <GraphLegendView labels={graphLabels(null)} kinds={["document", "integration"]} statuses={[]} /> : undefined}
    />
  );
  return <MemoryRouter>{onRender ? <Profiler id="canvas" onRender={onRender}>{canvas}</Profiler> : canvas}</MemoryRouter>;
}

const svg = () => document.querySelector<SVGSVGElement>(".graph-canvas__svg")!;
const nodeElement = (id: string) => document.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!;

function translate(element: Element): Point {
  const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(element.getAttribute("transform") ?? "");
  if (!match) throw new Error(`no translate in ${element.getAttribute("transform")}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function view(): { x: number; y: number; k: number } {
  const transform = document.querySelector(".graph-viewport")?.getAttribute("transform") ?? "";
  const match = /translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`no view transform in ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) };
}

/** Press on `target`, move by (dx, dy) in `steps`, release. */
function drag(target: Element, dx: number, dy: number, steps = 5, finish: "up" | "cancel" = "up") {
  const start = { clientX: 300, clientY: 200 };
  fireEvent.pointerDown(target, { ...start, button: 0, pointerId: 7 });
  for (let i = 1; i <= steps; i += 1) {
    fireEvent.pointerMove(target, { clientX: start.clientX + (dx * i) / steps, clientY: start.clientY + (dy * i) / steps, pointerId: 7 });
  }
  if (finish === "up") fireEvent.pointerUp(target, { clientX: start.clientX + dx, clientY: start.clientY + dy, pointerId: 7 });
  else fireEvent.pointerCancel(target, { pointerId: 7 });
}

describe("Knowledge map: dragging nodes", () => {
  it("selects a node on a click without movement, as before", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const a = nodeElement("A");
    drag(a, 0, 0, 1);
    fireEvent.click(a);
    expect(onSelect).toHaveBeenCalledWith("A");
    expect(translate(nodeElement("A"))).toEqual({ x: 0, y: 0 });
  });

  it("treats a press that moves less than 4 px as a click", () => {
    const onSelect = vi.fn();
    const onMove = vi.fn();
    render(<Harness onSelect={onSelect} onMove={onMove} />);
    drag(nodeElement("B"), DRAG_THRESHOLD - 1, 0);
    fireEvent.click(nodeElement("B"));
    expect(onMove).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("B");
    expect(translate(nodeElement("B"))).toEqual({ x: 200, y: 0 });
  });

  it("moves the node with the cursor beyond 4 px, keeps it there and does not select it", () => {
    const onSelect = vi.fn();
    const onMove = vi.fn();
    render(<Harness onSelect={onSelect} onMove={onMove} />);
    const { k } = view();
    const before = { B: translate(nodeElement("B")), C: translate(nodeElement("C")) };
    const viewBefore = view();
    drag(nodeElement("A"), 60, -30);
    // The click that follows the release of a drag does not select.
    fireEvent.click(nodeElement("A"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMove).toHaveBeenCalledTimes(1);
    const moved = translate(nodeElement("A"));
    expect(moved.x).toBeCloseTo(60 / k, 0);
    expect(moved.y).toBeCloseTo(-30 / k, 0);
    // Nothing else moved: no relayout, no pan.
    expect(translate(nodeElement("B"))).toEqual(before.B);
    expect(translate(nodeElement("C"))).toEqual(before.C);
    expect(view()).toEqual(viewBefore);
    // Its edge follows: it now starts near the new position.
    const path = document.querySelector('[data-edge-id="edge:A:B"]')!.getAttribute("d") ?? "";
    const [, sx, sy] = /^M([-\d.]+),([-\d.]+)/.exec(path) ?? [];
    expect(Math.hypot(Number(sx) - moved.x, Number(sy) - moved.y)).toBeLessThan(20);
    expect(screen.getByRole("status")).toHaveTextContent("Узел перемещён вручную. Остальные остались на месте.");
  });

  it("follows the cursor during the drag, one paint per frame, without re-rendering the canvas", () => {
    const commits = vi.fn();
    render(<Harness onRender={commits} />);
    const settled = commits.mock.calls.length;
    const a = nodeElement("A");
    const { k } = view();
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, button: 0, pointerId: 3 });
    for (let i = 1; i <= 30; i += 1) fireEvent.pointerMove(a, { clientX: 100 + i * 4, clientY: 100 + i * 2, pointerId: 3 });
    // Mid-drag the DOM already shows the node under the cursor…
    expect(translate(a).x).toBeCloseTo(120 / k, 0);
    expect(translate(a).y).toBeCloseTo(60 / k, 0);
    // …and React did not commit once for those 30 moves.
    expect(commits.mock.calls.length).toBe(settled);
    act(() => {
      fireEvent.pointerUp(a, { clientX: 220, clientY: 160, pointerId: 3 });
    });
    expect(commits.mock.calls.length).toBeGreaterThan(settled);
  });

  it("puts the node back when the drag is cancelled", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    drag(nodeElement("C"), 80, 80, 4, "cancel");
    expect(onMove).not.toHaveBeenCalled();
    expect(translate(nodeElement("C"))).toEqual({ x: 100, y: 160 });
  });

  it("pans when the background is dragged; node positions do not change", () => {
    render(<Harness />);
    const before = view();
    const nodesBefore = ["A", "B", "C"].map((id) => translate(nodeElement(id)));
    drag(svg(), 50, 40);
    const after = view();
    expect(after.x).toBeCloseTo(before.x + 50, 1);
    expect(after.y).toBeCloseTo(before.y + 40, 1);
    expect(after.k).toBe(before.k);
    expect(["A", "B", "C"].map((id) => translate(nodeElement(id)))).toEqual(nodesBefore);
  });

  it("zooms with the wheel; at a zoom other than 1 a dragged node still moves exactly with the cursor", () => {
    render(<Harness />);
    const before = view();
    fireEvent.wheel(svg(), { deltaY: -400, clientX: 480, clientY: 280 });
    const zoomed = view();
    expect(zoomed.k).toBeGreaterThan(before.k);
    expect(zoomed.k).not.toBeCloseTo(1, 2);
    const origin = translate(nodeElement("B"));
    drag(nodeElement("B"), 45, 27);
    const moved = translate(nodeElement("B"));
    // Screen delta / zoom = graph delta: the point under the cursor stays under it.
    expect((moved.x - origin.x) * zoomed.k).toBeCloseTo(45, 0);
    expect((moved.y - origin.y) * zoomed.k).toBeCloseTo(27, 0);
  });

  it("moves the selected node with Alt + arrows (Shift for a larger step) and announces it", () => {
    const onMove = vi.fn();
    render(<Harness selectedId="C" onMove={onMove} />);
    const { k } = view();
    const c = nodeElement("C");
    c.focus();
    fireEvent.keyDown(c, { key: "ArrowRight", altKey: true });
    expect(translate(nodeElement("C")).x).toBeCloseTo(100 + MOVE_STEP / k, 0);
    fireEvent.keyDown(c, { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(translate(nodeElement("C")).y).toBeCloseTo(160 - MOVE_STEP_LARGE / k, 0);
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Узел перемещён");
    // Without Alt the arrows still pan the map.
    const before = view();
    fireEvent.keyDown(svg(), { key: "ArrowLeft" });
    expect(view().x).toBeGreaterThan(before.x);
  });

  it("enables «Сбросить расположение» only with manual positions and «Вписать» keeps them", () => {
    render(<Harness />);
    const reset = screen.getByRole("button", { name: "Сбросить расположение" });
    expect(reset).toBeDisabled();
    drag(nodeElement("A"), 40, 40);
    expect(reset).toBeEnabled();
    const moved = translate(nodeElement("A"));
    fireEvent.click(screen.getByRole("button", { name: "Увеличить" }));
    fireEvent.click(screen.getByRole("button", { name: "Вписать" }));
    expect(translate(nodeElement("A"))).toEqual(moved);
    fireEvent.click(reset);
    expect(translate(nodeElement("A"))).toEqual({ x: 0, y: 0 });
    expect(reset).toBeDisabled();
  });
});

/** The declarations of one CSS rule of `app.css`, by its exact selector. */
function cssRule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

const opacityOf = (selector: string) => Number(/opacity:\s*([\d.]+)/.exec(cssRule(selector))?.[1]);

describe("Knowledge map: edges of the whole base", () => {
  const edgeClasses = () =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<SVGPathElement>(".graph-edges [data-edge-id]")).map((path) => [
        path.dataset.edgeId,
        path.classList.contains("is-lit") ? "lit" : path.classList.contains("is-faded") ? "faded" : "rest",
      ]),
    );

  it("keeps every edge faint until one of its nodes is hovered or selected", () => {
    const { rerender } = render(<Harness overview />);
    expect(document.querySelector(".graph-edges")).toHaveClass("graph-edges--quiet");
    expect(edgeClasses()).toEqual({ "edge:A:B": "rest", "edge:B:C": "rest" });
    // Hover: the node's edges are fully visible, the others fade further; leaving the canvas puts them back.
    fireEvent.pointerOver(nodeElement("A"));
    expect(edgeClasses()).toEqual({ "edge:A:B": "lit", "edge:B:C": "faded" });
    // The highlighted edge keeps its relation label.
    expect(document.querySelector('[data-edge-label="edge:A:B"]')).toHaveTextContent("зависит от");
    fireEvent.pointerLeave(svg());
    expect(edgeClasses()).toEqual({ "edge:A:B": "rest", "edge:B:C": "rest" });
    expect(document.querySelector("[data-edge-label]")).toBeNull();
    // Selection: the same, for as long as the node is selected.
    rerender(<Harness overview selectedId="B" />);
    expect(edgeClasses()).toEqual({ "edge:A:B": "lit", "edge:B:C": "lit" });
  });

  it("draws the edges of a neighbourhood or an answer graph as before (no faint resting state)", () => {
    render(<Harness />);
    expect(document.querySelector(".graph-edges")).not.toHaveClass("graph-edges--quiet");
  });

  it("styles a resting edge almost transparent, a lit one fully visible, and keeps unconfirmed edges dashed", () => {
    const rest = opacityOf(".graph-edges--quiet .graph-edge");
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThanOrEqual(0.25);
    expect(opacityOf(".graph-edges--quiet .graph-edge.is-lit")).toBe(1);
    expect(opacityOf(".graph-edges--quiet .graph-edge.is-faded")).toBeLessThan(rest);
    // Confirmed vs unconfirmed stays visible when lit: the dash is on the edge itself, whatever its state.
    expect(cssRule(".graph-edge--unconfirmed")).toContain("stroke-dasharray");
  });
});

describe("Knowledge map: labels", () => {
  const demoNodes: GraphNode[] = (demo.nodes as [string, GraphNodeKind, string, string | null, number][]).map(
    ([id, kind, label, status, degree]) => ({ ...node(id, kind), label, document_id: id.replace(/^doc:/, ""), status, degree }),
  );
  const demoEdges: GraphEdge[] = (demo.edges as [string, GraphRelation, string][]).map(([source, type, target], i) => ({
    ...edge(source, target),
    id: `edge:${i}`,
    type,
  }));
  const degree = new Map<string, number>();
  for (const e of demoEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const neighboursOf = (id: string) =>
    new Set(demoEdges.flatMap((e) => (e.source === id ? [e.target] : e.target === id ? [e.source] : [])));
  const top = topByDegree(demoNodes, degree);
  const demoLayout = layoutGraph(demoNodes, demoEdges, null);

  function MapView({ nodes = demoNodes, edges = demoEdges, layout = demoLayout, selectedId = null, overview = true }: {
    nodes?: GraphNode[];
    edges?: GraphEdge[];
    layout?: Layout;
    selectedId?: string | null;
    overview?: boolean;
  }) {
    return (
      <MemoryRouter>
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          layout={layout}
          overrides={new Map()}
          onMoveNode={() => {}}
          onResetLayout={() => {}}
          center={null}
          selectedId={selectedId}
          matches={new Set()}
          labels={graphLabels(null)}
          onSelect={() => {}}
          focusRequest={null}
          overview={overview}
        />
      </MemoryRouter>
    );
  }

  const labelled = () => new Set(Array.from(document.querySelectorAll<SVGTextElement>("[data-label-for]")).map((el) => el.dataset.labelFor ?? ""));

  /** The screen box of every drawn node label, rebuilt from its position, side and text as the canvas places it. */
  function labelBoxes(layout: Layout): Box[] {
    return Array.from(document.querySelectorAll<SVGTextElement>("[data-label-for]")).map((element) => {
      const k = LABEL_FONT_SIZE / Number(element.getAttribute("font-size"));
      const at = translate(element);
      const anchor = element.getAttribute("text-anchor");
      const side: LabelSide = anchor === "start" ? "right" : anchor === "end" ? "left" : Number(element.getAttribute("y")) > 0 ? "below" : "above";
      const id = element.dataset.labelFor ?? "";
      const width = estimateTextWidth(element.textContent ?? "", LABEL_FONT_SIZE, element.classList.contains("is-strong"));
      return labelBox({ x: at.x * k, y: at.y * k, ext: (layout.extent.get(id) ?? 0) * k, width, height: LABEL_HEIGHT }, side);
    });
  }

  function expectNoOverlaps(layout: Layout) {
    const boxes = labelBoxes(layout);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1, `labels ${i} and ${j} overlap`).toBe(false);
      }
    }
  }

  it("names only the 15 most connected nodes at rest, without overlaps; a hidden name stays in the title and the accessible name", () => {
    render(<MapView />);
    const named = labelled();
    expect(named.size).toBeGreaterThanOrEqual(10);
    expect(named.size).toBeLessThanOrEqual(15);
    for (const id of named) expect(top.has(id), id).toBe(true);
    expectNoOverlaps(demoLayout);
    const hidden = demoNodes.find((n) => !named.has(n.id))!;
    const element = nodeElement(hidden.id);
    expect(element.querySelector("title")).toHaveTextContent(hidden.label);
    expect(element.getAttribute("aria-label")?.startsWith(`${hidden.label}.`)).toBe(true);
  });

  it("names the selected node and its neighbours before the most connected; while hovering, the hovered node and its neighbours", () => {
    // A node outside the top 15 with neighbours outside it too: selection, not degree, decides.
    const selected = demoNodes.find((n) => !top.has(n.id) && [...neighboursOf(n.id)].filter((id) => !top.has(id)).length >= 2)!;
    const { rerender } = render(<MapView selectedId={selected.id} />);
    let named = labelled();
    expect(named.has(selected.id)).toBe(true);
    expect(document.querySelector(`[data-label-for="${selected.id}"]`)).toHaveClass("is-strong");
    const around = neighboursOf(selected.id);
    for (const id of named) expect(id === selected.id || around.has(id), id).toBe(true);
    expect([...named].some((id) => !top.has(id) && id !== selected.id)).toBe(true);
    expectNoOverlaps(demoLayout);

    // Hover another node: it is always named, with its own neighbours; the selected node keeps its name.
    const hovered = demoNodes.find((n) => n.id !== selected.id && !around.has(n.id) && neighboursOf(n.id).size >= 3)!;
    fireEvent.pointerOver(nodeElement(hovered.id));
    named = labelled();
    expect(named.has(hovered.id)).toBe(true);
    expect(named.has(selected.id)).toBe(true);
    const near = neighboursOf(hovered.id);
    for (const id of named) expect(id === selected.id || id === hovered.id || near.has(id), id).toBe(true);
    expectNoOverlaps(demoLayout);

    fireEvent.pointerLeave(svg());
    rerender(<MapView />);
    expect([...labelled()].every((id) => top.has(id))).toBe(true);
  });

  it("names every node of a small neighbourhood or answer graph where there is room, but only the top 15 of the whole base", () => {
    const grid = Array.from({ length: 20 }, (_, i) => ({ ...node(`N${i}`), label: `Узел ${i}` }));
    const chain = grid.slice(1).map((n, i) => edge(grid[i]!.id, n.id));
    const positions = new Map(grid.map((n, i) => [n.id, { x: (i % 5) * 170, y: Math.floor(i / 5) * 120 }]));
    const layout: Layout = {
      positions,
      radius: new Map(grid.map((n) => [n.id, 10])),
      extent: new Map(grid.map((n) => [n.id, nodeExtent(n.kind, 10)])),
      bounds: { minX: -13, minY: -13, maxX: 693, maxY: 373 },
    };
    const { unmount } = render(<MapView nodes={grid} edges={chain} layout={layout} overview={false} />);
    expect(labelled().size).toBe(20);
    unmount();
    render(<MapView nodes={grid} edges={chain} layout={layout} />);
    expect(labelled().size).toBe(15);
  });
});

describe("Knowledge map: the legend and the fitted view", () => {
  /** A ResizeObserver the test drives: jsdom has none. */
  class FakeResizeObserver {
    static all: FakeResizeObserver[] = [];
    elements: Element[] = [];
    constructor(readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.all.push(this);
    }
    observe(element: Element) {
      this.elements.push(element);
    }
    unobserve() {}
    disconnect() {
      this.elements = [];
    }
  }
  const resized = (element: Element) => {
    for (const observer of FakeResizeObserver.all) {
      if (observer.elements.includes(element)) act(() => observer.callback([], observer as unknown as ResizeObserver));
    }
  };

  beforeEach(() => {
    FakeResizeObserver.all = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  it("fits the graph again when the legend opens or closes, unless the user has moved the view", () => {
    render(<Harness withLegend />);
    const legend = document.querySelector(".graph-legend")!;
    resized(legend); // the observer's first report: no change
    const closed = view();
    // Opened, the legend takes the bottom-left corner: the graph is fitted beside it (here: to its right).
    fireEvent.click(screen.getByRole("button", { name: "Условные обозначения" }));
    vi.spyOn(legend, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 314, 440, 230));
    resized(legend);
    const opened = view();
    expect(opened).not.toEqual(closed);
    // The graph's left edge (x = -13 in graph units) is now right of the legend (16 + 440 px).
    expect(opened.x + opened.k * -13).toBeGreaterThan(456);
    // Closed again: back to the full fit.
    fireEvent.click(screen.getByRole("button", { name: "Условные обозначения" }));
    resized(legend);
    expect(view()).toEqual(closed);
    // After a pan the view is the user's: the legend does not move it.
    drag(svg(), 40, 30);
    const panned = view();
    fireEvent.click(screen.getByRole("button", { name: "Условные обозначения" }));
    resized(legend);
    expect(view()).toEqual(panned);
  });
});
