import type { DocStatus, DocumentTree, DocumentTreeEntry, DocumentTreeSection } from "../api/types";

/*
 * The tree of «Документы» v2 (GET /api/documents/tree, docs/ui-v2/documents/specs/DOCUMENTS_V2.md §4) as the
 * views use it: nodes by key, the node each document sits in, its path («Интеграции / ARIS»), the branch list's
 * orders and the review date as the rows and the preview show it. Every number comes from the API; nothing here
 * counts what the server did not send.
 */

/** Pseudo-nodes above the sections. */
export const ALL_NODE = "all";
export const ATTENTION_NODE = "attention";

/** The tree's logical order (not by size); a type outside it goes last, by its key. */
export const TREE_SECTION_ORDER: readonly string[] = [
  "overview",
  "architecture",
  "domain",
  "source",
  "integration",
  "dataset",
  "process",
  "decision",
  "standard",
  "guide",
  "glossary",
];

export interface TreeNode {
  /** `integration`, `integration/aris`, `all`, `attention`. */
  key: string;
  label: string;
  /** 0 for «Все документы» / «Требуют внимания», 1 for a section, 2 for a group. */
  level: 0 | 1 | 2;
  /** The section of a group; null otherwise. */
  parent: string | null;
  /** A section's groups (keys, in order). */
  groups: string[];
  /** Documents directly in this node, in the server's order (a section with groups has none or a few). */
  docIds: string[];
  /** Every document of the node (a section: its groups' documents, then its own). */
  allDocIds: string[];
  count: number;
  attention: number;
}

export interface TreeIndex {
  tree: DocumentTree;
  /** Sections in the tree's order (unknown types last). */
  sections: TreeNode[];
  nodes: Map<string, TreeNode>;
  /** Document ID → the node it sits in (its group, else its section). */
  nodeOfDoc: Map<string, string>;
}

export function sectionRank(key: string): number {
  const index = TREE_SECTION_ORDER.indexOf(key);
  return index < 0 ? TREE_SECTION_ORDER.length : index;
}

function orderSections(sections: DocumentTreeSection[]): DocumentTreeSection[] {
  return sections
    .map((section, position) => ({ section, position }))
    .sort((a, b) => {
      const rank = sectionRank(a.section.key) - sectionRank(b.section.key);
      if (rank !== 0) return rank;
      // Two unknown types: by key; known ones keep the server's order.
      return sectionRank(a.section.key) === TREE_SECTION_ORDER.length
        ? a.section.key.localeCompare(b.section.key)
        : a.position - b.position;
    })
    .map(({ section }) => section);
}

export function indexTree(tree: DocumentTree): TreeIndex {
  const nodes = new Map<string, TreeNode>();
  const nodeOfDoc = new Map<string, string>();
  const ids = Object.keys(tree.documents);
  const attentionIds = ids.filter((id) => tree.documents[id]?.attention);
  nodes.set(ALL_NODE, {
    key: ALL_NODE,
    label: "Все документы",
    level: 0,
    parent: null,
    groups: [],
    docIds: [],
    allDocIds: [],
    count: tree.total,
    attention: tree.attention_total,
  });
  nodes.set(ATTENTION_NODE, {
    key: ATTENTION_NODE,
    label: "Требуют внимания",
    level: 0,
    parent: null,
    groups: [],
    docIds: [],
    allDocIds: attentionIds,
    count: tree.attention_total,
    attention: tree.attention_total,
  });
  const sections: TreeNode[] = [];
  const all: string[] = [];
  for (const section of orderSections(tree.sections)) {
    const groupKeys: string[] = [];
    const inSection: string[] = [];
    for (const group of section.groups) {
      const docIds = group.doc_ids.filter((id) => id in tree.documents);
      nodes.set(group.key, {
        key: group.key,
        label: group.label,
        level: 2,
        parent: section.key,
        groups: [],
        docIds,
        allDocIds: docIds,
        count: group.count,
        attention: group.attention,
      });
      groupKeys.push(group.key);
      for (const id of docIds) nodeOfDoc.set(id, group.key);
      inSection.push(...docIds);
    }
    const direct = section.doc_ids.filter((id) => id in tree.documents);
    for (const id of direct) nodeOfDoc.set(id, section.key);
    inSection.push(...direct);
    const node: TreeNode = {
      key: section.key,
      label: section.label,
      level: 1,
      parent: null,
      groups: groupKeys,
      docIds: direct,
      allDocIds: inSection,
      count: section.count,
      attention: section.attention,
    };
    nodes.set(section.key, node);
    sections.push(node);
    all.push(...inSection);
  }
  const allNode = nodes.get(ALL_NODE);
  if (allNode) allNode.allDocIds = all;
  return { tree, sections, nodes, nodeOfDoc };
}

/** The section and (if any) the group a document sits in. */
export function placeOf(index: TreeIndex, id: string): { section: TreeNode | null; group: TreeNode | null } {
  const key = index.nodeOfDoc.get(id);
  const node = key ? index.nodes.get(key) : undefined;
  if (!node) return { section: null, group: null };
  if (node.level === 2) return { section: index.nodes.get(node.parent ?? "") ?? null, group: node };
  return { section: node, group: null };
}

/** «Интеграции / ARIS» or «Системы-источники»; null for a document outside the tree. */
export function pathLabel(index: TreeIndex, id: string): string | null {
  const { section, group } = placeOf(index, id);
  if (!section) return null;
  return group ? `${section.label} / ${group.label}` : section.label;
}

/** The tree nodes above a document (its section, then its group): what must be open to show it. */
export function ancestorsOf(index: TreeIndex, id: string): string[] {
  const { section, group } = placeOf(index, id);
  return [section?.key, group?.key].filter((key): key is string => Boolean(key));
}

/** A node key from the URL that the tree knows; otherwise «Все документы». */
export function knownNode(index: TreeIndex, key: string | null): string {
  return key && index.nodes.has(key) ? key : ALL_NODE;
}

// --- the branch list's orders --------------------------------------------------------------------------------

export type ListOrder = "attention" | "title" | "reviewed";
export const LIST_ORDERS: readonly ListOrder[] = ["attention", "title", "reviewed"];
export const ORDER_LABEL: Record<ListOrder, string> = {
  attention: "Сначала требующие внимания",
  title: "По названию",
  reviewed: "По дате проверки",
};

export function parseOrder(value: string | null): ListOrder {
  return value && (LIST_ORDERS as readonly string[]).includes(value) ? (value as ListOrder) : "attention";
}

const STATUS_RANK: Record<DocStatus, number> = { deprecated: 0, draft: 1, in_review: 2, approved: 3 };

/** Deprecated, drafts, in review, approved needing attention (review or owner), then the rest. */
function attentionRank(entry: DocumentTreeEntry): number {
  if (entry.status !== "approved") return STATUS_RANK[entry.status];
  return entry.attention ? 3 : 4;
}

const byTitle = (a: DocumentTreeEntry, b: DocumentTreeEntry) => a.title.localeCompare(b.title, "ru", { sensitivity: "base" });

/** Never reviewed first (they need it), then the oldest review; «не требуется» (no review expected) last. */
function reviewRank(entry: DocumentTreeEntry): [number, string] {
  if (entry.review_state === "never_reviewed") return [0, ""];
  if (entry.reviewed_at) return [1, entry.reviewed_at];
  return [2, ""];
}

export function sortIds(ids: string[], documents: Record<string, DocumentTreeEntry>, order: ListOrder): string[] {
  const known = ids.filter((id) => documents[id]);
  const entry = (id: string) => documents[id] as DocumentTreeEntry;
  return [...known].sort((a, b) => {
    const x = entry(a);
    const y = entry(b);
    if (order === "attention") return attentionRank(x) - attentionRank(y) || byTitle(x, y) || a.localeCompare(b);
    if (order === "reviewed") {
      const [rx, dx] = reviewRank(x);
      const [ry, dy] = reviewRank(y);
      return rx - ry || dx.localeCompare(dy) || byTitle(x, y) || a.localeCompare(b);
    }
    return byTitle(x, y) || a.localeCompare(b);
  });
}

// --- the review date as rows and the preview show it ---------------------------------------------------------

const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });

/** «16 окт.» this year, «10 дек. 2025» another year; the value itself when it is not a date. */
export function compactDate(value: string, now: Date = new Date()): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  if (date.getFullYear() === now.getFullYear()) return dayMonth.format(date);
  return dayMonthYear.format(date).replace(/\s*г\.$/, "");
}

export interface ReviewMark {
  text: string;
  /** `warn`: overdue or never reviewed (amber); `muted`: no review expected. */
  tone: "normal" | "warn" | "muted";
  /** For assistive technology and the tooltip: what the date means. */
  description: string;
}

/** «Проверен»: the date (amber when overdue), «не проверялся» (amber) or «не требуется» (a draft, deprecated). */
export function reviewMark(entry: Pick<DocumentTreeEntry, "review_state" | "reviewed_at">, now: Date = new Date()): ReviewMark {
  if (entry.review_state === "never_reviewed") {
    return { text: "не проверялся", tone: "warn", description: "Документ ещё не проверялся" };
  }
  if (!entry.reviewed_at) return { text: "не требуется", tone: "muted", description: "Проверка не требуется" };
  const text = compactDate(entry.reviewed_at, now);
  if (entry.review_state === "stale") return { text, tone: "warn", description: `Проверен ${text}, проверка устарела` };
  return { text, tone: "normal", description: `Проверен ${text}` };
}

// --- the tree filter ------------------------------------------------------------------------------------------

/** Lower-cased, «ё» as «е»: the tree filter matches titles and IDs the way people type them. */
export function normalizeText(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е");
}

/** Whether a document matches the tree filter (title or ID). */
export function docMatches(id: string, entry: DocumentTreeEntry, needle: string): boolean {
  if (!needle) return true;
  return normalizeText(entry.title).includes(needle) || normalizeText(id).includes(needle);
}

/** Splits `text` into the parts that match `needle` (case- and «ё»-insensitively) and the rest. */
export function matchParts(text: string, needle: string): { text: string; match: boolean }[] {
  if (!needle) return [{ text, match: false }];
  const haystack = normalizeText(text);
  const parts: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && needle.length > 0; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
