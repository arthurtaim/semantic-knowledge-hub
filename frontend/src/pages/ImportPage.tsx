import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { ImportPreview, MetadataField, NewDocumentMetadata } from "../api/types";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { SafeHtml } from "../components/SafeHtml";
import { PageToolbar } from "../components/shell/PageToolbar";
import { splitList } from "../lib/authoring";
import {
  AUTHORING_ERROR_TITLE,
  FIELD_ORIGIN_LABEL,
  IMPORT_STATE_LABEL,
  METADATA_FIELD_LABEL,
  PROPOSAL_ERROR_TITLE,
} from "../lib/labels";
import { newRequestId } from "../lib/requestId";
import { useAsync } from "../lib/useAsync";

/** Largest file the browser reads for an import (the server limit is about the same). */
const MAX_FILE_BYTES = 400_000;

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fieldOf(preview: ImportPreview, name: string): MetadataField | undefined {
  return preview.fields.find((f) => f.field === name);
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Human decisions on the suggested metadata of a file without (valid) YAML. */
interface Decisions {
  title: string;
  owner: string;
  tags: string;
  summary: string;
  keepSummary: boolean;
  related: Set<string>;
  templateId: string;
  reason: string;
}

function initialDecisions(preview: ImportPreview): Decisions {
  const summary = fieldOf(preview, "summary")?.value;
  const owner = fieldOf(preview, "owner");
  return {
    title: preview.title,
    owner: owner && owner.origin !== "missing" ? String(owner.value ?? "") : "",
    tags: listOf(fieldOf(preview, "tags")?.value).join(", "),
    summary: typeof summary === "string" ? summary : "",
    keepSummary: typeof summary === "string" && summary.length > 0,
    // Suggested related documents start unchecked: the author confirms each one.
    related: new Set<string>(),
    templateId: String(fieldOf(preview, "template")?.value ?? preview.templates[0]?.template_id ?? ""),
    reason: `Импорт документа «${preview.title}»`,
  };
}

function OriginBadge({ origin }: { origin: MetadataField["origin"] }) {
  return <span className={`origin-badge origin-badge--${origin}`}>{FIELD_ORIGIN_LABEL[origin] ?? origin}</span>;
}

// --- preview of one import --------------------------------------------------------------------------

function PreviewView({ preview, onCreated }: { preview: ImportPreview; onCreated: (draftId: string, templateId: string | null) => void }) {
  const [d, setD] = useState<Decisions>(() => initialDecisions(preview));
  // One idempotency key per preview: a double click returns the same draft, a new preview gets a new key.
  const [requestId] = useState(newRequestId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const keep = preview.state === "ready";
  const blocked = preview.state === "conflict";
  const related = fieldOf(preview, "related_ids");
  const relatedIds = listOf(related?.value);
  const evidence = new Map((related?.evidence ?? []).map((e) => [e.split(":")[0] ?? e, e.slice(e.indexOf(":") + 1).trim()]));
  const valid = d.reason.trim().length >= 3 && (keep || (d.title.trim().length > 0 && d.templateId));
  const set = <K extends keyof Decisions>(key: K, value: Decisions[K]) => setD((current) => ({ ...current, [key]: value }));

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!valid || pending || blocked) return;
    setPending(true);
    setError(null);
    try {
      const metadata: NewDocumentMetadata = {
        id: "",
        title: d.title.trim(),
        status: "draft",
        owner: d.owner.trim(),
        tags: splitList(d.tags),
        related_ids: relatedIds.filter((id) => d.related.has(id)),
        source_refs: [],
        summary: d.keepSummary && d.summary.trim() ? d.summary.trim().slice(0, 1000) : null,
      };
      const draft = await api.importDocument(
        keep
          ? { content: preview.content, keep_original_metadata: true, reason: d.reason.trim(), client_request_id: requestId }
          : {
              content: preview.content,
              keep_original_metadata: false,
              template_id: d.templateId,
              metadata,
              reason: d.reason.trim(),
              client_request_id: requestId,
            },
      );
      onCreated(draft.id, draft.template_id);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setPending(false);
    }
  }

  const tone = preview.state === "ready" ? "success" : preview.state === "conflict" ? "danger" : preview.state === "invalid_metadata" ? "warning" : "info";
  return (
    <section className="import-preview" aria-labelledby="import-preview-title">
      <h2 id="import-preview-title">Предпросмотр импорта: «{preview.title}»</h2>
      <Notice tone={tone}>
        <p>
          <strong>{IMPORT_STATE_LABEL[preview.state]}.</strong>{" "}
          {preview.state === "ready"
            ? `YAML файла корректен: метаданные и ID ${preview.document_id} сохранятся как есть. Статус в базе — только после ревью и merge.`
            : preview.state === "needs_metadata_review"
              ? "В тексте нет метаданных (YAML). Сервер выделит ID и предложил поля — проверьте их, примите нужные и укажите недостающие."
              : preview.state === "invalid_metadata"
                ? "YAML файла некорректен (см. замечания ниже). Исправьте его в тексте и повторите предпросмотр — или создайте черновик со сгенерированными метаданными: испорченный заголовок будет заменён."
                : `Документ ${preview.document_id} уже есть в базе знаний. Это изменение существующего документа: предложите его на странице документа.`}
        </p>
        {blocked ? (
          <Link to={`/documents/${encodeURIComponent(preview.document_id)}`} className="text-link">
            Открыть {preview.document_id}
          </Link>
        ) : null}
      </Notice>

      <div className="table-scroll">
        <table className="data-table import-fields">
          <caption className="visually-hidden">Поля метаданных и их происхождение</caption>
          <thead>
            <tr>
              <th scope="col">Поле</th>
              <th scope="col">Значение</th>
              <th scope="col">Происхождение</th>
              <th scope="col">Примечание</th>
            </tr>
          </thead>
          <tbody>
            {preview.fields.map((f) => (
              <tr key={f.field}>
                <th scope="row">{METADATA_FIELD_LABEL[f.field] ?? f.field}</th>
                <td className="import-fields__value">{valueText(f.value)}</td>
                <td>
                  <OriginBadge origin={f.origin} />
                </td>
                <td className="muted">{f.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.issues.length > 0 ? (
        <div className="import-issues">
          <h3>Замечания проверки</h3>
          <ul>
            {preview.issues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`} className={`field__issue field__issue--${issue.severity}`}>
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!blocked ? (
        <form className="import-decide panel" onSubmit={create} aria-labelledby="import-decide-title">
          <h3 id="import-decide-title">{keep ? "Создать черновик с метаданными файла" : "Проверьте и примите метаданные"}</h3>
          {keep ? (
            <p className="muted">ID, название, владелец и теги берутся из YAML файла без изменений.</p>
          ) : (
            <>
              <fieldset className="import-templates">
                <legend>Шаблон (тип документа)</legend>
                {preview.templates.length === 0 ? <p className="muted">Подходящий шаблон не распознан — выбран шаблон по умолчанию.</p> : null}
                {preview.templates.map((tpl) => (
                  <label key={tpl.template_id} className="import-template">
                    <input
                      type="radio"
                      name="import-template"
                      value={tpl.template_id}
                      checked={d.templateId === tpl.template_id}
                      onChange={() => set("templateId", tpl.template_id)}
                    />
                    <span>
                      <span className="import-template__title">
                        {tpl.title} <span className="version-badge">v{tpl.version}</span>
                      </span>
                      <span className="import-template__reasons">{tpl.reasons.join("; ")}</span>
                    </span>
                  </label>
                ))}
                {d.templateId && !preview.templates.some((tpl) => tpl.template_id === d.templateId) ? (
                  <p className="muted">Выбран шаблон по умолчанию: {d.templateId}.</p>
                ) : null}
              </fieldset>
              <div className="authoring__grid">
                <div className="field">
                  <label htmlFor="imp-title">
                    Название <span aria-hidden="true">*</span>
                  </label>
                  <input id="imp-title" value={d.title} onChange={(e) => set("title", e.target.value)} maxLength={300} required />
                </div>
                <div className="field">
                  <label htmlFor="imp-owner">Владелец</label>
                  <input
                    id="imp-owner"
                    value={d.owner}
                    onChange={(e) => set("owner", e.target.value)}
                    maxLength={100}
                    placeholder="не указан — сохранится как unassigned"
                    aria-describedby="imp-owner-hint"
                  />
                  <p id="imp-owner-hint" className="field__hint">
                    ИИ и сервер владельца не назначают: укажите его или оставьте пустым.
                  </p>
                </div>
                <div className="field field--wide">
                  <label htmlFor="imp-tags">Теги</label>
                  <input id="imp-tags" value={d.tags} onChange={(e) => set("tags", e.target.value)} maxLength={1000} aria-describedby="imp-tags-hint" />
                  <p id="imp-tags-hint" className="field__hint">
                    Предложены теги, уже принятые в базе. Через запятую; удалите лишние.
                  </p>
                </div>
                <div className="field field--wide">
                  <label className="checkbox">
                    <input type="checkbox" checked={d.keepSummary} onChange={(e) => set("keepSummary", e.target.checked)} />
                    <span>Принять описание (первый абзац текста)</span>
                  </label>
                  <textarea
                    aria-label="Описание"
                    value={d.summary}
                    onChange={(e) => set("summary", e.target.value)}
                    rows={2}
                    maxLength={1000}
                    disabled={!d.keepSummary}
                  />
                </div>
              </div>
              {relatedIds.length > 0 ? (
                <fieldset className="import-related">
                  <legend>Предложенные связанные документы — отметьте подтверждённые</legend>
                  {relatedIds.map((id) => (
                    <label key={id} className="checkbox import-related__item">
                      <input
                        type="checkbox"
                        checked={d.related.has(id)}
                        onChange={() =>
                          setD((current) => {
                            const next = new Set(current.related);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return { ...current, related: next };
                          })
                        }
                      />
                      <span>
                        <code className="doc-id">{id}</code>{" "}
                        <span className="suggested-badge">предложено</span>{" "}
                        <span className="muted">{evidence.get(id) ?? ""}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </>
          )}
          <div className="field field--wide">
            <label htmlFor="imp-reason">
              Причина / цель <span aria-hidden="true">*</span>
            </label>
            <input id="imp-reason" value={d.reason} onChange={(e) => set("reason", e.target.value)} maxLength={2000} required />
          </div>
          {error ? (
            <ErrorState error={error} title={AUTHORING_ERROR_TITLE[error.code] ?? PROPOSAL_ERROR_TITLE[error.code]} />
          ) : null}
          <div className="button-row">
            <button type="submit" className="button button--primary" disabled={!valid || pending}>
              {pending ? "Создаём черновик…" : "Создать черновик"}
            </button>
          </div>
          <p className="muted">
            Создаётся только черновик: в базу знаний документ попадёт после ревью и merge. До этого ассистент его не
            цитирует.
          </p>
        </form>
      ) : null}

      <section className="import-rendered" aria-labelledby="import-rendered-title">
        <h3 id="import-rendered-title">Как будет выглядеть текст</h3>
        <SafeHtml html={preview.preview_html} className="prose import-rendered__prose" />
      </section>
    </section>
  );
}

// --- the page ---------------------------------------------------------------------------------------

/**
 * `/documents/import`: Markdown without YAML (pasted, a local .md file, or a staged file of the knowledge root)
 * → server preview (system / parsed / suggested / missing fields, template suggestions, issues) → human choices
 * → a DRAFT. Nothing is uploaded except the text the author pasted or picked.
 */
export function ImportPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const staging = useAsync(() => api.importStaging(), "import-staging");

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setFileError(null);
    if (!file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      setFileError("Выберите файл Markdown (.md).");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError("Файл слишком большой для импорта (больше 400 КБ).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setContent(String(reader.result ?? ""));
      setFilename(file.name);
    };
    reader.onerror = () => setFileError("Не удалось прочитать файл.");
    reader.readAsText(file, "utf-8");
  }

  async function runPreview(request: { content?: string; path?: string; filename?: string }, label: string) {
    setPending(label);
    setError(null);
    try {
      const result = await api.importPreview(request);
      setPreview(result);
      setPreviewKey((k) => k + 1);
      requestAnimationFrame(() => document.getElementById("import-preview-title")?.scrollIntoView({ block: "start" }));
    } catch (err) {
      setError(toApiError(err));
      setPreview(null);
    } finally {
      setPending(null);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    void runPreview({ content, ...(filename ? { filename } : {}) }, "text");
  }

  return (
    <div className="import-page">
      <PageToolbar
        crumbs={[
          { label: "Документы", to: "/documents" },
          { label: "Новый документ", to: "/documents/new" },
          { label: "Импорт Markdown" },
        ]}
      />
      <div className="page-head">
        <h1>Импорт Markdown</h1>
        <p className="lead">
          Вставьте текст или выберите файл .md. Писать YAML не нужно: сервер выделит ID, предложит шаблон, теги и связи —
          вы примете нужное. Импорт создаёт только черновик; утверждённым документ станет после ревью и merge.
        </p>
      </div>

      <form className="panel import-source" onSubmit={onSubmit} aria-labelledby="import-source-title">
        <h2 id="import-source-title">Текст документа</h2>
        <div className="field">
          <label htmlFor="import-file">Файл Markdown</label>
          <input
            id="import-file"
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={onFile}
            aria-describedby="import-file-hint"
          />
          <p id="import-file-hint" className="field__hint">
            Файл читается в браузере; на сервер уходит только его текст.{filename ? ` Загружен: ${filename}.` : ""}
          </p>
          {fileError ? <p className="flag">{fileError}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="import-text">Или вставьте текст</label>
          <textarea
            id="import-text"
            className="editor__source import-source__text"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              if (!e.target.value) setFilename(null);
            }}
            rows={12}
            spellCheck={false}
            placeholder={"# Название документа\n\n## Назначение\nТекст…"}
          />
        </div>
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={!content.trim() || pending !== null}>
            {pending === "text" ? "Готовим предпросмотр…" : "Показать предпросмотр"}
          </button>
          <Link to="/documents/new" className="button button--ghost">
            Создать по шаблону
          </Link>
        </div>
      </form>

      <section className="import-staging" aria-labelledby="import-staging-title">
        <h2 id="import-staging-title">Файлы без метаданных в базе знаний</h2>
        <p className="muted">
          Файлы knowledge-репозитория без корректного YAML не индексируются и не цитируются, пока их метаданные не
          проверены.
        </p>
        {staging.loading && !staging.data ? <Loading label="Загрузка списка…" /> : null}
        {staging.error ? <ErrorState error={staging.error} onRetry={staging.reload} /> : null}
        {staging.data && staging.data.length === 0 ? (
          <EmptyState title="Таких файлов нет">
            <p>У всех файлов базы знаний есть метаданные.</p>
          </EmptyState>
        ) : null}
        {staging.data && staging.data.length > 0 ? (
          <ul className="staging-list">
            {staging.data.map((item) => (
              <li key={item.path} className="staging-item">
                <p>
                  <code className="doc-id">{item.path}</code>
                </p>
                <p className="muted">{item.message}</p>
                {item.readable ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={pending !== null}
                    onClick={() => void runPreview({ path: item.path }, item.path)}
                  >
                    {pending === item.path ? "Готовим…" : "Открыть предпросмотр"}
                  </button>
                ) : (
                  <p className="muted">Сервер не может прочитать этот файл: вставьте его текст в форму выше.</p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div aria-live="polite">
        {error ? <ErrorState error={error} title={AUTHORING_ERROR_TITLE[error.code] ?? "Не удалось подготовить предпросмотр"} /> : null}
      </div>
      {preview ? (
        <PreviewView
          key={previewKey}
          preview={preview}
          onCreated={(draftId, templateId) =>
            navigate(templateId ? `/documents/new?draft=${encodeURIComponent(draftId)}` : `/proposals/${encodeURIComponent(draftId)}`)
          }
        />
      ) : null}
    </div>
  );
}
