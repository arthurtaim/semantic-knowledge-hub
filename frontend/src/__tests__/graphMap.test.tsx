import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphLegend, GraphNode, GraphNodeKind, GraphRelation, Subgraph } from "../api/types";
import { KIND_LABEL, ORIGIN_LABEL, RELATION_LABEL, type Point } from "../lib/graph";
import { GraphPage } from "../pages/GraphPage";
import { memoryStorage, mockApi, mockViewport, renderRoutes, type MockRoute } from "./helpers";

/*
 * The knowledge map page around the canvas (docs/ui-v2/specs/04_KNOWLEDGE_GRAPH.md): manual positions live
 * apart from the layout per view, survive «Вписать», more neighbours and a filter change, are kept for the
 * session, and «Сбросить расположение» lays the map out again; the three modes, the legend of what is on the map
 * and the details as a sheet on phones.
 */

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

let session: Storage;
let browser: Storage;
beforeEach(() => {
  session = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
  browser = memoryStorage();
  vi.stubGlobal("localStorage", browser);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const LIMITS = { overview_default: 150, overview_max: 200, neighbours_max: 200, depth_max: 2, path_depth_max: 6 };
const legend: GraphLegend = { kinds: KIND_LABEL, relations: RELATION_LABEL, origins: ORIGIN_LABEL, limits: LIMITS };

function node(id: string, kind: GraphNodeKind, label: string, status: string | null = "approved"): GraphNode {
  return {
    id: `doc:${id}`,
    kind,
    label,
    document_id: id,
    doc_type: null,
    status,
    owner: "demo-team",
    source_kind: "local_markdown",
    revision: "sha256:0000000000000000",
    version: "1.0",
    url: `/documents/${id}`,
    synthetic: true,
    expires_at: null,
    degree: 3,
  };
}

function edge(source: string, type: GraphRelation, target: string): GraphEdge {
  return {
    id: `edge:${source}:${type}:${target}`,
    source: `doc:${source}`,
    target: `doc:${target}`,
    type,
    origin: "canonical_metadata",
    verified: true,
    declared_in: source,
    field: `relations.${type}`,
    path: `${source}.md`,
    revision: "sha256:0000000000000000",
    status: "active",
    expires_at: null,
    feedback: null,
  };
}

function subgraph(nodes: GraphNode[], edges: GraphEdge[], extra: Partial<Subgraph> = {}): Subgraph {
  return { nodes, edges, total_nodes: nodes.length, total_edges: edges.length, partial: false, generation: "g1", next_cursor: null, focus: null, limits: LIMITS, ...extra };
}

const focus = node("DEMO-INT-002", "integration", "ARIS → Catalog: маппинг полей");
const entity = node("DEMO-SEM-002", "semantic_entity", "Логическая модель: BusinessProcess");
const rule = node("DEMO-GOV-006", "document", "Правила ссылочной целостности", "draft");
const flow = node("DEMO-INT-001", "integration", "ARIS → Catalog: обзор потока");
const NEIGHBOURS = "/api/graph/nodes/doc%3ADEMO-INT-002/neighbors";

function routes(extra: MockRoute[]): MockRoute[] {
  return [...extra, { path: "/api/graph/legend", body: legend }];
}

const local = (): MockRoute[] =>
  routes([
    {
      path: `${NEIGHBOURS}?depth=1&limit=100`,
      body: subgraph([focus, entity, rule], [edge("DEMO-INT-002", "maps_to", "DEMO-SEM-002"), edge("DEMO-GOV-006", "constrains", "DEMO-INT-002")], {
        total_nodes: 4,
        partial: true,
        next_cursor: 1,
        focus: focus.id,
      }),
    },
    {
      path: `${NEIGHBOURS}?depth=1&limit=100&cursor=1`,
      body: subgraph([focus, flow], [edge("DEMO-INT-002", "depends_on", "DEMO-INT-001")], { total_nodes: 4, focus: focus.id }),
    },
  ]);

const GRAPH = { "/graph": <GraphPage /> };
const nodeElement = (id: string) => document.querySelector<SVGGElement>(`[data-node-id="doc:${id}"]`)!;

function translate(element: Element): Point {
  const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(element.getAttribute("transform") ?? "");
  if (!match) throw new Error("no translate");
  return { x: Number(match[1]), y: Number(match[2]) };
}

function drag(target: Element, dx: number, dy: number) {
  fireEvent.pointerDown(target, { clientX: 200, clientY: 200, button: 0, pointerId: 5 });
  for (let i = 1; i <= 4; i += 1) fireEvent.pointerMove(target, { clientX: 200 + (dx * i) / 4, clientY: 200 + (dy * i) / 4, pointerId: 5 });
  fireEvent.pointerUp(target, { clientX: 200 + dx, clientY: 200 + dy, pointerId: 5 });
}

describe("Knowledge map: manual positions", () => {
  it("keeps a dragged node through «Вписать», more neighbours and a filter change", async () => {
    mockApi(local());
    renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    await screen.findByRole("group", { name: /Схема графа: 3 узла/ });
    drag(nodeElement("DEMO-SEM-002"), 90, 60);
    const placed = translate(nodeElement("DEMO-SEM-002"));
    expect(screen.getByRole("button", { name: "Сбросить расположение" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Вписать" }));
    expect(translate(nodeElement("DEMO-SEM-002"))).toEqual(placed);

    // More neighbours: the map is laid out again around the pinned node.
    await userEvent.click(within(screen.getByRole("complementary", { name: "Сведения об узле" })).getByRole("button", { name: "Показать соседей" }));
    await screen.findByRole("group", { name: /Схема графа: 4 узла/ });
    expect(translate(nodeElement("DEMO-SEM-002"))).toEqual(placed);

    // A filter (client-side here) hides the draft; the manually placed node stays where it was put.
    await userEvent.click(screen.getByRole("button", { name: "Статус: все" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Утверждён" }));
    await screen.findByRole("group", { name: /Схема графа: 3 узла/ });
    expect(nodeElement("DEMO-GOV-006")).toBeNull();
    expect(translate(nodeElement("DEMO-SEM-002"))).toEqual(placed);
    expect(screen.getByRole("button", { name: "Сбросить расположение" })).toBeEnabled();
  });

  it("«Сбросить расположение» returns the computed positions and turns itself off", async () => {
    mockApi(local());
    renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    await screen.findByRole("group", { name: /Схема графа: 3 узла/ });
    const computed = translate(nodeElement("DEMO-GOV-006"));
    const reset = screen.getByRole("button", { name: "Сбросить расположение" });
    expect(reset).toBeDisabled();
    drag(nodeElement("DEMO-GOV-006"), -70, 40);
    expect(translate(nodeElement("DEMO-GOV-006"))).not.toEqual(computed);
    await userEvent.click(reset);
    expect(translate(nodeElement("DEMO-GOV-006"))).toEqual(computed);
    expect(reset).toBeDisabled();
  });

  it("remembers manual positions for the session, per view, and works when storage is blocked", async () => {
    mockApi(local());
    const first = renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    await screen.findByRole("group", { name: /Схема графа: 3 узла/ });
    drag(nodeElement("DEMO-SEM-002"), 50, 50);
    const placed = translate(nodeElement("DEMO-SEM-002"));
    expect(session.length).toBe(1);
    expect(session.key(0)).toContain("local|doc:DEMO-INT-002");
    first.unmount();

    renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    await screen.findByRole("group", { name: /Схема графа: 3 узла/ });
    expect(translate(nodeElement("DEMO-SEM-002"))).toEqual(placed);
    expect(screen.getByRole("button", { name: "Сбросить расположение" })).toBeEnabled();
  });

  it("still moves nodes when sessionStorage throws", async () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, clear: blocked, length: 0 });
    mockApi(local());
    renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    await screen.findByRole("group", { name: /Схема графа: 3 узла/ });
    const before = translate(nodeElement("DEMO-SEM-002"));
    drag(nodeElement("DEMO-SEM-002"), 40, 0);
    expect(translate(nodeElement("DEMO-SEM-002"))).not.toEqual(before);
  });
});

describe("Knowledge map: modes, legend, phone", () => {
  const overview = subgraph([focus, entity, rule], [edge("DEMO-INT-002", "maps_to", "DEMO-SEM-002"), edge("DEMO-GOV-006", "constrains", "DEMO-INT-002")]);

  it("switches «Вся база» → «Вокруг узла» for the selected document; «Граф ответа» waits for an answer", async () => {
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }, ...local()]));
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    const modes = screen.getByRole("group", { name: "Режим карты" });
    expect(within(modes).getByRole("radio", { name: "Вся база" })).toBeChecked();
    expect(within(modes).getByRole("radio", { name: "Вокруг узла" })).toBeDisabled();
    expect(within(modes).getByRole("radio", { name: "Граф ответа" })).toBeDisabled();

    const target = screen.getByRole("button", { name: /^ARIS → Catalog: маппинг полей\. Интеграция/ });
    target.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(within(modes).getByRole("radio", { name: "Вокруг узла" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/graph?focus=DEMO-INT-002"));
    expect(await screen.findByRole("navigation", { name: "Путь" })).toHaveTextContent("Окружение DEMO-INT-002");

    await userEvent.click(within(screen.getByRole("group", { name: "Режим карты" })).getByRole("radio", { name: "Вся база" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/graph"));
  });

  it("offers «Граф ответа» for the last answer opened in this tab", async () => {
    session.setItem("skh.graph.trace", "TRACE-0123456789abcdef");
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    const answer = within(screen.getByRole("group", { name: "Режим карты" })).getByRole("radio", { name: "Граф ответа" });
    expect(answer).toBeEnabled();
    await userEvent.click(answer);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/graph?trace=TRACE-0123456789abcdef"));
  });

  it("collapses the legend into one line by default: its title and the swatches of the kinds on the map", async () => {
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    const legendRegion = screen.getByRole("region", { name: "Условные обозначения" });
    const toggle = within(legendRegion).getByRole("button", { name: "Условные обозначения" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(legendRegion).getByText("Интеграция", { selector: "span" })).not.toBeVisible();
    // One swatch per kind on the map, in the legend's order, named on hover; decorative for screen readers.
    const swatches = legendRegion.querySelector(".graph-legend__swatches")!;
    expect(swatches).toHaveAttribute("aria-hidden", "true");
    expect(Array.from(swatches.querySelectorAll("svg title")).map((t) => t.textContent)).toEqual(["Документ", "Интеграция", "Сущность / модель"]);

    // Expanded: only the kinds and statuses on the map, both kinds of edges.
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(legendRegion.querySelector(".graph-legend__swatches")).toBeNull();
    for (const kind of ["Документ", "Интеграция", "Сущность / модель", "Черновик", "Подтверждённая связь", "Временная или не подтверждённая"]) {
      expect(within(legendRegion).getByText(kind)).toBeVisible();
    }
    expect(within(legendRegion).queryByText("Датасет")).toBeNull();
    expect(within(legendRegion).queryByText("Шаблон")).toBeNull();
    expect(browser.getItem("skh.graph.legend")).toBe("open");
  });

  it("remembers the legend's state in this browser and works without storage", async () => {
    browser.setItem("skh.graph.legend", "open");
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    const first = renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    const toggle = screen.getByRole("button", { name: "Условные обозначения" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(browser.getItem("skh.graph.legend")).toBe("closed");
    first.unmount();

    const second = renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    expect(screen.getByRole("button", { name: "Условные обозначения" })).toHaveAttribute("aria-expanded", "false");
    second.unmount();

    // Blocked storage: collapsed by default, and the toggle still works on this page.
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, clear: blocked, length: 0 });
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    const again = screen.getByRole("button", { name: "Условные обозначения" });
    expect(again).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(again);
    expect(again).toHaveAttribute("aria-expanded", "true");
  });

  it("on a phone opens the details as a sheet from the bottom and closes it back to the list", async () => {
    mockViewport(390);
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    renderRoutes("/graph", GRAPH);
    const list = await screen.findByRole("region", { name: /^Узлы/ });
    expect(screen.getByRole("button", { name: "Списком" })).toHaveAttribute("aria-pressed", "true");
    const panel = document.querySelector("aside.graph-panel") as HTMLElement;
    expect(panel).not.toBeVisible();

    const item = within(list).getByRole("button", { name: "Логическая модель: BusinessProcess" });
    await act(async () => {
      item.focus();
      await userEvent.click(item);
    });
    expect(panel).toBeVisible();
    expect(panel).toHaveClass("graph-panel--sheet");
    await waitFor(() => expect(within(panel).getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toHaveFocus());
    await userEvent.click(within(panel).getByRole("button", { name: "Закрыть сведения" }));
    expect(panel).not.toBeVisible();
    expect(item).toHaveFocus();
  });
});
