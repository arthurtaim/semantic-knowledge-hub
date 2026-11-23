import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDate } from "../lib/labels";
import { ExplorerPage } from "../pages/ExplorerPage";
import { arisSummary, documentPage, emptyPage, facets, staleSync } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

describe("Knowledge explorer", () => {
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

  it("applies a status filter through the URL-backed query", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("link", { name: /ARIS integration/ });
    await userEvent.click(screen.getByRole("button", { name: /Черновик/ }));
    expect(calls.some((c) => c.url.includes("status=draft"))).toBe(true);
    expect(screen.getByRole("button", { name: /Черновик/ })).toHaveAttribute("aria-pressed", "true");
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

  it("sorts through the URL-backed sort param and shows the update date", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const result = link.closest("li") as HTMLElement;
    expect(within(result).getByText("Обновлён")).toBeInTheDocument();
    expect(within(result).getByText(formatDate(arisSummary.updated_at))).toBeInTheDocument();

    const sort = screen.getByLabelText("Сортировка");
    expect(sort).toHaveValue("");
    expect(within(sort).getByRole("option", { name: "Релевантность" })).toBeInTheDocument();
    await userEvent.selectOptions(sort, "Сначала новые");
    expect(sort).toHaveValue("updated");
    expect(calls.some((c) => c.url === "/api/documents?query=ARIS&page=1&size=20&sort=updated")).toBe(true);
  });

  it("restores the sort from the URL and offers relevance only with a query", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [{ ...arisSummary, index_state: "stale", updated_at: null }] } },
    ]);
    renderAt("/documents?sort=status", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const result = link.closest("li") as HTMLElement;
    expect(within(result).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    expect(within(result).getByText("не указано")).toBeInTheDocument();
    const sort = screen.getByLabelText("Сортировка");
    expect(sort).toHaveValue("status");
    expect(within(sort).queryByRole("option", { name: "Релевантность" })).toBeNull();
    expect(calls.some((c) => c.url === "/api/documents?page=1&size=20&sort=status")).toBe(true);
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
    renderAt("/documents", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(screen.getByText("Источник: Локальный workspace")).toBeInTheDocument();
    // the row still names its source for screen readers
    const source = within(link.closest("li") as HTMLElement).getByText("Локальный workspace");
    expect(source.closest("div")).toHaveClass("visually-hidden");
  });

  it("shows the source on every row when the results mix sources", async () => {
    const gitlabDoc = { ...arisSummary, id: "SEM-GL-001", title: "GitLab document", source: "gitlab" as const };
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [arisSummary, gitlabDoc], total: 2 } },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "GitLab document" });
    expect(screen.queryByText(/^Источник:/)).toBeNull();
    expect(within(link.closest("li") as HTMLElement).getByText("GitLab").closest("div")).not.toHaveClass("visually-hidden");
  });

  it("puts an overdue review next to the status stamp", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: { ...documentPage, items: [{ ...arisSummary, review_state: "stale" }] } },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    const head = link.closest(".result__head") as HTMLElement;
    expect(within(head).getByText("Проверка устарела")).toBeInTheDocument();
    expect(within(head).getByText("Черновик")).toBeInTheDocument();
  });

  describe("on a phone", () => {
    function phoneScreen() {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((media: string) => ({ matches: true, media, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
      );
    }
    afterEach(() => vi.unstubAllGlobals());

    it("keeps the filters in a closed disclosure when none is active", async () => {
      phoneScreen();
      mockApi([
        { path: "/api/knowledge/facets", body: facets },
        { path: /\/api\/documents\?/, body: documentPage },
      ]);
      renderAt("/documents", "/documents", <ExplorerPage />);
      await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
      const summary = screen.getByText("Фильтры", { selector: "summary" });
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
      expect(within(screen.getByRole("complementary", { name: "Фильтры" })).getByRole("group", { name: "Статус" })).toBeInTheDocument();
    });

    it("opens the disclosure and counts active filters", async () => {
      phoneScreen();
      mockApi([
        { path: "/api/knowledge/facets", body: facets },
        { path: /\/api\/documents\?/, body: documentPage },
      ]);
      renderAt("/documents?status=draft&owner=demo-team", "/documents", <ExplorerPage />);
      await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
      const summary = screen.getByText("Фильтры (2)", { selector: "summary" });
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(true);
      expect(screen.getByRole("button", { name: /Черновик/ })).toHaveAttribute("aria-pressed", "true");
    });
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
