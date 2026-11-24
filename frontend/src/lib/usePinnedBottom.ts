import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps `--pinned-bottom` on <html> equal to the height of an element pinned to the bottom of the window (the
 * dialog's field), so `html { scroll-padding-bottom }` makes the browser scroll focused controls and anchors above
 * it instead of under it (WCAG 2.2 — 2.4.11 Focus Not Obscured). Removed again when the element unmounts.
 */
export function usePinnedBottom(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--pinned-bottom", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--pinned-bottom");
    };
  }, [ref]);
}
