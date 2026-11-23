import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { DocumentDetail, ProposalDetail } from "../api/types";
import { ChangeContentEditor } from "../components/ChangeContentEditor";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { StatusStamp } from "../components/StatusStamp";
import { AUTHORING_ERROR_TITLE, PROPOSAL_STATUS_LABEL } from "../lib/labels";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";

/**
 * `/proposals/new?document=<id>` creates a change proposal; `?edit=<proposal id>` continues editing a stored
 * change draft (saved with PUT and optimistic locking). New documents are edited in `/documents/new?draft=<id>`.
 */
export function ProposalEditorPage() {
  const [params] = useSearchParams();
  const editId = params.get("edit") ?? "";
  return editId ? <EditChangeDraft key={editId} id={editId} /> : <NewProposal />;
}

function NewProposal() {
  const [params] = useSearchParams();
  const documentId = params.get("document") ?? "";
  // ?from=<proposal id>: start from an earlier proposal's text (e.g. after a revision conflict).
  const fromId = params.get("from") ?? "";
  const { data: doc, error, loading, reload } = useAsync(
    () => (documentId ? api.document(documentId) : Promise.resolve(null)),
    documentId,
  );
  const source = useAsync(() => (fromId ? api.draft(fromId) : Promise.resolve(null)), `from-${fromId}`);
  const [previousDraft, setPreviousDraft] = useState<string | null>(null);

  if (!documentId) {
    return (
      <EmptyState title="Не выбран документ" page>
        <p>Откройте документ в базе знаний и нажмите «Предложить изменение».</p>
        <Link to="/documents" className="button button--secondary">
          Перейти к документам
        </Link>
      </EmptyState>
    );
  }
  if (loading && !doc) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} title={error.status === 404 ? "Документ не найден" : undefined} page />;
  if (fromId && source.loading && !source.data && !source.error) {
    return <Loading label="Загрузка исходного предложения…" />;
  }
  if (!doc) return null;
  const basis = source.data && source.data.document_id === doc.id ? source.data : null;
  let basisProblem: string | null = null;
  if (fromId && source.error) basisProblem = source.error.message;
  else if (fromId && source.data && !basis) basisProblem = "Это предложение относится к другому документу.";
  // After a conflict reload the editor starts from the current text; the earlier version stays visible below.
  const activeBasis = previousDraft === null ? basis : null;
  // Keyed by revision: the form state starts from the loaded text and resets if the document is reloaded.
  return (
    <ProposalEditor
      key={`${doc.revision}-${activeBasis?.id ?? ""}`}
      doc={doc}
      basis={activeBasis}
      basisProblem={basisProblem}
      previousDraft={previousDraft}
      onReload={(draft) => {
        setPreviousDraft(draft);
        reload();
      }}
    />
  );
}

interface EditorProps {
  doc: DocumentDetail;
  /** Earlier proposal whose text pre-fills the editor; the new proposal is based on the CURRENT revision. */
  basis: ProposalDetail | null;
  basisProblem: string | null;
  previousDraft: string | null;
  onReload: (draft: string) => void;
}

function ProposalEditor({ doc, basis, basisProblem, previousDraft, onReload }: EditorProps) {
  const navigate = useNavigate();
  const session = useSession();
  const [content, setContent] = useState(basis?.proposed_content ?? doc.raw);
  const [reason, setReason] = useState(basis?.reason ?? "");
  const [instruction, setInstruction] = useState("");
  // A change of an existing document is manual or AI-assisted; `external_page` applies to new documents only.
  const [origin, setOrigin] = useState<"manual" | "ai_suggestion">(basis?.origin === "ai_suggestion" ? "ai_suggestion" : "manual");
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [suggestNote, setSuggestNote] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  const changed = content !== doc.raw;
  const aiAvailable = session?.features.ai_edit_suggestions ?? false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setSubmitError(null);
    try {
      const created = await api.createDraft({
        document_id: doc.id,
        base_revision: doc.revision,
        proposed_content: content,
        reason: reason.trim(),
        origin,
      });
      navigate(`/proposals/${created.id}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
    } finally {
      setPending(false);
    }
  }

  async function suggest() {
    setPending(true);
    setSubmitError(null);
    try {
      const result = await api.suggestDraft({ document_id: doc.id, base_revision: doc.revision, instruction });
      setContent(result.proposed_content);
      setOrigin("ai_suggestion");
      setSuggestNote(result.warnings);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="editor">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to={`/documents/${doc.id}`}>{doc.title}</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Новое предложение</span>
      </nav>
      <div className="page-head">
        <h1>Предложить изменение</h1>
        <p className="lead">
          Правка не применяется к документу. Создаётся предложение с diff, которое проходит проверку и ревью.
        </p>
      </div>
      <dl className="inline-meta">
        <div>
          <dt>Документ</dt>
          <dd>
            <code className="doc-id">{doc.id}</code>
          </dd>
        </div>
        <div>
          <dt>Статус</dt>
          <dd>
            <StatusStamp status={doc.status} />
          </dd>
        </div>
        <div>
          <dt>Базовая ревизия</dt>
          <dd>
            <code className="doc-id">{doc.revision}</code>
          </dd>
        </div>
      </dl>

      <section className="panel ai-draft" aria-labelledby="ai-draft-title">
        <h2 id="ai-draft-title">Черновик от ИИ</h2>
        {aiAvailable ? (
          <>
            <label htmlFor="instruction">Что изменить</label>
            <input
              id="instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={2000}
              placeholder="Например: сформулируй открытые вопросы яснее"
            />
            <button
              type="button"
              className="button button--secondary"
              disabled={pending || instruction.trim().length < 3}
              onClick={suggest}
            >
              Подготовить черновик
            </button>
            {suggestNote.length > 0 ? <Notice tone="warning">{suggestNote.join(" ")}</Notice> : null}
          </>
        ) : (
          <p className="muted">
            В демо-режиме ИИ не генерирует правки. Отредактируйте текст вручную — он пройдёт ту же проверку.
          </p>
        )}
      </section>

      {basisProblem ? (
        <Notice tone="warning">
          Не удалось взять текст из предыдущего предложения: {basisProblem} Редактор открыт с актуальным текстом документа.
        </Notice>
      ) : null}
      {basis ? (
        <Notice tone="warning" className="basis-notice">
          <p>
            <strong>Текст взят из предложения «{basis.reason}»</strong> (базовая ревизия{" "}
            <code className="doc-id">{basis.base_revision}</code>). Новое предложение будет создано относительно
            актуальной ревизии <code className="doc-id">{doc.revision}</code>.
          </p>
          <p>
            Документ изменился после того предложения: этот текст может отменить правки других авторов. Сравните его с
            актуальной версией и обязательно проверьте diff после создания предложения.
          </p>
          <details>
            <summary>Показать актуальный текст документа</summary>
            <pre className="raw-source">
              <code>{doc.raw}</code>
            </pre>
          </details>
          <Link to={`/proposals/${basis.id}`} className="text-link">
            Вернуться к исходному предложению
          </Link>
        </Notice>
      ) : null}
      {previousDraft !== null && previousDraft !== doc.raw ? (
        <Notice tone="warning">
          <p>Документ обновлён до актуальной ревизии. Ваша прежняя версия сохранена ниже — перенесите нужные правки.</p>
          <details>
            <summary>Показать прежнюю версию</summary>
            <pre className="raw-source">
              <code>{previousDraft}</code>
            </pre>
          </details>
        </Notice>
      ) : null}
      <form className="editor__form" onSubmit={submit}>
        <ChangeContentEditor value={content} onChange={setContent} />
        <label htmlFor="reason">Причина изменения</label>
        <input
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          required
          minLength={3}
          placeholder="Коротко: что и зачем меняется"
        />
        {submitError ? (
          <ErrorState
            error={submitError}
            title={submitError.code === "revision_conflict" ? "Документ изменился" : undefined}
            onRetry={submitError.code === "revision_conflict" ? () => onReload(content) : undefined}
            retryLabel="Загрузить актуальную версию"
          />
        ) : null}
        <div className="editor__actions">
          <button type="submit" className="button button--primary" disabled={pending || !changed || reason.trim().length < 3}>
            Создать предложение
          </button>
          <button type="button" className="button button--ghost" onClick={() => setContent(doc.raw)} disabled={!changed}>
            Вернуть исходный текст
          </button>
          {!changed ? <span className="muted">Измените текст, чтобы создать предложение.</span> : null}
        </div>
      </form>
    </div>
  );
}

// --- editing a stored change draft ------------------------------------------------------------------

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function EditChangeDraft({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(() => api.draft(id), `edit-${id}`);
  // After a lost-update conflict the stored version is reloaded; the author's text stays visible.
  const [previousText, setPreviousText] = useState<string | null>(null);

  if (loading && !data) return <Loading label="Загрузка черновика…" />;
  if (error && !data) {
    return <ErrorState error={error} onRetry={reload} title={error.status === 404 ? "Черновик не найден" : undefined} page />;
  }
  if (!data) return null;
  if (data.operation === "create") return <Navigate to={`/documents/new?draft=${encodeURIComponent(id)}`} replace />;
  if (!data.can_edit) {
    return (
      <Notice tone="warning">
        <p>
          <strong>Черновик больше нельзя редактировать</strong>: статус предложения — «{PROPOSAL_STATUS_LABEL[data.status]}».
        </p>
        <Link to={`/proposals/${encodeURIComponent(id)}`} className="text-link">
          Открыть предложение
        </Link>
      </Notice>
    );
  }
  return (
    <ChangeDraftForm
      key={data.edit_version}
      proposal={data}
      previousText={previousText}
      onReload={(text) => {
        setPreviousText(text);
        reload();
      }}
    />
  );
}

interface ChangeDraftFormProps {
  proposal: ProposalDetail;
  previousText: string | null;
  onReload: (text: string) => void;
}

function ChangeDraftForm({ proposal: p, previousText, onReload }: ChangeDraftFormProps) {
  const navigate = useNavigate();
  const [content, setContent] = useState(p.proposed_content);
  const [reason, setReason] = useState(p.reason);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const dirty = content !== p.proposed_content || reason.trim() !== p.reason;
  const back = `/proposals/${encodeURIComponent(p.id)}`;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.saveDraft(p.id, { expected_version: p.edit_version, reason: reason.trim(), proposed_content: content });
      navigate(back);
    } catch (err) {
      setError(toApiError(err)); // the text stays in the editor
    } finally {
      setPending(false);
    }
  }

  function onCancel(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    event.preventDefault();
    setConfirmLeave(true);
  }

  return (
    <div className="editor">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to="/proposals">Предложения</Link>
        <span aria-hidden="true">/</span>
        <Link to={back}>{p.document_id}</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Редактирование черновика</span>
      </nav>
      <div className="page-head">
        <h1>Редактирование черновика</h1>
        <p className="lead">
          Изменение документа «{p.document_title}». Сохранение обновит черновик предложения — сам документ не меняется до
          merge в GitLab.
        </p>
      </div>
      <dl className="inline-meta">
        <div>
          <dt>Документ</dt>
          <dd>
            <code className="doc-id">{p.document_id}</code>
          </dd>
        </div>
        <div>
          <dt>Базовая ревизия</dt>
          <dd>
            <code className="doc-id">{p.base_revision}</code>
          </dd>
        </div>
      </dl>
      {previousText !== null && previousText !== p.proposed_content ? (
        <Notice tone="warning">
          <p>Загружена сохранённая версия черновика. Ваш прежний текст — ниже: перенесите нужные правки.</p>
          <details>
            <summary>Показать прежний текст</summary>
            <pre className="raw-source">
              <code>{previousText}</code>
            </pre>
          </details>
        </Notice>
      ) : null}
      <form className="editor__form" onSubmit={save}>
        <ChangeContentEditor value={content} onChange={setContent} />
        <label htmlFor="reason">Причина изменения</label>
        <input
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          required
          minLength={3}
        />
        {error ? (
          <div className="stack">
            <ErrorState
              error={error}
              title={AUTHORING_ERROR_TITLE[error.code]}
              onRetry={error.code === "draft_modified" ? () => onReload(content) : undefined}
              retryLabel="Загрузить сохранённую версию"
            />
            {error.code === "draft_not_editable" ? (
              <Link to={back} className="text-link">
                Открыть предложение
              </Link>
            ) : (
              <p className="muted">Ваш текст остаётся в редакторе.</p>
            )}
          </div>
        ) : null}
        <p className="save-state" role="status" aria-live="polite">
          {dirty ? "Есть несохранённые изменения" : "Изменений после последнего сохранения нет"}
        </p>
        <div className="editor__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={pending || !dirty || reason.trim().length < 3}
          >
            Сохранить черновик
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setContent(p.proposed_content);
              setReason(p.reason);
            }}
            disabled={!dirty || pending}
          >
            Вернуть сохранённый текст
          </button>
          <Link to={back} className="button button--ghost" onClick={onCancel}>
            Отмена
          </Link>
        </div>
        {confirmLeave ? (
          <div className="reject-box" role="group" aria-labelledby="confirm-leave-change">
            <p id="confirm-leave-change">
              <strong>Есть несохранённые изменения.</strong> Если уйти сейчас, они будут потеряны.
            </p>
            <div className="button-row">
              <button type="button" className="button button--danger" onClick={() => navigate(back)}>
                Уйти без сохранения
              </button>
              <button type="button" className="button button--ghost" onClick={() => setConfirmLeave(false)}>
                Остаться
              </button>
            </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}
