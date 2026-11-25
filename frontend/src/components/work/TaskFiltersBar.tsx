import { useEffect, useId, useState } from "react";
import type { AssigneeRef, ProjectDocumentRef, TaskPriority, TaskStatus } from "../../api/types";
import {
  countFilters,
  EMPTY_FILTERS,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
  type TaskFilters,
} from "../../lib/work";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { Menu, type MenuGroup, type MenuTriggerProps } from "../ui/Popover";

/*
 * The one filter model of List, Board and Gantt (state in the URL, lib/work.ts): search by title or key, status,
 * priority, assignee, «Просроченные», «Вехи» and «Документ» — a document linked to tasks of the project (only
 * documents the reader can see are offered or matched; `?doc=ID` also arrives from a document page).
 */

interface TaskFiltersBarProps {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  assignees: AssigneeRef[];
  /** Documents linked to the project's tasks (visible to this reader), for the «Документ» filter. */
  documents?: ProjectDocumentRef[];
  /** How many tasks match / all, for the screen reader and the line under the bar. */
  shown: number;
  total: number;
  /** Tasks of the project per assignee id: shows how the work is distributed in the «Исполнитель» menu. */
  assigneeCounts?: Record<string, number>;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function TaskFiltersBar({ filters, onChange, assignees, documents = [], shown, total, assigneeCounts }: TaskFiltersBarProps) {
  const [text, setText] = useState(filters.q);
  const searchId = useId();

  // The URL is the truth: Back / Forward or a link changes the field too.
  useEffect(() => setText(filters.q), [filters.q]);

  // Typing filters after a short pause (the URL is replaced, not pushed, by the page).
  useEffect(() => {
    if (text.trim() === filters.q) return undefined;
    const timer = window.setTimeout(() => onChange({ ...filters, q: text.trim() }), 250);
    return () => window.clearTimeout(timer);
  }, [text, filters, onChange]);

  const statusGroups: MenuGroup[] = [
    {
      multi: true,
      items: TASK_STATUS_ORDER.map((status: TaskStatus) => ({
        id: status,
        label: TASK_STATUS_LABEL[status],
        checked: filters.status.includes(status),
        onSelect: () => onChange({ ...filters, status: toggle(filters.status, status) }),
      })),
    },
  ];
  const priorityGroups: MenuGroup[] = [
    {
      multi: true,
      items: PRIORITY_ORDER.map((priority: TaskPriority) => ({
        id: priority,
        label: PRIORITY_LABEL[priority],
        checked: filters.priority.includes(priority),
        onSelect: () => onChange({ ...filters, priority: toggle(filters.priority, priority) }),
      })),
    },
  ];
  const assigneeGroups: MenuGroup[] = [
    {
      radio: true,
      items: [
        { id: "any", label: "Все исполнители", checked: !filters.assignee, onSelect: () => onChange({ ...filters, assignee: "" }) },
        { id: "none", label: "Не назначен", checked: filters.assignee === "none", onSelect: () => onChange({ ...filters, assignee: "none" }) },
        ...assignees.map((a) => ({
          id: a.id,
          label: a.display_name,
          description: a.role ?? undefined,
          meta: assigneeCounts ? String(assigneeCounts[a.id] ?? 0) : undefined,
          checked: filters.assignee === a.id,
          onSelect: () => onChange({ ...filters, assignee: a.id }),
        })),
      ],
    },
  ];
  const documentGroups: MenuGroup[] = [
    {
      radio: true,
      items: [
        { id: "any", label: "Все документы", checked: !filters.doc, onSelect: () => onChange({ ...filters, doc: "" }) },
        ...documents.map((d) => ({
          id: d.document.document_id,
          label: `${d.document.document_id} — ${d.document.title}${d.changed_count ? " (изменён)" : ""}`,
          checked: filters.doc.toUpperCase() === d.document.document_id.toUpperCase(),
          onSelect: () => onChange({ ...filters, doc: d.document.document_id }),
        })),
      ],
    },
  ];
  const assigneeName =
    filters.assignee === "none" ? "Не назначен" : (assignees.find((a) => a.id === filters.assignee)?.display_name ?? filters.assignee);
  const active = countFilters(filters);

  const menuButton = (title: string, chosen: string[]) => (props: MenuTriggerProps) => (
    <button {...props} type="button" className={chosen.length ? "docs-filter docs-filter--on" : "docs-filter"}>
      <span className="docs-filter__text">{chosen.length ? `${title}: ${chosen.join(", ")}` : title}</span>
      <Icon name="chevron" size={12} />
    </button>
  );

  return (
    <div className="work-filters" role="search" aria-label="Фильтры задач">
      <div className="work-filters__search">
        <label htmlFor={searchId} className="visually-hidden">
          Найти задачу
        </label>
        <Icon name="search" size={14} />
        <input
          id={searchId}
          type="search"
          placeholder="Найти задачу: название или ключ"
          value={text}
          maxLength={100}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <Menu label="Статус" className="docs-filter-menu" groups={statusGroups} trigger={menuButton("Статус", filters.status.map((s) => TASK_STATUS_LABEL[s]))} />
      <Menu
        label="Исполнитель"
        className="docs-filter-menu"
        groups={assigneeGroups}
        trigger={menuButton("Исполнитель", filters.assignee ? [assigneeName] : [])}
      />
      <Menu
        label="Приоритет"
        className="docs-filter-menu"
        groups={priorityGroups}
        trigger={menuButton("Приоритет", filters.priority.map((p) => PRIORITY_LABEL[p]))}
      />
      {documents.length || filters.doc ? (
        <Menu label="Документ" className="docs-filter-menu" groups={documentGroups} trigger={menuButton("Документ", filters.doc ? [filters.doc] : [])} />
      ) : null}
      <Chip tone="filter" selected={filters.overdue} onClick={() => onChange({ ...filters, overdue: !filters.overdue })}>
        Просроченные
      </Chip>
      <Chip tone="filter" selected={filters.milestone} onClick={() => onChange({ ...filters, milestone: !filters.milestone })}>
        Вехи
      </Chip>
      {active > 0 ? (
        <Button variant="quiet" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
          Сбросить фильтры
        </Button>
      ) : null}
      <span className="work-filters__count" aria-live="polite">
        {active > 0 ? `Найдено: ${shown} из ${total}` : `Задач: ${total}`}
      </span>
    </div>
  );
}
