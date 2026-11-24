/**
 * The ask page's conversation kept in MEMORY while the app is open, so following a citation to its document
 * and coming back does not lose the answers. Never persisted: a reload or «Новый диалог» clears it.
 */
let saved: unknown[] = [];

export function saveConversation<T>(turns: T[]): void {
  saved = turns;
}

export function restoreConversation<T>(): T[] {
  return saved as T[];
}

export function clearConversation(): void {
  saved = [];
}
