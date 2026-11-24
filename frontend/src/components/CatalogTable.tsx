import { useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { DocumentSummary } from "../api/types";
import { GROUP_LABEL, groupDocuments, type CatalogGroup } from "../lib/catalog";
import { pluralRu, REVIEW_LABEL, SOURCE_LABEL } from "../lib/labels";
import { StaleMark } from "./StaleMark";
import { Icon } from "./ui/Icon";
import { StatusMark } from "./ui/StatusMark";
import { When } from "./When";

interface CatalogTableProps {
  items: DocumentSummary[];
  group: CatalogGroup;
  /** All rows share one source: it is said once above the table, not per row. */
  singleSource: boolean;
  /** Cards instead of a table (phones). */
  cards?: boolean;
}

const docHref = (doc: DocumentSummary) => `/documents/${encodeURIComponent(doc.id)}`;

/** A press on the row (outside its link) opens the document; the title link stays the keyboard and AT path. */
function useRowOpen() {
  const navigate = useNavigate();
  return (doc: DocumentSummary) => (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return; // selecting text is not a click
    navigate(docHref(doc));
  };
}

function ReviewFlag({ doc }: { doc: DocumentSummary }) {
  return doc.review_state === "stale" || doc.review_state === "never_reviewed" ? (
    <span className="review-flag" title="Проверка документа">
      {REVIEW_LABEL[doc.review_state]}
    </span>
  ) : null;
}

/** «3 связи» / «нет связей» on a card; nothing when the list did not report a count. */
function linksText(count: number): string {
  return count === 0 ? "нет связей" : `${count} ${pluralRu(count, "связь", "связи", "связей")}`;
}

function TitleCell({ doc, singleSource }: { doc: DocumentSummary; singleSource: boolean }) {
  return (
    <>
      <Link to={docHref(doc)} className="catalog__title">
        {doc.title}
      </Link>
      <span className="catalog__id">
        <code className="doc-id">{doc.id}</code>
        {singleSource ? null : <span className="catalog__source">{SOURCE_LABEL[doc.source]}</span>}
      </span>
      {doc.index_state === "stale" ? <StaleMark /> : null}
    </>
  );
}

/**
 * The catalog table of design-05: Название (+ ID), Статус, Владелец, Обновлён, Связи; 42 px rows, 36 px group
 * headers with counts that collapse; the whole row opens the document. «Обновлён» is the document's own date
 * (`updated_at` in its metadata) — «—» without one, never the time the file was loaded or indexed. «Связи» is the
 * API's `link_count` — the same number as the document page's «Связи» (linked documents the reader can see); «—»
 * when it is not reported. A phone card leaves out what is unknown.
 */
export function CatalogTable({ items, group, singleSource, cards = false }: CatalogTableProps) {
  const groups = groupDocuments(items, group);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const open = useRowOpen();
  const grouped = group !== "none";

  function toggle(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // A render helper, not a nested component: the button must keep its identity (and focus) across toggles.
  function groupToggle(id: string, label: string, count: number) {
    const isOpen = !collapsed.has(id);
    return (
      <button type="button" className="catalog-group__toggle" aria-expanded={isOpen} onClick={() => toggle(id)}>
        <Icon name="chevron" size={14} className="catalog-group__chevron" />
        <span className="catalog-group__label">{label}</span>
        <span className="catalog-group__count">
          {count}
          <span className="visually-hidden"> {pluralRu(count, "документ", "документа", "документов")}</span>
        </span>
      </button>
    );
  }

  if (cards) {
    return (
      <div className="catalog-cards">
        {groups.map((g) => (
          <section key={g.key} className="catalog-cards__group" aria-label={grouped ? `${GROUP_LABEL[group]}: ${g.label}` : undefined}>
            {grouped ? (
              <h3 className="catalog-group catalog-group--card">
                {groupToggle(g.key, g.label, g.items.length)}
              </h3>
            ) : null}
            {collapsed.has(g.key) ? null : (
              <ul className="catalog-cards__list">
                {g.items.map((doc) => (
                  <li key={doc.id} className="catalog-card" onClick={open(doc)}>
                    <TitleCell doc={doc} singleSource={singleSource} />
                    <span className="catalog-card__meta">
                      <StatusMark status={doc.status} />
                      <ReviewFlag doc={doc} />
                      <span className={doc.owner_missing ? "flag" : undefined}>{doc.owner_missing ? "не назначен" : doc.owner}</span>
                      {doc.metadata_updated_at ? <When value={doc.metadata_updated_at} /> : null}
                      {doc.link_count != null ? <span className="catalog-card__links">{linksText(doc.link_count)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="catalog-table-wrap">
      <table className="catalog-table">
        <caption className="visually-hidden">
          Документы{grouped ? `, сгруппированные: ${GROUP_LABEL[group].toLocaleLowerCase("ru")}` : ""}
        </caption>
        <colgroup>
          <col />
          <col className="catalog-table__col-status" />
          <col className="catalog-table__col-owner" />
          <col className="catalog-table__col-updated" />
          <col className="catalog-table__col-links" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Название</th>
            <th scope="col">Статус</th>
            <th scope="col">Владелец</th>
            <th scope="col">Обновлён</th>
            <th scope="col" className="catalog-table__num" title="Связанные документы: ссылки из документа и на него">
              Связи
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            {grouped ? (
              <tr className="catalog-group">
                <th scope="rowgroup" colSpan={5}>
                  {groupToggle(g.key, g.label, g.items.length)}
                </th>
              </tr>
            ) : null}
            {collapsed.has(g.key)
              ? null
              : g.items.map((doc) => (
                  <tr key={doc.id} className="catalog-row" onClick={open(doc)}>
                    <td className="catalog-row__name">
                      <TitleCell doc={doc} singleSource={singleSource} />
                    </td>
                    <td>
                      <span className="catalog-row__status">
                        <StatusMark status={doc.status} />
                        <ReviewFlag doc={doc} />
                      </span>
                    </td>
                    <td className={doc.owner_missing ? "flag" : undefined}>{doc.owner_missing ? "не назначен" : doc.owner}</td>
                    <td className={doc.metadata_updated_at ? undefined : "catalog-row__none"}>
                      <When value={doc.metadata_updated_at} />
                    </td>
                    <td className={doc.link_count ? "catalog-table__num" : "catalog-table__num catalog-row__none"}>
                      {doc.link_count ?? "—"}
                    </td>
                  </tr>
                ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
