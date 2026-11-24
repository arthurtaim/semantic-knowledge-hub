/** The YAML front matter block at the very start of a Markdown file, delimiters and following blank lines included. */
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;

export interface SplitDocument {
  /** The front matter exactly as written (both `---` lines and the blank lines after them), or "". */
  frontMatter: string;
  body: string;
}

/** Splits a document so that `frontMatter + body === raw` always holds (nothing is re-serialised). */
export function splitFrontMatter(raw: string): SplitDocument {
  const match = FRONT_MATTER.exec(raw);
  if (!match) return { frontMatter: "", body: raw };
  return { frontMatter: match[0], body: raw.slice(match[0].length) };
}

const FIELD_LABEL: Record<string, string> = {
  id: "ID",
  title: "Название",
  type: "Тип",
  status: "Статус",
  owner: "Владелец",
  version: "Версия",
  tags: "Теги",
  updated_at: "Обновлён",
  reviewed_at: "Проверен",
  template: "Шаблон",
  template_version: "Версия шаблона",
};

export interface FrontMatterField {
  key: string;
  label: string;
  value: string;
}

/**
 * Top-level scalar fields of the front matter for a READ-ONLY summary (no YAML parser: nested values and
 * multi-line blocks are counted, not interpreted). The text itself is never rewritten.
 */
export function frontMatterSummary(frontMatter: string): { fields: FrontMatterField[]; other: number } {
  const fields: FrontMatterField[] = [];
  let other = 0;
  for (const line of frontMatter.split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (FIELD_LABEL[key] && value && value !== "|" && value !== ">") {
      fields.push({ key, label: FIELD_LABEL[key], value });
    } else {
      other += 1;
    }
  }
  return { fields, other };
}
