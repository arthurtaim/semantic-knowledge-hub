import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import type { TaskStatus, WorkTask } from "../../api/types";
import { formatDay, TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../../lib/work";
import { Icon } from "../ui/Icon";
import { Menu, Popover } from "../ui/Popover";
import { AssigneeName, PriorityMark, TaskStatusMark } from "./WorkBits";

/*
 * «Доска» (M6): a column per status. A card moves by dragging (pointer events — mouse, pen and touch; 4 px threshold,
 * the card follows the pointer through a CSS transform in one animation frame per move, no React render per frame)
 * or without dragging (WCAG 2.5.7): the card's «Статус» menu, or Alt + ← / → on a focused card. The new status is
 * saved through PATCH /api/tasks/{id} with the task's version; on an error the card goes back and the reason is said.
 *
 * Planner v2 (docs/ui-v2/planner/specs/PLANNER_V2.md §5): the shared page frame, the shared status shapes in the column
 * headings; how to move a card is told in «Вид» (BoardViewMenu) and, for a screen reader, as each card's description.
 *
 * Remediation B2 (audit SYS-010, reports/remediation/03_PERFORMANCE.md): a 1000-card board was ≈ 46 000 DOM nodes, a
 * 350 ms first render and ≈ 180 ms per move (every card re-rendered). Now each column renders a WINDOW of its cards —
 * the first BOARD_WINDOW, then BOARD_WINDOW more when the column's end comes into view or on «Показать ещё» (focus
 * goes to the first new card); the count in the heading and `aria-setsize` / `aria-posinset` stay the whole column's.
 * A card just moved (keyboard, menu or drag) is always rendered in its new column, so focus can follow it. Cards are
 * memoised on what they show: a move or a quiet re-read re-renders only the cards that changed.
 */

/** Cards a column renders at first and adds per step. */
export const BOARD_WINDOW = 40;
/** How far below the viewport the end of a column starts the next step (px). */
const GROW_MARGIN = 800;

const initialWindows = (): Record<TaskStatus, number> =>
  Object.fromEntries(TASK_STATUS_ORDER.map((s) => [s, BOARD_WINDOW])) as Record<TaskStatus, number>;

/** «Вид» of the Board: how cards move (with the mouse, the card menu, the keyboard). */
export function BoardViewMenu({ canWrite }: { canWrite: boolean }) {
  return (
    <Popover
      id="board-view"
      className="board-view"
      panelClassName="board-view__panel"
      trigger={(props) => (
        <button {...props} type="button" className="button button--secondary button--sm" title="Как переносить карточки">
          <Icon name="sliders" size={14} />
          Вид
        </button>
      )}
    >
      {canWrite ? (
        <div className="gantt-keys">
          <div className="gantt-keys__title">Как перенести карточку</div>
          <dl className="gantt-keys__list">
            <div>
              <dt>мышь, перо, палец</dt>
              <dd>перетащить в колонку</dd>
            </div>
            <div>
              <dt>⋯ на карточке</dt>
              <dd>выбрать статус</dd>
            </div>
            <div>
              <dt>Alt + ← →</dt>
              <dd>в соседнюю колонку</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="muted">Только просмотр: статусы задач здесь не меняются.</p>
      )}
    </Popover>
  );
}

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

/** What a card does; one stable object for all cards (it reads the board's latest state), so memo holds. */
interface CardHandlers {
  pointerDown: (event: PointerEvent<HTMLElement>, taskId: string) => void;
  pointerMove: (event: PointerEvent<HTMLElement>) => void;
  pointerUp: (event: PointerEvent<HTMLElement>) => void;
  pointerCancel: (event: PointerEvent<HTMLElement>) => void;
  keyDown: (event: KeyboardEvent<HTMLElement>, taskId: string) => void;
  moveTo: (taskId: string, status: TaskStatus) => void;
}

export function TaskBoard({ tasks, canWrite, today, keyOf, taskHref, onMove, filtered }: TaskBoardProps) {
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const columnRefs = useRef(new Map<TaskStatus, HTMLElement>());
  const sentinels = useRef(new Map<TaskStatus, HTMLElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [windows, setWindows] = useState(initialWindows);
  // The card moved last stays rendered in its new column even beyond the window (focus follows it there).
  const [pinned, setPinned] = useState<string | null>(null);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);

  // After a keyboard move the card lives in another column: focus follows it.
  useEffect(() => {
    if (!focusId) return;
    document.querySelector<HTMLElement>(`[data-card-id="${focusId}"] .board-card__title`)?.focus();
    setFocusId(null);
  }, [focusId, tasks]);

  async function move(task: WorkTask, status: TaskStatus, viaKeyboard = false) {
    if (status === task.status) return;
    setPinned(task.id);
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

  // One stable handler object for every card: it calls this render's functions and finds the task by id in the
  // latest snapshot, so a memoised card never acts on an old copy of its task.
  const latest = useRef({ byId, onPointerDown, onPointerMove, finish, onCardKeyDown, move });
  latest.current = { byId, onPointerDown, onPointerMove, finish, onCardKeyDown, move };
  const handlers = useMemo<CardHandlers>(() => {
    const withTask = (id: string, run: (task: WorkTask) => void) => {
      const task = latest.current.byId.get(id);
      if (task) run(task);
    };
    return {
      pointerDown: (event, id) => withTask(id, (task) => latest.current.onPointerDown(event, task)),
      pointerMove: (event) => latest.current.onPointerMove(event),
      pointerUp: (event) => latest.current.finish(event, false),
      pointerCancel: (event) => latest.current.finish(event, true),
      keyDown: (event, id) => withTask(id, (task) => latest.current.onCardKeyDown(event, task)),
      moveTo: (id, status) => withTask(id, (task) => void latest.current.move(task, status, true)),
    };
  }, []);

  const byStatus = new Map<TaskStatus, WorkTask[]>(TASK_STATUS_ORDER.map((s) => [s, []]));
  for (const task of tasks) byStatus.get(task.status)?.push(task);
  const shown = new Map<TaskStatus, number>();
  for (const status of TASK_STATUS_ORDER) {
    const items = byStatus.get(status) ?? [];
    let count = Math.min(items.length, windows[status]);
    const at = pinned ? items.findIndex((t) => t.id === pinned) : -1;
    if (at >= count) count = at + 1;
    shown.set(status, count);
  }
  const layout = TASK_STATUS_ORDER.map((s) => `${shown.get(s)}/${byStatus.get(s)?.length ?? 0}`).join(" ");

  // The next window of a column when its end comes into view (no observer — e.g. jsdom: «Показать ещё» only).
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const grow = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.status as TaskStatus);
        if (grow.length) setWindows((current) => ({ ...current, ...Object.fromEntries(grow.map((s) => [s, current[s] + BOARD_WINDOW])) }));
      },
      { rootMargin: `0px 0px ${GROW_MARGIN}px 0px` },
    );
    // Re-observed after every growth: a column end still in view grows again (a tall screen), then it stops.
    for (const element of sentinels.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);

  function showMore(status: TaskStatus) {
    const items = byStatus.get(status) ?? [];
    const from = shown.get(status) ?? 0;
    setWindows((current) => ({ ...current, [status]: Math.max(current[status], from) + BOARD_WINDOW }));
    const first = items[from];
    if (first) setFocusId(first.id); // the first new card, so keyboard and screen reader users go on from there
  }

  return (
    <div className="board" onClickCapture={onClickCapture}>
      {canWrite ? (
        <p className="visually-hidden" id="board-hint">
          Перетащите карточку в другую колонку или выберите статус в меню карточки; с клавиатуры — Alt + ← / →.
        </p>
      ) : null}
      <div className="board__columns">
        {TASK_STATUS_ORDER.map((status) => {
          const items = byStatus.get(status) ?? [];
          const count = shown.get(status) ?? 0;
          const rest = items.length - count;
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
                {items.slice(0, count).map((task, index) => (
                  <li key={task.id} aria-setsize={items.length} aria-posinset={index + 1}>
                    <BoardCard
                      task={task}
                      canWrite={canWrite}
                      today={today}
                      href={taskHref(task)}
                      waitsFor={task.is_blocked ? task.blocked_by.map(keyOf).join(", ") : ""}
                      handlers={handlers}
                    />
                  </li>
                ))}
              </ul>
              {rest > 0 ? (
                <div className="board__more">
                  <button
                    type="button"
                    className="button button--secondary button--sm"
                    aria-label={`Показать ещё ${Math.min(rest, BOARD_WINDOW)} в колонке «${TASK_STATUS_LABEL[status]}»: показано ${count} из ${items.length}`}
                    onClick={() => showMore(status)}
                  >
                    Показать ещё {Math.min(rest, BOARD_WINDOW)}
                  </button>
                  <span className="board__more-count muted" aria-hidden="true">
                    {count} из {items.length}
                  </span>
                  <span
                    className="board__sentinel"
                    data-status={status}
                    aria-hidden="true"
                    ref={(element) => {
                      if (element) sentinels.current.set(status, element);
                      else sentinels.current.delete(status);
                    }}
                  />
                </div>
              ) : null}
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

interface BoardCardProps {
  task: WorkTask;
  canWrite: boolean;
  today: string;
  href: string;
  /** Keys of the unfinished predecessors («Ждёт …»), "" when not blocked. */
  waitsFor: string;
  handlers: CardHandlers;
}

/** The fields a card shows (and moves by): a card re-renders only when one of them, or a prop, changes. */
function sameCard(a: BoardCardProps, b: BoardCardProps): boolean {
  if (a.canWrite !== b.canWrite || a.today !== b.today || a.href !== b.href || a.waitsFor !== b.waitsFor || a.handlers !== b.handlers) return false;
  const x = a.task;
  const y = b.task;
  return (
    x === y ||
    (x.id === y.id &&
      x.version === y.version &&
      x.key === y.key &&
      x.title === y.title &&
      x.status === y.status &&
      x.priority === y.priority &&
      x.is_milestone === y.is_milestone &&
      x.overdue === y.overdue &&
      x.late === y.late &&
      x.is_blocked === y.is_blocked &&
      x.due_date === y.due_date &&
      x.child_count === y.child_count &&
      x.link_count === y.link_count &&
      x.assignee_id === y.assignee_id &&
      x.assignee?.display_name === y.assignee?.display_name &&
      x.assignee?.role === y.assignee?.role)
  );
}

const BoardCard = memo(function BoardCard({ task, canWrite, today, href, waitsFor, handlers }: BoardCardProps) {
  return (
    <article
      className={`board-card${task.overdue || task.late ? " is-overdue" : ""}${task.is_blocked ? " is-blocked" : ""}`}
      data-card-id={task.id}
      data-task-key={task.key}
      tabIndex={-1}
      aria-describedby={canWrite ? "board-hint" : undefined}
      onPointerDown={(event) => handlers.pointerDown(event, task.id)}
      onPointerMove={handlers.pointerMove}
      onPointerUp={handlers.pointerUp}
      onPointerCancel={handlers.pointerCancel}
      onKeyDown={(event) => handlers.keyDown(event, task.id)}
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
                  onSelect: () => handlers.moveTo(task.id, s),
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
      <Link to={href} className="board-card__title" draggable={false}>
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
            Ждёт {waitsFor}
          </span>
        ) : null}
        {task.child_count > 0 ? <span className="muted">Подзадач: {task.child_count}</span> : null}
        {task.link_count ? <span className="muted">Документов: {task.link_count}</span> : null}
      </div>
    </article>
  );
}, sameCard);
