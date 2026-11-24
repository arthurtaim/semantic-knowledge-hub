import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentDetail, DocumentTree, DocumentTreeEntry } from "../api/types";
import { BranchList, LONG_LIST, type BranchRowData } from "../components/docs/BranchList";
import { peekHandOff } from "../lib/conversation";
import { indexTree, reviewMark } from "../lib/docTree";
import { ExplorerPage } from "../pages/ExplorerPage";
import { DocumentPage, treeCrumbs } from "../pages/DocumentPage";
import type { RecentHandOff } from "../pages/HomePage";
import { demoTree } from "./docsTreeFixture";
import { arisDetail, session } from "./fixtures";
import { memoryStorage, mockApi, mockViewport, renderAt, renderRoutes } from "./helpers";

/*
 * «Документы» v2, slice 4 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §1 «Список ветки», «Предпросмотр»): the branch
 * list with its order and three-line rows, the preview from GET /api/documents/{id}, the wiring of tree, list and
 * preview through the URL, the document page's path by the tree.
 */

const location = () => screen.getByTestId("location").textContent ?? "";

const flowDetail: DocumentDetail = {
  ...arisDetail,
  id: "DEMO-INT-001",
  title: "ARIS → Catalog: обзор потока (демо)",
  status: "approved",
  owner: "demo-integration-team",
  version: "2.0",
  review_state: "ok",
  reviewed_at: "2026-10-16",
  tags: ["aris", "catalog"],
  summary: "Инкрементальный поток процессных метаданных из ARIS (SYS-ARIS) в Data Catalog (SYS-CAT).",
  systems: ["ARIS", "Data Catalog"],
  sections: [
    { heading: "ARIS → Catalog: обзор потока (демо)", anchor: "aris-catalog", level: 1, text: "" },
    { heading: "Назначение", anchor: "назначение", level: 2, text: "…" },
    { heading: "Детали", anchor: "детали", level: 3, text: "…" },
    { heading: "Источник и получатель", anchor: "источник-и-получатель", level: 2, text: "…" },
  ],
};

function routes(extra: Parameters<typeof mockApi>[0] = []) {
  return mockApi([
    ...extra,
    { path: "/api/documents/tree", body: demoTree },
    { path: "/api/documents/DEMO-INT-001", body: flowDetail },
    { path: "/api/documents/DEMO-INT-002", body: { ...flowDetail, id: "DEMO-INT-002", title: "ARIS → Catalog: маппинг полей (демо)" } },
    { path: /^\/api\/documents\/[A-Z]/, body: arisDetail },
  ]);
}

function renderList(path: string, mode = session) {
  return renderRoutes(
    path,
    {
      "/documents": <ExplorerPage />,
      "/documents/:id": <p>Страница документа</p>,
      "/ask": <p>Ассистент</p>,
      "/proposals/new": <p>Новое предложение</p>,
    },
    mode,
  );
}

const branch = () => screen.getByRole("region", { name: /^(Интеграции \/ ARIS|Требуют внимания|Все документы|Результаты)/ });
const rowLinks = () => within(branch()).getAllByRole("link").filter((link) => link.classList.contains("docs-row"));
const titles = () => rowLinks().map((link) => link.querySelector(".docs-row__title")?.textContent);

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Список: the branch list", () => {
  it("shows the branch's path, its count from the API and rows of three lines; the status only when not approved", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris");
    const region = await screen.findByRole("region", { name: "Интеграции / ARIS" });
    const head = region.querySelector(".docs-branch__head") as HTMLElement;
    expect(within(head).getByText("Интеграции")).toHaveClass("docs-branch__parent");
    expect(within(head).getByRole("heading", { level: 2 })).toHaveTextContent("ARIS");
    expect(within(head).getByLabelText("4 документа")).toHaveTextContent("4");
    // «Сначала требующие внимания»: deprecated, drafts, in review, approved needing attention, then by title
    expect(titles()).toEqual([
      "Ночная полная выгрузка ARIS (устаревший поток)",
      "ARIS integration — questions for discovery",
      "ARIS → Catalog: маппинг полей (демо)",
      "ARIS → Catalog: обзор потока (демо)",
    ]);
    const [deprecated, draft, , approved] = rowLinks() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(deprecated).toHaveAccessibleName("Ночная полная выгрузка ARIS (устаревший поток), Устарел");
    expect(deprecated).toHaveClass("docs-row--deprecated");
    expect(within(deprecated).getByText("Устарел")).toBeInTheDocument();
    expect(within(draft).getByText("Черновик")).toBeInTheDocument();
    expect(within(approved).queryByText("Утверждён")).toBeNull();
    expect(approved).toHaveAccessibleName("ARIS → Catalog: обзор потока (демо)");
    // line 2: the summary, only when there is one; line 3: ID, systems, review date
    expect(within(approved).getByText(/^Инкрементальный поток/)).toHaveClass("docs-row__summary");
    expect(draft.querySelector(".docs-row__summary")).toBeNull();
    expect(within(approved).getByText("DEMO-INT-001")).toBeInTheDocument();
    expect(within(approved).getByText("ARIS, Data Catalog")).toBeInTheDocument();
    expect(approved.querySelector(".docs-row__review")).toHaveTextContent("16 окт.");
    // overdue in amber; a draft: «не требуется»
    expect(deprecated.querySelector(".docs-row__review")).toHaveClass("docs-row__review--warn");
    expect(deprecated.querySelector(".docs-row__review")).toHaveTextContent("10 дек. 2025");
    expect(draft.querySelector(".docs-row__review")).toHaveTextContent("не требуется");
    expect(screen.getByText("Источник: Локальный workspace", { selector: "p" })).toBeInTheDocument();
  });

  it("changes the order from the menu, through the URL", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris");
    await screen.findByRole("region", { name: "Интеграции / ARIS" });
    await userEvent.click(screen.getByRole("button", { name: "Сначала требующие внимания" }));
    const menu = screen.getByRole("menu", { name: "Порядок документов" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Сначала требующие внимания",
      "По названию",
      "По дате проверки",
    ]);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "По дате проверки" }));
    expect(location()).toBe("/documents?view=list&node=integration%2Faris&order=reviewed");
    expect(titles()).toEqual([
      "Ночная полная выгрузка ARIS (устаревший поток)", // 10 Dec 2025
      "ARIS → Catalog: маппинг полей (демо)", // 15 Oct
      "ARIS → Catalog: обзор потока (демо)", // 16 Oct
      "ARIS integration — questions for discovery", // a draft: no review expected
    ]);
    await userEvent.click(screen.getByRole("button", { name: "По дате проверки" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "По названию" }));
    expect(titles()[0]).toBe("Ночная полная выгрузка ARIS (устаревший поток)"); // Cyrillic first in Russian order
    expect(location()).toContain("order=title");
  });

  it("previews on a click and on Space, opens on Enter; ↑↓ Home End move between rows (one tab stop)", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris");
    await screen.findByRole("region", { name: "Интеграции / ARIS" });
    const rows = rowLinks();
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    await userEvent.click(rows[3] as HTMLElement);
    expect(location()).toBe("/documents?view=list&node=integration%2Faris&doc=DEMO-INT-001");
    expect(rows[3]).toHaveAttribute("aria-current", "true");
    expect(rows[3]).toHaveClass("docs-row--selected");
    expect(await screen.findByRole("heading", { level: 2, name: "ARIS → Catalog: обзор потока (демо)" })).toBeInTheDocument();
    // the keyboard
    expect(rows[3]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(rows[2]).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(rows[3]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowDown}");
    expect(rows[2]).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(location()).toBe("/documents?view=list&node=integration%2Faris&doc=DEMO-INT-002");
    await userEvent.keyboard("{Enter}");
    expect(location()).toBe("/documents/DEMO-INT-002");
  });

  it("opens the document on a double click", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris");
    await screen.findByRole("region", { name: "Интеграции / ARIS" });
    await userEvent.dblClick(rowLinks()[0] as HTMLElement);
    expect(location()).toBe("/documents/DEMO-INT-018");
  });

  it("lists «Требуют внимания» and «Все документы» from the tree; no paging", async () => {
    routes();
    renderList("/documents?view=list&node=attention");
    const region = await screen.findByRole("region", { name: "Требуют внимания" });
    expect(within(region).getByLabelText("4 документа")).toBeInTheDocument();
    expect(titles()).toEqual([
      "Ночная полная выгрузка ARIS (устаревший поток)",
      "ARIS integration — questions for discovery",
      "Archive Store: исторические снимки",
      "CRM: карточки и идентификаторы",
    ]);
    expect(within(rowLinks()[2] as HTMLElement).getByText("без владельца")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("tree")).getByText("Все документы"));
    expect(await screen.findByRole("region", { name: "Все документы" })).toBeInTheDocument();
    expect(rowLinks()).toHaveLength(11);
    expect(screen.queryByRole("navigation", { name: /Страницы/ })).toBeNull();
  });

  it("does not lay out rows off screen in a long branch (content-visibility beyond 200 rows)", () => {
    const row = (n: number): BranchRowData => ({
      id: `DOC-${n}`,
      title: `Документ ${n}`,
      status: "approved",
      summary: null,
      systems: [],
      review: reviewMark({ review_state: "ok", reviewed_at: "2026-10-01" }),
      ownerMissing: false,
      indexStale: false,
      source: "local",
    });
    const rows = Array.from({ length: LONG_LIST + 1 }, (_, n) => row(n));
    const { unmount } = renderAt("/", "/", <BranchList parentLabel={null} title="Все документы" count={rows.length} rows={rows} selected={null} onPreview={() => {}} />);
    expect(screen.getByRole("list")).toHaveClass("docs-list--long");
    expect(screen.getAllByRole("listitem")).toHaveLength(201);
    unmount();
    renderAt("/", "/", <BranchList parentLabel={null} title="Все документы" count={200} rows={rows.slice(0, 200)} selected={null} onPreview={() => {}} />);
    expect(screen.getByRole("list")).not.toHaveClass("docs-list--long");
  });
});

describe("Список: tree, list and preview together", () => {
  it("tree → ARIS → document → preview → «Открыть»", async () => {
    routes();
    renderList("/documents");
    const tree = await screen.findByRole("tree");
    await userEvent.click(within(tree).getByText("Интеграции"));
    await userEvent.click(within(tree).getByText("ARIS"));
    await waitFor(() => expect(location()).toBe("/documents?view=list&node=integration%2Faris"));
    expect(screen.getByRole("region", { name: "Интеграции / ARIS" })).toBeInTheDocument();
    await userEvent.click(within(tree).getByText("ARIS → Catalog: обзор потока (демо)"));
    expect(location()).toBe("/documents?view=list&node=integration%2Faris&doc=DEMO-INT-001");
    // highlighted in the tree and in the list
    expect(within(tree).getByRole("treeitem", { name: "ARIS → Catalog: обзор потока (демо)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: "ARIS → Catalog: обзор потока (демо)" })).toHaveAttribute("aria-current", "true");
    const preview = await screen.findByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" });
    await userEvent.click(within(preview).getByRole("link", { name: "Открыть" }));
    expect(location()).toBe("/documents/DEMO-INT-001");
  });

  it("a document chosen in the tree takes the list to its branch, unless the list shows all or those needing attention", async () => {
    routes();
    renderList("/documents?view=list&node=source");
    const tree = await screen.findByRole("tree");
    await userEvent.click(within(tree).getByText("Интеграции"));
    await userEvent.click(within(tree).getByText("Общие правила"));
    await userEvent.click(within(tree).getByText("CDC и full refresh: сравнение"));
    expect(location()).toBe("/documents?view=list&node=integration%2F_common&doc=DEMO-INT-010");
    await userEvent.click(within(tree).getByText("Требуют внимания"));
    await userEvent.click(within(tree).getByText("CDC и full refresh: сравнение"));
    expect(location()).toBe("/documents?view=list&node=attention&doc=DEMO-INT-010");
  });

  it("opens a shared link with `doc`: the tree opens to it and the preview shows it", async () => {
    routes();
    renderList("/documents?view=list&node=attention&doc=DEMO-INT-001");
    const tree = await screen.findByRole("tree");
    expect(within(tree).getByRole("treeitem", { name: "ARIS → Catalog: обзор потока (демо)" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" })).toBeInTheDocument();
  });

  it("a search shows the results in the middle column; the tree stays and marks the branch of the chosen result", async () => {
    routes([
      {
        path: "/api/documents?query=%D0%BF%D0%BE%D1%82%D0%BE%D0%BA&page=1&size=100",
        body: {
          items: [{ ...flowDetail, highlights: [{ text: "поток", highlight: true }], match_reasons: ["Слова запроса в названии"], link_count: 11 }],
          total: 1,
          page: 1,
          size: 100,
        },
      },
    ]);
    renderList("/documents?view=list&node=source");
    const field = await screen.findByRole("searchbox", { name: "Найти в документах" });
    await userEvent.type(field, "поток{Enter}");
    const results = await screen.findByRole("region", { name: "Результаты: «поток»" });
    const result = within(results).getByRole("link", { name: "ARIS → Catalog: обзор потока (демо)" });
    expect(within(result).getByText("поток", { selector: "mark" })).toBeInTheDocument();
    expect(within(result).getByText("Почему найдено: Слова запроса в названии")).toBeInTheDocument();
    await userEvent.click(result);
    expect(location()).toContain("doc=DEMO-INT-001");
    expect(location()).toContain("node=source"); // a search keeps the node
    const tree = screen.getByRole("tree");
    expect(within(tree).getByRole("treeitem", { name: /^ARIS, 4/ }).querySelector(".doc-tree__row--trail")).not.toBeNull();
    expect(within(tree).getByRole("treeitem", { name: "ARIS → Catalog: обзор потока (демо)" })).toHaveAttribute("aria-selected", "true");
  });

  it("below 1280 px the preview is a sheet opened by a choice; below 960 px a document opens its page", async () => {
    mockViewport(1100);
    routes();
    const { unmount } = renderList("/documents?view=list&node=integration/aris&doc=DEMO-INT-001");
    await screen.findByRole("region", { name: "Интеграции / ARIS" });
    expect(screen.queryByRole("dialog")).toBeNull(); // never opens by itself
    await userEvent.click(screen.getByRole("link", { name: "ARIS → Catalog: маппинг полей (демо)" }));
    const sheet = await screen.findByRole("dialog", { name: "Просмотр документа" });
    expect(within(sheet).getByRole("link", { name: "Открыть" })).toHaveAttribute("href", "/documents/DEMO-INT-002");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    mockViewport(390);
    renderList("/documents?view=list");
    const tree = await screen.findByRole("tree");
    expect(screen.queryByRole("region", { name: "Все документы" })).toBeNull(); // one screen: the tree first
    await userEvent.click(within(tree).getByText("Системы-источники"));
    expect(await screen.findByRole("region", { name: "Системы-источники" })).toBeInTheDocument();
    expect(screen.queryByRole("tree")).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "CRM: карточки и идентификаторы" }));
    expect(location()).toBe("/documents/DEMO-SRC-004");
  });
});

describe("Список: the preview", () => {
  it("shows the document: status, ID, version, title, summary, actions, properties, tags and its sections", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris&doc=DEMO-INT-001");
    const preview = await screen.findByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" });
    const status = preview.querySelector(".doc-preview__status") as HTMLElement;
    expect(status).toHaveTextContent("Утверждён");
    expect(status).toHaveTextContent("DEMO-INT-001");
    expect(status).toHaveTextContent("версия 2.0");
    expect(within(preview).getByRole("heading", { level: 2 })).toHaveClass("doc-preview__title");
    expect(within(preview).getByText(/^Инкрементальный поток/)).toHaveClass("doc-preview__summary");
    expect(within(preview).getByRole("link", { name: "Открыть" })).toHaveClass("button--primary");
    expect(preview.querySelectorAll(".button--primary")).toHaveLength(1);
    expect(within(preview).getByRole("button", { name: "Спросить ассистента" })).toBeInTheDocument();
    expect(within(preview).getByRole("link", { name: "Предложить изменение" })).toHaveAttribute("href", "/proposals/new?document=DEMO-INT-001");
    const value = (term: string) => within(preview).getByText(term, { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(value("Расположение")).toHaveTextContent("Интеграции / ARIS");
    expect(value("Системы")).toHaveTextContent("ARIS, Data Catalog");
    expect(value("Владелец")).toHaveTextContent("demo-integration-team");
    expect(value("Проверен")).toHaveTextContent("16 окт.");
    expect(within(value("Связи")).getByRole("link", { name: "11 документов" })).toHaveAttribute("href", "/documents/DEMO-INT-001#doc-links");
    expect(within(within(preview).getByRole("list", { name: "Теги" })).getByRole("link", { name: "aris" })).toHaveAttribute(
      "href",
      "/documents?view=table&tag=aris",
    );
    const toc = within(preview).getByRole("navigation", { name: "Разделы документа" });
    expect(within(toc).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Назначение", `/documents/DEMO-INT-001#${encodeURIComponent("назначение")}`],
      ["Источник и получатель", `/documents/DEMO-INT-001#${encodeURIComponent("источник-и-получатель")}`],
    ]);
  });

  it("«Спросить ассистента» opens a new dialog with this document as its context (like «@документ»)", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris&doc=DEMO-INT-001");
    const preview = await screen.findByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" });
    await userEvent.click(within(preview).getByRole("button", { name: "Спросить ассистента" }));
    expect(location()).toBe("/ask");
    const handed = peekHandOff<RecentHandOff>();
    expect(handed?.recent.documents).toEqual([{ id: "DEMO-INT-001", title: "ARIS → Catalog: обзор потока (демо)" }]);
    expect(handed?.recent.question).toBe("");
  });

  it("has no «Спросить ассистента» when AI is disabled", async () => {
    routes();
    renderList("/documents?view=list&node=integration/aris&doc=DEMO-INT-001", {
      ...session,
      features: { ...session.features, ai_mode: "disabled" },
    });
    const preview = await screen.findByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" });
    expect(within(preview).queryByRole("button", { name: "Спросить ассистента" })).toBeNull();
    expect(within(preview).getByRole("link", { name: "Открыть" })).toBeInTheDocument();
  });

  it("shows a skeleton while loading and a short error with «Повторить»", async () => {
    let fail = true;
    let release: (() => void) | null = null;
    mockApi([
      { path: "/api/documents/tree", body: demoTree },
      {
        path: "/api/documents/DEMO-INT-001",
        respond: () =>
          fail
            ? new Response(JSON.stringify({ code: "internal_error", message: "Сервер недоступен.", request_id: "r1" }), { status: 500 })
            : new Promise<Response>((resolve) => {
                release = () => resolve(new Response(JSON.stringify(flowDetail), { status: 200 }));
              }),
      },
    ]);
    renderList("/documents?view=list&node=integration/aris&doc=DEMO-INT-001");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить документ DEMO-INT-001. Сервер недоступен.");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Загружаем документ…");
    expect(document.querySelector(".doc-preview__skeleton")).not.toBeNull();
    await act(async () => release?.());
    expect(await screen.findByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" })).toBeInTheDocument();
  });
});

describe("The document page's path follows the tree", () => {
  const index = indexTree(demoTree);

  it("Документы / section / group / title; the section alone without a group or a tree", () => {
    expect(treeCrumbs(flowDetail, index)).toEqual([
      { label: "Документы", to: "/documents" },
      { label: "Интеграции", to: "/documents?view=list&node=integration" },
      { label: "ARIS", to: "/documents?view=list&node=integration%2Faris&doc=DEMO-INT-001" },
      { label: "ARIS → Catalog: обзор потока (демо)" },
    ]);
    const source = { ...flowDetail, id: "DEMO-SRC-002", type: "source" as const, title: "ARIS: модель" };
    expect(treeCrumbs(source, index)).toEqual([
      { label: "Документы", to: "/documents" },
      { label: "Системы-источники", to: "/documents?view=list&node=source&doc=DEMO-SRC-002" },
      { label: "ARIS: модель" },
    ]);
    expect(treeCrumbs(flowDetail, null)[1]).toEqual({ label: "Интеграции", to: "/documents?view=list&node=integration&doc=DEMO-INT-001" });
  });

  it("renders the path with the group once the tree arrives", async () => {
    const entry: DocumentTreeEntry = demoTree.documents["DEMO-INT-001"] as DocumentTreeEntry;
    const tree: DocumentTree = { ...demoTree, documents: { ...demoTree.documents, "DEMO-INT-001": entry } };
    mockApi([
      { path: "/api/documents/DEMO-INT-001", body: flowDetail },
      { path: "/api/drafts?document_id=DEMO-INT-001", body: { items: [], total: 0 } },
      { path: "/api/documents/tree", body: tree },
    ]);
    renderAt("/documents/DEMO-INT-001", "/documents/:id", <DocumentPage />);
    const path = await screen.findByRole("navigation", { name: "Путь" });
    await waitFor(() => expect(within(path).getAllByRole("listitem")).toHaveLength(4));
    expect(within(path).getByRole("link", { name: "ARIS" })).toHaveAttribute("href", "/documents?view=list&node=integration%2Faris&doc=DEMO-INT-001");
    expect(within(path).getByRole("link", { name: "Интеграции" })).toHaveAttribute("href", "/documents?view=list&node=integration");
  });
});
