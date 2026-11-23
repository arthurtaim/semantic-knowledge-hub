import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import type { DocStatus, GraphEdge, GraphNode } from "../api/types";
import {
  canExpand,
  FEEDBACK_LABEL,
  focusParam,
  isUnconfirmedEdge,
  KIND_ORDER,
  nodeDisplayId,
  nodeShapePath,
  nodeStatusClass,
  nodeStatusText,
  ORIGIN_ORDER,
  SOURCE_KIND_LABEL,
  type GraphLabels,
} from "../lib/graph";
import { formatDateTime, STATUS_LABEL, STATUS_ORDER } from "../lib/labels";
import { StatusStamp } from "./StatusStamp";

const isDocStatus = (value: string | null): value is DocStatus => value !== null && value in STATUS_LABEL;

/** The shape of a node kind (legend, lists, details); decorative — the kind is always named in text too. */
export function ShapeIcon({ kind, status = "none" }: { kind: string; status?: string }) {
  return (
    <svg className={`graph-icon graph-node--status-${status}`} width="20" height="20" viewBox="-11 -11 22 22" aria-hidden="true" focusable="false">
      <path className="graph-node__shape" d={nodeShapePath(kind, 7)} />
    </svg>
  );
}

function EdgeSample({ unconfirmed }: { unconfirmed: boolean }) {
  return (
    <svg className="graph-icon graph-icon--edge" width="36" height="12" viewBox="0 0 36 12" aria-hidden="true" focusable="false">
      <path className={`graph-edge${unconfirmed ? " graph-edge--unconfirmed" : ""}`} d="M1,6H29" />
      <path className="graph-arrow" d="M27,2L35,6L27,10Z" />
    </svg>
  );
}

// --- why linked -----------------------------------------------------------------------------------------

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "Why linked": who declared the edge, in which field, file and revision (or which answer it belongs to). */
export function EdgeProvenance({ edge }: { edge: GraphEdge }) {
  const trace = edge.origin === "query_trace";
  return (
    <dl className="graph-why__facts" aria-label="Почему связаны">
      {edge.declared_in ? (
        <Fact term="Указано в">
          <code className="doc-id">{edge.declared_in}</code>
        </Fact>
      ) : null}
      {edge.field ? (
        <Fact term={trace ? "Фрагменты" : "Поле"}>
          <code>{edge.field}</code>
        </Fact>
      ) : null}
      {edge.path ? (
        <Fact term="Файл">
          <code className="graph-why__path">{edge.path}</code>
        </Fact>
      ) : null}
      {edge.revision ? (
        <Fact term={edge.revision.startsWith("sha256:") || !trace ? "Ревизия" : "Версия страницы"}>
          <code className="doc-id">{edge.revision}</code>
        </Fact>
      ) : null}
      {trace && edge.type === "cited_in" ? <Fact term="Использование">процитирована в ответе</Fact> : null}
      {edge.status === "dangling" ? <Fact term="Цель">не найдена в базе знаний</Fact> : null}
      {edge.expires_at ? <Fact term="Хранится до">{formatDateTime(edge.expires_at)}</Fact> : null}
      {edge.feedback ? <Fact term="Отзыв">{FEEDBACK_LABEL[edge.feedback] ?? edge.feedback}</Fact> : null}
    </dl>
  );
}

interface EdgeItemProps {
  edge: GraphEdge;
  self: string;
  byId: Map<string, GraphNode>;
  labels: GraphLabels;
  onSelect: (id: string) => void;
}

function EdgeItem({ edge, self, byId, labels, onSelect }: EdgeItemProps) {
  const end = (id: string, first: boolean) => {
    const node = byId.get(id);
    const label = node?.label ?? id;
    // The panel title names the selected node; in its edge list it is "этот узел".
    return id === self ? (
      <strong className="graph-why__self">{first ? "Этот узел" : "этот узел"}</strong>
    ) : (
      <button type="button" className="graph-why__node" onClick={() => onSelect(id)}>
        {label}
      </button>
    );
  };
  const unconfirmed = isUnconfirmedEdge(edge);
  return (
    <li className={`graph-why${unconfirmed ? " graph-why--unconfirmed" : ""}`}>
      <p className="graph-why__line">
        {end(edge.source, true)} <span className="graph-why__rel">{labels.relation(edge.type)}</span> {end(edge.target, false)}
      </p>
      <p className="graph-why__origin">
        {unconfirmed ? <span className="graph-why__temp">Не подтверждённая связь.</span> : null} {labels.origin(edge.origin)}
      </p>
      <EdgeProvenance edge={edge} />
    </li>
  );
}

// --- details panel ----------------------------------------------------------------------------------------

export interface NodeDetailsProps {
  node: GraphNode;
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
  labels: GraphLabels;
  /** The node whose neighbourhood is shown (local mode). */
  isFocus: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

export function NodeDetails({ node, byId, edges, labels, isFocus, canLoadMore, loadingMore, onLoadMore, onSelect, headingRef }: NodeDetailsProps) {
  const outgoing = edges.filter((e) => e.source === node.id);
  const incoming = edges.filter((e) => e.target === node.id && e.source !== node.id);
  const status = nodeStatusText(node);
  const isDocument = Boolean(node.document_id) && node.id.startsWith("doc:");
  const inAppUrl = node.url && node.url.startsWith("/") ? node.url : null;
  const edgeList = (title: string, list: GraphEdge[], id: string) =>
    list.length > 0 ? (
      <section className="graph-panel__edges" aria-labelledby={id}>
        <h3 id={id}>
          {title} <span className="muted">({list.length})</span>
        </h3>
        <ul className="graph-why-list">
          {list.map((edge) => (
            <EdgeItem key={edge.id} edge={edge} self={node.id} byId={byId} labels={labels} onSelect={onSelect} />
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <div className="graph-details">
      <p className="graph-details__kind">
        <ShapeIcon kind={node.kind} status={nodeStatusClass(node)} /> {labels.kind(node.kind)}
      </p>
      <h2 className="graph-details__title" ref={headingRef} tabIndex={-1}>
        {node.label}
      </h2>
      <dl className="graph-details__facts">
        {node.kind === "external_page" ? (
          <Fact term="Статус">
            <span className="graph-unconfirmed">{status}</span>
          </Fact>
        ) : isDocStatus(node.status) ? (
          <Fact term="Статус">
            <StatusStamp status={node.status} />
          </Fact>
        ) : node.kind === "query_context" ? (
          <Fact term="Статус">временный след ответа, не знание</Fact>
        ) : null}
        <Fact term="ID">
          <code className="doc-id">{nodeDisplayId(node)}</code>
        </Fact>
        {node.version ? <Fact term="Версия">{node.version}</Fact> : null}
        {node.revision ? (
          <Fact term="Ревизия">
            <code className="doc-id">{node.revision}</code>
          </Fact>
        ) : null}
        {node.owner ? <Fact term="Владелец">{node.owner}</Fact> : null}
        <Fact term="Источник">
          {SOURCE_KIND_LABEL[node.source_kind] ?? node.source_kind}
          {node.synthetic ? " · демо-данные" : ""}
        </Fact>
        {node.expires_at ? <Fact term="Хранится до">{formatDateTime(node.expires_at)}</Fact> : null}
      </dl>
      <div className="graph-details__actions">
        {isDocument ? (
          <Link to={`/documents/${encodeURIComponent(node.document_id ?? "")}`} className="button button--secondary">
            Открыть документ
          </Link>
        ) : null}
        {node.kind === "external_page" && inAppUrl ? (
          <Link to={inAppUrl} className="button button--secondary">
            Открыть страницу
          </Link>
        ) : null}
        {canExpand(node) && !isFocus ? (
          <Link to={`/graph?focus=${encodeURIComponent(focusParam(node))}`} className="button button--secondary">
            Показать соседей
          </Link>
        ) : null}
        {isFocus && canLoadMore ? (
          <button type="button" className="button button--secondary" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Загружаем соседей…" : "Показать соседей"}
          </button>
        ) : null}
        {isDocument ? (
          <Link to={`/documents?query=${encodeURIComponent(node.document_id ?? "")}`} className="button button--quiet">
            Открыть в списке
          </Link>
        ) : null}
      </div>
      {outgoing.length + incoming.length === 0 ? (
        <p className="muted">На схеме у этого узла нет связей.</p>
      ) : (
        <>
          {edgeList("Исходящие связи", outgoing, `graph-out-${node.id}`)}
          {edgeList("Входящие связи", incoming, `graph-in-${node.id}`)}
        </>
      )}
    </div>
  );
}

// --- accessible alternative: lists ----------------------------------------------------------------------

const EDGE_LIST_LIMIT = 300;
/** Long edge lists start collapsed to this many rows (phones show the list view by default). */
const EDGE_LIST_INITIAL = 40;

export interface GraphListViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  labels: GraphLabels;
  center: string | null;
  selectedId: string | null;
  matches: ReadonlySet<string>;
  onSelect: (id: string) => void;
  focusRequest: { id: string; nonce: number } | null;
}

/** The graph as two ruled lists (nodes, then edges): fully keyboard reachable, the default on phones. */
export function GraphListView({ nodes, edges, labels, center, selectedId, matches, onSelect, focusRequest }: GraphListViewProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [allEdges, setAllEdges] = useState(false);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const sorted = [...nodes].sort(
    (a, b) =>
      Number(b.id === center) - Number(a.id === center) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      a.label.localeCompare(b.label, "ru"),
  );
  const shownEdges = edges.slice(0, allEdges ? EDGE_LIST_LIMIT : EDGE_LIST_INITIAL);

  useEffect(() => {
    if (!focusRequest) return;
    const target = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-node-id]") ?? []).find(
      (element) => element.dataset.nodeId === focusRequest.id,
    );
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const nodeLabel = (id: string) => byId.get(id)?.label ?? id;
  return (
    <div className="graph-list">
      <section aria-labelledby="graph-list-nodes">
        <h2 id="graph-list-nodes">
          Узлы <span className="muted">({nodes.length})</span>
        </h2>
        <ul className="graph-list__items" ref={listRef}>
          {sorted.map((node) => {
            const status = nodeStatusText(node);
            return (
              <li key={node.id} className={`graph-list__item${matches.has(node.id) ? " is-match" : ""}`}>
                <button
                  type="button"
                  className="graph-list__node"
                  data-node-id={node.id}
                  aria-pressed={node.id === selectedId}
                  onClick={() => onSelect(node.id)}
                >
                  <ShapeIcon kind={node.kind} status={nodeStatusClass(node)} />
                  <span>{node.label}</span>
                </button>
                <p className="graph-list__meta">
                  <span>{labels.kind(node.kind)}</span>
                  {status ? <span className={node.kind === "external_page" ? "graph-unconfirmed" : undefined}>{status}</span> : null}
                  <code className="doc-id">{nodeDisplayId(node)}</code>
                  <span>
                    связей: {degree.get(node.id) ?? 0}
                  </span>
                  {node.id === center ? <span>в центре</span> : null}
                  {matches.has(node.id) ? <span className="graph-list__found">найден поиском</span> : null}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="graph-list-edges">
        <h2 id="graph-list-edges">
          Связи <span className="muted">({edges.length})</span>
        </h2>
        {edges.length === 0 ? <p className="muted">Связей между показанными узлами нет.</p> : null}
        <ul className="graph-list__items graph-list__items--edges">
          {shownEdges.map((edge) => (
            <li key={edge.id} className="graph-list__item">
              <p className="graph-list__edge">
                <button type="button" className="graph-why__node" onClick={() => onSelect(edge.source)}>
                  {nodeLabel(edge.source)}
                </button>{" "}
                <span className="graph-why__rel">{labels.relation(edge.type)}</span>{" "}
                <button type="button" className="graph-why__node" onClick={() => onSelect(edge.target)}>
                  {nodeLabel(edge.target)}
                </button>
              </p>
              <p className="graph-list__meta">
                <span>
                  {isUnconfirmedEdge(edge) ? "Не подтверждённая связь. " : ""}
                  {labels.origin(edge.origin)}
                </span>
                {edge.declared_in ? (
                  <span>
                    указано в <code className="doc-id">{edge.declared_in}</code>
                    {edge.field ? (
                      <>
                        , поле <code>{edge.field}</code>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
        {edges.length > shownEdges.length && !allEdges ? (
          <button type="button" className="button button--secondary graph-list__more" onClick={() => setAllEdges(true)}>
            Показать все связи ({Math.min(edges.length, EDGE_LIST_LIMIT)})
          </button>
        ) : null}
        {edges.length > shownEdges.length && allEdges ? (
          <p className="muted">
            Показаны первые {shownEdges.length} связей из {edges.length} — уточните фильтр.
          </p>
        ) : null}
      </section>
    </div>
  );
}

// --- legend ---------------------------------------------------------------------------------------------

export function GraphLegendView({ labels, kinds, relations }: { labels: GraphLabels; kinds: string[]; relations: string[] }) {
  return (
    <section className="graph-legend" aria-labelledby="graph-legend-title">
      <h2 id="graph-legend-title">Условные обозначения</h2>
      <div className="graph-legend__cols">
        <div>
          <h3>Узлы — форма по типу</h3>
          <ul className="graph-legend__list">
            {KIND_ORDER.filter((k) => kinds.includes(k)).map((kind) => (
              <li key={kind}>
                <ShapeIcon
                  kind={kind}
                  status={kind === "external_page" ? "external" : kind === "query_context" ? "query" : "neutral"}
                />
                <span>{labels.kind(kind)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Связи — линия по происхождению</h3>
          <ul className="graph-legend__list">
            {ORIGIN_ORDER.map((origin) => (
              <li key={origin}>
                <EdgeSample unconfirmed={origin === "query_trace" || origin === "external_discovery" || origin === "ai_suggestion"} />
                <span>{labels.origin(origin)}</span>
              </li>
            ))}
          </ul>
          <p className="graph-legend__note">
            Сплошная линия — подтверждённая связь, пунктир — временная или не подтверждённая. Стрелка направлена от
            документа, который объявил связь.
          </p>
          <p className="graph-legend__note">Типы связей: {relations.map((r) => labels.relation(r)).join(", ")}.</p>
        </div>
        <div>
          <h3>Статус — контур узла</h3>
          <ul className="graph-legend__list">
            {STATUS_ORDER.map((status) => (
              <li key={status}>
                <ShapeIcon kind="document" status={status} />
                <span>
                  {STATUS_LABEL[status]}
                  <span className="muted">
                    {status === "approved"
                      ? " — сплошной контур"
                      : status === "in_review"
                        ? " — точечный контур"
                        : status === "draft"
                          ? " — штриховой контур"
                          : " — серый, подпись зачёркнута"}
                  </span>
                </span>
              </li>
            ))}
            <li>
              <ShapeIcon kind="external_page" status="external" />
              <span>
                Внешняя страница<span className="muted"> — статус не подтверждён, хранится временно</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
