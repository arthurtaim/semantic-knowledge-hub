import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import type { TaskStatus, WorkTask } from "../../api/types";
import { formatDay, TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../../lib/work";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Popover";
import { AssigneeName, PriorityMark, TaskStatusMark } from "./WorkBits";

/*
 * «Доска» (M6): a column per status. A card moves by dragging (pointer events — mouse, pen and touch; 4 px threshold,
 * the card follows the pointer through a CSS transform in one animation frame per move, no React render per frame)
 * or without dragging (WCAG 2.5.7): the card's «Статус» menu, or Alt + ← / → on a focused card. The new status is
 * saved through PATCH /api/tasks/{id} with the task's version; on an error the card goes back and the reason is said.
 */

const DRAG_THRESHOLD = 4;

interface TaskBoardProps {
  tasks: WorkTask[];
  canWrite: boolean;
  today: string;
  keyOf: (id: string) => string;
  taskHref: (task: WorkTask) => string;
  onMove: (task: WorkTask, status: TaskStatus) => Promise<boolean>;
  filtered: boolean;
}

interface Drag {
  pointer: number;
  task: WorkTask;
  card: HTMLElement;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  dragging: boolean;
  columns: { status: TaskStatus; rect: DOMRect; element: HTMLElement }[];
  target: TaskStatus | null;
  /** A paint is scheduled for the next animation frame (at most one per frame). */
  framePending: boolean;
}

const requestFrame = (callback: () => void): number =>
  typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 16);

function capture(element: Element, pointerId: number, on: boolean) {
  try {
    if (on) element.setPointerCapture?.(pointerId);
    else if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // A synthetic event without an active pointer: no capture, the drag still works.
  }
}

export function TaskBoard({ tasks, canWrite, today, keyOf, taskHref, onMove, filtered }: TaskBoardProps) {
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const columnRefs = useRef(new Map<TaskStatus, HTMLElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // After a keyboard move the card lives in another column: focus follows it.
  useEffect(() => {
    if (!focusId) return;
    document.querySelector<HTMLElement>(`[data-card-id="${focusId}"] .board-card__title`)?.focus();
    setFocusId(null);
  }, [focusId, tasks]);

  async function move(task: WorkTask, status: TaskStatus, viaKeyboard = false) {
    if (status === task.status) return;
    if (viaKeyboard) setFocusId(task.id);
    setAnnouncement(`${task.key} → «${TASK_STATUS_LABEL[status]}»…`);
    const ok = await onMove(task, status);
    setAnnouncement(ok ? `${task.key} перенесена в «${TASK_STATUS_LABEL[status]}».` : `${task.key} осталась в «${TASK_STATUS_LABEL[task.status]}».`);
  }

  function onPointerDown(event: PointerEvent<HTMLElement>, task: WorkTask) {
    if (!canWrite || event.button !== 0 || drag.current) return;
    if ((event.target as Element).closest("button, select, input, [role='menu']")) return;
    suppressClick.current = false;
    drag.current = {
      pointer: event.pointerId,
      task,
      card: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      dragging: false,
      columns: [],
      target: null,
      framePending: false,
    };
  }

  function paint(d: Drag) {
    d.framePending = false;
    if (drag.current !== d) return; // the drag ended before this frame
    d.card.style.transform = `translate(${d.dx}px, ${d.dy}px)`;
    for (const column of d.columns) column.element.classList.toggle("is-drop-target", column.status === d.target && column.status !== d.task.status);
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    d.dx = event.clientX - d.startX;
    d.dy = event.clientY - d.startY;
    if (!d.dragging) {
      if (Math.hypot(d.dx, d.dy) < DRAG_THRESHOLD) return;
      d.dragging = true;
      capture(d.card, event.pointerId, true);
      d.card.classList.add("is-dragging");
      d.columns = TASK_STATUS_ORDER.flatMap((status) => {
        const element = columnRefs.current.get(status);
        return element ? [{ status, rect: element.getBoundingClientRect(), element }] : [];
      });
    }
    const hit = d.columns.find((c) => event.clientX >= c.rect.left && event.clientX <= c.rect.right && event.clientY >= c.rect.top && event.clientY <= c.rect.bottom);
    d.target = hit?.status ?? null;
    if (!d.framePending) {
      d.framePending = true;
      requestFrame(() => paint(d));
    }
  }

  function finish(event: PointerEvent<HTMLElement>, cancelled: boolean) {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    if (!d.dragging) return; // a click: the link opens the task
    capture(d.card, event.pointerId, false);
    d.card.style.transform = "";
    d.card.classList.remove("is-dragging");
    for (const column of d.columns) column.element.classList.remove("is-drop-target");
    suppressClick.current = true;
    if (!cancelled && d.target && d.target !== d.task.status) void move(d.task, d.target);
  }

  function onClickCapture(event: MouseEvent<HTMLElement>) {
    if (suppressClick.current) {
      // The press was a drag: it moved the card and does not open it.
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onCardKeyDown(event: KeyboardEvent<HTMLElement>, task: WorkTask) {
    if (!canWrite || !event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TASK_STATUS_ORDER.indexOf(task.status);
    const next = TASK_STATUS_ORDER[index + (event.key === "ArrowLeft" ? -1 : 1)];
    if (next) void move(task, next, true);
  }

  const byStatus = new Map<TaskStatus, WorkTask[]>(TASK_STATUS_ORDER.map((s) => [s, []]));
  for (const task of tasks) byStatus.get(task.status)?.push(task);

  return (
    <div className="board" onClickCapture={onClickCapture}>
      {canWrite ? (
        <p className="board__hint muted" id="board-hint">
          Перетащите карточку в другую колонку или выберите статус в меню карточки; с клавиатуры — Alt + ← / →.
        </p>
      ) : null}
      <div className="board__columns">
        {TASK_STATUS_ORDER.map((status) => {
          const items = byStatus.get(status) ?? [];
          return (
            <section
              key={status}
              className={`board__column board__column--${status}`}
              aria-labelledby={`board-col-${status}`}
              data-status={status}
              ref={(element) => {
                if (element) columnRefs.current.set(status, element);
                else columnRefs.current.delete(status);
              }}
            >
              <h2 className="board__column-title" id={`board-col-${status}`}>
                <TaskStatusMark status={status} />
                <span className="board__count" aria-label={`задач: ${items.length}`}>
                  {items.length}
                </span>
              </h2>
              {items.length === 0 ? <p className="board__empty muted">{filtered ? "Нет задач по фильтрам" : "Пусто"}</p> : null}
              <ul className="board__cards">
                {items.map((task) => (
                  <li key={task.id}>
                    <article
                      className={`board-card${task.overdue || task.late ? " is-overdue" : ""}${task.is_blocked ? " is-blocked" : ""}`}
                      data-card-id={task.id}
                      data-task-key={task.key}
                      tabIndex={-1}
                      aria-describedby={canWrite ? "board-hint" : undefined}
                      onPointerDown={(event) => onPointerDown(event, task)}
                      onPointerMove={onPointerMove}
                      onPointerUp={(event) => finish(event, false)}
                      onPointerCancel={(event) => finish(event, true)}
                      onKeyDown={(event) => onCardKeyDown(event, task)}
                    >
                      <div className="board-card__head">
                        <span className="board-card__key">
                          {task.is_milestone ? <Icon name="milestone" size={12} label="Веха" /> : null}
                          {task.key}
                        </span>
                        <PriorityMark priority={task.priority} compact />
                        {canWrite ? (
                          <Menu
                            label={`Статус ${task.key}`}
                            align="end"
                            groups={[
                              {
                                label: "Перенести в",
                                radio: true,
                                items: TASK_STATUS_ORDER.map((s) => ({
                                  id: s,
                                  label: TASK_STATUS_LABEL[s],
                                  checked: s === task.status,
                                  onSelect: () => void move(task, s, true),
                                })),
                              },
                            ]}
                            trigger={(props) => (
                              <button {...props} type="button" className="board-card__menu" aria-label={`Сменить статус ${task.key}`}>
                                <Icon name="more" size={14} />
                              </button>
                            )}
                          />
                        ) : null}
                      </div>
                      <Link
                        to={taskHref(task)}
                        className="board-card__title"
                        draggable={false}
                      >
                        {task.title}
                      </Link>
                      <div className="board-card__meta">
                        <AssigneeName task={task} />
                        {task.due_date ? (
                          <span className={task.overdue ? "board-card__due is-overdue" : "board-card__due"}>
                            {task.overdue ? <Icon name="alert" size={12} /> : null}
                            {task.overdue ? "Просрочена: " : "Срок "}
                            {formatDay(task.due_date, today)}
                          </span>
                        ) : null}
                        {!task.overdue && task.late ? (
                          <span className="board-card__due is-overdue">
                            <Icon name="clock" size={12} />
                            Отстаёт от плана
                          </span>
                        ) : null}
                        {task.is_blocked ? (
                          <span className="board-card__blocked">
                            <Icon name="dependency" size={12} />
                            Ждёт {task.blocked_by.map(keyOf).join(", ")}
                          </span>
                        ) : null}
                        {task.child_count > 0 ? <span className="muted">Подзадач: {task.child_count}</span> : null}
                        {task.link_count > 0 ? <span className="muted">Документов: {task.link_count}</span> : null}
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
