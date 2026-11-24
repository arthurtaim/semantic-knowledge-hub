import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { IntegrationsResponse, PublicationJobList, PublicationJobSummary, SessionResponse } from "../api/types";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { PublicationJobStateLabel } from "../components/PublicationState";
import { When } from "../components/When";
import { PageToolbar } from "../components/shell/PageToolbar";
import { shortRevision } from "../lib/labels";
import { PUBLISHER_INTEGRATION_HREF } from "../lib/routes";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";
import { useMediaQuery } from "../lib/useMediaQuery";

/** Phones: card rows instead of the table, as in the proposals list (docs/ui-v2/specs/03_SCREENS.md §6). */
const PHONE = "(max-width: 719.98px)";
/** GET /api/publications/jobs returns the newest jobs only (docs/API_CONTRACTS.md: newest first, ≤ 50). */
const SERVER_LIMIT = 50;

interface Jobs {
  list: PublicationJobList;
  /** Document titles from the reader's snapshot; a document the reader cannot open keeps only its ID. */
  titles: Map<string, string>;
}

/** The job list names no titles: they come from the documents themselves, and a failed lookup never hides a job. */
async function loadJobs(): Promise<Jobs> {
  const list = await api.publicationJobs();
  const ids = [...new Set(list.items.map((job) => job.document_id))];
  const documents = await Promise.allSettled(ids.map((id) => api.document(id)));
  const titles = new Map<string, string>();
  documents.forEach((result, index) => {
    const id = ids[index];
    if (id && result.status === "fulfilled") titles.set(id, result.value.title);
  });
  return { list, titles };
}

/**
 * What the server says about the Confluence publisher: the integration row (`confluence_publisher`) with its state
 * and message; without it (the status needs another permission) only the session's `confluence_publish` flag.
 */
type Publisher =
  | { kind: "loading" }
  | { kind: "off"; message: string | null }
  | { kind: "error"; message: string }
  | { kind: "on" };

function publisherOf(status: IntegrationsResponse | null, statusLoading: boolean, session: SessionResponse | null): Publisher {
  const item = status?.items.find((i) => i.name === "confluence_publisher");
  if (item) {
    if (item.state === "disabled") return { kind: "off", message: item.human_readable_message || null };
    if (item.state === "error") return { kind: "error", message: item.human_readable_message };
    return { kind: "on" };
  }
  if (statusLoading) return { kind: "loading" };
  if (session?.features.confluence_publish === false) return { kind: "off", message: null };
  return { kind: "on" };
}

const jobHref = (job: PublicationJobSummary) => `/publications/${encodeURIComponent(job.id)}`;
const documentHref = (job: PublicationJobSummary) => `/documents/${encodeURIComponent(job.document_id)}`;

/** A press on the row (outside its links) opens the job; the title link stays the keyboard and AT path. */
function useRowOpen() {
  const navigate = useNavigate();
  return (job: PublicationJobSummary) => (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return; // selecting text is not a click
    navigate(jobHref(job));
  };
}

/** The title opens the job page; the ID opens the document. Without a known title the ID is the job link. */
function DocumentCell({ job, title, block }: { job: PublicationJobSummary; title: string | undefined; block?: boolean }) {
  if (!title) {
    return (
      <Link to={jobHref(job)} className="publications__title">
        <code className="doc-id">{job.document_id}</code>
      </Link>
    );
  }
  return (
    <>
      <Link to={jobHref(job)} className="publications__title">
        {title}
      </Link>
      {/* The name starts with the visible ID (WCAG 2.5.3) and says where it leads, unlike the title. */}
      <Link
        to={documentHref(job)}
        className={`publications__doc${block ? " publications__doc--block" : ""}`}
        aria-label={`${job.document_id}, открыть документ`}
      >
        <code className="doc-id">{job.document_id}</code>
      </Link>
    </>
  );
}

/** The Confluence page the job wrote to (or found), as the job reports it; the space is not part of a job. */
function PageCell({ job }: { job: PublicationJobSummary }) {
  if (!job.page_id) return <span className="muted">—</span>;
  return (
    <span>
      Страница <code className="doc-id">{job.page_id}</code>
      {job.version_after != null ? <>, версия {job.version_after}</> : null}
    </span>
  );
}

function PublicationCard({ job, title }: { job: PublicationJobSummary; title: string | undefined }) {
  const open = useRowOpen();
  return (
    <li className="publication-card" onClick={open(job)}>
      <span className="publication-card__title">
        <DocumentCell job={job} title={title} />
      </span>
      <span className="publication-card__meta">
        <PublicationJobStateLabel state={job.state} />
        {job.page_id ? <PageCell job={job} /> : null}
        <span>
          ревизия <code className="doc-id">{shortRevision(job.revision)}</code>
        </span>
        <When value={job.updated_at} />
      </span>
    </li>
  );
}

function PublicationTable({ jobs }: { jobs: Jobs }) {
  const open = useRowOpen();
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">Задания публикации в Confluence</caption>
        <thead>
          <tr>
            <th scope="col">Документ</th>
            <th scope="col">Состояние</th>
            <th scope="col">Страница Confluence</th>
            <th scope="col">Ревизия</th>
            <th scope="col">Обновлено</th>
          </tr>
        </thead>
        <tbody>
          {jobs.list.items.map((job) => (
            <tr key={job.id} onClick={open(job)}>
              <td>
                <DocumentCell job={job} title={jobs.titles.get(job.document_id)} block />
              </td>
              <td>
                <PublicationJobStateLabel state={job.state} />
              </td>
              <td>
                <PageCell job={job} />
              </td>
              <td>
                <code className="doc-id">{shortRevision(job.revision)}</code>
              </td>
              <td>
                <When value={job.updated_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The publisher's row on the integrations page (its state, target and message). */
function IntegrationsLink() {
  return (
    <Link to={PUBLISHER_INTEGRATION_HREF} className="button button--secondary">
      Интеграции
    </Link>
  );
}

/** The server's own words about the publisher, marked as such. */
function ServerMessage({ message }: { message: string }) {
  return (
    <p className="publications__server">
      <span className="muted">Состояние интеграции: </span>
      {message}
    </p>
  );
}

const WHAT_IT_NEEDS =
  "Для публикации нужны настроенный Confluence REST (целевое пространство и родительская страница) и GitLab как " +
  "источник смёрженных ревизий утверждённых документов. Публикация включается только отдельной настройкой, а каждая " +
  "страница публикуется после предпросмотра и явного подтверждения.";

/**
 * «Публикации»: the publication jobs (GET /api/publications/jobs), newest first — the document, the job state, the
 * Confluence page the job reports, the revision and when it last changed; a row opens the job page. Empty, it says
 * honestly why: publication is not configured (the server's message and what it needs), or nothing was published yet.
 */
export function PublicationsPage() {
  const session = useSession();
  const phone = useMediaQuery(PHONE);
  const jobs = useAsync(loadJobs, "publication-jobs");
  const status = useAsync(() => api.integrations(), "integrations");
  const publisher = publisherOf(status.data, status.loading && !status.data, session);
  const items = jobs.data?.list.items ?? [];

  return (
    <div className="publications">
      <PageToolbar title="Публикации" meta={jobs.data ? <span className="page-toolbar__count">{items.length}</span> : null} />
      <div className="page-head">
        <h1>Публикации</h1>
        <p className="lead">
          Задания публикации утверждённых документов из GitLab в Confluence. Каждое задание относится к одной ревизии
          документа: сначала предпросмотр без записи, затем явное подтверждение.
        </p>
      </div>
      <div aria-live="polite">
        {jobs.loading && !jobs.data ? <Loading label="Загрузка публикаций…" /> : null}
        {jobs.error ? <ErrorState error={jobs.error} onRetry={jobs.reload} /> : null}
      </div>

      {jobs.data && items.length > 0 && publisher.kind === "off" ? (
        <Notice tone="info">
          <p>Публикация в Confluence сейчас выключена: новые публикации недоступны. Ниже — задания, созданные раньше.</p>
          {publisher.message ? <ServerMessage message={publisher.message} /> : null}
          <div className="button-row">
            <IntegrationsLink />
          </div>
        </Notice>
      ) : null}
      {jobs.data && publisher.kind === "error" ? (
        <Notice tone="warning">
          <p>Публикация в Confluence настроена, но проверка подключения не прошла.</p>
          <ServerMessage message={publisher.message} />
          <div className="button-row">
            <IntegrationsLink />
          </div>
        </Notice>
      ) : null}

      {jobs.data && items.length === 0 && publisher.kind === "loading" ? <Loading label="Проверяем публикацию в Confluence…" /> : null}
      {jobs.data && items.length === 0 && publisher.kind === "off" ? (
        <EmptyState title="Публикация в Confluence выключена">
          {publisher.message ? <ServerMessage message={publisher.message} /> : null}
          <p>{WHAT_IT_NEEDS}</p>
          <div className="button-row">
            <IntegrationsLink />
          </div>
        </EmptyState>
      ) : null}
      {jobs.data && items.length === 0 && (publisher.kind === "on" || publisher.kind === "error") ? (
        <EmptyState title="Публикаций пока нет">
          <p>
            Публикация начинается с утверждённого документа: откройте его, перейдите в «История» и в блоке «Публикация в
            Confluence» нажмите «Подготовить публикацию». После merge предложения в GitLab задание создаётся само; в
            Confluence ничего не записывается до предпросмотра и подтверждения.
          </p>
          <div className="button-row">
            <Link to="/documents" className="button button--secondary">
              Перейти к документам
            </Link>
          </div>
        </EmptyState>
      ) : null}

      {jobs.data && items.length > 0 && phone ? (
        <ul className="publication-cards" aria-label="Задания публикации в Confluence">
          {items.map((job) => (
            <PublicationCard key={job.id} job={job} title={jobs.data?.titles.get(job.document_id)} />
          ))}
        </ul>
      ) : null}
      {jobs.data && items.length > 0 && !phone ? <PublicationTable jobs={jobs.data} /> : null}
      {items.length >= SERVER_LIMIT ? (
        <p className="muted">Показаны {SERVER_LIMIT} последних заданий: более ранние сервер в этом списке не возвращает.</p>
      ) : null}
    </div>
  );
}
