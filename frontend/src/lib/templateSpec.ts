import type { StudioIssue, TemplateSectionSpec, TemplateSpec } from "../api/types";

/*
 * Template Studio: the section builder and the Markdown editor are two views of ONE structure (`spec.sections`).
 * The rules mirror the backend (backend/app/domain/template_studio.py), so what the editor shows is what the server
 * stores:
 * - a section is `## Title`, then optionally `> Требует уточнения: hint`, then free content;
 * - a section with neither hint nor content gets the bare placeholder `> Требует уточнения`;
 * - text before the first `## ` (and any `# ` heading) cannot be mapped — the editor says so and keeps the last
 *   mapped structure;
 * - Markdown cannot say «необязательный»: a section keeps its flag by title, a new one is required.
 */

export const PLACEHOLDER = "Требует уточнения";
const SECTION_LINE = /^##\s+(.+?)\s*$/;
const H1_LINE = /^#\s+\S/;
const HINT_LINE = new RegExp(`^> ${PLACEHOLDER}:\\s?(.*)$`);
const BARE_PLACEHOLDER = new RegExp(`^> ${PLACEHOLDER}:?\\s*$`);

const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
const blank = (line: string | undefined) => line === undefined || line.trim() === "";

function toSection(title: string, input: string[]): TemplateSectionSpec {
  let lines = [...input];
  while (lines.length > 0 && blank(lines[0])) lines.shift();
  while (lines.length > 0 && blank(lines[lines.length - 1])) lines.pop();
  let hint = "";
  const first = lines[0];
  if (first !== undefined) {
    const match = HINT_LINE.exec(first);
    if (match && (match[1] ?? "").trim()) {
      hint = (match[1] ?? "").trim();
      lines = lines.slice(1);
      while (lines.length > 0 && blank(lines[0])) lines.shift();
    } else if (lines.length === 1 && BARE_PLACEHOLDER.test(first)) {
      lines = [];
    }
  }
  return { title, required: true, hint, content: lines.join("\n") };
}

export interface ParsedBody {
  sections: TemplateSectionSpec[];
  /** Why the text cannot be shown in the builder exactly (empty = it can). */
  problems: string[];
}

export function parseBody(body: string): ParsedBody {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const sections: TemplateSectionSpec[] = [];
  const preamble: string[] = [];
  let title: string | null = null;
  let current: string[] = [];
  for (const line of lines) {
    const match = SECTION_LINE.exec(line);
    if (match) {
      if (title !== null) sections.push(toSection(title, current));
      title = match[1] ?? "";
      current = [];
    } else if (title === null) {
      if (line.trim()) preamble.push(line);
    } else {
      current.push(line);
    }
  }
  if (title !== null) sections.push(toSection(title, current));
  const problems: string[] = [];
  if (preamble.some((line) => H1_LINE.test(line))) {
    problems.push("Заголовок первого уровня «# …» в шаблоне не нужен: документ получает его из названия.");
  } else if (preamble.length > 0) {
    problems.push("Текст до первого раздела «## …» не относится ни к одному разделу — перенесите его в раздел.");
  }
  if (sections.length === 0 && preamble.length === 0) problems.push("В Markdown нет ни одного раздела «## …».");
  return { sections, problems };
}

export function renderBody(sections: TemplateSectionSpec[]): string {
  const blocks = sections.map((section) => {
    const lines = [`## ${section.title.trim()}`];
    const hint = squash(section.hint);
    const content = section.content
      .replace(/\r\n?/g, "\n")
      .replace(/^\n+|\n+$/g, "")
      .replace(/\s+$/, "");
    if (hint) lines.push(`> ${PLACEHOLDER}: ${hint}`);
    if (content) {
      if (hint) lines.push("");
      lines.push(content);
    } else if (!hint) {
      lines.push(`> ${PLACEHOLDER}`);
    }
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

/** Markdown → sections, keeping the required/optional flag of a section with the same title (case-insensitive). */
export function sectionsFromMarkdown(text: string, previous: TemplateSectionSpec[]): ParsedBody {
  const parsed = parseBody(text);
  const flags = new Map(previous.map((s) => [s.title.trim().toLocaleLowerCase("ru"), s.required]));
  return {
    problems: parsed.problems,
    sections: parsed.sections.map((s) => ({ ...s, required: flags.get(s.title.trim().toLocaleLowerCase("ru")) ?? true })),
  };
}

export function emptySection(): TemplateSectionSpec {
  return { title: "", required: true, hint: "", content: "" };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** «a, b, c» ↔ ["a", "b", "c"] for labels and tags. */
export function listToText(values: string[]): string {
  return values.join(", ");
}

export function textToList(text: string): string[] {
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function sameSpec(a: TemplateSpec | null, b: TemplateSpec | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Issues of exactly this field (`title`, `sections.2.title`). */
export function issuesFor(issues: StudioIssue[] | undefined, field: string): StudioIssue[] {
  return (issues ?? []).filter((i) => i.field === field);
}

/** Issues of a field and everything under it (`sections` → `sections`, `sections.0.title`…). */
export function issuesUnder(issues: StudioIssue[] | undefined, field: string): StudioIssue[] {
  return (issues ?? []).filter((i) => i.field === field || i.field.startsWith(`${field}.`));
}

export type StudioTab = "properties" | "structure" | "markdown" | "preview" | "history";

/** The editor tab where a field lives (to take the person to an error). */
export function tabOfField(field: string): StudioTab {
  if (field.startsWith("sections")) return "structure";
  if (field === "source") return "markdown";
  return "properties";
}

/** The DOM id of a field's control (the summary links to it). */
export function controlId(field: string): string {
  return `tpl-${field.replace(/\./g, "-")}`;
}
