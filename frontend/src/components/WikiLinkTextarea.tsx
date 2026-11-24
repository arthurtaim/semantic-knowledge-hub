import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import { ApiError, api, isCancelled } from "../api/client";
import type { LinkSuggestion } from "../api/types";
import { caretCoordinates } from "../lib/caret";
import { STATUS_LABEL, TYPE_LABEL } from "../lib/labels";
import { findWikiQuery, replacementRange, type WikiQuery } from "../lib/wikilink";

/** Debounce of the suggestion request while the author types after `[[`. */
export const SUGGEST_DELAY_MS = 150;
const SUGGEST_LIMIT = 8;

const MATCHED_LABEL: Record<LinkSuggestion["matched"], string> = {
  id: "совпал ID",
  title: "совпало название",
  alias: "совпал синоним",
};

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "ref">;

interface Props extends TextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

interface Popup {
  wiki: WikiQuery;
  top: number;
  left: number;
}

/**
 * The Markdown textarea with `[[` autocomplete: typing `[[` and part of an ID, title or synonym opens a listbox
 * of visible documents (↑ ↓ Enter/Tab Esc, or the mouse). The chosen document is inserted as `[[ID|Title]]`
 * in place of the typed `[[query` — through the browser's edit command where available, so Ctrl+Z undoes it.
 * Nothing is picked automatically: until the author moves to an option, Enter is an ordinary line break.
 */
export function WikiLinkTextarea({ value, onValueChange, textareaRef, onKeyDown, onBlur, ...rest }: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [items, setItems] = useState<LinkSuggestion[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  // Esc closes the popup for this `[[` until the author starts another link.
  const dismissed = useRef<number | null>(null);
  const query = popup?.wiki.query ?? null;

  useEffect(() => {
    if (query === null || !query.trim()) {
      setItems([]);
      setLoadedFor(null);
      setLoading(false);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    const handle = window.setTimeout(() => {
      api
        .linkSuggest(query.trim(), SUGGEST_LIMIT, { signal: controller.signal })
        .then((result) => {
          setItems(result);
          setLoadedFor(query);
          setError(null);
          setActive(-1);
          setAnnouncement(
            result.length === 0
              ? "Подходящих документов нет."
              : `Найдено документов: ${result.length}. Стрелка вниз — выбрать, Enter — вставить ссылку.`,
          );
        })
        .catch((err: unknown) => {
          if (isCancelled(err)) return;
          setItems([]);
          setLoadedFor(query);
          setError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, SUGGEST_DELAY_MS);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [query]);

  /** Opens, moves or closes the popup for the caret position of the textarea. */
  function track(el: HTMLTextAreaElement) {
    const caret = el.selectionStart === el.selectionEnd ? el.selectionStart : -1;
    const wiki = caret >= 0 ? findWikiQuery(el.value, caret) : null;
    if (!wiki || wiki.start === dismissed.current) {
      if (!wiki) dismissed.current = null;
      setPopup(null);
      return;
    }
    setPopup((previous) => {
      if (previous && previous.wiki.start === wiki.start && previous.wiki.query === wiki.query) return previous;
      return { wiki, ...place(el, wiki.start) };
    });
    if (!popup || popup.wiki.start !== wiki.start) setActive(-1);
  }

  function place(el: HTMLTextAreaElement, position: number): { top: number; left: number } {
    const point = caretCoordinates(el, position);
    const maxTop = el.offsetTop + el.clientHeight;
    const top = Math.min(Math.max(el.offsetTop + point.top + point.height + 4, el.offsetTop), maxTop);
    const width = wrapRef.current?.clientWidth ?? 0;
    const popupWidth = Math.min(416, width);
    const left = Math.max(0, Math.min(el.offsetLeft + point.left, width - popupWidth));
    return { top, left };
  }

  function close() {
    setPopup(null);
    setActive(-1);
  }

  function choose(suggestion: LinkSuggestion) {
    const el = textareaRef.current;
    if (!el || !popup) return;
    const caret = el.selectionEnd;
    const [from, to] = replacementRange(el.value, popup.wiki, caret);
    el.focus();
    el.setSelectionRange(from, to);
    // The browser edit command keeps the change in the native undo stack (Ctrl+Z); it fires `input` itself.
    let inserted = false;
    try {
      inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, suggestion.insert);
    } catch {
      inserted = false;
    }
    const expected = el.value.slice(0, from) + suggestion.insert;
    if (!inserted || !el.value.startsWith(expected)) {
      el.setRangeText(suggestion.insert, from, to, "end");
      onValueChange(el.value);
    }
    dismissed.current = null;
    close();
    setAnnouncement(`Вставлена ссылка на «${suggestion.title}» (${suggestion.document_id}).`);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (popup) {
      const count = items.length;
      if (event.key === "ArrowDown" && count > 0) {
        event.preventDefault();
        setActive((i) => (i + 1) % count);
        return;
      }
      if (event.key === "ArrowUp" && count > 0) {
        event.preventDefault();
        setActive((i) => (i <= 0 ? count - 1 : i - 1));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && active >= 0 && items[active]) {
        event.preventDefault();
        choose(items[active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissed.current = popup.wiki.start;
        close();
        setAnnouncement("Подсказки закрыты.");
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") close();
    }
    onKeyDown?.(event);
  }

  const fresh = query !== null && loadedFor === query;
  const activeId = popup && active >= 0 && items[active] ? `${listId}-opt-${active}` : undefined;
  const style = popup ? ({ "--wl-top": `${popup.top}px`, "--wl-left": `${popup.left}px` } as CSSProperties) : undefined;

  return (
    <div className="wikilink-field" ref={wrapRef}>
      <textarea
        {...rest}
        ref={textareaRef}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          onValueChange(event.target.value);
          track(event.target);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || (!popup && event.key.startsWith("Arrow"))) {
            track(event.currentTarget);
          }
        }}
        onClick={(event) => track(event.currentTarget)}
        onBlur={(event) => {
          close();
          onBlur?.(event);
        }}
        aria-autocomplete="list"
        aria-controls={popup ? listId : undefined}
        aria-activedescendant={activeId}
      />
      {popup ? (
        <div className="wikilink-popup" style={style}>
          <p className="wikilink-popup__hint">
            {query?.trim()
              ? "Ссылка на документ: ↑ ↓ — выбрать, Enter — вставить, Esc — закрыть"
              : "Начните вводить ID, название или синоним документа"}
          </p>
          <ul id={listId} role="listbox" aria-label="Документы для ссылки" className="wikilink-popup__list">
            {items.map((item, index) => (
              <li
                key={item.document_id}
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                className={`wikilink-option${index === active ? " is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                // Only a moving pointer picks an option: a list that opens under a resting pointer (the browser
                // fires mouseenter on layout changes) must not preselect anything — Enter would insert it.
                onMouseMove={() => {
                  if (active !== index) setActive(index);
                }}
                onClick={() => choose(item)}
              >
                <span className="wikilink-option__title">{item.title}</span>
                <span className="wikilink-option__meta">
                  <code className="doc-id">{item.document_id}</code>
                  <span className={`wikilink-option__status wikilink-option__status--${item.status}`}>
                    {STATUS_LABEL[item.status]}
                  </span>
                  <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                  <span className="muted">
                    {MATCHED_LABEL[item.matched]}
                    {item.alias ? `: «${item.alias}»` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {query?.trim() && (loading || !fresh) && !error ? <p className="wikilink-popup__state">Ищем документы…</p> : null}
          {fresh && !loading && !error && items.length === 0 ? (
            <p className="wikilink-popup__state">Ничего не найдено. Проверьте ID или название — ссылка не создаётся сама.</p>
          ) : null}
          {error ? <p className="wikilink-popup__state flag">Подсказки недоступны: {error.message}</p> : null}
        </div>
      ) : null}
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
