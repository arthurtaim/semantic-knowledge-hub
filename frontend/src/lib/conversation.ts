/**
 * The assistant's state kept in MEMORY while the app is open, so following a citation to its document and
 * coming back does not lose the dialog. Never persisted: a reload or «Новый диалог» clears it.
 *
 * - the dialog's turns (`saveConversation` / `restoreConversation`);
 * - each composer's draft and dialog id (`saveDraft` / `restoreDraft`, by key: the home field, the dialog);
 * - a message sent from the home page, handed to the dialog that runs it (`handOff` / `peekHandOff`).
 */
let saved: unknown[] = [];
const drafts = new Map<string, unknown>();
let pending: unknown = null;

export function saveConversation<T>(turns: T[]): void {
  saved = turns;
}

export function restoreConversation<T>(): T[] {
  return saved as T[];
}

export function saveDraft<T>(key: string, draft: T): void {
  drafts.set(key, draft);
}

export function restoreDraft<T>(key: string): T | null {
  return (drafts.get(key) as T | undefined) ?? null;
}

export function forgetDraft(key: string): void {
  drafts.delete(key);
}

/** The home page sends a message: the dialog page picks it up and runs it as the start of a new dialog. */
export function handOff<T>(message: T): void {
  pending = message;
}

/** Reads the handed-off message without taking it (React may run an initializer twice). */
export function peekHandOff<T>(): T | null {
  return pending as T | null;
}

export function clearHandOff(): void {
  pending = null;
}

export function clearConversation(): void {
  saved = [];
  drafts.clear();
  pending = null;
}
