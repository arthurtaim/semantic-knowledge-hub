import { memo, useState } from "react";
import { Link } from "react-router-dom";
import type { AssigneeRef, TaskDateChange, TaskPriority, TaskStatus, TaskUpdate, WorkTask } from "../../api/types";
import type { UpdateResult } from "../../lib/useWorkspace";
import {
  addDays,
  formatDay,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
  type VisibleRow,
} from "../../lib/work";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { InlineDate, InlineText } from "./InlineEdit";
import { AssigneeName, AssigneeOptions, PriorityMark, TaskFlags, TaskStatusMark } from "./WorkBits";

/*
 * «Список» (M6): the task tree as a table — subtasks up to four levels with expand / collapse, inline editing of
 * title, status, assignee, priority, dates and the deadline without a page reload (optimistic, rolled back on an
 * error; `409 stale_task` re-reads and says so). A date change that would break a Finish-to-Start dependency is
 * refused by the server (`fs_violation`); the row then offers the schedule preview instead.
 * Renders 200 rows at a time («Показать ещё»), so a project with thousands of tasks keeps a bounded DOM.
 */

export const LIST_PAGE = 200;

export interface TaskListProps {
  rows: VisibleRow[];
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
}

export function TaskList({ rows, filtered, collapsed, ...rowProps }: TaskListProps) {
  const [limit, setLimit] = useState(LIST_PAGE);
  if (!rows.length) {
    return (
      <div className="work-empty">
        <p className="work-empty__title">{filtered ? "Нет задач по этим фильтрам" : "В проекте пока нет задач"}</p>
        <p className="muted">{filtered ? "Измените или сбросьте фильтры." : rowProps.canWrite ? "Создайте первую задачу кнопкой «Задача»." : ""}</p>
      </div>
    );
  }
  const shown = rows.slice(0, limit);
  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <caption className="visually-hidden">Задачи проекта (дерево: подзадачи под своей задачей)</caption>
        <thead>
          <tr>
            <th scope="col" className="task-table__title-col">
              Задача
            </th>
            <th scope="col">Статус</th>
            <th scope="col">Исполнитель</th>
            <th scope="col">Приоритет</th>
            <th scope="col">Начало</th>
            <th scope="col">Окончание</th>
            <th scope="col">Срок</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <TaskRow key={row.task.id} row={row} expanded={!collapsed.has(row.task.id)} {...rowProps} />
          ))}
        </tbody>
      </table>
      {rows.length > limit ? (
        <p className="task-table__more">
          <button type="button" className="button button--secondary button--sm" onClick={() => setLimit((n) => n + LIST_PAGE)}>
            Показать ещё {Math.min(LIST_PAGE, rows.length - limit)} из {rows.length - limit}
          </button>
        </p>
      ) : null}
    </div>
  );
}

type RowProps = Omit<TaskListProps, "rows" | "filtered" | "collapsed"> & { row: VisibleRow; expanded: boolean };

const TaskRow = memo(function TaskRow({
  row,
  expanded,
  onToggle,
  canWrite,
  assignees,
  today,
  maxDepth,
  keyOf,
  taskHref,
  updateTask,
  onScheduleConflict,
  onAddSubtask,
}: RowProps) {
  const { task, context } = row;
  const editDates = canWrite && !task.date_locked;

  async function changeDates(changes: Omit<TaskUpdate, "expected_version">, preview: TaskDateChange | null) {
    const result = await updateTask(task, changes, { optimistic: false });
    if (!result.ok && result.error.code === "schedule_conflict" && result.error.details.reason === "fs_violation" && preview) {
      onScheduleConflict(task, preview);
    }
  }

  function commitStart(value: string | null) {
    if (value === null) {
      void changeDates({ start_date: null, end_exclusive: null }, null);
      return;
    }
    if (!task.scheduled) {
      const changes = task.is_milestone ? { start_date: value } : { start_date: value, duration_workdays: 1 };
      void changeDates(changes, { task_id: task.id, start_date: value, duration_workdays: task.is_milestone ? 0 : 1 });
      return;
    }
    void changeDates({ start_date: value }, { task_id: task.id, start_date: value, duration_workdays: task.duration_workdays ?? 0 });
  }

  function commitEnd(value: string | null) {
    if (!value || !task.start_date) return;
    const end = addDays(value, 1); // the last day the user picked → the exclusive end
    void changeDates({ end_exclusive: end }, { task_id: task.id, start_date: task.start_date, end_exclusive: end });
  }

  const name = `${task.key} ${task.title}`;
  return (
    <tr className={`task-row${context ? " is-context" : ""}${task.status === "done" ? " is-done" : ""}`} data-task-key={task.key} data-depth={task.depth}>
      <td className="task-row__title" style={{ ["--depth" as string]: task.depth - 1 }}>
        <span className="task-row__tree">
          {task.child_count > 0 ? (
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
          )}
          {task.is_milestone ? <Icon name="milestone" size={13} className="task-row__milestone" label="Веха" /> : null}
          <span className="task-row__key">{task.key}</span>
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
            {canWrite && task.depth < maxDepth && !task.is_milestone ? (
              <IconButton icon="plus" size="sm" label={`Добавить подзадачу к ${task.key}`} className="task-row__add" onClick={() => onAddSubtask(task)} />
            ) : null}
          </span>
        </span>
        <TaskFlags task={task} keyOf={keyOf} today={today} />
        {context ? <span className="visually-hidden"> (не подходит под фильтры, показана как родитель)</span> : null}
      </td>
      <td data-label="Статус">
        {canWrite ? (
          <select
            className="task-row__select"
            aria-label={`Статус ${name}`}
            value={task.status}
            onChange={(event) => void updateTask(task, { status: event.target.value as TaskStatus })}
          >
            {TASK_STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        ) : (
          <TaskStatusMark status={task.status} />
        )}
      </td>
      <td data-label="Исполнитель">
        {canWrite ? (
          <select
            className="task-row__select task-row__select--assignee"
            aria-label={`Исполнитель ${name}`}
            value={task.assignee_id ?? ""}
            onChange={(event) => void updateTask(task, { assignee_id: event.target.value || null })}
          >
            <option value="">Не назначен</option>
            {task.assignee_id && !assignees.some((a) => a.id === task.assignee_id) ? (
              <option value={task.assignee_id}>{task.assignee?.display_name ?? task.assignee_id}</option>
            ) : null}
            <AssigneeOptions assignees={assignees} />
          </select>
        ) : (
          <AssigneeName task={task} />
        )}
      </td>
      <td data-label="Приоритет">
        {canWrite ? (
          <select
            className="task-row__select"
            aria-label={`Приоритет ${name}`}
            value={task.priority}
            onChange={(event) => void updateTask(task, { priority: event.target.value as TaskPriority })}
          >
            {PRIORITY_ORDER.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABEL[priority]}
              </option>
            ))}
          </select>
        ) : (
          <PriorityMark priority={task.priority} />
        )}
      </td>
      <td data-label="Начало" className="task-row__date">
        <InlineDate
          value={task.start_date}
          display={task.start_date ? formatDay(task.start_date, today) : "Без дат"}
          label={`Начало ${task.key}`}
          allowClear
          disabled={!editDates}
          onCommit={commitStart}
        />
      </td>
      <td data-label="Окончание" className="task-row__date">
        {task.is_milestone || !task.scheduled ? (
          <span className="inline-date">{task.is_milestone && task.start_date ? "веха" : "—"}</span>
        ) : (
          <InlineDate
            value={task.last_day}
            display={formatDay(task.last_day, today)}
            label={`Последний день ${task.key}`}
            disabled={!editDates}
            min={task.start_date ?? undefined}
            onCommit={commitEnd}
          />
        )}
      </td>
      <td data-label="Срок" className={`task-row__date${task.overdue ? " is-overdue" : ""}`}>
        <InlineDate
          value={task.due_date}
          display={task.due_date ? formatDay(task.due_date, today) : "—"}
          label={`Срок ${task.key}`}
          allowClear
          disabled={!canWrite}
          onCommit={(value) => void updateTask(task, { due_date: value })}
        />
      </td>
    </tr>
  );
});
