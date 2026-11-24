import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { WorkTask } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { buttonClass } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { TaskCreateSheet } from "../components/work/CreateForms";
import { TaskDetail } from "../components/work/TaskDetail";
import { WorkModeNote } from "../components/work/WorkBits";
import { useAsync } from "../lib/useAsync";
import { useWorkspace } from "../lib/useWorkspace";

/*
 * `/tasks/:key` (M6): a task as a page — the deep link other sections use (a document's tasks in Step 4, an AI
 * proposal in Step 5). The same TaskDetail as the panel of List / Board / Gantt, over the project's snapshot.
 */

export function TaskPage() {
  const { key = "" } = useParams();
  const task = useAsync(() => api.workTask(key), `task:${key}`);
  if (task.loading && !task.data) {
    return (
      <div className="work-page">
        <PageToolbar crumbs={[{ label: "Проекты", to: "/projects" }, { label: key }]} />
        <Loading label="Загружаем задачу…" />
      </div>
    );
  }
  if (task.error || !task.data) {
    return (
      <div className="work-page">
        <PageToolbar crumbs={[{ label: "Проекты", to: "/projects" }, { label: key }]} />
        {task.error?.status === 404 ? (
          <EmptyState title="Задача не найдена" page>
            <p>Задачи «{key}» нет или она вам недоступна.</p>
            <p>
              <Link to="/projects">Все проекты</Link>
            </p>
          </EmptyState>
        ) : task.error ? (
          <ErrorState error={task.error} onRetry={task.reload} page title="Не удалось загрузить задачу" />
        ) : null}
      </div>
    );
  }
  return <TaskPageBody projectRef={task.data.project_id} taskKey={task.data.key} />;
}

function TaskPageBody({ projectRef, taskKey }: { projectRef: string; taskKey: string }) {
  const ws = useWorkspace(projectRef);
  const navigate = useNavigate();
  const [creating, setCreating] = useState<WorkTask | null>(null);
  const taskHref = useCallback((t: Pick<WorkTask, "key">) => `/tasks/${encodeURIComponent(t.key)}`, []);
  const { snapshot, project } = ws;

  if (ws.loading && !snapshot) return <Loading label="Загружаем проект…" />;
  if (ws.error || !snapshot || !project) return ws.error ? <ErrorState error={ws.error} onRetry={ws.reload} page /> : null;
  const task = snapshot.tasks.find((t) => t.key === taskKey);
  const projectHref = `/projects/${encodeURIComponent(project.key)}`;

  return (
    <div className="work-page task-page">
      <PageToolbar
        crumbs={[{ label: "Проекты", to: "/projects" }, { label: project.title, to: projectHref }, { label: taskKey }]}
        actions={
          <Link to={`${projectHref}?view=gantt&task=${encodeURIComponent(taskKey)}`} className={buttonClass("secondary", "md", "button--collapsible button--with-icon")}>
            <Icon name="gantt" />
            <span className="button__label">На диаграмме Ганта</span>
          </Link>
        }
      />
      <WorkModeNote capabilities={ws.capabilities} />
      {ws.message ? (
        <div className={`work-message work-message--${ws.message.tone}`} role={ws.message.tone === "danger" ? "alert" : "status"}>
          <span className="work-message__text">{ws.message.text}</span>
        </div>
      ) : null}
      {task ? (
        <TaskDetail
          task={task}
          tasks={snapshot.tasks}
          projectRef={project.id}
          planRevision={snapshot.plan_revision}
          capabilities={ws.capabilities}
          canWrite={ws.canWrite}
          assignees={ws.assignees}
          today={snapshot.today}
          maxDepth={ws.capabilities?.limits.max_depth ?? 4}
          taskHref={taskHref}
          updateTask={ws.updateTask}
          onAddSubtask={setCreating}
          onRefresh={ws.refresh}
          onArchived={() => navigate(projectHref)}
          say={ws.say}
          headingLevel={1}
        />
      ) : (
        <EmptyState title="Задача в архиве" page>
          <p>
            {taskKey} больше нет среди задач проекта. <Link to={projectHref}>К проекту</Link>
          </p>
        </EmptyState>
      )}
      {creating ? (
        <TaskCreateSheet
          project={project}
          tasks={snapshot.tasks}
          assignees={ws.assignees}
          parent={creating}
          maxDepth={ws.capabilities?.limits.max_depth ?? 4}
          onClose={() => setCreating(null)}
          onCreated={(created) => {
            setCreating(null);
            navigate(`/tasks/${encodeURIComponent(created.key)}`);
          }}
        />
      ) : null}
    </div>
  );
}
