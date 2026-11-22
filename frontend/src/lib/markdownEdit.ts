/** Pure Markdown editing helpers for the editor toolbar (no DOM access; easy to test). */

export type MarkdownAction = "heading" | "bullets" | "numbers" | "table" | "link" | "code";

export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const BULLET_OR_NUMBER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE = "| Колонка 1 | Колонка 2 |\n| --- | --- |\n| Значение | Значение |";

/** Expands a selection to whole lines. */
function lineRange(text: string, start: number, end: number): [number, number] {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const effectiveEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const next = text.indexOf("\n", effectiveEnd);
  return [lineStart, next === -1 ? text.length : next];
}

function prefixLines(text: string, start: number, end: number, action: "heading" | "bullets" | "numbers"): EditResult {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const markers: string[] = [];
  const transformed = lines.map((line, index) => {
    if (action === "heading") {
      markers.push("## ");
      return `## ${line.replace(/^#{1,6}\s*/, "").trim() || "Заголовок раздела"}`;
    }
    const marker = action === "bullets" ? "- " : `${index + 1}. `;
    markers.push(marker);
    return `${marker}${line.replace(BULLET_OR_NUMBER, "").trim() || "Пункт"}`;
  });
  const block = transformed.join("\n");
  const result = text.slice(0, from) + block + text.slice(to);
  // One line: select its content so the placeholder can be typed over; several lines: select the block.
  const selectionStart = lines.length === 1 ? from + (markers[0]?.length ?? 0) : from;
  return { text: result, selectionStart, selectionEnd: from + block.length };
}

/** Inserts a block on its own lines (blank line before and after, as Markdown tables and fences require). */
function insertBlock(text: string, at: number, block: string, select: [number, number]): EditResult {
  const before = text.slice(0, at);
  const after = text.slice(at);
  let lead = "";
  if (before && !before.endsWith("\n\n")) lead = before.endsWith("\n") ? "\n" : "\n\n";
  let tail = "\n\n";
  if (after.startsWith("\n\n")) tail = "";
  else if (after.startsWith("\n") || after === "") tail = "\n";
  const offset = before.length + lead.length;
  return {
    text: before + lead + block + tail + after,
    selectionStart: offset + select[0],
    selectionEnd: offset + select[1],
  };
}

export function applyMarkdown(action: MarkdownAction, text: string, start: number, end: number): EditResult {
  const from = Math.max(0, Math.min(start, end, text.length));
  const to = Math.min(Math.max(start, end), text.length);
  const selected = text.slice(from, to);
  switch (action) {
    case "heading":
    case "bullets":
    case "numbers":
      return prefixLines(text, from, to, action);
    case "table": {
      const label = "Колонка 1";
      const at = to === from ? from : lineRange(text, from, to)[1];
      return insertBlock(text, at, TABLE, [2, 2 + label.length]);
    }
    case "code": {
      const content = selected.replace(/\n$/, "") || "код";
      const block = `\`\`\`\n${content}\n\`\`\``;
      const result = insertBlock(text.slice(0, from) + text.slice(to), from, block, [4, 4 + content.length]);
      return result;
    }
    case "link": {
      const label = selected.trim() || "текст ссылки";
      const url = "https://";
      const snippet = `[${label}](${url})`;
      const urlStart = from + label.length + 3;
      return {
        text: text.slice(0, from) + snippet + text.slice(to),
        selectionStart: urlStart,
        selectionEnd: urlStart + url.length,
      };
    }
  }
}
