import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api, isCancelled } from "../api/client";
import type { AiDraftResponse, DocumentTemplateInfo } from "../api/types";
import { AI_MODE_LABEL } from "../components/AiSourcesPanel";
import { AuthoringRoute, DocumentEditor } from "../components/DocumentEditor";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import {
  fieldsFromAi,
  fieldsFromProposal,
  fieldsFromTemplate,
  retitleBody,
  splitList,
  type AiInput,
  type EditorFields,
} from "../lib/authoring";
import { AI_ERROR_TITLE, AUTHORING_ERROR_TITLE, PROPOSAL_STATUS_LABEL, TYPE_LABEL } from "../lib/labels";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";

type Mode = "manual" | "ai";

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/**
 * `/documents/new`: Создать → Тип → Редактор → Сохранить черновик → Проверка → Ревью.
 * `?draft=<id>` resumes a stored draft (it survives reloads and restarts: drafts live on the backend);
 * `?from=<id>` starts a new draft from the text of an earlier `create` proposal (e.g. after a conflict).
 */
export function DocumentCreatePage() {
  const [params] = useSearchParams();
  const draftId = params.get("draft");
  // A draft created on this page keeps its editor mounted when the URL switches to `?draft=<id>`.
  const [adopted, setAdopted] = useState<string | null>(null);
  const [flowKey, setFlowKey] = useState(0);
  const [previousDraftId, setPreviousDraftId] = useState(draftId);
  if (draftId !== previousDraftId) {
    setPreviousDraftId(draftId);
    if (!draftId) {
      // Navigating from a draft to a plain `/documents/new` starts a fresh document.
      setFlowKey((key) => key + 1);
      setAdopted(null);
    }
  }

  return (
    <div className="authoring">
      <nav className="breadcrumbs" aria-label="Путь">
        <Link to="/documents">База знаний</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Новый документ</span>
      </nav>
      <div className="page-head">
        <h1>Новый документ</h1>
        <p className="lead">
          Документ сохраняется как черновик-предложение, проходит проверку и ревью и появится в базе знаний только после
          merge в GitLab. Разбираться в Git и YAML не нужно.
        </p>
      </div>
      {draftId && draftId !== adopted ? (
        <ResumeDraft key={draftId} id={draftId} />
      ) : (
        <NewDocumentFlow key={flowKey} onCreated={setAdopted} />
      )}
    </div>
  );
}

// --- a new document ---------------------------------------------------------------------------------

interface EditorStart {
  template: DocumentTemplateInfo;
  initial: EditorFields;
  aiResult: AiDraftResponse | null;
}

function NewDocumentFlow({ onCreated }: { onCreated: (id: string) => void }) {
  const session = useSession();
  const [params] = useSearchParams();
  // Read once: the URL changes to `?draft=<id>` after the first save, the flow must not restart then.
  const [fromId] = useState(() => params.get("from"));
  const templates = useAsync(() => api.templates(), "authoring-templates");
  const [mode, setMode] = useState<Mode>("manual");
  // `?template=<id>` from the Template Hub («Использовать шаблон») preselects the template.
  const [requestedTemplate] = useState(() => params.get("template"));
  const [templateId, setTemplateId] = useState<string | null>(requestedTemplate);
  const [stage, setStage] = useState<"choose" | "ai" | "edit">("choose");
  const [start, setStart] = useState<EditorStart | null>(null);
  const aiAvailable = session?.features.ai_authoring ?? false;
  const owner = session?.user.user_id ?? "";

  if (fromId) return <CopyFromProposal id={fromId} owner={owner} onCreated={onCreated} />;
  if (templates.loading && !templates.data) return <Loading label="Загрузка шаблонов…" />;
  if (templates.error) return <ErrorState error={templates.error} onRetry={templates.reload} />;
  const list = templates.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState title="Шаблоны документов не найдены">
        <p>Без шаблона нельзя определить раздел и структуру документа. Обратитесь к администратору приложения.</p>
      </EmptyState>
    );
  }
  const template = list.find((t) => t.id === templateId) ?? null;
  const unavailableRequested = requestedTemplate && !list.some((t) => t.id === requestedTemplate) ? requestedTemplate : null;

  if (stage === "edit" && start) {
    return (
      <DocumentEditor
        template={start.template}
        initial={start.initial}
        aiResult={start.aiResult}
        draft={null}
        onCreated={onCreated}
      />
    );
  }

  if (stage === "ai" && template) {
    return (
      <AiRequestStep
        template={template}
        aiMode={session?.features.ai_mode ?? "mock"}
        onBack={() => setStage("choose")}
        onManual={(title) => {
          const initial = fieldsFromTemplate(template, owner);
          const body = retitleBody(initial.body, initial.title, title);
          setStart({ template, initial: { ...initial, title: title.trim(), body }, aiResult: null });
          setStage("edit");
        }}
        onResult={(result, input) => {
          setStart({ template, initial: fieldsFromAi(template, result, input, owner), aiResult: result });
          setStage("edit");
        }}
      />
    );
  }

  function proceed(event: FormEvent) {
    event.preventDefault();
    if (!template) return;
    if (mode === "ai" && aiAvailable) {
      setStage("ai");
      return;
    }
    setStart({ template, initial: fieldsFromTemplate(template, owner), aiResult: null });
    setStage("edit");
  }

  const aiOff = session?.features.ai_mode === "disabled";
  let modeHint: string;
  if (aiOff) modeHint = "ИИ в этой установке отключён — документ создаётся вручную по шаблону.";
  else if (!aiAvailable)
    modeHint = "AI-помощник для создания документов отключён в этой установке — создайте документ вручную по шаблону.";
  else if (session?.features.ai_mode === "mock")
    modeHint =
      "Демо-режим без языковой модели: помощник соберёт структуру по шаблону и вставит только дословные выдержки из утверждённых документов команды.";
  else if (session?.features.ai_mode === "claude_cli")
    modeHint =
      "Помощник (Claude Code CLI, личный тест) предложит текст по шаблону со ссылками на источники; подготовка может занять несколько минут. Текст нужно проверить и отредактировать.";
  else modeHint = "Помощник предложит текст по шаблону со ссылками на источники. Текст нужно проверить и отредактировать.";

  return (
    <form className="authoring__start" onSubmit={proceed} aria-labelledby="start-title">
      <AuthoringRoute states={{ type: "current" }} />
      <h2 id="start-title">Способ и тип документа</h2>
      <p className="authoring__alt">
        Есть готовый текст в Markdown? <Link to="/documents/import">Импортировать Markdown</Link> — метаданные (YAML)
        писать не нужно. Все шаблоны с описанием и примерами — в разделе <Link to="/templates">Шаблоны</Link>.
      </p>
      {unavailableRequested ? (
        <Notice tone="warning">
          Шаблон «{unavailableRequested}» не используется для новых документов (устарел или не активен). Выберите
          актуальный шаблон.
        </Notice>
      ) : null}
      <fieldset className="segmented authoring__mode" aria-describedby="mode-hint">
        <legend>Как создать</legend>
        <label className="segmented__option">
          <input type="radio" name="mode" value="manual" checked={mode === "manual"} onChange={() => setMode("manual")} />
          <span>Вручную</span>
        </label>
        {/* No AI provider: the option is not offered at all (no dead control); otherwise it is disabled with a reason. */}
        {aiOff ? null : (
          <label className="segmented__option">
            <input
              type="radio"
              name="mode"
              value="ai"
              checked={mode === "ai"}
              disabled={!aiAvailable}
              onChange={() => setMode("ai")}
            />
            <span>С помощью AI</span>
          </label>
        )}
      </fieldset>
      <p id="mode-hint" className="muted authoring__mode-hint">
        {modeHint}
      </p>

      <fieldset className="template-cards">
        <legend>Тип документа</legend>
        <div className="template-cards__grid">
          {list.map((t) => (
            <label key={t.id} className="template-card">
              <input
                type="radio"
                name="template"
                value={t.id}
                checked={templateId === t.id}
                onChange={() => setTemplateId(t.id)}
                aria-labelledby={`tpl-${t.id}-title`}
                aria-describedby={`tpl-${t.id}-type tpl-${t.id}-desc tpl-${t.id}-sections`}
              />
              <span className="template-card__body">
                <span className="template-card__title">
                  <span id={`tpl-${t.id}-title`}>{t.title}</span>
                  {t.version && t.version > 1 ? (
                    <span className="template-card__version">
                      <span className="visually-hidden">версия шаблона </span>v{t.version}
                    </span>
                  ) : null}
                </span>
                <span className="template-card__type" id={`tpl-${t.id}-type`}>
                  Раздел каталога: {TYPE_LABEL[t.doc_type] ?? t.doc_type}
                </span>
                <span className="template-card__desc" id={`tpl-${t.id}-desc`}>
                  {t.description}
                </span>
                <span className="template-card__sections" id={`tpl-${t.id}-sections`}>
                  <span className="visually-hidden">Разделы шаблона: </span>
                  {t.sections.join(" · ")}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={!template}>
          {mode === "ai" && aiAvailable ? "Далее: запрос помощнику" : "Открыть редактор"}
        </button>
        <Link to="/documents" className="button button--ghost">
          Отмена
        </Link>
      </div>
      {!template ? <p className="muted">Выберите тип документа, чтобы продолжить.</p> : null}
    </form>
  );
}

// --- AI request -------------------------------------------------------------------------------------

interface AiRequestStepProps {
  template: DocumentTemplateInfo;
  aiMode: string;
  onBack: () => void;
  onManual: (title: string) => void;
  onResult: (result: AiDraftResponse, input: AiInput) => void;
}

function AiRequestStep({ template, aiMode, onBack, onManual, onResult }: AiRequestStepProps) {
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [related, setRelated] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const valid = title.trim().length > 0 && request.trim().length >= 3;

  // Leaving the step abandons a running request.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || pending) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setError(null);
    setCancelled(false);
    const input: AiInput = { title: title.trim(), request: request.trim(), relatedIds: splitList(related).slice(0, 10) };
    try {
      const result = await api.aiDraft(
        { template_id: template.id, title: input.title, request: input.request, related_ids: input.relatedIds },
        { signal: controller.signal },
      );
      // A response that raced with «Отменить» is dropped: the user chose to stay in the form.
      if (!controller.signal.aborted) onResult(result, input);
      else setCancelled(true);
    } catch (err) {
      // The request text stays in the form either way.
      if (isCancelled(err)) setCancelled(true);
      else setError(toApiError(err));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPending(false);
    }
  }

  return (
    <form className="authoring__ai panel" onSubmit={submit} aria-labelledby="ai-step-title">
      <AuthoringRoute states={{ type: "current" }} />
      <h2 id="ai-step-title">Запрос помощнику: «{template.title}»</h2>
      <p className="ai-mode-line">
        <span className={`ai-mode ai-mode--${aiMode}`}>{AI_MODE_LABEL[aiMode] ?? aiMode}</span>
      </p>
      <p className="muted">
        Помощник заполнит разделы шаблона только сведениями из утверждённых документов команды, которые вам доступны, и
        покажет источники. Чего нет в источниках, останется с пометкой «Требует уточнения». Результат — черновик: его
        нужно проверить и отредактировать.
      </p>
      <div className="field">
        <label htmlFor="ai-title">
          Название <span aria-hidden="true">*</span>
        </label>
        <input id="ai-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required />
      </div>
      <div className="field">
        <label htmlFor="ai-request">
          Что должно быть в документе <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="ai-request"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          maxLength={2000}
          rows={4}
          required
          aria-describedby="ai-request-hint"
        />
        <p id="ai-request-hint" className="field__hint">
          Например: какие системы участвуют, какие данные передаются, что нужно решить.
        </p>
      </div>
      <div className="field">
        <label htmlFor="ai-related">Связанные документы (необязательно)</label>
        <input
          id="ai-related"
          className="field__mono"
          value={related}
          onChange={(e) => setRelated(e.target.value)}
          maxLength={1500}
          spellCheck={false}
          aria-describedby="ai-related-hint"
          placeholder="SEM-ARCH-001, SEM-INT-002"
        />
        <p id="ai-related-hint" className="field__hint">
          ID через запятую, до 10. Как источники используются только утверждённые документы.
        </p>
      </div>
      <div aria-live="polite">
        {pending ? (
          <p className="muted">
            {aiMode === "claude_cli" ? "Готовим черновик… с Claude Code это может занять несколько минут" : "Готовим черновик…"}
          </p>
        ) : null}
        {cancelled && !pending ? (
          <p className="muted">Подготовка черновика отменена. Ваш запрос сохранён в форме — можно повторить.</p>
        ) : null}
      </div>
      {error ? (
        <div className="stack">
          <ErrorState error={error} title={AUTHORING_ERROR_TITLE[error.code] ?? AI_ERROR_TITLE[error.code]} />
          <p>Ваш запрос сохранён в форме. Можно повторить или продолжить без помощника.</p>
        </div>
      ) : null}
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={!valid || pending}>
          Подготовить черновик
        </button>
        {pending ? (
          <button type="button" className="button button--secondary" onClick={() => abortRef.current?.abort()}>
            Отменить
          </button>
        ) : null}
        <button type="button" className="button button--secondary" disabled={pending} onClick={() => onManual(title)}>
          Заполнить вручную
        </button>
        <button type="button" className="button button--ghost" disabled={pending} onClick={onBack}>
          Назад
        </button>
      </div>
    </form>
  );
}

// --- an existing draft ------------------------------------------------------------------------------

function ResumeDraft({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(async () => {
    const [proposal, templates] = await Promise.all([api.draft(id), api.templates(true)]);
    return { proposal, templates };
  }, `resume-${id}`);

  if (loading && !data) return <Loading label="Загрузка черновика…" />;
  if (error) {
    return <ErrorState error={error} onRetry={reload} title={error.status === 404 ? "Черновик не найден" : undefined} />;
  }
  if (!data) return null;
  const p = data.proposal;
  const proposalLink = (
    <Link to={`/proposals/${encodeURIComponent(p.id)}`} className="text-link">
      Открыть предложение
    </Link>
  );

  if (p.operation !== "create") {
    return (
      <Notice tone="info">
        <p>
          Это предложение изменения существующего документа «{p.document_title}», а не новый документ.
        </p>
        {p.can_edit ? (
          <p>
            <Link to={`/proposals/new?edit=${encodeURIComponent(p.id)}`} className="text-link">
              Продолжить редактирование изменения
            </Link>
          </p>
        ) : null}
        {proposalLink}
      </Notice>
    );
  }
  if (!p.can_edit) {
    return (
      <Notice tone="warning">
        <p>
          <strong>Черновик больше нельзя редактировать</strong>: статус предложения — «{PROPOSAL_STATUS_LABEL[p.status]}».
          Дальнейшие шаги выполняются на странице предложения.
        </p>
        {proposalLink}
      </Notice>
    );
  }
  const template = data.templates.find((t) => t.id === p.template_id);
  const initial = fieldsFromProposal(p);
  if (!template || !initial) {
    return (
      <Notice tone="danger">
        <p>
          Не удалось открыть черновик в редакторе:{" "}
          {!template ? "шаблон документа больше не доступен." : "сохранённый файл не удалось разобрать."}
        </p>
        {proposalLink}
      </Notice>
    );
  }
  return <DocumentEditor template={template} initial={initial} draft={p} />;
}

/** `?from=<id>`: a NEW draft with the text of an earlier `create` proposal and a fresh suggested ID. */
function CopyFromProposal({ id, owner, onCreated }: { id: string; owner: string; onCreated: (id: string) => void }) {
  const { data, error, loading, reload } = useAsync(async () => {
    // Listed templates only: an external_import draft is never copied into an ordinary new document.
    const [proposal, templates] = await Promise.all([api.draft(id), api.templates()]);
    return { proposal, templates };
  }, `copy-${id}`);

  if (loading && !data) return <Loading label="Загрузка исходного предложения…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const p = data.proposal;
  const template = data.templates.find((t) => t.id === p.template_id);
  const base = p.operation === "create" ? fieldsFromProposal(p) : null;
  if (!template || !base) {
    return (
      <Notice tone="warning">
        <p>Из этого предложения нельзя взять текст нового документа.</p>
        <Link to="/documents/new" className="text-link">
          Создать документ с нуля
        </Link>
      </Notice>
    );
  }
  const initial: EditorFields = {
    ...base,
    owner: base.owner || owner,
    id: "",
    manualId: false,
    path: "",
    pathEdited: false,
  };
  return (
    <DocumentEditor
      template={template}
      initial={initial}
      draft={null}
      onCreated={onCreated}
      notice={
        <Notice tone="info">
          <p>
            Текст и метаданные взяты из предложения «{p.reason}». ID <code className="doc-id">{p.document_id}</code> уже
            занят, поэтому сервер выделит новый свободный ID при первом сохранении. Будет создан новый черновик.
          </p>
          <Link to={`/proposals/${encodeURIComponent(p.id)}`} className="text-link">
            Вернуться к исходному предложению
          </Link>
        </Notice>
      }
    />
  );
}
