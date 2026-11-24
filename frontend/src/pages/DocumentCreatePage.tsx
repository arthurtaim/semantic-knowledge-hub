import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api, isCancelled } from "../api/client";
import type { AiDraftResponse, BlankDocumentInfo, DocType, DocumentTemplateInfo } from "../api/types";
import { AI_MODE_LABEL } from "../components/AiSourcesPanel";
import { AuthoringRoute, DocumentEditor } from "../components/DocumentEditor";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { SECTION_HINT, SectionSelect } from "../components/SectionSelect";
import { PageToolbar } from "../components/shell/PageToolbar";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import {
  fieldsFromAi,
  fieldsFromBlank,
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
 * «Пустой документ» (first) opens the editor with a title and a section only; «По шаблону» is the template flow.
 * `?draft=<id>` resumes a stored draft (it survives reloads and restarts: drafts live on the backend) — with or
 * without a template; `?from=<id>` starts a new draft from the text of an earlier `create` proposal.
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
      <PageToolbar crumbs={[{ label: "Документы", to: "/documents" }, { label: "Новый документ" }]} />
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
  /** Null: a blank document. */
  template: DocumentTemplateInfo | null;
  blank: BlankDocumentInfo | null;
  initial: EditorFields;
  aiResult: AiDraftResponse | null;
}

function NewDocumentFlow({ onCreated }: { onCreated: (id: string) => void }) {
  const session = useSession();
  const [params] = useSearchParams();
  // Read once: the URL changes to `?draft=<id>` after the first save, the flow must not restart then.
  const [fromId] = useState(() => params.get("from"));
  const templates = useAsync(() => api.templates(), "authoring-templates");
  // Only a preview (prefix, next ID, default section): the blank start never waits for it or fails on it.
  const blank = useAsync(() => api.blankDocument(), "authoring-blank");
  const [mode, setMode] = useState<Mode>("manual");
  // `?template=<id>` from the Template Hub («Использовать шаблон») preselects the template.
  const [requestedTemplate] = useState(() => params.get("template"));
  const [templateId, setTemplateId] = useState<string | null>(requestedTemplate);
  const [stage, setStage] = useState<"choose" | "ai" | "edit">("choose");
  const [start, setStart] = useState<EditorStart | null>(null);
  const aiAvailable = session?.features.ai_authoring ?? false;
  const owner = session?.user.user_id ?? "";

  if (fromId) return <CopyFromProposal id={fromId} owner={owner} onCreated={onCreated} />;
  const list = templates.data ?? [];
  const template = list.find((t) => t.id === templateId) ?? null;
  const unavailableRequested =
    requestedTemplate && templates.data && !list.some((t) => t.id === requestedTemplate) ? requestedTemplate : null;

  if (stage === "edit" && start) {
    return (
      <DocumentEditor
        template={start.template}
        blank={start.blank}
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
          setStart({ template, blank: null, initial: { ...initial, title: title.trim(), body }, aiResult: null });
          setStage("edit");
        }}
        onResult={(result, input) => {
          setStart({ template, blank: null, initial: fieldsFromAi(template, result, input, owner), aiResult: result });
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
    setStart({ template, blank: null, initial: fieldsFromTemplate(template, owner), aiResult: null });
    setStage("edit");
  }

  function startBlank(title: string, type: DocType) {
    setStart({ template: null, blank: blank.data, initial: fieldsFromBlank(title, type, owner), aiResult: null });
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

  let templateStart: ReactNode;
  if (templates.loading && !templates.data) templateStart = <Loading label="Загрузка шаблонов…" />;
  else if (templates.error) templateStart = <ErrorState error={templates.error} onRetry={templates.reload} />;
  else if (list.length === 0) {
    templateStart = (
      <Notice tone="info">
        Активных шаблонов нет — создайте пустой документ. Шаблон можно будет применить позже, когда он появится.
      </Notice>
    );
  } else templateStart = null;

  return (
    <div className="authoring__start">
      <AuthoringRoute states={{ type: "current" }} />
      <p className="authoring__alt">
        Есть готовый текст в Markdown? <Link to="/documents/import">Импортировать Markdown</Link> — метаданные (YAML)
        писать не нужно. Все шаблоны с описанием и примерами — в разделе <Link to="/templates">Шаблоны</Link>.
      </p>
      <BlankStart defaultType={blank.data?.default_type ?? "guide"} onStart={startBlank} />
      {templateStart ?? (
        <form className="authoring__template-start" onSubmit={proceed} aria-labelledby="start-title">
          <h2 id="start-title">По шаблону</h2>
          <p className="muted authoring__start-lead">
            Шаблон сразу даст структуру: обязательные разделы с подсказками, раздел каталога и теги.
          </p>
          {unavailableRequested ? (
            <Notice tone="warning">
              Шаблон «{unavailableRequested}» не используется для новых документов (устарел или не активен). Выберите
              актуальный шаблон.
            </Notice>
          ) : null}
          {/* No AI provider: the option is not offered at all (no dead control); otherwise it is disabled with a reason. */}
          <SegmentedControl
            label="Как создать"
            showLabel
            className="authoring__mode"
            describedBy="mode-hint"
            value={mode}
            onChange={setMode}
            options={[
              { value: "manual", label: "Вручную" },
              ...(aiOff ? [] : [{ value: "ai" as const, label: "С помощью AI", disabled: !aiAvailable }]),
            ]}
          />
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
      )}
    </div>
  );
}

// --- a blank document -------------------------------------------------------------------------------

/**
 * «Пустой документ», as in Obsidian or Notion: a title and a section — and straight into the editor. No template and no
 * required sections; the server fills the technical metadata (ID, status, dates, origin) at the first save.
 */
function BlankStart({ defaultType, onStart }: { defaultType: DocType; onStart: (title: string, type: DocType) => void }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DocType | null>(null);
  const chosen = type ?? defaultType;
  const valid = title.trim().length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid) onStart(title, chosen);
  }

  return (
    <form className="panel blank-start" onSubmit={submit} aria-labelledby="blank-start-title">
      <h2 id="blank-start-title">Пустой документ</h2>
      <p className="muted blank-start__lead">
        Как в Obsidian или Notion: без шаблона и обязательных разделов. Свободный Markdown, ссылки [[…]] и ИИ-помощник
        доступны сразу; ID, статус «черновик» и другие технические поля сервер заполнит сам. Шаблон можно применить
        позже — он добавит недостающие разделы, ничего не удаляя.
      </p>
      <div className="blank-start__grid">
        <div className="field">
          <label htmlFor="blank-title">
            Название <span aria-hidden="true">*</span>
          </label>
          <input
            id="blank-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            required
            placeholder="Например: Заметки о витрине клиентов"
          />
        </div>
        <div className="field">
          <label htmlFor="blank-type">Раздел каталога</label>
          <SectionSelect id="blank-type" value={chosen} onChange={setType} describedBy="blank-type-hint" />
          <p id="blank-type-hint" className="field__hint">
            {SECTION_HINT}
          </p>
        </div>
      </div>
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={!valid} aria-describedby="blank-start-hint">
          Начать писать
        </button>
      </div>
      <p id="blank-start-hint" className="muted">
        {valid ? "Откроется редактор. Черновик сохранится, когда вы нажмёте «Сохранить черновик»." : "Укажите название, чтобы начать."}
      </p>
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
  // A draft without a template (a blank document, an imported file) opens in the same editor.
  const template = p.template_id ? data.templates.find((t) => t.id === p.template_id) : null;
  const initial = fieldsFromProposal(p);
  if (template === undefined || !initial) {
    return (
      <Notice tone="danger">
        <p>
          Не удалось открыть черновик в редакторе:{" "}
          {template === undefined ? "шаблон документа больше не доступен." : "сохранённый файл не удалось разобрать."}
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
    const [proposal, templates, blank] = await Promise.all([
      api.draft(id),
      api.templates(),
      api.blankDocument().catch(() => null),
    ]);
    return { proposal, templates, blank };
  }, `copy-${id}`);

  if (loading && !data) return <Loading label="Загрузка исходного предложения…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const p = data.proposal;
  // A blank source stays blank (null); a template that is no longer offered cannot be copied (undefined).
  const template = p.template_id ? data.templates.find((t) => t.id === p.template_id) : null;
  const base = p.operation === "create" ? fieldsFromProposal(p) : null;
  if (template === undefined || !base) {
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
      blank={data.blank}
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
