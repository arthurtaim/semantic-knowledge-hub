/** Pure helpers of the `[[` autocomplete in the Markdown editor (no DOM access; easy to test). */

/** Longest query the popup reacts to; beyond it the author is clearly not typing a link. */
export const MAX_WIKI_QUERY = 80;

export interface WikiQuery {
  /** Offset of the opening `[[`. */
  start: number;
  /** Text typed after `[[` up to the caret. */
  query: string;
}

/**
 * The WikiLink being typed at `caret`: an unclosed `[[` on the same line, with no `]`, `[` or `|` between it
 * and the caret. Inside inline code (an odd number of backticks before it on the line) it is not a link.
 */
export function findWikiQuery(text: string, caret: number): WikiQuery | null {
  if (caret < 2 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  const open = line.lastIndexOf("[[");
  if (open === -1) return null;
  const query = line.slice(open + 2);
  if (query.length > MAX_WIKI_QUERY || /[[\]|]/.test(query)) return null;
  const before = line.slice(0, open);
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  if (before.endsWith("\\")) return null; // an escaped literal `\[[`
  if (/^\s*(```|~~~)/.test(text.slice(lineStart))) return null;
  if (insideFence(text, lineStart)) return null;
  return { start: lineStart + open, query };
}

/** True when the line starting at `lineStart` is inside a fenced code block. */
function insideFence(text: string, lineStart: number): boolean {
  let open = false;
  for (const line of text.slice(0, lineStart).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) open = !open;
  }
  return open;
}

/** The range the chosen suggestion replaces: `[[query` (and a `]]` right after the caret, if any). */
export function replacementRange(text: string, wiki: WikiQuery, caret: number): [number, number] {
  const end = text.startsWith("]]", caret) ? caret + 2 : caret;
  return [wiki.start, end];
}

/** Text after inserting `insert` over [from, to); the caret goes right after the insert. */
export function insertAt(text: string, from: number, to: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length };
}

/** `## Heading` lines of a Markdown body (sections for «Улучшить раздел»), outside fenced code. */
export function sectionHeadings(body: string): string[] {
  const result: string[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const match = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) result.push(match[1].trim());
  }
  return [...new Set(result)];
}
