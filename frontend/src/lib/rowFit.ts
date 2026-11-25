import { useLayoutEffect, useRef, useState } from "react";

/*
 * A toolbar row of two groups — the filters at the start, a view's controls at the end — that must stay ONE line
 * (Planner v2 §2.4, §3.9: a second line eats the height the compact frame freed). When the controls' full form does
 * not fit, the page draws their compact form (the Gantt: the zoom as a menu, «Вписать» and «Сегодня» as icons).
 *
 * The decision follows the width of the row itself, not of the window: a collapsed sidebar or a docked task panel
 * changes the room, a media query would not notice. The controls' full width is measured while they are drawn full
 * and remembered, so the decision compares the same full widths whatever form is on the screen — no flicker between
 * the two forms at the threshold.
 */

export interface RowFit {
  /** The row's inner width (without its padding). */
  available: number;
  /** The natural widths of the start group's items (the filters, the chips of chosen filters). */
  start: number[];
  /** The gap between the start group's items. */
  startGap: number;
  /** The gap between the two groups. */
  groupGap: number;
  /** The end group's full width. */
  end: number;
}

export function fitsOneRow({ available, start, startGap, groupGap, end }: RowFit): boolean {
  const filters = start.reduce((sum, width) => sum + width, 0) + startGap * Math.max(0, start.length - 1);
  return filters + groupGap + end <= available + 0.5;
}

function px(value: string): number {
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * A ref for the row and whether it cannot hold the end group's full form next to the start group. `form` names the end
 * group's full form (e.g. the view and the list's grouping); each form's full width is remembered from when it was
 * drawn full, so a width measured for another form never decides (a form not seen yet is drawn full first, then may
 * turn compact before the paint). `watch` re-measures when the start group's content changes without changing the
 * row's size (a chip added or removed). Without a layout (jsdom, a hidden tab) the current form stays.
 */
export function useCompactRow(
  startSelector: string,
  endSelector: string,
  form: string | null,
  watch?: unknown,
): [(row: HTMLElement | null) => void, boolean] {
  // a callback ref: the row appears after the page has loaded its data, and the measuring must start then
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<{ form: string | null; compact: boolean }>({ form, compact: false });
  const compact = form !== null && state.form === form && state.compact;
  const compactNow = useRef(compact);
  compactNow.current = compact;
  // the end group's full width per form, measured while that form is drawn full
  const fullWidths = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const el = row;
    if (form === null || !el) return undefined;
    const measure = () => {
      const start = el.querySelector<HTMLElement>(startSelector);
      const end = el.querySelector<HTMLElement>(endSelector);
      if (!start || !end) return;
      const style = getComputedStyle(el);
      const available = el.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
      if (available <= 0) return;
      if (!compactNow.current) fullWidths.current.set(form, end.getBoundingClientRect().width);
      const full = fullWidths.current.get(form);
      if (full === undefined) return;
      const next = !fitsOneRow({
        available,
        start: Array.from(start.children, (child) => child.getBoundingClientRect().width),
        startGap: px(getComputedStyle(start).columnGap),
        groupGap: px(style.columnGap),
        end: full,
      });
      if (next !== compactNow.current) {
        compactNow.current = next;
        setState({ form, compact: next });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const end = el.querySelector(endSelector);
    if (end) observer.observe(end);
    return () => observer.disconnect();
  }, [row, startSelector, endSelector, form, watch]);

  return [setRow, compact];
}
