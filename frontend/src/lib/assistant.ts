import type { AttachmentErrorCode, AssistantSkill, Citation, SearchScope } from "../api/types";
import { AI_ERROR_TITLE, pluralRu } from "./labels";

/*
 * Shared rules of the assistant screens (docs/ui-v2/specs/02_ASSISTANT.md): where to look, the dialog id,
 * the attachment limits the composer checks before uploading (the server's answer always wins), the error
 * titles of the ask endpoints and how citation markers are numbered per evidence group.
 */

/** Where the AI looks: team documents unless the user picks otherwise. */
export type AskScope = "team" | "corporate" | "both";

export const SCOPE_OPTIONS: { value: AskScope; label: string; sources: SearchScope[] }[] = [
  { value: "team", label: "Команда", sources: ["team"] },
  { value: "corporate", label: "Корпоративные", sources: ["corporate"] },
  { value: "both", label: "Оба", sources: ["team", "corporate"] },
];

export function scopeSources(scope: AskScope): SearchScope[] {
  return SCOPE_OPTIONS.find((option) => option.value === scope)?.sources ?? ["team"];
}

export function scopeLabel(scope: AskScope): string {
  return SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? "Команда";
}

/** `?scope=` of the ask page: team by default; corporate only when the user chose it. */
export function scopeFromParam(value: string | null): AskScope {
  return SCOPE_OPTIONS.some((option) => option.value === value) ? (value as AskScope) : "team";
}

/** The scope a request was made in (`sources` back to the switch). */
export function scopeOfSources(sources: SearchScope[]): AskScope {
  if (sources.includes("team") && sources.includes("corporate")) return "both";
  return sources.includes("corporate") ? "corporate" : "team";
}

/** The answer screen for a question (it asks at once: `run=1`); the team scope is the default. */
export function askHref(question: string, scope: AskScope = "team"): string {
  const params = new URLSearchParams({ q: question, run: "1" });
  if (scope !== "team") params.set("scope", scope);
  return `/ask?${params.toString()}`;
}

/** Backend `CONVERSATION_ID_PATTERN`: `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`. */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** A new dialog id: «conv-» + 24 random hex digits (getRandomValues also works outside secure contexts). */
export function newConversationId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `conv-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// --- attachments (docs/API_CONTRACTS.md v0.4; the server checks everything again) ---

export const ATTACHMENT_MAX_FILES = 10;
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_EXTENSIONS = ["md", "markdown", "txt", "csv", "json", "yaml", "yml", "sql", "pdf", "docx", "xlsx"];
/** For the file picker: the same list as `accept`. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`).join(",");

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What the composer can tell before uploading; null means «send it and let the server decide». */
export function precheckFile(file: { name: string; size: number }, filesInDialog: number): AttachmentErrorCode | null {
  if (!ATTACHMENT_EXTENSIONS.includes(extensionOf(file.name))) return "unsupported_type";
  if (file.size > ATTACHMENT_MAX_BYTES) return "too_large";
  if (filesInDialog >= ATTACHMENT_MAX_FILES) return "limit_reached";
  return null;
}

export const ATTACHMENT_ERROR_TEXT: Record<AttachmentErrorCode, string> = {
  unsupported_type: "формат не поддерживается",
  too_large: "больше 20 МБ",
  limit_reached: `не больше ${ATTACHMENT_MAX_FILES} файлов в диалоге`,
  unreadable: "не удалось прочитать",
};

const sizeFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** «820 Б», «48 КБ», «1,4 МБ». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(Math.max(1, Math.round(bytes / 1024)))} КБ`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} МБ`;
}

/** «2 файла, 1,4 МБ» (the size only when the browser reports it). */
export function filesSummary(count: number, bytes: number | null): string {
  const files = `${count} ${pluralRu(count, "файл", "файла", "файлов")}`;
  return bytes === null ? files : `${files}, ${formatBytes(bytes)}`;
}

// --- skills ---

/** The four quick skills under the home composer, in this order (only those the registry offers as available). */
export const QUICK_SKILL_IDS = ["draft_document", "check_freshness", "find_related", "compare_with_file"];

export const SKILL_ACCESS_LABEL: Record<AssistantSkill["access"], string> = {
  read: "чтение",
  draft: "создаёт черновик",
};

export type SkillInput = "document" | "selection" | "attachment" | "document_or_question" | "project";

/** A question shorter than this is no question (the server's rule for `ask` and «документ или вопрос»). */
export const MIN_QUESTION_CHARS = 3;

/** What a chosen skill still needs before it can run (the registry's `requires`, as the server checks it). */
export function missingInput(
  skill: AssistantSkill | null,
  context: { documents: number; selection: boolean; attachments: number; question?: string; project?: boolean },
): SkillInput | null {
  if (!skill) return null;
  if (skill.requires.project && !context.project) return "project";
  const document = context.documents > 0 || context.selection;
  if (skill.requires.selection && !context.selection) return "selection";
  if (skill.requires.document && !document) return "document";
  if (skill.requires.attachment && context.attachments === 0) return "attachment";
  const question = (context.question ?? "").trim().length >= MIN_QUESTION_CHARS;
  if (skill.requires.document_or_question && !document && !question) return "document_or_question";
  return null;
}

export const MISSING_INPUT_HINT: Record<SkillInput, string> = {
  document: "нужен документ: кнопка «Документ» или @ в тексте",
  selection: "нужен выделенный фрагмент документа",
  attachment: "нужен файл: кнопка «Файл» или перетащите его в поле",
  document_or_question: "нужен документ или вопрос: кнопка «Документ», @ в тексте или напишите вопрос",
  project: "нужен проект: выберите его в поле «Проект» под сообщением",
};

/** Titles of the ask errors (v0.3 provider errors plus the v0.4 skill and attachment checks). */
export const ASK_ERROR_TITLE: Record<string, string> = {
  ...AI_ERROR_TITLE,
  assistant_disabled: "Ассистент отключён",
  skill_unknown: "Навык не найден",
  skill_unavailable: "Навык недоступен в этом режиме",
  skill_input_missing: "Навыку не хватает данных",
  attachment_not_found: "Файл больше недоступен",
  selection_not_found: "Выделенный текст не найден в документе",
  document_not_found: "Документ не найден",
  // M7 chat work skills
  work_project_required: "Выберите проект",
  work_context_invalid: "Предложение не относится к этому навыку",
  work_tasks_required: "Укажите задачи",
  work_unavailable: "Данные задач недоступны",
  proposal_stale: "Предложение устарело — подготовьте заново",
  proposal_invalid: "Предложение не принято сервером",
  feature_unavailable: "Недоступно",
  forbidden: "Нет прав",
  not_found: "Не найдено",
};

/** Ask errors that are a conflict with the current state rather than a failure: the request can be repeated later. */
export function isConflict(code: string, status: number): boolean {
  return status === 409 || code === "ai_busy";
}

// --- citations: three groups that are never mixed ---

export type CitationGroup = "team" | "corporate" | "attachment";

export function citationGroup(citation: Citation): CitationGroup {
  if (citation.source_type === "attachment") return "attachment";
  if (citation.source_kind === "confluence_mcp" || citation.source_type === "confluence") return "corporate";
  return "team";
}

const GROUP_PREFIX: Record<CitationGroup, string> = { team: "", corporate: "К", attachment: "Ф" };

/**
 * Marker labels by group: team documents 1, 2…, corporate pages К1, К2…, attachments Ф1, Ф2… — in the order the
 * server numbered them (`ref`). The label says where a quote comes from; `[n]` in the text still means `ref` n.
 */
export function citationLabels(citations: Citation[]): Map<number, string> {
  const counters: Record<CitationGroup, number> = { team: 0, corporate: 0, attachment: 0 };
  const labels = new Map<number, string>();
  for (const citation of [...citations].sort((a, b) => a.ref - b.ref)) {
    const group = citationGroup(citation);
    counters[group] += 1;
    labels.set(citation.ref, `${GROUP_PREFIX[group]}${counters[group]}`);
  }
  return labels;
}
