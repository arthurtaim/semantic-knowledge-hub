import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { DocType, DocumentTemplateInfo, ProposalDetail, TemplateApplyPreview, TemplateSectionMapping } from "../api/types";
import { AUTHORING_ERROR_TITLE, PROPOSAL_ERROR_TITLE, TYPE_LABEL } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { DiffView } from "./DiffView";
import { ErrorState, Loading, Notice } from "./Feedback";
import { SidePanel, useSidePanelMode } from "./shell/SidePanel";

/** What the template is applied to: a draft (updated after confirmation) or an indexed document (a proposal). */
export type ApplyTemplateTarget = { kind: "draft"; id: string } | { kind: "document"; id: string };

/** The base changed after the preview (or the template did): a fresh preview is the way out. */
const STALE_CODES = new Set(["draft_modified", "revision_conflict", "template_version_changed"]);

const SECTION_STATE_TEXT: Record<TemplateSectionMapping["state"], string> = {
  matched: "совпал с разделом шаблона",
  added: "добавится из шаблона с пометкой «Требует уточнения»",
  kept: "останется как есть — в шаблоне такого раздела нет",
  optional_missing: "необязательный раздел шаблона, не добавляется",
};

const SECTION_MARK: Record<TemplateSectionMapping["state"], string> = {
  matched: "✓",
  added: "+",
  kept: "•",
  optional_missing: "○",
};

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function typeLabel(type: DocType | null): string {
  return type ? (TYPE_LABEL[type] ?? type) : "не задан";
}

interface ApplyTemplatePanelProps {
  target: ApplyTemplateTarget;
  /** The template the draft or document has now (it is marked in the list). */
  currentTemplateId?: string | null;
  onClose: () => void;
  /** Called with the updated draft, or with the change proposal created for a document. */
  onApplied: (detail: ProposalDetail) => void;
}

/**
 * «Применить шаблон»: choose an ACTIVE template → see what changes (sections, section of the catalogue, a diff) →
 * confirm. A draft is updated in place; a document gets a change proposal and itself never changes here. All text is
 * kept: the template only adds skeletons of missing required sections and pins its current version.
 */
export function ApplyTemplatePanel({ target, currentTemplateId = null, onClose, onApplied }: ApplyTemplatePanelProps) {
  const mode = useSidePanelMode(true);
  const templates = useAsync(() => api.templates(), "apply-template-templates");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [preview, setPreview] = useState<TemplateApplyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const isDocument = target.kind === "document";

  useEffect(() => {
    if (!templateId) return;
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    setPreview(null);
    const request =
      target.kind === "draft" ? api.previewDraftTemplate(target.id, templateId) : api.previewDocumentTemplate(target.id, templateId);
    request
      .then((result) => {
        if (id === seq.current) setPreview(result);
      })
      .catch((err: unknown) => {
        if (id === seq.current) setError(toApiError(err));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [target.kind, target.id, templateId, attempt]);

  async function confirm() {
    if (!preview || pending) return;
    setPending(true);
    setError(null);
    try {
      const detail =
        target.kind === "draft"
          ? await api.applyDraftTemplate(target.id, {
              template_id: preview.template_id,
              template_version: preview.template_version,
              expected_version: preview.expected_version ?? 0,
            })
          : await api.applyDocumentTemplate(target.id, {
              template_id: preview.template_id,
              template_version: preview.template_version,
              base_revision: preview.base_revision ?? "",
            });
      onApplied(detail);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setPending(false);
    }
  }

  const list: DocumentTemplateInfo[] = templates.data ?? [];
  const chosen = list.find((t) => t.id === templateId) ?? null;
  const errors = preview?.validation.filter((i) => i.severity === "error") ?? [];
  const warnings = preview?.validation.filter((i) => i.severity === "warning") ?? [];
  const stale = error !== null && STALE_CODES.has(error.code);

  return (
    <SidePanel
      id="apply-template"
      title="Применить шаблон"
      mode={mode}
      onClose={onClose}
      className="apply-template"
      footer={
        <div className="button-row apply-template__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!preview || !preview.changed || loading || pending || stale}
            onClick={() => void confirm()}
          >
            {isDocument ? "Создать предложение изменения" : "Применить шаблон"}
          </button>
          <button type="button" className="button button--ghost" disabled={pending} onClick={onClose}>
            Отмена
          </button>
        </div>
      }
    >
      <p className="muted apply-template__intro">
        {isDocument
          ? "Документ не изменится: будет создано предложение изменения с этим шаблоном — оно пройдёт обычное ревью и merge."
          : "Изменится только этот черновик — после подтверждения."}{" "}
        Весь текст сохраняется: шаблон добавит недостающие обязательные разделы с пометкой «Требует уточнения» и
        закрепит свою текущую версию. ID документа не меняется.
      </p>

      {templates.loading && !templates.data ? <Loading label="Загрузка шаблонов…" /> : null}
      {templates.error ? <ErrorState error={templates.error} onRetry={templates.reload} /> : null}
      {templates.data && list.length === 0 ? <Notice tone="warning">Активных шаблонов нет.</Notice> : null}
      {list.length > 0 ? (
        <div className="field apply-template__chooser">
          <label htmlFor="apply-template-select">Шаблон</label>
          <select
            id="apply-template-select"
            value={templateId ?? ""}
            onChange={(event) => setTemplateId(event.target.value || null)}
            aria-describedby="apply-template-meta"
          >
            <option value="">Выберите шаблон…</option>
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} · v{t.version ?? 1}
                {t.id === currentTemplateId ? " (текущий)" : ""}
              </option>
            ))}
          </select>
          <p id="apply-template-meta" className="field__hint">
            {chosen
              ? `Раздел «${TYPE_LABEL[chosen.doc_type] ?? chosen.doc_type}» · обязательные разделы: ${chosen.sections.join(" · ")}`
              : "Только активные шаблоны: устаревшие и черновики шаблонов не применяются."}
          </p>
        </div>
      ) : null}

      <div aria-live="polite" className="apply-template__result">
        {loading ? <Loading label="Готовим предпросмотр…" /> : null}
        {error ? (
          <div className="stack">
            <ErrorState
              error={error}
              title={AUTHORING_ERROR_TITLE[error.code] ?? PROPOSAL_ERROR_TITLE[error.code]}
              onRetry={stale ? () => setAttempt((n) => n + 1) : undefined}
              retryLabel="Обновить предпросмотр"
            />
          </div>
        ) : null}
        {preview && !loading ? (
          <section aria-labelledby="apply-template-preview-title" className="apply-template__preview">
            <h3 id="apply-template-preview-title">Что изменится</h3>
            <ul className="apply-template__summary">
              <li>
                Шаблон «{preview.template_title}» v{preview.template_version} будет закреплён
                {preview.previous_template_id
                  ? ` вместо «${preview.previous_template_id}» v${preview.previous_template_version ?? "?"}`
                  : ""}
                .
              </li>
              <li>
                {preview.type_before === preview.type_after
                  ? `Раздел каталога не меняется: «${typeLabel(preview.type_after)}».`
                  : `Раздел каталога: «${typeLabel(preview.type_before)}» → «${typeLabel(preview.type_after)}».`}
              </li>
              <li>
                ID <code className="doc-id">{preview.document_id}</code> не меняется.
              </li>
            </ul>
            {!preview.changed ? <Notice tone="info">Шаблон уже применён: изменений нет.</Notice> : null}
            <h4>Разделы</h4>
            <ul className="apply-template__sections">
              {preview.sections.map((s) => (
                <li key={`${s.state}-${s.heading}`} className={`apply-template__section apply-template__section--${s.state}`}>
                  <span className="apply-template__mark" aria-hidden="true">
                    {SECTION_MARK[s.state]}
                  </span>
                  <span>
                    <strong>{s.heading}</strong> — {SECTION_STATE_TEXT[s.state]}
                  </span>
                </li>
              ))}
            </ul>
            {errors.length > 0 || warnings.length > 0 ? (
              <Notice tone={errors.length > 0 ? "danger" : "warning"}>
                <p>
                  Проверка результата: ошибок {errors.length}, предупреждений {warnings.length}.
                </p>
                <ul>
                  {[...errors, ...warnings].map((issue) => (
                    <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <h4>Изменения</h4>
            <DiffView diff={preview.diff} label="Изменения после применения шаблона" />
          </section>
        ) : null}
        {!templateId && list.length > 0 ? <p className="muted">Выберите шаблон — ниже появится предпросмотр изменений.</p> : null}
      </div>
    </SidePanel>
  );
}
