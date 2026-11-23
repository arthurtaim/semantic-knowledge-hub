import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { DocumentDetail, DocumentPublicationStatus, ProposalList } from "../api/types";
import { PublicationPassportRow, PublicationSection } from "../components/DocumentPublication";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { ProposalStateLabel } from "../components/ProposalState";
import { SafeHtml } from "../components/SafeHtml";
import { StaleMark } from "../components/StaleMark";
import { StatusStamp } from "../components/StatusStamp";
import { formatDate, formatDateTime, REVIEW_LABEL, SOURCE_LABEL, TYPE_LABEL } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

const isHttpUrl = (value: string | null): value is string => Boolean(value && /^https?:\/\//i.test(value));

/** Where the document lives: a validated link to this exact revision, or an honest "local workspace" note. */
function SourceLocation({ doc }: { doc: DocumentDetail }) {
  if (isHttpUrl(doc.web_url)) {
    return (
      <a href={doc.web_url} className="passport__source-link" target="_blank" rel="noopener noreferrer">
        {doc.source === "gitlab" ? "Открыть в GitLab" : "Открыть в источнике"}
        <span aria-hidden="true"> ↗</span>
      </a>
    );
  }
  if (doc.source === "local") {
    return <span className="passport__note">Документ хранится в локальном workspace — внешней ссылки нет.</span>;
  }
  return <span className="passport__note">Ссылка на ревизию в источнике не указана.</span>;
}

async function loadDocument(id: string): Promise<{ doc: DocumentDetail; proposals: ProposalList }> {
  const [doc, proposals] = await Promise.all([api.document(id), api.drafts({ document_id: id })]);
  return { doc, proposals };
}

interface PublicationInfo {
  status: DocumentPublicationStatus | null;
  failed: boolean;
}

function Passport({ doc, publication }: { doc: DocumentDetail; publication: PublicationInfo }) {
  return (
    <aside className="passport" aria-labelledby="passport-title">
      <h2 id="passport-title" className="passport__title">
        Паспорт документа
      </h2>
      <StatusStamp status={doc.status} large />
      <dl className="passport__fields">
        {doc.is_demo ? (
          // The only in-page demo notice: a fact about the document, next to the other trust facts.
          <div className="passport__demo">
            <dt>Демо-документ</dt>
            <dd>
              <strong>Демо-данные.</strong> Синтетический документ для проверки приложения — не источник фактов о
              банке.
            </dd>
          </div>
        ) : null}
        <div>
          <dt>ID</dt>
          <dd>
            <code className="doc-id">{doc.id}</code>
          </dd>
        </div>
        <div>
          <dt>Раздел</dt>
          <dd>
            <Link to={`/documents?type=${doc.type}`}>{TYPE_LABEL[doc.type]}</Link>
          </dd>
        </div>
        <div>
          <dt>Владелец</dt>
          <dd className={doc.owner_missing ? "flag" : undefined}>
            {doc.owner_missing ? `не назначен (${doc.owner})` : doc.owner}
          </dd>
        </div>
        <div>
          <dt>Проверен</dt>
          <dd>
            {formatDate(doc.reviewed_at)}
            {doc.review_state === "stale" || doc.review_state === "never_reviewed" ? (
              <span className="flag flag--block">{REVIEW_LABEL[doc.review_state]}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Ревизия</dt>
          <dd>
            <code className="doc-id">{doc.revision}</code>
            {doc.index_state === "stale" ? <StaleMark /> : null}
          </dd>
        </div>
        <div>
          <dt>Дата ревизии</dt>
          <dd>
            {doc.updated_at ? <time dateTime={doc.updated_at}>{formatDateTime(doc.updated_at)}</time> : "не указана"}
          </dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>
            {SOURCE_LABEL[doc.source]}
            <code className="passport__uri">{doc.source_uri}</code>
            <SourceLocation doc={doc} />
          </dd>
        </div>
        <div>
          <dt>Файл</dt>
          <dd>
            <code className="passport__uri">{doc.path}</code>
          </dd>
        </div>
        <PublicationPassportRow status={publication.status} failed={publication.failed} />
        {doc.tags.length > 0 ? (
          <div>
            <dt>Теги</dt>
            <dd>
              <ul className="tags">
                {doc.tags.map((tag) => (
                  <li key={tag}>
                    <Link to={`/documents?tag=${encodeURIComponent(tag)}`} className="tag">
                      {tag}
                    </Link>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {Object.entries(doc.extra_metadata).map(([key, value]) => (
          <div key={key}>
            <dt>
              <code>{key}</code>
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {doc.related.length > 0 ? (
        <section className="passport__related" aria-labelledby="related-title">
          <h3 id="related-title">Связанные документы</h3>
          <ul>
            {doc.related.map((rel) =>
              rel.resolved ? (
                <li key={rel.id}>
                  <Link to={`/documents/${rel.id}`}>{rel.title}</Link>
                  <code className="doc-id">{rel.id}</code>
                </li>
              ) : (
                <li key={rel.id} className="muted">
                  <code className="doc-id">{rel.id}</code> — не найден в базе знаний
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}
      {doc.source_refs.length > 0 ? (
        <section className="passport__related" aria-labelledby="refs-title">
          <h3 id="refs-title">Внешние источники</h3>
          <ul>
            {doc.source_refs.map((ref) => (
              <li key={ref}>
                <code className="passport__uri">{ref}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const { data, error, loading, reload } = useAsync(() => loadDocument(id), id);
  // Loaded separately: a publication problem never hides the document itself.
  const publication = useAsync(() => api.documentPublication(id), `publication-${id}`);

  useEffect(() => {
    if (!data || !location.hash) return;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) {
      target.scrollIntoView({ block: "start" });
      target.classList.add("is-targeted");
      return () => target.classList.remove("is-targeted");
    }
    return undefined;
  }, [data, location.hash]);

  if (loading && !data) return <Loading label="Загрузка документа…" />;
  if (error) {
    return (
      <div className="stack">
        <ErrorState
          error={error}
          onRetry={error.status >= 500 || error.status === 0 ? reload : undefined}
          title={error.status === 404 ? "Документ не найден" : undefined}
        />
        <Link to="/documents" className="text-link">
          Вернуться к списку документов
        </Link>
      </div>
    );
  }
  if (!data) return null;
  const { doc, proposals } = data;
  const openProposals = proposals.items.filter((p) => p.status !== "rejected" && p.status !== "merged");

  return (
    <article className="document">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to="/documents">База знаний</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/documents?type=${doc.type}`}>{TYPE_LABEL[doc.type]}</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{doc.id}</span>
      </nav>

      <header className="document__head">
        <h1>{doc.title}</h1>
        <p className="document__compact-meta">
          <StatusStamp status={doc.status} /> <code className="doc-id">{doc.id}</code>
        </p>
        {doc.summary ? <p className="lead">{doc.summary}</p> : null}
        <div className="document__actions">
          <Link to={`/proposals/new?document=${encodeURIComponent(doc.id)}`} className="button button--primary">
            Предложить изменение
          </Link>
          <Link to={`/ask?about=${encodeURIComponent(doc.title)}`} className="button button--secondary">
            Спросить ассистента
          </Link>
          <Link to={`/graph?focus=${encodeURIComponent(doc.id)}`} className="button button--quiet">
            Связи на графе
          </Link>
        </div>
      </header>

      <div className="document__layout">
        <div className="document__main">
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

          <div className="tabs" role="tablist" aria-label="Представление документа">
            <button
              type="button"
              role="tab"
              id="tab-rendered"
              aria-selected={view === "rendered"}
              aria-controls="panel-document"
              onClick={() => setView("rendered")}
            >
              Документ
            </button>
            <button
              type="button"
              role="tab"
              id="tab-raw"
              aria-selected={view === "raw"}
              aria-controls="panel-document"
              onClick={() => setView("raw")}
            >
              Исходный Markdown
            </button>
          </div>
          <div
            id="panel-document"
            role="tabpanel"
            aria-labelledby={view === "rendered" ? "tab-rendered" : "tab-raw"}
          >
            {view === "rendered" ? (
              <SafeHtml html={doc.content_html} className="prose" />
            ) : (
              <pre className="raw-source">
                <code>{doc.raw}</code>
              </pre>
            )}
          </div>
          {publication.data ? <PublicationSection status={publication.data} /> : null}
        </div>
        <Passport doc={doc} publication={{ status: publication.data, failed: publication.error !== null }} />
      </div>
    </article>
  );
}
