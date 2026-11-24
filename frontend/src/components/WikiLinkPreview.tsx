import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { api } from "../api/client";
import type { DocumentDetail } from "../api/types";
import { TYPE_LABEL } from "../lib/labels";
import { StatusStamp } from "./StatusStamp";

const CARD_WIDTH = 320;
/** Loaded target documents, shared by every preview on the page (and across pages). */
const cache = new Map<string, Promise<DocumentDetail>>();

function loadTarget(id: string): Promise<DocumentDetail> {
  let pending = cache.get(id);
  if (!pending) {
    pending = api.document(id);
    pending.catch(() => cache.delete(id)); // a failed preview is retried next time
    cache.set(id, pending);
  }
  return pending;
}

interface Shown {
  anchor: HTMLElement;
  id: string | null;
  top: number;
  left: number;
  above: boolean;
}

function targetOf(anchor: HTMLElement): string | null {
  const match = /^\/documents\/([^/?#]+)/.exec(anchor.getAttribute("href") ?? "");
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function position(anchor: HTMLElement): Pick<Shown, "top" | "left" | "above"> {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(CARD_WIDTH, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const above = rect.bottom + 190 > window.innerHeight && rect.top > 200;
  return { top: above ? rect.top - 6 : rect.bottom + 6, left, above };
}

/**
 * Hover / keyboard-focus preview of WikiLinks (`a.wikilink`) inside rendered document HTML: title, status, type
 * and summary of the target, loaded once and cached. Unresolved links (`.wikilink--unresolved`) explain
 * themselves. The card is a tooltip (no controls): the link itself opens the document.
 */
export function WikiLinkPreviewArea({ children }: { children: ReactNode }) {
  const cardId = useId();
  const [shown, setShown] = useState<Shown | null>(null);
  const [doc, setDoc] = useState<{ id: string; detail: DocumentDetail | null; failed: boolean } | null>(null);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const id = shown?.id;
    if (!id) return undefined;
    let active = true;
    loadTarget(id)
      .then((detail) => active && setDoc({ id, detail, failed: false }))
      .catch(() => active && setDoc({ id, detail: null, failed: true }));
    return () => {
      active = false;
    };
  }, [shown?.id]);

  useEffect(() => {
    if (!shown) return undefined;
    const hide = () => setShown(null);
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [shown]);

  function show(anchor: HTMLElement) {
    if (current.current === anchor) return;
    hide();
    current.current = anchor;
    anchor.setAttribute("aria-describedby", cardId);
    const unresolved = anchor.classList.contains("wikilink--unresolved");
    setShown({ anchor, id: unresolved ? null : targetOf(anchor), ...position(anchor) });
  }

  function hide() {
    current.current?.removeAttribute("aria-describedby");
    current.current = null;
    setShown(null);
  }

  const wikilinkFrom = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? (target.closest(".wikilink") as HTMLElement | null) : null;

  function onOver(event: MouseEvent<HTMLDivElement>) {
    const anchor = wikilinkFrom(event.target);
    if (anchor) show(anchor);
  }

  function onOut(event: MouseEvent<HTMLDivElement>) {
    const anchor = wikilinkFrom(event.target);
    if (anchor && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) hide();
  }

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const anchor = wikilinkFrom(event.target);
    if (anchor) show(anchor);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && shown) hide();
  }

  const detail = shown?.id && doc?.id === shown.id ? doc : null;
  const width = typeof window === "undefined" ? CARD_WIDTH : Math.min(CARD_WIDTH, window.innerWidth - 16);
  return (
    <div className="wikilink-area" onMouseOver={onOver} onMouseOut={onOut} onFocus={onFocus} onBlur={hide} onKeyDown={onKeyDown}>
      {children}
      {shown ? (
        <div
          id={cardId}
          role="tooltip"
          className={`wikilink-card${shown.above ? " wikilink-card--above" : ""}`}
          style={{ top: shown.top, left: shown.left, width }}
        >
          {!shown.id ? (
            <>
              <p className="wikilink-card__title">Нерешённая ссылка</p>
              <p className="muted">Документ с таким ID или названием не найден или недоступен — ссылка не ведёт никуда.</p>
            </>
          ) : !detail ? (
            <p className="muted">Загружаем {shown.id}…</p>
          ) : detail.failed || !detail.detail ? (
            <p className="muted">Документ {shown.id} недоступен.</p>
          ) : (
            <>
              <p className="wikilink-card__title">{detail.detail.title}</p>
              <p className="wikilink-card__meta">
                <StatusStamp status={detail.detail.status} />
                <code className="doc-id">{detail.detail.id}</code>
                <span>{TYPE_LABEL[detail.detail.type] ?? detail.detail.type}</span>
              </p>
              {detail.detail.summary || detail.detail.excerpt ? (
                <p className="wikilink-card__text">{(detail.detail.summary || detail.detail.excerpt).slice(0, 240)}</p>
              ) : null}
              <p className="wikilink-card__hint muted">Владелец: {detail.detail.owner}. Нажмите ссылку, чтобы открыть.</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
