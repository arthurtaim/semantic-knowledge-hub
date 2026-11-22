import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { DocumentSummary } from "../api/types";
import { ErrorState, Loading } from "../components/Feedback";
import { StateBadge } from "../components/StateBadge";
import { StatusStamp } from "../components/StatusStamp";
import { formatDate, REVIEW_LABEL, TYPE_LABEL, TYPE_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

async function loadHome() {
  const [facets, documents, integrations] = await Promise.all([
    api.facets(),
    api.documents({ size: 100 }),
    api.integrations(),
  ]);
  return { facets, documents: documents.items, integrations: integrations.items };
}

function byReviewDate(a: DocumentSummary, b: DocumentSummary): number {
  return (b.reviewed_at ?? "").localeCompare(a.reviewed_at ?? "");
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
  const verified = (data?.documents ?? [])
    .filter((d) => d.status === "approved" && d.review_state === "ok")
    .sort(byReviewDate)
    .slice(0, 5);
  const attention = (data?.documents ?? []).filter(
    (d) => d.owner_missing || d.review_state === "stale" || d.review_state === "never_reviewed",
  );

  return (
    <div className="home">
      <section className="home__intro" aria-labelledby="home-title">
        <h1 id="home-title">База знаний семантического слоя</h1>
        <p className="lead">
          Ищите документы команды, задавайте вопросы с проверяемыми ссылками на источники и предлагайте правки через
          ревью.
        </p>
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
      </section>

      {loading && !data ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {data ? (
        <div className="home__grid">
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

          <section aria-labelledby="verified-title" className="panel">
            <h2 id="verified-title">Недавно проверенные</h2>
            {verified.length === 0 ? (
              <p className="muted">Утверждённых документов с актуальной проверкой пока нет.</p>
            ) : (
              <ul className="doc-rows">
                {verified.map((doc) => (
                  <li key={doc.id} className="doc-row">
                    <Link to={`/documents/${doc.id}`} className="doc-row__title">
                      {doc.title}
                    </Link>
                    <span className="doc-row__meta">
                      <code className="doc-id">{doc.id}</code> проверен {formatDate(doc.reviewed_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
        </div>
      ) : null}
    </div>
  );
}
