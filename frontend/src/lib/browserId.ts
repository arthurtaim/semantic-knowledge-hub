/**
 * The per-browser id of the assistant's chat history (`X-SKH-Browser`, docs/API_CONTRACTS.md v0.7): 128 random bits
 * as 32 hex digits, generated once and kept in localStorage. The server keys conversations by the user AND this id,
 * so one shared login does not show every browser's dialogs. A convenience scope, not authentication: anyone who
 * can read this browser's storage has it. Without storage (private mode, a policy) the id lives for this page load
 * only — the history then lasts until a reload.
 */
const KEY = "skh.browser-id.v1";
const PATTERN = /^[0-9a-f]{32}$/;

let current: string | null = null;

function generate(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function browserId(): string {
  if (current) return current;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(KEY);
  } catch {
    stored = null;
  }
  if (stored && PATTERN.test(stored)) {
    current = stored;
    return stored;
  }
  const id = generate();
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // Not kept: this page load only.
  }
  current = id;
  return id;
}

/** Tests: forget the cached id (the next call reads the storage again). */
export function resetBrowserId(): void {
  current = null;
}
