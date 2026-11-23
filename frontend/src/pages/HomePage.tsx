import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ProposalSummary } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { IndexStatusNotice } from "../components/IndexStatusNotice";
import { OperationBadge, ProposalStateLabel } from "../components/ProposalState";
import { StaleMark } from "../components/StaleMark";
import { StateBadge } from "../components/StateBadge";
import { StatusStamp } from "../components/StatusStamp";
import {
  formatDate,
  formatDateTime,
  PROPOSAL_NEEDS_ACTION,
  REVIEW_LABEL,
  SOURCE_LABEL,
  TYPE_LABEL,
  TYPE_ORDER,
} from "../lib/labels";
import { useAsync } from "../lib/useAsync";

const RECENT_LIMIT = 5;
const PROPOSALS_LIMIT = 5;
const NEEDS_ACTION = new Set(PROPOSAL_NEEDS_ACTION);

async function loadHome() {
  const [facets, documents, integrations] = await Promise.all([
    api.facets(),
    api.documents({ size: 100 }),
    api.integrations(),
  ]);
  return { facets, documents: documents.items, integrations: integrations.items };
}

function byUpdatedDesc(a: ProposalSummary, b: ProposalSummary): number {
  return b.updated_at.localeCompare(a.updated_at);
}

function RecentlyUpdated() {
  const recent = useAsync(() => api.documents({ sort: "updated", size: RECENT_LIMIT }), "home-recent");
  // The server puts documents without a date last; they are not "recent", so they are not listed here.
  const items = (recent.data?.items ?? []).filter((d) => d.updated_at);
  return (
    <section aria-labelledby="recent-title" className="panel">
      <h2 id="recent-title">Недавно обновлённые</h2>
      {recent.loading && !recent.data ? <Loading /> : null}
      {recent.error ? <ErrorState error={recent.error} onRetry={recent.reload} /> : null}
      {recent.data && items.length === 0 ? (
        <p className="muted">
          {recent.data.total === 0
            ? "В базе знаний пока нет документов."
            : "Источник не сообщает даты обновления документов — список недоступен."}
        </p>
      ) : null}
      {items.length > 0 ? (
        <>
          <ul className="doc-rows">
            {items.map((doc) => (
              <li key={doc.id} className="doc-row">
                <Link to={`/documents/${doc.id}`} className="doc-row__title">
                  {doc.title}
                </Link>
                <span className="doc-row__meta">
                  <code className="doc-id">{doc.id}</code>
                  <span>
                    обновлён <time dateTime={doc.updated_at ?? undefined}>{formatDate(doc.updated_at)}</time>
                  </span>
                  <span>{SOURCE_LABEL[doc.source]}</span>
                  {doc.index_state === "stale" ? <StaleMark /> : null}
                </span>
              </li>
            ))}
          </ul>
          <Link to="/documents?sort=updated" className="text-link">
            Все документы по дате обновления
          </Link>
        </>
      ) : null}
    </section>
  );
}

function ProposalsNeedingAction() {
  const drafts = useAsync(() => api.drafts(), "home-proposals");
  const items = (drafts.data?.items ?? []).filter((p) => NEEDS_ACTION.has(p.status)).sort(byUpdatedDesc);
  return (
    <section aria-labelledby="proposals-title" className="panel">
      <h2 id="proposals-title">Предложения, требующие действия</h2>
      {drafts.loading && !drafts.data ? <Loading /> : null}
      {drafts.error ? <ErrorState error={drafts.error} onRetry={drafts.reload} /> : null}
      {drafts.data && items.length === 0 ? (
        <EmptyState title="Нет предложений, требующих действия">
          <p>Чтобы предложить правку, откройте документ и нажмите «Предложить изменение».</p>
          <Link to="/documents" className="text-link">
            Перейти в каталог документов
          </Link>
        </EmptyState>
      ) : null}
      {items.length > 0 ? (
        <>
          <ul className="doc-rows">
            {items.slice(0, PROPOSALS_LIMIT).map((p) => (
              <li key={p.id} className="doc-row">
                <Link to={`/proposals/${p.id}`} className="doc-row__title">
                  {p.document_title}
                </Link>
                <span className="doc-row__meta">
                  <OperationBadge operation={p.operation} />
                  <ProposalStateLabel status={p.status} />
                  <span>{p.reason}</span>
                  <span>обновлено {formatDateTime(p.updated_at)}</span>
                </span>
              </li>
            ))}
          </ul>
          {items.length > PROPOSALS_LIMIT ? (
            <p className="muted">Показаны {PROPOSALS_LIMIT} из {items.length}.</p>
          ) : null}
        </>
      ) : null}
      <Link to="/proposals" className="text-link">
        Все предложения
      </Link>
    </section>
  );
}

function HomeIndexStatus() {
  const index = useAsync(() => api.indexStatus(), "home-index");
  if (index.error) return <p className="muted">Не удалось получить состояние синхронизации базы знаний.</p>;
  return index.data ? <IndexStatusNotice status={index.data} /> : null;
}

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { data, error, loading, reload } = useAsync(loadHome, "home");

  function onSearch(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    navigate(q ? `/documents?query=${encodeURIComponent(q)}` : "/documents");
  }

  const typeCounts = new Map(data?.facets.types.map((f) => [f.value, f.count]) ?? []);
  const attention = (data?.documents ?? []).filter(
    (d) => d.owner_missing || d.review_state === "stale" || d.review_state === "never_reviewed",
  );
  const askHref = query.trim() ? `/ask?q=${encodeURIComponent(query.trim())}` : "/ask";

  return (
    <div className="home">
      <section className="home__intro" aria-labelledby="home-title">
        <h1 id="home-title">База знаний семантического слоя</h1>
        <p className="lead">
          Ищите документы команды, задавайте вопросы с проверяемыми ссылками на источники и предлагайте правки через
          ревью.
        </p>
        <div className="home__actions">
          <form className="search-box" role="search" onSubmit={onSearch}>
            <label htmlFor="home-search" className="visually-hidden">
              Поиск по базе знаний
            </label>
            <input
              id="home-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Например: ARIS, ревизия, FTS5"
              maxLength={200}
              autoComplete="off"
            />
            <button type="submit" className="button button--primary">
              Найти
            </button>
          </form>
          <Link to={askHref} className="button button--ask">
            Спросить ассистента
          </Link>
          <Link to="/documents/new" className="button button--secondary home__create">
            Создать документ
          </Link>
        </div>
        <p className="home__hint muted">
          Ассистент отвечает только по найденным документам и показывает ссылки на источники.
        </p>
      </section>

      <HomeIndexStatus />

      {loading && !data ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <div className="home__grid">
        {data ? (
          <section aria-labelledby="sections-title" className="panel">
            <h2 id="sections-title">Разделы</h2>
            <ul className="index-list">
              {TYPE_ORDER.map((type) => {
                const count = typeCounts.get(type) ?? 0;
                return (
                  <li key={type}>
                    <Link to={`/documents?type=${type}`} className="index-list__link">
                      <span>{TYPE_LABEL[type]}</span>
                      <span className="index-list__count" aria-label={`документов: ${count}`}>
                        {count}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <RecentlyUpdated />
        <ProposalsNeedingAction />

        {data ? (
          <section aria-labelledby="attention-title" className="panel">
            <h2 id="attention-title">Требуют внимания</h2>
            {attention.length === 0 ? (
              <p className="muted">У всех документов есть владелец и актуальная проверка.</p>
            ) : (
              <ul className="doc-rows">
                {attention.map((doc) => (
                  <li key={doc.id} className="doc-row">
                    <Link to={`/documents/${doc.id}`} className="doc-row__title">
                      {doc.title}
                    </Link>
                    <span className="doc-row__meta">
                      <StatusStamp status={doc.status} />
                      {doc.owner_missing ? <span className="flag">Владелец не назначен</span> : null}
                      {doc.review_state === "stale" || doc.review_state === "never_reviewed" ? (
                        <span className="flag">{REVIEW_LABEL[doc.review_state]}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {data ? (
          <section aria-labelledby="integrations-title" className="panel">
            <h2 id="integrations-title">Источники и интеграции</h2>
            <ul className="integration-mini">
              {data.integrations.map((item) => (
                <li key={item.name}>
                  <span>{item.title}</span>
                  <StateBadge state={item.state} />
                </li>
              ))}
            </ul>
            <Link to="/integrations" className="text-link">
              Подробнее о подключениях
            </Link>
          </section>
        ) : null}
      </div>
    </div>
  );
}
