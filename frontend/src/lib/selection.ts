import { pluralRu } from "./labels";

/*
 * A fragment the reader selected in a document's text (docs/ui-v2/specs/03_SCREENS.md §3): what the assistant
 * receives as `selection: {document_id, section_anchor, text}`. The text is the selection exactly as the browser
 * reports it; the server checks that it really is in that section and answers `selection_not_found` otherwise.
 */

/** AskSelection.text limit of the API (characters). */
export const MAX_SELECTION_CHARS = 8000;

export interface CapturedSelection {
  /** The selected text as the browser reports it (cut to the API limit). */
  text: string;
  /** Anchor of the nearest heading at or before the start of the selection (`DocumentDetail.sections[].anchor`). */
  sectionAnchor: string | null;
  /** Non-empty lines of the text («Выделение: 2 строки»). */
  lines: number;
  /** The text was longer than the API accepts and was cut. */
  truncated: boolean;
  /** A copy of the range (to keep the fragment marked while the assistant works on it). */
  range: Range;
}

const HEADINGS = "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]";

/** The heading the node belongs to: the last heading that contains it or comes before it in `container`. */
export function nearestHeadingAnchor(container: Element, node: Node): string | null {
  let anchor: string | null = null;
  for (const heading of Array.from(container.querySelectorAll<HTMLElement>(HEADINGS))) {
    const before = heading === node || heading.contains(node) || Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!before) break;
    anchor = heading.id || anchor;
  }
  return anchor;
}

export function countLines(text: string): number {
  return Math.max(1, text.split("\n").filter((line) => line.trim().length > 0).length);
}

/** «Выделение: 1 строка», «Выделение: 3 строки» (plus a note when the text was cut to the API limit). */
export function selectionLabel(selection: Pick<CapturedSelection, "lines" | "truncated">): string {
  const n = selection.lines;
  const label = `Выделение: ${n} ${pluralRu(n, "строка", "строки", "строк")}`;
  return selection.truncated ? `${label} (первые ${MAX_SELECTION_CHARS} знаков)` : label;
}

/**
 * The current selection if it lies entirely inside `container` and has visible text; null for a caret, blanks,
 * a selection elsewhere on the page or one that crosses the container's edge.
 */
export function captureSelection(container: Element | null, selection: Selection | null = window.getSelection()): CapturedSelection | null {
  if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  const full = selection.toString();
  if (full.trim().length === 0) return null;
  const truncated = full.length > MAX_SELECTION_CHARS;
  const text = truncated ? full.slice(0, MAX_SELECTION_CHARS) : full;
  return {
    text,
    sectionAnchor: nearestHeadingAnchor(container, range.startContainer),
    lines: countLines(text),
    truncated,
    range: range.cloneRange(),
  };
}

/** Same fragment, same place: an Esc-dismissed toolbar does not come back for it. */
export function selectionKey(selection: CapturedSelection): string {
  return `${selection.sectionAnchor ?? ""}\u0000${selection.text}`;
}

// --- a mark that stays on the fragment while the assistant panel works on it (CSS Custom Highlight API) ---

const HIGHLIGHT = "skh-doc-selection";

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

function registry(): { highlights: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null;
}

/** Marks the range (where the browser supports highlights; otherwise the chip alone says what was selected). */
export function markSelection(range: Range): void {
  const api = registry();
  if (api) api.highlights.set(HIGHLIGHT, new api.Highlight(range));
}

export function clearSelectionMark(): void {
  registry()?.highlights.delete(HIGHLIGHT);
}
