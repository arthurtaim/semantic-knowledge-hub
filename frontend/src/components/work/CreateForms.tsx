import { useId, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "../../api/client";
import type { AssigneeRef, TaskPriority, TaskStatus, WorkProject, WorkTask } from "../../api/types";
import { newRequestId } from "../../lib/requestId";
import { toApiError } from "../../lib/useWorkspace";
import { PRIORITY_LABEL, PRIORITY_ORDER, TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../../lib/work";
import { ErrorState } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button } from "../ui/Button";
import { AssigneeOptions } from "./WorkBits";

/*
 * «Новая задача» and «Новый проект» (M6): forms in a sheet (a bottom sheet on phones). One idempotency key per
 * form (`client_request_id`): a double submit or a retry after a lost answer returns the object already created.
 * Dates are optional — the server never invents them; a task without dates goes to the «Без дат» pool.
 */

interface TaskCreateSheetProps {
  project: WorkProject;
  tasks: WorkTask[];
  assignees: AssigneeRef[];
  parent: WorkTask | null;
  maxDepth: number;
  onClose: () => void;
  onCreated: (task: WorkTask) => void;
}

type Schedule = "none" | "dates" | "milestone";

export function TaskCreateSheet({ project, tasks, assignees, parent, maxDepth, onClose, onCreated }: TaskCreateSheetProps) {
  const mode = useSidePanelMode(true);
  const id = useId();
  const requestId = useRef(newRequestId());
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState(parent?.id ?? "");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [assignee, setAssignee] = useState("");
  const [schedule, setSchedule] = useState<Schedule>("none");
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState("1");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const parents = tasks.filter((t) => t.depth < maxDepth && !t.is_milestone && !t.archived_at);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setError(null);
    if (!title.trim()) {
      setProblem("Введите название задачи.");
      return;
    }
    const days = Number(duration);
    if (schedule !== "none" && !start) {
      setProblem("Укажите дату начала или выберите «Без дат».");
      return;
    }
    if (schedule === "dates" && (!Number.isInteger(days) || days < 1)) {
      setProblem("Длительность — целое число рабочих дней, не меньше 1.");
      return;
    }
    setBusy(true);
    try {
      const created = await api.workCreateTask(project.id, {
        title: title.trim(),
        parent_task_id: parentId || null,
        status,
        priority,
        assignee_id: assignee || null,
        is_milestone: schedule === "milestone",
        ...(schedule === "dates" ? { start_date: start, duration_workdays: days } : {}),
        ...(schedule === "milestone" ? { start_date: start, duration_workdays: 0 } : {}),
        due_date: due || null,
        client_request_id: requestId.current,
      });
      onCreated(created);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      id="task-create"
      title={parent ? `Подзадача к ${parent.key}` : "Новая задача"}
      mode={mode}
      onClose={onClose}
      className="work-form"
      footer={
        <div className="button-row">
          <Button variant="primary" type="submit" form={`${id}-form`} disabled={busy}>
            {busy ? "Создаём…" : "Создать задачу"}
          </Button>
          <Button onClick={onClose}>Отмена</Button>
        </div>
      }
    >
      <form id={`${id}-form`} className="work-form__fields" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor={`${id}-title`}>
            Название <span aria-hidden="true">*</span>
          </label>
          <input id={`${id}-title`} value={title} maxLength={200} required autoFocus onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-parent`}>Родительская задача</label>
          <select id={`${id}-parent`} value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Нет (задача верхнего уровня)</option>
            {parents.map((t) => (
              <option key={t.id} value={t.id}>
                {"· ".repeat(t.depth - 1)}
                {t.key} {t.title}
              </option>
            ))}
          </select>
        </div>
        <div className="work-form__row">
          <div className="field">
            <label htmlFor={`${id}-status`}>Статус</label>
            <select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {TASK_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-priority`}>Приоритет</label>
            <select id={`${id}-priority`} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-assignee`}>Исполнитель</label>
          <select id={`${id}-assignee`} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-describedby={`${id}-assignee-hint`}>
            <option value="">Не назначен</option>
            <AssigneeOptions assignees={assignees} />
          </select>
          {assignees.some((a) => a.kind === "fixture") ? (
            <p className="field__hint" id={`${id}-assignee-hint`}>
              Исполнители «(демо)» — вымышленная команда для примера, не учётные записи: назначение не даёт никому прав.
            </p>
          ) : null}
        </div>
        <fieldset className="work-form__schedule">
          <legend>Сроки</legend>
          {(
            [
              ["none", "Без дат (в список «Без дат»)"],
              ["dates", "Начало и длительность"],
              ["milestone", "Веха (точка без длительности)"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="checkbox">
              <input type="radio" name={`${id}-schedule`} value={value} checked={schedule === value} onChange={() => setSchedule(value)} />
              {label}
            </label>
          ))}
          {schedule !== "none" ? (
            <div className="work-form__row">
              <div className="field">
                <label htmlFor={`${id}-start`}>{schedule === "milestone" ? "Дата вехи" : "Начало"}</label>
                <input id={`${id}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              {schedule === "dates" ? (
                <div className="field">
                  <label htmlFor={`${id}-duration`}>Рабочих дней</label>
                  <input id={`${id}-duration`} type="number" min={1} max={2000} step={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
                </div>
              ) : null}
            </div>
          ) : null}
          {schedule === "dates" ? <p className="field__hint">Начало в выходной переносится на понедельник; выходные не считаются.</p> : null}
        </fieldset>
        <div className="field">
          <label htmlFor={`${id}-due`}>Срок (включительно)</label>
          <input id={`${id}-due`} type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-describedby={`${id}-due-hint`} />
          <p className="field__hint" id={`${id}-due-hint`}>
            Дедлайн отдельно от плана: планировщик его не меняет, только предупреждает.
          </p>
        </div>
        {problem ? (
          <p className="field__issue field__issue--error" role="alert">
            {problem}
          </p>
        ) : null}
        {error ? <ErrorState error={error} /> : null}
      </form>
    </SidePanel>
  );
}

interface ProjectCreateSheetProps {
  onClose: () => void;
  onCreated: (project: WorkProject) => void;
}

/** The key is the project's short immutable name (ARIS): it prefixes every task key (ARIS-12). */
export function ProjectCreateSheet({ onClose, onCreated }: ProjectCreateSheetProps) {
  const mode = useSidePanelMode(true);
  const id = useId();
  const requestId = useRef(newRequestId());
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setError(null);
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
      setProblem("Ключ: 2–10 латинских заглавных букв и цифр, начинается с буквы (например, ARIS).");
      return;
    }
    if (!title.trim()) {
      setProblem("Введите название проекта.");
      return;
    }
    if (start && target && target < start) {
      setProblem("Целевая дата не может быть раньше начала.");
      return;
    }
    setBusy(true);
    try {
      const created = await api.workCreateProject({
        key,
        title: title.trim(),
        description: description.trim() || undefined,
        start_date: start || null,
        target_date: target || null,
        client_request_id: requestId.current,
      });
      onCreated(created);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      id="project-create"
      title="Новый проект"
      mode={mode}
      onClose={onClose}
      className="work-form"
      footer={
        <div className="button-row">
          <Button variant="primary" type="submit" form={`${id}-form`} disabled={busy}>
            {busy ? "Создаём…" : "Создать проект"}
          </Button>
          <Button onClick={onClose}>Отмена</Button>
        </div>
      }
    >
      <form id={`${id}-form`} className="work-form__fields" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor={`${id}-key`}>
            Ключ <span aria-hidden="true">*</span>
          </label>
          <input
            id={`${id}-key`}
            value={key}
            maxLength={10}
            required
            autoFocus
            autoComplete="off"
            aria-describedby={`${id}-key-hint`}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          />
          <p className="field__hint" id={`${id}-key-hint`}>
            Латиница и цифры, 2–10 знаков; не меняется. Задачи получат ключи {key || "KEY"}-1, {key || "KEY"}-2…
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-title`}>
            Название <span aria-hidden="true">*</span>
          </label>
          <input id={`${id}-title`} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-description`}>Описание</label>
          <textarea id={`${id}-description`} rows={4} value={description} maxLength={20000} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="work-form__row">
          <div className="field">
            <label htmlFor={`${id}-start`}>Начало</label>
            <input id={`${id}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-target`}>Целевая дата</label>
            <input id={`${id}-target`} type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
        </div>
        {problem ? (
          <p className="field__issue field__issue--error" role="alert">
            {problem}
          </p>
        ) : null}
        {error ? <ErrorState error={error} /> : null}
      </form>
    </SidePanel>
  );
}
