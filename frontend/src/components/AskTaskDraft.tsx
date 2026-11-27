import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { AssigneeRef, TaskCreate, TaskDraft, TaskDraftField, TaskPriority, WorkProject, WorkTask } from "../api/types";
import { PRIORITY_LABEL, addDays } from "../lib/work";
import { Icon } from "./ui/Icon";

/*
 * «Создать задачу» (design 2026-11-27 §5.4): the card of a task DRAFT the assistant prepared from the person's phrase.
 * Nothing was written by the chat. The person checks and edits the fields and presses «Создать задачу» — the SAME
 * route as «Новая задача» in a project (POST /api/projects/{key}/tasks: rights, audit, idempotency by
 * client_request_id, so a double click creates one task); then the checked context documents are linked
 * (POST /api/tasks/{id}/links). Words in the chat never create anything.
 */

const ORIGIN_TEXT: Record<string, string> = {
  request: "из вашего запроса",
  assistant: "предложение ассистента",
  composer: "выбран вами",
};
const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "critical"];

type Values = {
  project: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assignee: string;
  due: string;
  start: string;
  end: string;
};
type Key = keyof Values;
const FIELD_OF: Record<Key, TaskDraftField> = {
  project: "project",
  title: "title",
  description: "description",
  priority: "priority",
  assignee: "assignee",
  due: "due_date",
  start: "start_date",
  end: "end_date",
};
// a 422 `details.field` of the task API → the card field it belongs to
const SERVER_FIELD: Record<string, Key> = {
  title: "title",
  description: "description",
  priority: "priority",
  assignee_id: "assignee",
  due_date: "due",
  start_date: "start",
  end_exclusive: "end",
  duration_workdays: "end",
};

type LinkState = { document_id: string; title: string; state: "pending" | "linked" | "failed" };

/** The card field a 422 of the task API belongs to: `details.field` when the server names it, otherwise by code and
 * reason exactly as the task API sends them (`invalid_assignee`; `invalid_date_range` with `no_workdays`,
 * `end_before_start`, `partial`, …). */
function fieldOf(err: ApiError, values: Values): Key | null {
  const named = SERVER_FIELD[String(err.details.field ?? "")];
  if (named) return named;
  if (err.code === "invalid_assignee") return "assignee";
  if (err.code === "invalid_date_range") {
    const reason = String(err.details.reason ?? "");
    if (reason === "partial") return values.start ? "end" : "start";
    if (["no_workdays", "end_before_start", "duration_mismatch", "duration_zero"].includes(reason)) return "end";
  }
  return null;
}

interface AskTaskDraftProps {
  draft: TaskDraft;
  compact?: boolean;
  /** «Ответить как обычно»: the same question as a plain answer (shown only when the skill started by itself). */
  onAnswerNormally?: () => void;
}

function initial(draft: TaskDraft): Values {
  return {
    project: draft.project_key ?? "",
    title: draft.title,
    description: draft.description,
    priority: draft.priority,
    assignee: draft.assignee_id ?? "",
    due: draft.due_date ?? "",
    start: draft.start_date ?? "",
    end: draft.end_date ?? "",
  };
}

export function AskTaskDraft({ draft, compact = false, onAnswerNormally }: AskTaskDraftProps) {
  const id = useId();
  const [values, setValues] = useState<Values>(() => initial(draft));
  const [touched, setTouched] = useState<Set<Key>>(() => new Set());
  const [projects, setProjects] = useState<WorkProject[] | null>(null);
  const [assignees, setAssignees] = useState<AssigneeRef[]>([]);
  const [linkChosen, setLinkChosen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(draft.documents.map((d) => [d.document_id, true])),
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Key, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<WorkTask | null>(null);
  const [links, setLinks] = useState<LinkState[]>([]);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .workProjects()
      .then((list) => alive && setProjects(list.items.filter((p) => p.status !== "archived")))
      .catch(() => alive && setProjects([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .workAssignees(values.project || undefined)
      .then((list) => alive && setAssignees(list))
      .catch(() => alive && setAssignees([]));
    return () => {
      alive = false;
    };
  }, [values.project]);

  function set(key: Key, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  }

  function origin(key: Key): string | null {
    if (touched.has(key)) return "изменено вами";
    const from = draft.origin[FIELD_OF[key]];
    return from ? (ORIGIN_TEXT[from] ?? null) : null;
  }

  const missingProject = !values.project;
  const missingTitle = !values.title.trim();
  const halfPeriod = Boolean(values.start) !== Boolean(values.end);
  const canCreate = !missingProject && !missingTitle && !halfPeriod && !busy;

  async function linkDocuments(task: WorkTask, targets: LinkState[]) {
    const results = await Promise.all(
      targets.map(async (target, index): Promise<LinkState> => {
        try {
          // the key follows the document's place in the DRAFT (stable across retries of a subset)
          const place = draft.documents.findIndex((d) => d.document_id === target.document_id);
          await api.workLinkDocument(task.id, {
            document_id: target.document_id,
            client_request_id: `${draft.client_request_id}-link-${place >= 0 ? place : index}`,
          });
          return { ...target, state: "linked" };
        } catch {
          return { ...target, state: "failed" };
        }
      }),
    );
    setLinks((current) => current.map((link) => results.find((r) => r.document_id === link.document_id) ?? link));
  }

  async function create() {
    if (inFlight.current || !canCreate) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setFieldErrors({});
    const body: TaskCreate = {
      title: values.title.trim(),
      description: values.description.trim() || undefined,
      priority: values.priority,
      assignee_id: values.assignee || undefined,
      due_date: values.due || undefined,
      start_date: values.start || undefined,
      end_exclusive: values.end ? addDays(values.end, 1) : undefined,
      client_request_id: draft.client_request_id,
    };
    try {
      const task = await api.workCreateTask(values.project, body);
      setCreated(task);
      const targets = draft.documents
        .filter((d) => linkChosen[d.document_id])
        .map((d): LinkState => ({ document_id: d.document_id, title: d.title, state: "pending" }));
      setLinks(targets);
      if (targets.length > 0) await linkDocuments(task, targets);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const key = fieldOf(err, values);
        if (key) setFieldErrors({ [key]: err.message });
        else setProblem(err.message);
      } else if (err instanceof ApiError && err.status === 403) {
        setProblem("Нет прав на создание задач в этом проекте.");
      } else if (err instanceof ApiError && err.status === 404) {
        setProblem("Проект недоступен.");
      } else {
        setProblem(err instanceof Error ? err.message : "Не удалось создать задачу.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const className = `ask-proposal ask-task-draft${compact ? " ask-proposal--compact" : ""}`;

  if (created) {
    const failed = links.filter((l) => l.state === "failed");
    return (
      <section className={className} aria-label={`Задача ${created.key} создана`} data-task-draft="created">
        <p className="ask-proposal__title">
          <Icon name="projects" size={14} /> Задача {created.key} создана
        </p>
        <p className="ask-proposal__meta">{created.title}</p>
        {links
          .filter((l) => l.state === "linked")
          .map((l) => (
            <p key={l.document_id} className="ask-task-draft__note">
              Связь с документом «{l.title}» добавлена.
            </p>
          ))}
        {failed.length > 0 ? (
          <p className="ask-task-draft__problem" role="alert">
            Задача создана, связь с документом не добавлена — добавьте её в задаче.
          </p>
        ) : null}
        <div className="ask-proposal__actions">
          <Link className="button button--primary" to={`/projects/${values.project}?task=${created.key}`}>
            Открыть задачу
          </Link>
          {failed.length > 0 ? (
            <button type="button" className="button" onClick={() => void linkDocuments(created, failed)}>
              Добавить связь
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const field = (key: Key, label: string, control: ReactNode, hint?: string | null) => {
    const note = origin(key);
    const error = fieldErrors[key];
    return (
      <div className={`ask-task-draft__field${hint ? " ask-task-draft__field--missing" : ""}`}>
        <label htmlFor={`${id}-${key}`}>{label}</label>
        {control}
        {note ? <span className="ask-task-draft__origin">{note}</span> : null}
        {hint ? <span className="ask-task-draft__hint">{hint}</span> : null}
        {error ? (
          <span className="ask-task-draft__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <section className={className} aria-label="Черновик задачи" data-task-draft="draft">
      <p className="ask-proposal__title">
        <Icon name="projects" size={14} /> Черновик задачи — проверьте и создайте
      </p>
      <div className="ask-task-draft__grid">
        {field(
          "project",
          "Проект",
          <select id={`${id}-project`} value={values.project} onChange={(e) => set("project", e.target.value)}>
            <option value="">— выберите проект —</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} — {p.title}
              </option>
            ))}
            {values.project && projects && !projects.some((p) => p.key === values.project) ? (
              <option value={values.project}>{values.project}</option>
            ) : null}
          </select>,
          missingProject ? "Выберите проект" : null,
        )}
        {field(
          "title",
          "Название",
          <input id={`${id}-title`} value={values.title} maxLength={200} onChange={(e) => set("title", e.target.value)} />,
          missingTitle ? "Укажите название" : null,
        )}
        {field(
          "description",
          "Описание",
          <textarea
            id={`${id}-description`}
            value={values.description}
            rows={2}
            onChange={(e) => set("description", e.target.value)}
          />,
        )}
        {field("due", "Срок", <input id={`${id}-due`} type="date" value={values.due} onChange={(e) => set("due", e.target.value)} />)}
        {field(
          "start",
          "Начало",
          <input id={`${id}-start`} type="date" value={values.start} onChange={(e) => set("start", e.target.value)} />,
          !values.start && values.end ? "Укажите начало или очистите окончание" : null,
        )}
        {field(
          "end",
          "Окончание",
          <input id={`${id}-end`} type="date" value={values.end} onChange={(e) => set("end", e.target.value)} />,
          values.start && !values.end ? "Укажите окончание или очистите начало" : null,
        )}
        {field(
          "assignee",
          "Исполнитель",
          <select id={`${id}-assignee`} value={values.assignee} onChange={(e) => set("assignee", e.target.value)}>
            <option value="">не назначен</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>,
          draft.assignee_hint && !values.assignee ? `Исполнитель из запроса: «${draft.assignee_hint}» — выберите` : null,
        )}
        {field(
          "priority",
          "Приоритет",
          <select id={`${id}-priority`} value={values.priority} onChange={(e) => set("priority", e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>,
        )}
      </div>
      {draft.documents.length > 0 ? (
        <div className="ask-task-draft__links">
          {draft.documents.map((d) => (
            <label key={d.document_id} className="ask-task-draft__check">
              <input
                type="checkbox"
                checked={Boolean(linkChosen[d.document_id])}
                onChange={(e) => setLinkChosen((current) => ({ ...current, [d.document_id]: e.target.checked }))}
              />{" "}
              Связать с документом «{d.title}»
            </label>
          ))}
        </div>
      ) : null}
      {draft.issues.length > 0 ? (
        <ul className="ask-task-draft__issues" aria-label="Замечания">
          {draft.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p className="ask-task-draft__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="ask-proposal__actions">
        <button type="button" className="button button--primary" disabled={!canCreate} onClick={() => void create()}>
          Создать задачу
        </button>
        {draft.auto_started && onAnswerNormally ? (
          <button type="button" className="button" onClick={onAnswerNormally}>
            Ответить как обычно
          </button>
        ) : null}
      </div>
    </section>
  );
}
