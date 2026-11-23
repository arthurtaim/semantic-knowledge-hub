import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { canAsk } from "../lib/aiMode";
import { useSession } from "../lib/session";
import { Composer } from "./Composer";

/** ⌘K on a Mac, Ctrl+K elsewhere — as the trigger shows it. */
export function shortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/i.test(platform) ? "⌘K" : "Ctrl+K";
}

/** True when the key press belongs to a text field (so `/` types a slash there). */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
}

/** The visible trigger in the tool row: looks like a field, opens the palette. */
export function ComposerTrigger({ onOpen, buttonRef }: { onOpen: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const session = useSession();
  const ask = canAsk(session?.features.ai_mode);
  const keys = shortcutLabel();
  return (
    <button
      ref={buttonRef}
      type="button"
      className="composer-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K /"
      onClick={onOpen}
    >
      <span className="composer-trigger__text">{ask ? "Спросить или найти…" : "Найти в базе знаний…"}</span>
      <kbd className="composer-trigger__keys" aria-label={`Клавиши: ${keys} или /`}>
        {keys}
      </kbd>
    </button>
  );
}

/**
 * The ⌘K palette: a modal dialog with the composer. Esc closes it (after closing an open list) and focus
 * returns to where it was; Tab stays inside the dialog.
 */
export function ComposerPalette({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const session = useSession();
  const ask = canAsk(session?.features.ai_mode);

  // Captured at the first render: the field's autofocus (a child effect) runs before this component's effects.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => () => previous?.focus(), [previous]);

  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input, [href]") ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="composer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="composer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ask ? "Спросить или найти" : "Найти в базе знаний"}
        onKeyDown={trapTab}
      >
        <Composer variant="palette" inputId="palette-composer-input" autoFocus onNavigate={onClose} onEscape={onClose} />
      </div>
    </div>
  );
}
