import type { DocStatus, DocumentTreeEntry } from "../api/types";
import { compactDate, reviewMark, sectionRank, type ReviewMark, type TreeIndex } from "./docTree";
import { STATUS_ORDER } from "./labels";
import { readPreference, writePreference } from "./storage";

/*
 * «Таблица» of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §3, design docs-04): every row is a document
 * of GET /api/documents/tree; filters, sort and grouping are URL keys, so a filtered table can be sent to a colleague
 * and «Назад» walks back through it:
 *
 *   type       Раздел — section keys (document types)
 *   status     Состояние — document statuses (approved, in_review, draft, deprecated)
 *   flag       Состояние — what needs doing: `needs_review` (a stale or missing review), `no_owner`
 *   owner      Владелец — owners; `unassigned` is every document without an owner
 *   system     Система — systems the document is about
 *   source     Источник — local, gitlab…
 *   tag        Тег — answered by the server (GET /api/documents?tag=), the tree has no tags
 *   q          the toolbar search — answered by the server, the table keeps the matching rows
 *   attention  `1`: only the documents that need attention (the tree's `attention`)
 *   sort       `reviewed` (default, oldest first), `-reviewed`, `title`, `-links`…
 *   group      `type`, `owner`, `system` (none by default)
 *
 * Values of one key combine with «или», keys with «и»: `status=approved&flag=needs_review` is an approved document
 * whose review is overdue («Перепроверить»). The columns shown are remembered in this browser.
 */

export const TYPE_PARAM = "type";
export const STATUS_PARAM = "status";
export const FLAG_PARAM = "flag";
export const OWNER_PARAM = "owner";
export const SYSTEM_PARAM = "system";
export const SOURCE_PARAM = "source";
export const TAG_PARAM = "tag";
export const ATTENTION_PARAM = "attention";
export const SORT_PARAM = "sort";
export const GROUP_PARAM = "group";

/** The filters with several values (comma-separated in the URL). */
export const LIST_FILTERS = [TYPE_PARAM, STATUS_PARAM, FLAG_PARAM, OWNER_PARAM, SYSTEM_PARAM, SOURCE_PARAM, TAG_PARAM] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

/** Every key of the table: a link with one of them (and no view) opens «Таблица». */
export const TABLE_KEYS: readonly string[] = [...LIST_FILTERS, ATTENTION_PARAM, SORT_PARAM, GROUP_PARAM];

export type DocFlag = "needs_review" | "no_owner";
export const DOC_FLAGS: readonly DocFlag[] = ["needs_review", "no_owner"];
export const FLAG_LABEL: Record<DocFlag, string> = {
  needs_review: "Нужна проверка",
  no_owner: "Без владельца",
};

/** The owner filter's «не назначен»: every document without an owner, whatever placeholder it carries. */
export const UNASSIGNED_OWNER = "unassigned";
export const UNASSIGNED_LABEL = "не назначен";

/** «Нужна проверка»: the review is overdue or the document was never reviewed. */
export function needsReview(entry: Pick<DocumentTreeEntry, "review_state">): boolean {
  return entry.review_state === "stale" || entry.review_state === "never_reviewed";
}

export function hasFlag(entry: Pick<DocumentTreeEntry, "review_state" | "owner_missing">, flag: DocFlag): boolean {
  return flag === "needs_review" ? needsReview(entry) : entry.owner_missing;
}

// --- links into the table ----------------------------------------------------------------------------------------

/** A link into «Таблица» with these filters. */
export interface TableLink {
  type?: string[];
  status?: string[];
  flag?: DocFlag[];
  attention?: boolean;
}

export function tableHref(link: TableLink = {}): string {
  const params = new URLSearchParams({ view: "table" });
  if (link.type?.length) params.set(TYPE_PARAM, link.type.join(","));
  if (link.status?.length) params.set(STATUS_PARAM, link.status.join(","));
  if (link.flag?.length) params.set(FLAG_PARAM, link.flag.join(","));
  if (link.attention) params.set(ATTENTION_PARAM, "1");
  return `/documents?${params.toString()}`;
}

// --- filters ------------------------------------------------------------------------------------------------------

export function listValues(params: URLSearchParams, key: string): string[] {
  return (params.get(key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export type TableFilters = Record<ListFilter, string[]> & { attention: boolean };

export function readFilters(params: URLSearchParams): TableFilters {
  const lists = Object.fromEntries(LIST_FILTERS.map((key) => [key, listValues(params, key)])) as Record<ListFilter, string[]>;
  return { ...lists, attention: params.get(ATTENTION_PARAM) === "1" };
}

/** How many filter values are chosen (the phone's «Фильтры (N)»). */
export function filterCount(filters: TableFilters): number {
  return LIST_FILTERS.reduce((n, key) => n + filters[key].length, 0) + (filters.attention ? 1 : 0);
}

/** Whether a document passes every filter the tree can answer (tags and the search are the server's). */
export function matchesFilters(entry: DocumentTreeEntry, filters: TableFilters): boolean {
  if (filters.type.length && !filters.type.includes(entry.type)) return false;
  if (filters.status.length && !filters.status.includes(entry.status)) return false;
  if (filters.flag.length && !filters.flag.some((flag) => (DOC_FLAGS as readonly string[]).includes(flag) && hasFlag(entry, flag as DocFlag))) {
    return false;
  }
  if (filters.owner.length && !filters.owner.some((owner) => (owner === UNASSIGNED_OWNER ? entry.owner_missing : entry.owner === owner))) {
    return false;
  }
  if (filters.system.length && !filters.system.some((system) => entry.systems.includes(system))) return false;
  if (filters.source.length && !filters.source.includes(entry.source)) return false;
  if (filters.attention && !entry.attention) return false;
  return true;
}

/** Adds the value to the list, or removes it if it is there; null when the list becomes empty. */
export function toggled(values: string[], value: string): string | null {
  const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  return next.length > 0 ? next.join(",") : null;
}

// --- sort ---------------------------------------------------------------------------------------------------------

export type SortKey = "title" | "type" | "status" | "owner" | "reviewed" | "links";
export type SortDir = "asc" | "desc";
export interface TableSort {
  key: SortKey;
  dir: SortDir;
}

/** «Проверен ↑»: the oldest review first. */
export const DEFAULT_SORT: TableSort = { key: "reviewed", dir: "asc" };
const SORT_KEYS: readonly SortKey[] = ["title", "type", "status", "owner", "reviewed", "links"];

/** `reviewed`, `-links`…; an unknown value (the old catalog's `updated`) is the default. */
export function parseSort(value: string | null): TableSort {
  if (!value) return DEFAULT_SORT;
  const desc = value.startsWith("-");
  const key = desc ? value.slice(1) : value;
  return (SORT_KEYS as readonly string[]).includes(key) ? { key: key as SortKey, dir: desc ? "desc" : "asc" } : DEFAULT_SORT;
}

/** The URL value of a sort; null for the default (the key is left out). */
export function sortValue(sort: TableSort): string | null {
  if (sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir) return null;
  return sort.dir === "desc" ? `-${sort.key}` : sort.key;
}

/** A click on a header: the sorted column turns around, another column sorts ascending. */
export function nextSort(current: TableSort, key: SortKey): TableSort {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

const byTitle = (a: DocumentTreeEntry, b: DocumentTreeEntry) => a.title.localeCompare(b.title, "ru", { sensitivity: "base" });

/** Never reviewed first (the oldest of all), then the oldest review; «не требуется» last. */
function reviewOrder(entry: DocumentTreeEntry): string {
  if (entry.review_state === "never_reviewed") return "0";
  if (entry.reviewed_at) return `1${entry.reviewed_at}`;
  return "2";
}

function compareBy(key: SortKey, a: DocumentTreeEntry, b: DocumentTreeEntry): number {
  switch (key) {
    case "title":
      return byTitle(a, b);
    case "type":
      return sectionRank(a.type) - sectionRank(b.type) || a.type.localeCompare(b.type);
    case "status":
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    case "owner":
      // «не назначен» after every owner
      return Number(a.owner_missing) - Number(b.owner_missing) || (a.owner_missing ? 0 : a.owner.localeCompare(b.owner, "ru"));
    case "reviewed":
      return reviewOrder(a).localeCompare(reviewOrder(b));
    case "links":
      return a.link_count - b.link_count;
    default:
      return 0;
  }
}

/** The documents in the table's order; ties by title, then ID (stable whichever the direction). */
export function sortIdsBy(ids: string[], documents: Record<string, DocumentTreeEntry>, sort: TableSort): string[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return ids
    .filter((id) => documents[id])
    .sort((x, y) => {
      const a = documents[x] as DocumentTreeEntry;
      const b = documents[y] as DocumentTreeEntry;
      return sign * compareBy(sort.key, a, b) || byTitle(a, b) || x.localeCompare(y);
    });
}

// --- grouping -----------------------------------------------------------------------------------------------------

export type TableGroup = "none" | "type" | "owner" | "system";
export const TABLE_GROUPS: readonly TableGroup[] = ["none", "type", "owner", "system"];
export const GROUP_LABEL: Record<TableGroup, string> = { none: "нет", type: "Раздел", owner: "Владелец", system: "Система" };
export const NO_SYSTEM_LABEL = "Без системы";

export function parseGroup(value: string | null): TableGroup {
  return value && (TABLE_GROUPS as readonly string[]).includes(value) ? (value as TableGroup) : "none";
}

export interface RowGroup {
  key: string;
  label: string;
  ids: string[];
}

const NONE = "\u0000none";

/**
 * The sorted rows in groups, keeping their order inside a group. Sections in the tree's order; owners alphabetically
 * with «не назначен» last; systems by the document's first system (the one its tree group is named after),
 * alphabetically, «Без системы» last. `none` is one unnamed group.
 */
export function groupIds(ids: string[], index: TreeIndex, group: TableGroup): RowGroup[] {
  if (group === "none") return [{ key: "all", label: "", ids }];
  const documents = index.tree.documents;
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const entry = documents[id];
    if (!entry) continue;
    const key = group === "type" ? entry.type : group === "owner" ? (entry.owner_missing ? NONE : entry.owner) : (entry.systems[0] ?? NONE);
    const list = groups.get(key);
    if (list) list.push(id);
    else groups.set(key, [id]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (group === "type") return sectionRank(a) - sectionRank(b) || a.localeCompare(b);
    if (a === NONE) return 1;
    if (b === NONE) return -1;
    return a.localeCompare(b, "ru");
  });
  return keys.map((key) => ({
    key,
    label:
      group === "type"
        ? (index.nodes.get(key)?.label ?? key)
        : key === NONE
          ? group === "owner"
            ? UNASSIGNED_LABEL
            : NO_SYSTEM_LABEL
          : key,
    ids: groups.get(key) ?? [],
  }));
}

// --- columns ------------------------------------------------------------------------------------------------------

export type ColumnKey = "title" | "type" | "status" | "owner" | "systems" | "reviewed" | "links";

export interface TableColumn {
  key: ColumnKey;
  label: string;
  /** The sort of a header click; null: not sortable («Системы»). */
  sort: SortKey | null;
  /** «Название» always stays. */
  hideable: boolean;
}

export const TABLE_COLUMNS: readonly TableColumn[] = [
  { key: "title", label: "Название", sort: "title", hideable: false },
  { key: "type", label: "Раздел", sort: "type", hideable: true },
  { key: "status", label: "Состояние", sort: "status", hideable: true },
  { key: "owner", label: "Владелец", sort: "owner", hideable: true },
  { key: "systems", label: "Системы", sort: null, hideable: true },
  { key: "reviewed", label: "Проверен", sort: "reviewed", hideable: true },
  { key: "links", label: "Связи", sort: "links", hideable: true },
];

export const COLUMNS_KEY = "skh.documents.columns";

/** Below 1280 px «Системы» starts hidden (seven columns do not fit about 850 px); «Колонки» shows it again. */
export const NARROW_HIDDEN: readonly ColumnKey[] = ["systems"];

/**
 * The columns the reader hid in this browser; null when they never chose (the width decides then). Storage may be
 * unavailable: then nothing was chosen.
 */
export function readHiddenColumns(): Set<ColumnKey> | null {
  try {
    const raw = readPreference(COLUMNS_KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as unknown;
    const hideable = TABLE_COLUMNS.filter((c) => c.hideable).map((c) => c.key as string);
    return new Set(Array.isArray(stored) ? (stored.filter((v) => typeof v === "string" && hideable.includes(v)) as ColumnKey[]) : []);
  } catch {
    return null;
  }
}

/** Remembers the reader's choice, an empty one too (every column shown, whatever the width). */
export function rememberHiddenColumns(hidden: Set<ColumnKey>): void {
  writePreference(COLUMNS_KEY, JSON.stringify([...hidden]));
}

// --- cells --------------------------------------------------------------------------------------------------------

const fullDateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });

/** «15 янв. 2025»: the table always says the year (a column of dates to compare). */
export function fullDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return fullDateFormat.format(date).replace(/\s*г\.$/, "");
}

/** «Проверен» of the table: like the list's (lib/docTree.ts reviewMark), with the year. */
export function tableReviewMark(entry: Pick<DocumentTreeEntry, "review_state" | "reviewed_at">): ReviewMark {
  const mark = reviewMark(entry);
  if (!entry.reviewed_at || entry.review_state === "never_reviewed") return mark;
  const text = fullDate(entry.reviewed_at);
  return { ...mark, text, description: mark.description.replace(compactDate(entry.reviewed_at), text) };
}

/** The values a filter menu offers, with the number of documents of each (from the tree). */
export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

function counted(entries: DocumentTreeEntry[], values: (entry: DocumentTreeEntry) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const value of values(entry)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function sectionOptions(index: TreeIndex): FilterOption[] {
  return index.sections.map((section) => ({ value: section.key, label: section.label, count: section.count }));
}

export function statusOptions(index: TreeIndex, label: Record<DocStatus, string>): FilterOption[] {
  const counts = counted(Object.values(index.tree.documents), (entry) => [entry.status]);
  return STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({ value: status, label: label[status], count: counts.get(status) ?? 0 }));
}

export function flagOptions(index: TreeIndex): FilterOption[] {
  const entries = Object.values(index.tree.documents);
  return DOC_FLAGS.map((flag) => ({ value: flag, label: FLAG_LABEL[flag], count: entries.filter((entry) => hasFlag(entry, flag)).length }));
}

export function ownerOptions(index: TreeIndex): FilterOption[] {
  const entries = Object.values(index.tree.documents);
  const counts = counted(entries, (entry) => (entry.owner_missing ? [] : [entry.owner]));
  const owners = [...counts.keys()].sort((a, b) => a.localeCompare(b, "ru")).map((owner) => ({ value: owner, label: owner, count: counts.get(owner) ?? 0 }));
  const missing = entries.filter((entry) => entry.owner_missing).length;
  return missing > 0 ? [...owners, { value: UNASSIGNED_OWNER, label: UNASSIGNED_LABEL, count: missing }] : owners;
}

export function systemOptions(index: TreeIndex): FilterOption[] {
  const counts = counted(Object.values(index.tree.documents), (entry) => entry.systems);
  return [...counts.keys()].sort((a, b) => a.localeCompare(b, "ru")).map((system) => ({ value: system, label: system, count: counts.get(system) ?? 0 }));
}

export function sourceOptions(index: TreeIndex, label: (source: string) => string): FilterOption[] {
  const counts = counted(Object.values(index.tree.documents), (entry) => [entry.source]);
  return [...counts.keys()].sort().map((source) => ({ value: source, label: label(source), count: counts.get(source) ?? 0 }));
}
