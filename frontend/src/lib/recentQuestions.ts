/**
 * The user's recent questions for the home page. A per-viewer convenience: kept only in this browser
 * (localStorage, per user id), never sent anywhere, at most RECENT_LIMIT entries; answers are not stored.
 * Storage can be unavailable (private mode, policy): every access is guarded and the UI works without it.
 */
const RECENT_LIMIT = 5;
const MAX_LENGTH = 300;

function key(userId: string): string {
  return `skh.recent-questions.v1:${userId}`;
}

export function readRecentQuestions(userId: string | null | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(key(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberQuestion(userId: string | null | undefined, question: string): void {
  const text = question.trim().slice(0, MAX_LENGTH);
  if (!userId || text.length < 3) return;
  try {
    const next = [text, ...readRecentQuestions(userId).filter((q) => q !== text)].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Storage unavailable: nothing to remember, nothing breaks.
  }
}

export function clearRecentQuestions(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(key(userId));
  } catch {
    // ignore
  }
}
