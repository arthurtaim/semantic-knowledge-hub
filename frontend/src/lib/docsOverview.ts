import type { DocStatus, DocumentTreeEntry } from "../api/types";
import { ALL_NODE, compactDate, type TreeIndex } from "./docTree";
import { hasFlag, needsReview, tableHref, type TableLink } from "./docsTable";
import { pluralRu } from "./labels";

/*
 * «Обзор» of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §2, design docs-03): the matrix «разделы ×
 * состояние» and «Что сделать», both counted here from GET /api/documents/tree — the sections and their totals are
 * the API's, every other number is a count of the API's documents (no separate endpoint, nothing estimated).
 * A document can be counted in several columns (a draft whose owner is missing is in «Черновики» and «Без
 * владельца»); the overview says so.
 */

export type OverviewColumn = "total" | "approved" | "in_review" | "draft" | "deprecated" | "needs_review" | "no_owner";

export interface OverviewColumnSpec {
  key: OverviewColumn;
  /** The column header. */
  label: string;
  /** Short words for a phone chip («Черновики: 2»). */
  short: string;
  matches: (entry: DocumentTreeEntry) => boolean;
  /** The table filter that lists exactly these documents (the section is added per row). */
  link: TableLink;
  /** «2 черновика», «1 документ на ревью»: the count said in words. */
  phrase: (count: number) => string;
  /** «нет черновиков». */
  none: string;
}

const docs = (n: number) => pluralRu(n, "документ", "документа", "документов");
const status = (value: DocStatus) => (entry: DocumentTreeEntry) => entry.status === value;

export const OVERVIEW_COLUMNS: readonly OverviewColumnSpec[] = [
  {
    key: "total",
    label: "Всего",
    short: "Всего",
    matches: () => true,
    link: {},
    phrase: (n) => `${n} ${docs(n)}`,
    none: "нет документов",
  },
  {
    key: "approved",
    label: "Утверждено",
    short: "Утверждено",
    matches: status("approved"),
    link: { status: ["approved"] },
    phrase: (n) => `${n} ${pluralRu(n, "утверждённый документ", "утверждённых документа", "утверждённых документов")}`,
    none: "нет утверждённых документов",
  },
  {
    key: "in_review",
    label: "На ревью",
    short: "На ревью",
    matches: status("in_review"),
    link: { status: ["in_review"] },
    phrase: (n) => `${n} ${docs(n)} на ревью`,
    none: "нет документов на ревью",
  },
  {
    key: "draft",
    label: "Черновики",
    short: "Черновики",
    matches: status("draft"),
    link: { status: ["draft"] },
    phrase: (n) => `${n} ${pluralRu(n, "черновик", "черновика", "черновиков")}`,
    none: "нет черновиков",
  },
  {
    key: "deprecated",
    label: "Устарели",
    short: "Устарели",
    matches: status("deprecated"),
    link: { status: ["deprecated"] },
    phrase: (n) => `${n} ${pluralRu(n, "устаревший документ", "устаревших документа", "устаревших документов")}`,
    none: "нет устаревших документов",
  },
  {
    key: "needs_review",
    label: "Нужна проверка",
    short: "Нужна проверка",
    matches: needsReview,
    link: { flag: ["needs_review"] },
    phrase: (n) => `${n} ${pluralRu(n, "документ требует", "документа требуют", "документов требуют")} проверки`,
    none: "нет документов, требующих проверки",
  },
  {
    key: "no_owner",
    label: "Без владельца",
    short: "Без владельца",
    matches: (entry) => hasFlag(entry, "no_owner"),
    link: { flag: ["no_owner"] },
    phrase: (n) => `${n} ${docs(n)} без владельца`,
    none: "нет документов без владельца",
  },
];

export const COLUMN_BY_KEY = Object.fromEntries(OVERVIEW_COLUMNS.map((c) => [c.key, c])) as Record<OverviewColumn, OverviewColumnSpec>;

export interface OverviewRow {
  /** The section key (a document type); null for the total row. */
  key: string | null;
  label: string;
  counts: Record<OverviewColumn, number>;
}

export interface Overview {
  rows: OverviewRow[];
  total: OverviewRow;
  /** The API's totals. */
  documents: number;
  attention: number;
}

function countRow(key: string | null, label: string, total: number, entries: DocumentTreeEntry[]): OverviewRow {
  const counts = Object.fromEntries(
    OVERVIEW_COLUMNS.map((column) => [column.key, column.key === "total" ? total : entries.filter(column.matches).length]),
  ) as Record<OverviewColumn, number>;
  return { key, label, counts };
}

function entriesOf(index: TreeIndex, ids: string[]): DocumentTreeEntry[] {
  return ids.map((id) => index.tree.documents[id]).filter((entry): entry is DocumentTreeEntry => Boolean(entry));
}

/** The rows in the tree's order (its sections, unknown types last), then the total. «Всего» is the API's count. */
export function buildOverview(index: TreeIndex): Overview {
  const rows = index.sections.map((section) => countRow(section.key, section.label, section.count, entriesOf(index, section.allDocIds)));
  const all = index.nodes.get(ALL_NODE)?.allDocIds ?? [];
  return {
    rows,
    total: countRow(null, "Всего", index.tree.total, entriesOf(index, all)),
    documents: index.tree.total,
    attention: index.tree.attention_total,
  };
}

/** «Интеграции: 2 черновика», «Всего: нет документов без владельца». */
export function cellLabel(row: OverviewRow, column: OverviewColumnSpec): string {
  const count = row.counts[column.key];
  const words = count > 0 ? column.phrase(count) : column.none;
  return column.key === "approved" && count > 0 ? `${row.label}: ${words} из ${row.counts.total}` : `${row.label}: ${words}`;
}

/** The table with Раздел = the row (none for the total row) and Состояние = the column. */
export function cellHref(row: OverviewRow, column: OverviewColumnSpec): string {
  return tableHref({ ...column.link, type: row.key ? [row.key] : undefined });
}

/** The approved share of a row, 0–100 (the bar of «Утверждено»). */
export function approvedShare(row: OverviewRow): number {
  return row.counts.total > 0 ? Math.round((row.counts.approved / row.counts.total) * 100) : 0;
}

// --- «Что сделать» ---------------------------------------------------------------------------------------------

export type TodoKey = "review" | "owner" | "recheck" | "drafts";

export interface TodoGroup {
  key: TodoKey;
  title: string;
  /** Documents of the group in display order. */
  ids: string[];
  /** The table with exactly these documents («Ещё N»). */
  href: string;
}

/** Documents shown per group; «Ещё N» leads to the rest in the table. */
export const TODO_LIMIT = 3;

/** Overdue reviews first: never reviewed, then the oldest date. */
function byReviewAge(index: TreeIndex) {
  const date = (id: string) => {
    const entry = index.tree.documents[id];
    return entry?.review_state === "never_reviewed" ? "" : (entry?.reviewed_at ?? "9999");
  };
  return (a: string, b: string) => date(a).localeCompare(date(b));
}

/**
 * The documents that need attention, grouped by what to do (spec §2): «Завершить ревью» (in review), «Назначить
 * владельца» (no owner), «Перепроверить» (approved, review overdue or missing), «Черновики и устаревшие». Together
 * they are exactly the tree's `attention` documents; one can be in two groups (in review without an owner). Groups
 * keep the tree's order; «Перепроверить» starts with the oldest review. Empty groups are left out.
 */
export function todoGroups(index: TreeIndex): TodoGroup[] {
  const documents = index.tree.documents;
  const all = (index.nodes.get(ALL_NODE)?.allDocIds ?? []).filter((id) => documents[id]);
  const where = (test: (entry: DocumentTreeEntry) => boolean) => all.filter((id) => test(documents[id] as DocumentTreeEntry));
  const groups: TodoGroup[] = [
    {
      key: "review",
      title: "Завершить ревью",
      ids: where((e) => e.status === "in_review"),
      href: tableHref({ status: ["in_review"] }),
    },
    {
      key: "owner",
      title: "Назначить владельца",
      ids: where((e) => e.owner_missing),
      href: tableHref({ flag: ["no_owner"] }),
    },
    {
      key: "recheck",
      title: "Перепроверить",
      ids: where((e) => e.status === "approved" && needsReview(e)).sort(byReviewAge(index)),
      href: tableHref({ status: ["approved"], flag: ["needs_review"] }),
    },
    {
      key: "drafts",
      title: "Черновики и устаревшие",
      ids: where((e) => e.status === "draft" || e.status === "deprecated"),
      href: tableHref({ status: ["draft", "deprecated"] }),
    },
  ];
  return groups.filter((group) => group.ids.length > 0);
}

/** The right-hand note of a «Что сделать» row: the section; for «Перепроверить» the review date. */
export function todoNote(index: TreeIndex, group: TodoKey, id: string, now: Date = new Date()): string {
  const entry = index.tree.documents[id];
  if (!entry) return "";
  if (group === "recheck") return entry.reviewed_at ? compactDate(entry.reviewed_at, now) : "не проверялся";
  return index.nodes.get(entry.type)?.label ?? entry.type;
}
