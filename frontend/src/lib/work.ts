import type {
  LinkRelation,
  LinkState,
  ProjectStatus,
  ScheduleMode,
  TaskPriority,
  TaskStatus,
  WorkAccessMode,
  WorkCapabilities,
  WorkProject,
  WorkTask,
} from "../api/types";
import { readPreference, writePreference } from "./storage";

/*
 * M6 Work Management in the UI (docs/WORK_MANAGEMENT.md «UI»): labels, the project-local calendar (a mirror of
 * backend/app/work/calendar.py — only for drawing and for the ghost of a drag; the server computes every real
 * date), the filter state kept in the URL and the task tree. The Gantt's geometry is lib/gantt.ts.
 *
 * Dates are `YYYY-MM-DD` without a time zone. Arithmetic is done on whole day numbers (days since 1970-01-01, UTC),
 * so no local time zone or daylight saving can shift a date by one.
 */

// --- labels ------------------------------------------------------------------------------------------------------

export const TASK_STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "review", "done"];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "К работе",
  in_progress: "В работе",
  review: "На проверке",
  done: "Готово",
};

export const PRIORITY_ORDER: TaskPriority[] = ["critical", "high", "medium", "low"];

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  critical: "Критичный",
  high: "Высокий",
  medium: "Средний",
  low: "Низкий",
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "Активный",
  on_hold: "Приостановлен",
  completed: "Завершён",
  archived: "В архиве",
};

export const SCHEDULE_MODE_LABEL: Record<Exclude<ScheduleMode, "resolve_violations">, string> = {
  shift_successors: "Сдвинуть зависимые",
  only_this_task: "Только эта задача",
};

/** What the audit operation means, for «История». */
export const ACTIVITY_LABEL: Record<string, string> = {
  project_created: "создал(а) проект",
  project_updated: "изменил(а) проект",
  task_created: "создал(а) задачу",
  task_updated: "изменил(а) задачу",
  task_archived: "отправил(а) задачу в архив",
  task_restored: "вернул(а) задачу из архива",
  dependency_added: "добавил(а) зависимость",
  dependency_removed: "убрал(а) зависимость",
  schedule_applied: "применил(а) изменение сроков",
  link_added: "связал(а) задачу с документом",
  link_removed: "убрал(а) связь с документом",
  link_revision_acknowledged: "отметил(а) изменённый документ как проверенный",
  proposal_created: "получил(а) предложение AI",
  proposal_applied: "создал(а) задачи по предложению AI",
  proposal_rejected: "отклонил(а) предложение AI",
};

/** Field names of the audit `changes` map. */
export const FIELD_LABEL: Record<string, string> = {
  title: "Название",
  description: "Описание",
  status: "Статус",
  priority: "Приоритет",
  assignee_id: "Исполнитель",
  start_date: "Начало",
  end_exclusive: "Конец интервала",
  due_date: "Срок",
  is_milestone: "Веха",
  date_locked: "Сроки закреплены",
  estimate_workdays: "Оценка",
  parent_task_id: "Родитель",
  sort_order: "Порядок",
  archived_at: "Архив",
  predecessor: "Предшественник",
  successor: "Последователь",
  seed: "Синтетические демо-данные",
  document_id: "Документ",
  document: "Документ",
  relation: "Связь",
  revision_at_link: "Ревизия документа",
  proposal_id: "Предложение AI",
};

/** What a task does with a linked document. */
export const LINK_RELATION_LABEL: Record<LinkRelation, string> = {
  implements: "Реализует",
  requires: "Опирается на",
  documents: "Документирует",
  verifies: "Проверяет",
  blocks: "Блокирует",
};

export const LINK_RELATIONS: LinkRelation[] = ["implements", "requires", "documents", "verifies", "blocks"];

/** The state of a link for this reader, in words (unavailable on purpose names no document). */
export const LINK_STATE_LABEL: Record<LinkState, string> = {
  current: "Актуальна",
  revision_changed: "Документ изменён после связывания",
  revision_unknown: "Ревизия при связывании не записана",
  unavailable: "Документ недоступен — удалён или нет доступа",
  unverified: "Не проверено: база знаний сейчас недоступна",
};

/** A short revision for display: a content hash (`sha256:9ad39e83…` → `9ad39e83`) or a commit. */
export function shortRevision(revision: string | null | undefined): string {
  if (!revision) return "—";
  const value = revision.slice(revision.lastIndexOf(":") + 1);
  return value.length > 10 ? value.slice(0, 8) : value;
}

/** Server actor ids in words: the operator, a demo role, the demo seed; an unknown id is shown as it is. */
export function actorName(id: string, identity: { user_id: string; display_name: string } | null | undefined, assignees: { id: string; display_name: string }[]): string {
  if (identity && id === identity.user_id) return identity.display_name;
  if (id === "system:demo-seed") return "Демо-данные (синтетические)";
  return assignees.find((a) => a.id === id)?.display_name ?? id;
}

/** Server conflicts of a schedule preview, in words. */
export const CONFLICT_LABEL: Record<string, string> = {
  task_locked: "Сроки задачи закреплены",
  locked_successor: "Зависимой задаче с закреплёнными сроками пришлось бы сдвинуться",
  successor_violation: "Зависимая задача начнётся раньше окончания этой",
  requested_violates_predecessor: "Задача начнётся раньше окончания предшественника",
};

/** The reasons of `409 stale_schedule`. */
export const STALE_REASON_LABEL: Record<string, string> = {
  plan_revision: "план проекта изменился",
  snapshot_changed: "задачи или зависимости изменились",
  expired: "предпросмотр устарел",
  already_applied: "этот предпросмотр уже применён",
  task_changed: "одна из задач изменилась",
};

export function pluralWorkdays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} раб. дней`;
  if (last === 1) return `${n} раб. день`;
  if (last >= 2 && last <= 4) return `${n} раб. дня`;
  return `${n} раб. дней`;
}

// --- capabilities ------------------------------------------------------------------------------------------------

/** Roles that may change tasks of a project (membership: admin and member; the single operator, local or behind the
 * demo stand's one shared login). */
const WRITING_ROLES = new Set(["local_operator", "shared_login", "admin", "member"]);

/** Whether this reader may change tasks of `project`: the mode allows writes AND the project role does. */
export function canWriteProject(capabilities: WorkCapabilities | null, project: Pick<WorkProject, "my_role" | "status"> | null): boolean {
  if (!capabilities?.can_write || !project) return false;
  if (project.status === "archived") return false;
  return WRITING_ROLES.has(project.my_role);
}

export function isReadOnlyMode(mode: WorkAccessMode | undefined): boolean {
  return mode === "read_only";
}

// --- the calendar (mirror of backend/app/work/calendar.py) --------------------------------------------------------

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → whole days since 1970-01-01 (UTC); NaN for anything else. */
export function toDay(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return Number.NaN;
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDay(toDay(iso) + days);
}

/** ISO weekday: Monday 1 … Sunday 7 (1970-01-01 was a Thursday). */
export function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

export function isWorkday(day: number): boolean {
  return isoWeekday(day) <= 5;
}

export function nextWorkday(day: number): number {
  const weekday = isoWeekday(day);
  return weekday <= 5 ? day : day + (8 - weekday);
}

export function previousWorkday(day: number): number {
  const weekday = isoWeekday(day);
  return weekday <= 5 ? day : day - (weekday - 5);
}

/** Working days in `[start, endExclusive)`. */
export function countWorkdays(start: number, endExclusive: number): number {
  if (endExclusive <= start) return 0;
  const days = endExclusive - start;
  const weeks = Math.floor(days / 7);
  let total = weeks * 5;
  for (let offset = weeks * 7; offset < days; offset += 1) if (isWorkday(start + offset)) total += 1;
  return total;
}

/** `end_exclusive` of a task starting on `nextWorkday(start)` that lasts `duration` working days (0: a milestone). */
export function addWorkdays(start: number, duration: number): number {
  let day = nextWorkday(start);
  if (duration <= 0) return day;
  let left = duration - 1;
  while (left > 0) {
    day += 1;
    if (isWorkday(day)) left -= 1;
  }
  return day + 1;
}

/** The last occupied working day of `[start, endExclusive)`, or null when it holds none. */
export function lastWorkday(start: number, endExclusive: number): number | null {
  if (countWorkdays(start, endExclusive) === 0) return null;
  return previousWorkday(endExclusive - 1);
}

// --- formatting ----------------------------------------------------------------------------------------------------

const MONTHS_SHORT = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const WEEKDAYS_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** «27 нояб.» (and the year when it is not `yearOf`). A date-only value: no time zone applies. */
export function formatDay(iso: string | null | undefined, yearOf?: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  const year = yearOf && yearOf.slice(0, 4) === y ? "" : ` ${y}`;
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1] ?? m}${year}`;
}

/** «пт, 27 нояб.» */
export function formatDayWithWeekday(iso: string | null | undefined, yearOf?: string | null): string {
  if (!iso) return "—";
  const day = toDay(iso);
  if (Number.isNaN(day)) return iso;
  return `${WEEKDAYS_SHORT[isoWeekday(day) - 1]}, ${formatDay(iso, yearOf)}`;
}

/** The planned interval as the user reads it: «27 нояб. – 4 дек.», a milestone as one date, nothing as «Без дат». */
export function formatPlan(task: Pick<WorkTask, "start_date" | "last_day" | "is_milestone" | "scheduled">, yearOf?: string | null): string {
  if (!task.scheduled || !task.start_date) return "Без дат";
  if (task.is_milestone) return formatDay(task.start_date, yearOf);
  if (task.last_day === task.start_date) return formatDay(task.start_date, yearOf);
  return `${formatDay(task.start_date, yearOf)} – ${formatDay(task.last_day, yearOf)}`;
}

// --- the task tree -------------------------------------------------------------------------------------------------

export interface TaskTree {
  byId: Map<string, WorkTask>;
  children: Map<string | null, WorkTask[]>;
  /** Tree order: parents before children, siblings by sort_order then number (the server's order is kept). */
  ordered: WorkTask[];
}

/** Builds the tree from tasks in any order; the input order breaks ties between siblings. */
export function buildTree(tasks: WorkTask[]): TaskTree {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const children = new Map<string | null, WorkTask[]>();
  for (const task of tasks) {
    const parent = task.parent_task_id && byId.has(task.parent_task_id) ? task.parent_task_id : null;
    const list = children.get(parent);
    if (list) list.push(task);
    else children.set(parent, [task]);
  }
  const ordered: WorkTask[] = [];
  const walk = (parent: string | null) => {
    for (const task of children.get(parent) ?? []) {
      ordered.push(task);
      walk(task.id);
    }
  };
  walk(null);
  return { byId, children, ordered };
}

export function ancestorIds(tree: TaskTree, task: WorkTask): string[] {
  const result: string[] = [];
  let parent = task.parent_task_id;
  const seen = new Set<string>();
  while (parent && tree.byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    result.push(parent);
    parent = tree.byId.get(parent)?.parent_task_id ?? null;
  }
  return result;
}

// --- filters (one model for List, Board and Gantt; kept in the URL) ------------------------------------------------

export interface TaskFilters {
  q: string;
  status: TaskStatus[];
  priority: TaskPriority[];
  /** An assignee id, `none`, or "" (anyone). */
  assignee: string;
  overdue: boolean;
  milestone: boolean;
  /** A linked document id (case-insensitive), or "" (any). Only documents the reader can see are in `document_ids`. */
  doc: string;
}

export const EMPTY_FILTERS: TaskFilters = { q: "", status: [], priority: [], assignee: "", overdue: false, milestone: false, doc: "" };

const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function listParam<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T[] {
  const raw = params.get(name);
  if (!raw) return [];
  return raw.split(",").filter((value): value is T => (allowed as readonly string[]).includes(value));
}

export function filtersFromParams(params: URLSearchParams): TaskFilters {
  return {
    q: (params.get("q") ?? "").trim(),
    status: listParam(params, "status", TASK_STATUS_ORDER),
    priority: listParam(params, "priority", PRIORITY_ORDER),
    assignee: params.get("assignee") ?? "",
    overdue: params.get("overdue") === "1",
    milestone: params.get("milestone") === "1",
    doc: DOCUMENT_ID.test(params.get("doc") ?? "") ? (params.get("doc") ?? "") : "",
  };
}

/** URL changes for a filter model (empty values remove their key). */
export function filterParams(filters: TaskFilters): Record<string, string | null> {
  return {
    q: filters.q.trim() || null,
    status: filters.status.length ? filters.status.join(",") : null,
    priority: filters.priority.length ? filters.priority.join(",") : null,
    assignee: filters.assignee || null,
    overdue: filters.overdue ? "1" : null,
    milestone: filters.milestone ? "1" : null,
    doc: filters.doc || null,
  };
}

export function hasFilters(filters: TaskFilters): boolean {
  return Boolean(
    filters.q || filters.status.length || filters.priority.length || filters.assignee || filters.overdue || filters.milestone || filters.doc,
  );
}

export function countFilters(filters: TaskFilters): number {
  return (
    (filters.q ? 1 : 0) +
    (filters.status.length ? 1 : 0) +
    (filters.priority.length ? 1 : 0) +
    (filters.assignee ? 1 : 0) +
    (filters.overdue ? 1 : 0) +
    (filters.milestone ? 1 : 0) +
    (filters.doc ? 1 : 0)
  );
}

export function matchesFilters(task: WorkTask, filters: TaskFilters): boolean {
  if (filters.status.length && !filters.status.includes(task.status)) return false;
  if (filters.priority.length && !filters.priority.includes(task.priority)) return false;
  if (filters.assignee === "none" && task.assignee_id) return false;
  if (filters.assignee && filters.assignee !== "none" && task.assignee_id !== filters.assignee) return false;
  if (filters.overdue && !(task.overdue || task.late)) return false;
  if (filters.milestone && !task.is_milestone) return false;
  if (filters.doc) {
    const wanted = filters.doc.toUpperCase();
    if (!(task.document_ids ?? []).some((id) => id.toUpperCase() === wanted)) return false;
  }
  if (filters.q) {
    const needle = filters.q.toLocaleLowerCase("ru");
    if (!task.title.toLocaleLowerCase("ru").includes(needle) && !task.key.toLowerCase().includes(needle)) return false;
  }
  return true;
}

export interface VisibleRow {
  task: WorkTask;
  /** The task does not match the filters itself; it is shown as the context of a matching subtask. */
  context: boolean;
}

/**
 * The rows of a hierarchical view: every task when nothing is filtered (collapsed branches hidden); otherwise the
 * matching tasks with their ancestors as context rows (collapse still applies).
 */
export function visibleRows(tree: TaskTree, filters: TaskFilters, collapsed: ReadonlySet<string>): VisibleRow[] {
  const filtered = hasFilters(filters);
  let keep: Set<string> | null = null;
  let matching: Set<string> | null = null;
  if (filtered) {
    keep = new Set();
    matching = new Set();
    for (const task of tree.ordered) {
      if (!matchesFilters(task, filters)) continue;
      matching.add(task.id);
      keep.add(task.id);
      for (const id of ancestorIds(tree, task)) keep.add(id);
    }
  }
  const rows: VisibleRow[] = [];
  const walk = (parent: string | null) => {
    for (const task of tree.children.get(parent) ?? []) {
      if (keep && !keep.has(task.id)) continue;
      rows.push({ task, context: matching ? !matching.has(task.id) : false });
      if (!collapsed.has(task.id)) walk(task.id);
    }
  };
  walk(null);
  return rows;
}

// --- views ---------------------------------------------------------------------------------------------------------

export type WorkView = "list" | "board" | "gantt";
export const WORK_VIEWS: readonly WorkView[] = ["list", "board", "gantt"];
export const WORK_VIEW_LABEL: Record<WorkView, string> = { list: "Список", board: "Доска", gantt: "Гант" };
export const WORK_VIEW_KEY = "skh.work.view";

export function resolveWorkView(params: URLSearchParams): WorkView {
  const named = params.get("view");
  if (named && (WORK_VIEWS as readonly string[]).includes(named)) return named as WorkView;
  const stored = readPreference(WORK_VIEW_KEY);
  if (stored && (WORK_VIEWS as readonly string[]).includes(stored)) return stored as WorkView;
  return "list";
}

export function rememberWorkView(view: WorkView): void {
  writePreference(WORK_VIEW_KEY, view);
}
