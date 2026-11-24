import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, GraphNodeKind, GraphRelation } from "../api/types";
import {
  edgeGeometry,
  edgeOffsets,
  estimateTextWidth,
  labelBox,
  layoutGraph,
  mergePositions,
  NODE_GAP,
  placeLabels,
  type LabelRequest,
  type Layout,
} from "../lib/graph";
import demo from "./graphDemo.json";

/*
 * The initial layout of the knowledge map (docs/ui-v2/specs/04_KNOWLEDGE_GRAPH.md §3) on the synthetic demo graph
 * (97 nodes, 326 edges) and on generated graphs: no overlapping shapes, deterministic, rings around a centre,
 * unlinked nodes in a ring at the edge, pinned nodes kept, 200 nodes well within 300 ms.
 */

function node(id: string, kind: GraphNodeKind = "document", label = id, status: string | null = "approved", degree = 0): GraphNode {
  return {
    id,
    kind,
    label,
    document_id: id.startsWith("doc:") ? id.slice(4) : null,
    doc_type: null,
    status,
    owner: null,
    source_kind: "local_markdown",
    revision: null,
    version: null,
    url: null,
    synthetic: true,
    expires_at: null,
    degree,
  };
}

function edge(source: string, type: GraphRelation, target: string, index = 0): GraphEdge {
  return {
    id: `edge:${source}:${type}:${target}:${index}`,
    source,
    target,
    type,
    origin: type === "retrieved_for" || type === "cited_in" ? "query_trace" : "canonical_metadata",
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

const demoNodes = (demo.nodes as [string, GraphNodeKind, string, string | null, number][]).map(([id, kind, label, status, degree]) =>
  node(id, kind, label, status, degree),
);
const demoEdges = (demo.edges as [string, GraphRelation, string][]).map(([s, type, t], i) => edge(s, type, t, i));

/** Every pair of shapes keeps at least the sum of their radii (plus `gap`) between centres. */
function overlaps(layout: Layout, gap = 0): string[] {
  const ids = [...layout.positions.keys()];
  const found: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      const pa = layout.positions.get(a)!;
      const pb = layout.positions.get(b)!;
      const need = layout.extent.get(a)! + layout.extent.get(b)! + gap;
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < need - 1e-6) found.push(`${a} × ${b}`);
    }
  }
  return found;
}

const distance = (layout: Layout, id: string) => {
  const p = layout.positions.get(id)!;
  return Math.hypot(p.x, p.y);
};

/** The neighbourhood of `focus` within `depth` steps, as the server returns it. */
function neighbourhood(focus: string, depth: number) {
  const keep = new Set([focus]);
  let frontier = [focus];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const e of demoEdges) {
      for (const [a, b] of [
        [e.source, e.target],
        [e.target, e.source],
      ] as const) {
        if (frontier.includes(a) && !keep.has(b)) {
          keep.add(b);
          next.push(b);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: demoNodes.filter((n) => keep.has(n.id)),
    edges: demoEdges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    depth1: new Set(demoEdges.flatMap((e) => (e.source === focus ? [e.target] : e.target === focus ? [e.source] : []))),
  };
}

/** The machine's load per core (≥ 1): tests run in Node, whose `os` module is loaded without typings here. */
async function loadPerCore(): Promise<number> {
  try {
    const os = (await import(/* @vite-ignore */ ["node", "os"].join(":"))) as { loadavg(): number[]; cpus(): unknown[] };
    return Math.max(1, (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length));
  } catch {
    return 1;
  }
}

function synthetic(count: number, edgeCount: number) {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const kinds: GraphNodeKind[] = ["document", "integration", "source_system", "dataset", "semantic_entity", "template"];
  const nodes = Array.from({ length: count }, (_, i) => node(`doc:SYN-${i}`, kinds[i % kinds.length], `Синтетический документ ${i}`));
  const types: GraphRelation[] = ["references", "references", "depends_on", "consumes", "describes"];
  const edges = Array.from({ length: edgeCount }, (_, i) => {
    const s = Math.floor(random() * count);
    let t = Math.floor(Math.sqrt(random()) * count);
    if (t === s) t = (t + 1) % count;
    return edge(`doc:SYN-${s}`, types[i % types.length] as GraphRelation, `doc:SYN-${t}`, i);
  });
  return { nodes, edges };
}

describe("Knowledge map layout", () => {
  it("lays out the demo graph (97 nodes, 326 edges) without overlapping shapes, the same way every time", () => {
    expect(demoNodes).toHaveLength(97);
    expect(demoEdges).toHaveLength(326);
    const layout = layoutGraph(demoNodes, demoEdges, null);
    expect(layout.positions.size).toBe(97);
    expect(overlaps(layout, NODE_GAP - 0.5)).toEqual([]);
    const again = layoutGraph(demoNodes, demoEdges, null);
    expect([...again.positions]).toEqual([...layout.positions]);
    // The bounds contain every shape.
    for (const [id, p] of layout.positions) {
      const e = layout.extent.get(id)!;
      expect(p.x - e).toBeGreaterThanOrEqual(layout.bounds.minX - 1e-6);
      expect(p.y + e).toBeLessThanOrEqual(layout.bounds.maxY + 1e-6);
    }
  });

  it("puts unlinked nodes (the unused templates) in a ring around the linked ones, not scattered among them", () => {
    const layout = layoutGraph(demoNodes, demoEdges, null);
    const linked = new Set(demoEdges.flatMap((e) => [e.source, e.target]));
    const isolated = demoNodes.filter((n) => !linked.has(n.id));
    expect(isolated.length).toBe(14);
    const xs = demoNodes.filter((n) => linked.has(n.id)).map((n) => layout.positions.get(n.id)!);
    const box = {
      minX: Math.min(...xs.map((p) => p.x)),
      maxX: Math.max(...xs.map((p) => p.x)),
      minY: Math.min(...xs.map((p) => p.y)),
      maxY: Math.max(...xs.map((p) => p.y)),
    };
    for (const n of isolated) {
      const p = layout.positions.get(n.id)!;
      const outside = p.x < box.minX || p.x > box.maxX || p.y < box.minY || p.y > box.maxY;
      // On the ellipse around the map: outside its box or at least beyond the linked nodes' reach on that axis.
      const ex = (p.x / ((box.maxX - box.minX) / 2)) ** 2 + (p.y / ((box.maxY - box.minY) / 2)) ** 2;
      expect(outside || ex > 1, n.id).toBe(true);
    }
  });

  it("centres a neighbourhood on its focus: depth 1 on the first ring, depth 2 further out", () => {
    const focus = "doc:DEMO-INT-002";
    const { nodes, edges, depth1 } = neighbourhood(focus, 2);
    expect(nodes.length).toBeGreaterThan(20);
    const layout = layoutGraph(nodes, edges, focus);
    expect(layout.positions.get(focus)).toEqual({ x: 0, y: 0 });
    expect(overlaps(layout)).toEqual([]);
    const first = nodes.filter((n) => depth1.has(n.id)).map((n) => distance(layout, n.id));
    const second = nodes.filter((n) => n.id !== focus && !depth1.has(n.id)).map((n) => distance(layout, n.id));
    expect(Math.max(...first)).toBeLessThan(Math.min(...second));
    // The first ring goes all the way round the focus (not bunched on one side).
    const angles = nodes
      .filter((n) => depth1.has(n.id))
      .map((n) => Math.atan2(layout.positions.get(n.id)!.y, layout.positions.get(n.id)!.x))
      .sort((a, b) => a - b);
    const gaps = angles.map((a, i) => (i === 0 ? a + 2 * Math.PI - (angles[angles.length - 1] as number) : a - (angles[i - 1] as number)));
    expect(Math.max(...gaps)).toBeLessThan(Math.PI * 0.75);
  });

  it("centres an answer graph on the question: cited sources first, sources found but not cited just outside, the rest further", () => {
    const q = "query:TRACE-0123456789abcdef";
    const nodes = [
      node(q, "query_context", "Вопрос", null),
      ...["A", "B", "C"].map((id) => node(`doc:${id}`, "integration")),
      node("doc:FOUND", "document"),
      ...["X", "Y", "Z"].map((id) => node(`doc:${id}`, "source_system")),
    ];
    const edges = [
      ...["A", "B", "C", "FOUND"].map((id) => edge(`doc:${id}`, "retrieved_for", q)),
      ...["A", "B", "C"].map((id) => edge(`doc:${id}`, "cited_in", q)),
      edge("doc:A", "consumes", "doc:X"),
      edge("doc:B", "produces", "doc:Y"),
      edge("doc:FOUND", "references", "doc:Z"),
    ];
    const layout = layoutGraph(nodes, edges, q);
    expect(layout.positions.get(q)).toEqual({ x: 0, y: 0 });
    const cited = ["A", "B", "C"].map((id) => distance(layout, `doc:${id}`));
    const found = distance(layout, "doc:FOUND");
    const rest = ["X", "Y", "Z"].map((id) => distance(layout, `doc:${id}`));
    expect(Math.max(...cited)).toBeLessThan(found);
    expect(found).toBeLessThan(Math.min(...rest));
    expect(overlaps(layout)).toEqual([]);
  });

  it("keeps pinned (manually placed) nodes exactly where they are and lays the others out around them", () => {
    const pinned = new Map([
      ["doc:DEMO-SEM-002", { x: 900, y: -40 }],
      ["doc:DEMO-INT-001", { x: -700, y: 300 }],
    ]);
    const layout = layoutGraph(demoNodes, demoEdges, null, undefined, { pinned });
    expect(layout.positions.get("doc:DEMO-SEM-002")).toEqual({ x: 900, y: -40 });
    expect(layout.positions.get("doc:DEMO-INT-001")).toEqual({ x: -700, y: 300 });
    expect(overlaps(layout)).toEqual([]);
    // Around a centre too: a pinned neighbour stays put, the centre stays at (0, 0).
    const { nodes, edges } = neighbourhood("doc:DEMO-INT-002", 1);
    const moved = nodes.find((n) => n.id !== "doc:DEMO-INT-002")!.id;
    const local = layoutGraph(nodes, edges, "doc:DEMO-INT-002", undefined, { pinned: new Map([[moved, { x: 333, y: 44 }]]) });
    expect(local.positions.get(moved)).toEqual({ x: 333, y: 44 });
    expect(local.positions.get("doc:DEMO-INT-002")).toEqual({ x: 0, y: 0 });
  });

  it("merges manual positions over the layout: final position = override ?? layout", () => {
    const layout = layoutGraph(demoNodes.slice(0, 5), [], null);
    const merged = mergePositions(layout.positions, new Map([[demoNodes[1]!.id, { x: 1, y: 2 }], ["doc:GONE", { x: 3, y: 4 }]]));
    expect(merged.get(demoNodes[1]!.id)).toEqual({ x: 1, y: 2 });
    expect(merged.get(demoNodes[0]!.id)).toEqual(layout.positions.get(demoNodes[0]!.id));
    expect(merged.has("doc:GONE")).toBe(false);
  });

  it("lays out 200 nodes and 600 edges in well under 300 ms, without overlaps", async () => {
    const { nodes, edges } = synthetic(200, 600);
    layoutGraph(nodes.slice(0, 30), edges.slice(0, 40), null); // warm-up
    // The best of three runs: the test suite runs files in parallel, a single run measures the machine's load.
    let best = Infinity;
    let layout: Layout | null = null;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      layout = layoutGraph(nodes, edges, null);
      best = Math.min(best, performance.now() - started);
    }
    // 300 ms on an idle laptop (the spec); on a busy machine the budget grows with the load per core.
    expect(best).toBeLessThan(300 * (await loadPerCore()));
    expect(overlaps(layout as Layout)).toEqual([]);
  });
});

describe("Edges and labels", () => {
  it("fans parallel edges of one pair out to both sides and stops before the target's rim", () => {
    const a = "doc:A";
    const b = "doc:B";
    const edges = [edge(a, "references", b), edge(a, "depends_on", b), edge(b, "references", a)];
    const offsets = edgeOffsets(edges);
    const at: Record<string, { x: number; y: number }> = { [a]: { x: 0, y: 0 }, [b]: { x: 100, y: 0 } };
    // Three distinct curves, whichever way each edge points.
    const middles = edges.map((e) => edgeGeometry(at[e.source]!, at[e.target]!, 10, 13, offsets.get(e.id) ?? 0).mid.y.toFixed(1));
    expect(new Set(middles).size).toBe(3);
    const straight = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 13, 0);
    expect(straight.d).toBe("M10.0,0.0L87.0,0.0");
    expect(straight.mid).toEqual({ x: 48.5, y: 0 });
    const curved = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 13, 18);
    expect(curved.d.startsWith("M")).toBe(true);
    expect(curved.d).toContain("Q50.0,18.0");
  });

  it("places labels by priority: none overlap, a forced one (the selected node) is always placed", () => {
    const sides: LabelRequest["sides"] = ["right", "left", "below", "above"];
    const requests: LabelRequest[] = [
      { key: "n:selected", x: 0, y: 0, ext: 10, width: 120, height: 15, sides, own: "selected", force: true },
      { key: "n:near", x: 60, y: 0, ext: 10, width: 120, height: 15, sides, own: "near" },
      { key: "n:same", x: 0, y: 0, ext: 10, width: 120, height: 15, sides, own: "same" },
    ];
    const placed = placeLabels(requests, [
      { id: "selected", x: 0, y: 0, r: 10 },
      { id: "near", x: 60, y: 0, r: 10 },
    ]);
    // The selected label avoids the neighbouring node (right is blocked by it): it goes to the left.
    expect(placed.get("n:selected")).toBe("left");
    expect(placed.get("n:near")).toBe("right");
    // A third label at the same spot fits only below or above.
    expect(["below", "above"]).toContain(placed.get("n:same"));
    // Nothing fits, but the selected node is always named.
    const crowded = placeLabels(
      [
        { ...requests[1]!, key: "n:first", sides: ["right"] },
        { ...requests[1]!, key: "n:second", sides: ["right"] },
        { ...requests[1]!, key: "n:forced", sides: ["right"], force: true },
      ],
      [],
    );
    expect([...crowded.keys()]).toEqual(["n:first", "n:forced"]);
    const boxes = [...placed].map(([key, side]) => labelBox(requests.find((r) => r.key === key)!, side));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
      }
    }
    // A label outside the allowed area is not placed there.
    const inArea = placeLabels([{ ...requests[1]!, key: "n:edge", sides: ["right", "left"] }], [], { x0: -200, y0: -50, x1: 60, y1: 50 });
    expect(inArea.get("n:edge")).toBe("left");
  });

  it("estimates label widths from the text (wider for capitals and bold)", () => {
    expect(estimateTextWidth("ARIS", 11.5)).toBeGreaterThan(estimateTextWidth("aris", 11.5));
    expect(estimateTextWidth("Каталог", 11.5, true)).toBeGreaterThan(estimateTextWidth("Каталог", 11.5));
    expect(estimateTextWidth("Логическая модель: BusinessProcess", 11.5)).toBeGreaterThan(150);
  });
});
