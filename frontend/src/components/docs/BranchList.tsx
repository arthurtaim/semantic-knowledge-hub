import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { DocStatus, HighlightSegment, SourceType } from "../../api/types";
import { LIST_ORDERS, ORDER_LABEL, type ListOrder, type ReviewMark } from "../../lib/docTree";
import { pluralRu, SOURCE_LABEL, STATUS_LABEL } from "../../lib/labels";
import { Highlighted } from "../Highlighted";
import { StaleMark } from "../StaleMark";
import { buttonClass } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Popover";
import { StatusMark } from "../ui/StatusMark";

/*
 * The middle column of «Список» (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §1 «Список ветки», design docs-01 /
 * docs-02): the branch's path, its count and the order menu, then one row per document — three lines (~72 px):
 * the title with the status only when it is not «Утверждён», the summary when there is one, then the ID, the
 * systems and the review date (amber when overdue or never reviewed). A search shows its results in the same rows
 * with the highlighted snippet and «Почему найдено».
 *
 * A row is a link to the document: a click shows it in the preview (on a phone it opens it), Enter or a double
 * click opens it, Space previews; ↑↓ Home End move between the rows (one tab stop). No paging; beyond 200 rows the
 * browser skips laying out the rows off screen (`content-visibility`).
 */

/** Beyond this many rows, rows off screen are not laid out (content-visibility). */
export const LONG_LIST = 200;

export interface BranchRowData {
  id: string;
  title: string;
  status: DocStatus;
  /** The summary line; null: no line. */
  summary: string | null;
  /** A search snippet instead of the summary. */
  highlights?: HighlightSegment[] | null;
  systems: string[];
  review: ReviewMark;
  ownerMissing: boolean;
  indexStale: boolean;
  source: SourceType;
  /** Search only. */
  reasons?: string[] | null;
  relatedVia?: string | null;
}

interface BranchListProps {
  /** «Интеграции / ARIS»: the parent part (muted) and the node's own name. */
  parentLabel: string | null;
  title: string;
  /** The count from the API (the node's `count`, or the search total). */
  count: number;
  rows: BranchRowData[];
  selected: string | null;
  /** The order menu; absent for a search (relevance). */
  order?: ListOrder;
  onOrder?: (order: ListOrder) => void;
  /** At the end of the header instead of the order menu (a search: «Сбросить поиск»). */
  action?: ReactNode;
  /** Show a row in the preview (click, Space). */
  onPreview: (id: string) => void;
  /** A click opens the document instead of previewing it (phones). */
  openOnClick?: boolean;
  /** Between the header and the rows: a search's notes, its «Спросить ИИ», a loading or empty state. */
  before?: ReactNode;
  /** After the rows: «Показать ещё», the source. */
  after?: ReactNode;
  /** Shown instead of rows (an empty branch, a search without results). */
  empty?: ReactNode;
  busy?: boolean;
}

const docHref = (id: string) => `/documents/${encodeURIComponent(id)}`;

export function BranchList({
  parentLabel,
  title,
  count,
  rows,
  selected,
  order,
  onOrder,
  action,
  onPreview,
  openOnClick = false,
  before,
  after,
  empty,
  busy = false,
}: BranchListProps) {
  const idBase = useId();
  const navigate = useNavigate();
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLAnchorElement>());
  const ids = rows.map((row) => row.id);
  // One tab stop: the row last focused, else the selected one, else the first.
  const tabStop = focusId && ids.includes(focusId) ? focusId : selected && ids.includes(selected) ? selected : ids[0];
  // One source for every row: said once under the list; mixed sources: on every row.
  const sources = new Set(rows.map((row) => row.source));
  const singleSource = sources.size === 1 ? rows[0]?.source : null;

  // The selected row given from outside (the URL, the tree) is scrolled into view in the list too.
  useEffect(() => {
    if (selected) refs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function focusRow(id: string | undefined) {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  }

  function onClick(event: MouseEvent<HTMLAnchorElement>, id: string) {
    // A new tab or window (modifier, middle button) stays the browser's; a plain click previews.
    if (openOnClick || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setFocusId(id);
    onPreview(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>, id: string) {
    const position = ids.indexOf(id);
    const go = (target: string | undefined) => {
      event.preventDefault();
      focusRow(target);
    };
    switch (event.key) {
      case "ArrowDown":
        go(ids[Math.min(position + 1, ids.length - 1)]);
        return;
      case "ArrowUp":
        go(ids[Math.max(position - 1, 0)]);
        return;
      case "Home":
        go(ids[0]);
        return;
      case "End":
        go(ids[ids.length - 1]);
        return;
      case " ":
        event.preventDefault();
        onPreview(id);
        return;
      case "Enter":
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(docHref(id));
        return;
      default:
    }
  }

  const orderMenu =
    order && onOrder ? (
      <Menu
        label="Порядок документов"
        align="end"
        className="docs-branch__order-menu"
        groups={[
          {
            radio: true,
            items: LIST_ORDERS.map((value) => ({
              id: value,
              label: ORDER_LABEL[value],
              checked: order === value,
              onSelect: () => onOrder(value),
            })),
          },
        ]}
        trigger={(props) => (
          <button {...props} type="button" className={buttonClass("quiet", "sm", "docs-branch__order")}>
            <span className="docs-branch__order-label">{ORDER_LABEL[order]}</span>
            <Icon name="chevron" size={14} />
          </button>
        )}
      />
    ) : null;

  return (
    <section className="docs-branch" aria-labelledby={`${idBase}-title`} aria-busy={busy}>
      <div className="docs-branch__head">
        {parentLabel ? (
          <>
            <span className="docs-branch__parent">{parentLabel}</span>
            <span className="docs-branch__sep" aria-hidden="true">
              /
            </span>
          </>
        ) : null}
        <h2 id={`${idBase}-title`} className="docs-branch__title" title={title}>
          {parentLabel ? <span className="visually-hidden">{parentLabel} / </span> : null}
          {title}
        </h2>
        <span className="docs-branch__count" aria-label={`${count} ${pluralRu(count, "документ", "документа", "документов")}`}>
          {count}
        </span>
        {orderMenu}
        {action ? <span className="docs-branch__action">{action}</span> : null}
      </div>
      {before}
      {rows.length === 0 ? (
        empty
      ) : (
        <ul className={rows.length > LONG_LIST ? "docs-list docs-list--long" : "docs-list"} aria-labelledby={`${idBase}-title`}>
          {rows.map((row) => {
            const rowId = `${idBase}-${row.id}`;
            const isSelected = row.id === selected;
            const described = [row.summary || row.highlights ? `${rowId}-summary` : "", `${rowId}-meta`, row.reasons?.length ? `${rowId}-why` : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <li key={row.id} className="docs-list__item">
                <Link
                  ref={(element) => {
                    if (element) refs.current.set(row.id, element);
                    else refs.current.delete(row.id);
                  }}
                  to={docHref(row.id)}
                  className={["docs-row", isSelected ? "docs-row--selected" : "", row.status === "deprecated" ? "docs-row--deprecated" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={row.status === "approved" ? row.title : `${row.title}, ${STATUS_LABEL[row.status]}`}
                  aria-describedby={described}
                  tabIndex={row.id === tabStop ? 0 : -1}
                  onClick={(event) => onClick(event, row.id)}
                  onDoubleClick={() => navigate(docHref(row.id))}
                  onKeyDown={(event) => onKeyDown(event, row.id)}
                  onFocus={() => setFocusId(row.id)}
                >
                  <span className="docs-row__line">
                    <span className="docs-row__title">{row.title}</span>
                    {row.relatedVia ? (
                      <span className="related-via" title="Найден через объявленную связь, а не по своему тексту">
                        Связан с {row.relatedVia}
                      </span>
                    ) : null}
                    {row.indexStale ? <StaleMark /> : null}
                    {row.status !== "approved" ? <StatusMark status={row.status} className="docs-row__status" /> : null}
                  </span>
                  {row.highlights ? (
                    <span id={`${rowId}-summary`} className="docs-row__summary docs-row__summary--snippet">
                      <Highlighted segments={row.highlights} />
                    </span>
                  ) : row.summary ? (
                    <span id={`${rowId}-summary`} className="docs-row__summary">
                      {row.summary}
                    </span>
                  ) : null}
                  <span id={`${rowId}-meta`} className="docs-row__meta">
                    <span className="docs-row__id">{row.id}</span>
                    {row.systems.length > 0 ? <span className="docs-row__systems">{row.systems.join(", ")}</span> : null}
                    {row.ownerMissing ? <span className="docs-row__flag">без владельца</span> : null}
                    {singleSource ? (
                      <span className="visually-hidden">Источник: {SOURCE_LABEL[row.source]}</span>
                    ) : (
                      <span className="docs-row__source">{SOURCE_LABEL[row.source]}</span>
                    )}
                    <span className={`docs-row__review docs-row__review--${row.review.tone}`} title={row.review.description}>
                      <span className="visually-hidden">{row.review.description}</span>
                      <span aria-hidden="true">{row.review.text}</span>
                    </span>
                  </span>
                  {row.reasons && row.reasons.length > 0 ? (
                    <span id={`${rowId}-why`} className="docs-row__why">
                      Почему найдено: {row.reasons.join("; ")}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {after}
      {singleSource && rows.length > 0 ? <p className="docs-branch__source">Источник: {SOURCE_LABEL[singleSource]}</p> : null}
    </section>
  );
}
