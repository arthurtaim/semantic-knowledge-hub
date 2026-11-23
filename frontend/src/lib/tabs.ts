import type { KeyboardEvent } from "react";

/**
 * Keyboard of a `role="tablist"` (WAI-ARIA APG, automatic activation): ←/→ move to the previous/next tab
 * (wrapping), Home/End to the first/last; the focused tab is activated by a click. Use with a roving tabindex:
 * the selected tab `tabIndex={0}`, the others `-1`.
 */
export function onTabListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'));
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  if (current < 0 || tabs.length === 0) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (current + 1) % tabs.length;
      break;
    case "ArrowLeft":
      next = (current - 1 + tabs.length) % tabs.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}
