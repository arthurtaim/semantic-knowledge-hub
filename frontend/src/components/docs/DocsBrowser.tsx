import { useId, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { DocumentPage, DocumentSummary } from "../../api/types";
import { canAsk } from "../../lib/aiMode";
import {
  ALL_NODE,
  ATTENTION_NODE,
  knownNode,
  parseOrder,
  reviewMark,
  sortIds,
  type ListOrder,
  type TreeIndex,
} from "../../lib/docTree";
import { DOC_PARAM, NODE_PARAM, ORDER_PARAM, queryOf, searchChanges, withParams } from "../../lib/docsView";
import { pluralRu } from "../../lib/labels";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/useAsync";
import type { DocumentTreeState } from "../../lib/useDocumentTree";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { EmptyState, ErrorState, Loading, Notice } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button, buttonClass, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { askAboutResults } from "./DocsCatalog";
import { BranchList, type BranchRowData } from "./BranchList";
import { DocPreview } from "./DocPreview";
import { DocTree } from "./DocTree";

/*
 * «Список» of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §1, design docs-01 / docs-02): the tree,
 * the documents of the chosen branch (or the results of the toolbar search over the whole base) and the preview
 * of the chosen document. Node, document, order and search live in the URL (lib/docsView.ts).
 *
 * Widths (the next slice refines them): from 1280 px three columns; below, the preview is a sheet over the page
 * once a document is chosen; below 960 px one screen at a time — the tree, then the list of the chosen branch
 * (a document opens its page).
 */

/** The preview is a column from this width, a sheet below it. */
const PREVIEW_SHEET = "(max-width: 1279.98px)";
/** One screen at a time below this width. */
const SINGLE_SCREEN = "(max-width: 959.98px)";
/** The API's page size: a search shows this many results at a time («Показать ещё» for more). */
const SEARCH_PAGE = 100;

function rowFromSummary(doc: DocumentSummary): BranchRowData {
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    summary: doc.summary ?? null,
    highlights: doc.highlights ?? null,
    systems: doc.systems ?? [],
    review: reviewMark(doc),
    ownerMissing: doc.owner_missing,
    indexStale: doc.index_state === "stale",
    source: doc.source,
    reasons: doc.match_reasons ?? null,
    relatedVia: doc.related_via ?? null,
  };
}

function branchRows(index: TreeIndex, node: string, order: ListOrder): BranchRowData[] {
  const documents = index.tree.documents;
  const ids = index.nodes.get(node)?.allDocIds ?? [];
  return sortIds(ids, documents, order).map((id) => {
    const entry = documents[id];
    if (!entry) throw new Error(`unknown document ${id}`); // sortIds keeps known documents only
    return {
      id,
      title: entry.title,
      status: entry.status,
      summary: entry.summary,
      systems: entry.systems,
      review: reviewMark(entry),
      ownerMissing: entry.owner_missing,
      indexStale: entry.index_state === "stale",
      source: entry.source,
    };
  });
}

/** One search over the whole base: the first page at once, the next ones on «Показать ещё» (no paging UI). */
function useSearch(query: string) {
  const first = useAsync<DocumentPage | null>(
    () => (query ? api.documents({ query, page: 1, size: SEARCH_PAGE }) : Promise.resolve(null)),
    `search|${query}`,
  );
  const [more, setMore] = useState<{ query: string; page: number; items: DocumentSummary[]; loading: boolean }>({
    query: "",
    page: 1,
    items: [],
    loading: false,
  });
  const extra = more.query === query ? more : { query, page: 1, items: [], loading: false };

  async function loadMore() {
    const page = extra.page + 1;
    setMore({ ...extra, loading: true });
    try {
      const next = await api.documents({ query, page, size: SEARCH_PAGE });
      setMore((current) => (current.query === query ? { query, page, items: [...current.items, ...next.items], loading: false } : current));
    } catch {
      setMore((current) => ({ ...current, loading: false }));
    }
  }

  const seen = new Set<string>();
  const items = [...(first.data?.items ?? []), ...extra.items].filter((doc) => !seen.has(doc.id) && Boolean(seen.add(doc.id)));
  return { first, items, total: first.data?.total ?? 0, loadingMore: extra.loading, loadMore };
}

export function DocsBrowser({ tree, notice }: { tree: DocumentTreeState; notice?: ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const sheetId = useId();
  const query = queryOf(params);
  const index = tree.index;
  const node = index ? knownNode(index, params.get(NODE_PARAM)) : (params.get(NODE_PARAM) ?? ALL_NODE);
  const doc = params.get(DOC_PARAM);
  const order = parseOrder(params.get(ORDER_PARAM));
  const sheetPreview = useMediaQuery(PREVIEW_SHEET);
  const single = useMediaQuery(SINGLE_SCREEN);
  const panelMode = useSidePanelMode(true);
  const aiOn = canAsk(session?.features.ai_mode);
  // Below 1280 px the preview is a sheet the reader opens by choosing a document (never by itself on arrival).
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const search = useSearch(query);

  function update(changes: Record<string, string | null>) {
    setParams(withParams(params, changes));
  }

  function selectNode(key: string) {
    update({ [NODE_PARAM]: key });
  }

  /** A document from the tree: the list follows it to its branch (unless it shows all or those needing attention). */
  function selectFromTree(id: string) {
    if (single) {
      navigate(`/documents/${encodeURIComponent(id)}`);
      return;
    }
    const holder = index?.nodeOfDoc.get(id);
    const keep = node === ALL_NODE || node === ATTENTION_NODE || query;
    update({ [DOC_PARAM]: id, ...(keep || !holder ? {} : { [NODE_PARAM]: holder }) });
    if (sheetPreview) setSheetFor(id);
  }

  function preview(id: string) {
    update({ [DOC_PARAM]: id });
    if (sheetPreview) setSheetFor(id);
  }

  const nodeData = index?.nodes.get(node);
  const parent = nodeData?.parent ? index?.nodes.get(nodeData.parent) : undefined;

  let middle: ReactNode;
  if (query) {
    const total = search.total;
    const rows = search.items.map(rowFromSummary);
    const ask =
      aiOn && rows.length > 0 ? (
        <Link to={askAboutResults(query, rows.map((r) => r.id))} className={buttonClass("quiet", "sm", "docs-branch__ask")}>
          Спросить ИИ об этих документах
        </Link>
      ) : null;
    middle = (
      <BranchList
        parentLabel={null}
        title={`Результаты: «${query}»`}
        count={total}
        rows={rows}
        selected={doc}
        action={<IconButton icon="close" label="Сбросить поиск" size="sm" onClick={() => update(searchChanges(""))} />}
        onPreview={preview}
        openOnClick={single}
        busy={search.first.loading}
        before={
          <>
            <p className="visually-hidden" aria-live="polite">
              {search.first.loading
                ? "Поиск…"
                : `${total} ${pluralRu(total, "документ", "документа", "документов")} по запросу «${query}»`}
            </p>
            {search.first.error ? <ErrorState error={search.first.error} onRetry={search.first.reload} /> : null}
            {search.first.data?.notes && search.first.data.notes.length > 0 ? (
              <Notice tone="info" className="docs-branch__notes">
                <ul>
                  {search.first.data.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            {ask ? <div className="docs-branch__tools">{ask}</div> : null}
            {search.first.loading && !search.first.data ? <Loading /> : null}
          </>
        }
        empty={
          search.first.data && !search.first.loading ? (
            <EmptyState title={`По запросу «${query}» ничего не найдено`}>
              <p>Проверьте написание или попробуйте другое слово. Поиск ищет по названию, тексту, тегам и связанным ID.</p>
            </EmptyState>
          ) : null
        }
        after={
          rows.length < total ? (
            <div className="docs-branch__more">
              <Button size="sm" onClick={() => void search.loadMore()} disabled={search.loadingMore}>
                {search.loadingMore ? "Загружаем…" : `Показать ещё ${Math.min(SEARCH_PAGE, total - rows.length)}`}
              </Button>
            </div>
          ) : null
        }
      />
    );
  } else if (index && nodeData) {
    middle = (
      <BranchList
        parentLabel={parent?.label ?? null}
        title={nodeData.label}
        count={nodeData.count}
        rows={branchRows(index, node, order)}
        selected={doc}
        order={order}
        onOrder={(next) => update({ [ORDER_PARAM]: next === "attention" ? null : next })}
        onPreview={preview}
        openOnClick={single}
        empty={<p className="docs-branch__empty">В этой ветке нет документов.</p>}
      />
    );
  } else {
    middle = tree.error ? <ErrorState error={tree.error} onRetry={tree.reload} /> : <Loading />;
  }

  const treeColumn = index ? (
    <DocTree index={index} node={node} doc={doc} onSelectNode={selectNode} onSelectDoc={selectFromTree} />
  ) : tree.error ? (
    <ErrorState error={tree.error} onRetry={tree.reload} />
  ) : (
    <Loading />
  );

  // One screen at a time: the tree until a branch (or a search) is chosen, then its list.
  if (single) {
    const showList = Boolean(query) || params.has(NODE_PARAM);
    return (
      <div className="docs-browser docs-browser--single">
        {notice}
        {showList ? (
          <>
            {!query ? (
              <Button variant="quiet" size="sm" className="docs-browser__back" onClick={() => update({ [NODE_PARAM]: null, [DOC_PARAM]: null })}>
                <Icon name="chevron" size={14} className="docs-browser__back-icon" />
                Разделы
              </Button>
            ) : null}
            {middle}
          </>
        ) : (
          treeColumn
        )}
      </div>
    );
  }

  const previewBody = doc ? (
    <DocPreview id={doc} index={index} canAskAssistant={aiOn} />
  ) : (
    <p className="doc-preview__placeholder">Выберите документ в дереве или в списке — здесь появится его описание.</p>
  );

  return (
    <div className={sheetPreview ? "docs-browser docs-browser--two" : "docs-browser"}>
      {notice ? <div className="docs-browser__notice">{notice}</div> : null}
      <div className="docs-browser__columns">
        <div className="docs-browser__tree">{treeColumn}</div>
        <div className="docs-browser__list">{middle}</div>
        {sheetPreview ? null : (
          <section className="docs-browser__preview" aria-label="Просмотр документа">
            {previewBody}
          </section>
        )}
      </div>
      {sheetPreview && doc && sheetFor === doc ? (
        <SidePanel id={`${sheetId}-preview`} title="Просмотр документа" mode={panelMode} onClose={() => setSheetFor(null)}>
          <DocPreview id={doc} index={index} canAskAssistant={aiOn} />
        </SidePanel>
      ) : null}
    </div>
  );
}
