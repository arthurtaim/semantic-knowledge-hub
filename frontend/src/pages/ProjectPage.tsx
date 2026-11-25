import { useCallback, useEffect, useMemo, useState } from "react";
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
import { GanttChart } from "../components/work/GanttChart";
import { SchedulePreviewDialog, type ScheduleRequest } from "../components/work/SchedulePreviewDialog";
import { TaskBoard } from "../components/work/TaskBoard";
import { TaskDetail } from "../components/work/TaskDetail";
import { TaskFiltersBar } from "../components/work/TaskFiltersBar";
import { TaskList } from "../components/work/TaskList";
import { WorkModeNote } from "../components/work/WorkBits";
import { withParams } from "../lib/docsView";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useWorkspace } from "../lib/useWorkspace";
import {
  buildTree,
  filterParams,
  filtersFromParams,
  formatDay,
  ganttRange,
  GANTT_ZOOM_KEY,
  hasFilters,
  matchesFilters,
  PROJECT_STATUS_LABEL,
  rememberWorkView,
  resolveWorkView,
  resolveZoom,
  TASK_STATUS_LABEL,
  visibleRows,
  WORK_VIEW_LABEL,
  WORK_VIEWS,
  type GanttZoom,
  type TaskFilters,
  type VisibleRow,
  type WorkView,
} from "../lib/work";
import { writePreference } from "../lib/storage";

/*
 * A project (M6): «Список | Доска | Гант» over ONE snapshot of its tasks (lib/useWorkspace.ts) with one filter model;
 * the view, the filters, the Gantt zoom and the open task live in the URL (`?view=gantt&status=todo&task=ARIS-3`), so
 * Back / Forward and a sent link restore them; the view is also remembered in this browser. One task panel serves
 * all three views (docked ≥ 1200 px, a sheet below). Every screen starts from `GET /api/work/capabilities`: without
 * write rights there are no write controls at all.
 *
 * «AI план» (Step 5, typed AI task-plan proposals) sits next to «Задача» only when the server reports
 * `capabilities.features.ai_proposals` (a planning-capable AI provider) AND the reader may write; the open proposal is
 * in the URL (`?proposal=WAP-…`). Without AI the button is simply absent — everything else works as before.
 */

const PHONE = "(max-width: 719.98px)";

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
  const panelMode = useSidePanelMode();
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
  const range = useMemo(() => ganttRange(tasks, today, snapshot?.range_start, snapshot?.range_end_exclusive), [tasks, today, snapshot]);
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
          <Icon name={option} size={14} />
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

  return (
    <div className={`work-page project-page project-page--${view}${panel && panelMode === "inline" ? " project-page--with-panel" : ""}`}>
      <PageToolbar
        crumbs={[{ label: "Проекты", to: "/projects" }, { label: project.title }]}
        meta={phone ? null : viewSwitch}
        actions={
          canWrite ? (
            <>
              {aiPlanOn ? (
                <Button icon="assistant" className="button--collapsible button--with-icon" onClick={() => setPlanning(true)} aria-label="AI план">
                  <span className="button__label">AI план</span>
                </Button>
              ) : null}
              <Button variant="primary" icon="plus" className="button--collapsible button--with-icon" onClick={() => setCreating({ parent: null })}>
                <span className="button__label">Задача</span>
              </Button>
            </>
          ) : null
        }
      />
      <div className="project-page__body">
        <div className="project-page__main">
          <header className="project-head">
            <h1 className="project-head__title">
              {project.title} <span className="project-head__key">{project.key}</span>
            </h1>
            <p className="project-head__meta">
              <span className={`project-status project-status--${project.status}`}>{PROJECT_STATUS_LABEL[project.status]}</span>
              <span>
                {project.start_date || project.target_date ? `${formatDay(project.start_date)} – ${formatDay(project.target_date)}` : "Сроки не заданы"}
              </span>
              <span>Сегодня {formatDay(today)} ({project.timezone})</span>
              <span data-testid="plan-revision">Ревизия плана {snapshot.plan_revision}</span>
              {project.is_demo ? <span className="project-card__demo">демо-данные</span> : null}
            </p>
            <WorkModeNote capabilities={capabilities} />
          </header>
          {phone ? <div className="project-page__views">{viewSwitch}</div> : null}
          <TaskFiltersBar filters={filters} onChange={onFilters} assignees={ws.assignees} documents={documents} shown={shownCount} total={tasks.length} assigneeCounts={assigneeCounts} />
          {message ? (
            <div className={`work-message work-message--${message.tone}`} role={message.tone === "danger" ? "alert" : "status"} key={message.nonce}>
              <Icon name={message.tone === "success" ? "check" : message.tone === "info" ? "info" : "alert"} size={14} />
              <span className="work-message__text">{message.text}</span>
              <IconButton icon="close" size="sm" label="Скрыть сообщение" onClick={clearMessage} />
            </div>
          ) : null}

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
              rows={ganttRows}
              pool={pool}
              dependencies={snapshot.dependencies}
              violations={snapshot.violations}
              range={range}
              zoom={zoom}
              onZoom={onZoom}
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
