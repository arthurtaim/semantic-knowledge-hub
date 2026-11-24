import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentTree } from "../api/types";
import { forgetDocumentTree } from "../lib/useDocumentTree";
import { buildOverview, cellHref, cellLabel, COLUMN_BY_KEY, todoGroups, todoNote } from "../lib/docsOverview";
import { indexTree } from "../lib/docTree";
import { tableHref } from "../lib/docsTable";
import { ExplorerPage } from "../pages/ExplorerPage";
import demo from "./docsTreeDemo.json";
import { memoryStorage, mockApi, mockViewport, renderRoutes } from "./helpers";

/*
 * «Документы» v2, slice 5 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §2, design docs-03): «Обзор» counted on the
 * client from GET /api/documents/tree. The fixture is the synthetic demo base as the API answered it (83 documents,
 * 12 needing attention; summaries dropped), so the numbers here are the demo's real numbers.
 */

const demoTree = demo as DocumentTree;
const index = indexTree(demoTree);
const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  forgetDocumentTree();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sections in the tree's order: Всего, Утверждено, На ревью, Черновики, Устарели, Нужна проверка, Без владельца. */
const DEMO_ROWS: [string, number[]][] = [
  ["Продукт", [1, 1, 0, 0, 0, 0, 0]],
  ["Архитектура", [1, 1, 0, 0, 0, 0, 0]],
  ["Домен", [9, 7, 2, 0, 0, 1, 0]],
  ["Системы-источники", [12, 10, 1, 1, 0, 1, 1]],
  ["Интеграции", [19, 16, 0, 2, 1, 1, 0]],
  ["Датасеты", [3, 3, 0, 0, 0, 0, 0]],
  ["Процессы", [7, 6, 0, 0, 1, 1, 1]],
  ["Решения", [5, 5, 0, 0, 0, 0, 0]],
  ["Стандарты", [19, 17, 1, 0, 1, 2, 0]],
  ["Руководства", [5, 5, 0, 0, 0, 0, 0]],
  ["Глоссарий", [2, 2, 0, 0, 0, 0, 0]],
];
const DEMO_TOTAL = [83, 73, 4, 3, 3, 6, 2];

describe("lib/docsOverview on the demo base", () => {
  const overview = buildOverview(index);
  const columns = ["total", "approved", "in_review", "draft", "deprecated", "needs_review", "no_owner"] as const;

  it("counts every section × state; «Всего» is the API's count; rows in the tree's order", () => {
    expect(overview.rows.map((row) => [row.label, columns.map((c) => row.counts[c])])).toEqual(DEMO_ROWS);
    expect(columns.map((c) => overview.total.counts[c])).toEqual(DEMO_TOTAL);
    expect(overview.documents).toBe(83);
    expect(overview.attention).toBe(12);
  });

  it("says a cell in words with Russian plurals", () => {
    const row = (label: string) => overview.rows.find((r) => r.label === label)!;
    expect(cellLabel(row("Интеграции"), COLUMN_BY_KEY.draft)).toBe("Интеграции: 2 черновика");
    expect(cellLabel(row("Системы-источники"), COLUMN_BY_KEY.draft)).toBe("Системы-источники: 1 черновик");
    expect(cellLabel(row("Домен"), COLUMN_BY_KEY.in_review)).toBe("Домен: 2 документа на ревью");
    expect(cellLabel(row("Стандарты"), COLUMN_BY_KEY.needs_review)).toBe("Стандарты: 2 документа требуют проверки");
    expect(cellLabel(row("Процессы"), COLUMN_BY_KEY.needs_review)).toBe("Процессы: 1 документ требует проверки");
    expect(cellLabel(row("Процессы"), COLUMN_BY_KEY.deprecated)).toBe("Процессы: 1 устаревший документ");
    expect(cellLabel(row("Процессы"), COLUMN_BY_KEY.no_owner)).toBe("Процессы: 1 документ без владельца");
    expect(cellLabel(row("Интеграции"), COLUMN_BY_KEY.approved)).toBe("Интеграции: 16 утверждённых документов из 19");
    expect(cellLabel(row("Глоссарий"), COLUMN_BY_KEY.approved)).toBe("Глоссарий: 2 утверждённых документа из 2");
    expect(cellLabel(row("Интеграции"), COLUMN_BY_KEY.total)).toBe("Интеграции: 19 документов");
    expect(cellLabel(row("Продукт"), COLUMN_BY_KEY.draft)).toBe("Продукт: нет черновиков");
    expect(cellLabel(overview.total, COLUMN_BY_KEY.in_review)).toBe("Всего: 4 документа на ревью");
  });

  it("links a cell to the table with Раздел = the row and Состояние = the column", () => {
    const integration = overview.rows.find((r) => r.key === "integration")!;
    expect(cellHref(integration, COLUMN_BY_KEY.draft)).toBe("/documents?view=table&type=integration&status=draft");
    expect(cellHref(integration, COLUMN_BY_KEY.needs_review)).toBe("/documents?view=table&type=integration&flag=needs_review");
    expect(cellHref(integration, COLUMN_BY_KEY.total)).toBe("/documents?view=table&type=integration");
    expect(cellHref(overview.total, COLUMN_BY_KEY.no_owner)).toBe("/documents?view=table&flag=no_owner");
    expect(tableHref({ attention: true })).toBe("/documents?view=table&attention=1");
  });

  it("groups the documents needing attention by action; together they are the API's attention documents", () => {
    const groups = todoGroups(index);
    expect(groups.map((g) => [g.title, g.ids.length])).toEqual([
      ["Завершить ревью", 4],
      ["Назначить владельца", 2],
      ["Перепроверить", 2],
      ["Черновики и устаревшие", 6],
    ]);
    const union = new Set(groups.flatMap((g) => g.ids));
    const flagged = Object.entries(demoTree.documents)
      .filter(([, entry]) => entry.attention)
      .map(([id]) => id);
    expect([...union].sort()).toEqual(flagged.sort());
    expect(union.size).toBe(12);
    // «Перепроверить»: approved documents, the oldest review first
    expect(groups[2]?.ids).toEqual(["SEM-STD-001", "DEMO-SRC-004"]);
    expect(todoNote(index, "recheck", "SEM-STD-001", new Date("2026-11-24"))).toBe("15 янв. 2025");
    expect(todoNote(index, "review", "DEMO-SRC-010")).toBe("Системы-источники");
    expect(groups.map((g) => g.href)).toEqual([
      "/documents?view=table&status=in_review",
      "/documents?view=table&flag=no_owner",
      "/documents?view=table&status=approved&flag=needs_review",
      "/documents?view=table&status=draft%2Cdeprecated",
    ]);
  });
});

function renderOverview(path = "/documents?view=overview") {
  const calls = mockApi([{ path: "/api/documents/tree", body: demoTree }]);
  renderRoutes(path, { "/documents": <ExplorerPage /> });
  return calls;
}

/** What a matrix cell shows: its number, or «—» for zero. */
function shown(cell: Element): string {
  const link = cell.querySelector("a");
  if (link) return link.textContent ?? "";
  return cell.querySelector(".docs-matrix__zero") ? "—" : (cell.textContent ?? "");
}

describe("Обзор: the matrix", () => {
  it("shows «83 документа, 73 утверждены», «12 требуют внимания» and the matrix with the demo's numbers", async () => {
    const calls = renderOverview();
    const overview = await screen.findByRole("region", { name: "83 документа, 73 утверждены" });
    expect(within(overview).getByRole("link", { name: "12 требуют внимания" })).toHaveAttribute("href", "/documents?view=table&attention=1");
    expect(within(overview).getByText(/Один документ может попасть в несколько столбцов/)).toBeInTheDocument();

    const table = within(overview).getByRole("table", { name: "Документы по разделам и состояниям" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Раздел",
      "Всего",
      "Утверждено",
      "На ревью",
      "Черновики",
      "Устарели",
      "Нужна проверка",
      "Без владельца",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    const read = (row: HTMLElement) => [
      within(row).getByRole("rowheader").textContent,
      within(row).getAllByRole("cell").map(shown),
    ];
    const zeroAsDash = (counts: number[]) => counts.map((n, i) => (n === 0 && i > 0 ? "—" : String(n)));
    expect(rows.slice(0, -1).map(read)).toEqual(DEMO_ROWS.map(([label, counts]) => [label, zeroAsDash(counts)]));
    expect(read(rows[rows.length - 1] as HTMLElement)).toEqual(["Всего", zeroAsDash(DEMO_TOTAL)]);
    // a zero says so to assistive technology, a number names its section and state
    const integration = rows[4] as HTMLElement;
    expect(within(integration).getByRole("link", { name: "Интеграции: 2 черновика" })).toHaveClass("docs-matrix__chip--draft");
    expect(within(integration).getByText("Интеграции: нет документов на ревью")).toHaveClass("visually-hidden");
    expect(within(integration).getByRole("link", { name: "Интеграции: 16 утверждённых документов из 19" })).toBeInTheDocument();
    // one request for the whole view; no search field on the overview
    expect(calls.filter((c) => c.url === "/api/documents/tree")).toHaveLength(1);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("a cell opens «Таблица» with Раздел = the row and Состояние = the column", async () => {
    renderOverview();
    await userEvent.click(await screen.findByRole("link", { name: "Интеграции: 2 черновика" }));
    expect(location()).toBe("/documents?view=table&type=integration&status=draft");
    expect(screen.getByRole("button", { name: "Таблица" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a section opens «Список» with that section open in the tree", async () => {
    renderOverview();
    await userEvent.click(await screen.findByRole("link", { name: "Интеграции" }));
    expect(location()).toBe("/documents?view=list&node=integration");
    const item = await screen.findByRole("treeitem", { name: /^Интеграции, 19 документов/ });
    expect(item).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { level: 2, name: "Интеграции" })).toBeInTheDocument();
  });

  it("says when nothing needs attention", async () => {
    const calm: DocumentTree = { ...demoTree, attention_total: 0, documents: {}, sections: [], total: 0 };
    mockApi([{ path: "/api/documents/tree", body: calm }]);
    renderRoutes("/documents?view=overview", { "/documents": <ExplorerPage /> });
    expect(await screen.findByText("Внимания не требует ни один документ")).toBeInTheDocument();
    expect(screen.getByText("Сейчас ни один документ не требует внимания.")).toBeInTheDocument();
  });
});

describe("Обзор: «Что сделать»", () => {
  it("groups by action with up to three documents each and «Ещё N» into the filtered table", async () => {
    renderOverview();
    const todo = await screen.findByRole("complementary", { name: "Что сделать" });
    expect(within(todo).getByText("12 документов, сгруппированы по действию")).toBeInTheDocument();
    const groups = within(todo).getAllByRole("region");
    expect(groups.map((g) => within(g).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Завершить ревью4",
      "Назначить владельца2",
      "Перепроверить2 утверждённых",
      "Черновики и устаревшие6",
    ]);
    const [review, owner, recheck, drafts] = groups as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(review).getAllByRole("listitem")).toHaveLength(3);
    expect(within(review).getByRole("link", { name: "Завершить ревью: ещё 1 в таблице" })).toHaveAttribute(
      "href",
      "/documents?view=table&status=in_review",
    );
    expect(within(owner).queryByRole("link", { name: /ещё/ })).toBeNull();
    const crm = within(recheck).getByRole("link", { name: /^CRM: карточки и идентификаторы/ });
    expect(crm).toHaveAttribute("href", "/documents/DEMO-SRC-004");
    expect(within(drafts).getByRole("link", { name: "Черновики и устаревшие: ещё 3 в таблице" })).toHaveAttribute(
      "href",
      "/documents?view=table&status=draft%2Cdeprecated",
    );
    // a draft or a deprecated document says its status in text, with its shape
    expect(within(drafts).getAllByText(/^(Черновик|Устарел)$/)).toHaveLength(3);
  });
});

describe("Обзор on a phone", () => {
  it("lists the sections with the non-zero states as chips, no wide matrix", async () => {
    mockViewport(390);
    renderOverview();
    const list = await screen.findByRole("list", { name: "Документы по разделам и состояниям" });
    expect(screen.queryByRole("table")).toBeNull();
    const chips = within(list).getByRole("list", { name: "Интеграции: требуют внимания" });
    expect(within(chips).getAllByRole("link").map((l) => l.textContent)).toEqual(["Черновики: 2", "Устарели: 1", "Нужна проверка: 1"]);
    expect(within(chips).getByRole("link", { name: "Интеграции: 2 черновика" })).toHaveAttribute(
      "href",
      "/documents?view=table&type=integration&status=draft",
    );
    expect(within(list).queryByRole("list", { name: "Решения: требуют внимания" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Что сделать" })).toBeInTheDocument());
  });
});
