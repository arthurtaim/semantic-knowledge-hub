import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentTree } from "../api/types";
import { DocTree, TREE_EXPANDED_KEY } from "../components/docs/DocTree";
import {
  ancestorsOf,
  compactDate,
  indexTree,
  knownNode,
  matchParts,
  pathLabel,
  reviewMark,
  sortIds,
  type TreeIndex,
} from "../lib/docTree";
import { demoTree } from "./docsTreeFixture";
import { memoryStorage } from "./helpers";

/*
 * «Документы» v2, slice 3: the tree (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §1 «Дерево») — counts from the API,
 * status shapes, click behaviour, the APG Tree View keyboard, the filter, remembered branches, opening the branch
 * of a document given from outside.
 */

function Harness({ index, initialNode = "all", initialDoc = null }: { index: TreeIndex; initialNode?: string; initialDoc?: string | null }) {
  const [node, setNode] = useState(initialNode);
  const [doc, setDoc] = useState<string | null>(initialDoc);
  return (
    <>
      <DocTree index={index} node={node} doc={doc} onSelectNode={setNode} onSelectDoc={setDoc} />
      <output data-testid="state">{`${node}|${doc ?? ""}`}</output>
    </>
  );
}

const state = () => screen.getByTestId("state").textContent;
const tree = () => screen.getByRole("tree", { name: "Разделы и документы" });
const item = (name: string | RegExp) => within(tree()).getByRole("treeitem", { name });
const visibleNames = () => within(tree()).getAllByRole("treeitem").map((el) => el.getAttribute("aria-label"));

function renderTree(options: { tree?: DocumentTree; node?: string; doc?: string | null } = {}) {
  const index = indexTree(options.tree ?? demoTree);
  return render(<Harness index={index} initialNode={options.node} initialDoc={options.doc ?? null} />);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocTree", () => {
  it("shows the filter, «Свернуть всё», the two lists and the sections with the API's counts", () => {
    renderTree();
    expect(screen.getByRole("navigation", { name: "Дерево документов" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Фильтр дерева" })).toHaveAttribute("placeholder", "Фильтр дерева");
    expect(screen.getByRole("button", { name: "Свернуть всё" })).toBeInTheDocument();
    expect(visibleNames()).toEqual([
      "Все документы, 11 документов",
      "Требуют внимания, 4 документа",
      "Продукт, 1 документ",
      "Системы-источники, 3 документа, 2 требуют внимания",
      "Интеграции, 5 документов, 2 требуют внимания",
      "Стандарты, 2 документа",
    ]);
    const integrations = item(/^Интеграции/);
    expect(integrations).toHaveAttribute("aria-level", "1");
    expect(integrations).toHaveAttribute("aria-expanded", "false");
    expect(within(integrations).getByTitle("Требуют внимания")).toHaveTextContent("2");
    expect(integrations.querySelector(".doc-tree__count")).toHaveTextContent("5");
    // «Требуют внимания»: the yellow counter, not a second plain number
    const attention = item(/^Требуют внимания/);
    expect(attention.querySelector(".doc-tree__attention")).toHaveTextContent("4");
    expect(attention.querySelector(".doc-tree__count")).toBeNull();
    // «Все документы» is the list now: current and selected
    expect(item(/^Все документы/)).toHaveAttribute("aria-current", "true");
    expect(item(/^Все документы/)).toHaveAttribute("aria-selected", "true");
    expect(within(tree()).getAllByRole("treeitem", { selected: true })).toHaveLength(1);
  });

  it("a click opens a section and makes it the list; a second click on it closes it", async () => {
    renderTree();
    await userEvent.click(within(item(/^Интеграции/)).getByText("Интеграции"));
    expect(state()).toBe("integration|");
    const integrations = item(/^Интеграции/);
    expect(integrations).toHaveAttribute("aria-expanded", "true");
    expect(integrations).toHaveAttribute("aria-current", "true");
    const groups = within(integrations).getByRole("group");
    expect(within(groups).getAllByRole("treeitem").map((el) => el.getAttribute("aria-label"))).toEqual([
      "ARIS, 4 документа, 2 требуют внимания",
      "Общие правила, 1 документ",
    ]);
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-level", "2");
    // a group: opens and becomes the list
    await userEvent.click(within(item(/^ARIS, 4/)).getByText("ARIS"));
    expect(state()).toBe("integration/aris|");
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-expanded", "true");
    // the section stays open while another node is the list; clicking the listed group again closes it
    await userEvent.click(within(item(/^ARIS, 4/)).getAllByText("ARIS")[0] as HTMLElement);
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-expanded", "false");
    expect(state()).toBe("integration/aris|");
  });

  it("shows documents with their status shape and selects one on a click", async () => {
    renderTree({ node: "integration/aris" });
    await userEvent.click(within(item(/^Интеграции/)).getByText("Интеграции"));
    await userEvent.click(within(item(/^ARIS, 4/)).getByText("ARIS"));
    const docs = within(within(item(/^ARIS, 4/)).getByRole("group")).getAllByRole("treeitem");
    // the server's order: needing attention first; a status other than «Утверждён» is part of the name
    expect(docs.map((el) => el.getAttribute("aria-label"))).toEqual([
      "ARIS integration — questions for discovery, Черновик",
      "Ночная полная выгрузка ARIS (устаревший поток), Устарел",
      "ARIS → Catalog: обзор потока (демо)",
      "ARIS → Catalog: маппинг полей (демо)",
    ]);
    expect(docs[0]?.querySelector(".doc-tree__shape--draft")).not.toBeNull();
    expect(docs[1]?.querySelector(".doc-tree__row--deprecated")).not.toBeNull();
    expect(docs[2]?.querySelector('[data-icon="file"]')).not.toBeNull();
    expect(docs[2]).toHaveAttribute("aria-level", "3");
    expect(within(docs[2] as HTMLElement).getByTitle("ARIS → Catalog: обзор потока (демо)")).toBeInTheDocument();
    await userEvent.click(within(docs[2] as HTMLElement).getByText("ARIS → Catalog: обзор потока (демо)"));
    expect(state()).toBe("integration/aris|DEMO-INT-001");
    expect(item("ARIS → Catalog: обзор потока (демо)")).toHaveAttribute("aria-selected", "true");
    // the listed group stays current, the document is the one selected item
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-current", "true");
    expect(within(tree()).getAllByRole("treeitem", { selected: true })).toHaveLength(1);
  });

  it("follows the APG Tree View keyboard: ↑↓ Home End → ← Enter and type-ahead, one tab stop", async () => {
    // Letters typed within 0.6 s form one prefix; each step of this test is a new word unless said otherwise.
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const pause = () => {
      clock += 1000;
    };
    renderTree();
    const all = item(/^Все документы/);
    expect(all).toHaveAttribute("tabindex", "0");
    expect(within(tree()).getAllByRole("treeitem").filter((el) => el.getAttribute("tabindex") === "0")).toHaveLength(1);
    act(() => all.focus());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(item(/^Системы-источники/)).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(item(/^Продукт/)).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(item(/^Стандарты/)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(all).toHaveFocus();
    // type-ahead: «и» → Интеграции; → opens it, → again moves to its first child
    pause();
    await userEvent.keyboard("и");
    const integrations = item(/^Интеграции/);
    expect(integrations).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(integrations).toHaveAttribute("aria-expanded", "true");
    expect(integrations).toHaveFocus();
    expect(state()).toBe("all|"); // opening is not choosing
    await userEvent.keyboard("{ArrowRight}");
    expect(item(/^ARIS, 4/)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(item(/^ARIS integration/)).toHaveFocus();
    // ← on a document goes to its group, on an open group closes it, then goes up to the section
    await userEvent.keyboard("{ArrowLeft}");
    expect(item(/^ARIS, 4/)).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowLeft}");
    expect(integrations).toHaveFocus();
    // Enter chooses: the node becomes the list
    await userEvent.keyboard("{Enter}");
    expect(state()).toBe("integration|");
    // type-ahead by prefix: «с» goes to the next «С…» (Стандарты after Интеграции), «ст» stays on it; from the top
    // «с» → Системы-источники, then «ст» (typed together) → Стандарты
    pause();
    await userEvent.keyboard("с");
    expect(item(/^Стандарты/)).toHaveFocus();
    pause();
    await userEvent.keyboard("{Home}");
    await userEvent.keyboard("с");
    expect(item(/^Системы-источники/)).toHaveFocus();
    await userEvent.keyboard("т");
    expect(item(/^Стандарты/)).toHaveFocus();
    // the focused item is the tab stop
    expect(item(/^Стандарты/)).toHaveAttribute("tabindex", "0");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}");
    expect(state()).toBe("integration|DEMO-GOV-001"); // choosing a document leaves the node to the page
  });

  it("filters by title and ID with the matches marked and their branches open; Esc clears", async () => {
    renderTree();
    const field = screen.getByRole("searchbox", { name: "Фильтр дерева" });
    await userEvent.type(field, "маппинг");
    expect(visibleNames()).toEqual([
      "Все документы, 11 документов",
      "Требуют внимания, 4 документа",
      "Интеграции, 5 документов, 2 требуют внимания",
      "ARIS, 4 документа, 2 требуют внимания",
      "ARIS → Catalog: маппинг полей (демо)",
    ]);
    expect(item(/^Интеграции/)).toHaveAttribute("aria-expanded", "true");
    expect(within(item("ARIS → Catalog: маппинг полей (демо)")).getByText("маппинг", { selector: "mark" })).toBeInTheDocument();
    // by ID, case-insensitively
    await userEvent.clear(field);
    await userEvent.type(field, "src-004");
    expect(visibleNames().slice(2)).toEqual(["Системы-источники, 3 документа, 2 требуют внимания", "CRM: карточки и идентификаторы"]);
    // a group name shows the whole group
    await userEvent.clear(field);
    await userEvent.type(field, "общие");
    expect(visibleNames().slice(2)).toEqual(["Интеграции, 5 документов, 2 требуют внимания", "Общие правила, 1 документ", "CDC и full refresh: сравнение"]);
    await userEvent.clear(field);
    await userEvent.type(field, "квазизвезда");
    expect(screen.getByText("В дереве нет совпадений с «квазизвезда».")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(field).toHaveValue("");
    // the filter did not change what the reader had opened
    expect(item(/^Интеграции/)).toHaveAttribute("aria-expanded", "false");
  });

  it("remembers the open branches in this browser; «Свернуть всё» closes them", async () => {
    const { unmount } = renderTree();
    await userEvent.click(within(item(/^Интеграции/)).getByText("Интеграции"));
    await userEvent.click(within(item(/^ARIS, 4/)).getByText("ARIS"));
    expect(JSON.parse(localStorage.getItem(TREE_EXPANDED_KEY) ?? "[]")).toEqual(["integration", "integration/aris"]);
    unmount();
    renderTree();
    expect(item(/^Интеграции/)).toHaveAttribute("aria-expanded", "true");
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Свернуть всё" }));
    expect(item(/^Интеграции/)).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem(TREE_EXPANDED_KEY)).toBeNull();
  });

  it("opens the branch of a document given from outside and scrolls it into view", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderTree({ node: "attention", doc: "DEMO-INT-001" });
    const target = item("ARIS → Catalog: обзор потока (демо)");
    expect(target).toHaveAttribute("aria-selected", "true");
    expect(item(/^Интеграции/)).toHaveAttribute("aria-expanded", "true");
    expect(item(/^ARIS, 4/)).toHaveAttribute("aria-expanded", "true");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(scroll.mock.contexts.at(-1)).toBe(target);
    // the branch holding it is marked while another node is the list
    expect(item(/^ARIS, 4/).querySelector(".doc-tree__row--trail")).not.toBeNull();
    expect(item(/^Требуют внимания/)).toHaveAttribute("aria-current", "true");
    expect(JSON.parse(localStorage.getItem(TREE_EXPANDED_KEY) ?? "[]")).toEqual(["integration", "integration/aris"]);
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
    renderTree();
    await userEvent.click(within(item(/^Интеграции/)).getByText("Интеграции"));
    expect(item(/^Интеграции/)).toHaveAttribute("aria-expanded", "true");
  });
});

describe("lib/docTree", () => {
  const index = indexTree(demoTree);

  it("indexes sections, groups and the node of every document; an unknown type goes last", () => {
    expect(index.sections.map((s) => s.key)).toEqual(["overview", "source", "integration", "standard"]);
    expect(index.nodes.get("integration")?.allDocIds).toEqual([
      "SEM-INT-ARIS-001",
      "DEMO-INT-018",
      "DEMO-INT-001",
      "DEMO-INT-002",
      "DEMO-INT-010",
    ]);
    expect(index.nodes.get("all")?.allDocIds).toHaveLength(11);
    expect(index.nodes.get("attention")?.allDocIds.sort()).toEqual(["DEMO-INT-018", "DEMO-SRC-004", "DEMO-SRC-010", "SEM-INT-ARIS-001"]);
    expect(pathLabel(index, "DEMO-INT-001")).toBe("Интеграции / ARIS");
    expect(pathLabel(index, "DEMO-SRC-002")).toBe("Системы-источники");
    expect(pathLabel(index, "NOPE")).toBeNull();
    expect(ancestorsOf(index, "DEMO-PROC-006")).toEqual(["standard", "standard/templates"]);
    expect(knownNode(index, "integration/aris")).toBe("integration/aris");
    expect(knownNode(index, "integration/zzz")).toBe("all");
    expect(knownNode(index, null)).toBe("all");
    const odd = indexTree({
      ...demoTree,
      sections: [{ key: "memo", label: "memo", count: 0, attention: 0, groups: [], doc_ids: [] }, ...demoTree.sections],
    });
    expect(odd.sections.map((s) => s.key)).toEqual(["overview", "source", "integration", "standard", "memo"]);
  });

  it("orders a branch: needing attention first, by title, by the review date", () => {
    const ids = index.nodes.get("all")?.allDocIds ?? [];
    const attention = sortIds(ids, demoTree.documents, "attention");
    expect(attention.slice(0, 4)).toEqual(["DEMO-INT-018", "SEM-INT-ARIS-001", "DEMO-SRC-010", "DEMO-SRC-004"]);
    // Russian collation: Cyrillic titles first, then Latin ones
    const titles = sortIds(ids, demoTree.documents, "title").map((id) => demoTree.documents[id]?.title);
    expect(titles.slice(0, 2)).toEqual(["Ночная полная выгрузка ARIS (устаревший поток)", "Статусы документов и authority (демо)"]);
    expect(titles.slice(4, 7)).toEqual(["ARIS → Catalog: маппинг полей (демо)", "ARIS → Catalog: обзор потока (демо)", "ARIS integration — questions for discovery"]);
    const reviewed = sortIds(ids, demoTree.documents, "reviewed");
    expect(reviewed[0]).toBe("DEMO-INT-018"); // 2025-12-10, the oldest
    expect(reviewed.at(-1)).toBe("SEM-INT-ARIS-001"); // a draft: no review expected
  });

  it("formats the review date and its tone", () => {
    const now = new Date("2026-11-24T12:00:00");
    expect(compactDate("2026-10-16", now)).toBe("16 окт.");
    expect(compactDate("2025-12-10", now)).toBe("10 дек. 2025");
    expect(reviewMark({ review_state: "ok", reviewed_at: "2026-10-16" }, now)).toMatchObject({ text: "16 окт.", tone: "normal" });
    expect(reviewMark({ review_state: "stale", reviewed_at: "2026-03-02" }, now)).toMatchObject({ text: "2 мар.", tone: "warn" });
    expect(reviewMark({ review_state: "never_reviewed", reviewed_at: null }, now)).toMatchObject({ text: "не проверялся", tone: "warn" });
    expect(reviewMark({ review_state: "not_required", reviewed_at: null }, now)).toMatchObject({ text: "не требуется", tone: "muted" });
  });

  it("splits a text into matching parts, ignoring case and «ё»", () => {
    expect(matchParts("Ёлка и ёж", "е")).toEqual([
      { text: "Ё", match: true },
      { text: "лка и ", match: false },
      { text: "ё", match: true },
      { text: "ж", match: false },
    ]);
    expect(matchParts("ARIS", "")).toEqual([{ text: "ARIS", match: false }]);
  });
});
