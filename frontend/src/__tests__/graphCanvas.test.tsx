import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode, GraphNodeKind } from "../api/types";
import { DRAG_THRESHOLD, GraphCanvas, MOVE_STEP, MOVE_STEP_LARGE } from "../components/GraphCanvas";
import { graphLabels, nodeExtent, type Layout, type Point } from "../lib/graph";

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
}

/** The canvas with its manual positions held like the page holds them. */
function Harness({ onSelect = () => {}, onMove = () => {}, selectedId = null, onRender }: HarnessProps) {
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
