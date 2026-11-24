/**
 * The user's recent dialogs for the home page («Недавние диалоги»). A per-viewer convenience: kept only in this
 * browser (localStorage, per user id), never sent anywhere, at most RECENT_LIMIT entries; answers and file
 * contents are never stored — only the question, the skill's name, the name of an attached file or a chosen
 * document, the number of sources of the answer and the time. Storage can be unavailable (private mode,
 * policy): every access is guarded and the UI works without it.
 */
const RECENT_LIMIT = 5;
const MAX_LENGTH = 300;
const MAX_NAME = 160;

export interface RecentDialog {
  /** The question as asked; "" when a skill ran without one. */
  question: string;
  /** ISO time of the question. */
  at: string | null;
  /** The skill's name («Сравнить с файлом»); null for a plain answer. */
  skill: string | null;
  /** Number of verified sources of the answer, once it arrived. */
  sources: number | null;
  /** The first attached file's name, or a chosen document's title. */
  context: string | null;
}

function key(userId: string): string {
  return `skh.recent-questions.v1:${userId}`;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** v1 stored plain questions; later entries are objects. Anything else is skipped. */
function parse(entry: unknown): RecentDialog | null {
  if (typeof entry === "string") return entry.trim() ? { question: entry, at: null, skill: null, sources: null, context: null } : null;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.slice(0, MAX_LENGTH) : "";
  const skill = text(record.skill, MAX_NAME);
  if (!question && !skill) return null;
  return {
    question,
    at: text(record.at, 40),
    skill,
    sources: typeof record.sources === "number" && record.sources >= 0 ? Math.floor(record.sources) : null,
    context: text(record.context, MAX_NAME),
  };
}

export function readRecentDialogs(userId: string | null | undefined): RecentDialog[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(key(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parse).filter((entry): entry is RecentDialog => entry !== null).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function write(userId: string, entries: RecentDialog[]): void {
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(entries.slice(0, RECENT_LIMIT)));
  } catch {
    // Storage unavailable: nothing to remember, nothing breaks.
  }
}

const sameDialog = (a: RecentDialog, b: RecentDialog) => a.question === b.question && a.skill === b.skill;

/** Remembers a question (or a skill run) as the newest entry; an earlier identical entry moves up. */
export function rememberDialog(
  userId: string | null | undefined,
  entry: { question: string; skill?: string | null; context?: string | null; at?: string },
): void {
  const question = entry.question.trim().slice(0, MAX_LENGTH);
  const skill = entry.skill?.trim().slice(0, MAX_NAME) || null;
  if (!userId || (question.length < 3 && !skill)) return;
  const next: RecentDialog = {
    question,
    at: entry.at ?? new Date().toISOString(),
    skill,
    sources: null,
    context: entry.context?.trim().slice(0, MAX_NAME) || null,
  };
  write(userId, [next, ...readRecentDialogs(userId).filter((item) => !sameDialog(item, next))]);
}

/** Adds the number of sources once the answer arrived (to the newest matching entry). */
export function noteDialogSources(userId: string | null | undefined, question: string, skill: string | null, sources: number): void {
  if (!userId) return;
  const items = readRecentDialogs(userId);
  const probe: RecentDialog = { question: question.trim().slice(0, MAX_LENGTH), at: null, skill, sources: null, context: null };
  const index = items.findIndex((item) => sameDialog(item, probe));
  if (index < 0) return;
  items[index] = { ...(items[index] as RecentDialog), sources };
  write(userId, items);
}

export function clearRecentQuestions(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(key(userId));
  } catch {
    // ignore
  }
}
