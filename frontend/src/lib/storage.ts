/**
 * Per-browser preferences (theme, sidebar). Storage may be unavailable (private mode, blocked site data, a
 * policy): every access is wrapped and falls back to the default, so the interface never depends on it.
 */
export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the choice still applies until the page is reloaded.
  }
}
