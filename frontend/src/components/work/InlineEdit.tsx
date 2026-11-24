import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "../ui/Button";

/*
 * Inline editing in a row (M6 List, task panel): the value is shown as text; a button turns it into a field.
 * Enter or leaving the field saves, Esc cancels and returns focus to the button. Saving is the caller's
 * `onCommit` (optimistic with rollback, docs/WORK_MANAGEMENT.md «UI»).
 */

interface InlineTextProps {
  value: string;
  /** Accessible name of the field and the button: «Название ARIS-3». */
  label: string;
  maxLength?: number;
  onCommit: (value: string) => void;
  /** The text shown while not editing (a link to the task, for instance). */
  children: ReactNode;
}

export function InlineText({ value, label, maxLength, onCommit, children }: InlineTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function start() {
    setDraft(value);
    done.current = false;
    setEditing(true);
  }

  function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const text = draft.trim();
    if (save && text && text !== value) onCommit(text);
    // The button comes back on the next render.
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="input inline-edit__input"
        aria-label={label}
        value={draft}
        maxLength={maxLength}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
      />
    );
  }
  return (
    <span className="inline-edit">
      {children}
      <IconButton ref={buttonRef} icon="edit" size="sm" label={`Изменить: ${label}`} className="inline-edit__button" onClick={start} />
    </span>
  );
}

interface InlineDateProps {
  value: string | null;
  /** What the button shows (a formatted date, «—»). */
  display: string;
  label: string;
  /** null: clear the date (only where the field allows it). */
  onCommit: (value: string | null) => void;
  allowClear?: boolean;
  disabled?: boolean;
  min?: string;
}

export function InlineDate({ value, display, label, onCommit, allowClear = false, disabled = false, min }: InlineDateProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft || null;
    if (save && next !== value && (next !== null || allowClear)) onCommit(next);
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="date"
        className="input inline-edit__date"
        aria-label={label}
        value={draft}
        min={min}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    );
  }
  if (disabled) return <span className="inline-date">{display}</span>;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="inline-date inline-date--button"
      aria-label={`${label}: ${display}. Изменить`}
      onClick={() => {
        setDraft(value ?? "");
        done.current = false;
        setEditing(true);
      }}
    >
      {display}
    </button>
  );
}
