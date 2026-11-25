import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type {
  AssigneeRef,
  DocStatus,
  LinkSuggestion,
  ProposalTaskEdit,
  ProposedTask,
  TaskPriority,
  WorkProject,
  WorkProposal,
  WorkProposalApplyResult,
  WorkProposalEdits,
} from "../../api/types";
import { STATUS_LABEL } from "../../lib/labels";
import { newRequestId } from "../../lib/requestId";
import { toApiError } from "../../lib/useWorkspace";
import { formatPlan, PRIORITY_LABEL, PRIORITY_ORDER, pluralWorkdays } from "../../lib/work";
import { ErrorState, Notice } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { StatusStamp } from "../StatusStamp";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { AssigneeOptions } from "./WorkBits";

/*
 * «План с ассистентом» (was «AI план»; M6 Step 5, docs/WORK_MANAGEMENT.md §11): a typed task-plan PROPOSAL from documents of the knowledge base.
 *
 * 1. The request: what is needed, which documents (search by ID or title; without any the server picks approved
 *    documents), an optional planned start. The model only proposes; nothing is created.
 * 2. The review — a separate, checkable entity: sources (id, revision, status — a draft is said to be a draft),
 *    assumptions, validation issues (what the server dropped: an assignee, dates, an invented source, a quote it
 *    could not find), every proposed task (keep / drop, title, priority, estimate, assignee chosen by a person),
 *    the FS dependencies (keep / drop) and the dates the SERVER computed from the chosen start.
 * 3. «Создать задачи» applies the reviewed plan in one server transaction; «Отклонить» closes it. A stale proposal
 *    (the plan or a source changed, or it expired) cannot be applied — «Подготовить заново».
 * The open proposal lives in the URL (`?proposal=WAP-…`), so a reload or a sent link returns to the review.
 */

const STALE_LABEL: Record<string, string> = {
  plan_changed: "план проекта изменился после подготовки",
  source_changed: "документ-источник изменился",
  source_unavailable: "документ-источник недоступен (удалён или нет доступа)",
  expired: "истёк срок действия предложения",
  knowledge_unavailable: "база знаний сейчас недоступна — источники не проверить",
};

interface WorkPlanSheetProps {
  project: WorkProject;
  assignees: AssigneeRef[];
  canWrite: boolean;
  proposalId: string | null;
  onProposal: (id: string | null) => void;
  onClose: () => void;
  onApplied: (result: WorkProposalApplyResult) => void;
}

export function WorkPlanSheet({ project, assignees, canWrite, proposalId, onProposal, onClose, onApplied }: WorkPlanSheetProps) {
  const mode = useSidePanelMode(true);
  return (
    <SidePanel id="work-plan" title={proposalId ? "Предложение AI: план задач" : "План с ассистентом"} mode={mode} onClose={onClose} className="work-form work-plan">
      {proposalId ? (
        <ProposalReview
          key={proposalId}
          project={project}
          proposalId={proposalId}
          assignees={assignees}
          canWrite={canWrite}
          onProposal={onProposal}
          onApplied={onApplied}
          onClose={onClose}
        />
      ) : (
        <PlanRequest project={project} onProposal={onProposal} onClose={onClose} />
      )}
    </SidePanel>
  );
}

// --- 1. the request ------------------------------------------------------------------------------------------------

function PlanRequest({ project, onProposal, onClose }: { project: WorkProject; onProposal: (id: string) => void; onClose: () => void }) {
  const id = useId();
  const [request, setRequest] = useState("");
  const [docs, setDocs] = useState<LinkSuggestion[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<LinkSuggestion[]>([]);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setFound([]);
      return undefined;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .linkSuggest(q, 8, { signal: abort.signal })
        .then(setFound)
        .catch(() => undefined);
    }, 200);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [query]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (request.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const proposal = await api.workCreateProposal({
        project_id: project.id,
        request: request.trim(),
        document_ids: docs.map((d) => d.document_id),
        start_date: start || null,
      });
      onProposal(proposal.id);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="work-form__fields work-plan__request" onSubmit={(e) => void submit(e)} aria-label="Запрос AI плана">
      <Notice tone="info">AI только предложит задачи по документам базы знаний. Ничего не будет создано, пока вы не проверите предложение и не нажмёте «Создать задачи».</Notice>
      <div className="field">
        <label htmlFor={`${id}-request`}>
          Что нужно сделать <span aria-hidden="true">*</span>
        </label>
        <textarea
          id={`${id}-request`}
          value={request}
          rows={4}
          maxLength={2000}
          required
          placeholder="Например: по спецификации интеграции подготовь задачи на 4 недели"
          onChange={(e) => setRequest(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-docs`}>Документы-источники</label>
        {docs.length ? (
          <ul className="work-plan__chosen" aria-label="Выбранные документы">
            {docs.map((d) => (
              <li key={d.document_id}>
                <span className="task-mini-list__key">{d.document_id}</span> {d.title} <StatusStamp status={d.status} />
                <button type="button" className="link-button" aria-label={`Убрать ${d.document_id}`} onClick={() => setDocs(docs.filter((x) => x.document_id !== d.document_id))}>
                  Убрать
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {docs.length < 5 ? (
          <>
            <input id={`${id}-docs`} type="search" value={query} maxLength={120} autoComplete="off" placeholder="ID или название документа" onChange={(e) => setQuery(e.target.value)} />
            {found.length ? (
              <ul className="task-docs__found" aria-label="Найденные документы">
                {found
                  .filter((s) => !docs.some((d) => d.document_id === s.document_id))
                  .map((s) => (
                    <li key={s.document_id}>
                      <button
                        type="button"
                        className="task-docs__pick"
                        onClick={() => {
                          setDocs([...docs, s]);
                          setQuery("");
                        }}
                      >
                        <span className="task-mini-list__key">{s.document_id}</span> {s.title} <StatusStamp status={s.status} />
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
          </>
        ) : null}
        <p className="field__hint">До пяти документов. Без выбора сервер возьмёт утверждённые документы, найденные по запросу.</p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-start`}>Плановое начало</label>
        <input id={`${id}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-describedby={`${id}-start-hint`} />
        <p className="field__hint" id={`${id}-start-hint`}>
          Даты рассчитает сервер по оценкам и зависимостям (Пн–Пт). Без начала задачи будут без дат.
        </p>
      </div>
      {error ? <ProposalError error={error} /> : null}
      <div className="button-row">
        <Button variant="primary" type="submit" icon="assistant" className="button--with-icon" disabled={busy || request.trim().length < 3}>
          {busy ? "AI готовит предложение…" : "Подготовить предложение"}
        </Button>
        <Button onClick={onClose}>Отмена</Button>
      </div>
      {busy ? (
        <p className="muted" role="status">
          Модель читает документы и составляет план — это может занять до минуты.
        </p>
      ) : null}
    </form>
  );
}

function ProposalError({ error }: { error: ApiError }) {
  if (error.code === "proposal_invalid") {
    const cycle = Array.isArray(error.details.cycle) ? (error.details.cycle as string[]).join(" → ") : null;
    return (
      <Notice tone="danger">
        Сервер отклонил план модели: {error.message}
        {cycle ? ` (${cycle})` : ""} Ничего не сохранено — попробуйте уточнить запрос.
      </Notice>
    );
  }
  if (error.code === "feature_unavailable" || error.code.startsWith("ai_")) {
    return <Notice tone="warning">{error.message}</Notice>;
  }
  return <ErrorState error={error} />;
}

// --- 2. the review --------------------------------------------------------------------------------------------------

interface ReviewProps {
  project: WorkProject;
  proposalId: string;
  assignees: AssigneeRef[];
  canWrite: boolean;
  onProposal: (id: string | null) => void;
  onApplied: (result: WorkProposalApplyResult) => void;
  onClose: () => void;
}

type Edit = Omit<ProposalTaskEdit, "local_id">;

function ProposalReview({ project, proposalId, assignees, canWrite, onProposal, onApplied, onClose }: ReviewProps) {
  const id = useId();
  const [proposal, setProposal] = useState<WorkProposal | null>(null);
  const [shown, setShown] = useState<WorkProposal | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [start, setStart] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "reject" | "again" | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const confirmation = useRef(newRequestId());

  const load = useCallback(() => {
    api
      .workProposal(proposalId)
      .then((p) => {
        setProposal(p);
        setShown(p);
        setStart(p.start_date);
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(toApiError(err)));
  }, [proposalId]);

  useEffect(load, [load]);

  const body = useMemo((): WorkProposalEdits => {
    const tasks = Object.entries(edits).map(([local_id, edit]) => ({ local_id, ...edit }));
    const excluded = [...dropped].map((pair) => {
      const [predecessor = "", successor = ""] = pair.split("→");
      return { predecessor, successor };
    });
    return { tasks, excluded_dependencies: excluded, start_date: start };
  }, [edits, dropped, start]);

  if (loadError) {
    return loadError.status === 404 ? (
      <Notice tone="warning">Предложение не найдено (оно личное и видно только тому, кто его подготовил).</Notice>
    ) : (
      <ErrorState error={loadError} onRetry={load} />
    );
  }
  if (!proposal || !shown) return <p className="muted">Загружаем предложение…</p>;

  const titleOf = (local: string) => shown.tasks.find((t) => t.local_id === local)?.title ?? local;
  const setEdit = (local: string, change: Edit) => setEdits((current) => ({ ...current, [local]: { ...current[local], ...change } }));
  const included = (task: ProposedTask) => edits[task.local_id]?.include ?? task.included;
  const chosen = shown.tasks.filter(included);
  const decided = proposal.status !== "suggested";
  const ready = proposal.state === "ready";

  async function preview() {
    setBusy("preview");
    setProblem(null);
    try {
      setShown(await api.workPreviewProposal(proposalId, body));
    } catch (err) {
      setProblem(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function applyPlan() {
    if (!proposal) return;
    setBusy("apply");
    setProblem(null);
    try {
      const result = await api.workApplyProposal(proposalId, {
        ...body,
        expected_plan_revision: proposal.base_plan_revision,
        client_request_id: confirmation.current,
      });
      onApplied(result);
    } catch (err) {
      const e = toApiError(err);
      setProblem(e);
      if (e.code === "proposal_stale") load();
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setProblem(null);
    try {
      const p = await api.workRejectProposal(proposalId);
      setProposal(p);
      setShown(p);
    } catch (err) {
      setProblem(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function again() {
    if (!proposal) return;
    setBusy("again");
    setProblem(null);
    try {
      const next = await api.workCreateProposal({
        project_id: project.id,
        request: proposal.request,
        document_ids: proposal.sources.map((s) => s.document_id).filter((d): d is string => Boolean(d)),
        start_date: start,
      });
      onProposal(next.id);
    } catch (err) {
      setProblem(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  const warnings = shown.issues.filter((i) => i.severity === "warning");
  const infos = shown.issues.filter((i) => i.severity === "info");
  return (
    <div className="work-plan__review" data-proposal-id={proposal.id} data-proposal-state={proposal.state}>
      {decided ? (
        <Notice tone={proposal.status === "applied" ? "success" : "info"}>
          {proposal.status === "applied" ? (
            <>
              Предложение применено: создано задач — {proposal.applied_task_keys.length}.{" "}
              {proposal.applied_task_keys.map((key) => (
                <Link key={key} to={`/tasks/${encodeURIComponent(key)}`} className="work-plan__key">
                  {key}
                </Link>
              ))}
            </>
          ) : (
            "Предложение отклонено: задачи не создавались."
          )}
        </Notice>
      ) : ready ? (
        <Notice tone="info">Это предложение AI. Ничего не создано, пока вы не нажмёте «Создать задачи». Исполнителей AI не назначает, даты рассчитывает сервер.</Notice>
      ) : (
        <Notice tone="warning">
          Предложение устарело: {proposal.stale_reasons.map((r) => STALE_LABEL[r] ?? r).join("; ")}. Применить его нельзя — подготовьте заново.{" "}
          {canWrite ? (
            <Button size="sm" onClick={() => void again()} disabled={busy !== null}>
              {busy === "again" ? "Готовим…" : "Подготовить заново"}
            </Button>
          ) : null}
        </Notice>
      )}

      <section className="work-plan__block" aria-labelledby={`${id}-req`}>
        <h3 className="task-section__title" id={`${id}-req`}>
          Запрос
        </h3>
        <p className="work-plan__request-text">{proposal.request}</p>
        {proposal.goal ? <p className="muted">Цель по версии модели: {proposal.goal}</p> : null}
        <p className="muted work-plan__meta">
          Провайдер: {proposal.provider} · схема {proposal.schema_version} · ревизия плана {proposal.base_plan_revision}
          {proposal.parent_task_key ? ` · под задачей ${proposal.parent_task_key}` : ""}
        </p>
      </section>

      <section className="work-plan__block" aria-labelledby={`${id}-src`}>
        <h3 className="task-section__title" id={`${id}-src`}>
          Источники <span className="task-section__count">{proposal.sources.length}</span>
        </h3>
        <ul className="task-docs">
          {proposal.sources.map((s, index) => (
            <li key={s.document_id ?? `hidden-${index}`} className="task-doc" data-source-state={s.state}>
              {s.document_id ? (
                <span className="task-doc__main">
                  <Link to={`/documents/${encodeURIComponent(s.document_id)}`} className="task-doc__link">
                    <span className="task-mini-list__key">{s.document_id}</span> {s.title}
                  </Link>
                  {s.status ? <StatusStamp status={s.status as DocStatus} /> : null}
                  {s.status && s.status !== "approved" ? (
                    <span className="task-doc__state muted">Не утверждён ({(STATUS_LABEL[s.status as DocStatus] ?? s.status).toLowerCase()}) — не авторитетный источник.</span>
                  ) : null}
                  {s.state === "revision_changed" ? <span className="task-doc__state task-doc__state--changed">Документ изменился после подготовки предложения.</span> : null}
                </span>
              ) : (
                <span className="task-doc__main task-doc__unavailable">
                  <Icon name="alert" size={14} />
                  Документ недоступен — удалён или нет доступа
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {proposal.assumptions.length ? (
        <section className="work-plan__block" aria-labelledby={`${id}-ass`}>
          <h3 className="task-section__title" id={`${id}-ass`}>
            Допущения модели
          </h3>
          <ul className="work-plan__list">
            {proposal.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {warnings.length || infos.length ? (
        <section className="work-plan__block" aria-labelledby={`${id}-iss`}>
          <h3 className="task-section__title" id={`${id}-iss`}>
            Проверка сервера <span className="task-section__count">{shown.issues.length}</span>
          </h3>
          <ul className="work-plan__list work-plan__issues">
            {[...warnings, ...infos].map((i, index) => (
              <li key={`${i.code}-${i.local_id ?? ""}-${index}`} className={`work-plan__issue work-plan__issue--${i.severity}`} data-issue={i.code}>
                <Icon name={i.severity === "warning" ? "alert" : "info"} size={12} />
                {i.local_id ? <strong>{titleOf(i.local_id)}: </strong> : null}
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="work-plan__block" aria-labelledby={`${id}-tasks`}>
        <h3 className="task-section__title" id={`${id}-tasks`}>
          Задачи <span className="task-section__count">{chosen.length} из {shown.tasks.length}</span>
        </h3>
        {!decided ? (
          <div className="work-plan__start">
            <div className="field">
              <label htmlFor={`${id}-start`}>Плановое начало</label>
              <input id={`${id}-start`} type="date" value={start ?? ""} disabled={!canWrite || !ready} onChange={(e) => setStart(e.target.value || null)} />
            </div>
            <Button size="sm" onClick={() => void preview()} disabled={busy !== null || !ready}>
              {busy === "preview" ? "Считаем…" : "Пересчитать сроки"}
            </Button>
          </div>
        ) : null}
        <ol className="plan-tasks">
          {shown.tasks.map((task) => (
            <PlanTaskRow
              key={task.local_id}
              task={task}
              edit={edits[task.local_id] ?? {}}
              included={included(task)}
              editable={canWrite && ready}
              assignees={assignees}
              parentTitle={task.parent_local_id ? titleOf(task.parent_local_id) : null}
              onEdit={(change) => setEdit(task.local_id, change)}
            />
          ))}
        </ol>
      </section>

      {shown.dependencies.length ? (
        <section className="work-plan__block" aria-labelledby={`${id}-deps`}>
          <h3 className="task-section__title" id={`${id}-deps`}>
            Зависимости <span className="muted task-section__hint">окончание → начало</span>
          </h3>
          <ul className="work-plan__list work-plan__list--checks">
            {shown.dependencies.map((d) => {
              const pair = `${d.predecessor}→${d.successor}`;
              const label = `${titleOf(d.predecessor)} → ${titleOf(d.successor)}`;
              return (
                <li key={pair}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={!dropped.has(pair)}
                      disabled={!canWrite || !ready}
                      onChange={(e) => {
                        const next = new Set(dropped);
                        if (e.target.checked) next.delete(pair);
                        else next.add(pair);
                        setDropped(next);
                      }}
                    />
                    {label}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {problem ? <ProposalError error={problem} /> : null}
      <div className="button-row work-plan__actions">
        {canWrite && !decided ? (
          <>
            <Button variant="primary" onClick={() => void applyPlan()} disabled={busy !== null || !proposal.can_apply || chosen.length === 0}>
              {busy === "apply" ? "Создаём…" : `Создать задачи (${chosen.length})`}
            </Button>
            <Button onClick={() => void reject()} disabled={busy !== null}>
              Отклонить
            </Button>
          </>
        ) : null}
        <Button variant="quiet" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </div>
  );
}

function PlanTaskRow({
  task,
  edit,
  included,
  editable,
  assignees,
  parentTitle,
  onEdit,
}: {
  task: ProposedTask;
  edit: Edit;
  included: boolean;
  editable: boolean;
  assignees: AssigneeRef[];
  parentTitle: string | null;
  onEdit: (change: Edit) => void;
}) {
  const id = useId();
  const title = edit.title ?? task.title;
  const priority = edit.priority ?? task.priority;
  const estimate = edit.estimate_workdays ?? task.estimate_workdays;
  const assignee = edit.assignee_id !== undefined ? edit.assignee_id : task.assignee_id;
  const plan = formatPlan({ start_date: task.start_date, last_day: task.last_day, is_milestone: task.is_milestone, scheduled: Boolean(task.start_date) }, task.start_date);
  return (
    <li className={`plan-task${included ? "" : " plan-task--dropped"}${parentTitle ? " plan-task--child" : ""}`} data-local-id={task.local_id}>
      <div className="plan-task__head">
        <label className="checkbox plan-task__include">
          <input type="checkbox" checked={included} disabled={!editable} onChange={(e) => onEdit({ include: e.target.checked })} aria-label={`Создать задачу «${task.title}»`} />
          {task.is_milestone ? <Icon name="milestone" size={13} label="Веха" /> : null}
        </label>
        {editable ? (
          <input className="plan-task__title" value={title} maxLength={200} aria-label={`Название «${task.title}»`} onChange={(e) => onEdit({ title: e.target.value })} />
        ) : (
          <span className="plan-task__title">{title}</span>
        )}
      </div>
      {parentTitle ? <p className="muted plan-task__parent">Подзадача «{parentTitle}»</p> : null}
      {task.description ? <p className="plan-task__description">{task.description}</p> : null}
      <div className="plan-task__fields">
        <div className="field">
          <label htmlFor={`${id}-pr`}>Приоритет</label>
          <select id={`${id}-pr`} value={priority} disabled={!editable} onChange={(e) => onEdit({ priority: e.target.value as TaskPriority })}>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-est`}>Оценка, раб. дн.</label>
          <input
            id={`${id}-est`}
            type="number"
            min={task.is_milestone ? 0 : 1}
            max={60}
            value={estimate ?? ""}
            disabled={!editable || task.is_milestone}
            onChange={(e) => onEdit({ estimate_workdays: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-as`}>Исполнитель</label>
          <select id={`${id}-as`} value={assignee ?? ""} disabled={!editable} onChange={(e) => onEdit({ assignee_id: e.target.value || null })}>
            <option value="">Не назначен</option>
            <AssigneeOptions assignees={assignees} />
          </select>
        </div>
      </div>
      <p className="plan-task__plan">
        <Icon name="clock" size={12} /> {task.start_date ? plan : estimate === null ? "Без дат: нет оценки" : "Без дат: не выбрано начало"}
        {task.start_date && !task.is_milestone && task.estimate_workdays ? ` · ${pluralWorkdays(task.estimate_workdays)}` : ""}
      </p>
      {task.duplicate_of ? <p className="task-doc__state task-doc__state--changed">Похожая задача уже есть: {task.duplicate_of}.</p> : null}
      {task.sources.length ? (
        <ul className="plan-task__sources" aria-label="Источники задачи">
          {task.sources.map((s, index) => (
            <li key={s.document_id ?? `hidden-${index}`}>
              {s.document_id ? <span className="task-mini-list__key">{s.document_id}</span> : <span className="muted">недоступный документ</span>}
              {s.verified && s.quote ? <q className="plan-task__quote">{s.quote}</q> : <span className="muted"> — без подтверждённой цитаты</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted plan-task__sources">Без опоры в документах — допущение модели.</p>
      )}
    </li>
  );
}
