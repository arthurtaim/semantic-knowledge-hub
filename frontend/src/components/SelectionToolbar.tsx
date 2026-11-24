import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Link } from "react-router-dom";
import { captureSelection, selectionKey, type CapturedSelection } from "../lib/selection";

/*
 * The floating bar over a fragment selected in the document text (docs/ui-v2/specs/03_SCREENS.md §3, design-04):
 * «Объяснить / Найти связанные / Предложить правку». It appears for a selection made with the mouse or the
 * keyboard (Shift+arrows), only inside the text and only for visible characters; it never takes focus by itself.
 *
 * Keyboard: Alt+F10 moves focus into the bar while it is shown (the ARIA toolbar convention of editors);
 * ←/→, Home/End move between its actions; Esc closes it and returns focus to where it was (the text when focus
 * was nowhere in particular), keeping the selection. ⌘J / Ctrl+J opens the assistant panel with the selection as
 * context — the same actions are there.
 */

/** Wait for the selection to settle (a drag, Shift+arrows) before showing the bar. */
export const SELECTION_DELAY_MS = 120;
const GAP = 8;

export type SelectionAction =
  | { id: string; label: string; kind: "run" }
  /** The manual path (the AI action is unavailable): a link, with the reason as its description. */
  | { id: string; label: string; kind: "link"; to: string; description: string };

interface Placement {
  selection: CapturedSelection;
  /** The selection's first and last line boxes, relative to the bar's positioned parent. */
  top: number;
  bottom: number;
  left: number;
}

interface SelectionToolbarProps {
  /**
   * The positioned wrapper of the text and the bar (`position: relative`, `tabIndex={-1}`): the bar is placed in
   * it, and focus lands on it after Esc when it was nowhere in particular before.
   */
  frameRef: RefObject<HTMLElement | null>;
  /** The document text inside the frame: selections elsewhere never show the bar. */
  textSelector?: string;
  actions: SelectionAction[];
  onAction: (actionId: string, selection: CapturedSelection) => void;
}

function isToolbarShortcut(event: globalThis.KeyboardEvent): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "F10" || event.code === "F10");
}

function place(selection: CapturedSelection, parent: HTMLElement | null): Placement {
  const range = selection.range;
  const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0) : [];
  const box = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  const first = rects[0] ?? box;
  const last = rects[rects.length - 1] ?? box;
  const base = parent?.getBoundingClientRect();
  if (!first || !last || !base) return { selection, top: 0, bottom: 0, left: 0 };
  return { selection, top: first.top - base.top, bottom: last.bottom - base.top, left: first.left - base.left };
}

export function SelectionToolbar({ frameRef, textSelector = ".prose", actions, onAction }: SelectionToolbarProps) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const barRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const dismissed = useRef<string | null>(null);
  const dragging = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  const hintId = useId();
  const text = useCallback(() => frameRef.current?.querySelector<HTMLElement>(textSelector) ?? null, [frameRef, textSelector]);

  const hide = useCallback(() => {
    setPlacement(null);
    setStyle(null);
    // The next selection starts from the first action.
    setActive(0);
  }, []);

  const evaluate = useCallback(() => {
    if (dragging.current) return;
    const selection = captureSelection(text());
    if (!selection) {
      // Focus inside the bar keeps it (the selection is still there for the browser, just not reported).
      if (!barRef.current?.contains(document.activeElement)) {
        dismissed.current = null;
        hide();
      }
      return;
    }
    if (dismissed.current === selectionKey(selection)) return;
    dismissed.current = null;
    setPlacement(place(selection, frameRef.current));
  }, [text, frameRef, hide]);

  // The selection settles, then the bar appears (mouse: after the button is released).
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(evaluate, SELECTION_DELAY_MS);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (event.target instanceof Node && text()?.contains(event.target)) dragging.current = true;
    };
    const onPointerUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("mouseup", onPointerUp);
    window.addEventListener("resize", schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("resize", schedule);
    };
  }, [evaluate, text]);

  const visible = placement !== null;

  // Above the first line; below the last one when there is no room under the page toolbar.
  useLayoutEffect(() => {
    if (!placement) return;
    const bar = barRef.current;
    const frame = frameRef.current;
    if (!bar || !frame) return;
    const height = bar.offsetHeight;
    const width = bar.offsetWidth;
    const above = frame.getBoundingClientRect().top + placement.top - height - GAP;
    const limit = document.querySelector(".page-toolbar")?.getBoundingClientRect().bottom ?? 0;
    const top = above < limit ? placement.bottom + GAP : placement.top - height - GAP;
    const left = Math.max(0, Math.min(placement.left, frame.clientWidth - width));
    setStyle({ top, left });
  }, [placement, frameRef]);

  // Announce once when the bar appears, so a screen-reader user knows it is there and how to reach it.
  useEffect(() => {
    if (visible && !shown.current) setAnnouncement("Действия с выделением: Alt+F10");
    if (!visible) setAnnouncement("");
    shown.current = visible;
  }, [visible]);

  function focusItem(index: number) {
    const count = actions.length;
    const next = ((index % count) + count) % count;
    setActive(next);
    itemRefs.current[next]?.focus();
  }

  const close = useCallback(
    (restoreFocus: boolean) => {
      const current = placement;
      if (current) dismissed.current = selectionKey(current.selection);
      hide();
      if (!restoreFocus) return;
      const target = returnTo.current && returnTo.current.isConnected ? returnTo.current : frameRef.current;
      returnTo.current = null;
      target?.focus({ preventScroll: true });
      // Keep the fragment selected (moving focus may have collapsed it).
      if (current) {
        const selection = window.getSelection();
        if (selection && (selection.isCollapsed || selection.rangeCount === 0)) {
          selection.removeAllRanges();
          selection.addRange(current.selection.range);
        }
      }
    },
    [placement, hide, frameRef],
  );

  // Alt+F10: into the bar. Esc while the bar is shown and focus is in the text or nowhere: close it.
  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isToolbarShortcut(event)) {
        event.preventDefault();
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!barRef.current?.contains(focused)) returnTo.current = focused && focused !== document.body ? focused : null;
        focusItem(active);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      const inBar = barRef.current?.contains(focused) ?? false;
      const nowhere = !focused || focused === document.body || Boolean(frameRef.current?.contains(focused));
      if (!inBar && !nowhere) return;
      event.preventDefault();
      close(inBar);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // focusItem reads the refs; `active` is the item to return to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active, close, frameRef]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = itemRefs.current.findIndex((item) => item === document.activeElement);
    if (index < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") focusItem(index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") focusItem(index - 1);
    else if (event.key === "Home") focusItem(0);
    else if (event.key === "End") focusItem(actions.length - 1);
    else return;
    event.preventDefault();
  }

  function run(action: SelectionAction) {
    if (!placement) return;
    const { selection } = placement;
    dismissed.current = selectionKey(selection);
    returnTo.current = null;
    hide();
    if (action.kind === "run") onAction(action.id, selection);
  }

  return (
    <>
      <div
        ref={barRef}
        role="toolbar"
        aria-label="Действия с выделением"
        aria-keyshortcuts="Alt+F10"
        aria-orientation="horizontal"
        className="selection-toolbar"
        hidden={!visible}
        style={style ? { top: `${style.top}px`, left: `${style.left}px` } : undefined}
        onKeyDown={onKeyDown}
      >
        {actions.map((action, index) => {
          const common = {
            ref: (el: HTMLElement | null) => {
              itemRefs.current[index] = el;
            },
            className: "selection-toolbar__item",
            tabIndex: index === active ? 0 : -1,
            // Keep the selection: the text stays selected while an action is chosen.
            onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
            onFocus: () => setActive(index),
          };
          return action.kind === "link" ? (
            <Link key={action.id} to={action.to} {...common} aria-describedby={`${hintId}-${index}`} title={action.description} onClick={() => run(action)}>
              {action.label}
            </Link>
          ) : (
            <button key={action.id} type="button" {...common} onClick={() => run(action)}>
              {action.label}
            </button>
          );
        })}
        {actions.map((action, index) =>
          action.kind === "link" ? (
            <span key={action.id} id={`${hintId}-${index}`} className="visually-hidden">
              {action.description}
            </span>
          ) : null,
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
