import { memo, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AssigneeRef, TaskDateChange, TaskPriority, TaskStatus, TaskUpdate, WorkTask } from "../../api/types";
import type { UpdateResult } from "../../lib/useWorkspace";
import {
  addDays,
  formatDay,
  formatPlanShort,
  initials,
  LIST_COLUMN_LABEL,
  LIST_COLUMNS,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
  type ListColumn,
  type TaskGroup,
  type VisibleRow,
} from "../../lib/work";
import { Button, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu, Popover, type MenuGroup } from "../ui/Popover";
import { InlineText } from "./InlineEdit";
import { PriorityBars, PriorityMark, StatusShape, TaskStatusMark } from "./WorkBits";

/*
 * «Список» (M6; Planner v2 — docs/ui-v2/planner/specs/PLANNER_V2.md §4): the tasks as a table of plain cells — no
 * select in every row. A cell looks like text (a status mark and its word, an avatar and a name, priority bars and
 * their word, «10 – 19 нояб.», a deadline in red when overdue, «—» when empty) and turns into an editor on a click or
 * Enter: a menu for status (keys 1–4), assignee and priority, a small calendar form for the dates and the deadline.
 * Saving is the same as before: PATCH with the task's version, optimistic for plain fields and rolled back on an
 * error (shown at the cell and in the page message); `409 stale_task` re-reads; dates wait for the server, and a date
 * that would break a Finish-to-Start dependency opens the schedule preview instead.
 *
 * Without grouping it is the task tree (subtasks up to four levels, expand / collapse); grouped by status, assignee
 * or priority it is a flat list under group headers, subtasks marked with ↳. Columns can be hidden in «Вид».
 * Renders 200 rows at a time («Показать ещё»), so a project with thousands of tasks keeps a bounded DOM.
 */

export const LIST_PAGE = 200;

export interface TaskListProps {
  /** The task tree (no grouping). */
  rows: VisibleRow[];
  /** Grouped: the groups of matching tasks; null — the tree. */
  groups: TaskGroup[] | null;
  collapsed: ReadonlySet<string>;
  onToggle: (taskId: string) => void;
  canWrite: boolean;
  assignees: AssigneeRef[];
  today: string;
  maxDepth: number;
  keyOf: (id: string) => string;
  /** The link that opens a task in the panel (keeps the view and the filters). */
  taskHref: (task: WorkTask) => string;
  updateTask: (task: WorkTask, changes: Omit<TaskUpdate, "expected_version">, options?: { optimistic?: boolean }) => Promise<UpdateResult>;
  /** The server refused a date change because of a dependency: show its consequences instead. */
  onScheduleConflict: (task: WorkTask, change: TaskDateChange) => void;
  onAddSubtask: (parent: WorkTask) => void;
  filtered: boolean;
  /** Columns hidden in «Вид». */
  hidden: ReadonlySet<ListColumn>;
}

type RowProps = Omit<TaskListProps, "rows" | "groups" | "filtered" | "collapsed" | "hidden"> & {
  task: WorkTask;
  context: boolean;
  /** Tree mode: the expand / collapse button and the indent; grouped: a ↳ mark for subtasks. */
  tree: boolean;
  expanded: boolean;
  shown: readonly ListColumn[];
};

export function TaskList({ rows, groups, filtered, collapsed, hidden, ...rowProps }: TaskListProps) {
  const [limit, setLimit] = useState(LIST_PAGE);
  const shown = LIST_COLUMNS.filter((column) => !hidden.has(column));
  const total = groups ? groups.reduce((n, g) => n + g.tasks.length, 0) : rows.length;
  if (!total) {
    return (
      <div className="work-empty">
        <p className="work-empty__title">{filtered ? "Нет задач по этим фильтрам" : "В проекте пока нет задач"}</p>
        <p className="muted">{filtered ? "Измените или сбросьте фильтры." : rowProps.canWrite ? "Создайте первую задачу кнопкой «Задача»." : ""}</p>
      </div>
    );
  }

  let budget = limit;
  const body: ReactNode[] = [];
  if (groups) {
    for (const group of groups) {
      if (budget <= 0) break;
      const tasks = group.tasks.slice(0, budget);
      budget -= tasks.length;
      body.push(
        <tbody key={group.key} className="task-group" data-group={group.key}>
          <tr className="task-group__head">
            <th scope="colgroup" colSpan={shown.length + 2}>
              <span className="task-group__title">
                {group.status ? <StatusShape status={group.status} /> : null}
                {group.priority ? <PriorityBars priority={group.priority} /> : null}
                {group.assignee !== undefined ? <Avatar name={group.assignee?.display_name ?? null} /> : null}
                {group.label}
                <span className="task-group__count">{group.tasks.length}</span>
              </span>
            </th>
          </tr>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} context={false} tree={false} expanded shown={shown} {...rowProps} />
          ))}
        </tbody>,
      );
    }
  } else {
    body.push(
      <tbody key="tree">
        {rows.slice(0, limit).map((row) => (
          <TaskRow key={row.task.id} task={row.task} context={row.context} tree expanded={!collapsed.has(row.task.id)} shown={shown} {...rowProps} />
        ))}
      </tbody>,
    );
  }

  return (
    <div className="task-table-wrap">
      <table className={`task-table${groups ? " task-table--grouped" : ""}`}>
        <caption className="visually-hidden">
          {groups ? "Задачи проекта по группам" : "Задачи проекта (дерево: подзадачи под своей задачей)"}
        </caption>
        <colgroup>
          <col className="task-table__col-title" />
          {shown.map((column) => (
            <col key={column} className={`task-table__col-${column}`} />
          ))}
          <col className="task-table__col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Задача</th>
            {shown.map((column) => (
              <th key={column} scope="col">
                {LIST_COLUMN_LABEL[column]}
              </th>
            ))}
            <th scope="col">
              <span className="visually-hidden">Действия</span>
            </th>
          </tr>
        </thead>
        {body}
      </table>
      {total > limit ? (
        <p className="task-table__more">
          <button type="button" className="button button--secondary button--sm" onClick={() => setLimit((n) => n + LIST_PAGE)}>
            Показать ещё {Math.min(LIST_PAGE, total - limit)} из {total - limit}
          </button>
        </p>
      ) : null}
    </div>
  );
}

function Avatar({ name }: { name: string | null }) {
  if (!name) return <span className="list-avatar list-avatar--none" aria-hidden="true" />;
  return (
    <span className="list-avatar" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** A failed save, shown at its cell (the page message says it too). */
interface CellError {
  column: ListColumn;
  text: string;
}

const TaskRow = memo(function TaskRow(props: RowProps) {
  const { task, context, tree, expanded, shown, onToggle, canWrite, assignees, today, maxDepth, keyOf, taskHref, updateTask, onScheduleConflict, onAddSubtask } = props;
  const navigate = useNavigate();
  const [error, setError] = useState<CellError | null>(null);
  const editDates = canWrite && !task.date_locked;
  const name = `${task.key} ${task.title}`;

  async function save(column: ListColumn, changes: Omit<TaskUpdate, "expected_version">, options?: { optimistic?: boolean }) {
    const result = await updateTask(task, changes, options);
    if (result.ok) setError(null);
    else if (result.error.code !== "stale_task" && !(result.error.code === "schedule_conflict" && result.error.details.reason === "fs_violation")) {
      setError({ column, text: result.error.message });
    }
    return result;
  }

  async function saveDates(changes: Omit<TaskUpdate, "expected_version">, preview: TaskDateChange | null) {
    const result = await save("dates", changes, { optimistic: false });
    if (!result.ok && result.error.code === "schedule_conflict" && result.error.details.reason === "fs_violation" && preview) {
      onScheduleConflict(task, preview);
    }
  }

  const errorMark = (column: ListColumn) =>
    error?.column === column ? <Icon name="alert" size={13} className="list-cell__error" label={`Не сохранено: ${error.text}`} /> : null;

  const cells: Record<ListColumn, ReactNode> = {
    status: (
      <td key="status" data-label="Статус">
        <StatusCell task={task} name={name} canWrite={canWrite} onChange={(status) => void save("status", { status })} />
        {errorMark("status")}
      </td>
    ),
    assignee: (
      <td key="assignee" data-label="Исполнитель">
        <AssigneeCell task={task} name={name} canWrite={canWrite} assignees={assignees} onChange={(assignee_id) => void save("assignee", { assignee_id })} />
        {errorMark("assignee")}
      </td>
    ),
    priority: (
      <td key="priority" data-label="Приоритет">
        <PriorityCell task={task} name={name} canWrite={canWrite} onChange={(priority) => void save("priority", { priority })} />
        {errorMark("priority")}
      </td>
    ),
    dates: (
      <td key="dates" data-label="Сроки" className="task-row__date">
        <DatesCell task={task} today={today} editable={editDates} onSave={saveDates} />
        {errorMark("dates")}
      </td>
    ),
    due: (
      <td key="due" data-label="Срок сдачи" className={`task-row__date${task.overdue ? " is-overdue" : ""}`}>
        <DueCell task={task} today={today} editable={canWrite} onSave={(due_date) => void save("due", { due_date })} />
        {errorMark("due")}
      </td>
    ),
  };

  const parentKey = task.parent_task_id ? keyOf(task.parent_task_id) : null;
  const actions: MenuGroup[] = [
    {
      items: [
        { id: "open", label: "Открыть задачу", icon: "documents", onSelect: () => navigate(taskHref(task)) },
        ...(canWrite && task.depth < maxDepth && !task.is_milestone
          ? [{ id: "subtask", label: "Добавить подзадачу", icon: "plus" as const, onSelect: () => onAddSubtask(task) }]
          : []),
      ],
    },
  ];

  return (
    <tr className={`task-row${context ? " is-context" : ""}${task.status === "done" ? " is-done" : ""}`} data-task-key={task.key} data-depth={task.depth}>
      <td className="task-row__title" style={{ ["--depth" as string]: tree ? task.depth - 1 : 0 }}>
        <span className="task-row__tree">
          {tree ? (
            task.child_count > 0 ? (
              <button
                type="button"
                className="task-row__toggle"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Свернуть" : "Развернуть"} подзадачи ${task.key}`}
                onClick={() => onToggle(task.id)}
              >
                <Icon name="chevron" size={14} />
              </button>
            ) : (
              <span className="task-row__toggle-space" aria-hidden="true" />
            )
          ) : null}
          <span className="task-row__key">{task.key}</span>
          {task.is_milestone ? <Icon name="milestone" size={12} strokeWidth={2.2} className="task-row__milestone" label="Веха" /> : null}
          {!tree && parentKey ? (
            <span className="task-row__sub" title={`Подзадача ${parentKey}`}>
              <Icon name="subtask" size={13} label={`Подзадача ${parentKey}`} />
            </span>
          ) : null}
          <span className="task-row__name">
            {canWrite ? (
              <InlineText value={task.title} label={`Название ${task.key}`} maxLength={200} onCommit={(title) => void updateTask(task, { title })}>
                <Link to={taskHref(task)} className="task-row__link">
                  {task.title}
                </Link>
              </InlineText>
            ) : (
              <Link to={taskHref(task)} className="task-row__link">
                {task.title}
              </Link>
            )}
          </span>
          <TaskTags task={task} keyOf={keyOf} />
        </span>
        {context ? <span className="visually-hidden"> (не подходит под фильтры, показана как родитель)</span> : null}
      </td>
      {shown.map((column) => cells[column])}
      <td className="task-row__actions">
        <Menu
          label={`Действия ${task.key}`}
          align="end"
          groups={actions}
          trigger={(menuProps) => <IconButton {...menuProps} icon="more" size="sm" label={`Действия ${task.key}`} className="task-row__more" />}
        />
      </td>
    </tr>
  );
});

/** Small grey tags after the title: waits for a predecessor, linked documents, late; they give way before the title. */
function TaskTags({ task, keyOf }: { task: WorkTask; keyOf: (id: string) => string }) {
  const waits = task.is_blocked && task.blocked_by.length ? task.blocked_by.map(keyOf).join(", ") : "";
  if (!waits && !task.link_count && !(task.late && !task.overdue)) return null;
  return (
    <span className="task-tags">
      {task.late && !task.overdue ? <Icon name="clock" size={12} className="task-tags__late" label="Отстаёт от плана" /> : null}
      {waits ? (
        <span className="task-tag" title={`Ждёт предшественника: ${waits}`}>
          <Icon name="clock" size={12} />
          <span className="visually-hidden">ждёт </span>
          {waits}
        </span>
      ) : null}
      {task.link_count ? (
        <span className="task-tag" title="Связанные документы">
          <Icon name="documents" size={12} />
          <span className="visually-hidden">документов: </span>
          {task.link_count}
        </span>
      ) : null}
    </span>
  );
}

// --- cells -----------------------------------------------------------------------------------------------------

function StatusCell({ task, name, canWrite, onChange }: { task: WorkTask; name: string; canWrite: boolean; onChange: (status: TaskStatus) => void }) {
  if (!canWrite) return <TaskStatusMark status={task.status} className="list-cell list-cell--static" />;
  return (
    <Menu
      label={`Статус ${task.key}`}
      className="list-cell-menu"
      groups={[
        {
          radio: true,
          items: TASK_STATUS_ORDER.map((status, index) => ({
            id: status,
            label: TASK_STATUS_LABEL[status],
            lead: <StatusShape status={status} />,
            shortcut: String(index + 1),
            checked: task.status === status,
            onSelect: () => {
              if (status !== task.status) onChange(status);
            },
          })),
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className="list-cell" aria-label={`Статус ${name}: ${TASK_STATUS_LABEL[task.status]}`}>
          <TaskStatusMark status={task.status} />
        </button>
      )}
    />
  );
}

function AssigneeCell({
  task,
  name,
  canWrite,
  assignees,
  onChange,
}: {
  task: WorkTask;
  name: string;
  canWrite: boolean;
  assignees: AssigneeRef[];
  onChange: (assigneeId: string | null) => void;
}) {
  const who = task.assignee_id ? (task.assignee?.display_name ?? task.assignee_id) : null;
  const shown = (
    <>
      <Avatar name={who} />
      <span className={who ? "list-cell__text" : "list-cell__text muted"}>{who ?? "Не назначен"}</span>
    </>
  );
  if (!canWrite) return <span className="list-cell list-cell--static">{shown}</span>;
  const choose = (id: string | null) => () => {
    if (id !== task.assignee_id) onChange(id);
  };
  const roles = [...new Set(assignees.flatMap((a) => (a.role ? [a.role] : [])))];
  const known = assignees.some((a) => a.id === task.assignee_id);
  const groups: MenuGroup[] = [
    {
      radio: true,
      items: [
        { id: "none", label: "Не назначен", checked: !task.assignee_id, onSelect: choose(null) },
        ...(task.assignee_id && !known ? [{ id: task.assignee_id, label: who ?? task.assignee_id, checked: true, onSelect: choose(task.assignee_id) }] : []),
        ...assignees.filter((a) => !a.role).map((a) => ({ id: a.id, label: a.display_name, checked: task.assignee_id === a.id, onSelect: choose(a.id) })),
      ],
    },
    ...roles.map((role) => ({
      label: role,
      radio: true,
      items: assignees.filter((a) => a.role === role).map((a) => ({ id: a.id, label: a.display_name, checked: task.assignee_id === a.id, onSelect: choose(a.id) })),
    })),
  ];
  return (
    <Menu
      label={`Исполнитель ${task.key}`}
      className="list-cell-menu docs-filter-menu"
      groups={groups}
      trigger={(props) => (
        <button {...props} type="button" className="list-cell" aria-label={`Исполнитель ${name}: ${who ?? "не назначен"}`}>
          {shown}
        </button>
      )}
    />
  );
}

function PriorityCell({ task, name, canWrite, onChange }: { task: WorkTask; name: string; canWrite: boolean; onChange: (priority: TaskPriority) => void }) {
  if (!canWrite) return <PriorityMark priority={task.priority} />;
  return (
    <Menu
      label={`Приоритет ${task.key}`}
      className="list-cell-menu"
      groups={[
        {
          radio: true,
          items: PRIORITY_ORDER.map((priority) => ({
            id: priority,
            label: PRIORITY_LABEL[priority],
            lead: <PriorityBars priority={priority} />,
            checked: task.priority === priority,
            onSelect: () => {
              if (priority !== task.priority) onChange(priority);
            },
          })),
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className="list-cell" aria-label={`Приоритет ${name}: ${PRIORITY_LABEL[task.priority]}`}>
          <PriorityMark priority={task.priority} />
        </button>
      )}
    />
  );
}

/** Enter in a date field saves the form (the same in every browser and in tests); Esc is the popover's. */
function submitOnEnter(save: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    save();
  };
}

/** Start and last day (inclusive); a milestone has one date. Enter saves, Esc closes without saving. */
function DatesCell({
  task,
  today,
  editable,
  onSave,
}: {
  task: WorkTask;
  today: string;
  editable: boolean;
  onSave: (changes: Omit<TaskUpdate, "expected_version">, preview: TaskDateChange | null) => void;
}) {
  const label = formatPlanShort(task, today);
  if (!editable) {
    return (
      <span className="list-cell list-cell--static">
        {label}
        {task.date_locked ? <Icon name="lock" size={12} className="list-cell__lock" label="Сроки закреплены" /> : null}
      </span>
    );
  }
  return (
    <Popover
      id={`dates-${task.id}`}
      align="start"
      className="list-cell-anchor"
      panelClassName="list-editor"
      trigger={(props) => (
        <button {...props} type="button" className="list-cell" aria-label={`Сроки ${task.key}: ${label} — изменить`}>
          {label}
        </button>
      )}
    >
      {({ open, close }) => (open ? <DatesForm task={task} onDone={close} onSave={onSave} /> : null)}
    </Popover>
  );
}

function DatesForm({ task, onDone, onSave }: { task: WorkTask; onDone: () => void; onSave: (changes: Omit<TaskUpdate, "expected_version">, preview: TaskDateChange | null) => void }) {
  const id = useId();
  const [start, setStart] = useState(task.start_date ?? "");
  const [last, setLast] = useState(task.is_milestone ? "" : (task.last_day ?? ""));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    onDone();
    const startChanged = (start || null) !== task.start_date;
    const lastChanged = !task.is_milestone && task.scheduled && (last || null) !== task.last_day;
    if (!start) {
      if (task.scheduled) onSave({ start_date: null, end_exclusive: null }, null);
      return;
    }
    if (!task.scheduled) {
      const changes = task.is_milestone ? { start_date: start } : { start_date: start, duration_workdays: 1 };
      onSave(changes, { task_id: task.id, start_date: start, duration_workdays: task.is_milestone ? 0 : 1 });
      return;
    }
    if (startChanged && lastChanged && last) {
      const end = addDays(last, 1);
      onSave({ start_date: start, end_exclusive: end }, { task_id: task.id, start_date: start, end_exclusive: end });
    } else if (startChanged) {
      onSave({ start_date: start }, { task_id: task.id, start_date: start, duration_workdays: task.duration_workdays ?? 0 });
    } else if (lastChanged && last && task.start_date) {
      const end = addDays(last, 1); // the last day the user picked → the exclusive end
      onSave({ end_exclusive: end }, { task_id: task.id, start_date: task.start_date, end_exclusive: end });
    }
  }

  return (
    <form className="list-editor__form" onSubmit={submit} aria-label={`Сроки ${task.key}`}>
      <label className="list-editor__field" htmlFor={`${id}-start`}>
        <span>{task.is_milestone ? "Дата" : "Начало"}</span>
        <input
          ref={first}
          id={`${id}-start`}
          type="date"
          className="input"
          aria-label={`Начало ${task.key}`}
          value={start}
          onChange={(event) => setStart(event.target.value)}
          onKeyDown={submitOnEnter(() => submit())}
        />
      </label>
      {!task.is_milestone && task.scheduled ? (
        <label className="list-editor__field" htmlFor={`${id}-last`}>
          <span>Последний день</span>
          <input
            id={`${id}-last`}
            type="date"
            className="input"
            aria-label={`Последний день ${task.key}`}
            value={last}
            min={start || undefined}
            onChange={(event) => setLast(event.target.value)}
            onKeyDown={submitOnEnter(() => submit())}
          />
        </label>
      ) : null}
      <p className="list-editor__hint muted">Последний день — включительно; выходные не считаются рабочими.</p>
      <div className="list-editor__actions">
        <Button type="submit" size="sm" variant="primary">
          Сохранить
        </Button>
        {task.scheduled ? (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              onDone();
              onSave({ start_date: null, end_exclusive: null }, null);
            }}
          >
            Снять даты
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The deadline (inclusive): red when it has passed; «—» when there is none. */
function DueCell({ task, today, editable, onSave }: { task: WorkTask; today: string; editable: boolean; onSave: (due: string | null) => void }) {
  const label = task.due_date ? formatDay(task.due_date, today) : "—";
  const overdue = task.overdue ? <span className="visually-hidden"> Просрочена (срок {formatDay(task.due_date, today)})</span> : null;
  if (!editable) {
    return (
      <span className="list-cell list-cell--static">
        {label}
        {overdue}
      </span>
    );
  }
  return (
    <Popover
      id={`due-${task.id}`}
      align="start"
      className="list-cell-anchor"
      panelClassName="list-editor"
      trigger={(props) => (
        <button {...props} type="button" className="list-cell" aria-label={`Срок ${task.key}: ${task.due_date ? label : "не задан"}${task.overdue ? ", просрочена" : ""} — изменить`}>
          {label}
          {overdue}
        </button>
      )}
    >
      {({ open, close }) => (open ? <DueForm task={task} onDone={close} onSave={onSave} /> : null)}
    </Popover>
  );
}

function DueForm({ task, onDone, onSave }: { task: WorkTask; onDone: () => void; onSave: (due: string | null) => void }) {
  const [due, setDue] = useState(task.due_date ?? "");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  function submit(event?: FormEvent) {
    event?.preventDefault();
    onDone();
    if ((due || null) !== task.due_date) onSave(due || null);
  }
  return (
    <form className="list-editor__form" aria-label={`Срок сдачи ${task.key}`} onSubmit={submit}>
      <label className="list-editor__field">
        <span>Срок сдачи (включительно)</span>
        <input
          ref={field}
          type="date"
          className="input"
          aria-label={`Срок ${task.key}`}
          value={due}
          onChange={(event) => setDue(event.target.value)}
          onKeyDown={submitOnEnter(() => submit())}
        />
      </label>
      <div className="list-editor__actions">
        <Button type="submit" size="sm" variant="primary">
          Сохранить
        </Button>
        {task.due_date ? (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              onDone();
              onSave(null);
            }}
          >
            Очистить
          </Button>
        ) : null}
      </div>
    </form>
  );
}

