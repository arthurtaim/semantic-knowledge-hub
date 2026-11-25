import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from "react";
import type { ScheduleOperation, ScheduleViolation, TaskDateChange, WorkDependency, WorkTask } from "../../api/types";
import {
  addWorkdays,
  barGeometry,
  DAY_WIDTH,
  dependencyPath,
  formatDay,
  formatPlan,
  fromDay,
  lastWorkday,
  nextWorkday,
  pluralWorkdays,
  scaleCells,
  TASK_STATUS_LABEL,
  toDay,
  type GanttRange,
  type GanttZoom,
  type VisibleRow,
} from "../../lib/work";
import { Icon } from "../ui/Icon";

/*
 * «Гант» (M6, docs/WORK_MANAGEMENT.md «UI»): an interactive projection of the server's plan, never its source.
 * Own SVG (the house approach of the knowledge map, components/GraphCanvas.tsx) instead of a library: the
 * half-open `[start, end_exclusive)` interval, the Mon–Fri calendar, milestones as points, the unscheduled pool and
 * the preview-before-apply flow need full control, and every colour is a token of the visual system.
 *
 * - A bar covers `[start_date, end_exclusive)`: it ends at the boundary after `last_day` (no «+1 day»).
 * - Weekends are shaded; a milestone is a diamond on its day boundary; today is a vertical line.
 * - Drag a bar to move it, its right edge to change the duration (snapped to days, the ghost follows the Mon–Fri
 *   calendar exactly as the server will). Nothing changes on drop: the parent opens the schedule preview.
 * - Keyboard (WCAG 2.5.7): a focused bar moves with ← / →, changes its duration with Shift + ← / →; Enter shows the
 *   consequences (or opens the task when nothing is pending), Esc cancels.
 * - Rows are virtualised (only the visible window plus a margin is in the DOM); a drag paints the bar directly in
 *   one animation frame per move — no React render per pointer frame.
 */

export const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 52;
const BAR_HEIGHT = 18;
const BAR_TOP = (ROW_HEIGHT - BAR_HEIGHT) / 2;
const OVERSCAN = 8;
const DRAG_THRESHOLD = 4;
const RESIZE_HANDLE = 8;
/** jsdom and the first render have no size: assume a usual window height. */
const FALLBACK_VIEWPORT = 640;

export interface GanttChartProps {
  rows: VisibleRow[];
  /** Unscheduled tasks matching the filters that are not chart rows. */
  pool: WorkTask[];
  dependencies: WorkDependency[];
  violations: ScheduleViolation[];
  range: GanttRange;
  zoom: GanttZoom;
  today: string;
  canWrite: boolean;
  /** Phones: no dragging (the task panel's form changes dates). */
  compact: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (taskId: string) => void;
  keyOf: (id: string) => string;
  onOpen: (task: WorkTask) => void;
  /** A drag, resize or keyboard move finished: show its consequences (nothing is written yet). */
  onRequestSchedule: (task: WorkTask, change: TaskDateChange) => void;
  /** The pending preview's operations, drawn as dashed ghosts. */
  previewOps: ScheduleOperation[] | null;
  /** «Сегодня» and the other view controls live in the page's filter row; they reach the chart through this handle. */
  ref?: Ref<GanttHandle>;
}

export interface GanttHandle {
  scrollToToday: () => void;
}

type Mode = "move" | "resize";

interface Pending {
  task: WorkTask;
  mode: Mode;
  delta: number;
  element: SVGGElement;
}

interface PointerDrag extends Pending {
  pointer: number;
  startX: number;
  startY: number;
  dragging: boolean;
  /** A paint is scheduled for the next animation frame (at most one per frame). */
  framePending: boolean;
}

/** The interval a move / resize by `delta` calendar days produces, as the server's calendar will compute it. */
export function plannedChange(task: WorkTask, mode: Mode, delta: number): { start: string; endExclusive: string; change: TaskDateChange } | null {
  if (!task.start_date || !task.end_exclusive) return null;
  const start = toDay(task.start_date);
  const end = toDay(task.end_exclusive);
  if (task.is_milestone) {
    const day = start + delta;
    const iso = fromDay(day);
    return { start: iso, endExclusive: iso, change: { task_id: task.id, start_date: iso, duration_workdays: 0 } };
  }
  const duration = task.duration_workdays ?? 1;
  if (mode === "move") {
    const first = nextWorkday(start + delta);
    const stop = addWorkdays(first, duration);
    return {
      start: fromDay(first),
      endExclusive: fromDay(stop),
      change: { task_id: task.id, start_date: fromDay(start + delta), duration_workdays: duration },
    };
  }
  // resize: the right edge moves; at least one working day stays.
  let last = lastWorkday(start, end + delta);
  if (last === null) last = nextWorkday(start);
  const stop = last + 1;
  return { start: task.start_date, endExclusive: fromDay(stop), change: { task_id: task.id, start_date: task.start_date, end_exclusive: fromDay(stop) } };
}

const requestFrame = (callback: () => void): number =>
  typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 16);
const cancelFrame = (handle: number) => {
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
  window.clearTimeout(handle);
};

function capture(element: Element, pointerId: number, on: boolean) {
  try {
    if (on) element.setPointerCapture?.(pointerId);
    else if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // A synthetic event without an active pointer: no capture.
  }
}

/** «30 нояб.» for one day, «30 нояб. – 2 дек.» for more. */
function span(start: string, last: string, today: string): string {
  return start === last ? formatDay(start, today) : `${formatDay(start, today)} – ${formatDay(last, today)}`;
}

function barLabel(task: WorkTask, today: string): string {
  const parts = [`${task.key} ${task.title}`, task.is_milestone ? `веха ${formatPlan(task, today)}` : formatPlan(task, today)];
  if (!task.is_milestone && task.duration_workdays) parts.push(pluralWorkdays(task.duration_workdays));
  parts.push(TASK_STATUS_LABEL[task.status]);
  if (task.overdue) parts.push(`просрочена, срок ${formatDay(task.due_date, today)}`);
  else if (task.late) parts.push("отстаёт от плана");
  if (task.date_locked) parts.push("сроки закреплены");
  return parts.join(", ");
}

export function GanttChart(props: GanttChartProps) {
  const { rows, pool, dependencies, violations, range, zoom, today, canWrite, compact, collapsed, onToggle, keyOf, onOpen, onRequestSchedule, previewOps, ref } = props;
  const dayWidth = DAY_WIDTH[zoom];
  const namesWidth = compact ? 132 : 300;
  const width = (range.end - range.start) * dayWidth;
  const height = Math.max(rows.length, 1) * ROW_HEIGHT;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: FALLBACK_VIEWPORT });
  const scrollFrame = useRef<number | null>(null);
  const drag = useRef<PointerDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const suppressClick = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const canDrag = canWrite && !compact;

  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.task.id, index] as const)), [rows]);
  const x = useCallback((iso: string) => (toDay(iso) - range.start) * dayWidth, [range.start, dayWidth]);
  const violated = useMemo(() => new Set(violations.map((v) => v.dependency_id)), [violations]);
  const scale = useMemo(() => scaleCells(range, zoom, dayWidth), [range, zoom, dayWidth]);

  // The visible window of rows (virtualisation).
  const first = Math.max(0, Math.floor((view.top - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length - 1, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  const onScroll = () => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestFrame(() => {
      scrollFrame.current = null;
      const el = scrollerRef.current;
      if (el) setView({ top: el.scrollTop, height: el.clientHeight || FALLBACK_VIEWPORT });
    });
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) setView({ top: el.scrollTop, height: el.clientHeight || FALLBACK_VIEWPORT });
    return () => {
      if (scrollFrame.current !== null) cancelFrame(scrollFrame.current);
    };
  }, []);

  // Keep the date in the middle of the window when the zoom changes; on the first render show today.
  const lastZoom = useRef<{ zoom: GanttZoom; dayWidth: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const visible = Math.max(el.clientWidth - namesWidth, 0);
    if (lastZoom.current === null) {
      el.scrollLeft = Math.max(0, (toDay(today) - range.start) * dayWidth - visible / 4);
    } else if (lastZoom.current.zoom !== zoom) {
      const centreDay = (el.scrollLeft + visible / 2) / lastZoom.current.dayWidth;
      el.scrollLeft = Math.max(0, centreDay * dayWidth - visible / 2);
    }
    lastZoom.current = { zoom, dayWidth };
  }, [zoom, dayWidth, namesWidth, today, range.start]);

  function scrollToToday() {
    const el = scrollerRef.current;
    if (!el) return;
    const visible = Math.max(el.clientWidth - namesWidth, 0);
    el.scrollLeft = Math.max(0, (toDay(today) - range.start) * dayWidth - visible / 4);
  }

  useImperativeHandle(ref, () => ({ scrollToToday }));

  // --- painting a pending change directly in the DOM ------------------------------------------------------------
  function paint(p: Pending) {
    const planned = plannedChange(p.task, p.mode, p.delta);
    const body = p.element.querySelector<SVGElement>("[data-part='body']");
    const info = p.element.querySelector<SVGTextElement>("[data-part='info']");
    p.element.classList.toggle("is-changing", p.delta !== 0);
    if (!planned) return;
    const nx = (toDay(planned.start) - range.start) * dayWidth;
    if (p.task.is_milestone) {
      p.element.setAttribute("transform", `translate(${nx - (barGeometry(p.task, range, dayWidth)?.x ?? nx)}, 0)`);
    } else if (body) {
      const nw = (toDay(planned.endExclusive) - toDay(planned.start)) * dayWidth;
      body.setAttribute("x", String(nx));
      body.setAttribute("width", String(Math.max(nw, 2)));
      const handle = p.element.querySelector<SVGElement>("[data-part='resize']");
      handle?.setAttribute("x", String(nx + nw - RESIZE_HANDLE / 2));
    }
    if (info) {
      const lastDay = p.task.is_milestone ? planned.start : fromDay(toDay(planned.endExclusive) - 1);
      info.textContent = p.delta === 0 ? "" : span(planned.start, lastDay, today);
      info.setAttribute("x", String(nx));
    }
  }

  function reset(p: Pending) {
    p.element.removeAttribute("transform");
    p.element.classList.remove("is-changing", "is-dragging");
    const geometry = barGeometry(p.task, range, dayWidth);
    const body = p.element.querySelector<SVGElement>("[data-part='body']");
    const info = p.element.querySelector<SVGTextElement>("[data-part='info']");
    if (geometry && body && !geometry.milestone) {
      body.setAttribute("x", String(geometry.x));
      body.setAttribute("width", String(Math.max(geometry.width, 2)));
      p.element.querySelector<SVGElement>("[data-part='resize']")?.setAttribute("x", String(geometry.x + geometry.width - RESIZE_HANDLE / 2));
    }
    if (info) info.textContent = "";
  }

  function commit(p: Pending) {
    const planned = plannedChange(p.task, p.mode, p.delta);
    reset(p);
    if (!planned || p.delta === 0) return;
    onRequestSchedule(p.task, planned.change);
  }

  // --- pointer ---------------------------------------------------------------------------------------------------
  function onPointerDown(event: PointerEvent<SVGGElement>, task: WorkTask) {
    if (!canDrag || event.button !== 0 || drag.current || task.date_locked) return;
    const part = (event.target as Element).closest<SVGElement>("[data-part]")?.dataset.part;
    const mode: Mode = part === "resize" && !task.is_milestone ? "resize" : "move";
    if (pending.current) {
      reset(pending.current);
      pending.current = null;
    }
    drag.current = {
      task,
      mode,
      delta: 0,
      element: event.currentTarget,
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      framePending: false,
    };
  }

  function onPointerMove(event: PointerEvent<SVGGElement>) {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    if (!d.dragging) {
      if (Math.hypot(dx, event.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.dragging = true;
      capture(d.element, event.pointerId, true);
      d.element.classList.add("is-dragging");
    }
    const delta = Math.round(dx / dayWidth);
    if (delta === d.delta) return;
    d.delta = delta;
    if (!d.framePending) {
      d.framePending = true;
      requestFrame(() => {
        d.framePending = false;
        if (drag.current === d) paint(d);
      });
    }
  }

  function onPointerEnd(event: PointerEvent<SVGGElement>, cancelled: boolean) {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null; // a frame still scheduled will not paint
    if (!d.dragging) return; // a click opens the task
    capture(d.element, event.pointerId, false);
    suppressClick.current = true;
    if (cancelled) {
      reset(d);
      return;
    }
    commit(d);
  }

  function onBarClick(task: WorkTask) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onOpen(task);
  }

  // --- keyboard (WCAG 2.5.7: the same change without dragging) ------------------------------------------------------
  function onBarKeyDown(event: KeyboardEvent<SVGGElement>, task: WorkTask) {
    const element = event.currentTarget;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const p = pending.current;
      if (p && p.task.id === task.id && p.delta !== 0) {
        pending.current = null;
        commit(p);
      } else {
        onOpen(task);
      }
      return;
    }
    if (event.key === "Escape") {
      if (pending.current) {
        event.preventDefault();
        reset(pending.current);
        pending.current = null;
        setAnnouncement("Изменение отменено.");
      }
      return;
    }
    if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (!canWrite) return;
    if (task.date_locked) {
      setAnnouncement(`${task.key}: сроки закреплены — снимите закрепление в карточке задачи.`);
      return;
    }
    const mode: Mode = event.shiftKey && !task.is_milestone ? "resize" : "move";
    let p = pending.current;
    if (!p || p.task.id !== task.id || p.mode !== mode) {
      if (p) reset(p);
      p = { task, mode, delta: 0, element };
      pending.current = p;
    }
    p.delta += event.key === "ArrowLeft" ? -1 : 1;
    paint(p);
    const planned = plannedChange(task, mode, p.delta);
    if (planned) {
      const lastDay = task.is_milestone ? planned.start : fromDay(toDay(planned.endExclusive) - 1);
      setAnnouncement(
        `${task.key}: ${span(planned.start, lastDay, today)}. Enter — показать последствия, Esc — отменить.`,
      );
    }
  }

  // A pending keyboard change is dropped when focus leaves its bar.
  function onBarBlur(task: WorkTask) {
    const p = pending.current;
    if (p && p.task.id === task.id) {
      reset(p);
      pending.current = null;
    }
  }

  // --- what is drawn -----------------------------------------------------------------------------------------------
  const windowRows = rows.slice(first, last + 1);
  const arrows = useMemo(() => {
    const result: { id: string; d: string; violated: boolean; title: string; from: number; to: number }[] = [];
    for (const dep of dependencies) {
      const from = rowIndex.get(dep.predecessor_id);
      const to = rowIndex.get(dep.successor_id);
      if (from === undefined || to === undefined) continue;
      const pred = rows[from]?.task;
      const succ = rows[to]?.task;
      if (!pred || !succ) continue;
      const a = barGeometry(pred, range, dayWidth);
      const b = barGeometry(succ, range, dayWidth);
      if (!a || !b) continue;
      const fromX = a.milestone ? a.x + 7 : a.x + a.width;
      const toX = b.milestone ? b.x - 7 : b.x;
      result.push({
        id: dep.id,
        d: dependencyPath(fromX, from * ROW_HEIGHT + ROW_HEIGHT / 2, toX, to * ROW_HEIGHT + ROW_HEIGHT / 2, ROW_HEIGHT),
        violated: violated.has(dep.id),
        title: `${pred.key} → ${succ.key}: ${succ.key} начинается после окончания ${pred.key}${violated.has(dep.id) ? " (сейчас нарушено)" : ""}`,
        from,
        to,
      });
    }
    return result;
  }, [dependencies, rowIndex, rows, range, dayWidth, violated]);
  const visibleArrows = arrows.filter((a) => Math.max(a.from, a.to) >= first && Math.min(a.from, a.to) <= last);

  const ghosts = useMemo(() => {
    if (!previewOps) return [];
    return previewOps.flatMap((op) => {
      const index = rowIndex.get(op.task_id);
      if (index === undefined || !op.after.start_date || !op.after.end_exclusive) return [];
      const geometry = barGeometry({ start_date: op.after.start_date, end_exclusive: op.after.end_exclusive, is_milestone: op.after.start_date === op.after.end_exclusive }, range, dayWidth);
      return geometry ? [{ op, index, geometry }] : [];
    });
  }, [previewOps, rowIndex, range, dayWidth]);

  const todayX = x(today);
  const hintId = "gantt-keys";

  return (
    <div className="gantt" style={{ ["--gantt-names" as string]: `${namesWidth}px` }}>
      {/* What can be done with the bars: the description of the bars' group; visible on a phone (no dragging there). */}
      <p className={compact ? "gantt__hint muted" : "visually-hidden"} id={hintId}>
        {canDrag
          ? "Перетащите полосу — сдвиг, правый край — длительность. С клавиатуры: ← / → — сдвиг, Shift + ← / → — длительность, Enter — показать последствия, Esc — отмена."
          : canWrite
            ? "Сроки меняются в карточке задачи (кнопка на полосе открывает её); последствия показываются до применения."
            : "Только просмотр."}
      </p>
      <div className="gantt__scroller" ref={scrollerRef} onScroll={onScroll} tabIndex={0} aria-label="Диаграмма Ганта: прокрутка">
        <div className="gantt__content" style={{ width: namesWidth + width, height: HEADER_HEIGHT + height }}>
          <div className="gantt__header" style={{ width: namesWidth + width }}>
            <div className="gantt__corner" style={{ width: namesWidth }}>
              Задача
            </div>
            <svg className="gantt__scale" width={width} height={HEADER_HEIGHT} aria-hidden="true">
              {scale.top.map((cell) => (
                <g key={`t${cell.x}`}>
                  <line x1={cell.x} x2={cell.x} y1={0} y2={HEADER_HEIGHT} className="gantt__scale-rule" />
                  <text x={cell.x + 6} y={17} className="gantt__scale-top">
                    {cell.label}
                  </text>
                </g>
              ))}
              {scale.bottom.map((cell) => (
                <g key={`b${cell.x}`}>
                  <line x1={cell.x} x2={cell.x} y1={26} y2={HEADER_HEIGHT} className="gantt__scale-rule gantt__scale-rule--minor" />
                  {cell.width >= 18 ? (
                    <text x={cell.x + cell.width / 2} y={43} textAnchor="middle" className="gantt__scale-bottom">
                      <title>{cell.title}</title>
                      {cell.label}
                    </text>
                  ) : null}
                </g>
              ))}
              <g className="gantt__today-mark">
                <line x1={todayX} x2={todayX} y1={26} y2={HEADER_HEIGHT} />
              </g>
            </svg>
          </div>
          <div className="gantt__body" style={{ height }}>
            <div className="gantt__names" style={{ width: namesWidth, height }}>
              {windowRows.map((row, i) => (
                <GanttName
                  key={row.task.id}
                  row={row}
                  top={(first + i) * ROW_HEIGHT}
                  expanded={!collapsed.has(row.task.id)}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  compact={compact}
                />
              ))}
            </div>
            <svg className="gantt__chart" width={width} height={height} role="group" aria-label="Полосы задач" aria-describedby={hintId}>
              <defs>
                <pattern id="gantt-weekends" width={7 * dayWidth} height={ROW_HEIGHT} patternUnits="userSpaceOnUse">
                  <rect x={5 * dayWidth} y={0} width={2 * dayWidth} height={ROW_HEIGHT} className="gantt__weekend" />
                </pattern>
                <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 Z" className="gantt__arrowhead" />
                </marker>
                <marker id="gantt-arrow-violated" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 Z" className="gantt__arrowhead gantt__arrowhead--violated" />
                </marker>
              </defs>
              <rect x={0} y={0} width={width} height={height} fill="url(#gantt-weekends)" aria-hidden="true" />
              {zoom === "day" ? <rect x={todayX} y={0} width={dayWidth} height={height} className="gantt__today-band" aria-hidden="true" /> : null}
              <g aria-hidden="true">
                {windowRows.map((row, i) => (
                  <line key={row.task.id} x1={0} x2={width} y1={(first + i + 1) * ROW_HEIGHT} y2={(first + i + 1) * ROW_HEIGHT} className="gantt__row-rule" />
                ))}
              </g>
              <g className="gantt__arrows">
                {visibleArrows.map((arrow) => (
                  <g key={arrow.id} className={`gantt-arrow${arrow.violated ? " is-violated" : ""}`} data-dependency-id={arrow.id}>
                    <title>{arrow.title}</title>
                    <path d={arrow.d} className="gantt-arrow__hit" />
                    <path d={arrow.d} className="gantt-arrow__line" markerEnd={`url(#${arrow.violated ? "gantt-arrow-violated" : "gantt-arrow"})`} />
                  </g>
                ))}
              </g>
              <g className="gantt__ghosts" aria-hidden="true">
                {ghosts.map(({ op, index, geometry }) =>
                  geometry.milestone ? (
                    <path
                      key={op.task_id}
                      d={`M${geometry.x},${index * ROW_HEIGHT + ROW_HEIGHT / 2 - 8} l8,8 l-8,8 l-8,-8 Z`}
                      className={`gantt-ghost gantt-ghost--${op.change}`}
                      data-ghost-for={op.key}
                    />
                  ) : (
                    <rect
                      key={op.task_id}
                      x={geometry.x}
                      y={index * ROW_HEIGHT + BAR_TOP - 3}
                      width={Math.max(geometry.width, 2)}
                      height={BAR_HEIGHT + 6}
                      rx={5}
                      className={`gantt-ghost gantt-ghost--${op.change}`}
                      data-ghost-for={op.key}
                    />
                  ),
                )}
              </g>
              <g className="gantt__bars">
                {windowRows.map((row, i) => (
                  <GanttBar
                    key={row.task.id}
                    task={row.task}
                    context={row.context}
                    index={first + i}
                    range={range}
                    dayWidth={dayWidth}
                    today={today}
                    draggable={canDrag && !row.task.date_locked}
                    focusable
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerEnd={onPointerEnd}
                    onClick={onBarClick}
                    onKeyDown={onBarKeyDown}
                    onBlur={onBarBlur}
                  />
                ))}
              </g>
              <line x1={todayX} x2={todayX} y1={0} y2={height} className="gantt__today" aria-hidden="true" />
            </svg>
          </div>
        </div>
      </div>
      <GanttLegend />
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      <section className="gantt-pool" aria-labelledby="gantt-pool-title">
        <h2 className="gantt-pool__title" id="gantt-pool-title">
          Без дат <span className="gantt-pool__count">{pool.length}</span>
        </h2>
        {pool.length === 0 ? (
          <p className="muted">У всех задач есть даты.</p>
        ) : (
          <>
            <p className="muted">
              Даты не придумываются: планировщик пропускает эти задачи{canWrite ? ", пока в карточке не заданы начало и длительность" : ""}.
            </p>
            <ul className="gantt-pool__list">
              {pool.map((task) => (
                <li key={task.id} data-task-key={task.key}>
                  <button type="button" className="gantt-pool__item" onClick={() => onOpen(task)}>
                    <span className="gantt-pool__key">{task.key}</span>
                    <span className="gantt-pool__name">{task.title}</span>
                    {task.blocked_by.length ? <span className="muted">после {task.blocked_by.map(keyOf).join(", ")}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

interface GanttNameProps {
  row: VisibleRow;
  top: number;
  expanded: boolean;
  onToggle: (taskId: string) => void;
  onOpen: (task: WorkTask) => void;
  compact: boolean;
}

const GanttName = memo(function GanttName({ row, top, expanded, onToggle, onOpen, compact }: GanttNameProps) {
  const { task } = row;
  return (
    <div
      className={`gantt-name${row.context ? " is-context" : ""}${task.status === "done" ? " is-done" : ""}`}
      style={{ top, ["--depth" as string]: compact ? 0 : task.depth - 1 }}
      data-task-key={task.key}
    >
      {task.child_count > 0 ? (
        <button
          type="button"
          className="task-row__toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Свернуть" : "Развернуть"} подзадачи ${task.key}`}
          onClick={() => onToggle(task.id)}
        >
          <Icon name="chevron" size={14} />
        </button>
      ) : (
        <span className="task-row__toggle-space" aria-hidden="true" />
      )}
      <button type="button" className="gantt-name__open" onClick={() => onOpen(task)} title={`${task.key} ${task.title}`}>
        <span className="gantt-name__key">{task.key}</span>
        <span className="gantt-name__title">{task.title}</span>
      </button>
      {task.overdue || task.late ? <Icon name="alert" size={13} className="gantt-name__late" label={task.overdue ? "Просрочена" : "Отстаёт от плана"} /> : null}
      {task.date_locked ? <Icon name="lock" size={13} className="gantt-name__lock" label="Сроки закреплены" /> : null}
    </div>
  );
});

interface GanttBarProps {
  task: WorkTask;
  context: boolean;
  index: number;
  range: GanttRange;
  dayWidth: number;
  today: string;
  draggable: boolean;
  focusable: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>, task: WorkTask) => void;
  onPointerMove: (event: PointerEvent<SVGGElement>) => void;
  onPointerEnd: (event: PointerEvent<SVGGElement>, cancelled: boolean) => void;
  onClick: (task: WorkTask) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, task: WorkTask) => void;
  onBlur: (task: WorkTask) => void;
}

function GanttBar({ task, context, index, range, dayWidth, today, draggable, focusable, onPointerDown, onPointerMove, onPointerEnd, onClick, onKeyDown, onBlur }: GanttBarProps) {
  const geometry = barGeometry(task, range, dayWidth);
  const y = index * ROW_HEIGHT;
  const due = task.due_date ? (toDay(task.due_date) + 1 - range.start) * dayWidth : null;
  const classes = [
    "gantt-bar",
    `gantt-bar--${task.status}`,
    geometry?.milestone ? "gantt-bar--milestone" : "",
    task.overdue || task.late ? "is-late" : "",
    task.date_locked ? "is-locked" : "",
    draggable ? "is-draggable" : "",
    context ? "is-context" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <g>
      {due !== null ? (
        <g className={`gantt-due${task.overdue ? " is-overdue" : ""}`} aria-hidden="true">
          <title>{`Срок ${task.key}: ${formatDay(task.due_date, today)} (включительно)`}</title>
          <line x1={due} x2={due} y1={y + 6} y2={y + ROW_HEIGHT - 6} />
          <path d={`M${due},${y + 6} l-5,0 l5,5 Z`} />
        </g>
      ) : null}
      {geometry ? (
        <g
          className={classes}
          data-task-id={task.id}
          data-task-key={task.key}
          role="button"
          tabIndex={focusable ? 0 : -1}
          aria-label={barLabel(task, today)}
          onPointerDown={(event) => onPointerDown(event, task)}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => onPointerEnd(event, false)}
          onPointerCancel={(event) => onPointerEnd(event, true)}
          onClick={() => onClick(task)}
          onKeyDown={(event) => onKeyDown(event, task)}
          onBlur={() => onBlur(task)}
        >
          {geometry.milestone ? (
            <path d={`M${geometry.x},${y + ROW_HEIGHT / 2 - 8} l8,8 l-8,8 l-8,-8 Z`} className="gantt-bar__diamond" data-part="body" />
          ) : (
            <rect x={geometry.x} y={y + BAR_TOP} width={Math.max(geometry.width, 2)} height={BAR_HEIGHT} rx={4} className="gantt-bar__body" data-part="body" />
          )}
          {!geometry.milestone && task.status === "done" ? (
            <path d={`M${geometry.x + 5},${y + ROW_HEIGHT / 2} l3,3 l6,-6`} className="gantt-bar__tick" />
          ) : null}
          {task.date_locked ? (
            <g transform={`translate(${geometry.milestone ? geometry.x + 10 : geometry.x + 3}, ${y + BAR_TOP + 2}) scale(0.58)`} className="gantt-bar__lock">
              <rect x="5" y="10.5" width="14" height="10" rx="2" />
              <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
            </g>
          ) : null}
          {!geometry.milestone && draggable ? (
            <rect
              x={geometry.x + geometry.width - RESIZE_HANDLE / 2}
              y={y + BAR_TOP}
              width={RESIZE_HANDLE}
              height={BAR_HEIGHT}
              className="gantt-bar__resize"
              data-part="resize"
            />
          ) : null}
          <text x={(geometry.milestone ? geometry.x + 12 : geometry.x + geometry.width + 6) + (task.date_locked && geometry.milestone ? 12 : 0)} y={y + ROW_HEIGHT / 2 + 4} className="gantt-bar__label">
            {task.title}
          </text>
          <text x={geometry.x} y={y + 9} className="gantt-bar__info" data-part="info" />
        </g>
      ) : (
        <text x={6} y={y + ROW_HEIGHT / 2 + 4} className="gantt-bar__none">
          без дат
        </text>
      )}
    </g>
  );
}

function GanttLegend() {
  return (
    <ul className="gantt-legend" aria-label="Обозначения">
      <li>
        <span className="gantt-legend__bar gantt-legend__bar--todo" aria-hidden="true" />К работе
      </li>
      <li>
        <span className="gantt-legend__bar gantt-legend__bar--in_progress" aria-hidden="true" />В работе
      </li>
      <li>
        <span className="gantt-legend__bar gantt-legend__bar--review" aria-hidden="true" />На проверке
      </li>
      <li>
        <span className="gantt-legend__bar gantt-legend__bar--done" aria-hidden="true" />Готово
      </li>
      <li>
        <Icon name="milestone" size={13} />
        Веха
      </li>
      <li>
        <span className="gantt-legend__bar gantt-legend__bar--late" aria-hidden="true" />
        Отстаёт / просрочена
      </li>
      <li>
        <span className="gantt-legend__due" aria-hidden="true" />
        Срок (включительно)
      </li>
      <li>
        <span className="gantt-legend__bar gantt-legend__bar--ghost" aria-hidden="true" />
        Предпросмотр
      </li>
      <li>
        <span className="gantt-legend__weekend" aria-hidden="true" />
        Выходные (Пн–Пт — рабочие)
      </li>
    </ul>
  );
}
