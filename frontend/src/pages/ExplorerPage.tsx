import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { DocsBrowser } from "../components/docs/DocsBrowser";
import { DocsCatalog } from "../components/docs/DocsCatalog";
import { DocsOverview } from "../components/docs/DocsOverview";
import { IndexStatusNotice } from "../components/IndexStatusNotice";
import { PageToolbar } from "../components/shell/PageToolbar";
import { buttonClass } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { graphHref } from "../lib/catalog";
import {
  DOCS_VIEWS,
  queryOf,
  rememberDocsView,
  resolveView,
  searchChanges,
  VIEW_LABEL,
  VIEW_PARAM,
  withParams,
  type DocsView,
} from "../lib/docsView";
import { useAsync } from "../lib/useAsync";
import { useDocumentTree } from "../lib/useDocumentTree";
import { useMediaQuery } from "../lib/useMediaQuery";

/** The view switch and the search field leave the toolbar below this width. */
const COMPACT_TOOLBAR = "(max-width: 1279.98px)";
/** Typing in the search field updates the results after this pause (Enter at once). */
const SEARCH_DELAY_MS = 300;

/**
 * `/documents` — «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md): the toolbar with Обзор | Список |
 * Таблица | Карта, the search field and «Создать документ», then the chosen view. The view, the tree node, the
 * previewed document, the search and the table's filters live in the URL (lib/docsView.ts), so a link can be
 * shared and «Назад» walks back; the chosen view is also remembered in this browser. «Список» is the default.
 */
export function ExplorerPage() {
  const [params, setParams] = useSearchParams();
  const view = resolveView(params);
  const query = queryOf(params);
  const [draftQuery, setDraftQuery] = useState(query);
  const compact = useMediaQuery(COMPACT_TOOLBAR);
  const tree = useDocumentTree();
  const index = useAsync(() => api.indexStatus(), "index-status");
  const typing = useRef<number | undefined>(undefined);

  // The URL changed (Назад, a chip, a link): the field follows — unless it only differs by spaces still being typed.
  useEffect(() => setDraftQuery((draft) => (draft.trim() === query ? draft : query)), [query]);
  useEffect(() => () => window.clearTimeout(typing.current), []);
  // The URL always names the view on screen (replacing the entry): a shared link opens the same view for a
  // colleague whatever they chose before, and «Назад» returns to what was shown, not to the remembered choice.
  useEffect(() => {
    if (params.get(VIEW_PARAM) !== view) setParams(withParams(params, { [VIEW_PARAM]: view }), { replace: true });
  }, [params, view, setParams]);

  function chooseView(next: DocsView) {
    rememberDocsView(next);
    if (next === view) return;
    // Pages of the list and of the table do not line up.
    setParams(withParams(params, { [VIEW_PARAM]: next, page: null }));
  }

  function search(text: string, replace: boolean) {
    window.clearTimeout(typing.current);
    if (text.trim() === query) return;
    setParams(withParams(params, searchChanges(text)), { replace });
  }

  function onType(text: string) {
    setDraftQuery(text);
    window.clearTimeout(typing.current);
    typing.current = window.setTimeout(() => search(text, true), SEARCH_DELAY_MS);
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    search(draftQuery, false);
  }

  const notice = index.data ? <IndexStatusNotice status={index.data} /> : null;

  const viewSwitch = (
    <div className="view-switch" role="group" aria-label="Вид раздела">
      {DOCS_VIEWS.map((option) => (
        <button
          key={option}
          type="button"
          className="view-switch__item"
          aria-pressed={view === option}
          onClick={() => chooseView(option)}
        >
          {VIEW_LABEL[option]}
        </button>
      ))}
      <Link to={graphHref(params)} className="view-switch__item">
        Карта
      </Link>
    </div>
  );

  // The overview has nothing to search (design docs-03); the list and the table search the whole base.
  const searchForm =
    view === "overview" ? null : (
      <form className="catalog-search" role="search" onSubmit={onSearch}>
        <label htmlFor="docs-search" className="visually-hidden">
          Найти в документах
        </label>
        <Icon name="search" className="catalog-search__icon" />
        <input
          id="docs-search"
          type="search"
          value={draftQuery}
          onChange={(e) => onType(e.target.value)}
          placeholder="Название, ID, тег или система"
          title="Название, текст, теги, системы, связанные ID"
          maxLength={200}
          autoComplete="off"
        />
      </form>
    );

  return (
    <div className={`catalog docs docs--${view}`}>
      <PageToolbar
        title="Документы"
        meta={compact ? null : viewSwitch}
        actions={
          <>
            {compact ? null : searchForm}
            <Link to="/documents/new" className={buttonClass("primary", "md", "button--collapsible button--with-icon")}>
              <Icon name="plus" />
              <span className="button__label">Создать документ</span>
            </Link>
          </>
        }
      />
      {/* The toolbar names the page; the heading keeps the page outline for assistive technology. */}
      <h1 className="visually-hidden">Документы</h1>

      {compact ? (
        <div className="catalog__top">
          {viewSwitch}
          {searchForm}
        </div>
      ) : null}

      {view === "overview" ? (
        <DocsOverview tree={tree} notice={notice} />
      ) : view === "list" ? (
        <DocsBrowser tree={tree} notice={notice} />
      ) : (
        <DocsCatalog flush={!compact} notice={notice} />
      )}
    </div>
  );
}
