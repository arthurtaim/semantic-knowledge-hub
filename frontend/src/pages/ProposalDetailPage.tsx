import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { ProposalDetail } from "../api/types";
import { DiffView } from "../components/DiffView";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { formatDateTime, PROPOSAL_ACTION_LABEL, PROPOSAL_STATUS_LABEL } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

export function ProposalDetailPage() {
  const { id = "" } = useParams();
  const { data, error, loading, reload, setData } = useAsync(() => api.draft(id), id);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState("");

  async function run(action: () => Promise<ProposalDetail>, done: string) {
    setPending(true);
    setActionError(null);
    setMessage("");
    try {
      setData(await action());
      setMessage(done);
      setConfirmReject(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
    } finally {
      setPending(false);
    }
  }

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} title={error.status === 404 ? "Предложение не найдено" : undefined} />;
  if (!data) return null;
  const p = data;
  const errors = p.validation.filter((i) => i.severity === "error");
  const warnings = p.validation.filter((i) => i.severity === "warning");

  return (
    <div className="proposal">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to="/proposals">Предложения</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{p.document_id}</span>
      </nav>
      <div className="page-head">
        <h1>
          Изменение документа «<Link to={`/documents/${p.document_id}`}>{p.document_title}</Link>»
        </h1>
        <p className="lead">{p.reason}</p>
      </div>

      <div className="proposal__status">
        <span className={`proposal-state proposal-state--${p.status}`}>{PROPOSAL_STATUS_LABEL[p.status]}</span>
        <dl className="inline-meta">
          <div>
            <dt>Автор</dt>
            <dd>{p.author}</dd>
          </div>
          <div>
            <dt>Создано</dt>
            <dd>{formatDateTime(p.created_at)}</dd>
          </div>
          <div>
            <dt>Происхождение</dt>
            <dd>{p.origin === "ai_suggestion" ? "черновик ИИ, проверен человеком" : "ручная правка"}</dd>
          </div>
          <div>
            <dt>Базовая ревизия</dt>
            <dd>
              <code className="doc-id">{p.base_revision}</code>
            </dd>
          </div>
          <div>
            <dt>Текущая ревизия</dt>
            <dd>
              <code className="doc-id">{p.current_revision ?? "документ недоступен"}</code>
            </dd>
          </div>
        </dl>
      </div>

      <Notice tone="info">
        Исходный документ не изменяется. «Готово к ревью» — это не утверждение и не merge: решение принимают
        ревьюеры в GitLab.
      </Notice>
      {p.is_stale ? (
        <Notice tone="danger">
          Исходный документ изменился после создания предложения (ревизия {p.current_revision ?? "—"}). Отправить на
          ревью нельзя — создайте новое предложение на основе актуального текста.
        </Notice>
      ) : null}
      {errors.length > 0 ? (
        <Notice tone="danger">
          <p>Ошибки проверки — исправьте их в новом предложении:</p>
          <ul>
            {errors.map((issue) => (
              <li key={`${issue.code}-${issue.field ?? ""}`}>{issue.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {warnings.length > 0 ? (
        <Notice tone="warning">
          <p>Предупреждения:</p>
          <ul>
            {warnings.map((issue) => (
              <li key={`${issue.code}-${issue.field ?? ""}`}>{issue.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {errors.length === 0 && warnings.length === 0 ? (
        <p className="validation-ok">Проверка метаданных и содержимого пройдена.</p>
      ) : null}

      <section aria-labelledby="diff-title">
        <h2 id="diff-title">Изменения</h2>
        <DiffView diff={p.diff} />
      </section>

      <section className="proposal__actions" aria-labelledby="actions-title">
        <h2 id="actions-title">Решение</h2>
        <div aria-live="polite">{message ? <p className="success">{message}</p> : null}</div>
        {actionError ? <ErrorState error={actionError} /> : null}
        <div className="button-row">
          <button
            type="button"
            className="button button--primary"
            disabled={!p.can_mark_ready || pending}
            onClick={() => run(() => api.markReady(p.id), "Предложение отмечено «Готово к ревью». Документ не изменён.")}
          >
            Отметить «Готово к ревью»
          </button>
          {!confirmReject ? (
            <button
              type="button"
              className="button button--danger"
              disabled={!p.can_reject || pending}
              onClick={() => setConfirmReject(true)}
            >
              Отклонить
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            disabled={pending || p.status !== "ready_for_review" || p.publication.state === "disabled"}
            onClick={() => run(() => api.openMergeRequest(p.id), "Merge Request создан.")}
            aria-describedby="mr-hint"
          >
            Открыть MR в GitLab
          </button>
        </div>
        {p.publication.state === "submitted" && p.publication.external_url ? (
          <p>
            Merge Request:{" "}
            <a href={p.publication.external_url} target="_blank" rel="noopener noreferrer nofollow">
              {p.publication.external_url}
            </a>
          </p>
        ) : null}
        <p id="mr-hint" className="muted">
          {p.publication.state === "disabled"
            ? "Создание Merge Request отключено в конфигурации (GITLAB_PROPOSALS_ENABLED=false)."
            : "MR можно открыть после статуса «Готово к ревью»."}
        </p>
        {confirmReject ? (
          <div className="reject-box">
            <label htmlFor="reject-comment">Комментарий к отклонению (необязательно)</label>
            <input id="reject-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
            <div className="button-row">
              <button
                type="button"
                className="button button--danger"
                disabled={pending}
                onClick={() => run(() => api.rejectDraft(p.id, comment), "Предложение отклонено. Документ не изменён.")}
              >
                Подтвердить отклонение
              </button>
              <button type="button" className="button button--ghost" onClick={() => setConfirmReject(false)}>
                Отмена
              </button>
            </div>
          </div>
        ) : null}
        {p.review_comment ? (
          <p>
            Комментарий ревьюера: <q>{p.review_comment}</q>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="history-title">
        <h2 id="history-title">История</h2>
        <ol className="history">
          {p.history.map((event, index) => (
            <li key={index}>
              <time dateTime={event.at}>{formatDateTime(event.at)}</time> — {PROPOSAL_ACTION_LABEL[event.action] ?? event.action}
              <span className="muted"> ({event.actor})</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
