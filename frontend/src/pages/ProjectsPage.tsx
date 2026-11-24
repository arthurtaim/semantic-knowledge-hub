import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { WorkCapabilities, WorkProject, WorkProjectList } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Icon } from "../components/ui/Icon";
import { ProjectCreateSheet } from "../components/work/CreateForms";
import { WorkModeNote } from "../components/work/WorkBits";
import { useAsync } from "../lib/useAsync";
import { formatDay, PROJECT_STATUS_LABEL } from "../lib/work";

/*
 * «Проекты» (M6): every project the reader may see, with what the server counted — progress (done of all),
 * open, waiting for predecessors, overdue, without dates, the next milestone. Nothing is computed or invented
 * here. «Создать проект» only when the mode allows writes (no disabled-looking fake in read-only mode).
 */

interface OverviewData {
  capabilities: WorkCapabilities;
  projects: WorkProjectList;
}

export function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const archived = params.get("archived") === "1";
  const [creating, setCreating] = useState(false);
  const state = useAsync<OverviewData>(
    async () => {
      const capabilities = await api.workCapabilities();
      if (!capabilities.enabled) return { capabilities, projects: { items: [], total: 0 } };
      const projects = await api.workProjects({ include_archived: archived });
      return { capabilities, projects };
    },
    `projects:${archived}`,
  );
  const capabilities = state.data?.capabilities ?? null;
  const canCreate = Boolean(capabilities?.can_write);

  function created(project: WorkProject) {
    setCreating(false);
    navigate(`/projects/${encodeURIComponent(project.key)}`);
  }

  return (
    <div className="work-page projects-page">
      <PageToolbar
        title="Проекты"
        actions={
          canCreate ? (
            <Button variant="primary" icon="plus" className="button--collapsible button--with-icon" onClick={() => setCreating(true)}>
              <span className="button__label">Создать проект</span>
            </Button>
          ) : null
        }
      />
      <h1 className="visually-hidden">Проекты</h1>
      <WorkModeNote capabilities={capabilities} />

      {state.loading && !state.data ? <Loading label="Загружаем проекты…" /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} title="Не удалось загрузить проекты" /> : null}
      {capabilities && !capabilities.enabled ? (
        <EmptyState title="Модуль задач отключён">
          <p>Сервер запущен с TASK_SYSTEM=disabled: проекты и задачи недоступны. Остальные разделы работают как обычно.</p>
        </EmptyState>
      ) : null}

      {state.data && capabilities?.enabled ? (
        <>
          <div className="projects-page__filters">
            <Chip
              tone="filter"
              selected={archived}
              onClick={() => {
                const next = new URLSearchParams(params);
                if (archived) next.delete("archived");
                else next.set("archived", "1");
                setParams(next, { replace: true });
              }}
            >
              Показать архивные
            </Chip>
            <span className="muted">Проектов: {state.data.projects.total}</span>
          </div>
          {state.data.projects.items.length === 0 ? (
            <EmptyState title="Проектов пока нет">
              <p>{canCreate ? "Создайте первый проект кнопкой «Создать проект»." : "Проекты появятся, когда их создаст оператор."}</p>
            </EmptyState>
          ) : (
            <ul className="project-cards">
              {state.data.projects.items.map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {creating ? <ProjectCreateSheet onClose={() => setCreating(false)} onCreated={created} /> : null}
    </div>
  );
}

function ProjectCard({ project }: { project: WorkProject }) {
  const stats = project.stats;
  const done = stats?.by_status.done ?? 0;
  const total = stats?.total ?? 0;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const summary = project.description.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
  return (
    <article className="project-card" data-project-key={project.key} aria-labelledby={`project-${project.id}`}>
      <header className="project-card__head">
        <h2 className="project-card__title" id={`project-${project.id}`}>
          <Link to={`/projects/${encodeURIComponent(project.key)}`}>{project.title}</Link>
        </h2>
        <span className="project-card__key">{project.key}</span>
        <span className={`project-status project-status--${project.status}`}>{PROJECT_STATUS_LABEL[project.status]}</span>
        {project.is_demo ? <span className="project-card__demo">демо</span> : null}
      </header>
      {summary ? <p className="project-card__summary">{summary}</p> : null}
      <p className="project-card__dates">
        <Icon name="clock" size={13} />
        {project.start_date || project.target_date ? `${formatDay(project.start_date)} – ${formatDay(project.target_date)}` : "Сроки проекта не заданы"}
      </p>
      {stats ? (
        <>
          <div className="project-progress">
            <div
              className="project-progress__track"
              role="progressbar"
              aria-label={`Готово задач в ${project.key}`}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-valuetext={`${done} из ${total}`}
            >
              <span className="project-progress__bar" style={{ width: `${percent}%` }} />
            </div>
            <span className="project-progress__text">
              Готово {done} из {total}
            </span>
          </div>
          <dl className="project-card__stats">
            <div>
              <dt>Открыто</dt>
              <dd>{stats.open}</dd>
            </div>
            <div>
              <dt>Ждут предшественников</dt>
              <dd>{stats.blocked}</dd>
            </div>
            <div className={stats.overdue ? "is-alert" : undefined}>
              <dt>Просрочено</dt>
              <dd>
                {stats.overdue ? <Icon name="alert" size={13} /> : null}
                {stats.overdue}
              </dd>
            </div>
            <div>
              <dt>Без дат</dt>
              <dd>{stats.unscheduled}</dd>
            </div>
          </dl>
          <p className="project-card__milestone">
            <Icon name="milestone" size={13} />
            {stats.next_milestone ? (
              <>
                Ближайшая веха:{" "}
                <Link to={`/projects/${encodeURIComponent(project.key)}?view=gantt&task=${encodeURIComponent(stats.next_milestone.key)}`}>
                  {stats.next_milestone.title}
                </Link>{" "}
                · {formatDay(stats.next_milestone.date)}
              </>
            ) : stats.milestones ? (
              "Все вехи пройдены"
            ) : (
              "Вех нет"
            )}
          </p>
        </>
      ) : null}
    </article>
  );
}
