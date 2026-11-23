import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { PublicationJobDetail, PublicationPlan, ValidationIssue } from "../api/types";
import { DiffView } from "../components/DiffView";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { PublicationJobStateLabel } from "../components/PublicationState";
import { parseUnifiedDiff } from "../lib/diff";
import {
  formatDateTime,
  INTEGRATION_TARGET_LABEL,
  PUBLICATION_ERROR_HINT,
  PUBLICATION_ERROR_TITLE,
  PUBLICATION_EVENT_LABEL,
  PUBLICATION_ISSUE_HINT,
  PUBLICATION_JOB_STATE_LABEL,
  PUBLISHER_MODE_LABEL,
  publicationActionText,
  shortRevision,
} from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { When } from "../components/When";

type JobAction = "dry_run" | "publish" | "reconcile" | "acknowledge" | "release";

const PENDING_TEXT: Record<JobAction, string> = {
  dry_run: "Выполняем предпросмотр: читаем Confluence, ничего не записываем…",
  publish: "Публикуем в Confluence: перед записью ещё раз проверяем страницу…",
  reconcile: "Проверяем состояние страницы в Confluence (без записи)…",
  acknowledge: "Принимаем текущую страницу как основу и обновляем предпросмотр…",
  release: "Проверяем, что страницы нет, и готовим создание новой (без записи)…",
};

const isHttpUrl = (value: string | null | undefined): value is string => Boolean(value && /^https?:\/\//i.test(value));

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function outcomeMessage(kind: JobAction, job: PublicationJobDetail): string {
  const label = PUBLICATION_JOB_STATE_LABEL[job.state];
  if (kind === "acknowledge") return "Ручная правка подтверждена. Предпросмотр обновлён: проверьте, что заменит публикация.";
  if (kind === "release") return "Привязка к удалённой странице снята. Предпросмотр обновлён: будет создана новая страница.";
  if (kind === "dry_run") return `Предпросмотр обновлён: «${label}».`;
  if (kind === "publish") {
    if (job.state === "published") {
      return job.action === "noop" ? "Изменений не было — новая версия страницы не создавалась." : "Опубликовано в Confluence.";
    }
    return `Публикация обработана: «${label}».`;
  }
  return job.state === "published"
    ? "Проверка подтвердила: страница опубликована."
    : `Состояние проверено в Confluence: «${label}».`;
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  return (
    <ul>
      {issues.map((issue) => (
        <li key={`${issue.code}-${issue.message}`} data-code={issue.code}>
          {issue.message}
          {PUBLICATION_ISSUE_HINT[issue.code] ? <span className="muted"> {PUBLICATION_ISSUE_HINT[issue.code]}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function MockTag({ mock }: { mock: boolean }) {
  return mock ? <span className="pub-mock-tag">тестовый дубль Confluence</span> : null;
}

/** What happened to the job, in plain words: success, failure, unconfirmed write, conflict or waiting. */
function Outcome({ job, mock, onReload }: { job: PublicationJobDetail; mock: boolean; onReload: () => void }) {
  const url = job.plan?.target.url;
  switch (job.state) {
    case "published":
      return (
        <Notice tone="success" className="publication-outcome">
          <p>
            <strong>Опубликовано в Confluence</strong>
          </p>
          <p>
            {job.action === "noop"
              ? "Изменений не было — новая версия страницы не создавалась."
              : `Страница ${job.page_id ?? ""}${job.version_after != null ? `, версия ${job.version_after}` : ""}${
                  job.published_at ? `, ${formatDateTime(job.published_at)}` : ""
                }.`}
          </p>
          {isHttpUrl(url) ? (
            <p>
              <a href={url} target="_blank" rel="noopener noreferrer">
                Открыть страницу в Confluence<span aria-hidden="true"> ↗</span>
              </a>{" "}
              <MockTag mock={mock} />
            </p>
          ) : null}
        </Notice>
      );
    case "failed":
      return (
        <Notice tone="danger" className="publication-outcome">
          <p>
            <strong>Публикация не выполнена</strong>
            {job.error_code && PUBLICATION_ERROR_TITLE[job.error_code] ? `: ${PUBLICATION_ERROR_TITLE[job.error_code]}` : ""}
          </p>
          {job.error_message ? <p>{job.error_message}</p> : null}
          {job.error_code && PUBLICATION_ERROR_HINT[job.error_code] ? <p>{PUBLICATION_ERROR_HINT[job.error_code]}</p> : null}
          <p>Ничего не перезаписано. После устранения причины нажмите «Повторить».</p>
        </Notice>
      );
    case "result_unknown":
      return (
        <Notice tone="warning" className="publication-outcome">
          <p>
            <strong>Результат публикации не подтверждён</strong>
          </p>
          <p>
            Запрос на запись отправлен, но ответ Confluence не получен — страница могла быть изменена. Нажмите «Проверить
            результат»: приложение сначала проверит Confluence и не создаст дубликат страницы.
          </p>
          {job.error_message ? <p className="muted">{job.error_message}</p> : null}
        </Notice>
      );
    case "conflict":
      return (
        <Notice tone="danger" className="publication-outcome">
          <p>
            <strong>Конфликт публикации — ничего не перезаписано</strong>
          </p>
          {job.error_message ? <p>{job.error_message}</p> : null}
        </Notice>
      );
    case "superseded":
      return (
        <Notice tone="info" className="publication-outcome">
          <p>
            Задание заменено заданием для более новой ревизии документа. Откройте документ, чтобы подготовить публикацию
            актуальной ревизии.
          </p>
          <Link to={`/documents/${encodeURIComponent(job.document_id)}`} className="text-link">
            Открыть документ
          </Link>
        </Notice>
      );
    case "pending":
      return (
        <Notice tone="info" className="publication-outcome">
          Предпросмотр ещё не выполнен. Нажмите «Проверить заново (dry-run)».
        </Notice>
      );
    case "validating":
    case "publishing":
      return (
        <Notice tone="info" className="publication-outcome">
          <p>{job.state === "validating" ? "Выполняется предпросмотр…" : "Идёт запись в Confluence…"}</p>
          <button type="button" className="button button--secondary" onClick={onReload}>
            Обновить состояние
          </button>
        </Notice>
      );
    case "dry_run_ready":
      return job.plan && job.plan.problems.length === 0 ? (
        <Notice tone="info" className="publication-outcome">
          Предпросмотр готов: проверьте изменения ниже перед публикацией.
        </Notice>
      ) : null;
  }
}

const DIFF_COPY: Record<
  Exclude<PublicationPlan["diff_kind"], "none">,
  { title: string; label: string; note: string; before: string; after: string }
> = {
  new_page: {
    title: "Содержимое новой страницы",
    label: "Содержимое новой страницы",
    note: "Страница будет создана целиком: все строки добавлены.",
    before: "Было",
    after: "Стало",
  },
  page_update: {
    title: "Изменения на странице",
    label: "Изменения страницы построчно",
    note: "Было — текущая страница в Confluence, стало — страница после публикации ревизии из GitLab.",
    before: "Сейчас в Confluence",
    after: "После публикации",
  },
  manual_edit: {
    title: "Ручная правка в Confluence",
    label: "Ручная правка построчно",
    note: "Было — версия, опубликованная приложением, стало — текущая страница в Confluence.",
    before: "Опубликовано приложением",
    after: "Сейчас в Confluence",
  },
};

function DiffSection({ plan }: { plan: PublicationPlan }) {
  if (plan.diff_kind === "none" || !plan.diff.trim()) {
    return (
      <section className="publication-diff" aria-labelledby="publication-diff-title">
        <h2 id="publication-diff-title">Изменения</h2>
        <p className="muted">Изменений нет: содержимое страницы совпадает с ревизией документа.</p>
      </section>
    );
  }
  const copy = DIFF_COPY[plan.diff_kind];
  return (
    <section className="publication-diff" aria-labelledby="publication-diff-title">
      <h2 id="publication-diff-title">{copy.title}</h2>
      <p className="muted">
        {copy.note} Сравнение показано в формате хранения Confluence (XHTML).
      </p>
      <DiffView
        diff={parseUnifiedDiff(plan.diff)}
        newFile={plan.diff_kind === "new_page"}
        label={copy.label}
        beforeLabel={copy.before}
        afterLabel={copy.after}
      />
    </section>
  );
}

export function PublicationJobPage() {
  const { jobId = "" } = useParams();
  const { data, error, loading, reload, setData } = useAsync(() => api.publicationJob(jobId), jobId);
  const documentId = data?.document_id ?? "";
  // Publisher facts (mode, mock target) come from the document status; optional, never blocks the page.
  const publication = useAsync(
    () => (documentId ? api.documentPublication(documentId) : Promise.resolve(null)),
    `job-publication-${documentId}`,
  );
  const [pending, setPending] = useState<JobAction | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState("");
  const [confirmAck, setConfirmAck] = useState(false);
  const inFlight = useRef(false);

  async function run(kind: JobAction, action: () => Promise<PublicationJobDetail>) {
    if (inFlight.current) return; // guards against a double click before React re-renders
    inFlight.current = true;
    setPending(kind);
    setActionError(null);
    setMessage("");
    try {
      const result = await action();
      setData(result);
      setMessage(outcomeMessage(kind, result));
      setConfirmAck(false);
    } catch (err) {
      setActionError(toApiError(err));
      // The server may have changed the job (plan_changed, result_unknown): show its current state.
      try {
        setData(await api.publicationJob(jobId));
      } catch {
        // keep the last known state; the error above is already visible
      }
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  if (loading && !data) return <Loading label="Загрузка задания публикации…" />;
  if (error && !data) {
    return (
      <ErrorState
        error={error}
        onRetry={reload}
        title={error.status === 404 ? "Задание публикации не найдено" : PUBLICATION_ERROR_TITLE[error.code]}
        page
      />
    );
  }
  if (!data) return null;
  const job = data;
  const plan = job.plan;
  const publisher = publication.data?.publisher ?? null;
  const mock = publisher?.target_kind === "mock";
  const busy = pending !== null;
  const done = job.state === "published";
  const title = plan?.target.title ?? job.document_id;
  const manualEdit = plan?.diff_kind === "manual_edit";
  const pageMissing = job.state === "conflict" && Boolean(plan?.problems.some((p) => p.code === "mapped_page_missing"));
  const mr = plan?.merge_request ?? null;

  let publishHint: string;
  if (!job.publish_enabled) {
    publishHint = job.publish_disabled_reason ?? "Запись в Confluence выключена: доступен только предпросмотр.";
  } else if (job.can_publish) {
    publishHint =
      "Будет записано ровно то, что показано в предпросмотре. Перед записью приложение ещё раз проверит страницу в Confluence; если она изменилась, публикация остановится.";
  } else if (plan && plan.problems.length > 0) {
    publishHint = "Публикация заблокирована: устраните проблемы, перечисленные выше, и выполните предпросмотр заново.";
  } else if (done) {
    publishHint = "Публикация завершена.";
  } else {
    publishHint = "Опубликовать можно только после готового предпросмотра.";
  }

  return (
    <div className="publication-job">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to="/documents">База знаний</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/documents/${encodeURIComponent(job.document_id)}`}>{job.document_id}</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Публикация</span>
      </nav>
      <div className="page-head">
        <h1>Публикация в Confluence</h1>
        <p className="lead">
          Документ «{title}». Публикация — отдельный шаг после merge в GitLab: сначала предпросмотр без записи, затем
          явное подтверждение.
        </p>
      </div>

      <div className="proposal__status">
        <PublicationJobStateLabel state={job.state} />
        {publisher ? (
          <span className="muted">
            Режим: {PUBLISHER_MODE_LABEL[publisher.mode]} · {INTEGRATION_TARGET_LABEL[publisher.target_kind]}
          </span>
        ) : null}
        <MockTag mock={mock} />
      </div>

      <Outcome job={job} mock={mock} onReload={reload} />

      <section className="panel publication-summary" aria-labelledby="publication-summary-title">
        <h2 id="publication-summary-title">{done ? "Что опубликовано" : "Что будет опубликовано"}</h2>
        <dl className="mr-panel__fields">
          <div>
            <dt>Документ</dt>
            <dd>
              <Link to={`/documents/${encodeURIComponent(job.document_id)}`}>{title}</Link>{" "}
              <code className="doc-id">{job.document_id}</code>
            </dd>
          </div>
          <div>
            <dt>Ревизия в GitLab</dt>
            <dd>
              <code className="doc-id">{shortRevision(job.revision)}</code>
            </dd>
          </div>
          <div>
            <dt>Merge Request</dt>
            <dd>
              {mr ? (
                <>
                  {isHttpUrl(mr.url) ? (
                    <a href={mr.url} target="_blank" rel="noopener noreferrer">
                      MR !{mr.iid}
                      <span aria-hidden="true"> ↗</span>
                    </a>
                  ) : (
                    `MR !${mr.iid}`
                  )}
                  {mr.merged_at ? <span className="muted">, merge {formatDateTime(mr.merged_at)}</span> : null}
                </>
              ) : (
                <span className="muted">не найден</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Действие</dt>
            <dd data-testid="publication-action">
              {publicationActionText(plan?.action ?? job.action, {
                pageId: plan?.target.page_id ?? job.page_id,
                remoteVersion: plan?.remote_version,
                done,
              })}
            </dd>
          </div>
          {plan ? (
            <>
              <div>
                <dt>Пространство</dt>
                <dd>
                  <code className="doc-id">{plan.target.space_key}</code>
                </dd>
              </div>
              <div>
                <dt>Родительская страница</dt>
                <dd>
                  <code className="doc-id">{plan.target.parent_id}</code>
                </dd>
              </div>
              <div>
                <dt>Страница</dt>
                <dd>
                  {plan.target.page_id ? (
                    isHttpUrl(plan.target.url) ? (
                      <>
                        <a href={plan.target.url} target="_blank" rel="noopener noreferrer">
                          Страница {plan.target.page_id}
                          <span aria-hidden="true"> ↗</span>
                        </a>{" "}
                        <MockTag mock={mock} />
                      </>
                    ) : (
                      <code className="doc-id">{plan.target.page_id}</code>
                    )
                  ) : (
                    "будет создана"
                  )}
                </dd>
              </div>
              <div>
                <dt>Заголовок страницы</dt>
                <dd>{plan.target.title}</dd>
              </div>
              <div>
                <dt>Предпросмотр выполнен</dt>
                <dd>{formatDateTime(plan.checked_at)}</dd>
              </div>
            </>
          ) : null}
          {job.attempts > 0 ? (
            <div>
              <dt>Попыток записи</dt>
              <dd>{job.attempts}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {plan && plan.problems.length > 0 ? (
        <Notice tone="danger">
          <p>
            <strong>Публикация заблокирована:</strong>
          </p>
          <IssueList issues={plan.problems} />
        </Notice>
      ) : null}
      {plan && plan.warnings.length > 0 ? (
        <Notice tone="warning">
          <p>Предупреждения:</p>
          <IssueList issues={plan.warnings} />
        </Notice>
      ) : null}

      {manualEdit ? (
        <section className="panel conflict-panel manual-edit" aria-labelledby="manual-edit-title">
          <h2 id="manual-edit-title">Страница изменена в Confluence вручную</h2>
          <p>
            После последней публикации страницу отредактировали прямо в Confluence. Автоматическая перезапись
            запрещена: приложение не затрёт эту правку. Ниже показана разница между версией, опубликованной
            приложением, и текущей страницей.
          </p>
          <p>Есть два способа продолжить:</p>
          <ol className="manual-edit__ways">
            <li>
              <strong>Перенести правку в GitLab.</strong> Предложите изменение документа с этой правкой — после ревью и
              merge подготовьте публикацию заново.{" "}
              <Link to={`/proposals/new?document=${encodeURIComponent(job.document_id)}`} className="text-link">
                Предложить изменение документа
              </Link>
            </li>
            <li>
              <strong>Подтвердить ручную правку.</strong> Текущая страница в Confluence станет основой для сравнения. В
              Confluence ничего не записывается; обновлённый предпросмотр покажет, что именно заменит публикация.
              {job.state === "conflict" && !confirmAck ? (
                <div className="button-row manual-edit__action">
                  <button type="button" className="button button--secondary" disabled={busy} onClick={() => setConfirmAck(true)}>
                    Подтвердить ручную правку
                  </button>
                </div>
              ) : null}
            </li>
          </ol>
          {confirmAck ? (
            <div className="reject-box" role="group" aria-labelledby="confirm-ack-text">
              <p id="confirm-ack-text">
                <strong>Принять текущую страницу Confluence как основу?</strong> В Confluence ничего не записывается. Если
                этой правки нет в GitLab, следующая публикация её заменит — это будет видно в обновлённом предпросмотре.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button button--danger"
                  disabled={busy}
                  onClick={() => run("acknowledge", () => api.acknowledgeManualEdit(job.id))}
                >
                  Да, принять текущую страницу как основу
                </button>
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmAck(false)}>
                  Отмена
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {pageMissing ? (
        <section className="panel conflict-panel" aria-labelledby="page-missing-title">
          <h2 id="page-missing-title">Опубликованная страница не найдена в Confluence</h2>
          <p>
            Страницу удалили или перенесли туда, где она недоступна. Лучше всего восстановить её в Confluence (например,
            из корзины пространства) и выполнить проверку заново. Если восстановить нельзя, создайте страницу заново:
            приложение убедится, что страницы действительно нет, забудет старую привязку и покажет новый предпросмотр. В
            Confluence при этом ничего не записывается.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => run("release", () => api.releaseMissingPage(job.id))}
            >
              Создать страницу заново
            </button>
          </div>
        </section>
      ) : null}

      {plan ? <DiffSection plan={plan} /> : null}
      {plan ? (
        <details className="publication-storage">
          <summary>Код страницы (формат хранения Confluence)</summary>
          <p className="muted">Ровно этот текст будет записан в Confluence. Показан как код, без отображения HTML.</p>
          <pre className="raw-source">
            <code>{plan.storage}</code>
          </pre>
        </details>
      ) : null}

      <section className="proposal__actions publication-actions" aria-labelledby="publication-actions-title">
        <h2 id="publication-actions-title">Действия</h2>
        <div aria-live="polite" role="status" className="proposal__live">
          {pending ? <p className="muted">{PENDING_TEXT[pending]}</p> : null}
          {message && !pending ? <p className="success">{message}</p> : null}
        </div>
        {actionError ? (
          actionError.code === "plan_changed" ? (
            <Notice tone="warning">
              <p>
                <strong>Предпросмотр обновлён: проверьте изменения ещё раз</strong>
              </p>
              <p>{actionError.message}</p>
              <p>Ничего не записано. Текущее состояние задания: «{PUBLICATION_JOB_STATE_LABEL[job.state]}».</p>
            </Notice>
          ) : (
            <div className="stack">
              <ErrorState error={actionError} title={PUBLICATION_ERROR_TITLE[actionError.code]} />
              {PUBLICATION_ERROR_HINT[actionError.code] ? <p>{PUBLICATION_ERROR_HINT[actionError.code]}</p> : null}
              <p className="muted">Состояние задания обновлено: «{PUBLICATION_JOB_STATE_LABEL[job.state]}».</p>
            </div>
          )
        ) : null}
        <div className="button-row">
          <button
            type="button"
            className="button button--secondary"
            disabled={!job.can_dry_run || busy}
            onClick={() => run("dry_run", () => api.dryRunPublication(job.id))}
          >
            Проверить заново (dry-run)
          </button>
          {job.publish_enabled ? (
            <button
              type="button"
              className="button button--primary"
              disabled={!job.can_publish || busy}
              aria-describedby="publish-hint"
              onClick={() => run("publish", () => api.publishPublication(job.id))}
            >
              Опубликовать в Confluence
            </button>
          ) : null}
          {job.can_reconcile ? (
            <button
              type="button"
              className={`button ${job.state === "result_unknown" ? "button--primary" : "button--secondary"}`}
              disabled={busy}
              aria-describedby="reconcile-hint"
              onClick={() => run("reconcile", () => api.reconcilePublication(job.id))}
            >
              {job.state === "result_unknown" ? "Проверить результат" : "Повторить"}
            </button>
          ) : null}
        </div>
        <p id="publish-hint" className={job.publish_enabled ? "muted" : "publish-disabled"}>
          {publishHint}
        </p>
        {job.can_reconcile ? (
          <p id="reconcile-hint" className="muted">
            {job.state === "result_unknown"
              ? "«Проверить результат» только читает Confluence: если запись прошла, задание будет завершено; если нет — обновится предпросмотр."
              : "«Повторить» сначала проверяет Confluence (без записи) и обновляет предпросмотр."}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="publication-history-title" className="publication-history">
        <h2 id="publication-history-title">История</h2>
        {job.history.length === 0 ? (
          <p className="muted">Событий пока нет.</p>
        ) : (
          <ol className="history">
            {job.history.map((event, index) => (
              <li key={index}>
                <When value={event.at} /> —{" "}
                {PUBLICATION_EVENT_LABEL[event.action] ?? event.action}
                {event.state ? (
                  <span className="muted">
                    {" "}
                    → {PUBLICATION_JOB_STATE_LABEL[event.state as keyof typeof PUBLICATION_JOB_STATE_LABEL] ?? event.state}
                  </span>
                ) : null}
                {event.revision ? (
                  <span className="muted">
                    {" "}
                    · ревизия <code className="doc-id">{shortRevision(event.revision)}</code>
                  </span>
                ) : null}
                <span className="muted"> ({event.actor})</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
