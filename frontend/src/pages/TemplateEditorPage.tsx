import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { AiProposal, StudioCheck, StudioIssue, StudioOptions, StudioState, TemplateSpec } from "../api/types";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { SafeHtml } from "../components/SafeHtml";
import { PageToolbar } from "../components/shell/PageToolbar";
import { ActivateTemplateDialog, type ActivationTarget } from "../components/studio/ActivateTemplateDialog";
import { describedBy, FieldIssues } from "../components/studio/FieldIssues";
import { SectionBuilder } from "../components/studio/SectionBuilder";
import { StudioHistory } from "../components/studio/StudioHistory";
import { TemplatePropertiesForm } from "../components/studio/TemplatePropertiesForm";
import { Button } from "../components/ui/Button";
import { useBeforeUnloadGuard } from "../components/UnsavedChangesGuard";
import { ACTIVATION_TEXT, formatDateTime, STUDIO_ERROR_TITLE, TEMPLATE_FIELD_LABEL } from "../lib/labels";
import { onTabListKeyDown } from "../lib/tabs";
import {
  controlId,
  issuesFor,
  renderBody,
  sameSpec,
  sectionsFromMarkdown,
  tabOfField,
  type StudioTab,
} from "../lib/templateSpec";
import { useAsync } from "../lib/useAsync";

const TABS: { id: StudioTab; label: string }[] = [
  { id: "properties", label: "Свойства" },
  { id: "structure", label: "Разделы" },
  { id: "markdown", label: "Markdown" },
  { id: "preview", label: "Предпросмотр" },
  { id: "history", label: "История" },
];

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

function issuesOf(error: ApiError): StudioIssue[] {
  const raw = error.details.issues;
  return Array.isArray(raw) ? (raw as StudioIssue[]) : [];
}

function sourceLine(state: StudioState | null): string {
  if (!state) return "новый шаблон";
  if (state.kind === "created") return "создан в студии шаблонов";
  if (state.kind === "adopted") return "из поставки, изменён в студии шаблонов";
  return "из поставки приложения";
}

interface EditorProps {
  options: StudioOptions;
  initialState: StudioState | null;
  initialSpec: TemplateSpec;
  proposal: AiProposal | null;
  initialNotice: string | null;
  onReload: () => void;
}

/** The editor itself, mounted once its data is loaded (the spec in state is the one source of truth). */
function StudioEditor({ options, initialState, initialSpec, proposal, initialNotice, onReload }: EditorProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [studio, setStudio] = useState<StudioState | null>(initialState);
  const [spec, setSpec] = useState<TemplateSpec>(initialSpec);
  const [saved, setSaved] = useState<TemplateSpec | null>(initialState ? initialSpec : null);
  const [check, setCheck] = useState<StudioCheck | null>(initialState?.draft?.check ?? null);
  const [issues, setIssues] = useState<StudioIssue[]>(initialState?.draft?.check.issues ?? []);
  const [checkedSpec, setCheckedSpec] = useState<string | null>(initialState?.draft ? JSON.stringify(initialSpec) : null);
  const [markdown, setMarkdown] = useState<{ text: string; problems: string[] } | null>(null);
  const requested = params.get("tab") as StudioTab | null;
  const [tab, setTab] = useState<StudioTab>(requested && TABS.some((t) => t.id === requested) ? requested : "properties");
  const [busy, setBusy] = useState<null | "check" | "save" | "discard" | "acknowledge">(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [activation, setActivation] = useState<ActivationTarget | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const previewSeq = useRef(0);

  const isNew = studio === null;
  const permissions = options.permissions;
  const canWrite = isNew ? permissions.create : permissions.edit;
  const readOnly = !canWrite;
  const dirty = isNew || !sameSpec(spec, saved);
  const unmapped = markdown !== null && markdown.problems.length > 0;
  const stale = checkedSpec !== null && checkedSpec !== JSON.stringify(spec);
  const draft = studio?.draft ?? null;
  const currentVersion = studio?.current_version ?? null;
  const fromAi = proposal !== null && isNew;

  // Leaving with unsaved edits asks first.
  useBeforeUnloadGuard(dirty && !readOnly);

  // A link in the issue summary: open the field's tab, then focus the field.
  useEffect(() => {
    if (!focusField) return;
    const target = document.getElementById(controlId(focusField)) ?? document.getElementById(controlId(focusField.split(".")[0] ?? ""));
    target?.focus();
    setFocusField(null);
  }, [focusField, tab]);

  // The preview is the server's: it renders the new document exactly as authoring will.
  useEffect(() => {
    if (tab !== "preview" || unmapped) return undefined;
    const seq = ++previewSeq.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .studioValidate(spec, studio?.template_id, { signal: controller.signal })
        .then((result) => {
          if (seq !== previewSeq.current) return;
          setCheck(result);
          setIssues(result.issues);
          setCheckedSpec(JSON.stringify(spec));
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [tab, spec, studio?.template_id, unmapped]);

  function change(next: Partial<TemplateSpec>) {
    setSpec((current) => ({ ...current, ...next }));
    if (next.sections) setMarkdown(null);
    setNotice(null);
  }

  function onMarkdown(text: string) {
    const parsed = sectionsFromMarkdown(text, spec.sections);
    setMarkdown({ text, problems: parsed.problems });
    if (parsed.problems.length === 0) setSpec((current) => ({ ...current, sections: parsed.sections }));
    setNotice(null);
  }

  function goTo(field: string) {
    setTab(tabOfField(field));
    setFocusField(field);
  }

  async function runCheck() {
    setBusy("check");
    setError(null);
    try {
      const result = await api.studioValidate(spec, studio?.template_id);
      setCheck(result);
      setIssues(result.issues);
      setCheckedSpec(JSON.stringify(spec));
      setNotice(result.valid ? "Проверка пройдена: ошибок нет." : null);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (unmapped || readOnly) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      if (isNew) {
        await api.studioCreate(spec, fromAi ? proposal.id : null);
        navigate(`/templates/${encodeURIComponent(spec.template_id)}/edit`, {
          replace: true,
          state: { notice: "Черновик шаблона сохранён. По нему ещё нельзя создавать документы — сначала «Активировать»." },
        });
        return;
      }
      const result = await api.studioSaveDraft(studio.template_id, spec, studio.revision);
      setStudio(result.state);
      setSaved(spec);
      setCheck(result.check);
      setIssues(result.check.issues);
      setCheckedSpec(JSON.stringify(spec));
      setNotice(
        result.check.valid
          ? `Черновик сохранён. ${ACTIVATION_TEXT[result.check.activation]?.(result.check.next_version) ?? ""}`
          : "Черновик сохранён, но в нём есть ошибки: активировать его можно после исправления.",
      );
    } catch (err) {
      const apiError = toApiError(err);
      setError(apiError);
      if (apiError.code === "template_invalid") setIssues(issuesOf(apiError));
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (!studio) return;
    setBusy("discard");
    setError(null);
    try {
      const state = await api.studioDiscardDraft(studio.template_id, studio.revision);
      if (state === null) {
        navigate("/templates", { replace: true });
        return;
      }
      setStudio(state);
      const current = state.current ?? spec;
      setSpec(current);
      setSaved(current);
      setMarkdown(null);
      setCheck(null);
      setIssues([]);
      setCheckedSpec(null);
      setConfirmDiscard(false);
      setNotice(`Черновик удалён. Действует v${state.current_version ?? "—"} без изменений.`);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function acknowledge() {
    if (!studio) return;
    setBusy("acknowledge");
    setError(null);
    try {
      const state = await api.studioAcknowledgeShipped(studio.template_id, studio.revision);
      setStudio(state);
      setNotice(`Оставлена действующая v${state.current_version}. Версия из поставки доступна в истории.`);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  function onActivated(state: StudioState, text: string) {
    setActivation(null);
    setStudio(state);
    const current = state.current ?? spec;
    setSpec(current);
    setSaved(current);
    setMarkdown(null);
    setCheck(null);
    setIssues([]);
    setCheckedSpec(null);
    setNotice(text);
  }

  const activateBlocked: string | null = isNew
    ? "Сначала сохраните черновик."
    : !permissions.activate
      ? "Нет права активировать шаблоны."
      : !draft
        ? "Нет сохранённого черновика: нечего активировать."
        : dirty
          ? "Есть несохранённые изменения: сначала сохраните черновик."
          : !draft.check.valid
            ? "В черновике есть ошибки: исправьте и сохраните."
            : draft.check.activation === "no_change"
              ? "Черновик не отличается от действующей версии."
              : null;
  const saveBlocked: string | null = readOnly
    ? isNew
      ? "Нет права создавать шаблоны."
      : "Нет права редактировать шаблоны."
    : unmapped
      ? "Markdown не сопоставлен с разделами: исправьте текст или верните его по конструктору."
      : !dirty
        ? "Изменений нет."
        : null;

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const tabCount = (id: StudioTab) => errors.filter((i) => tabOfField(i.field) === id).length;
  const outcome = check && !stale ? ACTIVATION_TEXT[check.activation]?.(check.next_version) : null;
  const title = isNew ? "Новый шаблон" : spec.title.trim() || studio.template_id;
  const visibleTabs = TABS.filter((t) => t.id !== "history" || !isNew);

  let panel: ReactNode = null;
  if (tab === "properties") {
    panel = <TemplatePropertiesForm spec={spec} onChange={change} issues={issues} options={options} idEditable={isNew} readOnly={readOnly} />;
  } else if (tab === "structure") {
    panel = (
      <>
        {unmapped ? (
          <Notice tone="warning">
            <p>
              <strong>Markdown не сопоставлен:</strong> {markdown.problems.join(" ")} Конструктор показывает последнюю
              сопоставленную структуру.
            </p>
            <Button size="sm" onClick={() => setMarkdown(null)}>
              Вернуть Markdown по конструктору
            </Button>
          </Notice>
        ) : null}
        <SectionBuilder
          sections={spec.sections}
          onChange={(sections) => change({ sections })}
          issues={issues}
          maxSections={options.max_sections}
          readOnly={readOnly || unmapped}
        />
      </>
    );
  } else if (tab === "markdown") {
    const markdownIssues = issuesFor(issues, "source");
    panel = (
      <div className="studio-markdown">
        <div className="field">
          <label htmlFor="tpl-markdown">Текст шаблона в Markdown</label>
          <textarea
            id="tpl-markdown"
            className="studio-markdown__text"
            rows={18}
            spellCheck={false}
            readOnly={readOnly}
            value={markdown?.text ?? renderBody(spec.sections)}
            onChange={(e) => onMarkdown(e.target.value)}
            aria-invalid={unmapped || undefined}
            aria-describedby={["tpl-markdown-hint", unmapped ? "tpl-markdown-problems" : "", describedBy(controlId("source"), markdownIssues) ?? ""]
              .filter(Boolean)
              .join(" ")}
          />
          <p id="tpl-markdown-hint" className="field__hint">
            Раздел — строка «## Название», подсказка — «&gt; Требует уточнения: …», дальше свободный текст. Обязательность
            задаётся в «Разделах»: раздел с тем же названием её сохраняет, новый — обязательный.
          </p>
          {unmapped ? (
            <p id="tpl-markdown-problems" className="field__issue field__issue--error" role="alert">
              {markdown.problems.join(" ")}
            </p>
          ) : null}
          <div id={controlId("source")} tabIndex={-1}>
            <FieldIssues id={controlId("source")} issues={markdownIssues} />
          </div>
        </div>
      </div>
    );
  } else if (tab === "preview") {
    panel = check ? (
      <div className="studio-preview">
        <p className="muted">
          Так выглядит новый документ по этому шаблону (ID <code className="doc-id">{check.preview.document_id}</code> — пример;
          настоящий выделит сервер). Обязательных разделов: {check.preview.sections.filter((s) => s.required).length} из{" "}
          {check.preview.sections.length}.
        </p>
        <div className="studio-preview__doc">
          <SafeHtml html={check.preview.html} className="prose" />
        </div>
        <details className="template-source">
          <summary>Файл нового документа (YAML и Markdown)</summary>
          <pre className="raw-source">
            <code>{check.preview.markdown}</code>
          </pre>
        </details>
        <details className="template-source">
          <summary>Исходный текст шаблона</summary>
          <pre className="raw-source">
            <code>{check.source}</code>
          </pre>
        </details>
      </div>
    ) : unmapped ? (
      <p className="muted">Предпросмотр появится, когда Markdown будет сопоставлен с разделами.</p>
    ) : (
      <Loading label="Готовим предпросмотр…" />
    );
  } else if (studio) {
    panel = (
      <StudioHistory
        key={studio.revision}
        state={studio}
        canActivate={permissions.activate}
        onActivateVersion={(version, shipped) => setActivation({ kind: "version", version, shipped })}
      />
    );
  }

  return (
    <article className="studio">
      <PageToolbar
        crumbs={[
          { label: "Шаблоны", to: "/templates" },
          ...(isNew ? [] : [{ label: spec.title.trim() || studio.template_id, to: `/templates/${encodeURIComponent(studio.template_id)}` }]),
          { label: isNew ? "Новый шаблон" : "Редактор" },
        ]}
        actionsInContentOnPhone
        actions={
          <>
            <Button onClick={() => void runCheck()} disabled={busy !== null || unmapped}>
              {busy === "check" ? "Проверяем…" : "Проверить"}
            </Button>
            {isNew ? null : (
              <Button
                onClick={() => draft && setActivation({ kind: "draft", check: draft.check })}
                disabled={activateBlocked !== null || busy !== null}
                aria-describedby={activateBlocked ? "studio-activate-why" : undefined}
              >
                Активировать
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={saveBlocked !== null || busy !== null}
              aria-describedby={saveBlocked ? "studio-save-why" : undefined}
            >
              {busy === "save" ? "Сохраняем…" : "Сохранить черновик"}
            </Button>
          </>
        }
      />
      <header className="studio__head">
        <h1>
          {title}{" "}
          {currentVersion ? <span className="version-badge version-badge--large">v{currentVersion}</span> : null}
        </h1>
        <p className="template-tile__line studio__status" aria-live="polite">
          {currentVersion ? (
            <span className="tpl-status tpl-status--active">действует v{currentVersion}</span>
          ) : (
            <span className="tpl-status tpl-status--draft">ещё не активирован</span>
          )}
          {draft ? (
            <span>
              черновик сохранил {draft.saved_by}, {formatDateTime(draft.saved_at)}
            </span>
          ) : null}
          {dirty && !readOnly ? <span className="studio__dirty">несохранённые изменения</span> : null}
          <span className="muted">{sourceLine(studio)}</span>
        </p>
        {outcome ? <p className="studio__outcome">{outcome}</p> : null}
        <p className="visually-hidden">
          {activateBlocked ? <span id="studio-activate-why">Активировать нельзя: {activateBlocked}</span> : null}
          {saveBlocked ? <span id="studio-save-why">Сохранить нельзя: {saveBlocked}</span> : null}
        </p>
        {activateBlocked && !isNew && permissions.activate && draft ? (
          <p className="muted studio__why">Активировать: {activateBlocked}</p>
        ) : null}
      </header>

      {readOnly ? (
        <Notice tone="info">
          <p>{saveBlocked} Шаблон открыт только для просмотра.</p>
        </Notice>
      ) : null}
      {fromAi ? (
        <Notice tone="info" className="studio__ai">
          <p>
            <strong>Предложение ИИ.</strong> Проверьте и отредактируйте: шаблон появится только после «Сохранить черновик», а
            действовать начнёт после отдельной активации.
          </p>
          {proposal.warnings.length > 0 ? (
            <ul>
              {proposal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {studio?.shipped_update ? (
        <Notice tone="warning">
          <p>
            В поставке приложения появилась версия <strong>v{studio.shipped_update}</strong>. Действует v{currentVersion} из
            студии; новая версия сама не включается. Сравните их во вкладке «История» и решите.
          </p>
          <div className="button-row">
            {permissions.activate ? (
              <Button size="sm" onClick={() => setActivation({ kind: "version", version: studio.shipped_update ?? 0, shipped: true })}>
                Активировать v{studio.shipped_update} из поставки
              </Button>
            ) : null}
            {permissions.edit ? (
              <Button size="sm" variant="quiet" onClick={() => void acknowledge()} disabled={busy !== null}>
                Оставить действующую v{currentVersion}
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success">
          <p role="status">{notice}</p>
        </Notice>
      ) : null}
      {error ? (
        <div className="studio__error">
          <ErrorState error={error} title={STUDIO_ERROR_TITLE[error.code]} />
          {error.code === "template_conflict" ? (
            <div className="button-row">
              <Button size="sm" onClick={onReload}>
                Загрузить сохранённое (мои правки пропадут)
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  if (!studio) return;
                  api
                    .studioState(studio.template_id)
                    .then((fresh) => {
                      setStudio(fresh);
                      setError(null);
                      setNotice(`Получена ревизия ${fresh.revision}. Ваши правки на месте — сохраните, чтобы записать их поверх.`);
                    })
                    .catch((err: unknown) => setError(toApiError(err)));
                }}
              >
                Оставить мои правки и сохранить поверх
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {issues.length > 0 ? (
        <Notice tone={errors.length > 0 ? "danger" : "warning"} className="studio__issues">
          <p>
            <strong>
              {errors.length > 0 ? `Ошибок: ${errors.length}` : "Ошибок нет"}
              {warnings.length > 0 ? ` · предупреждений: ${warnings.length}` : ""}
            </strong>
            {stale ? " — после проверки были правки: нажмите «Проверить» ещё раз." : null}
          </p>
          <ul className="studio__issue-list">
            {[...errors, ...warnings].map((issue) => (
              <li key={`${issue.field}-${issue.code}`}>
                <button type="button" className="button button--quiet button--sm" onClick={() => goTo(issue.field)}>
                  {TEMPLATE_FIELD_LABEL[issue.field.split(".")[0] ?? ""] ?? issue.field}
                  {issue.field.startsWith("sections.") ? ` №${Number(issue.field.split(".")[1]) + 1}` : ""}
                </button>
                : {issue.message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="tabs studio__tabs" role="tablist" aria-label="Разделы редактора" onKeyDown={onTabListKeyDown}>
        {visibleTabs.map((t) => {
          const count = tabCount(t.id);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`studio-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`studio-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => {
                setTab(t.id);
                if (t.id !== "markdown" && markdown && markdown.problems.length === 0) setMarkdown(null);
              }}
            >
              {t.label}
              {count > 0 ? <span className="studio__tab-count"> ({count})</span> : null}
              {t.id === "markdown" && unmapped ? <span className="studio__tab-count"> (!)</span> : null}
            </button>
          );
        })}
      </div>
      <section
        className="studio__panel"
        role="tabpanel"
        id={`studio-panel-${tab}`}
        aria-labelledby={`studio-tab-${tab}`}
        tabIndex={-1}
      >
        {panel}
      </section>

      {studio && draft && permissions.edit ? (
        <div className="studio__discard">
          {confirmDiscard ? (
            <p className="button-row">
              <span>
                {currentVersion
                  ? `Удалить черновик? Действующая v${currentVersion} останется без изменений.`
                  : "Удалить черновик? Шаблон ещё не активирован и исчезнет из каталога."}
              </span>
              <Button size="sm" variant="danger" onClick={() => void discard()} disabled={busy !== null}>
                Удалить черновик
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirmDiscard(false)}>
                Отмена
              </Button>
            </p>
          ) : (
            <Button size="sm" variant="quiet" onClick={() => setConfirmDiscard(true)}>
              Удалить черновик…
            </Button>
          )}
        </div>
      ) : null}

      {activation && studio ? (
        <ActivateTemplateDialog
          templateId={studio.template_id}
          revision={studio.revision}
          currentVersion={currentVersion}
          target={activation}
          onClose={() => setActivation(null)}
          onActivated={(result) =>
            onActivated(
              result.state,
              result.action === "info_updated"
                ? `Информационные поля v${result.version} обновлены. Новая версия не создавалась.`
                : `Действует v${result.version}. Новые документы создаются по ней; созданные раньше остаются на своей версии.`,
            )
          }
        />
      ) : null}
      {!isNew ? (
        <p className="studio__links">
          <Link to={`/templates/${encodeURIComponent(studio.template_id)}`} className="text-link">
            Открыть страницу шаблона
          </Link>
          {currentVersion && studio.current?.status === "active" ? (
            <>
              {" · "}
              <Link to={`/documents/new?template=${encodeURIComponent(studio.template_id)}`} className="text-link">
                Создать документ по v{currentVersion}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

/**
 * `/templates/new` (`?proposal=AIP-…` opens an AI proposal) and `/templates/:id/edit` — Template Studio. The registry
 * stays the only store of templates; a draft never affects documents until «Активировать» (docs/TEMPLATE_HUB.md).
 */
export function TemplateEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const proposalId = id ? null : params.get("proposal");
  const [nonce, setNonce] = useState(0);
  const options = useAsync(() => api.studioOptions(), "studio-options");
  const studio = useAsync<StudioState | null>(() => (id ? api.studioState(id) : Promise.resolve(null)), `studio-${id ?? "new"}-${nonce}`);
  const proposal = useAsync<AiProposal | null>(
    () => (proposalId ? api.aiProposal(proposalId) : Promise.resolve(null)),
    `studio-proposal-${proposalId ?? "none"}`,
  );
  const notice = (location.state as { notice?: string } | null)?.notice ?? null;

  const failure = options.error ?? studio.error ?? proposal.error;
  if (failure) {
    return (
      <div className="stack">
        <ErrorState error={failure} title={failure.status === 404 ? "Шаблон не найден" : STUDIO_ERROR_TITLE[failure.code]} page />
        <Link to="/templates" className="text-link">
          Все шаблоны
        </Link>
      </div>
    );
  }
  if (!options.data || studio.loading || proposal.loading || (id && !studio.data)) return <Loading label="Загрузка редактора шаблона…" />;

  const state = studio.data;
  const proposed = proposal.data?.items.find((i) => i.id === "template")?.proposed as TemplateSpec | undefined;
  const usableProposal = proposal.data && proposal.data.status === "suggested" && proposed ? proposal.data : null;
  const initialSpec: TemplateSpec | null = state
    ? (state.draft?.spec ?? state.current)
    : usableProposal && proposed
      ? proposed
      : options.data.defaults;
  if (!initialSpec) return <Loading label="Загрузка редактора шаблона…" />;
  return (
    <>
      {proposal.data && !usableProposal ? (
        <Notice tone="warning">
          <p>Предложение ИИ уже закрыто (статус «{proposal.data.status}»): начинаем с пустого шаблона.</p>
        </Notice>
      ) : null}
      <StudioEditor
        key={`${id ?? "new"}-${nonce}-${state?.revision ?? 0}`}
        options={options.data}
        initialState={state}
        initialSpec={initialSpec}
        proposal={usableProposal}
        initialNotice={notice}
        onReload={() => setNonce((n) => n + 1)}
      />
    </>
  );
}
