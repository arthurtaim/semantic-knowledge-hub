import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentPage, DocumentTree } from "../api/types";
import { graphHref } from "../lib/catalog";
import { toggled } from "../lib/docsTable";
import { ExplorerPage } from "../pages/ExplorerPage";
import { demoTree } from "./docsTreeFixture";
import { arisSummary, documentPage, emptyPage, facets, staleSync } from "./fixtures";
import { memoryStorage, mockApi, mockViewport, renderAt, renderRoutes } from "./helpers";

/** The small demo tree with one more document from GitLab: the table then says the source on every row. */
const mixedTree: DocumentTree = {
  ...demoTree,
  total: demoTree.total + 1,
  sections: demoTree.sections.map((section) =>
    section.key === "overview" ? { ...section, count: section.count + 1, doc_ids: [...section.doc_ids, "SEM-GL-001"] } : section,
  ),
  documents: {
    ...demoTree.documents,
    "SEM-GL-001": { ...(demoTree.documents["SEM-OVERVIEW-001"] as DocumentTree["documents"][string]), title: "GitLab document", source: "gitlab" },
  },
};

const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * «Документы» v2: a search shows its results in the middle column of «Список» (the tree stays), in the same rows as
 * a branch — status (only when not «Утверждён»), the highlighted snippet, ID, systems, review date — plus «Почему
 * найдено», «Связан с …» and the query's notes. These tests replace the snippet list of the old catalog: the
 * features are the same, the markup is the branch list's (a row is a link named by its title and status).
 */
describe("Список: search results", () => {
  const searchRoutes = (page: DocumentPage, extra: Parameters<typeof mockApi>[0] = []) =>
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/documents?query=ARIS&page=1&size=100", body: page },
      ...extra,
    ]);
  const row = (name: RegExp) => screen.getByRole("link", { name });

  it("shows search results with status, provenance and highlighted snippet", async () => {
    searchRoutes(documentPage);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);

    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery, Черновик" });
    expect(link).toHaveAttribute("href", "/documents/SEM-INT-ARIS-001");
    expect(within(link).getByText("Черновик")).toBeInTheDocument();
    expect(within(link).getByText("SEM-INT-ARIS-001")).toBeInTheDocument();
    // provenance on every result: the source, quietly in the row
    expect(link.querySelector(".docs-row__source")).toHaveTextContent("Источник: Локальный workspace");
    expect(within(link).getByText("ARIS", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Результаты: «ARIS»" })).toBeInTheDocument();
    expect(screen.getByText("1 документ по запросу «ARIS»")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Создать документ" })).toHaveAttribute("href", "/documents/new");
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    // the tree stays next to the results
    expect(screen.getByRole("tree", { name: "Разделы и документы" })).toBeInTheDocument();
  });

  it("clears the search with «Сбросить поиск» and returns to the branch", async () => {
    searchRoutes(documentPage);
    renderRoutes("/documents?query=ARIS", { "/documents": <ExplorerPage /> });
    await screen.findByRole("heading", { level: 2, name: "Результаты: «ARIS»" });
    await userEvent.click(screen.getByRole("button", { name: "Сбросить поиск" }));
    await waitFor(() => expect(location()).toBe("/documents?view=list"));
    expect(await screen.findByRole("heading", { level: 2, name: "Все документы" })).toBeInTheDocument();
  });

  it("shows an explicit empty state instead of inventing results", async () => {
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: /\/api\/documents\?query=/, body: emptyPage },
    ]);
    renderAt("/documents?query=nothing", "/documents", <ExplorerPage />);
    expect(await screen.findByText("По запросу «nothing» ничего не найдено")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сбросить поиск" })).toBeInTheDocument();
  });

  it("reports server errors with the request id (the tree and a search)", async () => {
    const failure = { code: "internal_error", message: "Внутренняя ошибка сервера.", request_id: "abc123" };
    mockApi([{ path: "/api/documents/tree", status: 500, body: failure }]);
    const { unmount } = renderAt("/documents", "/documents", <ExplorerPage />);
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Внутренняя ошибка сервера.");
    expect(screen.getAllByText("abc123").length).toBeGreaterThan(0);
    unmount();
    vi.restoreAllMocks();
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: /\/api\/documents\?query=/, status: 500, body: { ...failure, request_id: "def456" } },
    ]);
    renderAt("/documents?query=x", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Внутренняя ошибка сервера.");
    expect(screen.getByText("def456")).toBeInTheDocument();
  });

  it("says the source on every result row (provenance), even when all results share it — not once under the list", async () => {
    searchRoutes({ ...documentPage, items: [arisSummary, { ...arisSummary, id: "SEM-ARCH-001", title: "Semantic Layer — demonstration architecture" }], total: 2 });
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);
    await screen.findByRole("link", { name: /^ARIS integration/ });
    const rows = within(screen.getByRole("region", { name: "Результаты: «ARIS»" })).getAllByRole("link").filter((l) => l.classList.contains("docs-row"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const source = row.querySelector(".docs-row__source") as HTMLElement;
      expect(source).toHaveTextContent("Источник: Локальный workspace");
      expect(within(source).getByText("Источник:")).toHaveClass("visually-hidden"); // seen: «Локальный workspace»
    }
    expect(screen.queryByText(/^Источник:/, { selector: "p" })).toBeNull();
  });

  it("shows the source on every row when the results mix sources (list and table)", async () => {
    const gitlabDoc = { ...arisSummary, id: "SEM-GL-001", title: "GitLab document", source: "gitlab" as const };
    mockApi([
      { path: "/api/documents/tree", body: mixedTree },
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [arisSummary, gitlabDoc], total: 2 } },
    ]);
    renderAt("/documents?query=x", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: /^GitLab document/ });
    expect(screen.queryByText(/^Источник:/, { selector: "p" })).toBeNull();
    expect(link.querySelector(".docs-row__source")).toHaveTextContent(/^Источник: GitLab$/);
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    // «Таблица» keeps the search's rows (the server answers, the tree gives the row) and says the source on each
    const tableRow = (await screen.findByRole("link", { name: "GitLab document" })).closest("tr") as HTMLElement;
    expect(tableRow.querySelector(".docs-table__source")).toHaveTextContent(/^Источник: GitLab$/);
    const arisRow = screen.getByRole("link", { name: "ARIS integration — questions for discovery" }).closest("tr") as HTMLElement;
    expect(arisRow.querySelector(".docs-table__source")).toHaveTextContent("Локальный workspace");
    expect(screen.getAllByRole("row")).toHaveLength(3); // the header and the two results
  });

  it("marks an overdue review: the date in amber, said as «проверка устарела»", async () => {
    searchRoutes({ ...documentPage, items: [{ ...arisSummary, status: "approved", review_state: "stale", reviewed_at: "2025-01-15" }] });
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const review = link.querySelector(".docs-row__review") as HTMLElement;
    expect(review).toHaveClass("docs-row__review--warn");
    expect(review).toHaveTextContent("15 янв. 2025");
    expect(within(review).getByText("Проверен 15 янв. 2025, проверка устарела")).toHaveClass("visually-hidden");
    // an approved document has no status word in its row
    expect(within(link).queryByText("Утверждён")).toBeNull();
  });

  it("explains why each result was found, marks results found through a relation and shows query notes", async () => {
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      {
        path: "/api/documents?query=MDM&page=1&size=100",
        body: {
          ...documentPage,
          items: [
            { ...arisSummary, match_reasons: ["Слова запроса в названии: MDM", "Теги: mdm"], related_via: null, version: "1.0" },
            {
              ...arisSummary,
              id: "SEM-ARCH-001",
              title: "Semantic Layer — demonstration architecture",
              status: "approved" as const,
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
    const first = row(/^ARIS integration/);
    expect(within(first).getByText("Почему найдено: Слова запроса в названии: MDM; Теги: mdm")).toBeInTheDocument();
    expect(within(first).queryByText(/Связан с/)).toBeNull();
    const related = row(/^Semantic Layer/);
    expect(within(related).getByText("Связан с SEM-INT-ARIS-001")).toBeInTheDocument();
    expect(within(related).getByText("Почему найдено: Связь из метаданных документа")).toBeInTheDocument();
  });

  it("shows no reasons line for a branch", async () => {
    mockApi([{ path: "/api/documents/tree", body: demoTree }]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("heading", { level: 2, name: "Все документы" });
    expect(screen.queryByText(/Почему найдено/)).toBeNull();
  });
});

/*
 * «Документы» v2, slice 6: «Таблица» is built from the tree (GET /api/documents/tree) with its own filters, header
 * sort and grouping (docsTable.test.tsx). These tests replace the old catalog table's (the «Вид» menu, «Обновлён»,
 * «+ Фильтр» and its chips are gone — spec §3 names the columns and filters); what the old table kept stays tested
 * here: a search narrows the rows, the stale-index notice and mark, a press anywhere on a row, the remembered view,
 * storage refused, «Карта», old links with filters, the phone's cards and sheet.
 */
describe("Таблица: a search", () => {
  it("keeps the rows the search finds; the query is a chip and «Сбросить фильтры» clears it", async () => {
    const calls = mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?query=ARIS&page=1&size=100", body: documentPage },
    ]);
    renderRoutes("/documents?view=table&query=ARIS", { "/documents": <ExplorerPage /> });
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(link.closest("table")).not.toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("1 из 11")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/documents?query=ARIS&page=1&size=100")).toBe(true);
    expect(screen.getByText("Запрос: «ARIS»")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(location()).toBe("/documents?view=table");
    expect(await screen.findByText("11 из 11")).toBeInTheDocument();
  });

  it("never shows the rows of the previous search while a new one loads", async () => {
    let answer: (response: Response) => void = () => {};
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?query=ARIS&page=1&size=100", body: documentPage },
      { path: /\/api\/documents\?query=CDC/, respond: () => new Promise<Response>((resolve) => (answer = resolve)) },
    ]);
    renderRoutes("/documents?view=table&q=ARIS", { "/documents": <ExplorerPage /> });
    expect(await screen.findByRole("link", { name: "ARIS integration — questions for discovery" })).toBeInTheDocument();
    const field = screen.getByRole("searchbox", { name: "Найти в документах" });
    await userEvent.clear(field);
    await userEvent.type(field, "CDC{Enter}");
    expect(await screen.findAllByText("Поиск…")).not.toHaveLength(0);
    expect(screen.queryByRole("link", { name: "ARIS integration — questions for discovery" })).toBeNull();
    answer(
      new Response(JSON.stringify({ ...documentPage, items: [{ ...arisSummary, id: "DEMO-INT-010", title: "CDC и full refresh: сравнение" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await screen.findByRole("link", { name: "CDC и full refresh: сравнение" })).toBeInTheDocument();
    expect(screen.getByText("1 из 11")).toBeInTheDocument();
  });

  it("reads the sort of an old link (`sort=status` → Состояние; `sort=updated` → the default) and marks a stale row", async () => {
    const staleTree: DocumentTree = {
      ...demoTree,
      documents: { ...demoTree.documents, "DEMO-INT-001": { ...(demoTree.documents["DEMO-INT-001"] as DocumentTree["documents"][string]), index_state: "stale" } },
    };
    mockApi([
      { path: "/api/documents/tree", body: staleTree },
      { path: "/api/knowledge/facets", body: facets },
    ]);
    const { unmount } = renderAt("/documents?sort=status", "/documents", <ExplorerPage />);
    const header = await screen.findByRole("columnheader", { name: "Состояние" });
    expect(header).toHaveAttribute("aria-sort", "ascending");
    const row = screen.getByRole("link", { name: "ARIS → Catalog: обзор потока (демо)" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    unmount();
    renderAt("/documents?sort=updated", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("columnheader", { name: "Проверен" })).toHaveAttribute("aria-sort", "ascending");
  });

  it("says when the listed documents come from a stale index", async () => {
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/index/status", body: staleSync },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    const { unmount } = renderAt("/documents", "/documents", <ExplorerPage />);
    expect(await screen.findByText("Данные могут быть устаревшими.")).toBeInTheDocument();
    unmount();
    renderAt("/documents?view=table", "/documents", <ExplorerPage />);
    expect(await screen.findByText("Данные могут быть устаревшими.")).toBeInTheDocument();
  });
});

describe("Catalog: the table", () => {
  function catalogRoutes() {
    return mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
    ]);
  }

  it("opens a document by a press anywhere on its row; the title stays a real link", async () => {
    catalogRoutes();
    renderRoutes("/documents?view=table", { "/documents": <ExplorerPage /> });
    const link = await screen.findByRole("link", { name: "CDC и full refresh: сравнение" });
    expect(link).toHaveAttribute("href", "/documents/DEMO-INT-010");
    await userEvent.click(within(link.closest("tr") as HTMLElement).getByText("Утверждён"));
    expect(location()).toBe("/documents/DEMO-INT-010");
  });

  // «Документы» v2: a new key (`skh.documents.view`) — the old catalog's «list» was a list of snippets.
  it("remembers the view chosen in this browser and puts it in the URL", async () => {
    catalogRoutes();
    const { unmount } = renderRoutes("/documents", { "/documents": <ExplorerPage /> });
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    expect(location()).toBe("/documents?view=table");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Таблица" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("skh.documents.view")).toBe("table");
    unmount();
    renderAt("/documents", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Таблица" })).toHaveAttribute("aria-pressed", "true");
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
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    // hiding a column still works for this page
    await userEvent.click(screen.getByRole("button", { name: "Колонки" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Системы" }));
    expect(screen.queryByRole("columnheader", { name: "Системы" })).toBeNull();
  });

  it("«Карта» opens the map with the filters the map has", async () => {
    catalogRoutes();
    renderAt("/documents?type=integration&status=approved&owner=demo-team", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("link", { name: "Карта" })).toHaveAttribute("href", "/graph?kind=integration&status=approved");
  });
});

describe("Catalog: filters from old links", () => {
  it("reads a single-value filter and a tag from an old link and resets all filters", async () => {
    const calls = mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
      {
        path: "/api/documents?tag=aris&page=1&size=100",
        body: { ...documentPage, items: [{ ...arisSummary }, { ...arisSummary, id: "DEMO-INT-001" }, { ...arisSummary, id: "DEMO-SRC-002" }], total: 3 },
      },
    ]);
    renderRoutes("/documents?type=integration&tag=aris", { "/documents": <ExplorerPage /> });
    // a link with filters opens «Таблица»; the tag is answered by the server, the section by the tree
    expect(await screen.findByRole("button", { name: "Раздел: Интеграции" })).toBeInTheDocument();
    // the tag lives in «Ещё»; while chosen it is a chip on the panel
    expect(screen.getByRole("button", { name: "Убрать фильтр «Тег: aris»" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ещё" })).toBeInTheDocument();
    expect(await screen.findByText("2 из 11")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/documents?tag=aris&page=1&size=100")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(location()).toBe("/documents?view=table");
    expect(screen.getByRole("button", { name: "Раздел: все" })).toBeInTheDocument();
  });

  describe("on a phone", () => {
    it("shows cards instead of the table and the filters in a sheet", async () => {
      mockViewport(390);
      mockApi([
        { path: "/api/documents/tree", body: demoTree },
        { path: "/api/knowledge/facets", body: facets },
      ]);
      renderRoutes("/documents?status=approved", { "/documents": <ExplorerPage /> });
      const card = (await screen.findByRole("link", { name: "CDC и full refresh: сравнение" })).closest("li") as HTMLElement;
      expect(screen.queryByRole("table")).toBeNull();
      // a card: title, state, review date (and the ID)
      expect(within(card).getByText("Утверждён")).toBeInTheDocument();
      expect(within(card).getByText("18 сент. 2026")).toBeInTheDocument();
      expect(within(card).getByText("DEMO-INT-010")).toBeInTheDocument();
      expect(screen.getByText("8 из 11")).toBeInTheDocument();

      const open = screen.getByRole("button", { name: "Фильтры (1)" });
      await userEvent.click(open);
      const sheet = screen.getByRole("dialog", { name: "Фильтры" });
      expect(within(sheet).getByRole("button", { name: "Закрыть: Фильтры" })).toHaveFocus();
      const status = within(sheet).getByRole("group", { name: "Состояние: статус" });
      expect(within(status).getByRole("button", { name: /Утверждён/ })).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(within(sheet).getByRole("button", { name: /Только требующие внимания/ }));
      expect(location()).toBe("/documents?status=approved&view=table&attention=1");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Фильтры" })).toBeNull();
      expect(screen.getByRole("button", { name: "Фильтры (2)" })).toHaveFocus();
      expect(screen.getByText("1 из 11")).toBeInTheDocument();
    });
  });
});

describe("lib/catalog and filter values", () => {
  it("toggles comma-separated filter values", () => {
    expect(toggled([], "draft")).toBe("draft");
    expect(toggled(["approved"], "in_review")).toBe("approved,in_review");
    expect(toggled(["approved", "in_review"], "approved")).toBe("in_review");
    expect(toggled(["draft"], "draft")).toBeNull();
  });

  it("maps only the filters the map understands", () => {
    expect(graphHref(new URLSearchParams(""))).toBe("/graph");
    expect(graphHref(new URLSearchParams("type=source&status=draft"))).toBe("/graph?kind=source_system&status=draft");
    // a section without its own node kind, several statuses, an owner: no map equivalent
    expect(graphHref(new URLSearchParams("type=architecture&status=approved,draft&owner=x"))).toBe("/graph");
  });
});
