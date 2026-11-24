import { useCallback, useSyncExternalStore } from "react";

const hasMatchMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * Whether a CSS media query matches, kept in sync with resizes. Without `matchMedia` (jsdom, old browsers)
 * it reports `false`, i.e. the wide layout.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => hasMatchMedia() && window.matchMedia(query).matches,
    () => false,
  );
}
