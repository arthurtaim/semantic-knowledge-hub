import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { StudioOptions, TemplateComparison, TemplateDetail } from "../api/types";
import { AiProposalCard, useAiProposal } from "../components/AiProposal";
import { AI_MODE_LABEL } from "../components/AiSourcesPanel";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { SafeHtml } from "../components/SafeHtml";
import { StatusStamp } from "../components/StatusStamp";
import { AI_ERROR_TITLE, AI_PROPOSAL_ERROR_TITLE, formatDate, METADATA_FIELD_LABEL, pluralRu, TYPE_LABEL } from "../lib/labels";
import { useSession } from "../lib/session";
import { useAsync } from "../lib/useAsync";
import { TemplateStatusBadge } from "./TemplatesPage";
import { When } from "../components/When";
import { PageToolbar } from "../components/shell/PageToolbar";
import { buttonClass } from "../components/ui/Button";
import { TemplateComparisonView } from "../components/studio/TemplateComparisonView";

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function currentVersionOf(t: TemplateDetail): number {
  return t.history.find((h) => h.active)?.version ?? Math.max(t.version, ...t.versions);
}

function fieldName(field: string): string {
  return METADATA_FIELD_LABEL[field] ? `${METADATA_FIELD_LABEL[field]} (${field})` : field;
}

function Block({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="template-block" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

// --- compare two versions ---------------------------------------------------------------------------

function CompareVersions({ template }: { template: TemplateDetail }) {
  const versions = [...template.versions].sort((a, b) => a - b);
  const latest = versions[versions.length - 1] ?? template.version;
  const [from, setFrom] = useState(versions.length > 1 ? (versions[versions.length - 2] ?? latest) : latest);
  const [to, setTo] = useState(latest);
  const [result, setResult] = useState<TemplateComparison | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  if (versions.length < 2) {
    return <p className="muted">У шаблона одна версия — сравнивать нечего.</p>;
  }

  async function compare(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      setResult(await api.templateCompare(template.id, from, to));
    } catch (err) {
      setError(toApiError(err));
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="compare" onSubmit={compare} aria-label="Сравнение версий шаблона">
      <div className="compare__controls">
        <div className="field">
          <label htmlFor="cmp-from">Версия «было»</label>
          <select id="cmp-from" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cmp-to">Версия «стало»</label>
          <select id="cmp-to" value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button--secondary" disabled={pending || from === to}>
          {pending ? "Сравниваем…" : "Сравнить"}
        </button>
      </div>
      {from === to ? <p className="muted">Выберите две разные версии.</p> : null}
      {error ? <ErrorState error={error} /> : null}
      {result ? <TemplateComparisonView result={result} /> : null}
    </form>
  );
}

// --- create with AI ---------------------------------------------------------------------------------

function CreateWithAi({ template, onClose }: { template: TemplateDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const session = useSession();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const state = useAiProposal((p) => {
    if (p.result_draft_id) navigate(`/documents/new?draft=${encodeURIComponent(p.result_draft_id)}`);
  });
  const busy = state.preparing !== null;
  const valid = prompt.trim().length >= 3;

  useEffect(() => promptRef.current?.focus(), []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    void state.run({
      kind: "draft_from_prompt",
      template_id: template.id,
      prompt: prompt.trim(),
      ...(title.trim() ? { title: title.trim() } : {}),
    });
  }

  return (
    <section className="panel template-ai" id="template-ai" aria-labelledby="template-ai-title">
      <h2 id="template-ai-title">Создать документ с ИИ по шаблону «{template.title}» v{template.version}</h2>
      <p className="ai-mode-line">
        <span className={`ai-mode ai-mode--${session?.features.ai_mode ?? "mock"}`}>
          {AI_MODE_LABEL[session?.features.ai_mode ?? "mock"] ?? session?.features.ai_mode}
        </span>
      </p>
      <p className="muted">
        ИИ читает этот шаблон из реестра, ищет сведения в утверждённых документах, доступных вам, и предлагает черновик с
        основаниями. Чего нет в источниках, останется помеченным «Требует уточнения». Черновик создаётся только после
        вашего подтверждения и проходит обычное ревью.
      </p>
      <form onSubmit={submit} className="template-ai__form">
        <div className="field">
          <label htmlFor="ai-doc-title">Название (необязательно)</label>
          <input id="ai-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
        </div>
        <div className="field">
          <label htmlFor="ai-doc-prompt">
            Что должно быть в документе <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="ai-doc-prompt"
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            maxLength={2000}
            required
            aria-describedby="ai-doc-prompt-hint"
          />
          <p id="ai-doc-prompt-hint" className="field__hint">
            Например: какие системы и данные участвуют, кто потребители, что нужно описать.
          </p>
        </div>
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={!valid || busy}>
            {busy ? "Готовим предложение…" : "Предложить черновик"}
          </button>
          {busy ? (
            <button type="button" className="button button--secondary" onClick={state.cancel}>
              Отменить
            </button>
          ) : null}
          <button type="button" className="button button--ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </form>
      {state.error ? (
        <ErrorState
          error={state.error}
          title={AI_PROPOSAL_ERROR_TITLE[state.error.code] ?? AI_ERROR_TITLE[state.error.code] ?? "Не удалось получить предложение ИИ"}
        />
      ) : null}
      {state.proposal ? (
        <AiProposalCard
          key={state.proposal.id}
          proposal={state.proposal}
          pending={state.decision}
          error={state.decisionError}
          onAccept={(ids) => void state.accept(ids)}
          onReject={() => void state.reject()}
          onRegenerate={state.regenerate}
          acceptLabel="Создать черновик"
          appliedNote={
            state.proposal.result_draft_id ? (
              <p>
                <Link to={`/documents/new?draft=${encodeURIComponent(state.proposal.result_draft_id)}`}>Открыть черновик</Link>
              </p>
            ) : null
          }
        />
      ) : null}
    </section>
  );
}

// --- the page ---------------------------------------------------------------------------------------

/** `/templates/:id` (`?version=N` for an older version): structure, fields, rules, guidance, example, history. */
export function TemplateDetailPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const session = useSession();
  const requested = Number(params.get("version")) || null;
  const { data, error, loading, reload } = useAsync(
    () => (requested ? api.templateVersion(id, requested) : api.templateDetail(id)),
    `${id}@${requested ?? "current"}`,
  );
  const [aiOpen, setAiOpen] = useState(false);
  // Template Studio rights; an older backend (or no right to view the studio) simply shows no «Редактировать».
  const studio = useAsync<StudioOptions | null>(() => api.studioOptions().catch(() => null), "studio-options");

  if (loading && !data) return <Loading label="Загрузка шаблона…" />;
  if (error) {
    return (
      <div className="stack">
        <ErrorState
          error={error}
          onRetry={error.status >= 500 || error.status === 0 ? reload : undefined}
          title={error.status === 404 ? "Шаблон не найден" : undefined}
          page
        />
        <Link to="/templates" className="text-link">
          Все шаблоны
        </Link>
      </div>
    );
  }
  if (!data) return null;
  const t = data;
  const current = currentVersionOf(t);
  const oldVersion = t.version !== current;
  const usable = t.status === "active" && t.listed && !oldVersion;
  const aiAvailable = session?.features.ai_authoring ?? false;
  const aiOff = session?.features.ai_mode === "disabled";
  const unusableReason = oldVersion
    ? `Это версия v${t.version}; новые документы создаются по актуальной v${current}.`
    : t.status === "deprecated"
      ? "Шаблон устарел: новые документы по нему не создаются. Старые документы и черновики открываются по своей версии."
      : t.status !== "active"
        ? `Шаблон в статусе «${t.status}»: новые документы по нему не создаются.`
        : !t.listed
          ? "Служебный шаблон: документы по нему создаются только импортом."
          : null;
  const drafts = Object.entries(t.my_open_drafts).filter(([, n]) => n > 0);
  const canEdit = (studio.data?.permissions.edit ?? false) && !oldVersion;
  const editHref = `/templates/${encodeURIComponent(t.id)}/edit`;

  return (
    <article className="template-detail">
      <PageToolbar
        crumbs={[{ label: "Шаблоны", to: "/templates" }, { label: t.title }]}
        actionsInContentOnPhone
        actions={
          <>
            <a href="#compare" className={buttonClass("quiet")}>
              Сравнить версии
            </a>
            {canEdit ? (
              <Link to={editHref} className={buttonClass("secondary")}>
                Редактировать
              </Link>
            ) : null}
            {aiOff ? null : (
              <button
                type="button"
                className={buttonClass("secondary")}
                disabled={!usable || !aiAvailable}
                aria-expanded={aiOpen}
                aria-controls={aiOpen ? "template-ai" : undefined}
                aria-describedby={!usable ? "template-unusable" : !aiAvailable ? "template-ai-off" : undefined}
                onClick={() => setAiOpen((open) => !open)}
              >
                Создать с ИИ
              </button>
            )}
            {usable ? (
              <Link to={`/documents/new?template=${encodeURIComponent(t.id)}`} className={buttonClass("primary")}>
                Использовать шаблон
              </Link>
            ) : (
              <button type="button" className={buttonClass("primary")} disabled aria-describedby="template-unusable">
                Использовать шаблон
              </button>
            )}
          </>
        }
      />
      <header className="template-detail__head">
        <h1>
          {t.title} <span className="version-badge version-badge--large">v{t.version}</span>
        </h1>
        <p className="template-tile__line">
          <TemplateStatusBadge status={t.status} />
          <span>{t.category}</span>
          {TYPE_LABEL[t.doc_type] && TYPE_LABEL[t.doc_type] !== t.category ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{TYPE_LABEL[t.doc_type]}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>владелец {t.owner}</span>
          <span aria-hidden="true">·</span>
          <span>
            обновлён <When value={t.updated} />
          </span>
        </p>
        <p className="lead">{t.description}</p>
        <p className="muted template-detail__ids">
          ID шаблона <code className="doc-id">{t.id}</code> · документы получают ID вида{" "}
          <code className="doc-id">{t.id_prefix}-NNN</code>
        </p>
        {unusableReason ? (
          <p id="template-unusable" className="flag template-detail__why">
            {unusableReason}
          </p>
        ) : null}
        {usable && !aiAvailable && !aiOff ? (
          <p id="template-ai-off" className="muted">
            ИИ-помощник отключён в этой установке.
          </p>
        ) : null}
      </header>

      {t.has_draft && !oldVersion ? (
        <Notice tone="info" className="template-detail__studio">
          <p>
            {t.status === "draft"
              ? "Шаблон ещё не активирован: документы по нему не создаются, пока его не активируют в редакторе."
              : `Есть неактивированный черновик изменений. Действует v${t.version}: черновик не влияет на документы.`}
          </p>
          {canEdit ? (
            <Link to={editHref} className="text-link">
              Открыть в редакторе
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {t.shipped_update && !oldVersion ? (
        <Notice tone="warning" className="template-detail__studio">
          <p>
            В поставке приложения появилась версия <strong>v{t.shipped_update}</strong> этого шаблона. Действует v{t.version}{" "}
            из студии шаблонов: новая версия сама не включается.
          </p>
          {canEdit ? (
            <Link to={`${editHref}?tab=history`} className="text-link">
              Решить в редакторе
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {oldVersion ? (
        <Notice tone="info">
          <p>
            Вы смотрите версию <strong>v{t.version}</strong>; актуальная — v{current}. Черновики, созданные по v{t.version},
            проверяются по ней.
          </p>
          <Link to={`/templates/${encodeURIComponent(t.id)}`} className="text-link">
            Открыть актуальную версию
          </Link>
        </Notice>
      ) : null}
      {t.breaking ? (
        <Notice tone="warning">
          <p>
            <strong>Версия v{t.version} несовместима с предыдущей.</strong> {t.changes}
          </p>
          {t.migration ? <p>Миграция: {t.migration}</p> : null}
        </Notice>
      ) : null}

      {aiOpen && usable ? <CreateWithAi template={t} onClose={() => setAiOpen(false)} /> : null}

      <div className="template-detail__layout">
        <div className="template-detail__main">
          <Block title="Структура документа" id="tpl-structure">
            <p className="muted">
              Разделов: {t.required_sections} {pluralRu(t.required_sections, "обязательный", "обязательных", "обязательных")}
              {t.optional_sections > 0 ? `, ${t.optional_sections} необязательных` : ""}. Порядок разделов — как в документе.
            </p>
            <ol className="template-structure">
              {t.sections.map((section) => (
                <li key={section.title} className={section.required ? "is-required" : "is-optional"}>
                  <p className="template-structure__head">
                    <span className="template-structure__title">{section.title}</span>
                    <span className={section.required ? "req-badge" : "opt-badge"}>
                      {section.required ? "обязательный" : "необязательный"}
                    </span>
                  </p>
                  {section.hint ? <p className="template-structure__hint">{section.hint}</p> : null}
                </li>
              ))}
            </ol>
          </Block>
          <Block title="Пример (синтетический)" id="tpl-example">
            {t.example_html ? (
              <div className="template-example">
                <SafeHtml html={t.example_html} className="prose" />
              </div>
            ) : (
              <p className="muted">Пример для этой версии не задан.</p>
            )}
          </Block>
          <Block title="Как заполнять" id="tpl-instructions">
            {t.instructions ? <p className="template-text">{t.instructions}</p> : <p className="muted">Указаний нет.</p>}
          </Block>
          <Block title="Указания для ИИ" id="tpl-ai">
            {t.ai_guidance ? <p className="template-text">{t.ai_guidance}</p> : <p className="muted">Указаний нет.</p>}
            <p className="muted">
              ИИ получает этот шаблон от сервера из того же реестра — с закреплённой версией, без собственной копии схемы.
            </p>
          </Block>
          <details className="template-source">
            <summary>Исходный текст шаблона (Markdown)</summary>
            <pre className="raw-source">
              <code>{t.skeleton}</code>
            </pre>
          </details>
          <Block title="Сравнить версии" id="compare">
            <CompareVersions template={t} />
          </Block>
        </div>

        <aside className="template-detail__side" aria-label="Поля, правила и использование">
          <Block title="Поля метаданных" id="tpl-fields">
            <ul className="field-list">
              {t.required_metadata.map((f) => (
                <li key={f}>
                  {fieldName(f)} <span className="req-badge">обязательное</span>
                </li>
              ))}
              {t.optional_metadata.map((f) => (
                <li key={f}>
                  {fieldName(f)} <span className="opt-badge">необязательное</span>
                </li>
              ))}
            </ul>
            <p className="muted">
              ID, статус «черновик», раздел ({TYPE_LABEL[t.doc_type] ?? t.doc_type}), шаблон и его версия выставляет сервер.
              {t.default_tags.length > 0 ? ` Теги по умолчанию: ${t.default_tags.join(", ")}.` : ""}
            </p>
          </Block>
          <Block title="Правила проверки" id="tpl-rules">
            {t.validation.length > 0 ? (
              <ul className="field-list">
                {t.validation.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Кроме обязательных разделов и полей, дополнительных правил нет.</p>
            )}
          </Block>
          <Block title="Где используется" id="tpl-usage">
            {t.used_by.length > 0 ? (
              <ul className="field-list">
                {t.used_by.map((u) => (
                  <li key={u.document_id}>
                    <Link to={`/documents/${encodeURIComponent(u.document_id)}`}>{u.title}</Link>{" "}
                    <code className="doc-id">{u.document_id}</code> <StatusStamp status={u.status} />{" "}
                    <span className="version-badge">v{u.template_version ?? 1}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Среди доступных вам документов по этому шаблону пока ничего нет.</p>
            )}
            <p className="template-drafts">
              Мои открытые черновики:{" "}
              {drafts.length > 0 ? drafts.map(([v, n]) => `${v} — ${n}`).join(", ") : <span className="muted">нет</span>}
            </p>
          </Block>
          <Block title="История версий" id="tpl-history">
            <ol className="template-history" reversed>
              {[...t.history]
                .sort((a, b) => b.version - a.version)
                .map((row) => (
                  <li key={row.version} className={row.version === t.version ? "is-current" : undefined}>
                    <p className="template-history__head">
                      <strong>v{row.version}</strong>
                      {row.active ? <span className="tpl-status tpl-status--active">актуальная</span> : null}
                      {row.status !== "active" ? <TemplateStatusBadge status={row.status} /> : null}
                      {row.breaking ? <span className="breaking-badge">несовместимая</span> : null}
                      <span className="muted">с {formatDate(row.first_seen)}</span>
                    </p>
                    {row.changes ? <p>{row.changes}</p> : null}
                    {row.version !== t.version ? (
                      <Link
                        to={
                          row.active
                            ? `/templates/${encodeURIComponent(t.id)}`
                            : `/templates/${encodeURIComponent(t.id)}?version=${row.version}`
                        }
                        className="text-link"
                      >
                        Открыть v{row.version}
                      </Link>
                    ) : (
                      <span className="muted">открыта сейчас</span>
                    )}
                  </li>
                ))}
            </ol>
          </Block>
        </aside>
      </div>
    </article>
  );
}
