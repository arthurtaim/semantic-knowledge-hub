import type { FootnoteDefinition, Nodes, Parent, PhrasingContent, Root, RootContent, Text } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type PluggableList, type Processor } from "unified";

/*
 * The one Markdown pipeline of an assistant answer (react-markdown + remark-gfm; components/AnswerMarkdown.tsx
 * renders it, `answerPlainText` copies it). The answer is UNTRUSTED model text even after validation: the server
 * verified its citations, not its prose. Hence:
 * - raw HTML is never interpreted: react-markdown turns it into literal text (no `skipHtml`, no rehype-raw);
 * - links keep only http(s), mailto and app paths (`safeHref`); images are never loaded;
 * - link reference definitions are switched off, so `[1]: https://…` can never turn the marker `[1]` into a link;
 * - markers become reference nodes only in TEXT nodes (never in inline/fenced code, link text, URLs or titles) and
 *   only for references the server verified (`KnownRefs`); anything else stays literal text.
 */

/**
 * Markers of a validated answer: `[n]` is citation `ref` n (the server rewrites the model's `[Cn]` and drops the
 * unverified ones), `[Fn]` a system fact (backend `_MARKER_RE` / `_FACT_RE`). The optional blank before a marker
 * belongs to it (the pill has its own margin), a line break never does.
 */
const MARKER_RE = /([^\S\r\n]?)\[(\d{1,3}|F\d{1,3})\]/g;
const LINE_BREAK_RE = /\r\n|\r|\n/;

export type MarkerKind = "citation" | "fact";

/** References the server verified for this answer. `null` — none: preliminary (streamed) text. */
export interface KnownRefs {
  citations: ReadonlySet<number>;
  facts: ReadonlySet<string>;
}

/** The hast properties of a marker node (`<span data-skh-marker data-skh-ref>` until a component replaces it). */
export interface MarkerProps {
  dataSkhMarker: MarkerKind;
  dataSkhRef: string;
}

function markerOf(node: Text): MarkerProps | null {
  const props = node.data?.hProperties as Partial<MarkerProps> | undefined;
  return props?.dataSkhMarker && props.dataSkhRef ? { dataSkhMarker: props.dataSkhMarker, dataSkhRef: props.dataSkhRef } : null;
}

/** Text with its soft line breaks as `break` nodes: the answer's lines stay lines, as the model wrote them. */
function withBreaks(value: string, out: PhrasingContent[]) {
  value.split(LINE_BREAK_RE).forEach((line, index) => {
    if (index > 0) out.push({ type: "break" });
    if (line) out.push({ type: "text", value: line });
  });
}

/** One text node → text, breaks and marker nodes (only verified references become markers). */
function splitText(value: string, known: KnownRefs | null): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let last = 0;
  if (known) {
    for (const match of value.matchAll(MARKER_RE)) {
      const ref = match[2] ?? "";
      const kind: MarkerKind = ref.startsWith("F") ? "fact" : "citation";
      const verified = kind === "fact" ? known.facts.has(ref) : known.citations.has(Number(ref));
      if (!verified) continue;
      const index = match.index ?? 0;
      withBreaks(value.slice(last, index), out);
      const props: MarkerProps = { dataSkhMarker: kind, dataSkhRef: ref };
      out.push({ type: "text", value: match[0], data: { hName: "span", hProperties: { ...props } } });
      last = index + match[0].length;
    }
  }
  withBreaks(value.slice(last), out);
  return out;
}

/** A GFM footnote would add document-wide ids and back-links to the page: kept as the literal text it was. */
function footnoteAsText(node: FootnoteDefinition): RootContent[] {
  const label = `[^${node.label ?? node.identifier}]: `;
  const [first, ...rest] = node.children;
  if (first?.type === "paragraph") return [{ ...first, children: [{ type: "text", value: label }, ...first.children] }, ...rest];
  return [{ type: "paragraph", children: [{ type: "text", value: label.trimEnd() }] }, ...node.children];
}

function transform(parent: Parent, known: KnownRefs | null) {
  const children = parent.children;
  let index = 0;
  while (index < children.length) {
    const child = children[index] as RootContent;
    if (child.type === "text") {
      if (markerOf(child)) {
        index += 1;
        continue;
      }
      const parts = splitText(child.value, known);
      children.splice(index, 1, ...parts);
      index += parts.length;
    } else if (child.type === "footnoteReference") {
      children.splice(index, 1, { type: "text", value: `[^${child.label ?? child.identifier}]` });
      index += 1;
    } else if (child.type === "footnoteDefinition") {
      children.splice(index, 1, ...footnoteAsText(child)); // the replacement is visited next
    } else if (child.type === "link" || child.type === "linkReference") {
      // No markers inside link text: a link inside a link is not a thing; its line breaks are kept.
      transform(child, null);
      index += 1;
    } else {
      if ("children" in child) transform(child, known);
      index += 1;
    }
  }
}

interface AnswerPluginOptions {
  known: KnownRefs | null;
}

/** remark plugin: no link reference definitions; markers, line breaks and footnotes as described above. */
function remarkAnswer(this: Processor, options: AnswerPluginOptions) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ disable: { null: ["definition"] } });
  return (tree: Root) => transform(tree, options.known);
}

/** remark plugins of an answer; `singleTilde: false` — «~100 документов» is not strikethrough. */
export function answerRemarkPlugins(known: KnownRefs | null): PluggableList {
  return [
    [remarkGfm, { singleTilde: false }],
    [remarkAnswer, { known }],
  ];
}

/**
 * Where a link of model text may lead: http(s) and mailto as absolute URLs, or a path of this app (`/documents/…`;
 * never `//host` or `/\host`, which browsers read as another host). Anything else — `javascript:`, `data:`,
 * `vbscript:`, relative paths, fragments — is null: the link text is shown without a link.
 */
export function safeHref(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  if (!value || /\p{Cc}|\s/u.test(value)) return null;
  if (/^\/(?![/\\])/.test(value)) return value;
  if (!/^(?:https?|mailto):/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

// --- plain text («Копировать с источниками») from the same tree ---

export interface PlainLabels {
  /** `[n]` → «1», «К1», «Ф1». */
  citation: (ref: number) => string | undefined;
  /** `[F1]` → «С1». */
  fact: (ref: string) => string | undefined;
}

function inline(nodes: Nodes[], labels: PlainLabels): string {
  return nodes.map((node) => plain(node, labels)).join("");
}

function indent(text: string, prefix: string): string {
  const pad = " ".repeat(prefix.length);
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? prefix + line : line ? pad + line : line))
    .join("\n");
}

function plain(node: Nodes, labels: PlainLabels): string {
  switch (node.type) {
    case "root":
    case "blockquote":
    case "listItem": {
      const text = node.children.map((child) => plain(child, labels)).join(node.type === "listItem" ? "\n" : "\n\n");
      if (node.type === "blockquote") return text.replace(/^/gm, "> ");
      if (node.type === "listItem" && typeof node.checked === "boolean") return `[${node.checked ? "x" : " "}] ${text}`;
      return text;
    }
    case "list": {
      const start = node.start ?? 1;
      return node.children.map((item, i) => indent(plain(item, labels), node.ordered ? `${start + i}. ` : "- ")).join("\n");
    }
    case "table":
      return node.children.map((row) => row.children.map((cell) => inline(cell.children, labels).trim()).join(" | ")).join("\n");
    case "code":
    case "html":
    case "inlineCode":
      return node.value;
    case "thematicBreak":
      return "—";
    case "break":
      return "\n";
    case "text": {
      const marker = markerOf(node);
      if (!marker) return node.value;
      const label = marker.dataSkhMarker === "fact" ? labels.fact(marker.dataSkhRef) : labels.citation(Number(marker.dataSkhRef));
      const blank = node.value.startsWith("[") ? "" : (node.value[0] ?? "");
      return label ? `${blank}[${label}]` : node.value;
    }
    case "image":
      return node.alt ?? "";
    case "link": {
      const text = inline(node.children, labels);
      const href = safeHref(node.url);
      return href && href !== text ? `${text} (${href})` : text;
    }
    default:
      return "children" in node ? inline(node.children, labels) : "";
  }
}

/**
 * The answer as readable plain text — what the reader sees, without Markdown syntax: lines, «- » and «1. » items,
 * table rows «a | b», code as it is. Verified markers carry the labels of the screen; unknown ones stay as written.
 */
export function answerPlainText(markdown: string, known: KnownRefs, labels: PlainLabels): string {
  const processor = unified().use(remarkParse).use(answerRemarkPlugins(known));
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  return plain(tree, labels).trim();
}
