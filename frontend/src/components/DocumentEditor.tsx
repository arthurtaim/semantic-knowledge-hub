import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type {
  AiDraftResponse,
  AuthoringCheckRequest,
  AuthoringCheckResponse,
  BlankDocumentInfo,
  DocType,
  DocumentTemplateInfo,
  ProposalDetail,
  ValidationIssue,
} from "../api/types";
import {
  directoryOf,
  fieldsFromProposal,
  followingPath,
  retitleBody,
  toMetadata,
  type EditorFields,
} from "../lib/authoring";
import {
  AUTHORING_ERROR_TITLE,
  formatSavedAt,
  ORIGIN_LABEL,
  PROPOSAL_ERROR_TITLE,
  PROPOSAL_STATUS_LABEL,
  TYPE_LABEL,
} from "../lib/labels";
import { newRequestId } from "../lib/requestId";
import { useSession } from "../lib/session";
import { sectionHeadings } from "../lib/wikilink";
import { AiAssistPanel, useAiProposal, type AiAction } from "./AiProposal";
import { AiSourcesPanel } from "./AiSourcesPanel";
import { ApplyTemplatePanel } from "./ApplyTemplate";
import { ErrorState, Notice } from "./Feedback";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { SafeHtml } from "./SafeHtml";
import { SECTION_HINT, SectionSelect } from "./SectionSelect";
import { buttonClass } from "./ui/Button";
import { StatusStamp } from "./StatusStamp";
import { TemplateVersionNotice } from "./TemplateVersionNotice";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { WikiLinkTextarea } from "./WikiLinkTextarea";

/** Debounce of the live ID / validation check after an edit (exported for the tests' waits). */
export const CHECK_DELAY_MS = 500;

/** ValidationIssue.field values shown next to a form field; everything else goes to the general list. */
const FIELD_LABEL: Record<string, string> = {
  id: "ID документа",
  title: "Название",
  type: "Раздел каталога",
  status: "Статус",
  owner: "Владелец",
  tags: "Теги",
  related_ids: "Связанные документы",
  source_refs: "Источники",
  summary: "Описание",
  path: "Путь в репозитории",
};

const TAKEN_CODES = new Set(["document_id_taken", "document_path_taken"]);
/** Errors after which the draft is no longer an editable draft on the server. */
const LOCKING_CODES = new Set(["draft_not_editable", "document_exists", "invalid_transition"]);

const EMPTY_CHECK: AuthoringCheckResponse = {
  content: "",
  path: "",
  validation: [],
  preview_html: "",
  id_available: true,
  path_available: true,
  error_count: 0,
  warning_count: 0,
};

type Pending = "save" | "check" | "submit" | "delete" | "reload";

interface SavedDraft {
  id: string;
  version: number;
  savedAt: string;
  canDelete: boolean;
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/** Everything a save sends; the editor is "dirty" while this differs from the last saved state. */
function saveSnapshot(fields: EditorFields): string {
  return JSON.stringify({
    metadata: toMetadata(fields),
    body: fields.body,
    path: fields.path.trim(),
    reason: fields.reason.trim(),
    origin: fields.origin,
  });
}

function savedFrom(detail: ProposalDetail): SavedDraft {
  return { id: detail.id, version: detail.edit_version, savedAt: detail.updated_at, canDelete: detail.can_delete };
}

function errorTitle(error: ApiError): string | undefined {
  return AUTHORING_ERROR_TITLE[error.code] ?? PROPOSAL_ERROR_TITLE[error.code];
}

// --- route indicator --------------------------------------------------------------------------------

export type RouteStep = "type" | "edit" | "save" | "check" | "review";
type RouteState = "done" | "current" | "pending" | "failed";

const ROUTE_TITLES: [RouteStep, string][] = [
  ["type", "Тип документа"],
  ["edit", "Текст и метаданные"],
  ["save", "Черновик сохранён"],
  ["check", "Проверка"],
  ["review", "Отправка на ревью"],
];

const ROUTE_STATE_TEXT: Record<RouteState, string> = {
  done: "выполнено",
  current: "текущий шаг",
  pending: "впереди",
  failed: "есть ошибки",
};

/** «Тип → Редактор → Сохранить черновик → Проверка → Ревью»: where the author is in the authoring route. */
export function AuthoringRoute({ states }: { states: Partial<Record<RouteStep, RouteState>> }) {
  return (
    <ol className="lifecycle lifecycle--compact" aria-label="Шаги создания документа">
      {ROUTE_TITLES.map(([key, title], index) => {
        const state = states[key] ?? "pending";
        return (
          <li
            key={key}
            className={`lifecycle__step lifecycle__step--${state}`}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="lifecycle__marker" aria-hidden="true">
              {state === "done" ? "✓" : state === "failed" ? "!" : index + 1}
            </span>
            <span className="lifecycle__body">
              <span className="lifecycle__title">{title}</span>
              <span className="lifecycle__state">{ROUTE_STATE_TEXT[state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// --- form field -------------------------------------------------------------------------------------

interface FieldMessages {
  hint?: ReactNode;
  status?: ReactNode;
  issues: ValidationIssue[];
  required?: string | null;
}

function describedBy(id: string, m: FieldMessages): string | undefined {
  const ids = [m.hint ? `${id}-hint` : "", m.status ? `${id}-status` : "", m.issues.length || m.required ? `${id}-issues` : ""];
  return ids.filter(Boolean).join(" ") || undefined;
}

function invalid(m: FieldMessages): boolean {
  return Boolean(m.required) || m.issues.some((i) => i.severity === "error");
}

function FieldNotes({ id, messages }: { id: string; messages: FieldMessages }) {
  const { hint, status, issues, required } = messages;
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
      {status ? (
        <p id={`${id}-status`} className="field__status">
          {status}
        </p>
      ) : null}
      {required || issues.length > 0 ? (
        <ul id={`${id}-issues`} className="field__issues">
          {required ? <li className="field__issue field__issue--error">{required}</li> : null}
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`} className={`field__issue field__issue--${issue.severity}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

// --- editor -----------------------------------------------------------------------------------------

export interface DocumentEditorProps {
  /** Null: a blank document (no template) — free Markdown, the author chooses the section. */
  template: DocumentTemplateInfo | null;
  /** What the server generates for a blank document (the ID / path preview before the first save). */
  blank?: BlankDocumentInfo | null;
  initial: EditorFields;
  /** The stored draft being edited; null until the first save creates it. */
  draft: ProposalDetail | null;
  /** Provenance of an AI suggestion that filled the body (not stored by the server). */
  aiResult?: AiDraftResponse | null;
  /** Extra notice above the form (e.g. "text taken from proposal …"). */
  notice?: ReactNode;
  /** Called once the first save created the draft (before the URL changes to `?draft=<id>`). */
  onCreated?: (id: string) => void;
  /** «Применить шаблон» updated the stored draft (its template changed): the page reopens it. */
  onTemplateApplied?: (detail: ProposalDetail) => void;
}

/**
 * Metadata form + Markdown editor with live preview for a NEW document. The draft is stored on the server
 * (a `create` proposal); the YAML frontmatter is generated by the server from the form fields.
 */
export function DocumentEditor({
  template,
  blank = null,
  initial,
  draft,
  aiResult = null,
  notice,
  onCreated,
  onTemplateApplied,
}: DocumentEditorProps) {
  const navigate = useNavigate();
  const session = useSession();
  const [fields, setFields] = useState<EditorFields>(initial);
  // One idempotency key per form: a double click or a retried POST returns the draft already created.
  const [requestId] = useState(newRequestId);
  const [saved, setSaved] = useState<SavedDraft | null>(draft ? savedFrom(draft) : null);
  // An AI suggestion is unsaved work from the start; a pristine template or a loaded draft is not.
  const [baseline, setBaseline] = useState<string | null>(() => (aiResult ? null : saveSnapshot(initial)));
  const [autoDir] = useState(() =>
    directoryOf(
      initial.pathEdited || !initial.path ? (template?.suggested_path ?? blank?.suggested_path ?? "") : initial.path,
    ),
  );
  const [check, setCheck] = useState<{ key: string; result: AuthoringCheckResponse } | null>(null);
  const [checkError, setCheckError] = useState<ApiError | null>(null);
  const [checking, setChecking] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [locked, setLocked] = useState<{ id: string; message: string } | null>(null);
  const [previousBody, setPreviousBody] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(initial.pathEdited);
  const [view, setView] = useState<"source" | "preview">("source");
  const [applyOpen, setApplyOpen] = useState(false);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const idRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const ownerRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const metadata = toMetadata(fields);
  const snapshot = saveSnapshot(fields);
  const dirty = snapshot !== baseline;
  // The ID is allocated by the server at the first save; it is required only when the author sets it by hand.
  const idEditable = !saved && fields.manualId;
  const missing = {
    id: idEditable && !metadata.id,
    title: !metadata.title,
    body: !fields.body.trim(),
  };
  const missingAny = missing.id || missing.title || missing.body;
  const reasonInvalid = fields.reason.trim().length < 3;
  // An existing draft is checked against the template version it was created with (not the current one).
  const draftTemplateVersion = draft?.template_version ?? null;

  const checkRequest: AuthoringCheckRequest | null = missingAny
    ? null
    : {
        template_id: template?.id ?? null,
        metadata,
        body: fields.body,
        path: fields.path.trim() || null,
        origin: fields.origin,
        exclude_proposal_id: saved?.id ?? null,
        ...(draftTemplateVersion ? { template_version: draftTemplateVersion } : {}),
      };
  const checkKey = checkRequest ? JSON.stringify(checkRequest) : "";
  const requestRef = useRef(checkRequest);
  requestRef.current = checkRequest;
  const firstCheck = useRef(true);

  /** Stateless server validation + preview; responses of superseded requests are ignored. */
  const runCheck = useCallback(async (): Promise<AuthoringCheckResponse | null> => {
    const request = requestRef.current;
    if (!request) return null;
    const key = JSON.stringify(request);
    const id = ++seq.current;
    setChecking(true);
    try {
      const result = await api.checkNewDocument(request);
      if (id === seq.current) {
        setCheck({ key, result });
        setCheckError(null);
      }
      return result;
    } catch (err) {
      if (id === seq.current) setCheckError(toApiError(err));
      return null;
    } finally {
      if (id === seq.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!checkKey) return;
    const delay = firstCheck.current ? 0 : CHECK_DELAY_MS;
    firstCheck.current = false;
    const handle = window.setTimeout(() => void runCheck(), delay);
    return () => window.clearTimeout(handle);
  }, [checkKey, runCheck]);

  const fresh = check !== null && check.key === checkKey;
  const issues = check?.result.validation ?? [];
  const errors = issues.filter((i) => i.severity === "error");
  const generalIssues = issues.filter((i) => !i.field || !(i.field in FIELD_LABEL));
  const issuesFor = (field: string) => issues.filter((i) => i.field === field);
  const busy = pending !== null;

  // --- field updates ---
  const update = <K extends keyof EditorFields>(key: K, value: EditorFields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));
  // A "taken" error describes the previous ID/path; the live check reports on the new one.
  const clearTaken = () => setActionError((e) => (e && TAKEN_CODES.has(e.code) ? null : e));
  const setId = (value: string) => {
    clearTaken();
    setFields((f) => ({ ...f, id: value, path: f.pathEdited ? f.path : followingPath(autoDir, value) }));
  };
  const setManualId = (manual: boolean) => {
    clearTaken();
    const id = manual ? (template?.suggested_id ?? blank?.suggested_id ?? "") : "";
    setFields((f) => ({ ...f, manualId: manual, id, path: f.pathEdited ? f.path : followingPath(autoDir, id) }));
    if (manual) focusLater(idRef);
  };
  const setTitle = (value: string) =>
    setFields((f) => ({ ...f, title: value, body: retitleBody(f.body, f.title, value) }));
  const setPath = (value: string) => {
    clearTaken();
    setFields((f) => ({ ...f, path: value, pathEdited: true }));
  };
  const followId = () => setFields((f) => ({ ...f, path: followingPath(autoDir, f.id), pathEdited: false }));

  function focusLater(ref: { current: HTMLElement | null }) {
    requestAnimationFrame(() => ref.current?.focus());
  }

  function focusFirstMissing(requireReason: boolean) {
    if (missing.title) focusLater(titleRef);
    else if (missing.id) focusLater(idRef);
    else if (requireReason && reasonInvalid) focusLater(reasonRef);
    else if (missing.body) {
      setView("source");
      focusLater(bodyRef);
    }
  }

  /** 409 `document_id_taken` / `document_path_taken`: the draft was NOT stored; show it on the field, keep the text. */
  function showTaken(error: ApiError) {
    const detailField = typeof error.details.field === "string" ? error.details.field : "";
    const field = detailField || (error.code === "document_path_taken" ? "path" : "id");
    const validation = Array.isArray(error.details.validation) ? (error.details.validation as ValidationIssue[]) : [];
    const own: ValidationIssue = { severity: "error", code: error.code, message: error.message, field };
    const merged = validation.some((i) => i.code === error.code && i.field === field) ? validation : [...validation, own];
    seq.current += 1; // this answer is newer than any check still in flight
    setChecking(false);
    setCheck((previous) => ({
      key: checkKey,
      result: {
        ...(previous?.result ?? EMPTY_CHECK),
        validation: merged,
        id_available: !merged.some((i) => i.code === "document_id_taken"),
        path_available: !merged.some((i) => i.code === "document_path_taken"),
        error_count: merged.filter((i) => i.severity === "error").length,
        warning_count: merged.filter((i) => i.severity === "warning").length,
      },
    }));
    if (field === "path") {
      setAdvancedOpen(true);
      focusLater(pathRef);
    } else {
      if (fields.manualId) setAdvancedOpen(true);
      focusLater(idRef);
    }
  }

  function handleActionError(error: ApiError, proposalId: string | null) {
    setActionError(error);
    if (TAKEN_CODES.has(error.code)) showTaken(error);
    if (error.code === "validation_failed") void runCheck();
    if (proposalId && LOCKING_CODES.has(error.code)) setLocked({ id: proposalId, message: error.message });
  }

  /** Saves the draft (POST the first time, then PUT with the last known version). Never drops the text. */
  async function persist(): Promise<SavedDraft | null> {
    const sentFields = fields;
    const sentSnapshot = snapshot;
    const payload = {
      metadata,
      body: fields.body,
      path: fields.path.trim() || null,
      reason: fields.reason.trim(),
      origin: fields.origin,
    };
    try {
      const detail = saved
        ? await api.saveDraft(saved.id, { expected_version: saved.version, ...payload })
        : await api.createNewDocumentDraft({ template_id: template?.id ?? null, ...payload, client_request_id: requestId });
      const next = savedFrom(detail);
      setSaved(next);
      if (!saved) {
        // The server allocated the ID (and the path that follows it) exactly once: show and keep them.
        const allocated = (f: EditorFields): EditorFields => ({
          ...f,
          id: detail.document_id,
          manualId: false,
          path: f.pathEdited ? f.path : detail.document_path,
        });
        setFields(allocated);
        setBaseline(saveSnapshot(allocated(sentFields)));
      } else {
        setBaseline(sentSnapshot);
      }
      setActionError(null);
      if (!saved) {
        onCreated?.(detail.id);
        navigate(`/documents/new?draft=${encodeURIComponent(detail.id)}`, { replace: true });
      }
      return next;
    } catch (err) {
      handleActionError(toApiError(err), saved?.id ?? null);
      return null;
    }
  }

  function canProceed(requireReason: boolean): boolean {
    setAttempted(true);
    if (missingAny || (requireReason && reasonInvalid)) {
      focusFirstMissing(requireReason);
      return false;
    }
    return true;
  }

  async function guarded(kind: Pending, action: () => Promise<void>) {
    if (inFlight.current) return; // guards against a double click before React re-renders
    inFlight.current = true;
    setPending(kind);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const onSave = () => {
    if (!canProceed(true)) return;
    void guarded("save", async () => {
      await persist();
    });
  };

  const onCheck = () => {
    setShowSummary(true);
    if (!canProceed(false)) return;
    void guarded("check", async () => {
      await runCheck();
    });
  };

  const onSubmit = () => {
    if (!canProceed(true)) return;
    void guarded("submit", async () => {
      const current = !saved || dirty ? await persist() : saved;
      if (!current) return;
      try {
        await api.markReady(current.id);
        navigate(`/proposals/${encodeURIComponent(current.id)}`);
      } catch (err) {
        handleActionError(toApiError(err), current.id);
      }
    });
  };

  const onDelete = () => {
    if (!saved) return;
    const id = saved.id;
    void guarded("delete", async () => {
      try {
        await api.deleteDraft(id);
        navigate("/proposals", { state: { notice: "Черновик удалён. Документ в базе знаний не создавался." } });
      } catch (err) {
        setConfirmDelete(false);
        handleActionError(toApiError(err), id);
      }
    });
  };

  /** After 409 `draft_modified`: load the stored version; the local text stays visible for copying. */
  const onReload = () => {
    if (!saved) return;
    const id = saved.id;
    const localBody = fields.body;
    void guarded("reload", async () => {
      try {
        const latest = await api.draft(id);
        const next = latest.operation === "create" && latest.can_edit ? fieldsFromProposal(latest) : null;
        if (!next) {
          setLocked({ id, message: `Черновик больше нельзя редактировать: статус «${PROPOSAL_STATUS_LABEL[latest.status]}».` });
          setActionError(null);
          return;
        }
        setFields(next);
        setSaved(savedFrom(latest));
        setBaseline(saveSnapshot(next));
        setActionError(null);
        setPreviousBody(localBody !== next.body ? localBody : null);
      } catch (err) {
        setActionError(toApiError(err));
      }
    });
  };

  /** After an accepted AI proposal saved the draft on the server: load that version (a new edit_version). */
  async function reloadSaved(): Promise<void> {
    if (!saved) return;
    try {
      const latest = await api.draft(saved.id);
      const next = latest.operation === "create" && latest.can_edit ? fieldsFromProposal(latest) : null;
      if (!next) return;
      setFields(next);
      setSaved(savedFrom(latest));
      setBaseline(saveSnapshot(next));
    } catch (err) {
      setActionError(toApiError(err));
    }
  }

  const cancelHref = saved ? `/proposals/${encodeURIComponent(saved.id)}` : "/documents";

  // --- messages ---
  const required = (flag: boolean, message: string) => (attempted && flag ? message : null);
  // Availability is known only for the current form state; a taken ID/path is reported by its issue message.
  const availability = (available: boolean | undefined, checkingText: string, freeText: string) => {
    if (!checkKey) return null;
    if (!fresh || checking) return checkingText;
    return available ? freeText : null;
  };
  const previewId = !saved && !idEditable && fresh && check?.result.path ? check.result.path.split("/").pop()?.replace(/\.md$/, "") : null;
  const idMessages: FieldMessages = {
    hint: saved
      ? "Выделен при создании черновика и больше не меняется."
      : idEditable
        ? "Задан вручную: латиница, цифры, «-», «_» или «.». Сервер проверит, что ID свободен."
        : `ID выделит сервер при первом сохранении — один раз и навсегда.${previewId ? ` Сейчас свободен ${previewId}.` : ""}`,
    status: idEditable ? availability(check?.result.id_available, "Проверяем, свободен ли ID…", "ID свободен") : null,
    issues: issuesFor("id"),
    required: required(missing.id, "Укажите ID документа."),
  };
  const titleMessages: FieldMessages = { issues: issuesFor("title"), required: required(missing.title, "Укажите название.") };
  const ownerMessages: FieldMessages = {
    hint: "Команда или сотрудник, отвечающий за актуальность. Не указан — сохранится как «unassigned», владельца назначат на ревью.",
    issues: issuesFor("owner"),
  };
  const statusMessages: FieldMessages = {
    hint:
      fields.status === "draft"
        ? "Новый документ всегда начинается как черновик. Утверждённым он станет только после ревью и merge в GitLab — ни автор, ни ИИ статус не повышают."
        : "Статус задан в сохранённом черновике и вступит в силу только после ревью и merge в GitLab.",
    issues: issuesFor("status"),
  };
  const tagsMessages: FieldMessages = { hint: "Через запятую.", issues: issuesFor("tags") };
  const relatedMessages: FieldMessages = { hint: "ID документов через запятую.", issues: issuesFor("related_ids") };
  const summaryMessages: FieldMessages = { issues: issuesFor("summary") };
  const reasonMessages: FieldMessages = {
    hint: "Попадёт в описание предложения для ревьюеров.",
    issues: [],
    required: required(reasonInvalid, "Укажите причину или цель — не короче 3 символов."),
  };
  const pathMessages: FieldMessages = {
    hint: fields.pathEdited
      ? "Путь задан вручную. Имя файла должно совпадать с ID."
      : fields.id.trim()
        ? "Следует за ID документа, пока вы не измените путь."
        : "Сервер выберет путь вместе с ID при первом сохранении.",
    status: fields.path.trim() ? availability(check?.result.path_available, "Проверяем путь…", "Путь свободен") : null,
    issues: issuesFor("path"),
  };
  const sourcesMessages: FieldMessages = { hint: "Ссылки или ID источников через запятую.", issues: issuesFor("source_refs") };
  const bodyMessages: FieldMessages = {
    hint: `${template ? "" : "Свободный Markdown: обязательных разделов нет. "}Ссылка на другой документ: наберите [[ и начало ID или названия — появятся подсказки, вставится [[ID|Название]].`,
    issues: [],
    required: required(missing.body, "Текст документа не может быть пустым."),
  };
  const typeIssues = issuesFor("type");
  // «Применить шаблон» works on the SAVED draft (like the AI proposals): unsaved edits are saved first.
  let applyBlocker: string | null = null;
  if (locked) applyBlocker = "Черновик больше нельзя редактировать.";
  else if (!saved) applyBlocker = "Шаблон применяется к сохранённому черновику: сначала сохраните его.";
  else if (dirty) applyBlocker = "Есть несохранённые изменения: сохраните черновик, затем примените шаблон.";

  let submitBlocker: string | null = null;
  if (locked) submitBlocker = "Черновик больше нельзя редактировать.";
  else if (missingAny) submitBlocker = "Заполните обязательные поля: название и текст.";
  else if (reasonInvalid) submitBlocker = "Укажите причину или цель документа.";
  else if (errors.length > 0) submitBlocker = "Исправьте ошибки проверки, чтобы отправить документ на ревью.";

  let saveState: string;
  if (pending === "save" || (pending === "submit" && dirty)) saveState = "Сохраняем черновик…";
  else if (locked) saveState = "Редактирование закрыто";
  else if (dirty) saveState = saved ? "Есть несохранённые изменения" : "Черновик ещё не сохранён";
  else if (saved) saveState = `Черновик сохранён в ${formatSavedAt(saved.savedAt)}`;
  else saveState = "Черновик ещё не сохранён";

  const checkClean = fresh && errors.length === 0;
  const routeStates: Partial<Record<RouteStep, RouteState>> = {
    type: "done",
    edit: !saved || dirty ? "current" : "done",
    save: saved && !dirty ? "done" : "pending",
    check: saved && !dirty ? (checkClean ? "done" : errors.length > 0 ? "failed" : "current") : "pending",
    review: saved && !dirty && checkClean ? "current" : "pending",
  };

  return (
    <div className="authoring__editor">
      {/* «Отмена», the sidebar, any in-app link, Back / Forward, reload: one question before the edits are lost. */}
      <UnsavedChangesGuard
        when={dirty}
        description="Если выйти сейчас, правки будут потеряны. Чтобы их сохранить, нажмите «Остаться», затем «Сохранить черновик»."
      />
      <AuthoringRoute states={routeStates} />

      {notice}
      <TemplateVersionNotice proposal={draft} />
      {locked ? (
        <Notice tone="warning">
          <p>
            <strong>{locked.message}</strong> Ваш текст остаётся на странице — скопируйте его при необходимости.
          </p>
          <Link to={`/proposals/${encodeURIComponent(locked.id)}`} className="text-link">
            Открыть предложение
          </Link>
        </Notice>
      ) : null}
      {previousBody !== null ? (
        <Notice tone="warning">
          <p>Загружена сохранённая версия черновика. Ваш прежний текст — ниже: перенесите нужные правки.</p>
          <details>
            <summary>Показать прежний текст</summary>
            <pre className="raw-source">
              <code>{previousBody}</code>
            </pre>
          </details>
        </Notice>
      ) : null}
      {fields.origin === "import" ? (
        <Notice tone="info">
          Документ импортирован из Markdown. Метаданные, которые предложил сервер, нужно проверить: до ревью и merge
          это черновик, ассистент его не цитирует.
        </Notice>
      ) : null}
      {fields.origin === "ai_suggestion" ? (
        <Notice tone="info">
          Текст подготовлен ИИ-помощником. Это предложение, а не утверждённый документ: проверьте факты и источники,
          отредактируйте текст — дальше он пройдёт обычную проверку и ревью.
        </Notice>
      ) : null}

      <section className="panel authoring__meta" aria-labelledby="meta-title">
        <h2 id="meta-title">Метаданные</h2>
        <p className="muted authoring__meta-note">
          YAML-заголовок файла приложение сформирует само из этих полей. ID, статус, шаблон и происхождение выставляет
          сервер. Поля со звёздочкой обязательны.
        </p>
        <div className="authoring__grid">
          <div className="field">
            <label htmlFor="doc-title">
              Название <span aria-hidden="true">*</span>
            </label>
            <input
              id="doc-title"
              ref={titleRef}
              value={fields.title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              required
              aria-invalid={invalid(titleMessages)}
              aria-describedby={describedBy("doc-title", titleMessages)}
              placeholder="Например: Витрина клиентских метрик"
            />
            <FieldNotes id="doc-title" messages={titleMessages} />
          </div>
          <div className="field">
            <label htmlFor="doc-id">
              ID документа{idEditable ? <span aria-hidden="true"> *</span> : null}
            </label>
            {idEditable ? (
              <input
                id="doc-id"
                ref={idRef}
                className="field__mono"
                value={fields.id}
                onChange={(e) => setId(e.target.value)}
                maxLength={128}
                required
                spellCheck={false}
                autoComplete="off"
                aria-invalid={invalid(idMessages)}
                aria-describedby={describedBy("doc-id", idMessages)}
              />
            ) : (
              <input
                id="doc-id"
                ref={idRef}
                className="field__mono field__readonly"
                value={fields.id}
                readOnly
                placeholder="выделит сервер"
                aria-invalid={invalid(idMessages)}
                aria-describedby={describedBy("doc-id", idMessages)}
              />
            )}
            <FieldNotes id="doc-id" messages={idMessages} />
          </div>
          {template ? (
            <div className="field">
              <span className="field__label">Раздел каталога</span>
              <p className="field__static">
                {TYPE_LABEL[template.doc_type] ?? template.doc_type}
                <span className="muted"> · шаблон «{template.title}»</span>
              </p>
              <FieldNotes id="doc-type" messages={{ issues: typeIssues }} />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="doc-type">Раздел каталога</label>
              <SectionSelect
                id="doc-type"
                value={fields.type ?? blank?.default_type ?? "guide"}
                onChange={(value: DocType) => update("type", value)}
                describedBy={describedBy("doc-type", { hint: SECTION_HINT, issues: typeIssues })}
                invalid={typeIssues.some((i) => i.severity === "error")}
              />
              <FieldNotes id="doc-type" messages={{ hint: SECTION_HINT, issues: typeIssues }} />
            </div>
          )}
          <div className="field">
            <span className="field__label" id="doc-status-label">
              Статус
            </span>
            <p className="field__static" aria-labelledby="doc-status-label" aria-describedby={describedBy("doc-status", statusMessages)}>
              <StatusStamp status={fields.status} />
            </p>
            <FieldNotes id="doc-status" messages={statusMessages} />
          </div>
          <div className="field">
            <span className="field__label">Происхождение</span>
            <p className="field__static">
              {ORIGIN_LABEL[fields.origin] ?? fields.origin}
              <span className="muted">
                {" "}
                · {template ? `шаблон v${draft?.template_version ?? template.version ?? 1} закреплён` : "без шаблона"}
              </span>
            </p>
          </div>
          <div className="field">
            <span className="field__label" id="doc-template-label">
              Шаблон
            </span>
            <div className="field__row authoring__template-row">
              <p className="field__static" aria-labelledby="doc-template-label">
                {template ? `«${template.title}» v${draft?.template_version ?? template.version ?? 1}` : "не применён"}
              </p>
              <button
                type="button"
                className={buttonClass("secondary", "sm")}
                disabled={applyBlocker !== null || busy}
                aria-describedby="doc-template-hint"
                onClick={() => setApplyOpen(true)}
              >
                Применить шаблон
              </button>
            </div>
            <p id="doc-template-hint" className="field__hint">
              {applyBlocker ??
                (template
                  ? "Другой шаблон или новая версия этого — с предпросмотром изменений; текст сохраняется."
                  : "Шаблоны помогают структурировать текст, но не обязательны. Шаблон добавит недостающие разделы, ничего не удаляя.")}
            </p>
          </div>
          <div className="field">
            <label htmlFor="doc-owner">Владелец</label>
            <input
              id="doc-owner"
              ref={ownerRef}
              value={fields.owner}
              onChange={(e) => update("owner", e.target.value)}
              maxLength={100}
              placeholder="не указан — сохранится как unassigned"
              aria-invalid={invalid(ownerMessages)}
              aria-describedby={describedBy("doc-owner", ownerMessages)}
            />
            <FieldNotes id="doc-owner" messages={ownerMessages} />
          </div>
          <div className="field">
            <label htmlFor="doc-tags">Теги</label>
            <input
              id="doc-tags"
              value={fields.tags}
              onChange={(e) => update("tags", e.target.value)}
              maxLength={1000}
              aria-invalid={invalid(tagsMessages)}
              aria-describedby={describedBy("doc-tags", tagsMessages)}
            />
            <FieldNotes id="doc-tags" messages={tagsMessages} />
          </div>
          <div className="field">
            <label htmlFor="doc-related">Связанные документы</label>
            <input
              id="doc-related"
              className="field__mono"
              value={fields.relatedIds}
              onChange={(e) => update("relatedIds", e.target.value)}
              maxLength={3000}
              spellCheck={false}
              aria-invalid={invalid(relatedMessages)}
              aria-describedby={describedBy("doc-related", relatedMessages)}
              placeholder="SEM-ARCH-001, SEM-INT-002"
            />
            <FieldNotes id="doc-related" messages={relatedMessages} />
          </div>
          <div className="field field--wide">
            <label htmlFor="doc-summary">Описание</label>
            <textarea
              id="doc-summary"
              value={fields.summary}
              onChange={(e) => update("summary", e.target.value)}
              maxLength={1000}
              rows={2}
              aria-invalid={invalid(summaryMessages)}
              aria-describedby={describedBy("doc-summary", summaryMessages)}
              placeholder="Одно-два предложения: о чём документ"
            />
            <FieldNotes id="doc-summary" messages={summaryMessages} />
          </div>
          <div className="field field--wide">
            <label htmlFor="doc-reason">
              Причина / цель документа <span aria-hidden="true">*</span>
            </label>
            <input
              id="doc-reason"
              ref={reasonRef}
              value={fields.reason}
              onChange={(e) => update("reason", e.target.value)}
              maxLength={2000}
              required
              minLength={3}
              aria-invalid={invalid(reasonMessages)}
              aria-describedby={describedBy("doc-reason", reasonMessages)}
              placeholder="Зачем нужен документ"
            />
            <FieldNotes id="doc-reason" messages={reasonMessages} />
          </div>
        </div>
        <details
          className="authoring__advanced"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Дополнительно</summary>
          {!saved ? (
            <label className="checkbox authoring__manual-id">
              <input type="checkbox" checked={fields.manualId} onChange={(e) => setManualId(e.target.checked)} />
              <span>Задать ID вручную (например, при переносе документа с уже известным ID)</span>
            </label>
          ) : null}
          <div className="authoring__grid">
            <div className="field field--wide">
              <label htmlFor="doc-path">Путь в репозитории</label>
              <div className="field__row">
                <input
                  id="doc-path"
                  ref={pathRef}
                  className="field__mono"
                  value={fields.path}
                  onChange={(e) => setPath(e.target.value)}
                  maxLength={400}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={invalid(pathMessages)}
                  aria-describedby={describedBy("doc-path", pathMessages)}
                />
                {fields.pathEdited ? (
                  <button type="button" className="button button--ghost" onClick={followId}>
                    Следовать за ID
                  </button>
                ) : null}
              </div>
              <FieldNotes id="doc-path" messages={pathMessages} />
            </div>
            <div className="field field--wide">
              <label htmlFor="doc-sources">Источники</label>
              <input
                id="doc-sources"
                value={fields.sourceRefs}
                onChange={(e) => update("sourceRefs", e.target.value)}
                maxLength={5000}
                aria-invalid={invalid(sourcesMessages)}
                aria-describedby={describedBy("doc-sources", sourcesMessages)}
              />
              <FieldNotes id="doc-sources" messages={sourcesMessages} />
            </div>
          </div>
        </details>
      </section>

      {aiResult ? <AiSourcesPanel result={aiResult} /> : null}

      <section className="authoring__workspace" aria-labelledby="text-title">
        <div className="authoring__workspace-head">
          <h2 id="text-title">Текст документа</h2>
          <div className="view-toggle" role="group" aria-label="Показать">
            <button type="button" aria-pressed={view === "source"} onClick={() => setView("source")}>
              Текст
            </button>
            <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>
              Просмотр
            </button>
          </div>
        </div>
        <div className="authoring__panes" data-view={view}>
          <div className="authoring__source">
            <label htmlFor="doc-body">
              Текст в формате Markdown <span aria-hidden="true">*</span>
            </label>
            <MarkdownToolbar textareaRef={bodyRef} value={fields.body} onChange={(value) => update("body", value)} />
            <WikiLinkTextarea
              id="doc-body"
              textareaRef={bodyRef}
              className="editor__source authoring__textarea"
              value={fields.body}
              onValueChange={(value) => update("body", value)}
              spellCheck={false}
              rows={24}
              aria-invalid={invalid(bodyMessages)}
              aria-describedby={describedBy("doc-body", bodyMessages)}
            />
            <FieldNotes id="doc-body" messages={bodyMessages} />
          </div>
          <section className="authoring__preview" aria-labelledby="preview-label">
            <p className="authoring__pane-label" id="preview-label">
              Предпросмотр
              {checkKey && (!fresh || checking) && check ? <span className="muted"> · обновляется…</span> : null}
            </p>
            {check && check.result.preview_html ? (
              <SafeHtml html={check.result.preview_html} className="prose authoring__prose" />
            ) : (
              <p className="muted authoring__preview-empty">
                {missingAny
                  ? "Предпросмотр и проверка появятся, когда заполнены название и текст."
                  : "Готовим предпросмотр…"}
              </p>
            )}
          </section>
        </div>
        <details className="authoring__frontmatter">
          <summary>Что будет записано в файл</summary>
          {check && check.result.content ? (
            <>
              <p className="muted">
                Файл <code className="doc-id">{check.result.path}</code>. Заголовок YAML сформирован из полей формы — его
                не нужно редактировать вручную.
              </p>
              <pre className="raw-source">
                <code>{check.result.content}</code>
              </pre>
            </>
          ) : (
            <p className="muted">Появится после проверки.</p>
          )}
        </details>
      </section>

      {/* Without an AI provider the panel is not shown: the editor itself is the manual path. */}
      {session?.features.ai_mode === "disabled" ? null : (
        <DraftAiPanel
          draftId={saved?.id ?? null}
          dirty={dirty}
          locked={locked !== null}
          body={fields.body}
          bodyRef={bodyRef}
          hasTemplate={template !== null}
          onApplied={reloadSaved}
        />
      )}
      {applyOpen && saved ? (
        <ApplyTemplatePanel
          target={{ kind: "draft", id: saved.id }}
          currentTemplateId={template?.id ?? null}
          onClose={() => setApplyOpen(false)}
          onApplied={(detail) => {
            setApplyOpen(false);
            if (onTemplateApplied) onTemplateApplied(detail);
            else void reloadSaved();
          }}
        />
      ) : null}

      <section className="authoring__check" aria-labelledby="check-title">
        <h2 id="check-title">Проверка</h2>
        {checkError ? (
          <ErrorState error={checkError} title="Не удалось проверить документ" onRetry={onCheck} retryLabel="Проверить ещё раз" />
        ) : null}
        <div role="status" aria-live="polite" className="authoring__summary">
          {showSummary ? (
            missingAny ? (
              <p className="flag">Заполните обязательные поля: название и текст.</p>
            ) : pending === "check" || (checking && !fresh) ? (
              <p className="muted">Проверяем документ…</p>
            ) : check ? (
              errors.length > 0 ? (
                <p className="flag">
                  Ошибок: {errors.length}, предупреждений: {issues.length - errors.length}. Ошибки в полях отмечены рядом с
                  ними.
                </p>
              ) : (
                <p className="success">
                  Ошибок нет{issues.length > 0 ? `, предупреждений: ${issues.length}` : ""}. Документ можно отправить на
                  ревью.
                </p>
              )
            ) : null
          ) : null}
        </div>
        {generalIssues.some((i) => i.severity === "error") ? (
          <Notice tone="danger">
            <p>Ошибки:</p>
            <ul>
              {generalIssues
                .filter((i) => i.severity === "error")
                .map((issue) => (
                  <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
                ))}
            </ul>
          </Notice>
        ) : null}
        {generalIssues.some((i) => i.severity === "warning") ? (
          <Notice tone="warning">
            <p>Предупреждения:</p>
            <ul>
              {generalIssues
                .filter((i) => i.severity === "warning")
                .map((issue) => (
                  <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
                ))}
            </ul>
          </Notice>
        ) : null}
        {!showSummary && fresh && issues.length === 0 ? (
          <p className="validation-ok">Проверка метаданных и содержимого пройдена.</p>
        ) : null}
      </section>

      <section className="authoring__actions" aria-labelledby="authoring-actions-title">
        <h2 id="authoring-actions-title" className="visually-hidden">
          Действия с черновиком
        </h2>
        <p
          className={`save-state${dirty && !locked ? " save-state--dirty" : ""}${saved && !dirty && !locked && pending !== "save" ? " save-state--saved" : ""}`}
          role="status"
          aria-live="polite"
        >
          {saveState}
        </p>
        {actionError ? (
          <div className="stack authoring__error">
            <ErrorState
              error={actionError}
              title={errorTitle(actionError)}
              onRetry={actionError.code === "draft_modified" ? onReload : undefined}
              retryLabel="Загрузить сохранённую версию"
            />
            {TAKEN_CODES.has(actionError.code) ? (
              <p>Черновик не сохранён, но ваш текст остался в редакторе. Измените ID или путь и сохраните снова.</p>
            ) : null}
            {actionError.code === "draft_modified" ? (
              <p>Ваш текст не потерян: он остаётся в редакторе, пока вы не загрузите сохранённую версию.</p>
            ) : null}
          </div>
        ) : null}
        <div className="button-row">
          <button type="button" className="button button--primary" disabled={busy || locked !== null} onClick={onSave}>
            Сохранить черновик
          </button>
          <button type="button" className="button button--secondary" disabled={busy} onClick={onCheck}>
            Проверить
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy || submitBlocker !== null}
            aria-describedby="submit-review-hint"
            onClick={onSubmit}
          >
            Отправить на ревью
          </button>
          {saved && saved.canDelete && !confirmDelete ? (
            <button type="button" className="button button--danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Удалить черновик
            </button>
          ) : null}
          <Link to={cancelHref} className="button button--ghost">
            Отмена
          </Link>
        </div>
        <p id="submit-review-hint" className="muted">
          {submitBlocker ??
            "Черновик будет сохранён и отмечен «Готово к ревью». Документ появится в базе знаний только после merge в GitLab."}
        </p>
        {confirmDelete ? (
          <div className="reject-box" role="group" aria-labelledby="confirm-delete-text">
            <p id="confirm-delete-text">
              <strong>Удалить черновик безвозвратно?</strong> Текст и метаданные будут удалены. Документ в базе знаний не
              создавался.
            </p>
            <div className="button-row">
              <button type="button" className="button button--danger" disabled={busy} onClick={onDelete}>
                Удалить безвозвратно
              </button>
              <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Не удалять
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// --- AI actions on the draft ------------------------------------------------------------------------

interface DraftAiPanelProps {
  draftId: string | null;
  dirty: boolean;
  locked: boolean;
  body: string;
  bodyRef: { current: HTMLTextAreaElement | null };
  /** False for a blank document: the completeness check needs a template, so it is offered once one is applied. */
  hasTemplate: boolean;
  onApplied: () => Promise<void>;
}

/**
 * Contextual AI on a SAVED draft: metadata, related documents, completeness, improve a section, summarize,
 * explain the selection. Proposals refer to the saved version; an accepted proposal saves the draft on the
 * server (new version), after which the editor reloads it.
 */
function DraftAiPanel({ draftId, dirty, locked, body, bodyRef, hasTemplate, onApplied }: DraftAiPanelProps) {
  const state = useAiProposal((p) => {
    if (p.result_draft_id && p.result_draft_id === draftId) void onApplied();
  });
  const headings = sectionHeadings(body);
  const [section, setSection] = useState("");
  const chosen = headings.includes(section) ? section : (headings[0] ?? "");
  const id = draftId ?? "";
  const selection = () => {
    const el = bodyRef.current;
    return el ? el.value.slice(el.selectionStart, el.selectionEnd).trim() : "";
  };
  const actions: AiAction[] = [
    { key: "meta", label: "Предложить метаданные", build: () => ({ kind: "suggest_metadata", draft_id: id }) },
    { key: "related", label: "Найти связанные", build: () => ({ kind: "find_related", draft_id: id }) },
    ...(hasTemplate
      ? [{ key: "complete", label: "Проверить полноту", build: () => ({ kind: "check_completeness" as const, draft_id: id }) }]
      : []),
    {
      key: "improve",
      label: "Улучшить раздел",
      disabled: !chosen,
      hint: "В тексте нет разделов (## Заголовок).",
      build: () => (chosen ? { kind: "improve_section", draft_id: id, section: chosen } : null),
    },
    { key: "summarize", label: "Пересказать", build: () => ({ kind: "summarize", draft_id: id }) },
    {
      key: "explain",
      label: "Объяснить выделенное",
      hint: "Выделите фрагмент текста в редакторе, затем нажмите «Объяснить выделенное».",
      build: () => {
        const text = selection();
        return text.length >= 3 ? { kind: "explain", draft_id: id, selection: text.slice(0, 8000) } : null;
      },
    },
  ];
  let blocked: ReactNode = null;
  if (locked) blocked = "Черновик больше нельзя редактировать — предложения ИИ к нему не применяются.";
  else if (!draftId || dirty) {
    blocked = draftId
      ? "Есть несохранённые изменения. ИИ предлагает правки к сохранённой версии черновика — нажмите «Сохранить черновик»."
      : "ИИ работает с сохранённым черновиком: сначала нажмите «Сохранить черновик».";
  }
  return (
    <AiAssistPanel
      id="draft-ai"
      title="ИИ-помощник по черновику"
      state={state}
      actions={actions}
      blocked={blocked}
      intro={
        <p className="muted">
          Предложения с основаниями из утверждённых документов. Принимайте пункты по отдельности: принятые сохраняются в
          черновик (не в базу знаний), отклонённые ничего не меняют.
          {hasTemplate ? null : " Проверка полноты появится, когда к черновику применён шаблон."}
        </p>
      }
      controls={
        headings.length > 0 ? (
          <div className="field ai-assist__section">
            <label htmlFor="ai-section">Раздел для «Улучшить раздел»</label>
            <select id="ai-section" value={chosen} onChange={(e) => setSection(e.target.value)}>
              {headings.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        ) : null
      }
      appliedNote={() => (
        <Notice tone="success">
          Принятые пункты сохранены в черновик — редактор загрузил обновлённую версию. Отклонённые пункты ничего не
          изменили.
        </Notice>
      )}
    />
  );
}
