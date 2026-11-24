import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
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
  SOURCE_KIND_LABEL,
  type GraphLabels,
} from "../lib/graph";
import { formatDateTime, provenanceText, STATUS_LABEL, STATUS_ORDER } from "../lib/labels";
import { readPreference, writePreference } from "../lib/storage";
import { AiProposalCard, useAiProposal } from "./AiProposal";
import { ErrorState } from "./Feedback";
import { StatusStamp } from "./StatusStamp";
import { buttonClass } from "./ui/Button";
import { Icon } from "./ui/Icon";

const isDocStatus = (value: string | null): value is DocStatus => value !== null && value in STATUS_LABEL;

/**
 * The shape of a node kind (legend, lists, details); decorative — the kind is always named in text too. `title`
 * is a pointer tooltip only (the collapsed legend's swatches).
 */
export function ShapeIcon({ kind, status = "none", title }: { kind: string; status?: string; title?: string }) {
  return (
    <svg
      className={`graph-icon graph-node--${kind} graph-node--status-${status}`}
      width="16"
      height="16"
      viewBox="-11 -11 22 22"
      aria-hidden="true"
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path className="graph-node__shape" d={nodeShapePath(kind, 7)} />
    </svg>
  );
}

/** Outline class of a kind in the legend (templates and pages are outlined, the rest filled). */
const LEGEND_STATUS: Record<string, string> = { external_page: "external", query_context: "query", template: "template" };

function EdgeSample({ unconfirmed }: { unconfirmed: boolean }) {
  return (
    <svg className="graph-icon graph-icon--edge" width="24" height="12" viewBox="0 0 24 12" aria-hidden="true" focusable="false">
      <path className={`graph-edge graph-edge--sample${unconfirmed ? " graph-edge--unconfirmed" : ""}`} d="M1,6H18" />
      <path className="graph-arrow graph-arrow--lit" d="M16,2.5L23,6L16,9.5Z" />
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
      {!trace && edge.provenance && edge.provenance.length > 0 ? (
        <Fact term="Где объявлено">{edge.provenance.map(provenanceText).join("; ")}</Fact>
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

// --- AI on the graph: why two documents are related, what a change would affect ----------------------------

/** «Объяснить связь с …» (focus ↔ selected) and «Анализ влияния»: answers and plans, nothing to apply. */
function GraphAiActions({ node, focusNode }: { node: GraphNode; focusNode: GraphNode | null }) {
  const state = useAiProposal();
  const documentId = node.document_id ?? "";
  const other = focusNode && focusNode.document_id && focusNode.id !== node.id && focusNode.id.startsWith("doc:") ? focusNode : null;
  const busy = state.preparing !== null;
  return (
    <section className="graph-ai" aria-label="ИИ о связях узла">
      <div className="graph-details__actions graph-details__actions--ai">
        {other ? (
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            disabled={busy}
            onClick={() =>
              void state.run({ kind: "explain_relation", document_id: other.document_id ?? "", target_id: documentId })
            }
          >
            Объяснить связь с {nodeDisplayId(other)}
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={busy}
          onClick={() => void state.run({ kind: "impact_analysis", document_id: documentId })}
        >
          Анализ влияния
        </button>
      </div>
      <div aria-live="polite">
        {busy ? (
          <p className="muted">
            Готовим ответ ИИ…{" "}
            <button type="button" className={buttonClass("quiet", "sm")} onClick={state.cancel}>
              Отменить
            </button>
          </p>
        ) : null}
      </div>
      {state.error ? <ErrorState error={state.error} title="Не удалось получить ответ ИИ" /> : null}
      {state.proposal ? (
        <AiProposalCard
          key={state.proposal.id}
          proposal={state.proposal}
          pending={state.decision}
          error={state.decisionError}
          onAccept={(ids) => void state.accept(ids)}
          onReject={() => void state.reject()}
          onRegenerate={state.regenerate}
        />
      ) : null}
    </section>
  );
}

export interface NodeDetailsProps {
  node: GraphNode;
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
  labels: GraphLabels;
  /** The node whose neighbourhood is shown (local mode). */
  isFocus: boolean;
  /** The centre of a local graph: «Объяснить связь с …» explains the path between it and the selected node. */
  focusNode?: GraphNode | null;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

export function NodeDetails({
  node,
  byId,
  edges,
  labels,
  isFocus,
  focusNode = null,
  canLoadMore,
  loadingMore,
  onLoadMore,
  onSelect,
  headingRef,
}: NodeDetailsProps) {
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
      <h2
        className={`graph-details__title${node.status === "deprecated" ? " is-deprecated" : ""}`}
        ref={headingRef}
        tabIndex={-1}
      >
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
          <Link to={`/documents/${encodeURIComponent(node.document_id ?? "")}`} className={buttonClass("secondary", "sm")}>
            Открыть документ
          </Link>
        ) : null}
        {node.kind === "external_page" && inAppUrl ? (
          <Link to={inAppUrl} className={buttonClass("secondary", "sm")}>
            Открыть страницу
          </Link>
        ) : null}
        {canExpand(node) && !isFocus ? (
          <Link to={`/graph?focus=${encodeURIComponent(focusParam(node))}`} className={buttonClass("secondary", "sm")}>
            Показать соседей
          </Link>
        ) : null}
        {isFocus && canLoadMore ? (
          <button type="button" className={buttonClass("secondary", "sm")} onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Загружаем соседей…" : "Показать соседей"}
          </button>
        ) : null}
        {isDocument ? (
          <Link to={`/documents?query=${encodeURIComponent(node.document_id ?? "")}`} className={buttonClass("quiet", "sm")}>
            Открыть в списке
          </Link>
        ) : null}
      </div>
      {isDocument ? <GraphAiActions key={node.id} node={node} focusNode={focusNode} /> : null}
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
          <button type="button" className={buttonClass("secondary", "sm", "graph-list__more")} onClick={() => setAllEdges(true)}>
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

// --- legend: one line over the canvas (the kinds' swatches), expandable; only what is on the map ----------------

export const LEGEND_PREFERENCE = "skh.graph.legend";
const STATUS_HINT: Partial<Record<DocStatus, string>> = {
  draft: "пунктир",
  in_review: "точки",
  deprecated: "бледный",
};

export interface GraphLegendProps {
  labels: GraphLabels;
  /** Node kinds present on the map. */
  kinds: string[];
  /** Statuses present on the map that change a node's look (draft, in review, deprecated). */
  statuses: DocStatus[];
}

/**
 * The legend: collapsed to one line by default — «Условные обозначения» and the swatches of the kinds on the map —
 * so that it leaves the map free; expanded, the kinds, statuses and both kinds of edges with their names. The
 * choice is remembered in this browser (localStorage; without storage it holds until the page is reloaded).
 */
export function GraphLegendView({ labels, kinds, statuses }: GraphLegendProps) {
  const [open, setOpen] = useState(() => readPreference(LEGEND_PREFERENCE) === "open");
  const bodyId = useId();
  const toggle = () => {
    setOpen(!open);
    writePreference(LEGEND_PREFERENCE, open ? "closed" : "open");
  };
  const shown = KIND_ORDER.filter((k) => kinds.includes(k));
  return (
    <section className={`graph-legend${open ? " is-open" : ""}`} aria-labelledby={`${bodyId}-title`}>
      <h2 className="graph-legend__title" id={`${bodyId}-title`}>
        <button type="button" className="graph-legend__toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          <Icon name="chevron" size={14} className="graph-legend__chevron" />
          Условные обозначения
          {open ? null : (
            <span className="graph-legend__swatches" aria-hidden="true">
              {shown.map((kind) => (
                <ShapeIcon key={kind} kind={kind} status={LEGEND_STATUS[kind] ?? "none"} title={labels.kind(kind)} />
              ))}
            </span>
          )}
        </button>
      </h2>
      <div id={bodyId} className="graph-legend__body" hidden={!open}>
        <ul className="graph-legend__list">
          {shown.map((kind) => (
            <li key={kind}>
              <ShapeIcon kind={kind} status={LEGEND_STATUS[kind] ?? "none"} />
              <span>{labels.kind(kind)}</span>
            </li>
          ))}
          {STATUS_ORDER.filter((s) => statuses.includes(s) && STATUS_HINT[s]).map((status) => (
            <li key={status}>
              <ShapeIcon kind="document" status={status} />
              <span>
                {STATUS_LABEL[status]}
                <span className="muted"> — {STATUS_HINT[status]}</span>
              </span>
            </li>
          ))}
        </ul>
        <ul className="graph-legend__list">
          <li>
            <EdgeSample unconfirmed={false} />
            <span>Подтверждённая связь</span>
          </li>
          <li>
            <EdgeSample unconfirmed />
            <span>Временная или не подтверждённая</span>
          </li>
        </ul>
        <p className="graph-legend__note">Стрелка — от документа, который объявил связь.</p>
      </div>
    </section>
  );
}
