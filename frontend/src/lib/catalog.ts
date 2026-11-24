import type { DocStatus, DocType, DocumentSummary } from "../api/types";
import { SOURCE_LABEL, STATUS_LABEL, STATUS_ORDER, TYPE_LABEL, TYPE_ORDER } from "./labels";
import { readPreference, writePreference } from "./storage";

/*
 * The document catalog (`/documents`, docs/ui-v2/specs/03_SCREENS.md §4): filters in the URL (one value or a
 * comma-separated list — the API takes both), active filters as chips, grouping of the table, the view choice
 * remembered in this browser, and the matching knowledge-map URL for «Карта».
 */

export const FILTER_KEYS = ["type", "status", "owner", "tag", "source"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTER_TITLE: Record<FilterKey, string> = {
  type: "Раздел",
  status: "Статус",
  owner: "Владелец",
  source: "Источник",
  tag: "Тег",
};

/** The values of one filter from the URL (`status=approved,in_review` or `status=draft`). */
export function filterValues(params: URLSearchParams, key: FilterKey): string[] {
  return (params.get(key) ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Adds the value to the filter, or removes it if it is already there; null when the filter becomes empty. */
export function toggleValue(values: string[], value: string): string | null {
  const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  return next.length > 0 ? next.join(",") : null;
}

export function filterValueLabel(key: FilterKey, value: string): string {
  if (key === "type") return TYPE_LABEL[value as DocType] ?? value;
  if (key === "status") return STATUS_LABEL[value as DocStatus] ?? value;
  if (key === "source") return SOURCE_LABEL[value as keyof typeof SOURCE_LABEL] ?? value;
  return value;
}

export interface ActiveFilter {
  key: FilterKey;
  values: string[];
  /** «Статус: Утверждён, На ревью». */
  label: string;
}

export function activeFilters(params: URLSearchParams): ActiveFilter[] {
  return FILTER_KEYS.flatMap((key) => {
    const values = filterValues(params, key);
    if (values.length === 0) return [];
    return [{ key, values, label: `${FILTER_TITLE[key]}: ${values.map((v) => filterValueLabel(key, v)).join(", ")}` }];
  });
}

// --- grouping of the table, remembered per browser (the view itself: lib/docsView.ts) -----------------------

export type CatalogGroup = "type" | "status" | "owner" | "none";

export const CATALOG_GROUP_KEY = "skh.catalog.group";

export const GROUP_LABEL: Record<CatalogGroup, string> = {
  type: "Раздел",
  status: "Статус",
  owner: "Владелец",
  none: "Без группировки",
};

export function initialGroup(): CatalogGroup {
  const stored = readPreference(CATALOG_GROUP_KEY);
  return stored === "type" || stored === "status" || stored === "owner" || stored === "none" ? stored : "type";
}

export function rememberGroup(group: CatalogGroup): void {
  writePreference(CATALOG_GROUP_KEY, group);
}

export interface DocumentGroup {
  key: string;
  label: string;
  items: DocumentSummary[];
}

const OWNER_MISSING = "\u0000missing";

/**
 * Groups the loaded rows, keeping the server's order inside a group. Sections and statuses follow the
 * knowledge base's own order; owners are alphabetical, «не назначен» last. `none` is one unlabeled group.
 */
export function groupDocuments(items: DocumentSummary[], by: CatalogGroup): DocumentGroup[] {
  if (by === "none") return [{ key: "all", label: "", items }];
  const groups = new Map<string, DocumentSummary[]>();
  for (const doc of items) {
    const key = by === "type" ? doc.type : by === "status" ? doc.status : doc.owner_missing ? OWNER_MISSING : doc.owner;
    const list = groups.get(key);
    if (list) list.push(doc);
    else groups.set(key, [doc]);
  }
  const keys = [...groups.keys()];
  const order =
    by === "type"
      ? (k: string) => TYPE_ORDER.indexOf(k as DocType)
      : by === "status"
        ? (k: string) => STATUS_ORDER.indexOf(k as DocStatus)
        : null;
  keys.sort((a, b) => {
    if (order) return order(a) - order(b);
    if (a === OWNER_MISSING) return 1;
    if (b === OWNER_MISSING) return -1;
    return a.localeCompare(b, "ru");
  });
  return keys.map((key) => ({
    key,
    label:
      by === "type"
        ? (TYPE_LABEL[key as DocType] ?? key)
        : by === "status"
          ? (STATUS_LABEL[key as DocStatus] ?? key)
          : key === OWNER_MISSING
            ? "не назначен"
            : key,
    items: groups.get(key) ?? [],
  }));
}

// --- «Карта»: the same filters on the knowledge map, where the map has them ----------------------------------

/** Document types that are their own node kind on the map (backend/app/services/graph.py KIND_BY_TYPE). */
const GRAPH_KIND_BY_TYPE: Partial<Record<string, string>> = {
  source: "source_system",
  integration: "integration",
  domain: "semantic_entity",
  dataset: "dataset",
};

/**
 * `/graph` with the catalog's filters mapped to the map's filters: one status → `status`, one section that is a
 * node kind of its own → `kind`. Owner, tag, source, several values and a text query have no map equivalent
 * and are dropped (the map shows the whole base then).
 */
export function graphHref(params: URLSearchParams): string {
  const next = new URLSearchParams();
  const types = filterValues(params, "type");
  const statuses = filterValues(params, "status");
  const kind = types.length === 1 ? GRAPH_KIND_BY_TYPE[types[0] ?? ""] : undefined;
  if (kind) next.set("kind", kind);
  if (statuses.length === 1 && statuses[0]) next.set("status", statuses[0]);
  const query = next.toString();
  return query ? `/graph?${query}` : "/graph";
}
