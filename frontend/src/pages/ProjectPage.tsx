import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ProjectDocumentRef, ScheduleApplyResult, ScheduleOperation, SchedulePreview, TaskDateChange, TaskStatus, WorkTask } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { SidePanel, useSidePanelMode } from "../components/shell/SidePanel";
import { Button, IconButton } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { TaskCreateSheet } from "../components/work/CreateForms";
import { WorkPlanSheet } from "../components/work/WorkPlan";
import { GanttChart, type GanttHandle } from "../components/work/GanttChart";
import { GanttControls } from "../components/work/GanttControls";
import { ProjectStrip, projectSummary, type StripLayout } from "../components/work/ProjectStrip";
import { SchedulePreviewDialog, type ScheduleRequest } from "../components/work/SchedulePreviewDialog";
import { TaskBoard } from "../components/work/TaskBoard";
import { TaskDetail } from "../components/work/TaskDetail";
import { TaskFiltersBar } from "../components/work/TaskFiltersBar";
import { TaskList } from "../components/work/TaskList";
import { WorkModeNote, workModeText } from "../components/work/WorkBits";
import { withParams } from "../lib/docsView";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useWorkspace } from "../lib/useWorkspace";
import {
  buildTree,
  filterParams,
  filtersFromParams,
  hasFilters,
  matchesFilters,
  rememberWorkView,
  resolveWorkView,
  TASK_STATUS_LABEL,
  visibleRows,
  WORK_VIEW_LABEL,
  WORK_VIEWS,
  type TaskFilters,
  type VisibleRow,
  type WorkView,
} from "../lib/work";
import { writePreference } from "../lib/storage";
import { GANTT_ZOOM_KEY, resolveZoom, type GanttZoom } from "../lib/gantt";

/*
 * A project (M6, Planner v2 frame — docs/ui-v2/planner/specs/PLANNER_V2.md §2): the 52 px toolbar (path, key,
 * «Список | Доска | Гант», «План с ассистентом», «Задача»), one project line (ProjectStrip), the work mode — a tooltip
 * of «Демо-данные» while writes are allowed, a visible line with a lock when they are not — and one row of filters
 * with the view's controls at its right end; then the view.
 *
 * «Список | Доска | Гант» over ONE snapshot of its tasks (lib/useWorkspace.ts) with one filter model;
 * the view, the filters, the Gantt zoom and the open task live in the URL (`?view=gantt&status=todo&task=ARIS-3`), so
 * Back / Forward and a sent link restore them; the view is also remembered in this browser. One task panel serves
 * all three views (docked ≥ 1200 px, a sheet below). Every screen starts from `GET /api/work/capabilities`: without
 * write rights there are no write controls at all.
 *
 * «План с ассистентом» (was «AI план»; Step 5, typed AI task-plan proposals) sits next to «Задача» only when the server reports
 * `capabilities.features.ai_proposals` (a planning-capable AI provider) AND the reader may write; the open proposal is
 * in the URL (`?proposal=WAP-…`). Without AI the button is simply absent — everything else works as before.
 */

const PHONE = "(max-width: 719.98px)";
/** Up to this width the project line keeps status, dates and progress (the rest goes to «⋯»). */
const MEDIUM = "(max-width: 1100px)";
/** Phones: the project line keeps status and progress. */
const SMALL_PHONE = "(max-width: 599.98px)";

/** «14 задач», «1 задача», «3 задачи». */
function tasksText(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} задач`;
  if (last === 1) return `${n} задача`;
  if (last >= 2 && last <= 4) return `${n} задачи`;
  return `${n} задач`;
}

export function ProjectPage() {
  const { key = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const ws = useWorkspace(key);
  const view = resolveWorkView(params);
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const zoom = resolveZoom(params);
  const selectedKey = params.get("task");
  const proposalParam = params.get("proposal");
  const proposalId = proposalParam && /^WAP-[0-9a-f]{16}$/.test(proposalParam) ? proposalParam : null;
  const [planning, setPlanning] = useState(false);
  const phone = useMediaQuery(PHONE);
  const medium = useMediaQuery(MEDIUM);
  const smallPhone = useMediaQuery(SMALL_PHONE);
  const panelMode = useSidePanelMode();
  const ganttRef = useRef<GanttHandle>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState<{ parent: WorkTask | null } | null>(null);
  const [schedule, setSchedule] = useState<ScheduleRequest | null>(null);
  const [previewOps, setPreviewOps] = useState<ScheduleOperation[] | null>(null);
  const [documents, setDocuments] = useState<ProjectDocumentRef[]>([]);
  const { snapshot, project, capabilities, canWrite, say, message, clearMessage } = ws;
  const projectId = project?.id;
  const linksOn = Boolean(capabilities?.features.document_links);

  // Documents linked to the project's tasks (visible ones) for the «Документ» filter; re-read with every snapshot.
  useEffect(() => {
    if (!projectId || !linksOn) return undefined;
    let live = true;
    api
      .workProjectDocuments(projectId)
      .then((result) => {
        if (live) setDocuments(result.items);
      })
      .catch(() => {
        if (live) setDocuments([]);
      });
    return () => {
      live = false;
    };
  }, [projectId, linksOn, snapshot]);

  // A success message fades after a while; warnings and errors stay until closed.
  useEffect(() => {
    if (!message || message.tone !== "success") return undefined;
    const timer = window.setTimeout(clearMessage, 8000);
    return () => window.clearTimeout(timer);
  }, [message, clearMessage]);

  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot]);
  const assigneeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) if (t.assignee_id) counts[t.assignee_id] = (counts[t.assignee_id] ?? 0) + 1;
    return counts;
  }, [tasks]);
  const tree = useMemo(() => buildTree(tasks), [tasks]);
  const byId = tree.byId;
  const keyOf = useCallback((id: string) => byId.get(id)?.key ?? id, [byId]);
  const filtered = hasFilters(filters);
  const rows = useMemo(() => visibleRows(tree, filters, collapsed), [tree, filters, collapsed]);
  const today = snapshot?.today ?? new Date().toISOString().slice(0, 10);

  const setUrl = useCallback(
    (changes: Record<string, string | null>, replace = false) => setParams((current) => withParams(current, changes), { replace }),
    [setParams],
  );
  const onFilters = useCallback((next: TaskFilters) => setUrl(filterParams(next), true), [setUrl]);
  const taskHref = useCallback((task: Pick<WorkTask, "key">) => `?${withParams(params, { task: task.key }).toString()}`, [params]);
  const openTask = useCallback((task: WorkTask) => setUrl({ task: task.key }), [setUrl]);
  const closeTask = useCallback(() => setUrl({ task: null }), [setUrl]);

  function chooseView(next: WorkView) {
    rememberWorkView(next);
    if (next !== view) setUrl({ view: next });
  }

  const onZoom = useCallback(
    (next: GanttZoom) => {
      writePreference(GANTT_ZOOM_KEY, next);
      setUrl({ zoom: next }, true);
    },
    [setUrl],
  );

  const onToggle = useCallback((taskId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const requestSchedule = useCallback((task: WorkTask, change: TaskDateChange) => {
    setSchedule({ taskKey: task.key, changes: [change], mode: "shift_successors" });
  }, []);

  const onScheduleConflict = useCallback(
    (task: WorkTask, change: TaskDateChange) => {
      say("info", `${task.key}: новые даты затрагивают зависимые задачи — проверьте последствия перед применением.`);
      requestSchedule(task, change);
    },
    [say, requestSchedule],
  );

  const onPreview = useCallback((preview: SchedulePreview | null) => setPreviewOps(preview?.operations ?? null), []);

  function applied(result: ScheduleApplyResult) {
    setSchedule(null);
    setPreviewOps(null);
    ws.mergeTasks(result.changed_tasks);
    say("success", `Сроки применены${result.replayed ? " (повтор того же подтверждения)" : ""}: изменено задач — ${result.changed_tasks.length}. Ревизия плана ${result.plan_revision}.`);
    void ws.refresh();
  }

  const moveCard = useCallback(
    async (task: WorkTask, status: TaskStatus) => {
      const result = await ws.updateTask(task, { status });
      if (result.ok) say("success", `${task.key} → «${TASK_STATUS_LABEL[status]}».`);
      else if (result.error.code !== "stale_task") say("danger", `${task.key} не перенесена в «${TASK_STATUS_LABEL[status]}»: ${result.error.message} Карточка возвращена.`);
      return result.ok;
    },
    [ws, say],
  );

  // The Gantt: scheduled tasks (and unscheduled parents of scheduled ones, for the tree); the rest is the pool.
  const ganttRows = useMemo(() => chartRows(rows), [rows]);
  const pool = useMemo(() => {
    const inChart = new Set(ganttRows.map((r) => r.task.id));
    return tree.ordered.filter((t) => !t.scheduled && !inChart.has(t.id) && matchesFilters(t, filters));
  }, [tree, ganttRows, filters]);
  const boardTasks = useMemo(() => tree.ordered.filter((t) => matchesFilters(t, filters)), [tree, filters]);
  const shownCount = filtered ? tree.ordered.filter((t) => matchesFilters(t, filters)).length : tasks.length;

  if (ws.loading && !snapshot) {
    return (
      <div className="work-page">
        <PageToolbar crumbs={[{ label: "Проекты", to: "/projects" }, { label: key }]} />
        <Loading label="Загружаем проект…" />
      </div>
    );
  }
  if (ws.error || !snapshot || !project) {
    const error = ws.error;
    return (
      <div className="work-page">
        <PageToolbar crumbs={[{ label: "Проекты", to: "/projects" }, { label: key }]} />
        {error?.status === 404 ? (
          <EmptyState title="Проект не найден" page>
            <p>Проекта «{key}» нет или он вам недоступен.</p>
            <p>
              <Link to="/projects">Все проекты</Link>
            </p>
          </EmptyState>
        ) : error?.status === 503 ? (
          <EmptyState title="Модуль задач отключён" page>
            <p>{error.message}</p>
          </EmptyState>
        ) : error ? (
          <ErrorState error={error} onRetry={ws.reload} page title="Не удалось загрузить проект" />
        ) : null}
      </div>
    );
  }

  const selected = selectedKey ? (tasks.find((t) => t.key === selectedKey) ?? null) : null;
  const aiPlanOn = Boolean(capabilities?.features.ai_proposals);
  const maxDepth = capabilities?.limits.max_depth ?? 4;

  const viewSwitch = (
    <div className="view-switch" role="group" aria-label="Вид проекта">
      {WORK_VIEWS.map((option) => (
        <button key={option} type="button" className="view-switch__item" aria-pressed={view === option} onClick={() => chooseView(option)}>
          {WORK_VIEW_LABEL[option]}
        </button>
      ))}
    </div>
  );

  const panel =
    selectedKey !== null ? (
      <SidePanel id="task-panel" title={selected ? `${selected.key}: ${selected.title}` : selectedKey} mode={panelMode} onClose={closeTask} className="side-panel--task">
        {selected ? (
          <TaskDetail
            task={selected}
            tasks={tasks}
            projectRef={project.id}
            planRevision={snapshot.plan_revision}
            capabilities={capabilities}
            canWrite={canWrite}
            assignees={ws.assignees}
            today={today}
            maxDepth={maxDepth}
            taskHref={taskHref}
            updateTask={ws.updateTask}
            onAddSubtask={(parent) => setCreating({ parent })}
            onRefresh={ws.refresh}
            onArchived={() => closeTask()}
            say={say}
          />
        ) : (
          <EmptyState title="Задача не найдена">
            <p>В проекте {project.key} нет задачи «{selectedKey}» (или она в архиве).</p>
          </EmptyState>
        )}
        {selected ? (
          <p className="task-panel__page-link">
            <Link to={`/tasks/${encodeURIComponent(selected.key)}`}>Открыть страницей</Link>
          </p>
        ) : null}
      </SidePanel>
    ) : null;

  const summary = projectSummary(project, tasks, today);
  const stripLayout: StripLayout = smallPhone ? "phone" : medium ? "medium" : "wide";
  const readOnlyMode = capabilities !== null && !capabilities.can_write;
  const countText = filtered ? `Найдено: ${shownCount} из ${tasks.length}` : tasksText(tasks.length);

  // The view's own controls at the right end of the filter row.
  const viewControls =
    view === "gantt" ? <GanttControls zoom={zoom} onZoom={onZoom} onToday={() => ganttRef.current?.scrollToToday()} phone={phone} /> : null;

  return (
    <div className={`work-page project-page project-page--${view}${panel && panelMode === "inline" ? " project-page--with-panel" : ""}`}>
      <PageToolbar
        crumbs={[{ label: "Проекты", to: "/projects" }, { label: project.title }]}
        meta={
          <>
            <span className="project-page__key">{project.key}</span>
            {phone ? null : viewSwitch}
          </>
        }
        demoNote={capabilities?.can_write ? workModeText(capabilities) : null}
        actions={
          canWrite ? (
            <>
              {aiPlanOn ? (
                <Button icon="assistant" className="button--collapsible button--with-icon" onClick={() => setPlanning(true)} aria-label="План с ассистентом">
                  <span className="button__label">План с ассистентом</span>
                </Button>
              ) : null}
              <Button variant="primary" icon="plus" className="button--collapsible button--with-icon" onClick={() => setCreating({ parent: null })}>
                <span className="button__label">Задача</span>
              </Button>
            </>
          ) : null
        }
      />
      <h1 className="visually-hidden">{project.title}</h1>
      <ProjectStrip
        project={project}
        summary={summary}
        planRevision={snapshot.plan_revision}
        today={today}
        layout={stripLayout}
        overdueFilter={filters.overdue}
        onOverdue={() => onFilters({ ...filters, overdue: !filters.overdue })}
        taskHref={taskHref}
      />
      {readOnlyMode ? (
        <div className="project-page__mode">
          <WorkModeNote capabilities={capabilities} />
        </div>
      ) : null}
      {phone ? <div className="project-page__views">{viewSwitch}</div> : null}
      <div className="work-toolbar">
        <TaskFiltersBar filters={filters} onChange={onFilters} assignees={ws.assignees} documents={documents} assigneeCounts={assigneeCounts} />
        <div className="work-toolbar__view" role="group" aria-label="Вид">
          <span className={view === "list" ? "work-toolbar__count" : "visually-hidden"} aria-live="polite">
            {countText}
          </span>
          {viewControls}
        </div>
      </div>
      {message ? (
        <div className={`work-message work-message--${message.tone}`} role={message.tone === "danger" ? "alert" : "status"} key={message.nonce}>
          <Icon name={message.tone === "success" ? "check" : message.tone === "info" ? "info" : "alert"} size={14} />
          <span className="work-message__text">{message.text}</span>
          <IconButton icon="close" size="sm" label="Скрыть сообщение" onClick={clearMessage} />
        </div>
      ) : null}
      <div className="project-page__body">
        <div className="project-page__main">
          {view === "list" ? (
            <TaskList
              rows={rows}
              collapsed={collapsed}
              onToggle={onToggle}
              canWrite={canWrite}
              assignees={ws.assignees}
              today={today}
              maxDepth={maxDepth}
              keyOf={keyOf}
              taskHref={taskHref}
              updateTask={ws.updateTask}
              onScheduleConflict={onScheduleConflict}
              onAddSubtask={(parent) => setCreating({ parent })}
              filtered={filtered}
            />
          ) : view === "board" ? (
            <TaskBoard tasks={boardTasks} canWrite={canWrite} today={today} keyOf={keyOf} taskHref={taskHref} onMove={moveCard} filtered={filtered} />
          ) : (
            <GanttChart
              ref={ganttRef}
              rows={ganttRows}
              pool={pool}
              tasks={tasks}
              dependencies={snapshot.dependencies}
              violations={snapshot.violations}
              zoom={zoom}
              today={today}
              canWrite={canWrite}
              compact={phone}
              collapsed={collapsed}
              onToggle={onToggle}
              keyOf={keyOf}
              onOpen={openTask}
              onRequestSchedule={requestSchedule}
              previewOps={previewOps}
            />
          )}
        </div>
        {panel}
      </div>

      {schedule ? (
        <SchedulePreviewDialog
          projectRef={project.id}
          request={schedule}
          today={today}
          onClose={() => {
            setSchedule(null);
            setPreviewOps(null);
          }}
          onApplied={applied}
          onRefresh={ws.refresh}
          onPreview={onPreview}
        />
      ) : null}
      {(planning || proposalId) && project ? (
        <WorkPlanSheet
          project={project}
          assignees={ws.assignees}
          canWrite={canWrite && aiPlanOn}
          proposalId={proposalId}
          onProposal={(id) => setUrl({ proposal: id })}
          onClose={() => {
            setPlanning(false);
            setUrl({ proposal: null });
          }}
          onApplied={(result) => {
            setPlanning(false);
            setUrl({ proposal: null });
            say(
              "success",
              `${result.replayed ? "Повтор того же подтверждения: " : ""}создано задач по предложению AI — ${result.created_tasks.length}, зависимостей — ${result.created_dependencies}, связей с документами — ${result.created_links}. Ревизия плана ${result.plan_revision}.`,
            );
            void ws.refresh();
          }}
        />
      ) : null}
      {creating ? (
        <TaskCreateSheet
          project={project}
          tasks={tasks}
          assignees={ws.assignees}
          parent={creating.parent}
          maxDepth={maxDepth}
          onClose={() => setCreating(null)}
          onCreated={(task) => {
            setCreating(null);
            say("success", `Задача ${task.key} создана.`);
            void ws.refresh().then(() => setUrl({ task: task.key }));
          }}
        />
      ) : null}
    </div>
  );
}

/** Chart rows: scheduled tasks and the unscheduled ancestors that hold them (tree order kept). */
function chartRows(rows: VisibleRow[]): VisibleRow[] {
  const needed = new Set<string>();
  const keep: boolean[] = new Array(rows.length).fill(false);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.task.scheduled || needed.has(row.task.id)) {
      keep[i] = true;
      if (row.task.parent_task_id) needed.add(row.task.parent_task_id);
    }
  }
  return rows.filter((_, i) => keep[i]);
}
