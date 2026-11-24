import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DocStatus, DocumentTreeEntry } from "../../api/types";
import {
  ALL_NODE,
  ancestorsOf,
  ATTENTION_NODE,
  docMatches,
  matchParts,
  normalizeText,
  type TreeIndex,
  type TreeNode,
} from "../../lib/docTree";
import { pluralRu, STATUS_LABEL } from "../../lib/labels";
import { readPreference, writePreference } from "../../lib/storage";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";

/*
 * The documents tree of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §1, design docs-01 / docs-02):
 * «Фильтр дерева» and «Свернуть всё», «Все документы» and «Требуют внимания», then sections → groups → documents
 * with their counts from the API. A WAI-ARIA APG Tree View: `tree` / `treeitem` / `group`, `aria-expanded`,
 * `aria-selected`, `aria-level`, one tab stop (roving tabindex), ↑↓ →← Home End Enter and type-ahead.
 *
 * The node shown in the list is `aria-current`; the selected item (the previewed document, else that node) is
 * `aria-selected`. The open branches are remembered in this browser; a document chosen from outside (the URL, the
 * list, a search result) opens its branch and is scrolled into view.
 */

export const TREE_EXPANDED_KEY = "skh.documents.tree";
/** Type-ahead: letters typed within this pause form one prefix. */
const TYPEAHEAD_MS = 600;

function readExpanded(): Set<string> {
  try {
    const stored = JSON.parse(readPreference(TREE_EXPANDED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(keys: Set<string>): void {
  writePreference(TREE_EXPANDED_KEY, keys.size > 0 ? JSON.stringify([...keys]) : null);
}

/** One visible row of the tree, in display order. */
interface Item {
  key: string;
  kind: "pseudo" | "node" | "doc";
  level: number;
  label: string;
  parent: string | null;
  /** Nodes: whether the branch is open (null for a node without children and for documents). */
  expanded: boolean | null;
  node?: TreeNode;
  entry?: DocumentTreeEntry;
}

interface DocTreeProps {
  index: TreeIndex;
  /** The node whose documents the list shows. */
  node: string;
  /** The previewed document. */
  doc: string | null;
  onSelectNode: (key: string) => void;
  onSelectDoc: (id: string) => void;
}

const docKey = (id: string) => `doc:${id}`;

function StatusIcon({ status }: { status: DocStatus }) {
  if (status === "approved") return <Icon name="file" size={14} strokeWidth={1.8} className="doc-tree__icon doc-tree__icon--approved" />;
  return <span className={`doc-tree__icon doc-tree__shape doc-tree__shape--${status}`} aria-hidden="true" />;
}

function Marked({ text, needle }: { text: string; needle: string }) {
  const parts = matchParts(text, needle);
  return (
    <>
      {parts.map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

/**
 * What a document or node given from outside needs open, and the row to show: the document's section and group;
 * for a node (no document), its section and the node itself when it has children.
 */
function revealKeys(index: TreeIndex, node: string, doc: string | null): { target: string | null; open: string[] } {
  if (doc && index.tree.documents[doc]) return { target: docKey(doc), open: ancestorsOf(index, doc) };
  const nodeData = index.nodes.get(node);
  if (!nodeData || nodeData.level === 0) return { target: null, open: [] };
  const hasChildren = nodeData.groups.length > 0 || nodeData.docIds.length > 0;
  return { target: node, open: [nodeData.parent, hasChildren ? node : null].filter((key): key is string => Boolean(key)) };
}

function nodeName(node: TreeNode): string {
  const count = `${node.count} ${pluralRu(node.count, "документ", "документа", "документов")}`;
  if (node.key === ATTENTION_NODE || node.key === ALL_NODE) return `${node.label}, ${count}`;
  return node.attention > 0
    ? `${node.label}, ${count}, ${node.attention} ${pluralRu(node.attention, "требует", "требуют", "требуют")} внимания`
    : `${node.label}, ${count}`;
}

export function DocTree({ index, node, doc, onSelectNode, onSelectDoc }: DocTreeProps) {
  const idBase = useId();
  // Opened already on the first paint: the remembered branches plus the way to the given document or node.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([...readExpanded(), ...revealKeys(index, node, doc).open]));
  const [filter, setFilter] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const typed = useRef({ text: "", at: 0 });
  const needle = normalizeText(filter.trim());
  const documents = index.tree.documents;

  function changeExpanded(update: (current: Set<string>) => Set<string>) {
    setExpanded(update);
  }

  // A document chosen anywhere (the URL on arrival, the list, a search result) opens its branch and is shown;
  // so does a node given by the URL (a breadcrumb, an overview link): its section and the node itself open.
  useEffect(() => {
    const { target, open: keys } = revealKeys(index, node, doc);
    if (!target) return;
    setExpanded((current) => (keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys])));
    setReveal(target);
    // Only a new document or node from outside: a click on the open node closes it without reopening.
  }, [doc, node, index]);

  // The open branches are remembered in this browser (whatever opened them).
  useEffect(() => writeExpanded(expanded), [expanded]);

  // While filtering: the documents whose title or ID matches (or whose section / group name does), with their
  // branches open; a node shows when its name matches or something under it does.
  const filtering = needle.length > 0;
  const visible = useMemo(() => {
    if (!filtering) return null;
    const docs = new Set<string>();
    const nodes = new Set<string>();
    for (const section of index.sections) {
      const sectionHit = normalizeText(section.label).includes(needle);
      const consider = (ids: string[], groupHit: boolean, holder: string) => {
        for (const id of ids) {
          const entry = documents[id];
          if (entry && (sectionHit || groupHit || docMatches(id, entry, needle))) {
            docs.add(id);
            nodes.add(holder);
          }
        }
      };
      for (const groupKey of section.groups) {
        const group = index.nodes.get(groupKey);
        if (!group) continue;
        const groupHit = normalizeText(group.label).includes(needle);
        consider(group.docIds, groupHit, groupKey);
        if (groupHit || nodes.has(groupKey)) nodes.add(section.key);
      }
      consider(section.docIds, false, section.key);
      if (sectionHit) nodes.add(section.key);
    }
    return { docs, nodes };
  }, [filtering, needle, index, documents]);

  const isOpen = (key: string) => (visible ? visible.nodes.has(key) : expanded.has(key));

  // The visible rows in order: what the keyboard walks through.
  const items = useMemo(() => {
    const list: Item[] = [];
    for (const key of [ALL_NODE, ATTENTION_NODE]) {
      const pseudo = index.nodes.get(key);
      if (pseudo) list.push({ key, kind: "pseudo", level: 1, label: pseudo.label, parent: null, expanded: null, node: pseudo });
    }
    const pushDocs = (ids: string[], level: number, parent: string) => {
      for (const id of ids) {
        const entry = documents[id];
        if (!entry || (visible && !visible.docs.has(id))) continue;
        list.push({ key: docKey(id), kind: "doc", level, label: entry.title, parent, expanded: null, entry });
      }
    };
    for (const section of index.sections) {
      if (visible && !visible.nodes.has(section.key)) continue;
      const hasChildren = section.groups.length > 0 || section.docIds.length > 0;
      const open = hasChildren && isOpen(section.key);
      list.push({ key: section.key, kind: "node", level: 1, label: section.label, parent: null, expanded: hasChildren ? open : null, node: section });
      if (!open) continue;
      for (const groupKey of section.groups) {
        const group = index.nodes.get(groupKey);
        if (!group || (visible && !visible.nodes.has(groupKey))) continue;
        const groupOpen = group.docIds.length > 0 && isOpen(groupKey);
        list.push({
          key: groupKey,
          kind: "node",
          level: 2,
          label: group.label,
          parent: section.key,
          expanded: group.docIds.length > 0 ? groupOpen : null,
          node: group,
        });
        if (groupOpen) pushDocs(group.docIds, 3, groupKey);
      }
      pushDocs(section.docIds, 2, section.key);
    }
    return list;
    // `isOpen` reads `visible` and `expanded`, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, documents, visible, expanded]);

  const keys = items.map((item) => item.key);
  const selectedKey = doc && keys.includes(docKey(doc)) ? docKey(doc) : node;
  // The one tab stop: the item last focused, else the selected one, else the first.
  const tabStop = focusKey && keys.includes(focusKey) ? focusKey : keys.includes(selectedKey) ? selectedKey : keys[0];
  const trail = doc && documents[doc] ? new Set(ancestorsOf(index, doc)) : new Set<string>();

  // Scroll the revealed row into view once its branch is rendered.
  useEffect(() => {
    if (!reveal) return;
    const element = refs.current.get(reveal);
    if (!element) return;
    element.scrollIntoView({ block: "nearest" });
    setReveal(null);
  }, [reveal, items]);

  function focusItem(key: string | undefined) {
    if (!key) return;
    setFocusKey(key);
    refs.current.get(key)?.focus();
  }

  function toggle(key: string, open: boolean) {
    changeExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /** A click or Enter: a node opens and becomes the list; the node already shown and open closes again. */
  function activate(item: Item) {
    setFocusKey(item.key);
    if (item.kind === "doc" && item.entry) {
      onSelectDoc(item.key.slice(4));
      return;
    }
    if (item.kind === "pseudo") {
      onSelectNode(item.key);
      return;
    }
    if (item.expanded !== null && node === item.key && item.expanded && !filtering) {
      toggle(item.key, false);
      return;
    }
    if (item.expanded === false && !filtering) toggle(item.key, true);
    onSelectNode(item.key);
  }

  /** Focus moves to the next row whose name starts with the letters typed (a new letter searches after it). */
  function typeAhead(char: string, from: number) {
    const now = Date.now();
    const text = now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + char : char;
    typed.current = { text, at: now };
    const prefix = normalizeText(text);
    const start = text.length === 1 ? from + 1 : from;
    const order = [...items.slice(start), ...items.slice(0, start)];
    const hit = order.find((item) => normalizeText(item.label).startsWith(prefix));
    if (hit) focusItem(hit.key);
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const position = keys.indexOf(tabStop ?? "");
    const item = items[position];
    if (!item || event.altKey || event.ctrlKey || event.metaKey) return;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowDown":
        handled();
        focusItem(keys[Math.min(position + 1, keys.length - 1)]);
        return;
      case "ArrowUp":
        handled();
        focusItem(keys[Math.max(position - 1, 0)]);
        return;
      case "Home":
        handled();
        focusItem(keys[0]);
        return;
      case "End":
        handled();
        focusItem(keys[keys.length - 1]);
        return;
      case "ArrowRight":
        handled();
        if (item.expanded === false && !filtering) toggle(item.key, true);
        else if (item.expanded) focusItem(keys[position + 1]);
        return;
      case "ArrowLeft":
        handled();
        if (item.expanded && !filtering) toggle(item.key, false);
        else if (item.parent) focusItem(item.parent);
        return;
      case "Enter":
        handled();
        activate(item);
        return;
      default:
        if (event.key.length === 1 && event.key !== " ") {
          handled();
          typeAhead(event.key, position);
        }
    }
  }

  function collapseAll() {
    changeExpanded(() => new Set());
    setFilter("");
  }

  function row(item: Item): ReactNode {
    const nodeData = item.node;
    const entry = item.entry;
    const isNode = item.kind === "node";
    const current = item.kind !== "doc" && node === item.key;
    const classes = [
      "doc-tree__row",
      `doc-tree__row--${item.kind}`,
      current || (entry && selectedKey === item.key) ? "doc-tree__row--selected" : "",
      !current && trail.has(item.key) ? "doc-tree__row--trail" : "",
      entry?.status === "deprecated" ? "doc-tree__row--deprecated" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className={classes} onClick={() => activate(item)}>
        {isNode ? (
          item.expanded === null ? (
            <span className="doc-tree__chevron-space" />
          ) : (
            <Icon name="chevron" size={16} className={item.expanded ? "doc-tree__chevron doc-tree__chevron--open" : "doc-tree__chevron"} />
          )
        ) : null}
        {item.kind === "pseudo" ? <span className="doc-tree__chevron-space" /> : null}
        {entry ? <StatusIcon status={entry.status} /> : null}
        <span className="doc-tree__label" title={entry ? item.label : undefined}>
          <Marked text={item.label} needle={item.kind === "pseudo" ? "" : needle} />
        </span>
        {nodeData && nodeData.key !== ALL_NODE && nodeData.attention > 0 ? (
          <span className="doc-tree__attention" title="Требуют внимания">
            {nodeData.attention}
          </span>
        ) : null}
        {nodeData && nodeData.key !== ATTENTION_NODE ? <span className="doc-tree__count">{nodeData.count}</span> : null}
      </div>
    );
  }

  function treeItem(item: Item, children?: ReactNode): ReactNode {
    const entry = item.entry;
    const name =
      entry && item.kind === "doc"
        ? entry.status === "approved"
          ? item.label
          : `${item.label}, ${STATUS_LABEL[entry.status]}`
        : item.node
          ? nodeName(item.node)
          : item.label;
    return (
      <li
        key={item.key}
        id={`${idBase}-${item.key}`}
        ref={(element) => {
          if (element) refs.current.set(item.key, element);
          else refs.current.delete(item.key);
        }}
        role="treeitem"
        className="doc-tree__item"
        data-kind={item.kind}
        aria-level={item.level}
        aria-label={name}
        aria-expanded={item.expanded === null ? undefined : item.expanded}
        aria-selected={item.key === selectedKey}
        aria-current={item.kind !== "doc" && node === item.key ? "true" : undefined}
        tabIndex={item.key === tabStop ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusKey(item.key);
        }}
      >
        {row(item)}
        {children}
      </li>
    );
  }

  // The flat, ordered rows nested back for the DOM (APG: a treeitem owns the `group` of its children): a
  // section's groups come first, then the documents directly in it.
  function withChildren(item: Item): ReactNode {
    const children = item.expanded ? items.filter((child) => child.parent === item.key) : [];
    return treeItem(
      item,
      children.length > 0 ? <ul role="group" className="doc-tree__group">{children.map(withChildren)}</ul> : null,
    );
  }

  const roots = items.filter((item) => item.parent === null);
  const nothingFound = filtering && items.every((item) => item.kind === "pseudo");

  return (
    <nav className="doc-tree" aria-label="Дерево документов">
      <div className="doc-tree__tools">
        <label className="doc-tree__filter">
          <Icon name="filter" size={13} className="doc-tree__filter-icon" />
          <span className="visually-hidden">Фильтр дерева</span>
          <input
            type="search"
            value={filter}
            placeholder="Фильтр дерева"
            title="По названию и ID документа"
            maxLength={120}
            autoComplete="off"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter) {
                e.preventDefault();
                e.stopPropagation();
                setFilter("");
              }
            }}
          />
        </label>
        <IconButton icon="collapse" label="Свернуть всё" size="sm" variant="secondary" onClick={collapseAll} title="Свернуть всё" />
      </div>
      <ul role="tree" aria-label="Разделы и документы" className="doc-tree__tree" onKeyDown={onKeyDown}>
        {roots.map(withChildren)}
      </ul>
      {nothingFound ? <p className="doc-tree__empty">В дереве нет совпадений с «{filter.trim()}».</p> : null}
    </nav>
  );
}
