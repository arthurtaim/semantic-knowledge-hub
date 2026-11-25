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
  type RefObject,
} from "react";
import type { ScheduleOperation, ScheduleViolation, TaskDateChange, WorkDependency, WorkTask } from "../../api/types";
import {
  arrowEnds,
  arrowHead,
  barBox,
  chartRange,
  createTextMeasure,
  DAY_WIDTH,
  decideLabel,
  fitDayWidth,
  fitStartDay,
  lateEnd as lateEndOf,
  markerText,
  MILESTONE_HALF,
  projectSpan,
  routeDependency,
  scaleRows,
  scrollForDay,
  summarySpans,
  TODAY_AT,
  type BarBox,
  type ChartWindow,
  type DaySpan,
  type GanttZoom,
  type LabelDecision,
} from "../../lib/gantt";
import {
  addWorkdays,
  formatDay,
  formatPlan,
  fromDay,
  isoWeekday,
  lastWorkday,
  nextWorkday,
  pluralWorkdays,
  TASK_STATUS_LABEL,
  toDay,
  type VisibleRow,
} from "../../lib/work";
import { Icon } from "../ui/Icon";

/*
 * «Гант» (M6; Planner v2 — docs/ui-v2/planner/specs/PLANNER_V2.md §3): an interactive projection of the server's
 * plan, never its source. Own SVG/DOM (the house approach of the knowledge map) instead of a library: the half-open
 * `[start, end_exclusive)` interval, the Mon–Fri calendar, milestones as points, the unscheduled pool and the
 * preview-before-apply flow need full control, and every colour is a token of the visual system.
 *
 * - The geometry is lib/gantt.ts: zoom levels and «Вписать», the adaptive two-row scale, label placement, markers
 *   of tasks outside the window, arrow routing in the gutter. This file draws it.
 * - Layers, bottom to top (§3.6): grid and weekends → arrows → the «сегодня» line → bars → labels on their backing.
 * - A bar covers `[start_date, end_exclusive)`; a milestone is a diamond on its day boundary; a task with scheduled
 *   subtasks is a bracket over them (§3.4, not draggable: its subtasks' dates change); an overdue task is hatched
 *   from its end to today.
 * - Drag a bar to move it, its right edge to change the duration (snapped to days, the ghost follows the Mon–Fri
 *   calendar exactly as the server will). Nothing changes on drop: the parent opens the schedule preview.
 * - Keyboard (WCAG 2.5.7): a focused bar moves with ← / →, changes its duration with Shift + ← / →; Enter shows the
 *   consequences (or opens the task when nothing is pending), Esc cancels.
 * - Rows are virtualised (only the visible window plus a margin is in the DOM); only what touches the visible window
 *   horizontally is computed; a drag paints the bar directly in one animation frame per move — no React render per
 *   pointer frame.
 */

export const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 48;
const BAR_HEIGHT = 20;
const BAR_TOP = (ROW_HEIGHT - BAR_HEIGHT) / 2;
const SUMMARY_TOP = 12;
const SUMMARY_HEIGHT = 11;
const OVERSCAN = 8;
const DRAG_THRESHOLD = 4;
const RESIZE_HANDLE = 8;
/** jsdom and the first render have no size: assume a usual window. */
const FALLBACK = { width: 1100, height: 640 };
export const NAMES_WIDTH = 300;
export const NAMES_WIDTH_PHONE = 132;

export interface GanttChartProps {
  rows: VisibleRow[];
  /** Unscheduled tasks matching the filters that are not chart rows. */
  pool: WorkTask[];
  /** Every task of the snapshot: a summary covers all its descendants; a hidden task's arrows end at its ancestor. */
  tasks: WorkTask[];
  dependencies: WorkDependency[];
  violations: ScheduleViolation[];
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

function barLabel(task: WorkTask, today: string, summary: DaySpan | undefined): string {
  const parts = [`${task.key} ${task.title}`];
  if (summary) {
    const last = summary.end > summary.start ? summary.end - 1 : summary.start;
    parts.push(`сроки по подзадачам: ${span(fromDay(summary.start), fromDay(last), today)}`);
  } else {
    parts.push(task.is_milestone ? `веха ${formatPlan(task, today)}` : formatPlan(task, today));
    if (!task.is_milestone && task.duration_workdays) parts.push(pluralWorkdays(task.duration_workdays));
  }
  parts.push(TASK_STATUS_LABEL[task.status]);
  if (task.overdue) parts.push(`просрочена, срок ${formatDay(task.due_date, today)}`);
  else if (task.late) parts.push("отстаёт от плана");
  if (task.date_locked) parts.push("сроки закреплены");
  return parts.join(", ");
}

/** What a row draws: its box on the scale, the overdue hatching, where its label goes. */
interface RowModel {
  task: WorkTask;
  index: number;
  box: BarBox;
  lateEnd: number | null;
  label: LabelDecision;
  /** The marker's text and width when the task lies outside the window. */
  marker: { text: string; width: number } | null;
}

function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState(FALLBACK);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setSize({ width: el.clientWidth || FALLBACK.width, height: el.clientHeight || FALLBACK.height });
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function GanttChart(props: GanttChartProps) {
  const { rows, pool, tasks, dependencies, violations, zoom, today, canWrite, compact, collapsed, onToggle, keyOf, onOpen, onRequestSchedule, previewOps, ref } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollerRef);
  const namesWidth = compact ? NAMES_WIDTH_PHONE : NAMES_WIDTH;
  const visibleWidth = Math.max(size.width - namesWidth, 160);
  const todayDay = toDay(today);

  // Text widths: an offscreen canvas with a cache per font; dropped once the web font has loaded.
  const measure = useMemo(() => createTextMeasure(), []);
  const [, setFontsReady] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts?.ready) return undefined;
    let live = true;
    void fonts.ready.then(() => {
      if (!live) return;
      measure.reset();
      setFontsReady((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [measure]);

  const summaries = useMemo(() => summarySpans(tasks), [tasks]);
  const extent = useMemo(() => {
    const own = projectSpan(rows.map((row) => row.task));
    let merged = own;
    for (const row of rows) {
      const s = summaries.get(row.task.id);
      if (s) merged = merged ? { start: Math.min(merged.start, s.start), end: Math.max(merged.end, s.end) } : s;
    }
    return merged;
  }, [rows, summaries]);
  const dayWidth = zoom === "fit" ? fitDayWidth(visibleWidth, extent) : DAY_WIDTH[zoom];
  const range = useMemo(() => chartRange(tasks, today, dayWidth, visibleWidth), [tasks, today, dayWidth, visibleWidth]);
  const chartWidth = (range.end - range.start) * dayWidth;
  const height = Math.max(rows.length, 1) * ROW_HEIGHT;

  const [view, setView] = useState({ left: 0, top: 0 });
  const scrollFrame = useRef<number | null>(null);
  const drag = useRef<PointerDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const suppressClick = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const canDrag = canWrite && !compact;

  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.task.id, index] as const)), [rows]);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task] as const)), [tasks]);
  const violated = useMemo(() => new Set(violations.map((v) => v.dependency_id)), [violations]);
  const violatedSuccessors = useMemo(() => new Set(violations.map((v) => v.successor_id)), [violations]);

  const win: ChartWindow = useMemo(() => ({ x0: view.left, x1: view.left + visibleWidth }), [view.left, visibleWidth]);
  const scale = useMemo(() => scaleRows(range, dayWidth, win, todayDay, measure), [range, dayWidth, win, todayDay, measure]);

  // The visible window of rows (virtualisation).
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length - 1, Math.ceil((view.top + size.height) / ROW_HEIGHT) + OVERSCAN);

  const onScroll = () => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestFrame(() => {
      scrollFrame.current = null;
      const el = scrollerRef.current;
      if (el) setView({ left: el.scrollLeft, top: el.scrollTop });
    });
  };

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelFrame(scrollFrame.current);
    },
    [],
  );

  // Where the window goes when the scale changes: «Вписать» shows the project from its start; any other change keeps
  // the date in the middle of the window in the middle; the first render shows today at 30 % of the width.
  const layout = useRef<{ dayWidth: number; start: number; visible: number; zoom: GanttZoom } | null>(null);
  const anchor = useRef<{ day: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const prev = layout.current;
    let target: number | null = null;
    if (anchor.current) {
      target = scrollForDay(anchor.current.day, anchor.current.offset, range, dayWidth);
      anchor.current = null;
    } else if (!prev || (prev.zoom !== zoom && zoom === "fit")) {
      target =
        zoom === "fit"
          ? scrollForDay(fitStartDay(extent, todayDay), 0, range, dayWidth)
          : scrollForDay(todayDay, visibleWidth * TODAY_AT, range, dayWidth);
    } else if (prev.dayWidth !== dayWidth || prev.start !== range.start || prev.visible !== visibleWidth) {
      const centre = prev.start + (el.scrollLeft + prev.visible / 2) / prev.dayWidth;
      target = scrollForDay(centre, visibleWidth / 2, range, dayWidth);
    }
    layout.current = { dayWidth, start: range.start, visible: visibleWidth, zoom };
    if (target !== null) {
      el.scrollLeft = target;
      setView({ left: el.scrollLeft, top: el.scrollTop });
    }
  }, [zoom, dayWidth, range, visibleWidth, extent, todayDay]);

  const scrollToToday = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = scrollForDay(todayDay, visibleWidth * TODAY_AT, range, dayWidth);
    setView({ left: el.scrollLeft, top: el.scrollTop });
  }, [todayDay, visibleWidth, range, dayWidth]);

  useImperativeHandle(ref, () => ({ scrollToToday }), [scrollToToday]);

  /** Scrolls so that a task outside the window starts at 10 % of its width (a marker was pressed). */
  function scrollToTask(box: BarBox) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, box.x - visibleWidth * 0.1);
    setView({ left: el.scrollLeft, top: el.scrollTop });
  }

  // --- the row models: boxes, hatching, labels and markers for the visible window ------------------------------------
  const modelOf = useCallback(
    (task: WorkTask, index: number): RowModel | null => {
      const box = barBox(task, range, dayWidth, summaries.get(task.id));
      if (!box) return null;
      const late = lateEndOf(task, box, todayDay, range, dayWidth);
      const strong = box.kind !== "task";
      const label = decideLabel({
        kind: box.kind,
        x: box.x,
        width: box.width,
        lateEnd: late,
        done: task.status === "done",
        textWidth: measure(task.title, strong ? "label-strong" : "label"),
        window: win,
        labels: "auto",
      });
      let marker: RowModel["marker"] = null;
      if (label.place === "before" || label.place === "after") {
        const text = markerText(label.place, box.start, box.end, box.kind === "milestone");
        marker = { text, width: measure(text, "marker") + 8 };
      }
      return { task, index, box, lateEnd: late, label, marker };
    },
    [range, dayWidth, summaries, todayDay, measure, win],
  );

  const windowRows = rows.slice(first, last + 1);
  const models = useMemo(() => {
    const out = new Map<string, RowModel>();
    windowRows.forEach((row, i) => {
      const model = modelOf(row.task, first + i);
      if (model) out.set(row.task.id, model);
    });
    return out;
  }, [windowRows, modelOf, first]);

  // --- arrows: every dependency touching the window, routed in the gutter -------------------------------------------
  /** The row that shows a task: its own, or its nearest visible ancestor's (a collapsed branch). */
  const shownRow = useCallback(
    (taskId: string): number | undefined => {
      let id: string | null = taskId;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        const index = rowIndex.get(id);
        if (index !== undefined) return index;
        id = byId.get(id)?.parent_task_id ?? null;
      }
      return undefined;
    },
    [rowIndex, byId],
  );

  const arrows = useMemo(() => {
    const result: { id: string; d: string; head: string; violated: boolean; title: string }[] = [];
    const model = (index: number) => {
      const row = rows[index];
      if (!row) return null;
      return models.get(row.task.id) ?? modelOf(row.task, index);
    };
    for (const dep of dependencies) {
      const from = shownRow(dep.predecessor_id);
      const to = shownRow(dep.successor_id);
      if (from === undefined || to === undefined || from === to) continue;
      if (Math.max(from, to) < first || Math.min(from, to) > last) continue;
      const a = model(from);
      const b = model(to);
      if (!a || !b) continue;
      const ends = arrowEnds(a, b, win);
      if (!ends) continue;
      const y1 = from * ROW_HEIGHT + ROW_HEIGHT / 2;
      const y2 = to * ROW_HEIGHT + ROW_HEIGHT / 2;
      const pred = byId.get(dep.predecessor_id);
      const succ = byId.get(dep.successor_id);
      const isViolated = violated.has(dep.id);
      result.push({
        id: dep.id,
        d: routeDependency(ends.x1, y1, ends.x2, y2, ROW_HEIGHT),
        head: arrowHead(ends.x2, y2),
        violated: isViolated,
        title: `${pred?.key ?? "?"} → ${succ?.key ?? "?"}: ${succ?.key ?? "?"} начинается после окончания ${pred?.key ?? "?"}${isViolated ? " (сейчас нарушено)" : ""}`,
      });
    }
    return result;
  }, [dependencies, shownRow, rows, models, modelOf, first, last, byId, violated, win]);

  const ghosts = useMemo(() => {
    if (!previewOps) return [];
    return previewOps.flatMap((op) => {
      const index = rowIndex.get(op.task_id);
      if (index === undefined || !op.after.start_date || !op.after.end_exclusive) return [];
      const box = barBox(
        { start_date: op.after.start_date, end_exclusive: op.after.end_exclusive, is_milestone: op.after.start_date === op.after.end_exclusive },
        range,
        dayWidth,
      );
      return box ? [{ op, index, box }] : [];
    });
  }, [previewOps, rowIndex, range, dayWidth]);

  // --- painting a pending change directly in the DOM ------------------------------------------------------------
  function geometryOf(task: WorkTask): BarBox | null {
    return barBox(task, range, dayWidth, null);
  }

  function paint(p: Pending) {
    const planned = plannedChange(p.task, p.mode, p.delta);
    const body = p.element.querySelector<SVGElement>("[data-part='body']");
    const info = p.element.querySelector<SVGTextElement>("[data-part='info']");
    p.element.classList.toggle("is-changing", p.delta !== 0);
    if (!planned) return;
    const nx = (toDay(planned.start) - range.start) * dayWidth;
    const box = geometryOf(p.task);
    if (p.task.is_milestone) {
      p.element.setAttribute("transform", `translate(${nx - ((box?.x ?? nx) + MILESTONE_HALF)}, 0)`);
    } else if (body) {
      const nw = (toDay(planned.endExclusive) - toDay(planned.start)) * dayWidth;
      body.setAttribute("x", String(nx));
      body.setAttribute("width", String(Math.max(nw, 2)));
      p.element.querySelector<SVGElement>("[data-part='resize']")?.setAttribute("x", String(nx + nw - RESIZE_HANDLE / 2));
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
    const box = geometryOf(p.task);
    const body = p.element.querySelector<SVGElement>("[data-part='body']");
    const info = p.element.querySelector<SVGTextElement>("[data-part='info']");
    if (box && body && box.kind === "task") {
      body.setAttribute("x", String(box.x));
      body.setAttribute("width", String(box.width));
      p.element.querySelector<SVGElement>("[data-part='resize']")?.setAttribute("x", String(box.x + box.width - RESIZE_HANDLE / 2));
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
    if (!canDrag || event.button !== 0 || drag.current || task.date_locked || summaries.has(task.id)) return;
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
    if (summaries.has(task.id)) {
      setAnnouncement(`${task.key}: сроки по подзадачам — меняйте сроки подзадач.`);
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
      setAnnouncement(`${task.key}: ${span(planned.start, lastDay, today)}. Enter — показать последствия, Esc — отменить.`);
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
  const todayX = (todayDay - range.start + 0.5) * dayWidth;
  const hintId = "gantt-keys";
  const firstDay = range.start + Math.max(0, Math.floor(win.x0 / dayWidth) - 1);
  const lastDay = range.start + Math.ceil(win.x1 / dayWidth) + 1;
  const weekends: number[] = [];
  if (dayWidth >= 10) {
    for (let day = firstDay; day <= lastDay; day += 1) if (isoWeekday(day) === 6) weekends.push(day);
  }
  const gridLines = scale.bottom
    .map((cell) => (cell.day - range.start) * dayWidth)
    .filter((x) => x >= win.x0 - 1 && x > 0);
  const modelList = windowRows.flatMap((row) => {
    const model = models.get(row.task.id);
    return model ? [{ row, model }] : [];
  });

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
        <div className="gantt__content" style={{ width: namesWidth + chartWidth, height: HEADER_HEIGHT + height }}>
          <div className="gantt__header" style={{ width: namesWidth + chartWidth }}>
            <div className="gantt__corner" style={{ width: namesWidth }}>
              <span>Задача</span>
            </div>
            <div className="gantt__scale" style={{ width: chartWidth }} aria-hidden="true">
              {scale.top.map((cell) => (
                <div key={`t${cell.day}`} className="gantt__scale-top" style={{ left: cell.x, width: cell.width }} title={cell.title}>
                  {cell.label}
                </div>
              ))}
              {scale.bottom.map((cell) => (
                <div
                  key={`b${cell.day}`}
                  className={`gantt__scale-bottom gantt__scale-bottom--${scale.units.bottom}${cell.weekend ? " is-weekend" : ""}`}
                  style={{ left: cell.x, width: cell.width }}
                  title={cell.title}
                >
                  {cell.label}
                </div>
              ))}
              {scale.today ? (
                <div className="gantt__today-mark" style={{ left: scale.today.x - scale.today.width / 2, width: scale.today.width }}>
                  {scale.today.label}
                </div>
              ) : null}
            </div>
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
            <div className="gantt__area" style={{ width: chartWidth, height }}>
              <svg className="gantt__chart" width={chartWidth} height={height} role="group" aria-label="Полосы задач" aria-describedby={hintId}>
                <defs>
                  <pattern id="gantt-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="8" height="8" className="gantt__hatch-b" />
                    <rect width="4" height="8" className="gantt__hatch-a" />
                  </pattern>
                </defs>
                <g className="gantt__grid" aria-hidden="true">
                  {weekends.map((day) => (
                    <rect key={day} x={(day - range.start) * dayWidth} y={0} width={2 * dayWidth} height={height} className="gantt__weekend" />
                  ))}
                  {gridLines.map((x) => (
                    <line key={x} x1={x} x2={x} y1={0} y2={height} className="gantt__grid-line" />
                  ))}
                  {windowRows.map((row, i) => (
                    <line key={row.task.id} x1={win.x0} x2={win.x1} y1={(first + i + 1) * ROW_HEIGHT} y2={(first + i + 1) * ROW_HEIGHT} className="gantt__row-rule" />
                  ))}
                </g>
                <g className="gantt__arrows">
                  {arrows.map((arrow) => (
                    <g key={arrow.id} className={`gantt-arrow${arrow.violated ? " is-violated" : ""}`} data-dependency-id={arrow.id}>
                      <title>{arrow.title}</title>
                      <path d={arrow.d} className="gantt-arrow__hit" />
                      <path d={arrow.d} className="gantt-arrow__line" />
                      <path d={arrow.head} className="gantt-arrow__head" />
                    </g>
                  ))}
                </g>
                <line x1={todayX} x2={todayX} y1={0} y2={height} className="gantt__today" aria-hidden="true" />
                <g className="gantt__ghosts" aria-hidden="true">
                  {ghosts.map(({ op, index, box }) =>
                    box.kind === "milestone" ? (
                      <path
                        key={op.task_id}
                        d={`M${box.x + MILESTONE_HALF},${index * ROW_HEIGHT + ROW_HEIGHT / 2 - 9} l9,9 l-9,9 l-9,-9 Z`}
                        className={`gantt-ghost gantt-ghost--${op.change}`}
                        data-ghost-for={op.key}
                      />
                    ) : (
                      <rect
                        key={op.task_id}
                        x={box.x}
                        y={index * ROW_HEIGHT + BAR_TOP - 3}
                        width={box.width}
                        height={BAR_HEIGHT + 6}
                        rx={6}
                        className={`gantt-ghost gantt-ghost--${op.change}`}
                        data-ghost-for={op.key}
                      />
                    ),
                  )}
                </g>
                <g className="gantt__bars">
                  {modelList.map(({ row, model }) => (
                    <GanttBar
                      key={row.task.id}
                      model={model}
                      context={row.context}
                      today={today}
                      summary={summaries.get(row.task.id)}
                      violated={violatedSuccessors.has(row.task.id)}
                      draggable={canDrag && !row.task.date_locked && model.box.kind !== "summary"}
                      onPointerDown={onPointerDown}
                      onPointerMove={onPointerMove}
                      onPointerEnd={onPointerEnd}
                      onClick={onBarClick}
                      onKeyDown={onBarKeyDown}
                      onBlur={onBarBlur}
                    />
                  ))}
                  {windowRows
                    .filter((row) => !models.has(row.task.id))
                    .map((row) => (
                      <text key={row.task.id} x={win.x0 + 6} y={(rowIndex.get(row.task.id) ?? 0) * ROW_HEIGHT + ROW_HEIGHT / 2 + 4} className="gantt-bar__none">
                        без дат
                      </text>
                    ))}
                </g>
              </svg>
              <div className="gantt__labels">
                {modelList.map(({ row, model }) => (
                  <GanttLabel key={row.task.id} model={model} onMarker={scrollToTask} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <GanttLegend ghosts={ghosts.length > 0} />
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {pool.length ? (
        <section className="gantt-pool" aria-labelledby="gantt-pool-title">
          <h2 className="gantt-pool__title" id="gantt-pool-title">
            Без дат <span className="gantt-pool__count">{pool.length}</span>
          </h2>
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
        </section>
      ) : null}
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
      {task.overdue || task.late ? <Icon name="alert" size={14} className="gantt-name__late" label={task.overdue ? "Просрочена" : "Отстаёт от плана"} /> : null}
      {task.date_locked ? <Icon name="lock" size={13} className="gantt-name__lock" label="Сроки закреплены" /> : null}
    </div>
  );
});

interface GanttBarProps {
  model: RowModel;
  context: boolean;
  today: string;
  summary: DaySpan | undefined;
  violated: boolean;
  draggable: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>, task: WorkTask) => void;
  onPointerMove: (event: PointerEvent<SVGGElement>) => void;
  onPointerEnd: (event: PointerEvent<SVGGElement>, cancelled: boolean) => void;
  onClick: (task: WorkTask) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, task: WorkTask) => void;
  onBlur: (task: WorkTask) => void;
}

function GanttBar({ model, context, today, summary, violated, draggable, onPointerDown, onPointerMove, onPointerEnd, onClick, onKeyDown, onBlur }: GanttBarProps) {
  const { task, box, lateEnd, label, index } = model;
  const y = index * ROW_HEIGHT;
  const done = task.status === "done";
  const classes = [
    "gantt-bar",
    `gantt-bar--${task.status}`,
    box.kind === "milestone" ? "gantt-bar--milestone" : "",
    box.kind === "summary" ? "gantt-bar--summary" : "",
    task.overdue || task.late ? "is-late" : "",
    task.date_locked ? "is-locked" : "",
    violated ? "is-violated" : "",
    draggable ? "is-draggable" : "",
    context ? "is-context" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const cx = box.x + MILESTONE_HALF;
  const midY = y + ROW_HEIGHT / 2;
  return (
    <g
      className={classes}
      data-task-id={task.id}
      data-task-key={task.key}
      role="button"
      tabIndex={0}
      aria-label={barLabel(task, today, summary)}
      onPointerDown={(event) => onPointerDown(event, task)}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => onPointerEnd(event, false)}
      onPointerCancel={(event) => onPointerEnd(event, true)}
      onClick={() => onClick(task)}
      onKeyDown={(event) => onKeyDown(event, task)}
      onBlur={() => onBlur(task)}
    >
      <title>{summary ? `${task.key} · ${task.title} · сроки по подзадачам` : `${task.key} · ${task.title}`}</title>
      {lateEnd !== null ? (
        <g className="gantt-bar__late" aria-hidden="true">
          <rect x={box.x + box.width} y={y + BAR_TOP} width={lateEnd - box.x - box.width} height={BAR_HEIGHT} className="gantt-bar__hatch" />
          <line x1={lateEnd - 1} x2={lateEnd - 1} y1={y + BAR_TOP} y2={y + BAR_TOP + BAR_HEIGHT} className="gantt-bar__late-line" />
        </g>
      ) : null}
      {box.kind === "milestone" ? (
        <path d={`M${cx},${midY - MILESTONE_HALF} l${MILESTONE_HALF},${MILESTONE_HALF} l${-MILESTONE_HALF},${MILESTONE_HALF} l${-MILESTONE_HALF},${-MILESTONE_HALF} Z`} className="gantt-bar__diamond" data-part="body" />
      ) : box.kind === "summary" ? (
        <path
          d={`M${box.x},${y + SUMMARY_TOP} H${box.x + box.width} V${y + SUMMARY_TOP + SUMMARY_HEIGHT} L${box.x + box.width - 5},${y + SUMMARY_TOP + 6} H${box.x + 5} L${box.x},${y + SUMMARY_TOP + SUMMARY_HEIGHT} Z`}
          className="gantt-bar__summary"
          data-part="body"
        />
      ) : (
        <rect x={box.x} y={y + BAR_TOP} width={box.width} height={BAR_HEIGHT} rx={5} className="gantt-bar__body" data-part="body" />
      )}
      {box.kind === "task" && done && label.place === "inside" ? (
        <path d={`M${label.x - 14 + 1},${midY} l2.5,2.5 l5,-5`} className="gantt-bar__tick" />
      ) : box.kind === "task" && done && box.width >= 24 ? (
        <path d={`M${box.x + 8},${midY} l2.5,2.5 l5,-5`} className="gantt-bar__tick" />
      ) : null}
      {task.date_locked && box.kind !== "summary" ? (
        <g transform={`translate(${box.kind === "milestone" ? box.x - 13 : box.x + 3}, ${y + BAR_TOP + 3}) scale(0.58)`} className="gantt-bar__lock">
          <rect x="5" y="10.5" width="14" height="10" rx="2" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </g>
      ) : null}
      {label.place === "inside" ? (
        <text x={label.x} y={midY + 4} className="gantt-bar__text">
          {task.title}
        </text>
      ) : null}
      {box.kind === "task" && draggable ? (
        <rect x={box.x + box.width - RESIZE_HANDLE / 2} y={y + BAR_TOP} width={RESIZE_HANDLE} height={BAR_HEIGHT} className="gantt-bar__resize" data-part="resize" />
      ) : null}
      <text x={box.x} y={y + 7} className="gantt-bar__info" data-part="info" />
    </g>
  );
}

function GanttLabel({ model, onMarker }: { model: RowModel; onMarker: (box: BarBox) => void }) {
  const { task, box, label, marker, index } = model;
  const top = index * ROW_HEIGHT + BAR_TOP;
  if (label.place === "right") {
    const strong = box.kind !== "task";
    return (
      <div
        className={`gantt__label${strong ? " gantt__label--strong" : ""}${task.status === "done" ? " is-done" : ""}`}
        style={{ left: label.x, top, maxWidth: label.maxWidth }}
        aria-hidden="true"
      >
        {task.title}
      </div>
    );
  }
  if ((label.place === "before" || label.place === "after") && marker) {
    const left = label.place === "before" ? label.x : label.x - marker.width;
    return (
      <button
        type="button"
        tabIndex={-1}
        className={`gantt__label gantt__marker gantt__marker--${label.place}`}
        style={{ left, top, width: marker.width }}
        aria-label={`${task.key}: ${marker.text.replace(/[‹›]/g, "").trim()} — показать на шкале`}
        onClick={() => onMarker(box)}
      >
        {marker.text}
      </button>
    );
  }
  return null;
}

function GanttLegend({ ghosts }: { ghosts: boolean }) {
  return (
    <div className="gantt-legend-row">
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
          <span className="gantt-legend__late" aria-hidden="true" />
          Просрочка
        </li>
        <li>
          <span className="gantt-legend__summary" aria-hidden="true" />
          По подзадачам
        </li>
        <li>
          <Icon name="milestone" size={12} strokeWidth={2.4} />
          Веха
        </li>
        {ghosts ? (
          <li>
            <span className="gantt-legend__bar gantt-legend__bar--ghost" aria-hidden="true" />
            Предпросмотр
          </li>
        ) : null}
      </ul>
    </div>
  );
}

