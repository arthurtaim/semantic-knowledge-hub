import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { DocumentDetail, ProposalDetail } from "../api/types";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { StatusStamp } from "../components/StatusStamp";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";

export function ProposalEditorPage() {
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
      <EmptyState title="Не выбран документ">
        <p>Откройте документ в базе знаний и нажмите «Предложить изменение».</p>
        <Link to="/documents" className="button button--secondary">
          Перейти к документам
        </Link>
      </EmptyState>
    );
  }
  if (loading && !doc) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
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
  const [origin, setOrigin] = useState<"manual" | "ai_suggestion">(basis?.origin ?? "manual");
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
        <label htmlFor="content">Текст документа (Markdown с YAML-заголовком)</label>
        <textarea
          id="content"
          className="editor__source"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={22}
          spellCheck={false}
        />
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
