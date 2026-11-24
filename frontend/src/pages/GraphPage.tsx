import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { DocStatus, GraphNode, Subgraph } from "../api/types";
import { GraphCanvas } from "../components/GraphCanvas";
import { GraphLegendView, GraphListView, NodeDetails } from "../components/GraphDetails";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button, IconButton } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { Menu } from "../components/ui/Popover";
import {
  canExpand,
  filterGraph,
  focusParam,
  graphFiltersFrom,
  graphLabels,
  graphModeFrom,
  KIND_ORDER,
  layoutGraph,
  mergeSubgraphs,
  nodeDisplayId,
  RELATION_LABEL,
  TRACE_PATTERN,
  type GraphFilters,
  type GraphMode,
  type Point,
} from "../lib/graph";
import { readLastTrace, rememberTrace, useNodePositions } from "../lib/graphPositions";
import { formatDateTime, pluralRu, STATUS_LABEL, STATUS_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { useMediaQuery } from "../lib/useMediaQuery";

/** Below this width the list is the default view and the details open as a sheet from the bottom. */
const NARROW = "(max-width: 860px)";
const OVERVIEW_LIMIT = 150;
const NEIGHBOURS_PAGE = 100;
const TEMPORARY_KINDS = new Set(["external_page", "query_context"]);
const TRACE_RELATIONS = new Set(["retrieved_for", "cited_in"]);
const LOOK_STATUSES: DocStatus[] = ["draft", "in_review", "deprecated"];

const TRACE_UNAVAILABLE = "След ответа недоступен: срок хранения истёк или данные удалены";

/** What the server is asked for: a new key loads new data. */
function modeKey(mode: GraphMode, filters: GraphFilters): string {
  if (mode.kind === "global") return `global|${filters.kind}|${filters.relation}|${filters.status}`;
  if (mode.kind === "local") return `local|${mode.focus}|${mode.depth}|${filters.relation}`;
  return `trace|${mode.trace}`;
}

/** One map (the whole base, one node's neighbourhood, one answer): manual positions carry across its views. */
function baseKey(mode: GraphMode): string {
  if (mode.kind === "global") return "global";
  if (mode.kind === "local") return `local|${mode.focus}`;
  return `trace|${mode.trace}`;
}

/** One view of a map — mode, focus or trace, depth and filters: the key of its manual positions. */
function viewKey(mode: GraphMode, filters: GraphFilters): string {
  const depth = mode.kind === "local" ? `|${mode.depth}` : "";
  return `${baseKey(mode)}${depth}|${filters.kind}|${filters.relation}|${filters.status}`;
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

interface FilterChipProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** A filter as a chip («Тип узла: все») that opens a menu of choices. */
function FilterChip({ label, value, options, onChange }: FilterChipProps) {
  const current = options.find((o) => o.value === value)?.label;
  return (
    <Menu
      label={label}
      className="graph-filter-anchor"
      trigger={(props) => (
        <button type="button" {...props} className={`graph-filter${value ? " is-active" : ""}`}>
          <span className="graph-filter__label">
            {label}: {value && current ? current : "все"}
          </span>
          <Icon name="chevron" size={14} />
        </button>
      )}
      groups={[
        {
          radio: true,
          items: [{ value: "", label: "Все" }, ...options].map((option) => ({
            id: option.value || "all",
            label: option.label,
            checked: option.value === value,
            onSelect: () => onChange(option.value),
          })),
        },
      ]}
    />
  );
}

/**
 * `/graph` — the knowledge map. Three modes, all in the URL (shareable, back/forward works): the whole base
 * `/graph`, a neighbourhood `/graph?focus=ID&depth=1|2`, the evidence of one answer `/graph?trace=TRACE-…`.
 * Nodes can be dragged; their positions are kept per view (lib/graphPositions.ts) until «Сбросить расположение».
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

  // «Граф ответа» leads back to the last answer opened in this tab.
  const [lastTrace, setLastTrace] = useState<string | null>(() => readLastTrace());
  const currentTrace = mode.kind === "trace" && TRACE_PATTERN.test(mode.trace) ? mode.trace : null;
  useEffect(() => {
    if (!currentTrace) return;
    rememberTrace(currentTrace);
    setLastTrace(currentTrace);
  }, [currentTrace]);

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

  // Manual positions of this view; the layout pins them, and never re-runs because a node was dragged.
  const positions = useNodePositions(viewKey(mode, filters), baseKey(mode));
  const pinned = useRef(positions.overrides);
  pinned.current = positions.overrides;

  // Layout only for the drawn view. Within one mode, nodes already shown keep their place (after «Показать
  // соседей» or a client-side filter); a new mode and «Сбросить расположение» start from the initial layout.
  const previousPositions = useRef<{ key: string; resets: number; positions: Map<string, Point> } | null>(null);
  const layout = useMemo(() => {
    if (view !== "graph") return null;
    const before = previousPositions.current;
    const previous = before?.key === key && before.resets === positions.resetCount ? before.positions : undefined;
    return layoutGraph(visible.nodes, visible.edges, center, previous, { pinned: pinned.current });
  }, [view, visible, center, key, positions.resetCount]);
  useEffect(() => {
    if (layout) previousPositions.current = { key, resets: positions.resetCount, positions: layout.positions };
  }, [layout, key, positions.resetCount]);

  // Selection: the centre node by default (its links explain the neighbourhood / the answer).
  const [selection, setSelection] = useState<{ key: string; id: string | null }>({ key: "", id: null });
  const selectedId = selection.key === key ? selection.id : center;
  const selectedNode = selectedId ? (byId.get(selectedId) ?? null) : null;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  // Phones: the details are a sheet from the bottom, opened by a selection, closed with «Закрыть» or Escape.
  const [sheet, setSheet] = useState<{ key: string; open: boolean }>({ key: "", open: false });
  const sheetOpen = sheet.key === key && sheet.open;
  const returnFocus = useRef<HTMLElement | SVGElement | null>(null);

  const [search, setSearch] = useState("");
  const [searchState, setSearchState] = useState<SearchState>(NO_SEARCH);
  const current = searchState.key === key ? searchState : NO_SEARCH;
  const matches = useMemo(() => new Set(current.matches), [current.matches]);

  function select(id: string | null, moveFocus = false) {
    setSelection({ key, id });
    const asSheet = narrow && id !== null;
    if (asSheet) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
      setSheet({ key, open: true });
    }
    // From the list (or into the sheet) focus moves to the details; on the wide canvas it stays on the node.
    if (id && (moveFocus || asSheet)) requestAnimationFrame(() => headingRef.current?.focus());
  }

  function closeSheet() {
    setSheet({ key, open: false });
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (narrow && sheetOpen && event.key === "Escape") {
      event.preventDefault();
      closeSheet();
    }
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

  // Modes: «Вся база», «Вокруг узла» (the focus, or the selected document), «Граф ответа» (the last answer).
  const localTarget =
    mode.kind === "local" ? null : selectedNode && canExpand(selectedNode) ? focusParam(selectedNode) : null;
  function setMode(next: GraphMode["kind"]) {
    if (next === mode.kind) return;
    if (next === "global") setParams(new URLSearchParams());
    else if (next === "local" && localTarget) setParams(new URLSearchParams({ focus: localTarget }));
    else if (next === "trace" && lastTrace) setParams(new URLSearchParams({ trace: lastTrace }));
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
  const presentKinds = useMemo(() => [...new Set(visible.nodes.map((n) => n.kind))], [visible]);
  const presentStatuses = useMemo(
    () => LOOK_STATUSES.filter((s) => visible.nodes.some((n) => n.status === s && n.kind !== "external_page")),
    [visible],
  );
  const showMap = view === "graph" && layout !== null && visible.nodes.length > 0 && !graph.error;

  const listToggle = (
    <Button size="sm" aria-pressed={view === "list"} onClick={() => setViewChoice(view === "list" ? "graph" : "list")}>
      Списком
    </Button>
  );

  return (
    <div className={`graph-page${showMap ? " graph-page--map" : ""}`}>
      <PageToolbar
        crumbs={
          mode.kind === "global"
            ? [{ label: "Карта знаний" }]
            : [
                { label: "Карта знаний", to: "/graph" },
                {
                  label:
                    mode.kind === "local"
                      ? `Окружение ${focusNode ? nodeDisplayId(focusNode) : mode.focus.replace(/^doc:/, "")}`
                      : "Граф ответа",
                },
              ]
        }
        actions={narrow ? undefined : listToggle}
      />
      <h1 className="visually-hidden">{mode.kind === "trace" ? "Граф ответа" : "Карта знаний"}</h1>

      <div className="graph-bar">
        <fieldset className="segmented graph-bar__modes">
          <legend className="visually-hidden">Режим карты</legend>
          {(
            [
              ["global", "Вся база", true, ""],
              ["local", "Вокруг узла", mode.kind === "local" || localTarget !== null, "Выберите документ на карте"],
              ["trace", "Граф ответа", mode.kind === "trace" || lastTrace !== null, "Откройте граф из ответа ассистента"],
            ] as const
          ).map(([value, label, enabled, hint]) => (
            <label key={value} className="segmented__option" title={enabled ? undefined : hint}>
              <input
                type="radio"
                name="graph-mode"
                checked={mode.kind === value}
                disabled={!enabled}
                onChange={() => setMode(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {mode.kind === "local" ? (
          <fieldset className="segmented graph-bar__depth">
            <legend className="visually-hidden">Глубина</legend>
            {([1, 2] as const).map((depth) => (
              <label key={depth} className="segmented__option">
                <input type="radio" name="graph-depth" checked={mode.depth === depth} onChange={() => setDepth(depth)} />
                <span>{depth === 1 ? "1 шаг" : "2 шага"}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="graph-bar__filters" role="group" aria-label="Фильтры карты">
          <FilterChip
            label="Тип узла"
            value={filters.kind}
            options={kindOptions.map((kind) => ({ value: kind, label: labels.kind(kind) }))}
            onChange={(value) => setFilter("kind", value)}
          />
          <FilterChip
            label="Связь"
            value={filters.relation}
            options={relationOptions.map((relation) => ({ value: relation, label: labels.relation(relation) }))}
            onChange={(value) => setFilter("relation", value)}
          />
          <FilterChip
            label="Статус"
            value={filters.status}
            options={STATUS_ORDER.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
            onChange={(value) => setFilter("status", value)}
          />
          {hasFilters ? (
            <Button variant="quiet" size="sm" onClick={resetFilters}>
              Сбросить фильтры
            </Button>
          ) : null}
        </div>
        <form className="graph-search" role="search" onSubmit={(e) => void onSearch(e)}>
          <Icon name="search" size={14} className="graph-search__icon" />
          <input
            id="graph-search"
            type="search"
            aria-label="Найти узел"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
            autoComplete="off"
            placeholder="Найти узел: название или ID"
          />
          <Button type="submit" size="sm">
            Найти
          </Button>
        </form>
        {merged && !graph.error ? (
          <p className="graph-bar__count">
            {visible.nodes.length} {pluralRu(visible.nodes.length, "узел", "узла", "узлов")}, {visible.edges.length}{" "}
            {pluralRu(visible.edges.length, "связь", "связи", "связей")}
          </p>
        ) : null}
        {narrow ? listToggle : null}
      </div>

      <p className="graph-caption">
        {mode.kind === "global"
          ? "Связи из метаданных документов команды: что на что ссылается, от чего зависит, что описывает. Сначала показаны самые связанные узлы; остальные — через поиск и окружение узла."
          : null}
        {mode.kind === "local" ? (
          <>
            Окружение узла {focusNode ? <>«{focusNode.label}»</> : <code className="doc-id">{mode.focus}</code>}: связи глубиной{" "}
            {mode.depth === 1 ? "в один шаг" : "в два шага"}.
          </>
        ) : null}
        {mode.kind === "trace" ? (
          <>
            Какие источники нашлись для вопроса, какие из них процитированы в ответе и с чем они связаны в базе знаний. Текст
            вопроса не хранится — узел вопроса подписан ключевыми словами.
            {queryNode?.expires_at ? ` След хранится до ${formatDateTime(queryNode.expires_at)}.` : ""}
          </>
        ) : null}
        {merged && !graph.error ? (
          <span className="graph-caption__generation">
            {" "}
            Поколение графа: <code>{merged.generation}</code>
            {mode.kind === "trace" ? " · узлы и связи следа временные" : ""}
          </span>
        ) : null}
      </p>

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
        <div className="stack graph-message">
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
            <Notice tone="info" className="graph-partial graph-message">
              <p>
                Показана часть графа: {merged.nodes.length} из {merged.total_nodes}{" "}
                {pluralRu(merged.total_nodes, "узла", "узлов", "узлов")} — уточните фильтр или откройте окружение узла.
              </p>
              {canLoadMore ? (
                <Button size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? "Загружаем соседей…" : "Показать соседей ещё"}
                </Button>
              ) : null}
            </Notice>
          ) : null}
          {moreError ? <ErrorState error={moreError} title="Не удалось загрузить соседей" /> : null}
          {visible.nodes.length === 0 ? (
            <div className="graph-message">
              <EmptyState title="Узлов с такими фильтрами нет">
                <p>Измените или сбросьте фильтры.</p>
                {hasFilters ? (
                  <Button size="sm" onClick={resetFilters}>
                    Сбросить фильтры
                  </Button>
                ) : null}
              </EmptyState>
            </div>
          ) : (
            <>
              {visible.edges.length === 0 ? (
                <Notice tone="info" className="graph-message">
                  {mode.kind === "local"
                    ? "У этого узла нет связей: ни он сам, ни другие документы не объявили связей с ним (или их скрыл фильтр)."
                    : "Связей между показанными узлами нет — измените фильтр."}
                </Notice>
              ) : null}
              <div className={`graph-layout${view === "graph" ? " graph-layout--map" : ""}`}>
                <section className="graph-stage" aria-label={view === "graph" ? "Схема графа" : "Граф списком"}>
                  {view === "graph" && layout ? (
                    <GraphCanvas
                      nodes={visible.nodes}
                      edges={visible.edges}
                      layout={layout}
                      overrides={positions.overrides}
                      onMoveNode={positions.move}
                      onResetLayout={positions.reset}
                      center={center}
                      selectedId={selectedNode ? selectedNode.id : null}
                      matches={matches}
                      labels={labels}
                      onSelect={(id) => select(id)}
                      focusRequest={focusRequest}
                      legend={
                        <GraphLegendView
                          labels={labels}
                          kinds={presentKinds}
                          statuses={presentStatuses}
                          defaultOpen={!narrow}
                        />
                      }
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
                <aside
                  className={`graph-panel${narrow ? " graph-panel--sheet" : ""}`}
                  aria-label="Сведения об узле"
                  hidden={narrow && !sheetOpen}
                  onKeyDown={onPanelKeyDown}
                >
                  {narrow ? (
                    <div className="graph-panel__sheet-bar">
                      <IconButton icon="close" label="Закрыть сведения" size="sm" onClick={closeSheet} />
                    </div>
                  ) : null}
                  {selectedNode ? (
                    <NodeDetails
                      node={selectedNode}
                      byId={byId}
                      edges={visible.edges}
                      labels={labels}
                      isFocus={mode.kind === "local" && selectedNode.id === mode.focus}
                      focusNode={focusNode}
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
        </>
      ) : null}
    </div>
  );
}
