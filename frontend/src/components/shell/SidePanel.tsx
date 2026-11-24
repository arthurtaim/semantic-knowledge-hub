import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { IconButton } from "../ui/Button";

/*
 * The right panel of the «toolbar, content, right panel» pattern (docs/ui-v2/specs/03_SCREENS.md §1, §3, §6):
 * «Сведения» of a document and the document assistant (one at a time). On wide screens it is a column next to the
 * content (a complementary landmark); below 1200 px it is a slide-over sheet from the right, on phones a sheet
 * from the bottom — both modal (scrim, focus trap, Esc, focus return).
 */

/** Below this width a right panel is a sheet over the content. */
export const PANEL_SHEET_QUERY = "(max-width: 1199.98px)";
/** Phones: the sheet slides up from the bottom. */
export const PANEL_BOTTOM_QUERY = "(max-width: 599.98px)";

export type SidePanelMode = "inline" | "sheet" | "bottom";

/** How a right panel is shown at the current width; `alwaysSheet` (filters on a phone) never docks. */
export function useSidePanelMode(alwaysSheet = false): SidePanelMode {
  const sheet = useMediaQuery(PANEL_SHEET_QUERY);
  const bottom = useMediaQuery(PANEL_BOTTOM_QUERY);
  if (bottom) return "bottom";
  return sheet || alwaysSheet ? "sheet" : "inline";
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface SidePanelProps {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  mode: SidePanelMode;
  /** Controls in the header before «Закрыть». */
  actions?: ReactNode;
  /** Pinned under the scrolling body (the assistant's field). */
  footer?: ReactNode;
  /** A docked panel focuses this on open instead of its heading (the assistant's field). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the control that opened the panel is gone (or was the page itself). */
  returnFocus?: () => HTMLElement | null;
  /** False when the page reopens a panel the reader left open: a docked panel then does not take the focus. */
  focusOnOpen?: boolean;
  /** A sheet slides in from this edge (the documents tree: from the left); phones keep the bottom sheet. */
  side?: "left" | "right";
  className?: string;
}

/**
 * Rendered only while open. Takes focus when it opens (the heading of a docked panel, «Закрыть» of a sheet) and
 * gives it back to the control that opened it when it closes.
 */
export function SidePanel({
  id,
  title,
  onClose,
  children,
  mode,
  actions,
  footer,
  initialFocus,
  returnFocus,
  focusOnOpen = true,
  side = "right",
  className,
}: SidePanelProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef(returnFocus);
  fallbackRef.current = returnFocus;
  const modal = mode !== "inline";

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = active && active !== document.body ? active : null;
    if (modal) closeRef.current?.focus();
    else if (focusOnOpen) (initialFocus?.current ?? headingRef.current)?.focus();
    return () => {
      const target = opener && opener.isConnected ? opener : (fallbackRef.current?.() ?? null);
      target?.focus();
    };
    // The opener is the element focused when the panel mounted; a mode change keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A sheet is modal: Esc anywhere closes it.
  useEffect(() => {
    if (!modal) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modal, onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!modal) {
      // A docked panel closes with Esc while focus is inside it.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.closest("[hidden]"),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const classes = ["side-panel", `side-panel--${mode}`, mode === "sheet" && side === "left" ? "side-panel--left" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <div className="side-panel__head">
        <h2 id={titleId} className="side-panel__title" tabIndex={-1} ref={headingRef}>
          {title}
        </h2>
        {actions}
        <IconButton ref={closeRef} icon="close" label={`Закрыть: ${title}`} size="sm" onClick={onClose} />
      </div>
      <div className="side-panel__body">{children}</div>
      {footer ? <div className="side-panel__footer">{footer}</div> : null}
    </>
  );

  if (!modal) {
    return (
      <aside id={id} className={classes} aria-labelledby={titleId} ref={panelRef} onKeyDown={onKeyDown}>
        {body}
      </aside>
    );
  }
  return (
    <>
      <div className="side-panel-scrim" aria-hidden="true" onClick={onClose} />
      <div
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={classes}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        {body}
      </div>
    </>
  );
}
