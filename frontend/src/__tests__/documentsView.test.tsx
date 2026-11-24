import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryOf, resolveView, searchChanges, withParams } from "../lib/docsView";
import { ExplorerPage } from "../pages/ExplorerPage";
import { demoTree } from "./docsTreeFixture";
import { documentPage, facets } from "./fixtures";
import { memoryStorage, mockApi, renderRoutes } from "./helpers";

/*
 * «Документы» v2, slice 2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md «Виды»): Обзор | Список | Таблица | Карта in
 * the toolbar, the state in the URL, «Назад», the remembered view, «Список» by default.
 */

const location = () => screen.getByTestId("location").textContent ?? "";

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Браузер: назад
    </button>
  );
}

function routes() {
  return mockApi([
    { path: "/api/documents/tree", body: demoTree },
    { path: "/api/knowledge/facets", body: facets },
    { path: /\/api\/documents\?/, body: documentPage },
  ]);
}

function renderPage(path: string) {
  return renderRoutes(path, {
    "/documents": (
      <>
        <ExplorerPage />
        <BackButton />
      </>
    ),
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lib/docsView", () => {
  const p = (search: string) => new URLSearchParams(search);

  it("picks the view: the URL's, then list for a node / document / search, table for table filters, then the remembered one", () => {
    expect(resolveView(p(""))).toBe("list");
    expect(resolveView(p("view=overview"))).toBe("overview");
    expect(resolveView(p("view=table&node=integration"))).toBe("table");
    expect(resolveView(p("view=nonsense"))).toBe("list");
    expect(resolveView(p("node=integration/aris"))).toBe("list");
    expect(resolveView(p("doc=DEMO-INT-001"))).toBe("list");
    expect(resolveView(p("query=ARIS"))).toBe("list");
    expect(resolveView(p("q=ARIS&owner=x"))).toBe("list");
    for (const key of ["type", "status", "owner", "tag", "source", "sort", "page"]) expect(resolveView(p(`${key}=x`))).toBe("table");
    localStorage.setItem("skh.documents.view", "overview");
    expect(resolveView(p(""))).toBe("overview");
    expect(resolveView(p("tag=aris"))).toBe("table");
    localStorage.setItem("skh.documents.view", "list-of-snippets");
    expect(resolveView(p(""))).toBe("list");
  });

  it("reads `q` and the older `query`; a new search drops `query` and the page", () => {
    expect(queryOf(p("q=%20ARIS%20"))).toBe("ARIS");
    expect(queryOf(p("query=MDM"))).toBe("MDM");
    expect(queryOf(p("q=a&query=b"))).toBe("a");
    expect(withParams(p("query=old&page=2&view=table"), searchChanges(" new ")).toString()).toBe("view=table&q=new");
    expect(withParams(p("q=old"), searchChanges("  ")).toString()).toBe("");
  });
});

describe("Документы: the views", () => {
  it("opens «Список» by default, with Обзор | Список | Таблица | Карта in the toolbar", async () => {
    routes();
    renderPage("/documents");
    const views = screen.getByRole("group", { name: "Вид раздела" });
    expect(within(views).getAllByRole("button").map((b) => b.textContent)).toEqual(["Обзор", "Список", "Таблица"]);
    expect(within(views).getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
    expect(within(views).getByRole("link", { name: "Карта" })).toHaveAttribute("href", "/graph");
    expect(screen.getByRole("link", { name: "Создать документ" })).toHaveAttribute("href", "/documents/new");
    // the URL names the view on screen (replaced, not a new history entry)
    await waitFor(() => expect(location()).toBe("/documents?view=list"));
    expect(screen.getByRole("heading", { level: 1, name: "Документы" })).toBeInTheDocument();
  });

  it("puts the chosen view in the URL; «Назад» returns to the previous one", async () => {
    routes();
    renderPage("/documents");
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    expect(location()).toBe("/documents?view=table");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Обзор" }));
    expect(location()).toBe("/documents?view=overview");
    await userEvent.click(screen.getByRole("button", { name: "Браузер: назад" }));
    expect(location()).toBe("/documents?view=table");
    expect(screen.getByRole("button", { name: "Таблица" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Браузер: назад" }));
    expect(location()).toBe("/documents?view=list");
    expect(screen.getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens a link with table filters in «Таблица» and keeps an explicit view over the remembered one", async () => {
    routes();
    localStorage.setItem("skh.documents.view", "overview");
    const { unmount } = renderPage("/documents?owner=unassigned");
    expect(screen.getByRole("button", { name: "Таблица" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(location()).toBe("/documents?owner=unassigned&view=table"));
    unmount();
    renderPage("/documents");
    expect(screen.getByRole("button", { name: "Обзор" })).toHaveAttribute("aria-pressed", "true");
  });

  it("«Обзор»: the totals and sections from the tree API; a section opens «Список» on it; no search field", async () => {
    const calls = routes();
    renderPage("/documents?view=overview");
    const overview = await screen.findByRole("region", { name: /11 документов/ });
    expect(within(overview).getByRole("link", { name: "4 требуют внимания" })).toHaveAttribute(
      "href",
      "/documents?view=list&node=attention",
    );
    const rows = within(overview).getAllByRole("row").slice(1);
    expect(rows.map((r) => Array.from(r.children).map((c) => c.textContent))).toEqual([
      ["Продукт", "1", "—"],
      ["Системы-источники", "3", "2"],
      ["Интеграции", "5", "2"],
      ["Стандарты", "2", "—"],
    ]);
    expect(within(overview).getByRole("link", { name: "Интеграции" })).toHaveAttribute("href", "/documents?view=list&node=integration");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(calls.filter((c) => c.url === "/api/documents/tree")).toHaveLength(1);
  });

  it("types into the search: the URL follows after a pause, with the older `query` replaced by `q`", async () => {
    routes();
    renderPage("/documents?view=table&query=old");
    const field = screen.getByRole("searchbox", { name: "Найти в документах" });
    expect(field).toHaveValue("old");
    await userEvent.clear(field);
    await userEvent.type(field, "ARIS ");
    expect(field).toHaveValue("ARIS "); // the space being typed is kept
    await waitFor(() => expect(location()).toBe("/documents?view=table&q=ARIS"));
    expect(field).toHaveValue("ARIS ");
  });
});
