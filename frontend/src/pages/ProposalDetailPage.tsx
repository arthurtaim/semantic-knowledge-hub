import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { ProposalDetail, SourceDocumentState } from "../api/types";
import { DiffView } from "../components/DiffView";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { ProposalLifecycle } from "../components/ProposalLifecycle";
import { MergeRequestStateLabel, OperationBadge, ProposalStateLabel } from "../components/ProposalState";
import {
  AUTHORING_ERROR_TITLE,
  formatDateTime,
  pluralRu,
  PROPOSAL_ACTION_LABEL,
  PROPOSAL_ERROR_HINT,
  PROPOSAL_ERROR_TITLE,
  PROPOSAL_STATUS_LABEL,
  shortRevision,
} from "../lib/labels";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";

type ActionKind = "mark_ready" | "submit" | "refresh" | "reject" | "delete";

const PENDING_TEXT: Record<ActionKind, string> = {
  mark_ready: "Сохраняем отметку «Готово к ревью»…",
  submit: "Отправляем в GitLab: создаются ветка, коммит и Merge Request…",
  refresh: "Запрашиваем состояние Merge Request в GitLab…",
  reject: "Отклоняем предложение…",
  delete: "Удаляем черновик…",
};

const isHttpUrl = (value: string | null | undefined): value is string => Boolean(value && /^https?:\/\//i.test(value));

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/** Treats a legacy `is_stale` flag as a base-revision conflict if the server did not classify it yet. */
function effectiveSourceState(p: ProposalDetail): SourceDocumentState {
  return p.source_document_state === "unchanged" && p.is_stale ? "changed_since_base" : p.source_document_state;
}

function SourceStatement({ proposal: p }: { proposal: ProposalDetail }) {
  const state = effectiveSourceState(p);
  let tone: "info" | "danger" | "success" = "info";
  let text: string;
  let detail: string | null = null;
  if (state === "new_document") {
    text = "Документ появится в базе знаний только после merge в GitLab.";
    detail = `Сейчас существует только предложение: файл ${p.document_path} ещё не создан, документ не виден в каталоге, поиске и ответах ассистента.`;
  } else if (state === "id_taken") {
    tone = "danger";
    text = `Документ с ID ${p.document_id} уже появился в базе знаний.`;
    detail = `Пока предложение ждало ревью, этот ID или путь занял другой документ. Ничего не перезаписано. ${
      p.can_edit ? "Измените ID, продолжив редактирование черновика." : "Создайте новый черновик с другим ID."
    }`;
  } else if (state === "updated_by_this_proposal" && p.operation === "create") {
    tone = "success";
    text = "Документ создан в GitLab и добавлен в базу знаний.";
  } else if (state === "unchanged") {
    text = "Исходный документ не изменён — пока существует только предложение.";
  } else if (state === "changed_since_base") {
    tone = "danger";
    text = "Исходный документ изменился после создания предложения.";
    detail = `Базовая ревизия предложения — ${p.base_revision}, текущая ревизия документа — ${
      p.current_revision ?? "неизвестна"
    }. Ничего не перезаписано: ни документ, ни предложение не изменены автоматически.`;
  } else if (state === "updated_by_this_proposal") {
    tone = "success";
    text = "Изменение принято в GitLab и попало в базу знаний.";
    detail = p.current_revision ? `Текущая ревизия документа — ${p.current_revision}.` : null;
  } else {
    tone = "danger";
    text = "Исходный документ больше не найден в базе знаний.";
    detail = `Документ ${p.document_id} удалён или переименован — это предложение нельзя применить.`;
  }
  return (
    <Notice tone={tone} className="source-statement">
      <p className="source-statement__text" data-source-state={state}>
        <strong>{text}</strong>
      </p>
      {detail ? <p>{detail}</p> : null}
      <p className="source-statement__note">
        «Готово к ревью» — это не утверждение и не merge. Открытый Merge Request — тоже ещё не merge: решение принимают
        ревьюеры в GitLab.
      </p>
    </Notice>
  );
}

function MergeRequestPanel({ proposal: p }: { proposal: ProposalDetail }) {
  const mr = p.merge_request;
  const url = mr?.url ?? p.merge_request_url ?? (p.publication.state === "submitted" ? p.publication.external_url : null);
  const state = mr?.state ?? p.merge_request_state;
  const branch = p.branch_name ?? mr?.source_branch ?? null;
  if (!mr && !url) return null;
  return (
    <section className="panel mr-panel" aria-labelledby="mr-title">
      <h2 id="mr-title">Merge Request в GitLab</h2>
      <dl className="mr-panel__fields">
        <div>
          <dt>Ветка</dt>
          <dd>
            {branch ? <code className="doc-id">{branch}</code> : "не указана"}
            {mr?.target_branch ? (
              <>
                {" "}
                → <code className="doc-id">{mr.target_branch}</code>
              </>
            ) : null}
          </dd>
        </div>
        {mr?.iid ? (
          <div>
            <dt>Номер</dt>
            <dd>!{mr.iid}</dd>
          </div>
        ) : null}
        <div>
          <dt>Состояние MR</dt>
          <dd>{state ? <MergeRequestStateLabel state={state} /> : "не получено от GitLab"}</dd>
        </div>
        <div>
          <dt>Проверено</dt>
          <dd>{mr?.checked_at ? formatDateTime(mr.checked_at) : "ещё не проверялось"}</dd>
        </div>
      </dl>
      {isHttpUrl(url) ? (
        <a href={url} className="button button--secondary" target="_blank" rel="noopener noreferrer">
          Открыть Merge Request в GitLab
          <span aria-hidden="true">↗</span>
        </a>
      ) : url ? (
        <p>
          Адрес MR: <code className="doc-id">{url}</code>
        </p>
      ) : null}
      <p className="muted">
        Состояние MR показано так, как его последний раз сообщил GitLab. Статус «Принято (merge)» появляется только после
        подтверждения от GitLab.
      </p>
    </section>
  );
}

function SubmissionFailurePanel({ proposal: p }: { proposal: ProposalDetail }) {
  const s = p.submission;
  return (
    <section className="panel failure-panel" aria-labelledby="failure-title">
      <h2 id="failure-title">Отправка в GitLab не удалась</h2>
      <p>{s.error_message ?? "GitLab не принял изменения."}</p>
      <dl className="inline-meta">
        {s.error_code ? (
          <div>
            <dt>Код ошибки</dt>
            <dd>
              <code>{s.error_code}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Попыток</dt>
          <dd>{s.attempts}</dd>
        </div>
        <div>
          <dt>Последняя попытка</dt>
          <dd>{formatDateTime(s.last_attempt_at)}</dd>
        </div>
      </dl>
      {s.uncertain ? (
        <Notice tone="warning">
          Ответ GitLab на последнюю запись не получен (например, из-за тайм-аута) — изменения могли быть применены. Перед
          повторной записью приложение сначала проверит GitLab и не создаст дубликат ветки, коммита или MR. Можно также
          нажать «Проверить статус в GitLab»: если MR уже создан, он будет найден и привязан к предложению.
        </Notice>
      ) : null}
      <p className="muted">Предложение сохранено локально — ничего не потеряно. Отправку можно повторить.</p>
    </section>
  );
}

function ConflictPanel({ proposal: p }: { proposal: ProposalDetail }) {
  if (p.operation === "create") {
    return (
      <section className="panel conflict-panel" aria-labelledby="conflict-title">
        <h2 id="conflict-title">Как продолжить после конфликта</h2>
        <p>
          Пока предложение ждало ревью, документ с таким ID или файл с таким путём появился в базе знаний. Чтобы ничего
          не перезаписать, это предложение не будет отправлено. Создайте новый черновик с другим ID — текст можно взять
          из этого предложения.
        </p>
        <dl className="inline-meta">
          <div>
            <dt>ID</dt>
            <dd>
              <code className="doc-id">{p.document_id}</code>
            </dd>
          </div>
          <div>
            <dt>Путь в репозитории</dt>
            <dd>
              <code className="doc-id">{p.document_path}</code>
            </dd>
          </div>
        </dl>
        <Link to={`/documents/new?from=${encodeURIComponent(p.id)}`} className="button button--primary">
          Создать новый черновик с этим текстом
        </Link>
      </section>
    );
  }
  const href = `/proposals/new?document=${encodeURIComponent(p.document_id)}&from=${encodeURIComponent(p.id)}`;
  return (
    <section className="panel conflict-panel" aria-labelledby="conflict-title">
      <h2 id="conflict-title">Как продолжить после конфликта</h2>
      <p>
        Пока предложение ждало ревью, документ изменился. Чтобы не затереть чужие правки, это предложение не будет
        отправлено. Создайте новое предложение на основе актуальной версии и перенесите в него свои изменения.
      </p>
      <dl className="inline-meta">
        <div>
          <dt>Базовая ревизия предложения</dt>
          <dd>
            <code className="doc-id">{p.base_revision}</code>
          </dd>
        </div>
        <div>
          <dt>Актуальная ревизия документа</dt>
          <dd>
            <code className="doc-id">{p.current_revision ?? "неизвестна"}</code>
          </dd>
        </div>
      </dl>
      {p.source_document_state !== "missing" ? (
        <Link to={href} className="button button--primary">
          Создать новое предложение на основе актуальной версии
        </Link>
      ) : null}
    </section>
  );
}

function successMessage(kind: ActionKind, result: ProposalDetail): string {
  if (kind === "mark_ready") return "Предложение отмечено «Готово к ревью». Документ не изменён.";
  if (kind === "reject") return "Предложение отклонено. Документ не изменён.";
  if (kind === "submit") {
    return result.status === "submitted_to_gitlab"
      ? "Предложение отправлено в GitLab: создан Merge Request. Документ изменится только после merge."
      : `Отправка обработана, статус: «${PROPOSAL_STATUS_LABEL[result.status]}».`;
  }
  if (result.status === "merged") return "GitLab подтвердил merge.";
  if (result.status === "rejected") return "Merge Request закрыт в GitLab без merge — предложение отклонено.";
  return `Статус проверен в GitLab: «${PROPOSAL_STATUS_LABEL[result.status]}».`;
}

export function ProposalDetailPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const { data, error, loading, reload, setData } = useAsync(() => api.draft(id), id);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<ActionKind | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);

  async function run(kind: ActionKind, action: () => Promise<ProposalDetail>) {
    if (inFlight.current) return; // guards against a double click before React re-renders
    inFlight.current = true;
    setPending(kind);
    setActionError(null);
    setMessage("");
    try {
      const result = await action();
      setData(result);
      setMessage(successMessage(kind, result));
      setConfirmReject(false);
    } catch (err) {
      setActionError(toApiError(err));
      // The server may have changed the status (conflict, submission_failed): show the current state.
      try {
        setData(await api.draft(id));
      } catch {
        // keep the last known state; the error above is already visible
      }
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function deleteDraft() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("delete");
    setActionError(null);
    setMessage("");
    try {
      await api.deleteDraft(id);
      navigate("/proposals", { state: { notice: "Черновик удалён. Документы базы знаний не изменялись." } });
    } catch (err) {
      setActionError(toApiError(err));
      setConfirmDelete(false);
      try {
        setData(await api.draft(id));
      } catch {
        // keep the last known state; the error above is already visible
      }
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  if (loading && !data) return <Loading label="Загрузка предложения…" />;
  if (error && !data) {
    return <ErrorState error={error} onRetry={reload} title={error.status === 404 ? "Предложение не найдено" : undefined} />;
  }
  if (!data) return null;
  const p = data;
  const errors = p.validation.filter((i) => i.severity === "error");
  const warnings = p.validation.filter((i) => i.severity === "warning");
  const busy = pending !== null;
  const gitlabEnabled = session ? session.features.gitlab_proposals : p.publication.state !== "disabled";
  const sourceState = effectiveSourceState(p);
  const showConflict =
    p.status === "conflict" || (sourceState === "changed_since_base" && p.status !== "merged" && p.status !== "rejected");
  const showMarkReady = p.status === "draft";
  const showSubmit = p.status === "draft" || p.status === "ready_for_review" || p.status === "submitting";
  const showRetry = p.status === "submission_failed";
  const showRefresh = p.can_refresh_status || p.status === "submitted_to_gitlab";
  const settled = p.status === "merged" || p.status === "rejected";
  const creating = p.operation === "create";
  const editHref = creating
    ? `/documents/new?draft=${encodeURIComponent(p.id)}`
    : `/proposals/new?edit=${encodeURIComponent(p.id)}`;

  let submitHint: string | null = null;
  if (showSubmit || showRetry) {
    if (!gitlabEnabled) submitHint = "Отправка в GitLab не настроена — предложение остаётся локальным.";
    else if (p.status === "draft") submitHint = "Отправить в GitLab можно после отметки «Готово к ревью».";
    else if (p.status === "submitting") submitHint = "Отправка уже выполняется. Проверьте статус чуть позже.";
    else if (!p.can_submit && errors.length > 0) submitHint = "Сначала исправьте ошибки проверки в новом предложении.";
    else if (!p.can_submit) submitHint = "Отправка сейчас недоступна для этого предложения.";
    else if (showRetry && p.submission.uncertain) {
      submitHint = "Перед повторной записью приложение проверит, что уже создано в GitLab.";
    } else {
      submitHint = "Будут созданы ветка, коммит и Merge Request. Документ изменится только после merge в GitLab.";
    }
  }

  return (
    <div className="proposal">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to="/proposals">Предложения</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{p.document_id}</span>
      </nav>
      <div className="page-head">
        <h1>
          {creating ? "Новый документ" : "Изменение документа"} «
          {creating && p.status !== "merged" ? (
            p.document_title
          ) : (
            <Link to={`/documents/${p.document_id}`}>{p.document_title}</Link>
          )}
          »
        </h1>
        <p className="lead">{p.reason}</p>
      </div>

      <div className="proposal__status">
        <OperationBadge operation={p.operation} />
        <ProposalStateLabel status={p.status} />
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
          {creating ? (
            <div>
              <dt>Путь в репозитории</dt>
              <dd>
                <code className="doc-id">{p.document_path}</code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Базовая ревизия</dt>
            <dd>{creating || !p.base_revision ? "новый файл" : <code className="doc-id">{p.base_revision}</code>}</dd>
          </div>
          <div>
            <dt>Текущая ревизия</dt>
            <dd>
              {p.current_revision ? (
                <code className="doc-id">{p.current_revision}</code>
              ) : creating ? (
                "документа ещё нет в базе знаний"
              ) : (
                <code className="doc-id">документ недоступен</code>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <ProposalLifecycle proposal={p} />
      <SourceStatement proposal={p} />
      {p.status === "merged" && p.merged_revision ? (
        <Notice tone="success" className="sync-notice">
          <p>
            <strong>Синхронизировано с базой знаний:</strong> ревизия{" "}
            <code className="doc-id">{shortRevision(p.merged_revision)}</code>
            {p.synced_at ? `, ${formatDateTime(p.synced_at)}` : ""}.
          </p>
          <Link to={`/documents/${encodeURIComponent(p.document_id)}`} className="text-link">
            Открыть документ в базе знаний
          </Link>
        </Notice>
      ) : null}

      {!gitlabEnabled && !settled ? (
        <Notice tone="info">
          Отправка в GitLab не настроена — предложение остаётся локальным в этом приложении. Ревью и merge нужно выполнить
          вне приложения; документ в базе знаний от этого не изменится.
        </Notice>
      ) : null}

      {showConflict ? <ConflictPanel proposal={p} /> : null}
      {p.status === "submission_failed" ? <SubmissionFailurePanel proposal={p} /> : null}
      <MergeRequestPanel proposal={p} />

      {errors.length > 0 ? (
        <Notice tone="danger">
          <p>
            {p.can_edit
              ? "Ошибки проверки — исправьте их, продолжив редактирование черновика:"
              : "Ошибки проверки — исправьте их в новом предложении:"}
          </p>
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
        <h2 id="diff-title">{creating ? "Содержимое нового файла" : "Изменения"}</h2>
        {creating ? (
          <p className="muted">
            Файл <code className="doc-id">{p.document_path}</code> создаётся целиком: все строки добавлены.
          </p>
        ) : null}
        <DiffView diff={p.diff} newFile={creating} />
      </section>

      <section className="proposal__actions" aria-labelledby="actions-title">
        <h2 id="actions-title">Действия</h2>
        <div aria-live="polite" role="status" className="proposal__live">
          {pending ? <p className="muted">{PENDING_TEXT[pending]}</p> : null}
          {message && !pending ? <p className="success">{message}</p> : null}
        </div>
        {actionError ? (
          <div className="stack">
            <ErrorState
              error={actionError}
              title={PROPOSAL_ERROR_TITLE[actionError.code] ?? AUTHORING_ERROR_TITLE[actionError.code]}
            />
            {PROPOSAL_ERROR_HINT[actionError.code] ? <p>{PROPOSAL_ERROR_HINT[actionError.code]}</p> : null}
            <p className="muted">
              Состояние предложения обновлено: «{PROPOSAL_STATUS_LABEL[p.status]}». Локальное предложение сохранено.
            </p>
          </div>
        ) : null}
        <div className="button-row">
          {p.can_edit ? (
            <Link to={editHref} className="button button--secondary">
              Продолжить редактирование
            </Link>
          ) : null}
          {showMarkReady ? (
            <button
              type="button"
              className="button button--primary"
              disabled={!p.can_mark_ready || busy}
              onClick={() => run("mark_ready", () => api.markReady(p.id))}
            >
              Отметить «Готово к ревью»
            </button>
          ) : null}
          {showSubmit ? (
            <button
              type="button"
              className={`button ${p.status === "ready_for_review" ? "button--primary" : "button--secondary"}`}
              disabled={!p.can_submit || !gitlabEnabled || busy}
              aria-describedby={submitHint ? "submit-hint" : undefined}
              onClick={() => run("submit", () => api.submitDraft(p.id))}
            >
              Отправить в GitLab
            </button>
          ) : null}
          {showRetry ? (
            <button
              type="button"
              className="button button--primary"
              disabled={!p.can_submit || !gitlabEnabled || busy}
              aria-describedby={submitHint ? "submit-hint" : undefined}
              onClick={() => run("submit", () => api.submitDraft(p.id))}
            >
              Повторить отправку
            </button>
          ) : null}
          {showRefresh ? (
            <button
              type="button"
              className="button button--secondary"
              disabled={!p.can_refresh_status || busy}
              onClick={() => run("refresh", () => api.refreshDraftStatus(p.id))}
            >
              Проверить статус в GitLab
            </button>
          ) : null}
          {p.can_reject && !confirmReject ? (
            <button type="button" className="button button--danger" disabled={busy} onClick={() => setConfirmReject(true)}>
              Отклонить
            </button>
          ) : null}
          {p.can_delete && !confirmDelete ? (
            <button type="button" className="button button--danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Удалить черновик
            </button>
          ) : null}
        </div>
        {submitHint ? (
          <p id="submit-hint" className="muted">
            {submitHint}
          </p>
        ) : null}
        {settled && !showRefresh ? (
          <p className="muted">
            {p.status === "merged" ? "Предложение завершено: merge подтверждён GitLab." : "Предложение закрыто без изменений документа."}
          </p>
        ) : null}
        {confirmReject ? (
          <div className="reject-box">
            <label htmlFor="reject-comment">Комментарий к отклонению (необязательно)</label>
            <input id="reject-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
            <div className="button-row">
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => run("reject", () => api.rejectDraft(p.id, comment))}
              >
                Подтвердить отклонение
              </button>
              <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmReject(false)}>
                Отмена
              </button>
            </div>
          </div>
        ) : null}
        {confirmDelete ? (
          <div className="reject-box" role="group" aria-labelledby="confirm-delete-proposal">
            <p id="confirm-delete-proposal">
              <strong>Удалить черновик безвозвратно?</strong>{" "}
              {creating
                ? "Текст нового документа будет удалён; в базе знаний он не создавался."
                : "Предложенная правка будет удалена; документ не изменится."}
            </p>
            <div className="button-row">
              <button type="button" className="button button--danger" disabled={busy} onClick={deleteDraft}>
                Удалить безвозвратно
              </button>
              <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Не удалять
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
              <time dateTime={event.at}>{formatDateTime(event.at)}</time> —{" "}
              {PROPOSAL_ACTION_LABEL[event.action] ?? event.action}
              {event.status ? <span className="muted"> → {PROPOSAL_STATUS_LABEL[event.status] ?? event.status}</span> : null}
              <span className="muted"> ({event.actor})</span>
            </li>
          ))}
        </ol>
        {p.submission.attempts > 0 && p.status !== "submission_failed" ? (
          <p className="muted">
            {p.submission.attempts} {pluralRu(p.submission.attempts, "попытка", "попытки", "попыток")} отправки в GitLab,
            последняя — {formatDateTime(p.submission.last_attempt_at)}.
          </p>
        ) : null}
      </section>
    </div>
  );
}
