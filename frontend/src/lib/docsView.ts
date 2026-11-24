import { TABLE_KEYS } from "./docsTable";
import { readPreference, writePreference } from "./storage";

/*
 * «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md): which view `/documents` shows and the state every
 * view keeps in the URL, so a link can be sent to a colleague and «Назад» walks back through it.
 *
 *   view   overview | list | table          (absent: see `resolveView`)
 *   node   the tree node of «Список»: `all`, `attention`, a section (`integration`) or a group (`integration/aris`)
 *   doc    the document shown in the preview (its ID)
 *   q      the search of the toolbar field (`query` — the older name — is read too)
 *   order  the order of the branch list (`attention` by default, `title`, `reviewed`)
 *   type, status, flag, owner, system, source, tag, attention, sort, group — the table's (lib/docsTable.ts)
 */

export type DocsView = "overview" | "list" | "table";
export const DOCS_VIEWS: readonly DocsView[] = ["overview", "list", "table"];

export const VIEW_LABEL: Record<DocsView, string> = {
  overview: "Обзор",
  list: "Список",
  table: "Таблица",
};

export const VIEW_PARAM = "view";
export const NODE_PARAM = "node";
export const DOC_PARAM = "doc";
export const QUERY_PARAM = "q";
/** The name links from the palette, the assistant field and the map still use. */
export const LEGACY_QUERY_PARAM = "query";
export const ORDER_PARAM = "order";
/** The table's own keys: a link that carries one of them (and no view) opens the table (`page`: old links). */
export const TABLE_PARAMS: readonly string[] = [...TABLE_KEYS, "page"];

/** The view chosen in this browser (a new key: the catalog's old «list» was a list of snippets). */
export const DOCS_VIEW_KEY = "skh.documents.view";

function isView(value: string | null): value is DocsView {
  return value !== null && (DOCS_VIEWS as readonly string[]).includes(value);
}

export function storedDocsView(): DocsView | null {
  const stored = readPreference(DOCS_VIEW_KEY);
  return isView(stored) ? stored : null;
}

export function rememberDocsView(view: DocsView): void {
  writePreference(DOCS_VIEW_KEY, view);
}

/** The search text of the URL: `q`, or the older `query`. */
export function queryOf(params: URLSearchParams): string {
  return (params.get(QUERY_PARAM) ?? params.get(LEGACY_QUERY_PARAM) ?? "").trim();
}

/**
 * The view to show: the one the URL names; else «Список» for a node, a document or a search (they live there);
 * else «Таблица» for a link with table filters (`?owner=unassigned`, `?tag=aris`); else the one remembered in
 * this browser; else «Список».
 */
export function resolveView(params: URLSearchParams): DocsView {
  const named = params.get(VIEW_PARAM);
  if (isView(named)) return named;
  if (params.has(NODE_PARAM) || params.has(DOC_PARAM) || queryOf(params)) return "list";
  if (TABLE_PARAMS.some((key) => params.has(key))) return "table";
  return storedDocsView() ?? "list";
}

/** A copy of `params` with `changes` applied (null or "" removes a key). */
export function withParams(params: URLSearchParams, changes: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(name);
    else next.set(name, value);
  }
  return next;
}

/** The URL change of a new search: `q` set (or removed), the older `query` and the table's page dropped. */
export function searchChanges(text: string): Record<string, string | null> {
  return { [QUERY_PARAM]: text.trim() || null, [LEGACY_QUERY_PARAM]: null, page: null };
}

/** «Спросить ИИ об этих документах»: the assistant page with a question about the query and the top results. */
export function askAboutResults(query: string, ids: string[]): string {
  const top = ids.slice(0, 5);
  const question = `Что говорят документы по запросу «${query.slice(0, 200)}»${top.length ? ` (${top.join(", ")})` : ""}? Ответь со ссылками на источники.`;
  return `/ask?q=${encodeURIComponent(question)}`;
}
