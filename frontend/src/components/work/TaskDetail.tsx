import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type {
  LinkRelation,
  AssigneeRef,
  ScheduleApplyResult,
  TaskDependencies,
  TaskPriority,
  TaskStatus,
  TaskUpdate,
  WorkActivityEvent,
  WorkCapabilities,
  WorkTask,
} from "../../api/types";
import { toApiError, type UpdateResult } from "../../lib/useWorkspace";
import {
  ACTIVITY_LABEL,
  actorName,
  addDays,
  countWorkdays,
  FIELD_LABEL,
  formatDay,
  formatPlan,
  pluralWorkdays,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
  toDay,
  LINK_RELATION_LABEL,
  shortRevision,
} from "../../lib/work";
import { AnswerMarkdown } from "../AnswerMarkdown";
import { Notice } from "../Feedback";
import { When } from "../When";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { InlineDate, InlineText } from "./InlineEdit";
import { SchedulePreviewInline, type ScheduleRequest } from "./SchedulePreviewDialog";
import { TaskDocuments } from "./TaskDocuments";
import { AssigneeName, PriorityMark, TaskFlags, TaskStatusMark } from "./WorkBits";

/*
 * Task detail (M6): every field, subtasks, Finish-to-Start dependencies (add / remove; a cycle is refused with the
 * server's path `cycle_keys`), the change history (who, when, what), the «Документы» block (Step 4) and the
 * archive. One component for the panel of List / Board / Gantt and for the task page `/tasks/:key`.
 *
 * Dates change through the schedule preview shown right here (the consequences for dependants first, then
 * «Применить»): the form is the keyboard and phone alternative to dragging on the Gantt.
 */

export interface TaskDetailProps {
  task: WorkTask;
  /** Every task of the project (subtasks, the dependency picker, keys). */
  tasks: WorkTask[];
  projectRef: string;
  planRevision: number;
  capabilities: WorkCapabilities | null;
  canWrite: boolean;
  assignees: AssigneeRef[];
  today: string;
  maxDepth: number;
  taskHref: (task: Pick<WorkTask, "key">) => string;
  updateTask: (task: WorkTask, changes: Omit<TaskUpdate, "expected_version">, options?: { optimistic?: boolean }) => Promise<UpdateResult>;
  onAddSubtask: (parent: WorkTask) => void;
  /** Re-read the plan after a dependency, archive or schedule change. */
  onRefresh: () => Promise<void>;
  onArchived: (task: WorkTask) => void;
  say: (tone: "info" | "success" | "warning" | "danger", text: string) => void;
  /** 1 on the task page (the title is the H1); 2 in the panel, whose own heading names the task. */
  headingLevel?: 1 | 2;
}

export function TaskDetail(props: TaskDetailProps) {
  const { task, tasks, capabilities, canWrite, assignees, today, maxDepth, taskHref, updateTask, onAddSubtask, headingLevel = 2 } = props;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  const keyOf = (id: string) => byId.get(id)?.key ?? id;
  const parent = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
  const children = tasks.filter((t) => t.parent_task_id === task.id);
  // In the panel its heading already names the task; on the task page the title is the page's H1.
  const Title = headingLevel === 1 ? "h1" : "div";
  const name = `${task.key} ${task.title}`;

  return (
    <article className="task-detail" data-task-key={task.key}>
      <header className="task-detail__head">
        <p className="task-detail__key">
          {task.is_milestone ? <Icon name="milestone" size={13} label="Веха" /> : null}
          {task.key}
          {parent ? (
            <>
              <span aria-hidden="true"> · </span>
              <span className="muted">
                подзадача <Link to={taskHref(parent)}>{parent.key}</Link>
              </span>
            </>
          ) : null}
        </p>
        <Title className="task-detail__title">
          {canWrite ? (
            <InlineText value={task.title} label={`Название ${task.key}`} maxLength={capabilities?.limits.title_max ?? 200} onCommit={(title) => void updateTask(task, { title })}>
              <span>{task.title}</span>
            </InlineText>
          ) : (
            task.title
          )}
        </Title>
        <TaskFlags task={task} keyOf={keyOf} today={today} />
      </header>

      <dl className="task-props">
        <div>
          <dt>Статус</dt>
          <dd>
            {canWrite ? (
              <select aria-label={`Статус ${name}`} value={task.status} onChange={(e) => void updateTask(task, { status: e.target.value as TaskStatus })}>
                {TASK_STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            ) : (
              <TaskStatusMark status={task.status} />
            )}
          </dd>
        </div>
        <div>
          <dt>Исполнитель</dt>
          <dd>
            {canWrite ? (
              <select aria-label={`Исполнитель ${name}`} value={task.assignee_id ?? ""} onChange={(e) => void updateTask(task, { assignee_id: e.target.value || null })}>
                <option value="">Не назначен</option>
                {task.assignee_id && !assignees.some((a) => a.id === task.assignee_id) ? (
                  <option value={task.assignee_id}>{task.assignee?.display_name ?? task.assignee_id}</option>
                ) : null}
                {assignees.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            ) : (
              <AssigneeName task={task} />
            )}
          </dd>
        </div>
        <div>
          <dt>Приоритет</dt>
          <dd>
            {canWrite ? (
              <select aria-label={`Приоритет ${name}`} value={task.priority} onChange={(e) => void updateTask(task, { priority: e.target.value as TaskPriority })}>
                {PRIORITY_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            ) : (
              <PriorityMark priority={task.priority} />
            )}
          </dd>
        </div>
        <div>
          <dt>Срок</dt>
          <dd>
            <InlineDate
              value={task.due_date}
              display={task.due_date ? `${formatDay(task.due_date, today)} (включительно)` : "Не задан"}
              label={`Срок ${task.key}`}
              allowClear
              disabled={!canWrite}
              onCommit={(value) => void updateTask(task, { due_date: value })}
            />
          </dd>
        </div>
      </dl>

      <TaskDates {...props} />

      <TaskDescription task={task} canWrite={canWrite} limit={capabilities?.limits.description_max ?? 20_000} updateTask={updateTask} />

      <section className="task-section" aria-labelledby={`task-sub-${task.id}`}>
        <h3 className="task-section__title" id={`task-sub-${task.id}`}>
          Подзадачи <span className="task-section__count">{children.length}</span>
        </h3>
        {children.length ? (
          <ul className="task-mini-list">
            {children.map((child) => (
              <li key={child.id}>
                <TaskStatusMark status={child.status} className="task-status--compact" />
                <Link to={taskHref(child)} className="task-mini-list__link">
                  <span className="task-mini-list__key">{child.key}</span> {child.title}
                </Link>
                <span className="muted">{formatPlan(child, today)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Подзадач нет.</p>
        )}
        {canWrite && task.depth < maxDepth && !task.is_milestone ? (
          <Button size="sm" icon="plus" onClick={() => onAddSubtask(task)}>
            Добавить подзадачу
          </Button>
        ) : null}
        {task.is_milestone ? <p className="muted">У вехи нет подзадач.</p> : null}
      </section>

      <TaskDependencySection {...props} keyOf={keyOf} />

      <TaskDocuments task={task} capabilities={capabilities} canWrite={canWrite} onChanged={props.onRefresh} say={props.say} />

      <TaskHistory task={task} capabilities={capabilities} assignees={assignees} planRevision={props.planRevision} keyOf={keyOf} />

      <p className="task-detail__meta muted">
        Создана: {actorName(task.created_by, capabilities?.identity, assignees)} · <When value={task.created_at} />. Изменена:{" "}
        {actorName(task.updated_by, capabilities?.identity, assignees)} · <When value={task.updated_at} />. Версия {task.version}.
        {task.is_demo ? " Демо-данные (синтетические)." : ""}
      </p>

      {canWrite ? <TaskArchive {...props} /> : null}
    </article>
  );
}

// --- dates (the form alternative to dragging) -------------------------------------------------------------------------

function TaskDates({ task, projectRef, canWrite, today, updateTask, onRefresh, say }: TaskDetailProps) {
  const [editing, setEditing] = useState(false);
  const [request, setRequest] = useState<ScheduleRequest | null>(null);
  const [start, setStart] = useState(task.start_date ?? today);
  const [last, setLast] = useState(task.last_day ?? task.start_date ?? today);
  const [problem, setProblem] = useState<string | null>(null);
  const formId = useId();

  useEffect(() => {
    if (editing) return;
    setStart(task.start_date ?? today);
    setLast(task.last_day ?? task.start_date ?? today);
  }, [task.start_date, task.last_day, today, editing]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!start) {
      setProblem("Укажите дату начала.");
      return;
    }
    if (task.is_milestone) {
      setRequest({ taskKey: task.key, changes: [{ task_id: task.id, start_date: start, duration_workdays: 0 }] });
      return;
    }
    if (!last || toDay(last) < toDay(start)) {
      setProblem("Последний день не может быть раньше начала.");
      return;
    }
    const end = addDays(last, 1);
    if (countWorkdays(toDay(start), toDay(end)) === 0) {
      setProblem("В этом интервале нет рабочих дней (Пн–Пт).");
      return;
    }
    setRequest({ taskKey: task.key, changes: [{ task_id: task.id, start_date: start, end_exclusive: end }] });
  }

  async function unschedule() {
    const result = await updateTask(task, { start_date: null, end_exclusive: null }, { optimistic: false });
    if (result.ok) {
      setEditing(false);
      say("success", `${task.key}: даты сняты — задача в списке «Без дат».`);
    }
  }

  function applied(result: ScheduleApplyResult) {
    setRequest(null);
    setEditing(false);
    say("success", `Сроки применены: изменено задач — ${result.changed_tasks.length}.`);
    void onRefresh();
  }

  const workdays = start && last && !task.is_milestone ? countWorkdays(toDay(start), toDay(addDays(last, 1))) : 0;

  return (
    <section className="task-section" aria-labelledby={`task-dates-${task.id}`}>
      <h3 className="task-section__title" id={`task-dates-${task.id}`}>
        Сроки
      </h3>
      <p className="task-dates__plan">
        <span className="task-dates__value">{formatPlan(task, today)}</span>
        {task.duration_workdays ? <span className="muted"> · {pluralWorkdays(task.duration_workdays)}</span> : null}
        {task.date_locked ? (
          <span className="task-flag task-flag--locked">
            <Icon name="lock" size={12} /> закреплены
          </span>
        ) : null}
      </p>
      <p className="muted task-dates__note">Последний день — включительно; выходные (Сб, Вс) не считаются рабочими.</p>
      {canWrite ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={task.date_locked}
            onChange={(e) => void updateTask(task, { date_locked: e.target.checked }, { optimistic: false })}
          />
          Закрепить сроки (планировщик не сдвигает задачу, а сообщает о конфликте)
        </label>
      ) : null}
      {canWrite && !task.date_locked && !editing ? (
        <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
          {task.scheduled ? "Изменить сроки" : "Запланировать"}
        </Button>
      ) : null}
      {editing && !request ? (
        <form className="task-dates__form" onSubmit={submit} aria-labelledby={`task-dates-${task.id}`}>
          <div className="task-dates__fields">
            <div className="field">
              <label htmlFor={`${formId}-start`}>{task.is_milestone ? "Дата вехи" : "Начало"}</label>
              <input id={`${formId}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
            </div>
            {!task.is_milestone ? (
              <div className="field">
                <label htmlFor={`${formId}-last`}>Последний день</label>
                <input id={`${formId}-last`} type="date" value={last} min={start} onChange={(e) => setLast(e.target.value)} required />
              </div>
            ) : null}
          </div>
          {!task.is_milestone && workdays > 0 ? <p className="muted">Длительность: {pluralWorkdays(workdays)}.</p> : null}
          {problem ? (
            <p className="field__issue field__issue--error" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="button-row">
            <Button type="submit" variant="secondary">
              Показать последствия
            </Button>
            {task.scheduled ? (
              <Button variant="quiet" onClick={() => void unschedule()}>
                Снять даты
              </Button>
            ) : null}
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Отмена
            </Button>
          </div>
        </form>
      ) : null}
      {request ? (
        <SchedulePreviewInline projectRef={projectRef} request={request} onClose={() => setRequest(null)} onApplied={applied} onRefresh={onRefresh} today={today} />
      ) : null}
    </section>
  );
}

// --- description --------------------------------------------------------------------------------------------------------

function TaskDescription({
  task,
  canWrite,
  limit,
  updateTask,
}: {
  task: WorkTask;
  canWrite: boolean;
  limit: number;
  updateTask: TaskDetailProps["updateTask"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  const id = useId();

  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await updateTask(task, { description: draft });
    if (result.ok) setEditing(false);
  }

  return (
    <section className="task-section" aria-labelledby={`${id}-title`}>
      <h3 className="task-section__title" id={`${id}-title`}>
        Описание
      </h3>
      {editing ? (
        <form onSubmit={(e) => void save(e)}>
          <label htmlFor={`${id}-text`} className="visually-hidden">
            Описание {task.key} (Markdown)
          </label>
          <textarea id={`${id}-text`} rows={8} value={draft} maxLength={limit} onChange={(e) => setDraft(e.target.value)} />
          <p className="muted">Markdown. HTML показывается как текст.</p>
          <div className="button-row">
            <Button type="submit" variant="secondary">
              Сохранить описание
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Отмена
            </Button>
          </div>
        </form>
      ) : (
        <>
          {task.description.trim() ? (
            <div className="task-description answer-md">
              <AnswerMarkdown text={task.description} markers={null} headingLevel={3} />
            </div>
          ) : (
            <p className="muted">Описания нет.</p>
          )}
          {canWrite ? (
            <Button
              size="sm"
              variant="quiet"
              icon="edit"
              onClick={() => {
                setDraft(task.description);
                setEditing(true);
              }}
            >
              Изменить описание
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

// --- dependencies ---------------------------------------------------------------------------------------------------------

function TaskDependencySection({
  task,
  tasks,
  projectRef,
  planRevision,
  canWrite,
  today,
  taskHref,
  onRefresh,
  say,
  keyOf,
}: TaskDetailProps & { keyOf: (id: string) => string }) {
  const [deps, setDeps] = useState<TaskDependencies | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [role, setRole] = useState<"predecessor" | "successor">("predecessor");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; cycle?: string[]; offerPreview?: boolean } | null>(null);
  const [request, setRequest] = useState<ScheduleRequest | null>(null);
  const id = useId();

  useEffect(() => {
    let live = true;
    api
      .workTaskDependencies(task.id)
      .then((result) => {
        if (live) {
          setDeps(result);
          setLoadError(null);
        }
      })
      .catch((err: unknown) => {
        if (live) setLoadError(toApiError(err));
      });
    return () => {
      live = false;
    };
  }, [task.id, planRevision]);

  const candidates = tasks.filter((t) => t.id !== task.id && !t.archived_at);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!other) return;
    setBusy(true);
    setProblem(null);
    const payload = role === "predecessor" ? { predecessor_task_id: other } : { successor_task_id: other };
    try {
      await api.workAddDependency(task.id, { ...payload, expected_plan_revision: deps?.plan_revision ?? planRevision });
      setOther("");
      say("success", role === "predecessor" ? `${keyOf(other)} → ${task.key}: зависимость добавлена.` : `${task.key} → ${keyOf(other)}: зависимость добавлена.`);
      await onRefresh();
    } catch (err) {
      const e = toApiError(err);
      if (e.code === "dependency_cycle") {
        const path = Array.isArray(e.details.cycle_keys) ? (e.details.cycle_keys as string[]) : [];
        setProblem({ text: "Нельзя: зависимость замкнёт цикл.", cycle: path });
      } else if (e.code === "schedule_conflict" && e.details.reason === "dependency_violated") {
        setProblem({ text: "Текущие даты нарушат эту зависимость: зависимую задачу нужно сдвинуть.", offerPreview: true });
      } else if (e.status === 409) {
        setProblem({ text: "План проекта изменился — данные обновлены, повторите." });
        await onRefresh();
      } else {
        setProblem({ text: e.message });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(dependencyId: string, label: string) {
    setProblem(null);
    try {
      await api.workRemoveDependency(task.id, dependencyId, deps?.plan_revision ?? planRevision);
      say("success", `Зависимость ${label} убрана.`);
      await onRefresh();
    } catch (err) {
      const e = toApiError(err);
      if (e.status === 409) await onRefresh();
      say("danger", `Не удалось убрать зависимость ${label}: ${e.message}`);
    }
  }

  function previewWithDependency() {
    if (!other) return;
    const pair = role === "predecessor" ? { predecessor_task_id: other, successor_task_id: task.id } : { predecessor_task_id: task.id, successor_task_id: other };
    setRequest({ taskKey: task.key, changes: [], addDependencies: [{ ...pair, kind: "FS", lag_workdays: 0 }] });
  }

  const entry = (item: TaskDependencies["predecessors"][number], direction: "pred" | "succ") => {
    const label = direction === "pred" ? `${item.task.key} → ${task.key}` : `${task.key} → ${item.task.key}`;
    return (
      <li key={item.dependency.id} data-dependency-id={item.dependency.id}>
        <TaskStatusMark status={item.task.status} className="task-status--compact" />
        <Link to={taskHref(item.task)} className="task-mini-list__link">
          <span className="task-mini-list__key">{item.task.key}</span> {item.task.title}
        </Link>
        {item.dependency.satisfied === false ? <span className="task-flag task-flag--overdue">нарушена</span> : null}
        {canWrite ? (
          <button type="button" className="link-button" aria-label={`Убрать зависимость ${label}`} onClick={() => void remove(item.dependency.id, label)}>
            Убрать
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <section className="task-section" aria-labelledby={`${id}-title`}>
      <h3 className="task-section__title" id={`${id}-title`}>
        Зависимости <span className="muted task-section__hint">окончание → начало</span>
      </h3>
      {loadError ? <Notice tone="danger">Не удалось загрузить зависимости: {loadError.message}</Notice> : null}
      {deps ? (
        <div className="task-deps">
          <div>
            <h4 className="task-deps__title">Начнётся после</h4>
            {deps.predecessors.length ? <ul className="task-mini-list">{deps.predecessors.map((item) => entry(item, "pred"))}</ul> : <p className="muted">Нет предшественников.</p>}
          </div>
          <div>
            <h4 className="task-deps__title">После неё начнутся</h4>
            {deps.successors.length ? <ul className="task-mini-list">{deps.successors.map((item) => entry(item, "succ"))}</ul> : <p className="muted">Нет последователей.</p>}
          </div>
        </div>
      ) : !loadError ? (
        <p className="muted">Загрузка…</p>
      ) : null}
      {canWrite && !request ? (
        <form className="task-deps__add" onSubmit={(e) => void add(e)}>
          <div className="field">
            <label htmlFor={`${id}-role`}>Новая зависимость</label>
            <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as "predecessor" | "successor")}>
              <option value="predecessor">{task.key} начнётся после…</option>
              <option value="successor">После {task.key} начнётся…</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-task`}>Задача</label>
            <select id={`${id}-task`} value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">Выберите задачу</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.key} {t.title}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" size="sm" disabled={!other || busy}>
            Добавить зависимость
          </Button>
        </form>
      ) : null}
      {problem ? (
        <div className="notice notice--danger task-deps__problem" role="alert">
          <p>{problem.text}</p>
          {problem.cycle && problem.cycle.length ? (
            <p className="task-deps__cycle">
              Цикл: <span className="task-deps__path">{problem.cycle.join(" → ")}</span>
            </p>
          ) : null}
          {problem.offerPreview ? (
            <Button size="sm" onClick={previewWithDependency}>
              Показать последствия
            </Button>
          ) : null}
        </div>
      ) : null}
      {request ? (
        <SchedulePreviewInline
          projectRef={projectRef}
          request={request}
          today={today}
          onClose={() => setRequest(null)}
          onRefresh={onRefresh}
          onApplied={(result) => {
            setRequest(null);
            setProblem(null);
            setOther("");
            say("success", `Зависимость добавлена, сдвинуто задач: ${result.changed_tasks.length}.`);
            void onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}

// --- history ---------------------------------------------------------------------------------------------------------------

function describeValue(field: string, value: unknown, assignees: AssigneeRef[], keyOf: (id: string) => string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "status" && typeof value === "string") return TASK_STATUS_LABEL[value as TaskStatus] ?? value;
  if (field === "priority" && typeof value === "string") return PRIORITY_LABEL[value as TaskPriority] ?? value;
  if (field === "assignee_id" && typeof value === "string") return assignees.find((a) => a.id === value)?.display_name ?? value;
  if ((field === "parent_task_id" || field === "predecessor" || field === "successor") && typeof value === "string") return keyOf(value);
  if (field === "relation" && typeof value === "string") return LINK_RELATION_LABEL[value as LinkRelation] ?? value;
  if (field === "revision_at_link" && typeof value === "string") return shortRevision(value);
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDay(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function changeLines(event: WorkActivityEvent, assignees: AssigneeRef[], keyOf: (id: string) => string): string[] {
  const lines: string[] = [];
  for (const [field, raw] of Object.entries(event.changes ?? {})) {
    const label = FIELD_LABEL[field] ?? field;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      if ("changed" in value && !("before" in value)) {
        lines.push(`${label}: изменено`);
        continue;
      }
      if ("before" in value || "after" in value) {
        lines.push(`${label}: ${describeValue(field, value.before, assignees, keyOf)} → ${describeValue(field, value.after, assignees, keyOf)}`);
        continue;
      }
    }
    lines.push(`${label}: ${describeValue(field, raw, assignees, keyOf)}`);
  }
  return lines;
}

function TaskHistory({
  task,
  capabilities,
  assignees,
  planRevision,
  keyOf,
}: {
  task: WorkTask;
  capabilities: WorkCapabilities | null;
  assignees: AssigneeRef[];
  planRevision: number;
  keyOf: (id: string) => string;
}) {
  const [items, setItems] = useState<WorkActivityEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const allowed = Boolean(capabilities?.can_view_audit);
  const id = useId();

  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    api
      .workTaskActivity(task.id, { limit: 20 })
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setNext(page.next_before_seq);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(toApiError(err));
      });
    return () => {
      live = false;
    };
  }, [task.id, task.version, planRevision, allowed]);

  async function more() {
    if (next === null) return;
    try {
      const page = await api.workTaskActivity(task.id, { limit: 20, before_seq: next });
      setItems((current) => [...current, ...page.items]);
      setNext(page.next_before_seq);
    } catch (err) {
      setError(toApiError(err));
    }
  }

  return (
    <section className="task-section" aria-labelledby={`${id}-title`}>
      <h3 className="task-section__title" id={`${id}-title`}>
        <Icon name="history" size={14} /> История
      </h3>
      {!allowed ? (
        <p className="muted">История изменений не показывается в режиме только для просмотра.</p>
      ) : error ? (
        <Notice tone="danger">Не удалось загрузить историю: {error.message}</Notice>
      ) : items.length === 0 ? (
        <p className="muted">Записей пока нет.</p>
      ) : (
        <ol className="task-history">
          {items.map((event) => {
            const lines = changeLines(event, assignees, keyOf);
            return (
              <li key={event.id} className="task-history__item" data-operation={event.operation}>
                <p className="task-history__what">
                  <span className="task-history__who">{event.actor_display}</span> {ACTIVITY_LABEL[event.operation] ?? event.operation}
                  <span className="muted">
                    {" "}
                    · <When value={event.at} />
                  </span>
                </p>
                {lines.length ? (
                  <ul className="task-history__changes">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {allowed && next !== null ? (
        <Button size="sm" variant="quiet" onClick={() => void more()}>
          Показать раньше
        </Button>
      ) : null}
    </section>
  );
}

// --- archive -------------------------------------------------------------------------------------------------------------------

function TaskArchive({ task, onArchived, say, onRefresh }: TaskDetailProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function archive() {
    setBusy(true);
    try {
      const result = await api.workArchiveTask(task.id, task.version, task.child_count > 0);
      say("success", `${task.key} в архиве${result.archived.length > 1 ? ` вместе с подзадачами (${result.archived.length - 1})` : ""}. Зависимостей убрано: ${result.removed_dependency_ids.length}.`);
      onArchived(task);
      await onRefresh();
    } catch (err) {
      const e = toApiError(err);
      say("danger", `${task.key}: ${e.message}`);
      if (e.status === 409) await onRefresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="task-section task-archive" aria-label="Архив">
      {confirming ? (
        <div className="task-archive__confirm" role="group" aria-label="Подтверждение">
          <p>
            Отправить {task.key} в архив{task.child_count > 0 ? ` вместе с подзадачами (${task.child_count})` : ""}? Её зависимости будут убраны,
            история останется.
          </p>
          <div className="button-row">
            <Button variant="danger" onClick={() => void archive()} disabled={busy}>
              В архив
            </Button>
            <Button onClick={() => setConfirming(false)}>Отмена</Button>
          </div>
        </div>
      ) : (
        <Button variant="quiet" size="sm" onClick={() => setConfirming(true)}>
          Отправить в архив…
        </Button>
      )}
    </section>
  );
}
