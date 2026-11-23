import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphLegend, GraphNode, Subgraph } from "../api/types";
import { KIND_LABEL, ORIGIN_LABEL, RELATION_LABEL } from "../lib/graph";
import { GraphPage } from "../pages/GraphPage";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";

const LIMITS = { overview_default: 150, overview_max: 200, neighbours_max: 200, depth_max: 2, path_depth_max: 6 };
const legend: GraphLegend = { kinds: KIND_LABEL, relations: RELATION_LABEL, origins: ORIGIN_LABEL, limits: LIMITS };
const TRACE = "TRACE-0123456789abcdef";

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: "doc:DEMO-INT-002",
    kind: "integration",
    label: "ARIS → Catalog: маппинг полей (демо)",
    document_id: "DEMO-INT-002",
    doc_type: "integration",
    status: "approved",
    owner: "demo-integration-team",
    source_kind: "local_markdown",
    revision: "sha256:6c4ec69a72412e64",
    version: "1.3",
    url: "/documents/DEMO-INT-002",
    synthetic: true,
    expires_at: null,
    degree: 12,
    ...overrides,
  };
}

function edge(overrides: Partial<GraphEdge>): GraphEdge {
  return {
    id: "edge:DEMO-INT-002:maps_to:DEMO-SEM-002",
    source: "doc:DEMO-INT-002",
    target: "doc:DEMO-SEM-002",
    type: "maps_to",
    origin: "canonical_metadata",
    verified: true,
    declared_in: "DEMO-INT-002",
    field: "relations.maps_to",
    path: "integrations/DEMO-INT-002.md",
    revision: "sha256:6c4ec69a72412e64",
    status: "active",
    expires_at: null,
    feedback: null,
    ...overrides,
  };
}

function subgraph(nodes: GraphNode[], edges: GraphEdge[], extra: Partial<Subgraph> = {}): Subgraph {
  return {
    nodes,
    edges,
    total_nodes: nodes.length,
    total_edges: edges.length,
    partial: false,
    generation: "g1",
    next_cursor: null,
    focus: null,
    limits: LIMITS,
    ...extra,
  };
}

const integration = node({});
const entity = node({
  id: "doc:DEMO-SEM-002",
  kind: "semantic_entity",
  label: "Логическая модель: BusinessProcess",
  document_id: "DEMO-SEM-002",
  doc_type: "domain",
  owner: "demo-semantic-team",
  revision: "sha256:8a282cf393c92440",
  version: "1.4",
  url: "/documents/DEMO-SEM-002",
  degree: 17,
});
const governance = node({
  id: "doc:DEMO-GOV-006",
  kind: "document",
  label: "Правила ссылочной целостности (демо)",
  document_id: "DEMO-GOV-006",
  doc_type: "standard",
  status: "draft",
  owner: "demo-governance-team",
  revision: "sha256:db498a70b5407184",
  version: "1.2",
  url: "/documents/DEMO-GOV-006",
  degree: 7,
});
const mapsTo = edge({});
const constrains = edge({
  id: "edge:DEMO-GOV-006:constrains:DEMO-INT-002",
  source: "doc:DEMO-GOV-006",
  target: "doc:DEMO-INT-002",
  type: "constrains",
  declared_in: "DEMO-GOV-006",
  field: "relations.constrains",
  path: "governance/DEMO-GOV-006.md",
  revision: "sha256:db498a70b5407184",
});

const overview = subgraph([entity, integration, governance], [mapsTo, constrains]);
const NEIGHBOURS = "/api/graph/nodes/doc%3ADEMO-INT-002/neighbors";

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [...extra, { path: "/api/graph/legend", body: legend }];
}

const GRAPH = { "/graph": <GraphPage /> };
const panel = () => screen.getByRole("complementary", { name: "Сведения об узле" });

describe("Knowledge graph", () => {
  it("shows the global graph as accessible lists; selecting a node shows its metadata and why it is linked", async () => {
    const calls = mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа: 3 узла, 2 связи/ });

    await userEvent.click(screen.getByRole("radio", { name: "Списком" }));
    const nodes = screen.getByRole("heading", { name: "Узлы (3)" }).closest("section") as HTMLElement;
    expect(within(nodes).getByText("DEMO-INT-002")).toBeInTheDocument();
    const edges = screen.getByRole("heading", { name: "Связи (2)" }).closest("section") as HTMLElement;
    expect(within(edges).getAllByText("отображается в")).toHaveLength(1);

    await userEvent.click(within(nodes).getByRole("button", { name: "ARIS → Catalog: маппинг полей (демо)" }));
    expect(within(nodes).getByRole("button", { name: "ARIS → Catalog: маппинг полей (демо)" })).toHaveAttribute("aria-pressed", "true");
    const details = panel();
    expect(within(details).getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeInTheDocument();
    expect(within(details).getByText("Утверждён")).toBeInTheDocument();
    expect(within(details).getByText("1.3")).toBeInTheDocument();
    expect(within(details).getByText("demo-integration-team")).toBeInTheDocument();
    expect(within(details).getByText(/Локальный workspace \(Markdown\)/)).toBeInTheDocument();
    // why linked: declaring document, field, file and revision
    const outgoing = within(details).getByRole("heading", { name: "Исходящие связи (1)" }).closest("section") as HTMLElement;
    expect(within(outgoing).getByText("relations.maps_to")).toBeInTheDocument();
    expect(within(outgoing).getByText("integrations/DEMO-INT-002.md")).toBeInTheDocument();
    expect(within(outgoing).getByText("Подтверждённая связь из метаданных документа", { exact: false })).toBeInTheDocument();
    const incoming = within(details).getByRole("heading", { name: "Входящие связи (1)" }).closest("section") as HTMLElement;
    expect(within(incoming).getByText("relations.constrains")).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "Открыть документ" })).toHaveAttribute("href", "/documents/DEMO-INT-002");
    expect(within(details).getByRole("link", { name: "Показать соседей" })).toHaveAttribute("href", "/graph?focus=DEMO-INT-002");
    expect(within(details).getByRole("link", { name: "Открыть в списке" })).toHaveAttribute("href", "/documents?query=DEMO-INT-002");

    const request = calls.find((c) => c.url === "/api/graph/overview?limit=150");
    expect(request?.headers["X-SKH-Client"]).toBe("web");
  });

  it("draws nodes as focusable buttons; Enter selects a node and Escape clears the selection", async () => {
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    renderRoutes("/graph", GRAPH);
    const target = await screen.findByRole("button", { name: /^Логическая модель: BusinessProcess\. Сущность \/ модель, Утверждён/ });
    expect(target).toHaveAttribute("tabindex", "0");
    target.focus();
    await userEvent.keyboard("{Enter}");
    expect(target).toHaveAttribute("aria-pressed", "true");
    expect(within(panel()).getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeInTheDocument();
    expect(within(panel()).getByText("этот узел")).toBeInTheDocument();
    // dashed only for unconfirmed origins: both edges here are canonical
    expect(document.querySelectorAll(".graph-canvas__svg .graph-edge--unconfirmed")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    expect(target).toHaveAttribute("aria-pressed", "false");
    expect(within(panel()).getByRole("heading", { name: "Сведения об узле" })).toBeInTheDocument();
  });

  it("finds a node by ID, highlights and selects it", async () => {
    mockApi(routes([{ path: "/api/graph/overview?limit=150", body: overview }]));
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    await userEvent.type(screen.getByLabelText("Найти узел"), "sem-002");
    await userEvent.click(screen.getByRole("button", { name: "Найти" }));
    expect(await screen.findByText("Найден 1 узел: выбран «Логическая модель: BusinessProcess».")).toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeInTheDocument();
    expect(document.querySelectorAll(".graph-node.is-match")).toHaveLength(1);
    expect(screen.getByTestId("location").textContent).toBe("/graph");
  });

  it("filters through the URL and asks the server for the filtered overview", async () => {
    const calls = mockApi(
      routes([
        { path: "/api/graph/overview?limit=150", body: overview },
        { path: "/api/graph/overview?limit=150&kind=integration", body: subgraph([integration], []) },
      ]),
    );
    renderRoutes("/graph", GRAPH);
    await screen.findByRole("group", { name: /Схема графа/ });
    await userEvent.selectOptions(screen.getByLabelText("Тип узла"), "integration");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/graph?kind=integration"));
    expect(await screen.findByText("Связей между показанными узлами нет — измените фильтр.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/graph/overview?limit=150&kind=integration")).toBe(true);
  });

  it("shows a neighbourhood with the centre selected, a partial notice and loads more neighbours with the cursor", async () => {
    const extra = node({
      id: "doc:DEMO-INT-011",
      label: "Интеграционные ошибки и retry",
      document_id: "DEMO-INT-011",
      url: "/documents/DEMO-INT-011",
    });
    const calls = mockApi(
      routes([
        {
          path: `${NEIGHBOURS}?depth=1&limit=100`,
          body: subgraph([integration, entity], [mapsTo], {
            total_nodes: 3,
            partial: true,
            next_cursor: 1,
            focus: "doc:DEMO-INT-002",
          }),
        },
        {
          path: `${NEIGHBOURS}?depth=1&limit=100&cursor=1`,
          body: subgraph([integration, extra], [edge({ id: "e2", source: "doc:DEMO-INT-011", target: "doc:DEMO-INT-002", type: "references", field: "related_ids", declared_in: "DEMO-INT-011", path: "integrations/DEMO-INT-011.md" })], {
            total_nodes: 3,
            focus: "doc:DEMO-INT-002",
          }),
        },
      ]),
    );
    renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    expect(
      await screen.findByText("Показана часть графа: 2 из 3 узлов — уточните фильтр или откройте окружение узла."),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Путь" })).toHaveTextContent("Окружение DEMO-INT-002");
    // the centre is selected: its links are explained right away
    expect(within(panel()).getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeInTheDocument();
    expect(within(panel()).getByText("relations.maps_to")).toBeInTheDocument();
    expect(within(panel()).queryByRole("link", { name: "Показать соседей" })).toBeNull();

    await userEvent.click(within(panel()).getByRole("button", { name: "Показать соседей" }));
    await userEvent.click(screen.getByRole("radio", { name: "Списком" }));
    const nodes = (await screen.findByRole("heading", { name: "Узлы (3)" })).closest("section") as HTMLElement;
    expect(within(nodes).getByRole("button", { name: "Интеграционные ошибки и retry" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === `${NEIGHBOURS}?depth=1&limit=100&cursor=1`)).toBe(true);
    expect(screen.queryByText(/Показана часть графа/)).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "2 шага" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/graph?focus=DEMO-INT-002&depth=2"));
  });

  it("explains an unknown node", async () => {
    mockApi(
      routes([
        {
          path: `${NEIGHBOURS}?depth=1&limit=100`,
          status: 404,
          body: { code: "graph_node_not_found", message: "Узел графа не найден.", request_id: "g-1" },
        },
      ]),
    );
    renderRoutes("/graph?focus=DEMO-INT-002", GRAPH);
    expect(await screen.findByRole("alert")).toHaveTextContent("Узел графа не найден");
    expect(screen.getByRole("link", { name: "Открыть весь граф" })).toHaveAttribute("href", "/graph");
  });

  it("shows the evidence graph of an answer: external pages are temporary and their status is not confirmed", async () => {
    const query = node({
      id: `query:${TRACE}`,
      kind: "query_context",
      label: "Вопрос (заморозк, метаданн, окн)",
      document_id: null,
      doc_type: null,
      status: null,
      owner: null,
      source_kind: "query_trace",
      revision: null,
      version: null,
      url: null,
      synthetic: false,
      expires_at: "2026-11-24T12:00:00+00:00",
      degree: 0,
    });
    const page = node({
      id: "ext:confluence:demo-wiki:200101:3",
      kind: "external_page",
      label: "Регламент заморозки изменений метаданных (демо)",
      document_id: null,
      doc_type: null,
      status: "unknown",
      owner: null,
      source_kind: "confluence_mcp",
      revision: null,
      version: "3",
      url: "/corporate/200101",
      expires_at: "2026-11-24T12:00:00+00:00",
      degree: 0,
    });
    const traceEdge = (type: "retrieved_for" | "cited_in"): GraphEdge =>
      edge({
        id: `edge:${TRACE}:${type}:${page.id}`,
        source: page.id,
        target: query.id,
        type,
        origin: "query_trace",
        verified: type === "cited_in",
        declared_in: null,
        field: type === "retrieved_for" ? "s3, s2" : null,
        path: null,
        revision: "3",
        expires_at: "2026-11-24T12:00:00+00:00",
        feedback: "unrated",
      });
    mockApi(
      routes([
        {
          path: `/api/graph/query/${TRACE}`,
          body: subgraph([query, page], [traceEdge("retrieved_for"), traceEdge("cited_in")], { focus: query.id }),
        },
      ]),
    );
    renderRoutes(`/graph?trace=${TRACE}`, GRAPH);
    expect(await screen.findByRole("heading", { name: "Граф ответа", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Текст вопроса не хранится/)).toBeInTheDocument();
    expect(document.querySelectorAll(".graph-canvas__svg .graph-edge--unconfirmed")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /^Регламент заморозки изменений метаданных \(демо\)\. Внешняя страница Confluence, статус не подтверждён/ }));
    const details = panel();
    expect(within(details).getByText("статус не подтверждён")).toBeInTheDocument();
    const facts = within(details).getByText("Версия").closest("dl") as HTMLElement;
    expect(within(facts).getByText("3")).toBeInTheDocument();
    expect(within(details).getAllByText(/24 нояб\. 2026/).length).toBeGreaterThan(0);
    expect(within(details).getByText("s3, s2")).toBeInTheDocument();
    expect(within(details).getByText("процитирована в ответе", { selector: "dd" })).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "Открыть страницу" })).toHaveAttribute("href", "/corporate/200101");
    expect(within(details).queryByRole("link", { name: "Показать соседей" })).toBeNull();
    expect(within(details).queryByRole("link", { name: "Открыть документ" })).toBeNull();
  });

  it("says that an expired or erased answer trace is unavailable", async () => {
    mockApi(
      routes([
        {
          path: `/api/graph/query/${TRACE}`,
          status: 404,
          body: { code: "trace_not_found", message: "След запроса не найден или срок хранения истёк.", request_id: "t-1" },
        },
      ]),
    );
    renderRoutes(`/graph?trace=${TRACE}`, GRAPH);
    expect(await screen.findByRole("alert")).toHaveTextContent("След ответа недоступен: срок хранения истёк или данные удалены");
    expect(screen.getByRole("link", { name: "Спросить базу знаний" })).toHaveAttribute("href", "/ask");
  });

  it("does not request a malformed trace", async () => {
    const calls = mockApi(routes());
    renderRoutes("/graph?trace=TRACE-x", GRAPH);
    expect(await screen.findByRole("alert")).toHaveTextContent("След ответа недоступен");
    expect(calls.some((c) => c.url.startsWith("/api/graph/query/"))).toBe(false);
  });

  it("reports an unavailable backend with a retry", async () => {
    mockApi(
      routes([
        {
          path: "/api/graph/overview?limit=150",
          respond: () => Promise.reject(new TypeError("Failed to fetch")),
        },
      ]),
    );
    renderRoutes("/graph", GRAPH);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Сервер недоступен");
    expect(within(alert).getByRole("button", { name: "Повторить" })).toBeInTheDocument();
  });
});
