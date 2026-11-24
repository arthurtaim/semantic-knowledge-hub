import type {
  AssigneeRef,
  SchedulePreview,
  WorkCapabilities,
  WorkDependency,
  WorkGantt,
  WorkProject,
  WorkTask,
} from "../api/types";
import type { MockRoute } from "./helpers";

/* Synthetic M6 data for the UI tests (shapes of docs/API_CONTRACTS.md «v0.7»). */

export const TODAY = "2026-11-25";

export function capabilities(overrides: Partial<WorkCapabilities> = {}): WorkCapabilities {
  return {
    enabled: true,
    mode: "local_operator",
    label: "Локальная демонстрация — один оператор",
    can_write: true,
    can_view_audit: true,
    read_only_reason: null,
    team_ready: false,
    identity: { user_id: "local-demo-user", display_name: "Демо-пользователь (localhost)", kind: "local_operator" },
    calendar: { id: "mon_fri_v1", kind: "mon_fri", workdays: [1, 2, 3, 4, 5], holidays: [], timezone: "Europe/Moscow", interval: "[start_date, end_exclusive)" },
    statuses: ["todo", "in_progress", "review", "done"],
    priorities: ["low", "medium", "high", "critical"],
    project_statuses: ["active", "on_hold", "completed", "archived"],
    schedule_modes: ["only_this_task", "shift_successors", "resolve_violations"],
    link_relations: ["implements", "requires", "documents", "verifies", "blocks"],
    limits: {
      max_depth: 4,
      title_max: 200,
      description_max: 20000,
      page_max: 500,
      preview_changes_max: 200,
      preview_dependencies_max: 200,
      max_tasks_per_project: 5000,
      preview_ttl_seconds: 900,
    },
    features: { critical_path: false, comments: false, document_links: false, ai_proposals: false, lag: false },
    ...overrides,
  };
}

export const READ_ONLY = capabilities({
  mode: "read_only",
  label: "Только просмотр — изменения задач отключены",
  can_write: false,
  can_view_audit: false,
  read_only_reason: "Приложение доступно по общей/публичной ссылке (WORK_PUBLIC_EXPOSURE=true): без настоящей идентификации пользователей изменения задач отключены.",
});

export function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return {
    id: "p1",
    key: "ARIS",
    title: "ARIS Metadata Integration (демо)",
    description: "ДЕМО-ДАННЫЕ. Интеграция метаданных ARIS.",
    status: "active",
    timezone: "Europe/Moscow",
    calendar: "mon_fri_v1",
    start_date: "2026-11-02",
    target_date: "2026-12-10",
    is_demo: true,
    version: 1,
    plan_revision: 7,
    created_by: "system:demo-seed",
    created_at: "2026-11-24T10:00:00Z",
    updated_by: "system:demo-seed",
    updated_at: "2026-11-24T10:00:00Z",
    archived_at: null,
    stats: {
      total: 14,
      by_status: { todo: 5, in_progress: 4, review: 0, done: 5 },
      open: 9,
      blocked: 7,
      overdue: 1,
      milestones: 2,
      unscheduled: 1,
      next_milestone: { task_id: "t10", key: "ARIS-10", title: "Маппинг согласован", date: "2026-11-27" },
    },
    my_role: "local_operator",
    ...overrides,
  };
}

let counter = 0;

export function task(overrides: Partial<WorkTask> & { key: string }): WorkTask {
  counter += 1;
  const number = Number(overrides.key.split("-")[1] ?? counter);
  const base: WorkTask = {
    id: `t${number}`,
    project_id: "p1",
    key: overrides.key,
    number,
    parent_task_id: null,
    depth: 1,
    title: `Задача ${number}`,
    description: "",
    status: "todo",
    priority: "medium",
    assignee_id: null,
    assignee: null,
    reporter_id: "local-demo-user",
    estimate_workdays: null,
    start_date: null,
    end_exclusive: null,
    last_day: null,
    duration_workdays: null,
    due_date: null,
    is_milestone: false,
    date_locked: false,
    scheduled: false,
    sort_order: number,
    is_demo: true,
    version: 1,
    created_by: "local-demo-user",
    created_at: "2026-11-24T10:00:00Z",
    updated_by: "local-demo-user",
    updated_at: "2026-11-24T10:00:00Z",
    archived_at: null,
    blocked_by: [],
    is_blocked: false,
    overdue: false,
    late: false,
    child_count: 0,
    link_count: 0,
    document_ids: [],
  };
  const merged = { ...base, ...overrides };
  if (merged.start_date && merged.end_exclusive) merged.scheduled = true;
  return merged;
}

export const ASSIGNEES: AssigneeRef[] = [
  { id: "local-demo-user", display_name: "Демо-пользователь (localhost)", kind: "operator" },
  { id: "demo-analyst", display_name: "Аналитик (демо)", kind: "fixture" },
  { id: "demo-engineer", display_name: "Инженер данных (демо)", kind: "fixture" },
];

/**
 * A small plan: ARIS-1 (parent, done) with ARIS-2 (subtask) and ARIS-3 (sub-subtask); FS ARIS-4 → ARIS-5 → ARIS-6
 * (milestone); ARIS-7 without dates; ARIS-8 locked; ARIS-9 late and overdue.
 */
export function planTasks(): WorkTask[] {
  return [
    task({ key: "ARIS-1", title: "Анализ источника", status: "done", start_date: "2026-11-02", end_exclusive: "2026-11-10", last_day: "2026-11-09", duration_workdays: 6, child_count: 1, priority: "high" }),
    task({ key: "ARIS-2", title: "Инвентаризация моделей", parent_task_id: "t1", depth: 2, status: "done", start_date: "2026-11-02", end_exclusive: "2026-11-05", last_day: "2026-11-04", duration_workdays: 3, child_count: 1 }),
    task({ key: "ARIS-3", title: "Опросник для интервью", parent_task_id: "t2", depth: 3, status: "done", start_date: "2026-11-02", end_exclusive: "2026-11-04", last_day: "2026-11-03", duration_workdays: 2 }),
    task({
      key: "ARIS-4",
      title: "Маппинг метаданных",
      status: "in_progress",
      start_date: "2026-11-27",
      end_exclusive: "2026-11-28",
      last_day: "2026-11-27",
      duration_workdays: 1,
      assignee_id: "demo-analyst",
      assignee: ASSIGNEES[1] ?? null,
    }),
    task({ key: "ARIS-5", title: "Загрузчик", start_date: "2026-11-30", end_exclusive: "2026-12-02", last_day: "2026-12-01", duration_workdays: 2, blocked_by: ["t4"], is_blocked: true }),
    task({ key: "ARIS-6", title: "Готовность к пилоту", is_milestone: true, start_date: "2026-12-02", end_exclusive: "2026-12-02", duration_workdays: 0, priority: "critical", blocked_by: ["t5"], is_blocked: true, due_date: "2026-12-02" }),
    task({ key: "ARIS-7", title: "Документация без дат" }),
    task({ key: "ARIS-8", title: "Закреплённая проверка", date_locked: true, start_date: "2026-12-07", end_exclusive: "2026-12-09", last_day: "2026-12-08", duration_workdays: 2 }),
    task({
      key: "ARIS-9",
      title: "Сопоставить атрибуты",
      status: "in_progress",
      start_date: "2026-11-16",
      end_exclusive: "2026-11-20",
      last_day: "2026-11-19",
      duration_workdays: 4,
      due_date: "2026-11-19",
      overdue: true,
      late: true,
    }),
  ];
}

export function dependency(id: string, pred: string, succ: string, satisfied: boolean | null = true): WorkDependency {
  return { id, project_id: "p1", predecessor_id: pred, successor_id: succ, kind: "FS", lag_workdays: 0, created_by: "local-demo-user", created_at: "2026-11-24T10:00:00Z", satisfied };
}

export function gantt(tasks: WorkTask[] = planTasks(), overrides: Partial<WorkGantt> = {}): WorkGantt {
  return {
    project_id: "p1",
    project_key: "ARIS",
    plan_revision: 7,
    snapshot_at: "2026-11-25T09:00:00Z",
    today: TODAY,
    calendar: capabilities().calendar,
    tasks,
    dependencies: [dependency("d1", "t4", "t5"), dependency("d2", "t5", "t6")],
    unscheduled_task_ids: tasks.filter((t) => !t.scheduled).map((t) => t.id),
    violations: [],
    range_start: "2026-11-02",
    range_end_exclusive: "2026-12-09",
    critical_path: null,
    features: { critical_path: false, dependency_kinds: ["FS"], lag: false },
    ...overrides,
  };
}

export function preview(overrides: Partial<SchedulePreview> = {}): SchedulePreview {
  return {
    preview_id: "pv1",
    project_id: "p1",
    mode: "shift_successors",
    base_plan_revision: 7,
    calendar: "mon_fri_v1",
    input_hash: "h",
    operations: [
      {
        task_id: "t4",
        key: "ARIS-4",
        title: "Маппинг метаданных",
        change: "requested",
        before: { start_date: "2026-11-27", end_exclusive: "2026-11-28", last_day: "2026-11-27", duration_workdays: 1 },
        after: { start_date: "2026-11-30", end_exclusive: "2026-12-01", last_day: "2026-11-30", duration_workdays: 1 },
        shift_workdays: 1,
        reason: "requested",
        because_of: [],
        version: 1,
      },
      {
        task_id: "t5",
        key: "ARIS-5",
        title: "Загрузчик",
        change: "shifted",
        before: { start_date: "2026-11-30", end_exclusive: "2026-12-02", last_day: "2026-12-01", duration_workdays: 2 },
        after: { start_date: "2026-12-01", end_exclusive: "2026-12-03", last_day: "2026-12-02", duration_workdays: 2 },
        shift_workdays: 1,
        reason: "fs_predecessor",
        because_of: ["t4"],
        version: 1,
      },
    ],
    added_dependencies: [],
    conflicts: [],
    warnings: [],
    blocked_tasks: [],
    unchanged: ["t8"],
    can_apply: true,
    critical_path: null,
    created_at: "2026-11-25T09:00:00Z",
    expires_at: "2026-11-25T09:15:00Z",
    ...overrides,
  };
}

/** The four reads of a project page; `tasks`/`caps` can be functions to answer differently on a re-read. */
export function projectRoutes(options: { caps?: WorkCapabilities; snapshot?: WorkGantt | (() => WorkGantt); proj?: WorkProject } = {}): MockRoute[] {
  return [
    { path: "/api/work/capabilities", body: options.caps ?? capabilities() },
    { path: "/api/projects/ARIS", body: options.proj ?? project() },
    { path: "/api/projects/ARIS/gantt", body: options.snapshot ?? gantt() },
    { path: /^\/api\/work\/assignees/, body: ASSIGNEES },
    { path: /^\/api\/tasks\/[^/]+\/dependencies$/, body: { task_id: "t4", plan_revision: 7, predecessors: [], successors: [] } },
    { path: /^\/api\/tasks\/[^/]+\/activity/, body: { items: [], next_before_seq: null } },
  ];
}

/** jsdom has no PointerEvent (as in graphCanvas.test.tsx): a minimal one, and animation frames run at once. */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

export function stubPointerAndFrames(stub: (name: string, value: unknown) => void) {
  stub("PointerEvent", TestPointerEvent);
  stub("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  stub("cancelAnimationFrame", () => {});
}
