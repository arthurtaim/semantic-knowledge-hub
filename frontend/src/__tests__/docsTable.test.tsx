import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentTree, DocumentTreeEntry } from "../api/types";
import {
  groupIds,
  matchesFilters,
  nextSort,
  parseGroup,
  parseSort,
  readFilters,
  sortIdsBy,
  sortValue,
  tableReviewMark,
} from "../lib/docsTable";
import { indexTree } from "../lib/docTree";
import { forgetDocumentTree } from "../lib/useDocumentTree";
import { ExplorerPage } from "../pages/ExplorerPage";
import demo from "./docsTreeDemo.json";
import { facets } from "./fixtures";
import { memoryStorage, mockApi, mockViewport, renderRoutes } from "./helpers";

/*
 * «Документы» v2, slice 6 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §3, design docs-04): «Таблица» on the synthetic
 * demo base as GET /api/documents/tree answered it (83 documents, 12 needing attention).
 */

const demoTree = demo as DocumentTree;
const index = indexTree(demoTree);
const documents = demoTree.documents;
const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  forgetDocumentTree();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Браузер: назад
    </button>
  );
}

function renderTable(path = "/documents?view=table") {
  const calls = mockApi([
    { path: "/api/documents/tree", body: demoTree },
    { path: "/api/knowledge/facets", body: facets },
  ]);
  const view = renderRoutes(path, {
    "/documents": (
      <>
        <ExplorerPage />
        <BackButton />
      </>
    ),
    "/documents/:id": <p>Страница документа</p>,
  });
  return { calls, ...view };
}

const table = () => screen.getByRole("table");
const titleLinks = () => within(table()).getAllByRole("link").filter((link) => link.classList.contains("docs-table__title"));
const ids = () => titleLinks().map((link) => link.getAttribute("href")?.replace("/documents/", ""));
const rowOf = (title: string) => within(table()).getByRole("link", { name: title }).closest("tr") as HTMLElement;
const header = (name: string) => within(table()).getByRole("columnheader", { name: new RegExp(`^${name}`) });

describe("lib/docsTable", () => {
  it("reads the sort from the URL: `reviewed` ascending by default, `-key` descending, an unknown value the default", () => {
    expect(parseSort(null)).toEqual({ key: "reviewed", dir: "asc" });
    expect(parseSort("-links")).toEqual({ key: "links", dir: "desc" });
    expect(parseSort("status")).toEqual({ key: "status", dir: "asc" });
    expect(parseSort("updated")).toEqual({ key: "reviewed", dir: "asc" });
    expect(sortValue({ key: "reviewed", dir: "asc" })).toBeNull();
    expect(sortValue({ key: "reviewed", dir: "desc" })).toBe("-reviewed");
    expect(nextSort({ key: "title", dir: "asc" }, "title")).toEqual({ key: "title", dir: "desc" });
    expect(nextSort({ key: "title", dir: "desc" }, "links")).toEqual({ key: "links", dir: "asc" });
    expect(parseGroup("system")).toBe("system");
    expect(parseGroup("nonsense")).toBe("none");
  });

  it("sorts «Проверен ↑»: never reviewed first, then the oldest review; «не требуется» last", () => {
    const sorted = sortIdsBy(Object.keys(documents), documents, { key: "reviewed", dir: "asc" });
    expect(sorted.slice(0, 6)).toEqual(["SEM-DOM-001", "SEM-PROC-OLD-001", "SEM-STD-001", "DEMO-GOV-013", "DEMO-INT-018", "DEMO-SRC-004"]);
    expect(new Set(sorted.slice(-3))).toEqual(new Set(["SEM-INT-ARIS-001", "DEMO-SRC-009", "DEMO-INT-017"]));
    expect(sorted.slice(-3).every((id) => documents[id]?.review_state === "not_required")).toBe(true);
    const dated = sorted.slice(1, -3).map((id) => documents[id]?.reviewed_at ?? "");
    expect(dated.every(Boolean)).toBe(true);
    expect(dated).toEqual([...dated].sort());
  });

  it("sorts «Проверен ↓»: the newest review first, «не проверялся» after every date; «не требуется» still last", () => {
    const sorted = sortIdsBy(Object.keys(documents), documents, { key: "reviewed", dir: "desc" });
    expect(new Set(sorted.slice(-3))).toEqual(new Set(["SEM-INT-ARIS-001", "DEMO-SRC-009", "DEMO-INT-017"]));
    expect(sorted.at(-4)).toBe("SEM-DOM-001"); // never reviewed: older than any date
    const dated = sorted.slice(0, -4).map((id) => documents[id]?.reviewed_at ?? "");
    expect(dated.every(Boolean)).toBe(true);
    expect(dated).toEqual([...dated].sort().reverse());
    // «не требуется» among themselves: by title in both directions
    const ascLast = sortIdsBy(Object.keys(documents), documents, { key: "reviewed", dir: "asc" }).slice(-3);
    expect(sorted.slice(-3)).toEqual(ascLast);
  });

  it("filters: values of one key with «или», keys with «и»; «не назначен» is every document without an owner", () => {
    const pass = (search: string) =>
      Object.entries(documents)
        .filter(([, entry]) => matchesFilters(entry, readFilters(new URLSearchParams(search))))
        .map(([id]) => id)
        .sort();
    expect(pass("type=integration&status=draft")).toEqual(["DEMO-INT-017", "SEM-INT-ARIS-001"]);
    expect(pass("status=draft,deprecated")).toHaveLength(6);
    expect(pass("status=approved&flag=needs_review")).toEqual(["DEMO-SRC-004", "SEM-STD-001"]);
    expect(pass("owner=unassigned")).toEqual(["DEMO-SRC-010", "SEM-PROC-OLD-001"]);
    expect(pass("system=ARIS")).toHaveLength(13);
    expect(pass("attention=1")).toHaveLength(12);
  });

  it("Система matches a document by ANY of its systems; grouping by Система uses the first one (the tree's group)", () => {
    const pass = (search: string) =>
      Object.entries(documents)
        .filter(([, entry]) => matchesFilters(entry, readFilters(new URLSearchParams(search))))
        .map(([id]) => id)
        .sort();
    // DEMO-INT-001 is «ARIS, Data Catalog» (its tree group is ARIS), DEMO-INT-004 «CATIA, Data Catalog»
    expect(documents["DEMO-INT-001"]?.systems).toEqual(["ARIS", "Data Catalog"]);
    expect(documents["DEMO-INT-004"]?.systems).toEqual(["CATIA", "Data Catalog"]);
    expect(pass("system=Data Catalog")).toEqual(["DEMO-INT-001", "DEMO-INT-004", "DEMO-INT-008", "DEMO-SRC-007"]);
    expect(pass("system=ARIS")).toContain("DEMO-INT-001");
    expect(pass("system=CATIA")).toContain("DEMO-INT-004");
    // every document is in exactly one group of «Группировка: Система»: its first system
    const systems = groupIds(sortIdsBy(Object.keys(documents), documents, { key: "title", dir: "asc" }), index, "system");
    expect(systems.find((g) => g.label === "Data Catalog")?.ids.sort()).toEqual(["DEMO-INT-008", "DEMO-SRC-007"]);
    expect(systems.find((g) => g.label === "ARIS")?.ids).toContain("DEMO-INT-001");
    expect(systems.find((g) => g.label === "CATIA")?.ids).toContain("DEMO-INT-004");
  });

  it("groups by section in the tree's order, owners with «не назначен» last, systems with «Без системы» last", () => {
    const all = sortIdsBy(Object.keys(documents), documents, { key: "title", dir: "asc" });
    expect(groupIds(all, index, "type").map((g) => [g.label, g.ids.length])).toEqual(index.sections.map((s) => [s.label, s.count]));
    const owners = groupIds(all, index, "owner");
    expect(owners[owners.length - 1]).toMatchObject({ label: "не назначен", ids: ["DEMO-SRC-010", "SEM-PROC-OLD-001"].sort((a, b) => all.indexOf(a) - all.indexOf(b)) });
    const systems = groupIds(all, index, "system");
    expect(systems.map((g) => g.label).slice(0, 2)).toEqual(["Archive Store", "ARIS"]);
    expect(systems.find((g) => g.label === "ARIS")?.ids).toHaveLength(13);
    expect(systems[systems.length - 1]).toMatchObject({ label: "Без системы" });
    expect(systems.reduce((n, g) => n + g.ids.length, 0)).toBe(83); // each document once (its first system)
  });

  it("says the review date with the year", () => {
    expect(tableReviewMark({ review_state: "stale", reviewed_at: "2025-01-15" })).toMatchObject({ text: "15 янв. 2025", tone: "warn" });
    expect(tableReviewMark({ review_state: "ok", reviewed_at: "2026-10-16" }).text).toBe("16 окт. 2026");
    expect(tableReviewMark({ review_state: "never_reviewed", reviewed_at: null }).text).toBe("не проверялся");
    expect(tableReviewMark({ review_state: "not_required", reviewed_at: null })).toMatchObject({ text: "не требуется", tone: "muted" });
  });
});

describe("Таблица: columns and rows", () => {
  it("shows every document with Название + ID, Раздел, Состояние, Владелец, Системы, Проверен, Связи; «Проверен ↑» by default", async () => {
    renderTable();
    await screen.findByRole("table");
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Название",
      "Раздел",
      "Состояние",
      "Владелец",
      "Системы",
      "Проверен",
      "Связи",
    ]);
    expect(header("Проверен")).toHaveAttribute("aria-sort", "ascending");
    expect(header("Название")).not.toHaveAttribute("aria-sort");
    expect(within(header("Системы")).queryByRole("button")).toBeNull(); // not sortable
    expect(titleLinks()).toHaveLength(83);
    expect(screen.getByText("83 из 83")).toBeInTheDocument();
    expect(ids().slice(0, 3)).toEqual(["SEM-DOM-001", "SEM-PROC-OLD-001", "SEM-STD-001"]);

    // approved: the stamp and the text; the links right-aligned
    const flow = rowOf("ARIS → Catalog: обзор потока (демо)");
    const cells = within(flow).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual([
      "ARIS → Catalog: обзор потока (демо)DEMO-INT-001",
      "Интеграции",
      "Утверждён",
      "demo-integration-team",
      "ARIS, Data Catalog",
      "16 окт. 2026Проверен 16 окт. 2026",
      "11",
    ]);
    expect(within(cells[2] as HTMLElement).getByText("Утверждён").closest(".status-mark")).toHaveClass("status-mark--approved");
    expect(cells[6]).toHaveClass("docs-table__num");
    // deprecated: struck through, the dash shape; no owner: «не назначен» in red; overdue: amber with a clock
    const old = rowOf("Устаревший порядок согласования правок по почте (демо)");
    expect(old).toHaveClass("docs-table__row--deprecated");
    expect(within(old).getByText("Устарел").closest(".status-mark")).toHaveClass("status-mark--deprecated");
    expect(within(old).getByText("не назначен")).toHaveClass("docs-table__no-owner");
    const overdue = within(rowOf("Стандарт оформления документов базы знаний (демо)")).getByTitle("Проверен 15 янв. 2025, проверка устарела");
    expect(overdue).toHaveClass("docs-table__review--warn");
    expect(overdue.querySelector('[data-icon="clock"]')).not.toBeNull();
    expect(within(rowOf("Шаблон описания предметной области (демо)")).getByText("не проверялся")).toBeInTheDocument();
    expect(within(rowOf("Расписание обновления метаданных v2 — проект")).getByText("не требуется")).toBeInTheDocument();
  });

  it("sorts by a header click (`aria-sort`, the URL); a second click turns it around", async () => {
    renderTable();
    await screen.findByRole("table");
    await userEvent.click(within(header("Связи")).getByRole("button"));
    expect(location()).toBe("/documents?view=table&sort=links");
    expect(header("Связи")).toHaveAttribute("aria-sort", "ascending");
    expect(header("Проверен")).not.toHaveAttribute("aria-sort");
    expect(ids()[0]).toBe("SEM-PROC-OLD-001");
    await userEvent.click(within(header("Связи")).getByRole("button"));
    expect(location()).toBe("/documents?view=table&sort=-links");
    expect(header("Связи")).toHaveAttribute("aria-sort", "descending");
    expect(ids()[0]).toBe("DEMO-SEM-002");
    await userEvent.click(within(header("Название")).getByRole("button"));
    expect(header("Название")).toHaveAttribute("aria-sort", "ascending");
    // Russian order: Cyrillic titles before Latin ones
    expect(titleLinks()[0]?.textContent).toMatch(/^[А-ЯЁ]/);
    expect(titleLinks()[82]?.textContent).toMatch(/^[A-Z]/);
    // the default comes back through «Назад»
    await userEvent.click(screen.getByRole("button", { name: "Браузер: назад" }));
    await userEvent.click(screen.getByRole("button", { name: "Браузер: назад" }));
    await userEvent.click(screen.getByRole("button", { name: "Браузер: назад" }));
    expect(location()).toBe("/documents?view=table");
    expect(header("Проверен")).toHaveAttribute("aria-sort", "ascending");
  });

  it("«Проверен» either way: «не требуется» (drafts) stays at the bottom", async () => {
    renderTable();
    await screen.findByRole("table");
    const reviewTexts = () => Array.from(table().querySelectorAll(".docs-table__review > span[aria-hidden]")).map((el) => el.textContent);
    expect(reviewTexts()[0]).toBe("не проверялся");
    expect(reviewTexts().slice(-3)).toEqual(["не требуется", "не требуется", "не требуется"]);
    await userEvent.click(within(header("Проверен")).getByRole("button"));
    expect(location()).toBe("/documents?view=table&sort=-reviewed");
    expect(header("Проверен")).toHaveAttribute("aria-sort", "descending");
    expect(reviewTexts()[0]).toMatch(/\d{4}$/); // the newest date first
    expect(reviewTexts().slice(-4)).toEqual(["не проверялся", "не требуется", "не требуется", "не требуется"]);
  });
});

describe("Таблица: filters", () => {
  it("«Только требующие внимания» leaves the API's 12", async () => {
    renderTable();
    await screen.findByRole("table");
    const toggle = screen.getByRole("button", { name: "Только требующие внимания" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(location()).toBe("/documents?view=table&attention=1");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(titleLinks()).toHaveLength(demoTree.attention_total);
    expect(titleLinks()).toHaveLength(12);
    expect(screen.getByText("12 из 83")).toBeInTheDocument();
  });

  it("the overview's cell «Интеграции / Черновики» opens exactly the two integration drafts", async () => {
    renderTable("/documents?view=table&type=integration&status=draft");
    await screen.findByRole("table");
    expect(ids().sort()).toEqual(["DEMO-INT-017", "SEM-INT-ARIS-001"]);
    expect(screen.getByRole("button", { name: "Раздел: Интеграции" })).toHaveClass("docs-filter--on");
    expect(screen.getByRole("button", { name: "Состояние: Черновик" })).toBeInTheDocument();
    expect(screen.getByText("2 из 83")).toBeInTheDocument();
  });

  it("filters through menu buttons with several choices (the menu stays open); «Показать все» clears one filter", async () => {
    renderTable();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Раздел: все" }));
    const menu = screen.getByRole("menu", { name: "Раздел" });
    const integration = within(menu).getByRole("menuitemcheckbox", { name: /Интеграции/ });
    expect(integration).toHaveAttribute("aria-checked", "false");
    expect(integration).toHaveTextContent("19"); // the API's count
    await userEvent.click(integration);
    expect(location()).toBe("/documents?view=table&type=integration");
    expect(screen.getByRole("menu", { name: "Раздел" })).toBeVisible(); // a checkbox item keeps the menu open
    expect(within(screen.getByRole("menu", { name: "Раздел" })).getByRole("menuitemcheckbox", { name: /Интеграции/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(screen.getByRole("menu", { name: "Раздел" })).getByRole("menuitemcheckbox", { name: /Домен/ }));
    expect(location()).toBe("/documents?view=table&type=integration%2Cdomain");
    expect(titleLinks()).toHaveLength(19 + 9);
    await userEvent.keyboard("{Escape}");
    const button = screen.getByRole("button", { name: "Раздел: Интеграции, Домен" });
    expect(button).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Состояние: все" }));
    const state = screen.getByRole("menu", { name: "Состояние" });
    expect(within(state).getByRole("group", { name: "Статус" })).toBeInTheDocument();
    await userEvent.click(within(state).getByRole("menuitemcheckbox", { name: /Нужна проверка/ }));
    // Раздел (Интеграции или Домен) и Нужна проверка: one of each section
    expect(ids().sort()).toEqual(["DEMO-INT-018", "SEM-DOM-001"]);
    await userEvent.keyboard("{Escape}");

    await userEvent.click(button);
    await userEvent.click(within(screen.getByRole("menu", { name: "Раздел" })).getByRole("menuitem", { name: "Показать все" }));
    expect(location()).toBe("/documents?view=table&flag=needs_review");
    expect(titleLinks()).toHaveLength(6);
  });

  it("Владелец «не назначен» and Система: the documents without an owner, the documents about a system", async () => {
    renderTable();
    await screen.findByRole("table");
    // the filter, not the column header of the same name
    await userEvent.click(within(screen.getByRole("group", { name: "Фильтры" })).getByRole("button", { name: "Владелец" }));
    const owners = screen.getByRole("menu", { name: "Владелец" });
    const items = within(owners).getAllByRole("menuitemcheckbox");
    expect(items[items.length - 1]).toHaveTextContent(/^не назначен2$/);
    await userEvent.click(items[items.length - 1] as HTMLElement);
    expect(location()).toBe("/documents?view=table&owner=unassigned");
    expect(ids().sort()).toEqual(["DEMO-SRC-010", "SEM-PROC-OLD-001"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    await userEvent.click(screen.getByRole("button", { name: "Система" }));
    await userEvent.click(within(screen.getByRole("menu", { name: "Система" })).getByRole("menuitemcheckbox", { name: /^ARIS/ }));
    expect(titleLinks()).toHaveLength(13);
    expect(screen.getByText("13 из 83")).toBeInTheDocument();
  });

  it("the panel keeps Раздел, Состояние, Владелец, Система and «Только требующие внимания»; Тег and Источник are in «Ещё»", async () => {
    renderTable();
    await screen.findByRole("table");
    const panel = screen.getByRole("group", { name: "Фильтры" });
    await within(panel).findByRole("button", { name: "Ещё" });
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Раздел: все",
      "Состояние: все",
      "Владелец",
      "Система",
      "Только требующие внимания",
      "Ещё",
    ]);
    await userEvent.click(within(panel).getByRole("button", { name: "Ещё" }));
    const more = screen.getByRole("menu", { name: "Ещё фильтры" });
    expect(within(more).getByRole("group", { name: "Тег" })).toBeInTheDocument();
    expect(within(more).queryByRole("group", { name: "Источник" })).toBeNull(); // one source in the demo base
  });

  it("a tag chosen in «Ещё» is a chip on the panel with «×»: the filter is never hidden", async () => {
    const tagged = { items: ["DEMO-INT-001", "DEMO-INT-002"].map((id) => ({ id })), total: 2, page: 1, size: 100, notes: [] };
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?tag=aris&page=1&size=100", body: tagged },
    ]);
    renderRoutes("/documents?view=table", { "/documents": <ExplorerPage /> });
    await screen.findByRole("table");
    const panel = screen.getByRole("group", { name: "Фильтры" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Ещё" }));
    await userEvent.click(within(screen.getByRole("menu", { name: "Ещё фильтры" })).getByRole("menuitemcheckbox", { name: /^aris/ }));
    expect(location()).toBe("/documents?view=table&tag=aris");
    await userEvent.keyboard("{Escape}");
    expect(within(panel).getByRole("button", { name: "Ещё" })).not.toHaveClass("docs-filter--on"); // the chip says it
    const chip = within(panel).getByText("Тег: aris").closest(".chip") as HTMLElement;
    expect(chip).toHaveClass("chip--filter");
    expect(await screen.findByText("2 из 83")).toBeInTheDocument();
    await userEvent.click(within(chip).getByRole("button", { name: "Убрать фильтр «Тег: aris»" }));
    expect(location()).toBe("/documents?view=table");
    expect(within(panel).queryByText("Тег: aris")).toBeNull();
    expect(titleLinks()).toHaveLength(83);
  });

  it("a link with a source filter opens with its chip and «Источник» in «Ещё»", async () => {
    renderTable("/documents?view=table&source=gitlab");
    const panel = await screen.findByRole("group", { name: "Фильтры" });
    const chip = within(panel).getByText("Источник: GitLab").closest(".chip") as HTMLElement;
    expect(screen.getByText("Документов с такими фильтрами нет")).toBeInTheDocument(); // the demo base is local
    await userEvent.click(within(panel).getByRole("button", { name: "Ещё" }));
    const sources = within(screen.getByRole("menu", { name: "Ещё фильтры" })).getByRole("group", { name: "Источник" });
    expect(within(sources).getByRole("menuitemcheckbox", { name: /^Локальный workspace/ })).toHaveAttribute("aria-checked", "false");
    expect(within(sources).getByRole("menuitemcheckbox", { name: /^GitLab/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(chip).getByRole("button", { name: "Убрать фильтр «Источник: GitLab»" }));
    expect(location()).toBe("/documents?view=table");
    expect(titleLinks()).toHaveLength(83);
  });

  it("a search's rows say their source quietly (provenance on every result); without a search one source is not repeated", async () => {
    const found = { items: ["DEMO-INT-001", "DEMO-INT-002", "SEM-INT-ARIS-001"].map((id) => ({ id })), total: 3, page: 1, size: 100, notes: [] };
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?query=ARIS&page=1&size=100", body: found },
    ]);
    const { unmount } = renderRoutes("/documents?view=table&q=ARIS", { "/documents": <ExplorerPage /> });
    await screen.findByText("3 из 83");
    const sources = Array.from(table().querySelectorAll(".docs-table__source")).map((el) => el.textContent);
    expect(sources).toEqual(["Источник: Локальный workspace", "Источник: Локальный workspace", "Источник: Локальный workspace"]);
    unmount();
    renderTable();
    await screen.findByRole("table");
    expect(table().querySelectorAll(".docs-table__source")).toHaveLength(0);
    expect(table().querySelector("caption")).toHaveTextContent("Источник: Локальный workspace");
  });

  it("Система «Data Catalog» lists every document about it, also those whose first system (tree group) is another", async () => {
    renderTable();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Система" }));
    const catalog = within(screen.getByRole("menu", { name: "Система" })).getByRole("menuitemcheckbox", { name: /^Data Catalog/ });
    expect(catalog).toHaveTextContent(/^Data Catalog4$/); // the menu counts a document under each of its systems
    await userEvent.click(catalog);
    expect(location()).toBe("/documents?view=table&system=Data+Catalog");
    expect(ids().sort()).toEqual(["DEMO-INT-001", "DEMO-INT-004", "DEMO-INT-008", "DEMO-SRC-007"]);
    expect(within(rowOf("ARIS → Catalog: обзор потока (демо)")).getByText("ARIS, Data Catalog")).toBeInTheDocument();
  });
});

describe("Таблица: grouping, columns, keyboard", () => {
  it("groups by section with the API's counts and collapses a group; the grouping is in the URL", async () => {
    renderTable();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Группировка: нет" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Раздел" }));
    expect(location()).toBe("/documents?view=table&group=type");
    const groups = within(table()).getAllByRole("rowheader");
    expect(groups.map((g) => g.textContent)).toEqual(index.sections.map((s) => expect.stringMatching(new RegExp(`^${s.label}${s.count} документ`))));
    const integration = within(table()).getByRole("button", { name: /^Интеграции/ });
    await userEvent.click(integration);
    expect(integration).toHaveAttribute("aria-expanded", "false");
    expect(titleLinks()).toHaveLength(83 - 19);
    expect(integration).toHaveFocus();
  });

  it("hides a column from «Колонки» and remembers it in this browser", async () => {
    const { unmount } = renderTable();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Колонки" }));
    const menu = screen.getByRole("menu", { name: "Колонки" });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((i) => i.textContent)).toEqual(["Раздел", "Состояние", "Владелец", "Системы", "Проверен", "Связи"]);
    await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Системы" }));
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Системы" })).toHaveAttribute("aria-checked", "false");
    expect(within(table()).queryByRole("columnheader", { name: "Системы" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("skh.documents.columns") ?? "[]")).toEqual(["systems"]);
    unmount();
    renderTable();
    await screen.findByRole("table");
    expect(within(table()).getAllByRole("columnheader")).toHaveLength(6);
  });

  it("below 1280 px «Системы» starts hidden; «Колонки» brings it back and the choice is remembered", async () => {
    mockViewport(1100);
    const { unmount } = renderTable();
    await screen.findByRole("table");
    expect(within(table()).queryByRole("columnheader", { name: "Системы" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Колонки" }));
    const systems = within(screen.getByRole("menu", { name: "Колонки" })).getByRole("menuitemcheckbox", { name: "Системы" });
    expect(systems).toHaveAttribute("aria-checked", "false");
    await userEvent.click(systems);
    expect(within(table()).getByRole("columnheader", { name: "Системы" })).toBeInTheDocument();
    expect(localStorage.getItem("skh.documents.columns")).toBe("[]"); // the choice holds at any width
    // the next visit at the same narrow width: «Системы» is shown, as chosen
    unmount();
    const again = renderTable();
    await screen.findByRole("table");
    expect(within(table()).getByRole("columnheader", { name: "Системы" })).toBeInTheDocument();
    expect(within(table()).getAllByRole("columnheader")).toHaveLength(7);
    // (still narrow: without a remembered choice it starts hidden again)
    again.unmount();
    localStorage.removeItem("skh.documents.columns");
    renderTable();
    await screen.findByRole("table");
    expect(within(table()).queryByRole("columnheader", { name: "Системы" })).toBeNull();
  });

  it("one tab stop for the rows; ↑↓ Home End move between rows; Enter opens the document", async () => {
    renderTable("/documents?view=table&attention=1");
    await screen.findByRole("table");
    const links = titleLinks();
    expect(links.filter((link) => link.tabIndex === 0)).toHaveLength(1);
    (links[0] as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(links[1]).toHaveFocus();
    expect(links[1]).toHaveAttribute("tabindex", "0");
    await userEvent.keyboard("{End}");
    expect(links[11]).toHaveFocus();
    await userEvent.keyboard("{Home}{ArrowDown}{ArrowUp}{ArrowDown}");
    expect(links[1]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(location()).toBe(links[1]?.getAttribute("href")));
  });

  it("works from the keyboard: a header sorts with Enter, a filter menu opens with ↓ and toggles with Space", async () => {
    renderTable();
    await screen.findByRole("table");
    const sortLinks = within(header("Связи")).getByRole("button");
    sortLinks.focus();
    await userEvent.keyboard("{Enter}");
    expect(header("Связи")).toHaveAttribute("aria-sort", "ascending");
    const section = screen.getByRole("button", { name: "Раздел: все" });
    section.focus();
    await userEvent.keyboard("{ArrowDown}");
    const first = within(screen.getByRole("menu", { name: "Раздел" })).getAllByRole("menuitemcheckbox")[0] as HTMLElement;
    expect(first).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(location()).toBe("/documents?view=table&sort=links&type=overview");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Раздел: Продукт" })).toHaveFocus();
  });

  it("restores everything from a shared link", async () => {
    renderTable("/documents?view=table&attention=1&sort=-links&group=owner");
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Только требующие внимания" })).toHaveAttribute("aria-pressed", "true");
    expect(header("Связи")).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("button", { name: "Группировка: Владелец" })).toBeInTheDocument();
    const groups = within(table()).getAllByRole("rowheader").map((g) => g.textContent?.replace(/\d+ документ\D*$/, ""));
    expect(groups[groups.length - 1]).toBe("не назначен");
    const entry = (id: string) => documents[id] as DocumentTreeEntry;
    // inside a group the rows keep the sort: most links first
    const firstGroup = within(table()).getAllByRole("rowgroup").find((g) => g.querySelector(".docs-table__group")) as HTMLElement;
    const counts = Array.from(firstGroup.querySelectorAll(".docs-table__title")).map((a) => entry(a.getAttribute("href")?.replace("/documents/", "") ?? "").link_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
