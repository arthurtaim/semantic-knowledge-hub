import type { AssigneeRef, TaskPriority, TaskStatus, WorkCapabilities, WorkTask } from "../../api/types";
import { formatDay, PRIORITY_LABEL, TASK_STATUS_LABEL } from "../../lib/work";
import { Icon } from "../ui/Icon";

/*
 * Small shared pieces of the M6 screens. A state is always text plus shape, never colour alone
 * (docs/ui-v2/specs/01_VISUAL_SYSTEM.md): a status is a hollow ring / half / dot / tick, a priority a bar count.
 */

/** The work mode as the server reports it: «Локальная демонстрация — один оператор», read-only and why. */
export function WorkModeNote({ capabilities }: { capabilities: WorkCapabilities | null }) {
  if (!capabilities) return null;
  const readOnly = !capabilities.can_write;
  return (
    <p className={`work-mode${readOnly ? " work-mode--read-only" : ""}`} data-mode={capabilities.mode}>
      <Icon name={readOnly ? "lock" : "info"} size={14} />
      <span>
        <span className="work-mode__label">{capabilities.label}</span>
        {readOnly && capabilities.read_only_reason ? <span className="work-mode__reason"> {capabilities.read_only_reason}</span> : null}
        {!capabilities.team_ready && capabilities.mode === "local_operator" ? (
          <span className="work-mode__reason"> Исполнители «(демо)» — вымышленная команда для примера, не учётные записи.</span>
        ) : null}
      </span>
    </p>
  );
}

export function TaskStatusMark({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span className={["task-status", `task-status--${status}`, className ?? ""].filter(Boolean).join(" ")} data-status={status}>
      {status === "done" ? (
        <Icon name="check" size={13} strokeWidth={2.25} className="task-status__icon" />
      ) : (
        <span className="task-status__shape" aria-hidden="true" />
      )}
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

const PRIORITY_BARS: Record<TaskPriority, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function PriorityMark({ priority, compact = false }: { priority: TaskPriority; compact?: boolean }) {
  const bars = PRIORITY_BARS[priority];
  return (
    <span className={`priority priority--${priority}`} data-priority={priority} title={compact ? `Приоритет: ${PRIORITY_LABEL[priority]}` : undefined}>
      <span className="priority__bars" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= bars ? "is-on" : undefined} />
        ))}
      </span>
      <span className={compact ? "visually-hidden" : undefined}>{compact ? `Приоритет: ${PRIORITY_LABEL[priority]}` : PRIORITY_LABEL[priority]}</span>
    </span>
  );
}

/** Milestone, blocked, overdue / late, pinned dates — each a word with a shape. */
export function TaskFlags({ task, keyOf, today }: { task: WorkTask; keyOf?: (id: string) => string; today?: string }) {
  const flags = [];
  if (task.is_milestone) {
    flags.push(
      <span key="m" className="task-flag task-flag--milestone">
        <Icon name="milestone" size={12} strokeWidth={2} />
        Веха
      </span>,
    );
  }
  if (task.is_blocked) {
    const by = keyOf ? task.blocked_by.map(keyOf).join(", ") : "";
    flags.push(
      <span key="b" className="task-flag task-flag--blocked" title={by ? `Ждёт: ${by}` : undefined}>
        <Icon name="dependency" size={12} strokeWidth={2} />
        {by ? `Ждёт ${by}` : "Ждёт предшественников"}
      </span>,
    );
  }
  if (task.overdue) {
    flags.push(
      <span key="o" className="task-flag task-flag--overdue">
        <Icon name="alert" size={12} strokeWidth={2} />
        Просрочена{task.due_date ? ` (срок ${formatDay(task.due_date, today)})` : ""}
      </span>,
    );
  } else if (task.late) {
    flags.push(
      <span key="l" className="task-flag task-flag--overdue">
        <Icon name="clock" size={12} strokeWidth={2} />
        Отстаёт от плана
      </span>,
    );
  }
  if (task.date_locked) {
    flags.push(
      <span key="k" className="task-flag task-flag--locked">
        <Icon name="lock" size={12} strokeWidth={2} />
        Сроки закреплены
      </span>,
    );
  }
  if (!flags.length) return null;
  return <span className="task-flags">{flags}</span>;
}

export function AssigneeName({ task }: { task: Pick<WorkTask, "assignee" | "assignee_id"> }) {
  if (!task.assignee_id) return <span className="muted">Не назначен</span>;
  return <span title={task.assignee?.role ?? undefined}>{task.assignee?.display_name ?? task.assignee_id}</span>;
}

/** The options of an assignee select: people without a role first, then the demo team grouped by role. */
export function AssigneeOptions({ assignees }: { assignees: AssigneeRef[] }) {
  const roles = [...new Set(assignees.flatMap((a) => (a.role ? [a.role] : [])))];
  const option = (a: AssigneeRef) => (
    <option key={a.id} value={a.id}>
      {a.display_name}
    </option>
  );
  return (
    <>
      {assignees.filter((a) => !a.role).map(option)}
      {roles.map((role) => (
        <optgroup key={role} label={role}>
          {assignees.filter((a) => a.role === role).map(option)}
        </optgroup>
      ))}
    </>
  );
}

/** A live region for the result of an action (saved, rolled back, applied). */
export function WorkAnnouncer({ text, tone }: { text: string | null; tone?: "info" | "success" | "warning" | "danger" }) {
  return (
    <div className={`work-announcer${text ? ` work-announcer--${tone ?? "info"}` : ""}`} role="status" aria-live="polite">
      {text}
    </div>
  );
}
