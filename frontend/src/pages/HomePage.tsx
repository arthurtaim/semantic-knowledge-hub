import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { ProposalSummary } from "../api/types";
import { Composer, askHref, type AskScope } from "../components/Composer";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { IndexStatusNotice } from "../components/IndexStatusNotice";
import { OperationBadge, ProposalStateLabel } from "../components/ProposalState";
import { StaleMark } from "../components/StaleMark";
import { StateBadge } from "../components/StateBadge";
import { StatusStamp } from "../components/StatusStamp";
import {
  PROPOSAL_NEEDS_ACTION,
  REVIEW_LABEL,
  SOURCE_LABEL,
  TYPE_LABEL,
  TYPE_ORDER,
} from "../lib/labels";
import { canAsk } from "../lib/aiMode";
import { clearRecentQuestions, readRecentQuestions } from "../lib/recentQuestions";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";
import { When } from "../components/When";

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
    <section aria-labelledby="recent-title" className="home-section">
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
                    обновлён <When value={doc.updated_at} />
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
    <section aria-labelledby="proposals-title" className="home-section">
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
                  <span>
                    обновлено <When value={p.updated_at} />
                  </span>
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

const SCOPES: { value: AskScope; label: string }[] = [
  { value: "team", label: "Команда" },
  { value: "corporate", label: "Корпоративные" },
  { value: "both", label: "Оба" },
];

/** The user's recent questions (this browser only); each opens its answer again. */
function RecentQuestions() {
  const session = useSession();
  const userId = session?.user.user_id;
  const [items, setItems] = useState(() => readRecentQuestions(userId));
  useEffect(() => setItems(readRecentQuestions(userId)), [userId]);
  if (items.length === 0) return null;
  return (
    <section className="recent-questions" aria-labelledby="recent-questions-title">
      <h2 id="recent-questions-title">Недавние вопросы</h2>
      <ul>
        {items.map((question) => (
          <li key={question}>
            <Link to={askHref(question)} className="recent-questions__link">
              {question}
            </Link>
          </li>
        ))}
      </ul>
      <p className="recent-questions__note muted">
        Хранятся только в этом браузере.{" "}
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            clearRecentQuestions(userId);
            setItems([]);
          }}
        >
          Очистить
        </button>
      </p>
    </section>
  );
}

export function HomePage() {
  const session = useSession();
  const [scope, setScope] = useState<AskScope>("team");
  const { data, error, loading, reload } = useAsync(loadHome, "home");
  const ask = canAsk(session?.features.ai_mode);
  const corporateState = session?.features.corporate_search;

  const typeCounts = new Map(data?.facets.types.map((f) => [f.value, f.count]) ?? []);
  const attention = (data?.documents ?? []).filter(
    (d) => d.owner_missing || d.review_state === "stale" || d.review_state === "never_reviewed",
  );

  return (
    <div className="home">
      <section className="home__intro" aria-labelledby="home-title">
        <h1 id="home-title">База знаний семантического слоя</h1>
        <p className="lead">
          {ask
            ? "Спросите или найдите: ответ строится только по документам и начинается с цитат, а правки проходят ревью."
            : "Ищите документы команды и предлагайте правки через ревью. ИИ в этой установке отключён — поиск работает полностью."}
        </p>
        <Composer
          variant="hero"
          inputId="home-composer-input"
          scope={scope}
          renderExtra={(mode) =>
            mode === "ask" ? (
              <>
                <fieldset className="segmented composer__scope">
                  <legend>Где искать</legend>
                  {SCOPES.map((option) => (
                    <label key={option.value} className="segmented__option">
                      <input
                        type="radio"
                        name="home-scope"
                        value={option.value}
                        checked={scope === option.value}
                        onChange={() => setScope(option.value)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </fieldset>
                {scope !== "team" && corporateState === "disabled" ? (
                  <p className="field-hint">
                    Корпоративные источники (Confluence Data Center) не подключены — ответ будет только по документам
                    команды.
                  </p>
                ) : null}
                {scope !== "team" && corporateState === "mock" ? (
                  <p className="field-hint">Корпоративные источники — mock-коннектор с синтетическими страницами.</p>
                ) : null}
              </>
            ) : null
          }
        />
        <div className="home__actions">
          <Link to="/documents/new" className="button button--quiet home__create">
            Создать документ
          </Link>
          <Link to="/documents" className="button button--quiet">
            Открыть каталог
          </Link>
        </div>
        {ask ? <RecentQuestions /> : null}
      </section>

      <HomeIndexStatus />

      {loading && !data ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <div className="home__grid">
        <div className="home__main">
          <RecentlyUpdated />

          {data ? (
            <section aria-labelledby="attention-title" className="home-section">
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

          <ProposalsNeedingAction />
        </div>

        <div className="home__side">
          {data ? (
            <section aria-labelledby="sections-title" className="home-section">
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

          {data ? (
            <section aria-labelledby="integrations-title" className="home-section">
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
    </div>
  );
}
