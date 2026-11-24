import type { DocumentTreeEntry } from "../api/types";

/*
 * «Таблица» of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §3): the filters it reads from the URL
 * and the links other views build into it (the overview's cells, «Что сделать»). Every filter is a URL key, so a
 * filtered table can be sent to a colleague and «Назад» walks back through it:
 *
 *   type       Раздел — section keys (document types), several with «,»
 *   status     Состояние — document statuses (approved, in_review, draft, deprecated)
 *   flag       Состояние — what needs doing: `needs_review` (a stale or missing review), `no_owner`
 *   attention  `1`: only the documents that need attention (the tree's `attention`)
 *
 * Values of one key combine with «или», keys with «и»: `status=approved&flag=needs_review` is an approved document
 * whose review is overdue («Перепроверить»).
 */

export const TYPE_PARAM = "type";
export const STATUS_PARAM = "status";
export const FLAG_PARAM = "flag";
export const ATTENTION_PARAM = "attention";

export type DocFlag = "needs_review" | "no_owner";
export const DOC_FLAGS: readonly DocFlag[] = ["needs_review", "no_owner"];
export const FLAG_LABEL: Record<DocFlag, string> = {
  needs_review: "Нужна проверка",
  no_owner: "Без владельца",
};

/** «Нужна проверка»: the review is overdue or the document was never reviewed. */
export function needsReview(entry: Pick<DocumentTreeEntry, "review_state">): boolean {
  return entry.review_state === "stale" || entry.review_state === "never_reviewed";
}

export function hasFlag(entry: Pick<DocumentTreeEntry, "review_state" | "owner_missing">, flag: DocFlag): boolean {
  return flag === "needs_review" ? needsReview(entry) : entry.owner_missing;
}

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
