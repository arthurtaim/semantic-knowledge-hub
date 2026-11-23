import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { DocumentSummary } from "../api/types";
import { canAsk } from "../lib/aiMode";
import { pluralRu } from "../lib/labels";
import { useSession } from "../lib/session";
import { StatusStamp } from "./StatusStamp";

/** Debounce of the instant document matches while typing. */
export const COMPOSER_DELAY_MS = 150;
const MATCH_LIMIT = 6;
const MIN_QUESTION = 3;

export type ComposerMode = "ask" | "search";
/** Where the AI looks when asked from the composer: team documents unless the user picks otherwise. */
export type AskScope = "team" | "corporate" | "both";

type Option =
  | { kind: "ask"; key: string }
  | { kind: "doc"; key: string; doc: DocumentSummary }
  | { kind: "all"; key: string };

/** The answer screen for a question (it asks at once: `run=1`); the team scope is the default. */
export function askHref(question: string, scope: AskScope = "team"): string {
  const params = new URLSearchParams({ q: question, run: "1" });
  if (scope !== "team") params.set("scope", scope);
  return `/ask?${params.toString()}`;
}

interface ComposerProps {
  /** `palette`: inside the ⌘K dialog; `hero`: the home page's main field. */
  variant: "palette" | "hero";
  inputId: string;
  autoFocus?: boolean;
  /** Scope for questions (the hero shows the switch); team by default. */
  scope?: AskScope;
  /** Extra controls under the field for the current mode (the hero's scope switch for questions). */
  renderExtra?: (mode: ComposerMode) => ReactNode;
  /** Called after the composer navigated somewhere (closes the palette). */
  onNavigate?: () => void;
  /** Esc on an empty or closed list (closes the palette). */
  onEscape?: () => void;
}

/**
 * «Спросить или найти»: one field for questions, search and documents. An accessible combobox (ARIA 1.2):
 * typing shows instant document matches from the existing search; Enter asks the AI (or searches); ↑/↓ pick
 * a match; Tab switches «Спросить ИИ» / «Найти в документах» while the list is open. Without an AI provider
 * (`disabled`) it is a search field only — no dead controls.
 */
export function Composer({ variant, inputId, autoFocus, scope = "team", renderExtra, onNavigate, onEscape }: ComposerProps) {
  const session = useSession();
  const navigate = useNavigate();
  const listId = useId();
  const hintId = useId();
  const aiAvailable = canAsk(session?.features.ai_mode);
  // The user's explicit choice; until then the default follows the session (which may arrive later).
  const [choice, setChoice] = useState<ComposerMode | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  const requestNo = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const effectiveMode: ComposerMode = aiAvailable ? (choice ?? "ask") : "search";
  const text = query.trim();

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Instant matches: the same search as the catalogue, debounced; stale answers are ignored.
  useEffect(() => {
    const no = ++requestNo.current;
    if (text.length < 2) {
      setMatches([]);
      setLoading(false);
      setFailed(false);
      return undefined;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .documents({ query: text, size: MATCH_LIMIT })
        .then((page) => {
          if (no !== requestNo.current) return;
          setMatches(page.items.slice(0, MATCH_LIMIT));
          setFailed(false);
          setAnnouncement(
            page.items.length === 0
              ? "Документов не найдено"
              : `${pluralRu(page.total, "Найден", "Найдено", "Найдено")} ${page.total} ${pluralRu(page.total, "документ", "документа", "документов")}`,
          );
        })
        .catch(() => {
          if (no !== requestNo.current) return;
          setMatches([]);
          setFailed(true);
        })
        .finally(() => {
          if (no === requestNo.current) setLoading(false);
        });
    }, COMPOSER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const options: Option[] = [];
  if (text) {
    if (effectiveMode === "ask" && text.length >= MIN_QUESTION) options.push({ kind: "ask", key: "ask" });
    for (const doc of matches) options.push({ kind: "doc", key: `doc-${doc.id}`, doc });
    options.push({ kind: "all", key: "all" });
  }
  const expanded = open && options.length > 0;
  const activeOption = expanded && active >= 0 ? options[active] : undefined;

  function go(href: string) {
    setOpen(false);
    setActive(-1);
    onNavigate?.();
    navigate(href);
  }

  function activate(option: Option) {
    if (option.kind === "ask") go(askHref(text, scope));
    else if (option.kind === "doc") go(`/documents/${encodeURIComponent(option.doc.id)}`);
    else go(`/documents?query=${encodeURIComponent(text)}`);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (activeOption) {
      activate(activeOption);
      return;
    }
    if (effectiveMode === "ask" && text.length >= MIN_QUESTION) go(askHref(text, scope));
    else go(text ? `/documents?query=${encodeURIComponent(text)}` : "/documents");
  }

  function switchMode(next: ComposerMode) {
    setChoice(next);
    setActive(-1);
    setAnnouncement(next === "ask" ? "Режим: спросить ИИ" : "Режим: найти в документах");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const count = options.length;
      setActive((i) => (event.key === "ArrowDown" ? (i + 1) % count : i <= 0 ? count - 1 : i - 1));
    } else if (event.key === "Escape") {
      if (expanded) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
      } else if (onEscape) {
        event.preventDefault();
        onEscape();
      }
    } else if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // Raycast's pattern, only while the list is open: Tab turns a search into a question and back.
      if (aiAvailable && expanded) {
        event.preventDefault();
        switchMode(effectiveMode === "ask" ? "search" : "ask");
      }
    }
  }

  const label = aiAvailable ? (effectiveMode === "ask" ? "Спросить или найти" : "Поиск по базе знаний") : "Поиск по базе знаний";
  const placeholder = effectiveMode === "ask" ? "Спросить или найти…" : "Найти в базе знаний…";
  const hint = aiAvailable
    ? effectiveMode === "ask"
      ? "Enter — спросить ИИ, ↑↓ — выбрать документ, Tab — переключить на поиск."
      : "Enter — найти, ↑↓ — выбрать документ, Tab — переключить на вопрос ИИ."
    : "Enter — найти, ↑↓ — выбрать документ. ИИ отключён: работает поиск по документам.";

  return (
    <form className={`composer composer--${variant}`} role="search" onSubmit={submit}>
      {aiAvailable ? (
        <div className="composer__modes" role="group" aria-label="Режим поля">
          <button
            type="button"
            className="composer__mode"
            aria-pressed={effectiveMode === "ask"}
            onClick={() => {
              switchMode("ask");
              inputRef.current?.focus();
            }}
          >
            Спросить ИИ
          </button>
          <button
            type="button"
            className="composer__mode"
            aria-pressed={effectiveMode === "search"}
            onClick={() => {
              switchMode("search");
              inputRef.current?.focus();
            }}
          >
            Найти в документах
          </button>
        </div>
      ) : null}
      <div className="composer__row">
        <label htmlFor={inputId} className="visually-hidden">
          {label}
        </label>
        <div className="composer__field">
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
            aria-describedby={hintId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            maxLength={2000}
            autoComplete="off"
            spellCheck={false}
          />
          <ul id={listId} role="listbox" aria-label="Подсказки" className="composer__list" hidden={!expanded}>
            {options.map((option, index) => (
              <li
                key={option.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`composer__option composer__option--${option.kind}${index === active ? " is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (active !== index) setActive(index);
                }}
                onClick={() => activate(option)}
              >
                {option.kind === "ask" ? (
                  <>
                    <span className="composer__option-kind">Спросить ИИ</span>
                    <span className="composer__option-text">«{text}»</span>
                  </>
                ) : option.kind === "doc" ? (
                  <>
                    <span className="composer__option-text">{option.doc.title}</span>
                    <span className="composer__option-meta">
                      <code className="doc-id">{option.doc.id}</code>
                      <StatusStamp status={option.doc.status} />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="composer__option-kind">Все результаты</span>
                    <span className="composer__option-text">поиска «{text}»</span>
                  </>
                )}
              </li>
            ))}
            {expanded && loading && matches.length === 0 ? (
              <li role="presentation" className="composer__note">
                Ищем документы…
              </li>
            ) : null}
            {expanded && failed ? (
              <li role="presentation" className="composer__note">
                Подсказки недоступны — нажмите Enter, чтобы искать.
              </li>
            ) : null}
          </ul>
        </div>
        <button type="submit" className={`button ${variant === "hero" ? "button--primary" : "button--secondary"}`}>
          {effectiveMode === "ask" ? "Спросить" : "Найти"}
        </button>
      </div>
      <p id={hintId} className="composer__hint">
        {hint}
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {renderExtra?.(effectiveMode)}
    </form>
  );
}
