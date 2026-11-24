import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type ApiError } from "../api/client";
import type { DocumentDetail, DocumentLinks, DocumentPublicationStatus, ProposalList, ProposalSummary } from "../api/types";
import { AiAssistPanel, useAiProposal, type AiAction } from "../components/AiProposal";
import { DocumentDetails, SourceLocation } from "../components/DocumentDetails";
import { DocumentLinksPanel } from "../components/DocumentLinks";
import { PublicationSection } from "../components/DocumentPublication";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { ProposalStateLabel } from "../components/ProposalState";
import { SafeHtml } from "../components/SafeHtml";
import { StaleMark } from "../components/StaleMark";
import { When } from "../components/When";
import { WikiLinkPreviewArea } from "../components/WikiLinkPreview";
import { PageToolbar } from "../components/shell/PageToolbar";
import { SidePanel, useSidePanelMode } from "../components/shell/SidePanel";
import { buttonClass, IconButton } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { Menu, type MenuItem } from "../components/ui/Popover";
import { StatusMark } from "../components/ui/StatusMark";
import {
  formatDate,
  formatDateTime,
  OPERATION_LABEL,
  pluralRu,
  REVIEW_LABEL,
  shortRevision,
  SOURCE_LABEL,
  TYPE_LABEL,
} from "../lib/labels";
import { useSession } from "../lib/session";
import { onTabListKeyDown } from "../lib/tabs";
import { useAsync } from "../lib/useAsync";

/** The four segments of a document (docs/ui-v2/specs/03_SCREENS.md §3). */
export type DocumentView = "text" | "links" | "history" | "raw";

const VIEWS: { value: DocumentView; label: string }[] = [
  { value: "text", label: "Текст" },
  { value: "links", label: "Связи" },
  { value: "history", label: "История" },
  { value: "raw", label: "Markdown" },
];

/** Anchors of blocks that live in a segment other than «Текст» (a link to them opens that segment). */
const VIEW_BY_HASH: Record<string, DocumentView> = {
  "doc-links": "links",
  publication: "history",
  "doc-history": "history",
  "doc-raw": "raw",
};

function viewForHash(hash: string): DocumentView {
  return VIEW_BY_HASH[decodeURIComponent(hash.replace(/^#/, ""))] ?? "text";
}

/**
 * The right panel of the document. «Сведения» today; the document assistant (⌘J, a toolbar toggle) is the next
 * step and takes the same place — one right panel at a time.
 */
export type DocumentPanel = "details";

async function loadDocument(id: string): Promise<{ doc: DocumentDetail; proposals: ProposalList }> {
  const [doc, proposals] = await Promise.all([api.document(id), api.drafts({ document_id: id })]);
  return { doc, proposals };
}

/** Distinct documents this one links to or is linked from (only those the reader can see). */
export function linkedDocumentCount(links: DocumentLinks): number {
  return new Set([...links.outgoing.map((l) => l.target.document_id), ...links.backlinks.map((l) => l.source.document_id)])
    .size;
}

/** AI actions on an approved document: proposals only; an accepted change becomes an update DRAFT. */
function DocumentAiPanel({ doc }: { doc: DocumentDetail }) {
  const state = useAiProposal();
  const actions: AiAction[] = [
    { key: "meta", label: "Предложить метаданные", build: () => ({ kind: "suggest_metadata", document_id: doc.id }) },
    { key: "related", label: "Найти связанные", build: () => ({ kind: "find_related", document_id: doc.id }) },
    { key: "complete", label: "Проверить полноту", build: () => ({ kind: "check_completeness", document_id: doc.id }) },
    { key: "impact", label: "Анализ влияния", build: () => ({ kind: "impact_analysis", document_id: doc.id }) },
  ];
  return (
    <AiAssistPanel
      id="doc-ai"
      title="ИИ-помощник по документу"
      state={state}
      actions={actions}
      intro={
        <p className="muted">
          Предложения опираются на утверждённые документы и показывают основания. Утверждённый документ не меняется:
          принятые пункты попадают в новый черновик изменения, который проходит обычное ревью.
        </p>
      }
      appliedNote={(p) =>
        p.result_draft_id ? (
          <Notice tone="success">
            <p>
              <strong>Создан черновик изменения.</strong> Принятые пункты применены к черновику, а не к утверждённому
              документу: он изменится только после ревью и merge.
            </p>
            <Link to={`/proposals/${encodeURIComponent(p.result_draft_id)}`} className="text-link">
              Открыть черновик изменения
            </Link>
          </Notice>
        ) : null
      }
    />
  );
}

interface LinksState {
  data: DocumentLinks | null;
  error: ApiError | null;
  loading: boolean;
}

/** The six facts under the title (design-04); everything else is in «Сведения». */
function DocumentProperties({
  doc,
  links,
  onShowLinks,
  onShowDetails,
}: {
  doc: DocumentDetail;
  links: LinksState;
  onShowLinks: () => void;
  onShowDetails: () => void;
}) {
  const count = links.data ? linkedDocumentCount(links.data) : null;
  const unresolved = links.data?.unresolved.length ?? 0;
  return (
    <div className="doc-props-wrap">
      <dl className="doc-props">
        <div>
          <dt>Владелец</dt>
          <dd className={doc.owner_missing ? "flag" : undefined}>{doc.owner_missing ? `не назначен (${doc.owner})` : doc.owner}</dd>
        </div>
        <div>
          <dt>Раздел</dt>
          <dd>
            <Link to={`/documents?type=${doc.type}`} className="doc-props__link">
              {TYPE_LABEL[doc.type]}
            </Link>
          </dd>
        </div>
        <div>
          <dt>Проверен</dt>
          <dd>
            {doc.reviewed_at ? formatDate(doc.reviewed_at) : REVIEW_LABEL[doc.review_state]}
            {doc.reviewed_at && doc.review_state === "stale" ? (
              <span className="review-flag">{REVIEW_LABEL[doc.review_state]}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>
            {SOURCE_LABEL[doc.source]}
            {doc.web_url ? (
              <>
                {" "}
                <SourceLocation doc={doc} />
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Ревизия</dt>
          <dd>
            <code className="doc-id doc-props__revision" title={doc.revision}>
              {shortRevision(doc.revision)}
            </code>
            {doc.index_state === "stale" ? <StaleMark /> : null}
          </dd>
        </div>
        <div>
          <dt>Связи</dt>
          <dd>
            {links.error ? (
              <span className="muted">не загрузились</span>
            ) : count === null ? (
              <span className="muted">загрузка…</span>
            ) : (
              <button type="button" className="link-button" onClick={onShowLinks}>
                {count === 0 ? "нет связей" : `${count} ${pluralRu(count, "документ", "документа", "документов")}`}
              </button>
            )}
            {unresolved > 0 ? <span className="flag doc-props__flag">нерешённых: {unresolved}</span> : null}
          </dd>
        </div>
      </dl>
      <button type="button" className={buttonClass("quiet", "sm", "doc-props__more")} onClick={onShowDetails}>
        Все сведения
      </button>
    </div>
  );
}

function ProposalRow({ proposal: p }: { proposal: ProposalSummary }) {
  return (
    <li className="doc-history__item">
      <Link to={`/proposals/${encodeURIComponent(p.id)}`}>{p.reason}</Link>
      <span className="doc-history__meta">
        <ProposalStateLabel status={p.status} />
        <span>{OPERATION_LABEL[p.operation]}</span>
        <span>{p.author}</span>
        <When value={p.created_at} />
      </span>
    </li>
  );
}

/** «История»: what the API really knows — the current revision, the proposals for this document, publication. */
function DocumentHistory({
  doc,
  proposals,
  publication,
}: {
  doc: DocumentDetail;
  proposals: ProposalSummary[];
  publication: { data: DocumentPublicationStatus | null; failed: boolean };
}) {
  const publisherOff = publication.data?.publisher.mode === "disabled";
  return (
    <div className="doc-history" id="doc-history">
      <section className="doc-history__block" aria-labelledby="history-revision-title">
        <h2 id="history-revision-title">Текущая ревизия</h2>
        <dl className="doc-history__facts">
          <div>
            <dt>Ревизия</dt>
            <dd>
              <code className="doc-id">{doc.revision}</code>
            </dd>
          </div>
          <div>
            <dt>Дата ревизии</dt>
            <dd>{doc.updated_at ? <time dateTime={doc.updated_at}>{formatDateTime(doc.updated_at)}</time> : "не указана"}</dd>
          </div>
          <div>
            <dt>Версия</dt>
            <dd>{doc.version ?? "не указана"}</dd>
          </div>
          <div>
            <dt>Проверен</dt>
            <dd>
              {formatDate(doc.reviewed_at)} · {REVIEW_LABEL[doc.review_state]}
            </dd>
          </div>
        </dl>
        <p className="muted">
          {doc.source === "local"
            ? "Приложение показывает только текущую ревизию: локальный workspace не хранит прежние ревизии."
            : `Приложение показывает только текущую ревизию. Прежние ревизии и их авторы — в истории источника (${SOURCE_LABEL[doc.source]}).`}
          {doc.web_url ? (
            <>
              {" "}
              <SourceLocation doc={doc} />
            </>
          ) : null}
        </p>
      </section>

      <section className="doc-history__block" aria-labelledby="history-proposals-title">
        <h2 id="history-proposals-title">Предложения изменений</h2>
        {proposals.length === 0 ? (
          <p className="muted">К этому документу предложений изменений не было.</p>
        ) : (
          <ul className="doc-history__list">
            {proposals.map((p) => (
              <ProposalRow key={p.id} proposal={p} />
            ))}
          </ul>
        )}
      </section>

      {publication.data && !publisherOff ? (
        <PublicationSection status={publication.data} />
      ) : (
        <section className="doc-history__block" aria-labelledby="history-publication-title">
          <h2 id="history-publication-title">Публикация</h2>
          <p className="muted">
            {publication.failed
              ? "Состояние публикации недоступно."
              : publisherOff
                ? "Публикация в Confluence не настроена в этой установке."
                : "Загружаем состояние публикации…"}
          </p>
        </section>
      )}
    </div>
  );
}

function DocumentBody({
  doc,
  proposals,
  links,
  reloadLinks,
  publication,
}: {
  doc: DocumentDetail;
  proposals: ProposalList;
  links: LinksState;
  reloadLinks: () => void;
  publication: { data: DocumentPublicationStatus | null; failed: boolean };
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const aiOff = session?.features.ai_mode === "disabled";
  const [view, setView] = useState<DocumentView>(() => viewForHash(location.hash));
  const [seenHash, setSeenHash] = useState(location.hash);
  if (location.hash !== seenHash) {
    // A link to an anchor (a citation, «Подробнее о публикации») opens the segment that holds it.
    setSeenHash(location.hash);
    if (location.hash) setView(viewForHash(location.hash));
  }
  const [panel, setPanel] = useState<DocumentPanel | null>(null);
  const panelMode = useSidePanelMode();
  const tabRefs = useRef<Partial<Record<DocumentView, HTMLButtonElement | null>>>({});
  const closePanel = useCallback(() => setPanel(null), []);

  useEffect(() => {
    if (!location.hash) return undefined;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!target) return undefined;
    target.scrollIntoView({ block: "start" });
    target.classList.add("is-targeted");
    return () => target.classList.remove("is-targeted");
  }, [location.hash, view]);

  function showView(next: DocumentView, focusTab = false) {
    setView(next);
    if (focusTab) requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }

  const openProposals = proposals.items.filter((p) => p.status !== "rejected" && p.status !== "merged");
  const more: MenuItem[] = [
    {
      id: "details",
      label: panel === "details" ? "Скрыть сведения" : "Сведения о документе",
      icon: "info",
      onSelect: () => setPanel((current) => (current === "details" ? null : "details")),
    },
    {
      id: "graph",
      label: "Показать на карте знаний",
      icon: "map",
      onSelect: () => navigate(`/graph?focus=${encodeURIComponent(doc.id)}`),
    },
    ...(aiOff
      ? []
      : [
          {
            id: "ask",
            label: "Спросить ассистента",
            icon: "assistant" as const,
            onSelect: () => navigate(`/ask?about=${encodeURIComponent(doc.title)}`),
          },
        ]),
    { id: "raw", label: "Исходный Markdown", icon: "file-text", onSelect: () => showView("raw", true) },
  ];

  return (
    <article className={`document doc-page${panel && panelMode === "inline" ? " doc-page--with-panel" : ""}`}>
      <PageToolbar
        crumbs={[
          { label: "Документы", to: "/documents" },
          { label: TYPE_LABEL[doc.type], to: `/documents?type=${doc.type}` },
          { label: doc.title },
        ]}
        actions={
          <>
            <Link
              to={`/proposals/new?document=${encodeURIComponent(doc.id)}`}
              className={buttonClass("secondary", "md", "button--collapsible")}
            >
              <Icon name="edit" />
              <span className="button__label">Предложить изменение</span>
            </Link>
            {/* The document assistant toggle («Ассистент», ⌘J) goes here, before «Ещё». */}
            <Menu
              label="Действия с документом"
              align="end"
              groups={[{ items: more }]}
              trigger={(props) => <IconButton {...props} icon="more" label="Ещё" variant="secondary" />}
            />
          </>
        }
      />

      <div className="doc-page__body">
        <div className="doc-page__main">
          <header className="doc-head">
            <p className="doc-head__status">
              <StatusMark status={doc.status} />
              <code className="doc-id">{doc.id}</code>
              {doc.is_demo ? (
                <span className="doc-head__demo" title="Синтетический документ для проверки приложения — не источник фактов о банке.">
                  Демо-документ
                </span>
              ) : null}
            </p>
            <h1 className="doc-head__title">{doc.title}</h1>
            <DocumentProperties
              doc={doc}
              links={links}
              onShowLinks={() => showView("links", true)}
              onShowDetails={() => setPanel("details")}
            />
          </header>

          {doc.index_state === "stale" ? (
            <Notice tone="warning">
              <strong>Версия может быть устаревшей.</strong> Последняя синхронизация не смогла обновить этот документ —
              показана последняя известная ревизия <code>{doc.revision}</code>
              {doc.updated_at ? ` от ${formatDateTime(doc.updated_at)}` : ""}. Актуальный текст в источнике может
              отличаться.
            </Notice>
          ) : null}
          {doc.status === "draft" || doc.status === "in_review" ? (
            <Notice tone="info">
              Документ не утверждён: ассистент использует его только если явно включить «Учитывать черновики».
            </Notice>
          ) : null}
          {doc.status === "deprecated" ? (
            <Notice tone="danger">Документ устарел и не используется ассистентом как доказательство.</Notice>
          ) : null}
          {doc.warnings.length > 0 ? (
            <Notice tone="warning">
              <p>Замечания проверки метаданных:</p>
              <ul>
                {doc.warnings.map((w) => (
                  <li key={`${w.code}-${w.field ?? ""}`}>{w.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {openProposals.length > 0 ? (
            <Notice tone="info">
              <p>Предложения изменений к этому документу:</p>
              <ul>
                {openProposals.map((p) => (
                  <li key={p.id}>
                    <Link to={`/proposals/${p.id}`}>{p.reason}</Link> <ProposalStateLabel status={p.status} />
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div className="tabs doc-tabs" role="tablist" aria-label="Представление документа" onKeyDown={onTabListKeyDown}>
            {VIEWS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                id={`doc-tab-${option.value}`}
                ref={(el) => {
                  tabRefs.current[option.value] = el;
                }}
                aria-selected={view === option.value}
                tabIndex={view === option.value ? 0 : -1}
                aria-controls="doc-panel"
                onClick={() => setView(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div id="doc-panel" role="tabpanel" aria-labelledby={`doc-tab-${view}`} className={`doc-panel doc-panel--${view}`}>
            {view === "text" ? (
              <>
                <WikiLinkPreviewArea>
                  <SafeHtml html={doc.content_html} className="prose" />
                </WikiLinkPreviewArea>
                {/* Without an AI provider the block is not shown at all (the manual path is the page itself). */}
                {aiOff ? null : <DocumentAiPanel doc={doc} />}
              </>
            ) : view === "links" ? (
              <DocumentLinksPanel
                links={links.data}
                error={links.error}
                loading={links.loading}
                onRetry={reloadLinks}
                actions={
                  <Link to={`/graph?focus=${encodeURIComponent(doc.id)}`} className={buttonClass("secondary", "sm")}>
                    <Icon name="map" size={14} />
                    Связи на графе
                  </Link>
                }
              />
            ) : view === "history" ? (
              <DocumentHistory doc={doc} proposals={proposals.items} publication={publication} />
            ) : (
              <pre className="raw-source" id="doc-raw">
                <code>{doc.raw}</code>
              </pre>
            )}
          </div>
        </div>

        {panel === "details" ? (
          <SidePanel id="document-details" title="Сведения о документе" mode={panelMode} onClose={closePanel}>
            <DocumentDetails doc={doc} publication={{ status: publication.data, failed: publication.failed }} />
          </SidePanel>
        ) : null}
      </div>
    </article>
  );
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useAsync(() => loadDocument(id), id);
  // Loaded separately: a publication or links problem never hides the document itself.
  const publication = useAsync(() => api.documentPublication(id), `publication-${id}`);
  const links = useAsync(() => api.documentLinks(id), `links-${id}`);

  if (loading && !data) return <Loading label="Загрузка документа…" />;
  if (error) {
    return (
      <div className="stack">
        <ErrorState
          error={error}
          onRetry={error.status >= 500 || error.status === 0 ? reload : undefined}
          title={error.status === 404 ? "Документ не найден" : undefined}
          page
        />
        <Link to="/documents" className="text-link">
          Вернуться к списку документов
        </Link>
      </div>
    );
  }
  if (!data) return null;
  return (
    <DocumentBody
      key={data.doc.id}
      doc={data.doc}
      proposals={data.proposals}
      links={{ data: links.data, error: links.error, loading: links.loading }}
      reloadLinks={links.reload}
      publication={{ data: publication.data, failed: publication.error !== null }}
    />
  );
}
