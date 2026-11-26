import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { buttonClass } from "./ui/Button";

/*
 * One guard for leaving a page with unsaved edits (SYS-007, docs/DOCUMENT_CREATION_WORKFLOW.md §4).
 *
 * The app runs under <BrowserRouter>, not a data router, so react-router's `useBlocker` is not available. Instead:
 * - in-app links (Link, NavLink, the sidebar, links in a preview): a capture-phase click listener on the document stops
 *   the click before React Router sees it and asks; «Выйти без сохранения» repeats the same click;
 * - the browser's Back / Forward: a popstate listener that runs before the router's own (see `popGuard`) keeps the
 *   router on this page, moves the address back (BrowserRouter numbers its entries in `history.state.idx`) and asks;
 *   «Выйти без сохранения» repeats the move;
 * - reload, tab close and links to other sites: the browser's own `beforeunload` dialog.
 * - navigation started from code elsewhere in the app (the ⌘K quick find): `requestLeave(go)` asks the same way.
 * The page's own `navigate()` calls (after a save, a submit or a delete) are deliberate exits and are not guarded.
 */

/** While `active`, closing or reloading the tab asks first (the browser's own dialog); `skip` lets a confirmed exit pass. */
export function useBeforeUnloadGuard(active: boolean, skip?: RefObject<boolean>): void {
  useEffect(() => {
    if (!active) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (skip?.current) return;
      event.preventDefault();
      event.returnValue = ""; // older browsers ask only when a return value is set
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active, skip]);
}

/**
 * The mounted guard's Back / Forward handler. Listeners on `window` run in the order they were added (Chromium does
 * not run a capturing one first), so ONE listener is added when this module loads — before <BrowserRouter> mounts
 * and adds its own — and a guard can stop the event before the router sees it. Keep this module statically imported
 * (not behind React.lazy), or the router's listener would come first.
 */
let popGuard: ((event: PopStateEvent) => void) | null = null;
if (typeof window !== "undefined") window.addEventListener("popstate", (event) => popGuard?.(event));

/** The mounted, armed guard's handler for navigation started from code (null: nothing to protect). */
let callGuard: ((go: () => void) => void) | null = null;

/**
 * Run `go` (a navigation started from code — the ⌘K quick find, a search result) now, or, while a page has unsaved
 * edits, only after the person chose «Выйти без сохранения».
 */
export function requestLeave(go: () => void): void {
  if (callGuard) callGuard(go);
  else go();
}

type HeldNavigation =
  | { kind: "link"; anchor: HTMLAnchorElement; to: string }
  | { kind: "history"; delta: number }
  | { kind: "call"; go: () => void };

/** BrowserRouter's index of a history entry; null for an entry it did not create. */
function historyIndex(state: unknown): number | null {
  const idx = state !== null && typeof state === "object" ? (state as { idx?: unknown }).idx : undefined;
  return typeof idx === "number" ? idx : null;
}

const DEFAULT_DESCRIPTION = "Если выйти сейчас, они будут потеряны.";

interface UnsavedChangesGuardProps {
  /** True while the page has edits that leaving would lose. */
  when: boolean;
  /** The dialog's explanation under «Есть несохранённые изменения». */
  description?: string;
}

/** Asks «Остаться» / «Выйти без сохранения» before an in-app link or Back / Forward leaves the page while `when`. */
export function UnsavedChangesGuard({ when, description = DEFAULT_DESCRIPTION }: UnsavedChangesGuardProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [held, setHeld] = useState<HeldNavigation | null>(null);
  // Set once the person chose «Выйти без сохранения»: the repeated click or history move passes.
  const leaving = useRef(false);
  const here = useRef(location);
  here.current = location;
  const index = useRef<number | null>(null);

  useBeforeUnloadGuard(when, leaving);

  // This page's history index; a new location (the page stayed mounted) arms the guard again.
  useEffect(() => {
    index.current = historyIndex(window.history.state);
    leaving.current = false;
  }, [location.key]);

  useEffect(() => {
    if (!when) return undefined;
    const onClick = (event: MouseEvent) => {
      if (leaving.current || event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // a new tab
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return; // another site: `beforeunload` asks
      const current = here.current;
      if (url.pathname === current.pathname && url.search === current.search) return; // the same page
      event.preventDefault();
      event.stopImmediatePropagation();
      setHeld({ kind: "link", anchor, to: `${url.pathname}${url.search}${url.hash}` });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [when]);

  useEffect(() => {
    if (!when) return undefined;
    let returning = false;
    const onPopState = (event: PopStateEvent) => {
      if (leaving.current) return;
      if (returning) {
        // Our own step back to this page: the router never left it.
        returning = false;
        event.stopImmediatePropagation();
        return;
      }
      const current = here.current;
      if (window.location.pathname === current.pathname && window.location.search === current.search) return;
      const from = index.current;
      const to = historyIndex(event.state);
      if (from === null || to === null || from === to) return; // not the router's entry: it cannot be undone here
      event.stopImmediatePropagation();
      returning = true;
      window.history.go(from - to);
      setHeld({ kind: "history", delta: to - from });
    };
    popGuard = onPopState;
    return () => {
      if (popGuard === onPopState) popGuard = null;
    };
  }, [when]);

  useEffect(() => {
    if (!when) return undefined;
    const onCall = (go: () => void) => {
      if (leaving.current) go();
      else setHeld({ kind: "call", go });
    };
    callGuard = onCall;
    return () => {
      if (callGuard === onCall) callGuard = null;
    };
  }, [when]);

  if (!held) return null;

  function leave() {
    if (!held) return;
    leaving.current = true;
    setHeld(null);
    if (held.kind === "call") held.go();
    else if (held.kind === "history") window.history.go(held.delta);
    else if (held.anchor.isConnected) held.anchor.click(); // the link's own handler: its state, replace, side effects
    else navigate(held.to);
  }

  return <LeaveDialog description={description} onStay={() => setHeld(null)} onLeave={leave} />;
}

interface LeaveDialogProps {
  description: string;
  onStay: () => void;
  onLeave: () => void;
}

/** A modal alert dialog: focus on «Остаться», Tab stays inside, Esc stays, focus returns to where it was. */
function LeaveDialog({ description, onStay, onLeave }: LeaveDialogProps) {
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  // Captured at the first render, before «Остаться» takes the focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    stayRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, [opener]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The page's own shortcuts (⌘K, «/», Esc of a panel) wait while the dialog is open.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onStay();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="leave-confirm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onStay();
      }}
    >
      <div
        ref={dialogRef}
        className="leave-confirm__dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="leave-confirm__title">
          Есть несохранённые изменения
        </h2>
        <p id={textId} className="leave-confirm__text">
          {description}
        </p>
        <div className="button-row leave-confirm__actions">
          <button ref={stayRef} type="button" className={buttonClass("primary")} onClick={onStay}>
            Остаться
          </button>
          <button type="button" className={buttonClass("danger")} onClick={onLeave}>
            Выйти без сохранения
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
