import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { DocumentPublicationStatus } from "../api/types";
import {
  formatDateTime,
  INTEGRATION_TARGET_LABEL,
  PUBLICATION_ERROR_HINT,
  PUBLICATION_ERROR_TITLE,
  PUBLISHER_MODE_LABEL,
  shortRevision,
} from "../lib/labels";
import { ErrorState, Notice } from "./Feedback";
import { PublicationStateLabel } from "./PublicationState";

const isHttpUrl = (value: string | null | undefined): value is string => Boolean(value && /^https?:\/\//i.test(value));

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/** One passport row: the publication state, or a quiet note when publication is not configured. */
export function PublicationPassportRow({ status, failed }: { status: DocumentPublicationStatus | null; failed: boolean }) {
  if (!status && !failed) return null;
  return (
    <div>
      <dt>Confluence</dt>
      <dd>
        {!status ? (
          <span className="muted">состояние публикации недоступно</span>
        ) : status.publisher.mode === "disabled" ? (
          <span className="muted">публикация не настроена</span>
        ) : (
          <>
            <PublicationStateLabel state={status.state} />{" "}
            <a href="#publication" className="passport__note">
              Подробнее о публикации
            </a>
          </>
        )}
      </dd>
    </div>
  );
}

/**
 * «Публикация в Confluence» on the document page: GitLab revision, publication state, published revision,
 * the Confluence page and the last error. Publishing itself happens only on the job page, after a preview.
 */
export function PublicationSection({ status }: { status: DocumentPublicationStatus }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef(false);
  const { publisher, mapping, latest_job: job } = status;
  if (publisher.mode === "disabled") return null; // the passport shows a quiet note instead

  const mock = publisher.target_kind === "mock";
  const jobProblem =
    job && job.error_message && (status.state === "failed" || status.state === "conflict" || status.state === "result_unknown")
      ? job
      : null;

  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const detail = await api.preparePublication(status.document_id);
      navigate(`/publications/${encodeURIComponent(detail.id)}`);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section id="publication" className="panel publication" aria-labelledby="publication-title">
      <div className="publication__head">
        <h2 id="publication-title">Публикация в Confluence</h2>
        <PublicationStateLabel state={status.state} />
      </div>
      <p>{status.message}</p>
      {mock ? (
        <p className="publication__mock">
          <span className="pub-mock-tag">тестовый дубль Confluence</span> Публикация идёт в локальный тестовый дубль, а
          не в корпоративный Confluence.
        </p>
      ) : null}
      <dl className="publication__facts">
        <div>
          <dt>Ревизия в GitLab</dt>
          <dd>
            <code className="doc-id">{shortRevision(status.current_revision)}</code>
          </dd>
        </div>
        <div>
          <dt>Опубликованная ревизия</dt>
          <dd>
            {mapping ? <code className="doc-id">{shortRevision(mapping.published_revision)}</code> : "ещё не публиковался"}
          </dd>
        </div>
        <div>
          <dt>Последняя публикация</dt>
          <dd>{mapping ? formatDateTime(mapping.last_published_at) : "—"}</dd>
        </div>
        {mapping ? (
          <div>
            <dt>Страница</dt>
            <dd>
              «{mapping.page_title}», версия {mapping.page_version}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Пространство</dt>
          <dd>
            {publisher.space_key ? <code className="doc-id">{publisher.space_key}</code> : "не указано"}
            {publisher.parent_id ? (
              <span className="muted">
                {" "}
                · родительская страница <code className="doc-id">{publisher.parent_id}</code>
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Режим</dt>
          <dd>
            {PUBLISHER_MODE_LABEL[publisher.mode]}
            <span className="muted"> · {INTEGRATION_TARGET_LABEL[publisher.target_kind]}</span>
          </dd>
        </div>
      </dl>
      {mapping && isHttpUrl(mapping.url) ? (
        <p className="publication__link">
          <a href={mapping.url} target="_blank" rel="noopener noreferrer">
            Открыть страницу в Confluence<span aria-hidden="true"> ↗</span>
          </a>
          {mock ? <span className="pub-mock-tag">тестовый дубль Confluence</span> : null}
        </p>
      ) : null}
      {status.state === "outdated" && mapping ? (
        <Notice tone="warning">
          В Confluence опубликована ревизия <code className="doc-id">{shortRevision(mapping.published_revision)}</code>, а в
          GitLab уже <code className="doc-id">{shortRevision(status.current_revision)}</code>. Подготовьте публикацию
          актуальной ревизии.
        </Notice>
      ) : null}
      {jobProblem ? (
        <Notice tone={status.state === "result_unknown" ? "warning" : "danger"}>
          <p>
            <strong>{(jobProblem.error_code && PUBLICATION_ERROR_TITLE[jobProblem.error_code]) ?? "Последняя попытка публикации"}</strong>
          </p>
          {jobProblem.error_message !== status.message ? <p>{jobProblem.error_message}</p> : null}
          {jobProblem.error_code && PUBLICATION_ERROR_HINT[jobProblem.error_code] ? (
            <p>{PUBLICATION_ERROR_HINT[jobProblem.error_code]}</p>
          ) : null}
        </Notice>
      ) : null}
      {publisher.mode === "dry_run_only" ? (
        <p className="muted">
          Запись в Confluence выключена: можно подготовить и проверить предпросмотр, но не опубликовать.
        </p>
      ) : null}
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={!status.can_prepare || pending} onClick={prepare}>
          Подготовить публикацию
        </button>
        {job ? (
          <Link to={`/publications/${encodeURIComponent(job.id)}`} className="button button--secondary">
            {job.state === "published" || job.state === "superseded" ? "Подробнее о публикации" : "Открыть предпросмотр"}
          </Link>
        ) : null}
      </div>
      {!status.can_prepare ? (
        <p className="muted">Идёт публикация или её результат не подтверждён — откройте задание публикации.</p>
      ) : (
        <p className="muted">
          Сначала выполняется предпросмотр (dry-run): в Confluence ничего не записывается до отдельного подтверждения.
        </p>
      )}
      <div aria-live="polite" role="status">
        {pending ? <p className="muted">Готовим предпросмотр публикации…</p> : null}
      </div>
      {error ? <ErrorState error={error} title={PUBLICATION_ERROR_TITLE[error.code]} /> : null}
    </section>
  );
}
