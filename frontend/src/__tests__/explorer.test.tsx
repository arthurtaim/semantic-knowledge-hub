import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentPage, DocumentSummary } from "../api/types";
import { activeFilters, graphHref, groupDocuments, toggleValue } from "../lib/catalog";
import { formatWhen } from "../lib/labels";
import { ExplorerPage } from "../pages/ExplorerPage";
import { arisSummary, documentPage, emptyPage, facets, staleSync } from "./fixtures";
import { memoryStorage, mockApi, mockViewport, renderAt, renderRoutes } from "./helpers";

const doc = (overrides: Partial<DocumentSummary>): DocumentSummary => ({ ...arisSummary, ...overrides });
/** Three sections, two statuses: enough to see grouping. */
const catalog: DocumentPage = {
  items: [
    doc({ id: "DEMO-INT-001", title: "ARIS → Catalog: обзор потока", status: "approved", type: "integration", owner: "demo-integration-team" }),
    doc({ id: "DEMO-INT-018", title: "Ночная полная выгрузка ARIS", status: "deprecated", type: "integration", owner: "demo-integration-team" }),
    doc({ id: "DEMO-SRC-010", title: "Archive Store: исторические снимки", status: "in_review", type: "source", owner: "demo-semantic-team" }),
    doc({ id: "DEMO-SEM-009", title: "Датасет Process Overview", status: "approved", type: "dataset", owner: "demo-semantic-team" }),
  ],
  total: 4,
  page: 1,
  size: 100,
};
const allFacets = {
  ...facets,
  types: [
    { value: "source", count: 1 },
    { value: "dataset", count: 1 },
    { value: "integration", count: 2 },
  ],
  statuses: [
    { value: "approved", count: 2 },
    { value: "in_review", count: 1 },
    { value: "deprecated", count: 1 },
  ],
};

const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Catalog: the list with snippets (a search)", () => {
  it("shows search results with status, provenance and highlighted snippet", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?query=ARIS&page=1&size=20", body: documentPage },
    ]);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);

    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(link).toHaveAttribute("href", "/documents/SEM-INT-ARIS-001");
    const result = link.closest("li") as HTMLElement;
    expect(within(result).getByText("Черновик")).toBeInTheDocument();
    expect(within(result).getByText("SEM-INT-ARIS-001")).toBeInTheDocument();
    expect(within(result).getByText("Локальный workspace")).toBeInTheDocument();
    expect(within(result).getByText("ARIS", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText(/1 документ по запросу «ARIS»/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Создать документ" })).toHaveAttribute("href", "/documents/new");
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    // the query itself is a removable chip
    expect(screen.getByRole("button", { name: "Убрать запрос" })).toBeInTheDocument();
  });

  it("shows an explicit empty state instead of inventing results", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?query=/, body: emptyPage },
    ]);
    renderAt("/documents?query=nothing", "/documents", <ExplorerPage />);
    expect(await screen.findByText("По запросу «nothing» ничего не найдено")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem", { name: /ARIS/ })).toHaveLength(0);
  });

  it("reports server errors with the request id", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, status: 500, body: { code: "internal_error", message: "Внутренняя ошибка сервера.", request_id: "abc123" } },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Внутренняя ошибка сервера.");
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });

  it("searches from «Найти в списке» through the URL", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    const field = await screen.findByRole("searchbox", { name: "Поиск по документам" });
    expect(field).toHaveAttribute("placeholder", "Найти в списке");
    await userEvent.type(field, "ARIS{Enter}");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/documents?query=ARIS&page=1&size=20")).toBe(true));
    // without a remembered choice a search shows the list with snippets
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sorts through the «Вид» menu (URL-backed) and shows the update date", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const result = link.closest("li") as HTMLElement;
    expect(within(result).getByText("Обновлён")).toBeInTheDocument();
    expect(within(result).getByText(formatWhen(arisSummary.updated_at).text, { exact: false })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Вид" }));
    const menu = screen.getByRole("menu", { name: "Вид списка" });
    expect(within(menu).getByRole("menuitemradio", { name: "Релевантность" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Сначала новые" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/documents?query=ARIS&page=1&size=20&sort=updated")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Вид" }));
    expect(screen.getByRole("menuitemradio", { name: "Сначала новые" })).toHaveAttribute("aria-checked", "true");
  });

  it("restores the sort from the URL and offers relevance only with a query", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [{ ...arisSummary, index_state: "stale", updated_at: null }] } },
    ]);
    renderAt("/documents?sort=status", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const row = link.closest("tr") as HTMLElement;
    expect(within(row).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    expect(within(row).getByText("не указано")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Вид" }));
    expect(screen.getByRole("menuitemradio", { name: "Статус" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("menuitemradio", { name: "Релевантность" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "По разделам" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/documents?page=1&size=100&sort=status")).toBe(true);
  });

  it("says when the listed documents come from a stale index", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/index/status", body: staleSync },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    expect(await screen.findByText("Данные могут быть устаревшими.")).toBeInTheDocument();
  });

  it("shows the source once above the list when all results share it", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(screen.getByText("Источник: Локальный workspace")).toBeInTheDocument();
    // the row still names its source for screen readers
    const source = within(link.closest("li") as HTMLElement).getByText("Локальный workspace");
    expect(source.closest("div")).toHaveClass("visually-hidden");
  });

  it("shows the source on every row when the results mix sources (list and table)", async () => {
    const gitlabDoc = { ...arisSummary, id: "SEM-GL-001", title: "GitLab document", source: "gitlab" as const };
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [arisSummary, gitlabDoc], total: 2 } },
    ]);
    renderAt("/documents?query=x", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "GitLab document" });
    expect(screen.queryByText(/^Источник:/)).toBeNull();
    expect(within(link.closest("li") as HTMLElement).getByText("GitLab").closest("div")).not.toHaveClass("visually-hidden");
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    const row = (await screen.findByRole("link", { name: "GitLab document" })).closest("tr") as HTMLElement;
    expect(within(row).getByText("GitLab")).toBeInTheDocument();
  });

  it("puts an overdue review next to the status stamp", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [{ ...arisSummary, review_state: "stale" }] } },
    ]);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const head = link.closest(".result__head") as HTMLElement;
    expect(within(head).getByText("Проверка устарела")).toBeInTheDocument();
    expect(within(head).getByText("Черновик")).toBeInTheDocument();
  });

  it("explains why each result was found, marks results found through a relation and shows query notes", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      {
        path: "/api/documents?query=MDM&page=1&size=20",
        body: {
          ...documentPage,
          items: [
            { ...arisSummary, match_reasons: ["Слова запроса в названии: MDM", "Теги: mdm"], related_via: null, version: "1.0" },
            {
              ...arisSummary,
              id: "SEM-ARCH-001",
              title: "Semantic Layer — demonstration architecture",
              highlights: null,
              match_reasons: ["Связь из метаданных документа"],
              related_via: "SEM-INT-ARIS-001",
            },
          ],
          total: 2,
          notes: ["Аббревиатура MDM неоднозначна: master data management / модель метаданных. Уточните вопрос."],
        },
      },
    ]);
    renderAt("/documents?query=MDM", "/documents", <ExplorerPage />);
    expect(await screen.findByText(/Аббревиатура MDM неоднозначна/)).toBeInTheDocument();
    const first = screen.getByRole("link", { name: "ARIS integration — questions for discovery" }).closest("li") as HTMLElement;
    expect(within(first).getByText("Почему найдено: Слова запроса в названии: MDM; Теги: mdm")).toBeInTheDocument();
    expect(within(first).queryByText(/Связан с/)).toBeNull();
    const related = screen.getByRole("link", { name: "Semantic Layer — demonstration architecture" }).closest("li") as HTMLElement;
    expect(within(related).getByText("Связан с SEM-INT-ARIS-001")).toBeInTheDocument();
    expect(within(related).getByText("Почему найдено: Связь из метаданных документа")).toBeInTheDocument();
  });

  it("shows no reasons line for a plain listing", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("link", { name: /ARIS integration/ });
    expect(screen.queryByText(/Почему найдено/)).toBeNull();
  });
});

describe("Catalog: the table", () => {
  function catalogRoutes() {
    return mockApi([
      { path: "/api/knowledge/facets", body: allFacets },
      { path: /\/api\/documents\?/, body: catalog },
    ]);
  }

  it("is the default for browsing: Название + ID, Статус, Владелец, Обновлён — and no invented «Связи» column", async () => {
    const calls = catalogRoutes();
    renderAt("/documents", "/documents", <ExplorerPage />);
    const table = await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Таблица" })).toHaveAttribute("aria-pressed", "true");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Название", "Статус", "Владелец", "Обновлён"]);
    const row = within(table).getByRole("link", { name: "Archive Store: исторические снимки" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("DEMO-SRC-010")).toBeInTheDocument();
    expect(within(row).getByText("На ревью")).toBeInTheDocument();
    expect(within(row).getByText("demo-semantic-team")).toBeInTheDocument();
    // the table loads up to the API maximum so the groups are whole
    expect(calls.some((c) => c.url === "/api/documents?page=1&size=100")).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Документы" })).toBeInTheDocument();
  });

  it("groups by section with real counts, in the knowledge base order, and collapses a group", async () => {
    catalogRoutes();
    renderAt("/documents", "/documents", <ExplorerPage />);
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("rowheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Системы-источники1 документ", "Датасеты1 документ", "Интеграции2 документа"]);
    const integrations = within(table).getByRole("button", { name: /Интеграции/ });
    expect(integrations).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(integrations);
    expect(integrations).toHaveAttribute("aria-expanded", "false");
    expect(integrations).toHaveFocus();
    expect(within(table).queryByRole("link", { name: "Ночная полная выгрузка ARIS" })).toBeNull();
    expect(within(table).getByRole("link", { name: "Archive Store: исторические снимки" })).toBeInTheDocument();
    await userEvent.click(integrations);
    expect(within(table).getByRole("link", { name: "Ночная полная выгрузка ARIS" })).toBeInTheDocument();
  });

  it("changes the grouping from «Группировка» and remembers it", async () => {
    catalogRoutes();
    const { unmount } = renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Группировка: Раздел" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Статус" }));
    const headers = within(screen.getByRole("table")).getAllByRole("rowheader").map((h) => h.textContent);
    expect(headers).toEqual(["Утверждён2 документа", "На ревью1 документ", "Устарел1 документ"]);
    expect(localStorage.getItem("skh.catalog.group")).toBe("status");
    unmount();
    renderAt("/documents", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("button", { name: "Группировка: Статус" })).toBeInTheDocument();
  });

  it("opens a document by a press anywhere on its row; the title stays a real link", async () => {
    catalogRoutes();
    renderRoutes("/documents", { "/documents": <ExplorerPage /> });
    const link = await screen.findByRole("link", { name: "Датасет Process Overview" });
    expect(link).toHaveAttribute("href", "/documents/DEMO-SEM-009");
    await userEvent.click(within(link.closest("tr") as HTMLElement).getByText("Утверждён"));
    expect(location()).toBe("/documents/DEMO-SEM-009");
  });

  it("remembers the view chosen in this browser", async () => {
    catalogRoutes();
    const { unmount } = renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Список" }));
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("table")).toBeNull();
    expect(localStorage.getItem("skh.catalog.view")).toBe("list");
    unmount();
    renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("link", { name: "Датасет Process Overview" });
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("still works when the browser refuses storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    catalogRoutes();
    renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Список" }));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("«Карта» opens the map with the filters the map has", async () => {
    catalogRoutes();
    renderAt("/documents?type=integration&status=approved&owner=demo-team", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("link", { name: "Карта" })).toHaveAttribute("href", "/graph?kind=integration&status=approved");
  });
});

describe("Catalog: filter chips", () => {
  it("adds filters from «+ Фильтр», shows them as chips and removes them", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: allFacets },
      { path: /\/api\/documents\?/, body: catalog },
    ]);
    renderRoutes("/documents", { "/documents": <ExplorerPage /> });
    await screen.findByRole("table");
    const add = screen.getByRole("button", { name: "Фильтр" });
    await userEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    const status = screen.getByRole("group", { name: "Статус" });
    await userEvent.click(within(status).getByRole("button", { name: /Утверждён/ }));
    await userEvent.click(within(status).getByRole("button", { name: /На ревью/ }));
    expect(within(status).getByRole("button", { name: /Утверждён/ })).toHaveAttribute("aria-pressed", "true");
    expect(location()).toBe("/documents?status=approved%2Cin_review");
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=approved%2Cin_review"))).toBe(true));

    const chips = screen.getByRole("list", { name: "Активные фильтры" });
    expect(within(chips).getByText("Статус: Утверждён, На ревью")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(chips).getByRole("button", { name: "Убрать фильтр: Статус" }));
    expect(location()).toBe("/documents");
    expect(within(chips).queryByText(/Статус:/)).toBeNull();
  });

  it("reads a single-value filter from an old link and resets all filters", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: allFacets },
      { path: /\/api\/documents\?/, body: catalog },
    ]);
    renderRoutes("/documents?type=integration&tag=aris", { "/documents": <ExplorerPage /> });
    const chips = await screen.findByRole("list", { name: "Активные фильтры" });
    expect(within(chips).getByText("Раздел: Интеграции")).toBeInTheDocument();
    expect(within(chips).getByText("Тег: aris")).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole("button", { name: "Сбросить фильтры" }));
    expect(location()).toBe("/documents");
  });

  describe("on a phone", () => {
    it("shows card rows instead of the table and the filters in a sheet", async () => {
      mockViewport(390);
      mockApi([
        { path: "/api/knowledge/facets", body: allFacets },
        { path: /\/api\/documents\?/, body: catalog },
      ]);
      renderRoutes("/documents?status=approved", { "/documents": <ExplorerPage /> });
      await screen.findByRole("link", { name: "Датасет Process Overview" });
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByRole("region", { name: "Раздел: Датасеты" })).toBeInTheDocument();

      const open = screen.getByRole("button", { name: "Фильтр (1)" });
      await userEvent.click(open);
      const sheet = screen.getByRole("dialog", { name: "Фильтры" });
      expect(within(sheet).getByRole("button", { name: "Закрыть: Фильтры" })).toHaveFocus();
      expect(within(within(sheet).getByRole("group", { name: "Статус" })).getByRole("button", { name: /Утверждён/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Фильтры" })).toBeNull();
      expect(open).toHaveFocus();
    });
  });
});

describe("lib/catalog", () => {
  it("toggles comma-separated filter values", () => {
    expect(toggleValue([], "draft")).toBe("draft");
    expect(toggleValue(["approved"], "in_review")).toBe("approved,in_review");
    expect(toggleValue(["approved", "in_review"], "approved")).toBe("in_review");
    expect(toggleValue(["draft"], "draft")).toBeNull();
  });

  it("labels active filters in the order of the facets", () => {
    const params = new URLSearchParams("source=local&status=approved,in_review&owner=demo-team");
    expect(activeFilters(params).map((f) => f.label)).toEqual([
      "Статус: Утверждён, На ревью",
      "Владелец: demo-team",
      "Источник: Локальный workspace",
    ]);
  });

  it("maps only the filters the map understands", () => {
    expect(graphHref(new URLSearchParams(""))).toBe("/graph");
    expect(graphHref(new URLSearchParams("type=source&status=draft"))).toBe("/graph?kind=source_system&status=draft");
    // a section without its own node kind, several statuses, an owner: no map equivalent
    expect(graphHref(new URLSearchParams("type=architecture&status=approved,draft&owner=x"))).toBe("/graph");
  });

  it("groups owners alphabetically with «не назначен» last and keeps the server order inside a group", () => {
    const items = [
      doc({ id: "A", owner: "zeta" }),
      doc({ id: "B", owner: "", owner_missing: true }),
      doc({ id: "C", owner: "alpha" }),
      doc({ id: "D", owner: "zeta" }),
    ];
    const groups = groupDocuments(items, "owner");
    expect(groups.map((g) => g.label)).toEqual(["alpha", "zeta", "не назначен"]);
    expect(groups[1]?.items.map((d) => d.id)).toEqual(["A", "D"]);
    expect(groupDocuments(items, "none")).toHaveLength(1);
  });
});
