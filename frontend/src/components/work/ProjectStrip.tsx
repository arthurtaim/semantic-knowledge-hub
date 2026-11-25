import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { WorkProject, WorkTask } from "../../api/types";
import { formatDay, PROJECT_STATUS_LABEL } from "../../lib/work";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";

/*
 * Planner v2 — the project line (docs/ui-v2/planner/specs/PLANNER_V2.md §2.2): one 44 px line instead of a title
 * block, a metadata line and a banner. Status, the project's dates, «Готово N из M» with a bar, «N просрочена» (it
 * switches the «Просроченные» filter), the next milestone (a link to it) and «Ревизия плана N». Every number comes
 * from the loaded project (`stats`) or, without stats, from the loaded snapshot of its tasks — nothing is estimated.
 * Below 1100 px the line keeps status, dates and progress, the rest goes to «⋯»; on a phone — status and progress.
 */

export interface ProjectSummary {
  done: number;
  total: number;
  overdue: number;
  nextMilestone: { key: string; title: string; date: string } | null;
}

export function projectSummary(project: Pick<WorkProject, "stats">, tasks: WorkTask[], today: string): ProjectSummary {
  const stats = project.stats;
  if (stats) {
    const next = stats.next_milestone;
    return {
      done: stats.by_status.done ?? 0,
      total: stats.total,
      overdue: stats.overdue,
      nextMilestone: next ? { key: next.key, title: next.title, date: next.date } : null,
    };
  }
  const next = tasks
    .filter((t) => t.is_milestone && t.status !== "done" && t.start_date && t.start_date >= today)
    .sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""))[0];
  return {
    done: tasks.filter((t) => t.status === "done").length,
    total: tasks.length,
    overdue: tasks.filter((t) => t.overdue).length,
    nextMilestone: next?.start_date ? { key: next.key, title: next.title, date: next.start_date } : null,
  };
}

/** «1 просрочена», «2 просрочены», «5 просрочено». */
export function overdueText(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} просрочено`;
  if (last === 1) return `${n} просрочена`;
  if (last >= 2 && last <= 4) return `${n} просрочены`;
  return `${n} просрочено`;
}

/** «2 нояб. – 10 дек. 2026»: the start without the year when it is the end's year. */
export function projectDates(project: Pick<WorkProject, "start_date" | "target_date">): string {
  const { start_date: start, target_date: end } = project;
  if (!start && !end) return "Сроки не заданы";
  if (start && end) return `${formatDay(start, end)} – ${formatDay(end)}`;
  return start ? `с ${formatDay(start)}` : `до ${formatDay(end)}`;
}

export type StripLayout = "wide" | "medium" | "phone";

interface ProjectStripProps {
  project: WorkProject;
  summary: ProjectSummary;
  planRevision: number;
  today: string;
  layout: StripLayout;
  overdueFilter: boolean;
  onOverdue: () => void;
  /** The link that opens a task in the panel (keeps the view and the filters). */
  taskHref: (task: { key: string }) => string;
}

export function ProjectStrip({ project, summary, planRevision, today, layout, overdueFilter, onOverdue, taskHref }: ProjectStripProps) {
  const percent = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  const status = (
    <span className={`project-strip__status project-status project-status--${project.status}`}>
      <span className="project-strip__dot" aria-hidden="true" />
      {PROJECT_STATUS_LABEL[project.status]}
    </span>
  );
  const dates = (
    <span className="project-strip__dates" title={`Сегодня ${formatDay(today)}, часовой пояс проекта ${project.timezone}`}>
      {projectDates(project)}
    </span>
  );
  const progress = (
    <span className="project-strip__progress">
      <span className="project-strip__track" aria-hidden="true">
        <span className="project-strip__bar" style={{ width: `${percent}%` }} />
      </span>
      <span className="project-strip__done">
        Готово {summary.done} из {summary.total}
      </span>
    </span>
  );
  const overdue =
    summary.overdue > 0 ? (
      <button
        type="button"
        className="project-strip__overdue"
        aria-pressed={overdueFilter}
        title={overdueFilter ? "Показать все задачи" : "Показать только просроченные"}
        onClick={onOverdue}
      >
        <Icon name="alert" size={14} />
        {overdueText(summary.overdue)}
      </button>
    ) : null;
  const milestone = summary.nextMilestone ? (
    <span className="project-strip__milestone">
      <Icon name="milestone" size={12} strokeWidth={2} />
      Ближайшая веха:{" "}
      <Link to={taskHref(summary.nextMilestone)} className="project-strip__link">
        {summary.nextMilestone.title}
      </Link>
      <span className="project-strip__sep" aria-hidden="true">
        ·
      </span>
      {formatDay(summary.nextMilestone.date, today)}
    </span>
  ) : null;
  const revision = (
    <span className="project-strip__revision" data-testid="plan-revision">
      Ревизия плана {planRevision}
    </span>
  );

  const more = (items: ReactNode[]) => (
    <Popover
      id="project-strip-more"
      className="project-strip__more"
      panelClassName="project-strip__more-panel"
      trigger={(props) => <IconButton {...props} icon="more" size="sm" label="Ещё о проекте" />}
    >
      <ul className="project-strip__more-list">
        {items.filter(Boolean).map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </Popover>
  );

  return (
    <div className={`project-strip project-strip--${layout}`} aria-label="Сводка проекта" role="group">
      {status}
      {layout !== "phone" ? dates : null}
      {progress}
      {layout === "wide" ? (
        <>
          {overdue}
          {milestone}
          <span className="project-strip__spacer" />
          {revision}
        </>
      ) : (
        <>
          <span className="project-strip__spacer" />
          {more([layout === "phone" ? dates : null, overdue, milestone, revision])}
        </>
      )}
    </div>
  );
}
