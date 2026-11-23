import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { GraphNode, Subgraph } from "../api/types";
import { GraphCanvas } from "../components/GraphCanvas";
import { GraphLegendView, GraphListView, NodeDetails } from "../components/GraphDetails";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import {
  filterGraph,
  graphFiltersFrom,
  graphLabels,
  graphModeFrom,
  KIND_ORDER,
  layoutGraph,
  mergeSubgraphs,
  nodeDisplayId,
  focusParam,
  RELATION_LABEL,
  TRACE_PATTERN,
  type GraphFilters,
  type GraphMode,
  type Point,
} from "../lib/graph";
import { formatDateTime, pluralRu, STATUS_LABEL, STATUS_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { useMediaQuery } from "../lib/useMediaQuery";

/** Below this width the list is the default view (same breakpoint as the one-column layouts). */
const NARROW = "(max-width: 860px)";
const OVERVIEW_LIMIT = 150;
const NEIGHBOURS_PAGE = 100;
const TEMPORARY_KINDS = new Set(["external_page", "query_context"]);
const TRACE_RELATIONS = new Set(["retrieved_for", "cited_in"]);

const TRACE_UNAVAILABLE = "След ответа недоступен: срок хранения истёк или данные удалены";

function modeKey(mode: GraphMode, filters: GraphFilters): string {
  if (mode.kind === "global") return `global|${filters.kind}|${filters.relation}|${filters.status}`;
  if (mode.kind === "local") return `local|${mode.focus}|${mode.depth}|${filters.relation}`;
  return `trace|${mode.trace}`;
}

/** Overview filters run on the server; a neighbourhood is filtered by relation there, the rest on the client. */
function loadGraph(mode: GraphMode, filters: GraphFilters): Promise<Subgraph> {
  if (mode.kind === "global") {
    return api.graphOverview({
      limit: OVERVIEW_LIMIT,
      kind: filters.kind || undefined,
      relation: filters.relation || undefined,
      status: filters.status || undefined,
    });
  }
  if (mode.kind === "local") {
    return api.graphNeighbours(mode.focus, { depth: mode.depth, relation: filters.relation || undefined, limit: NEIGHBOURS_PAGE });
  }
  if (!TRACE_PATTERN.test(mode.trace)) {
    return Promise.reject(new ApiError(404, "trace_not_found", "Ссылка на след ответа повреждена.", null));
  }
  return api.graphQuery(mode.trace);
}

function errorTitle(error: ApiError): string | undefined {
  if (error.code === "trace_not_found") return TRACE_UNAVAILABLE;
  if (error.code === "graph_node_not_found") return "Узел графа не найден";
  if (error.code === "discovery_disabled") return "Память поиска отключена";
  if (error.code === "invalid_filter") return "Недопустимый фильтр";
  return undefined;
}

interface SearchState {
  key: string;
  matches: string[];
  message: string;
  remote: GraphNode[];
}

const NO_SEARCH: SearchState = { key: "", matches: [], message: "", remote: [] };
/** Stable empty value: a fresh `[]` on every render would recompute the merged graph and its layout. */
const NO_PAGES: Subgraph[] = [];

/**
 * `/graph` — the knowledge graph. Three modes, all in the URL (shareable, back/forward works):
 * global `/graph`, a neighbourhood `/graph?focus=ID&depth=1|2`, the evidence of one answer `/graph?trace=TRACE-…`.
 */
export function GraphPage() {
  const [params, setParams] = useSearchParams();
  const mode = graphModeFrom(params);
  const filters = graphFiltersFrom(params);
  const key = modeKey(mode, filters);
  const narrow = useMediaQuery(NARROW);
  const [viewChoice, setViewChoice] = useState<"graph" | "list" | null>(null);
  const view = viewChoice ?? (narrow ? "list" : "graph");

  const legend = useAsync(() => api.graphLegend(), "graph-legend");
  const labels = useMemo(() => graphLabels(legend.data), [legend.data]);
  const graph = useAsync(() => loadGraph(mode, filters), key);

  // Further pages of neighbours («Показать соседей»); they belong to one mode key.
  const [extra, setExtra] = useState<{ key: string; pages: Subgraph[] }>({ key, pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const pages = extra.key === key ? extra.pages : NO_PAGES;
  const merged = useMemo(() => (graph.data ? mergeSubgraphs(graph.data, pages) : null), [graph.data, pages]);

  const center =
    mode.kind === "local"
      ? mode.focus
      : mode.kind === "trace"
        ? (merged?.focus ?? merged?.nodes.find((n) => n.kind === "query_context")?.id ?? null)
        : null;
  const visible = useMemo(
    () => (merged ? filterGraph(merged.nodes, merged.edges, filters, center) : { nodes: [], edges: [] }),
    // `filters` is derived from the URL on every render; its fields are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [merged, filters.kind, filters.relation, filters.status, center],
  );
  const byId = useMemo(() => new Map(visible.nodes.map((n) => [n.id, n])), [visible]);

  // Layout only for the drawn view. Within one mode, nodes already shown keep their place (after «Показать
  // соседей» or a client-side filter); a new mode always starts from the deterministic initial layout.
  const previousPositions = useRef<{ key: string; positions: Map<string, Point> } | null>(null);
  const layout = useMemo(() => {
    if (view !== "graph") return null;
    const previous = previousPositions.current?.key === key ? previousPositions.current.positions : undefined;
    return layoutGraph(visible.nodes, visible.edges, center, previous);
  }, [view, visible, center, key]);
  useEffect(() => {
    if (layout) previousPositions.current = { key, positions: layout.positions };
  }, [layout, key]);

  // Selection: the centre node by default (its links explain the neighbourhood / the answer).
  const [selection, setSelection] = useState<{ key: string; id: string | null }>({ key: "", id: null });
  const selectedId = selection.key === key ? selection.id : center;
  const selectedNode = selectedId ? (byId.get(selectedId) ?? null) : null;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);

  const [search, setSearch] = useState("");
  const [searchState, setSearchState] = useState<SearchState>(NO_SEARCH);
  const current = searchState.key === key ? searchState : NO_SEARCH;
  const matches = useMemo(() => new Set(current.matches), [current.matches]);

  function select(id: string | null, moveFocus = false) {
    setSelection({ key, id });
    // From the list, move to the details (on phones they are below the list); on the canvas focus stays.
    if (id && moveFocus) requestAnimationFrame(() => headingRef.current?.focus());
  }

  function setFilter(name: keyof GraphFilters, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  function resetFilters() {
    const next = new URLSearchParams(params);
    for (const name of ["kind", "relation", "status"]) next.delete(name);
    setParams(next, { replace: true });
  }

  function setDepth(depth: 1 | 2) {
    if (mode.kind !== "local") return;
    const next = new URLSearchParams(params);
    next.set("depth", String(depth));
    setParams(next);
  }

  async function loadMore() {
    if (mode.kind !== "local" || merged?.next_cursor == null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.graphNeighbours(mode.focus, {
        depth: mode.depth,
        relation: filters.relation || undefined,
        limit: NEIGHBOURS_PAGE,
        cursor: merged.next_cursor,
      });
      setExtra((previous) => ({ key, pages: [...(previous.key === key ? previous.pages : []), page] }));
    } catch (err) {
      setMoreError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
    } finally {
      setLoadingMore(false);
    }
  }

  async function onSearch(event: FormEvent) {
    event.preventDefault();
    const raw = search.trim();
    const term = raw.toLocaleLowerCase("ru");
    if (!term) {
      setSearchState(NO_SEARCH);
      return;
    }
    const found = visible.nodes.filter(
      (n) => n.label.toLocaleLowerCase("ru").includes(term) || nodeDisplayId(n).toLocaleLowerCase("ru").includes(term),
    );
    const first = found[0];
    if (first) {
      setSearchState({
        key,
        matches: found.map((n) => n.id),
        message: `${pluralRu(found.length, "Найден", "Найдено", "Найдено")} ${found.length} ${pluralRu(found.length, "узел", "узла", "узлов")}: выбран «${first.label}».`,
        remote: [],
      });
      setSelection({ key, id: first.id });
      setFocusRequest({ id: first.id, nonce: Date.now() });
      return;
    }
    if (mode.kind === "global" && merged?.partial) {
      try {
        const remote = await api.graphOverview({ q: raw, limit: 10 });
        setSearchState({
          key,
          matches: [],
          message:
            remote.nodes.length > 0
              ? "В показанной части графа совпадений нет. Совпадения в базе знаний — откройте окружение узла:"
              : "Узлы с таким названием или ID не найдены.",
          remote: remote.nodes,
        });
      } catch (err) {
        const error = err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
        setSearchState({ key, matches: [], message: `Поиск по всему графу не выполнен: ${error.message}`, remote: [] });
      }
      return;
    }
    setSearchState({ key, matches: [], message: "В показанной части графа узлы с таким названием или ID не найдены.", remote: [] });
  }

  const kindOptions = KIND_ORDER.filter((k) => mode.kind === "trace" || !TEMPORARY_KINDS.has(k));
  const relationOptions = Object.keys(legend.data?.relations ?? RELATION_LABEL).filter(
    (r) => mode.kind === "trace" || !TRACE_RELATIONS.has(r),
  );
  const hasFilters = Boolean(filters.kind || filters.relation || filters.status);
  const focusNode = mode.kind === "local" ? (merged?.nodes.find((n) => n.id === mode.focus) ?? null) : null;
  const queryNode = mode.kind === "trace" ? (merged?.nodes.find((n) => n.kind === "query_context") ?? null) : null;
  const canLoadMore = mode.kind === "local" && merged?.next_cursor != null;

  return (
    <div className="graph-page">
      {mode.kind !== "global" ? (
        <nav className="breadcrumbs" aria-label="Путь">
          <Link to="/graph">Граф знаний</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">
            {mode.kind === "local" ? `Окружение ${focusNode ? nodeDisplayId(focusNode) : mode.focus.replace(/^doc:/, "")}` : "Граф ответа"}
          </span>
        </nav>
      ) : null}
      <div className="page-head">
        <h1>{mode.kind === "trace" ? "Граф ответа" : "Граф знаний"}</h1>
        {mode.kind === "global" ? (
          <p className="lead">
            Связи документов команды, объявленные в их метаданных: что на что ссылается, от чего зависит, что описывает.
            Сначала показаны самые связанные узлы; остальные — через поиск и окружение узла.
          </p>
        ) : null}
        {mode.kind === "local" ? (
          <p className="lead">
            Окружение узла {focusNode ? <>«{focusNode.label}»</> : <code className="doc-id">{mode.focus}</code>}: связи глубиной{" "}
            {mode.depth === 1 ? "в один шаг" : "в два шага"}. <Link to="/graph">Весь граф</Link>
          </p>
        ) : null}
        {mode.kind === "trace" ? (
          <p className="lead">
            Какие источники нашлись для вопроса, какие из них процитированы в ответе и с чем они связаны в базе знаний. Текст
            вопроса не хранится — узел вопроса подписан ключевыми словами.
            {queryNode?.expires_at ? ` След хранится до ${formatDateTime(queryNode.expires_at)}.` : ""}
          </p>
        ) : null}
      </div>

      <div className="graph-toolbar">
        <form className="graph-toolbar__search" role="search" onSubmit={(e) => void onSearch(e)}>
          <label htmlFor="graph-search">Найти узел</label>
          <div className="graph-toolbar__search-row">
            <input
              id="graph-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={100}
              autoComplete="off"
              placeholder="Название или ID"
            />
            <button type="submit" className="button button--primary">
              Найти
            </button>
          </div>
        </form>
        <div className="graph-toolbar__filters" role="group" aria-label="Фильтры графа">
          <div className="graph-toolbar__field">
            <label htmlFor="graph-kind">Тип узла</label>
            <select id="graph-kind" value={filters.kind} onChange={(e) => setFilter("kind", e.target.value)}>
              <option value="">Все</option>
              {kindOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {labels.kind(kind)}
                </option>
              ))}
            </select>
          </div>
          <div className="graph-toolbar__field">
            <label htmlFor="graph-relation">Тип связи</label>
            <select id="graph-relation" value={filters.relation} onChange={(e) => setFilter("relation", e.target.value)}>
              <option value="">Все</option>
              {relationOptions.map((relation) => (
                <option key={relation} value={relation}>
                  {labels.relation(relation)}
                </option>
              ))}
            </select>
          </div>
          <div className="graph-toolbar__field">
            <label htmlFor="graph-status">Статус</label>
            <select id="graph-status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
              <option value="">Все</option>
              {STATUS_ORDER.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </div>
          {hasFilters ? (
            <button type="button" className="button button--quiet graph-toolbar__reset" onClick={resetFilters}>
              Сбросить фильтры
            </button>
          ) : null}
        </div>
        <div className="graph-toolbar__modes">
          {mode.kind === "local" ? (
            <fieldset className="segmented">
              <legend>Глубина</legend>
              {([1, 2] as const).map((depth) => (
                <label key={depth} className="segmented__option">
                  <input type="radio" name="graph-depth" checked={mode.depth === depth} onChange={() => setDepth(depth)} />
                  <span>{depth === 1 ? "1 шаг" : "2 шага"}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <fieldset className="segmented">
            <legend>Вид</legend>
            <label className="segmented__option">
              <input type="radio" name="graph-view" checked={view === "graph"} onChange={() => setViewChoice("graph")} />
              <span>Схема</span>
            </label>
            <label className="segmented__option">
              <input type="radio" name="graph-view" checked={view === "list"} onChange={() => setViewChoice("list")} />
              <span>Списком</span>
            </label>
          </fieldset>
        </div>
      </div>

      <div aria-live="polite" role="status" className="graph-search-status">
        {current.message ? <p>{current.message}</p> : null}
      </div>
      {current.remote.length > 0 ? (
        <ul className="graph-remote">
          {current.remote.map((node) => (
            <li key={node.id}>
              <Link to={`/graph?focus=${encodeURIComponent(focusParam(node))}`}>{node.label}</Link>{" "}
              <code className="doc-id">{nodeDisplayId(node)}</code>
            </li>
          ))}
        </ul>
      ) : null}

      {graph.loading && !graph.data ? <Loading label="Загрузка графа…" /> : null}
      {graph.error ? (
        <div className="stack">
          <ErrorState
            error={graph.error}
            title={errorTitle(graph.error)}
            onRetry={graph.error.status === 0 || graph.error.status >= 500 ? graph.reload : undefined}
          />
          {graph.error.code === "trace_not_found" ? (
            <p>
              Задайте вопрос ещё раз — у нового ответа будет свой граф.{" "}
              <Link to="/ask" className="text-link">
                Спросить базу знаний
              </Link>
            </p>
          ) : null}
          {mode.kind !== "global" ? (
            <Link to="/graph" className="text-link">
              Открыть весь граф
            </Link>
          ) : null}
        </div>
      ) : null}

      {merged && !graph.error ? (
        <>
          {merged.partial ? (
            <Notice tone="info" className="graph-partial">
              <p>
                Показана часть графа: {merged.nodes.length} из {merged.total_nodes}{" "}
                {pluralRu(merged.total_nodes, "узла", "узлов", "узлов")} — уточните фильтр или откройте окружение узла.
              </p>
              {canLoadMore ? (
                <button type="button" className="button button--secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? "Загружаем соседей…" : "Показать соседей ещё"}
                </button>
              ) : null}
            </Notice>
          ) : null}
          {moreError ? <ErrorState error={moreError} title="Не удалось загрузить соседей" /> : null}
          {visible.nodes.length === 0 ? (
            <EmptyState title="Узлов с такими фильтрами нет">
              <p>Измените или сбросьте фильтры.</p>
              {hasFilters ? (
                <button type="button" className="button button--secondary" onClick={resetFilters}>
                  Сбросить фильтры
                </button>
              ) : null}
            </EmptyState>
          ) : (
            <>
              {visible.edges.length === 0 ? (
                <Notice tone="info">
                  {mode.kind === "local"
                    ? "У этого узла нет связей: ни он сам, ни другие документы не объявили связей с ним (или их скрыл фильтр)."
                    : "Связей между показанными узлами нет — измените фильтр."}
                </Notice>
              ) : null}
              <div className="graph-layout">
                <section className="graph-stage" aria-label={view === "graph" ? "Схема графа" : "Граф списком"}>
                  {view === "graph" && layout ? (
                    <GraphCanvas
                      nodes={visible.nodes}
                      edges={visible.edges}
                      layout={layout}
                      center={center}
                      selectedId={selectedNode ? selectedNode.id : null}
                      matches={matches}
                      labels={labels}
                      onSelect={(id) => select(id)}
                      focusRequest={focusRequest}
                    />
                  ) : (
                    <GraphListView
                      nodes={visible.nodes}
                      edges={visible.edges}
                      labels={labels}
                      center={center}
                      selectedId={selectedNode ? selectedNode.id : null}
                      matches={matches}
                      onSelect={(id) => select(id, true)}
                      focusRequest={focusRequest}
                    />
                  )}
                </section>
                <aside className="graph-panel" aria-label="Сведения об узле">
                  {selectedNode ? (
                    <NodeDetails
                      node={selectedNode}
                      byId={byId}
                      edges={visible.edges}
                      labels={labels}
                      isFocus={mode.kind === "local" && selectedNode.id === mode.focus}
                      canLoadMore={canLoadMore}
                      loadingMore={loadingMore}
                      onLoadMore={() => void loadMore()}
                      onSelect={(id) => select(id, true)}
                      headingRef={headingRef}
                    />
                  ) : (
                    <>
                      <h2 className="graph-details__title">Сведения об узле</h2>
                      <p className="muted">
                        Выберите узел на схеме или в списке: здесь появятся его метаданные и объяснение каждой связи —
                        кто её объявил, в каком поле и в какой ревизии.
                      </p>
                    </>
                  )}
                </aside>
              </div>
            </>
          )}
          <p className="graph-generation muted">
            Поколение графа: <code>{merged.generation}</code>
            {mode.kind === "trace" ? " · узлы и связи следа временные" : ""}
          </p>
        </>
      ) : null}

      <GraphLegendView
        labels={labels}
        kinds={mode.kind === "trace" ? KIND_ORDER : KIND_ORDER.filter((k) => !TEMPORARY_KINDS.has(k))}
        relations={relationOptions}
      />
    </div>
  );
}
