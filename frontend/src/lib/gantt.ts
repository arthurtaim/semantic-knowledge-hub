import type { WorkTask } from "../api/types";
import { readPreference, writePreference } from "./storage";
import { formatDay, fromDay, isoWeekday, toDay } from "./work";

/*
 * Planner v2 — the Gantt's geometry without any UI (docs/ui-v2/planner/specs/PLANNER_V2.md §3): zoom levels and
 * «Вписать», the adaptive two-row scale, where a bar's label goes, how a Finish-to-Start arrow is routed and which
 * arrows are drawn. The rules are ported from the mockup's `renderVals()` (design-source/PlanGantt.dc.html), not its
 * markup. Everything works on whole day numbers (lib/work.ts `toDay`) and on pixels of the chart's content box.
 *
 * Text widths come from a `TextMeasure` (canvas `measureText` with a cache per font in the app; a fixed width per
 * character in tests), never from reading the layout of the DOM in a loop.
 */

// --- zoom ------------------------------------------------------------------------------------------------------------

export type GanttZoom = "day" | "week" | "month" | "quarter" | "year" | "fit";
export type FixedZoom = Exclude<GanttZoom, "fit">;

export const FIXED_ZOOMS: readonly FixedZoom[] = ["day", "week", "month", "quarter", "year"];
export const GANTT_ZOOMS: readonly GanttZoom[] = [...FIXED_ZOOMS, "fit"];
export const GANTT_ZOOM_LABEL: Record<GanttZoom, string> = {
  day: "День",
  week: "Неделя",
  month: "Месяц",
  quarter: "Квартал",
  year: "Год",
  fit: "Вписать",
};

/** Pixels per calendar day of the fixed zoom levels (§3.2). */
export const DAY_WIDTH: Record<FixedZoom, number> = { day: 36, week: 16, month: 5, quarter: 1.8, year: 0.62 };
/** The range of the smooth zoom (Ctrl/⌘ + wheel, a pinch). */
export const MIN_DAY_WIDTH = 0.5;
export const MAX_DAY_WIDTH = 48;
/** «Вписать»: 3 days before the first task and 12 after the last one (room for its label). */
export const FIT_DAYS_BEFORE = 3;
export const FIT_DAYS_AFTER = 12;
/** «Сегодня» puts today at about 30 % of the visible width. */
export const TODAY_AT = 0.3;

export const GANTT_ZOOM_KEY = "skh.work.zoom";

function isZoom(value: string | null): value is GanttZoom {
  return value !== null && (GANTT_ZOOMS as readonly string[]).includes(value);
}

/**
 * The zoom of the URL (`?zoom=`), else the remembered one, else «Вписать» (the first visit of a project). The values
 * of the first planner (`day`, `week`, `month`) keep their meaning.
 */
export function resolveZoom(params: URLSearchParams): GanttZoom {
  const named = params.get("zoom");
  if (isZoom(named)) return named;
  const stored = readPreference(GANTT_ZOOM_KEY);
  if (isZoom(stored)) return stored;
  return "fit";
}

export function clampDayWidth(dayWidth: number): number {
  if (!Number.isFinite(dayWidth)) return DAY_WIDTH.week;
  return Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, dayWidth));
}

/** The fixed zoom a scale matches (a smooth zoom can land on one), or null. */
export function zoomForDayWidth(dayWidth: number): FixedZoom | null {
  return FIXED_ZOOMS.find((zoom) => Math.abs(DAY_WIDTH[zoom] - dayWidth) < 1e-6) ?? null;
}

/** Ctrl/⌘ + wheel or a pinch: a smooth step, exponential in the wheel delta, kept within the range. */
export function wheelDayWidth(dayWidth: number, deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return clampDayWidth(dayWidth * Math.exp(-pixels * 0.003));
}

export interface DaySpan {
  /** First day. */
  start: number;
  /** Day after the last one; equals `start` for a project made of one milestone. */
  end: number;
}

/** The days the scheduled tasks occupy (a milestone is a point), or null when nothing has dates. */
export function projectSpan(tasks: Pick<WorkTask, "start_date" | "end_exclusive" | "scheduled">[]): DaySpan | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    if (!task.scheduled || !task.start_date || !task.end_exclusive) continue;
    const s = toDay(task.start_date);
    const e = toDay(task.end_exclusive);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    start = Math.min(start, s);
    end = Math.max(end, e, s);
  }
  return Number.isFinite(start) ? { start, end } : null;
}

/** «Вписать»: the whole project with its margins in `width` pixels (an empty project: today with the margins). */
export function fitDayWidth(width: number, span: DaySpan | null): number {
  const days = span ? Math.max(0, span.end - span.start) : 0;
  return clampDayWidth(Math.max(width, 1) / (days + FIT_DAYS_BEFORE + FIT_DAYS_AFTER));
}

/** The first day «Вписать» shows. */
export function fitStartDay(span: DaySpan | null, today: number): number {
  return (span?.start ?? today) - FIT_DAYS_BEFORE;
}

// --- the drawn range ----------------------------------------------------------------------------------------------

export interface GanttRange {
  /** First day drawn (a Monday). */
  start: number;
  /** Day after the last one drawn. */
  end: number;
}

/**
 * The days the chart can scroll over: every scheduled task, due date and today, padded on each side by one visible
 * width (so «Сегодня», a zoom around the pointer or the centre always have room), aligned to Mondays.
 */
export function chartRange(
  tasks: Pick<WorkTask, "start_date" | "end_exclusive" | "due_date">[],
  today: string,
  dayWidth: number,
  visibleWidth: number,
): GanttRange {
  let min = toDay(today);
  let max = min + 1;
  const take = (iso: string | null | undefined, exclusive = false) => {
    if (!iso) return;
    const day = toDay(iso);
    if (Number.isNaN(day)) return;
    min = Math.min(min, day);
    max = Math.max(max, exclusive ? day : day + 1);
  };
  for (const task of tasks) {
    take(task.start_date);
    take(task.end_exclusive, true);
    take(task.due_date);
  }
  const pad = Math.max(14, Math.ceil(Math.max(visibleWidth, 320) / Math.max(dayWidth, MIN_DAY_WIDTH)));
  let start = min - pad;
  start -= isoWeekday(start) - 1; // back to Monday
  let end = max + pad;
  end += (8 - isoWeekday(end)) % 7; // forward to Monday
  return { start, end };
}

/** The scroll position that keeps `day` at `offset` pixels from the left edge of the visible window. */
export function scrollForDay(day: number, offset: number, range: GanttRange, dayWidth: number): number {
  return Math.max(0, (day - range.start) * dayWidth - offset);
}

// --- the scale -------------------------------------------------------------------------------------------------------

export type ScaleUnit = "day" | "week" | "month" | "quarter" | "year";

/** The bottom-row units in order with their minimal readable cell width (§3.3). */
const UNITS: readonly [ScaleUnit, number, number][] = [
  ["day", 1, 22],
  ["week", 7, 60],
  ["month", 30.4, 44],
  ["quarter", 91, 48],
  ["year", 365, 48],
];

/** Bottom row: the smallest unit whose cell is not narrower than its minimum; top row: the next unit. */
export function scaleUnits(dayWidth: number): { bottom: ScaleUnit; top: ScaleUnit } {
  const found = UNITS.find(([, days, min]) => days * dayWidth >= min);
  const bottom = found ? found[0] : "year";
  const top: ScaleUnit = bottom === "day" || bottom === "week" ? "month" : bottom === "month" ? "quarter" : "year";
  return { bottom, top };
}

const MONTH_FULL = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
/** A month as a scale cell (nominative): «нояб.», «май». */
const MONTH_CELL = ["янв.", "февр.", "март", "апр.", "май", "июнь", "июль", "авг.", "сент.", "окт.", "нояб.", "дек."];
const QUARTER = ["I", "II", "III", "IV"];

function ymd(day: number): [number, number, number] {
  const iso = fromDay(day);
  return [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))];
}

function dayOf(y: number, m: number, d = 1): number {
  return Math.round(Date.UTC(y, m, d) / 86_400_000);
}

export function unitStart(unit: ScaleUnit, day: number): number {
  const [y, m] = ymd(day);
  switch (unit) {
    case "day":
      return day;
    case "week":
      return day - (isoWeekday(day) - 1);
    case "month":
      return dayOf(y, m);
    case "quarter":
      return dayOf(y, Math.floor(m / 3) * 3);
    case "year":
      return dayOf(y, 0);
  }
}

export function unitNext(unit: ScaleUnit, day: number): number {
  const [y, m] = ymd(day);
  switch (unit) {
    case "day":
      return day + 1;
    case "week":
      return day + 7;
    case "month":
      return dayOf(y, m + 1);
    case "quarter":
      return dayOf(y, Math.floor(m / 3) * 3 + 3);
    case "year":
      return dayOf(y + 1, 0);
  }
}

/** Width of a text in pixels for one font role of the chart. */
export type TextMeasure = (text: string, role?: TextRole) => number;
export type TextRole = "label" | "label-strong" | "scale" | "scale-strong" | "marker" | "today";

/** Deterministic widths (tests, and a browser without a canvas): about 7 px per character. */
export const approximateMeasure: TextMeasure = (text) => Math.ceil(text.length * 7.1);

export interface ScaleCell {
  /** First day of the cell. */
  day: number;
  /** Left edge and width in content pixels, clipped to the visible window. */
  x: number;
  width: number;
  /** "" when it does not fit: a label that does not fit is not drawn — never overlapping. */
  label: string;
  /** The full name for a tooltip / screen reader. */
  title: string;
  /** A Saturday or a Sunday (day cells only). */
  weekend: boolean;
}

export interface ScaleRows {
  bottom: ScaleCell[];
  top: ScaleCell[];
  units: { bottom: ScaleUnit; top: ScaleUnit };
  /** The «сегодня» mark in the bottom row: centre x and width, or null when today is outside the window. */
  today: { x: number; width: number; label: string } | null;
}

/** A visible window of the chart in content pixels. */
export interface ChartWindow {
  x0: number;
  x1: number;
}

const TOP_PAD = 16;
const BOTTOM_PAD = 14;
const TODAY_GAP = 3;

function topLabel(unit: ScaleUnit, day: number, width: number, measure: TextMeasure): { label: string; title: string } {
  const [y, m] = ymd(day);
  const fits = (text: string) => width >= measure(text, "scale-strong") + TOP_PAD;
  if (unit === "month") {
    const full = `${MONTH_FULL[m]} ${y}`;
    if (fits(full)) return { label: full, title: full };
    const short = MONTH_CELL[m] ?? "";
    return { label: width >= 44 && fits(short) ? short : "", title: full };
  }
  if (unit === "quarter") {
    const full = `${QUARTER[Math.floor(m / 3)]} кв. ${y}`;
    if (fits(full)) return { label: full, title: full };
    const short = `${QUARTER[Math.floor(m / 3)]} кв.`;
    return { label: fits(short) ? short : "", title: full };
  }
  const year = String(y);
  return { label: fits(year) ? year : "", title: year };
}

function bottomLabel(unit: ScaleUnit, day: number, width: number, measure: TextMeasure): { label: string; title: string } {
  const [y, m, d] = ymd(day);
  const iso = fromDay(day);
  const fits = (text: string, pad = BOTTOM_PAD) => width >= measure(text, "scale") + pad;
  switch (unit) {
    case "day": {
      const label = String(d);
      return { label: fits(label, 4) ? label : "", title: formatDay(iso) };
    }
    case "week": {
      const long = formatDay(iso, iso);
      const title = `Неделя с ${formatDay(iso)}`;
      if (width >= 76 && fits(long)) return { label: long, title };
      return { label: fits(String(d)) ? String(d) : "", title };
    }
    case "month": {
      const full = MONTH_FULL[m] ?? "";
      const title = `${full} ${y}`;
      if (width >= 84 && fits(full)) return { label: full, title };
      const short = MONTH_CELL[m] ?? "";
      return { label: fits(short) ? short : "", title };
    }
    case "quarter": {
      const label = `${QUARTER[Math.floor(m / 3)]} кв.`;
      return { label: fits(label) ? label : "", title: `${label} ${y}` };
    }
    case "year": {
      const label = String(y);
      return { label: fits(label) ? label : "", title: label };
    }
  }
}

function cellsOf(unit: ScaleUnit, range: GanttRange, dayWidth: number, win: ChartWindow): { day: number; x: number; width: number }[] {
  const out: { day: number; x: number; width: number }[] = [];
  const firstDay = Math.max(range.start, range.start + Math.floor(win.x0 / dayWidth));
  const lastDay = Math.min(range.end, range.start + Math.ceil(win.x1 / dayWidth) + 1);
  for (let day = unitStart(unit, firstDay); day < lastDay; day = unitNext(unit, day)) {
    const left = (day - range.start) * dayWidth;
    const right = (unitNext(unit, day) - range.start) * dayWidth;
    const x0 = Math.max(left, win.x0);
    const x1 = Math.min(right, win.x1);
    if (x1 - x0 <= 0) continue;
    out.push({ day, x: x0, width: x1 - x0 });
  }
  return out;
}

/**
 * The two header rows for the visible window. Edge cells are clipped to the window, so a month that starts before
 * it is named at the window's left edge — in full when it fits, shortened («нояб.») when it does not, else not at
 * all. The bottom row hides every label the «сегодня» mark would cover.
 */
export function scaleRows(range: GanttRange, dayWidth: number, win: ChartWindow, today: number, measure: TextMeasure): ScaleRows {
  const units = scaleUnits(dayWidth);
  const top = cellsOf(units.top, range, dayWidth, win).map((cell) => ({ ...cell, ...topLabel(units.top, cell.day, cell.width, measure), weekend: false }));
  const todayCentre = (today - range.start + 0.5) * dayWidth;
  let todayMark: ScaleRows["today"] = null;
  if (todayCentre >= win.x0 && todayCentre <= win.x1) {
    const label = formatDay(fromDay(today), fromDay(today));
    todayMark = { x: todayCentre, width: Math.max(54, measure(label, "today") + 14), label };
  }
  const bottom = cellsOf(units.bottom, range, dayWidth, win).map((cell) => {
    const named = bottomLabel(units.bottom, cell.day, cell.width, measure);
    let label = named.label;
    if (label && todayMark) {
      const box =
        units.bottom === "day"
          ? [cell.x, cell.x + cell.width]
          : [cell.x, cell.x + measure(label, "scale") + BOTTOM_PAD];
      const half = todayMark.width / 2 + TODAY_GAP;
      if ((box[0] as number) < todayMark.x + half && (box[1] as number) > todayMark.x - half) label = "";
    }
    const weekday = isoWeekday(cell.day);
    return { ...cell, label, title: named.title, weekend: units.bottom === "day" && weekday >= 6 };
  });
  return { bottom, top, units, today: todayMark };
}

// --- bars, labels and markers ----------------------------------------------------------------------------------

export type BarKind = "task" | "milestone" | "summary";
export type LabelsMode = "auto" | "none";

/** A label inside the bar: 8 px on each side; «Готово» also has a tick (14 px). */
export const INSIDE_PADDING = 16;
export const DONE_TICK = 14;
/** A label to the right starts 8 px after the bar (or after the overdue hatching). */
export const LABEL_GAP = 8;
/** Kept free at the right edge of the window. */
export const EDGE_GAP = 6;
/** Less room than this to the right edge: no label (the name is in the left column and the tooltip). */
export const MIN_LABEL_ROOM = 56;
/** A marker of a task outside the window sits this far from the edge. */
export const MARKER_INSET = 4;

export interface LabelInput {
  kind: BarKind;
  /** Left edge and width of the bar (a milestone: the diamond's bounding box). */
  x: number;
  width: number;
  /** Right end of the overdue hatching, when there is one. */
  lateEnd: number | null;
  done: boolean;
  /** Width of the task's title in the label font. */
  textWidth: number;
  window: ChartWindow;
  labels: LabelsMode;
}

export type LabelDecision =
  /** Inside the bar; `x` is where the text starts (pinned to the window's left edge when the bar starts before it). */
  | { place: "inside"; x: number; width: number }
  /** To the right of the bar / hatching, never to its left (incoming arrows are there). */
  | { place: "right"; x: number; maxWidth: number }
  | { place: "none" }
  /** The task lies wholly before the window: «‹ 2 нояб. – 9 нояб.» at the left edge of its row. */
  | { place: "before"; x: number }
  /** The task lies wholly after the window: «27 нояб. ›» at the right edge (`x` is the marker's right end). */
  | { place: "after"; x: number };

/** §3.5: inside → right → nothing; markers for tasks outside the window. */
export function decideLabel(input: LabelInput): LabelDecision {
  const { kind, x, width, lateEnd, done, textWidth, window: win, labels } = input;
  const end = Math.max(x + width, lateEnd ?? Number.NEGATIVE_INFINITY);
  if (end <= win.x0) return { place: "before", x: win.x0 + MARKER_INSET };
  if (x >= win.x1) return { place: "after", x: win.x1 - MARKER_INSET };
  if (kind === "task") {
    const visibleStart = Math.max(x, win.x0);
    const visibleWidth = Math.min(x + width, win.x1) - visibleStart;
    const needed = textWidth + INSIDE_PADDING + (done ? DONE_TICK : 0);
    if (visibleWidth >= needed) return { place: "inside", x: visibleStart + INSIDE_PADDING / 2 + (done ? DONE_TICK : 0), width: visibleWidth };
  }
  if (labels === "none") return { place: "none" };
  const start = end + LABEL_GAP;
  const room = win.x1 - EDGE_GAP - start;
  if (room < MIN_LABEL_ROOM) return { place: "none" };
  return { place: "right", x: start, maxWidth: room };
}

/**
 * The text of a marker of a task outside the window: before it — its dates, the last day inclusive
 * («‹ 2 нояб. – 9 нояб.»); after it — when it starts («27 нояб. ›»).
 */
export function markerText(place: "before" | "after", startDay: number, endExclusive: number, milestone: boolean): string {
  const short = (day: number) => formatDay(fromDay(day), fromDay(day));
  if (place === "after") return `${short(startDay)} ›`;
  const lastDay = milestone || endExclusive <= startDay ? startDay : endExclusive - 1;
  return lastDay === startDay ? `‹ ${short(startDay)}` : `‹ ${short(startDay)} – ${short(lastDay)}`;
}

/** The narrowest bar (a task is visible at any zoom), a summary's narrowest bracket, half a milestone's diamond. */
export const MIN_BAR_WIDTH = 6;
export const MIN_SUMMARY_WIDTH = 8;
export const MILESTONE_HALF = 8;

export interface BarBox {
  kind: BarKind;
  /** Left edge and width in content pixels (a milestone: the diamond's bounding box around its day boundary). */
  x: number;
  width: number;
  /** Day numbers of `[start, end)`; a milestone's end equals its start. */
  start: number;
  end: number;
}

/**
 * Where a task sits on the scale: `[start_date, end_exclusive)` — a bar that ends at the boundary after the last
 * occupied day (no «+1 day»), at least 6 px wide; a milestone (or an empty interval) is a diamond on its day
 * boundary; a summary is a bracket over `summary`. Null without dates (the task waits in «Без дат»).
 */
export function barBox(
  task: Pick<WorkTask, "start_date" | "end_exclusive" | "is_milestone">,
  range: GanttRange,
  dayWidth: number,
  summary?: DaySpan | null,
): BarBox | null {
  if (summary) {
    return {
      kind: "summary",
      x: (summary.start - range.start) * dayWidth,
      width: Math.max(MIN_SUMMARY_WIDTH, (summary.end - summary.start) * dayWidth),
      start: summary.start,
      end: summary.end,
    };
  }
  if (!task.start_date || !task.end_exclusive) return null;
  const start = toDay(task.start_date);
  const end = toDay(task.end_exclusive);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (task.is_milestone || end <= start) {
    const cx = (start - range.start) * dayWidth;
    return { kind: "milestone", x: cx - MILESTONE_HALF, width: 2 * MILESTONE_HALF, start, end: start };
  }
  return { kind: "task", x: (start - range.start) * dayWidth, width: Math.max(MIN_BAR_WIDTH, (end - start) * dayWidth), start, end };
}

/**
 * The right end of the overdue hatching (§3.4): an unfinished task that is late or overdue is hatched from its end
 * to the start of today; null when it is not late or its end is not before today (summaries are never hatched).
 */
export function lateEnd(
  task: Pick<WorkTask, "late" | "overdue" | "status">,
  box: BarBox,
  today: number,
  range: GanttRange,
  dayWidth: number,
): number | null {
  if (box.kind === "summary" || task.status === "done" || !(task.late || task.overdue)) return null;
  const todayX = (today - range.start) * dayWidth;
  return todayX > box.x + box.width ? todayX : null;
}

/**
 * Summary tasks (§3.4): a task with scheduled subtasks is drawn as a bracket over the union of its own dates and the
 * dates of all its descendants (until the server rolls parents' dates up, its own dates count too, so nothing
 * disappears). Only tasks with at least one scheduled descendant are summaries.
 */
export function summarySpans(tasks: Pick<WorkTask, "id" | "parent_task_id" | "start_date" | "end_exclusive" | "scheduled">[]): Map<string, DaySpan> {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const own = (t: (typeof tasks)[number]): DaySpan | null => {
    if (!t.scheduled || !t.start_date || !t.end_exclusive) return null;
    const s = toDay(t.start_date);
    const e = toDay(t.end_exclusive);
    return Number.isNaN(s) || Number.isNaN(e) ? null : { start: s, end: Math.max(e, s) };
  };
  const merge = (a: DaySpan | null | undefined, b: DaySpan | null | undefined): DaySpan | null =>
    a && b ? { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) } : (a ?? b ?? null);
  // Descendants' spans per task (without the task itself): each scheduled task widens all its ancestors.
  const below = new Map<string, DaySpan>();
  for (const task of tasks) {
    const span = own(task);
    if (!span) continue;
    let parent = task.parent_task_id;
    const guard = new Set<string>();
    while (parent && byId.has(parent) && !guard.has(parent)) {
      guard.add(parent);
      below.set(parent, merge(below.get(parent), span) as DaySpan);
      parent = byId.get(parent)?.parent_task_id ?? null;
    }
  }
  const result = new Map<string, DaySpan>();
  for (const [id, span] of below) {
    const task = byId.get(id);
    result.set(id, merge(span, task ? own(task) : null) as DaySpan);
  }
  return result;
}

// --- arrows ----------------------------------------------------------------------------------------------------------

/** The first and last horizontal steps of an arrow: right after the predecessor, and before the successor. */
export const ARROW_STUB = 6;
export const ARROW_ENTRY = 8;

/**
 * A Finish-to-Start arrow from (x1, y1) — the predecessor's right end — to (x2, y2) — the successor's left end
 * (a milestone's left vertex). It never runs along a label (§3.6):
 * - usual case (`x2 - 8 ≥ x1 + 6`): `M x1 y1 H x1+6 V y2 H x2` — the vertical stands right after the predecessor's
 *   end, before its label (which starts at x1 + 8); the horizontal runs on the successor's row, left of its bar;
 * - the successor starts earlier: `M x1 y1 H x1+6 V yb H x2-8 V y2 H x2`, where `yb` is the grid line between the
 *   rows — above the successor's row, or below it when the successor is the upper one.
 */
export function routeDependency(x1: number, y1: number, x2: number, y2: number, rowHeight: number): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  if (x2 - ARROW_ENTRY >= x1 + ARROW_STUB) {
    return `M${r(x1)} ${r(y1)}H${r(x1 + ARROW_STUB)}V${r(y2)}H${r(x2)}`;
  }
  const yb = y2 > y1 ? y2 - rowHeight / 2 : y2 + rowHeight / 2;
  return `M${r(x1)} ${r(y1)}H${r(x1 + ARROW_STUB)}V${r(yb)}H${r(x2 - ARROW_ENTRY)}V${r(y2)}H${r(x2)}`;
}

export interface ArrowEnd {
  box: BarBox;
  label: LabelDecision;
  /** The width of the task's marker when it lies outside the window. */
  marker: { width: number } | null;
}

/**
 * The ends of an arrow (§3.6): the predecessor's right end and the successor's left end (a milestone's vertices).
 * A task wholly outside the window is reached at its marker — after the «‹ …» marker on the left, before the
 * «… ›» marker on the right — so the arrow starts or ends at the edge of the window and never runs over a marker.
 * Null when both tasks lie on the same side outside the window.
 */
export function arrowEnds(pred: ArrowEnd, succ: ArrowEnd, win: ChartWindow): { x1: number; x2: number } | null {
  const before = (end: ArrowEnd) => end.label.place === "before";
  const after = (end: ArrowEnd) => end.label.place === "after";
  if ((before(pred) && before(succ)) || (after(pred) && after(succ))) return null;
  const x1 = before(pred) ? win.x0 + MARKER_INSET + (pred.marker?.width ?? 0) + 2 : pred.box.x + pred.box.width;
  const x2 = after(succ) ? win.x1 - MARKER_INSET - (succ.marker?.width ?? 0) - 2 : succ.box.x;
  return { x1, x2 };
}

/** A filled 6 × 7 px triangle pointing right at (x, y). */
export function arrowHead(x: number, y: number): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${r(x)} ${r(y)}l-6 -3.5v7z`;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The straight segments of an absolute `M … H … V …` path (the routes above). */
export function pathSegments(d: string): Segment[] {
  const segments: Segment[] = [];
  let x = 0;
  let y = 0;
  for (const match of d.matchAll(/([MHV])\s*(-?[\d.]+)(?:\s+(-?[\d.]+))?/g)) {
    const [, op, a, b] = match;
    const first = Number(a);
    if (op === "M") {
      x = first;
      y = Number(b);
    } else if (op === "H") {
      segments.push({ x1: x, y1: y, x2: first, y2: y });
      x = first;
    } else {
      segments.push({ x1: x, y1: y, x2: x, y2: first });
      y = first;
    }
  }
  return segments;
}

export type LinksMode = "auto" | "all" | "selected" | "none";
export const LINKS_MODES: readonly LinksMode[] = ["auto", "all", "selected", "none"];
export const LINKS_MODE_LABEL: Record<LinksMode, string> = {
  auto: "Авто",
  all: "Все",
  selected: "Только у выбранной",
  none: "Скрыть",
};

/** Which arrows are drawn: «Авто» — all from 8 px per day, only the selected task's from 1.5 px, none below. */
export function effectiveLinks(mode: LinksMode, dayWidth: number): Exclude<LinksMode, "auto"> {
  if (mode !== "auto") return mode;
  if (dayWidth >= 8) return "all";
  if (dayWidth >= 1.5) return "selected";
  return "none";
}

/** The note at the right end of the legend row. */
export function linksNote(mode: Exclude<LinksMode, "auto">, hasSelection: boolean): string {
  if (mode === "none") return "Связи скрыты";
  if (mode === "selected") return hasSelection ? "Связи — только у выбранной задачи" : "Связи — только у выбранной: выберите задачу";
  return hasSelection ? "Связи выбранной выделены" : "Выберите задачу — её связи выделятся";
}

// --- the view settings («Вид») --------------------------------------------------------------------------------------

/** The left column's width can be dragged within these bounds (§3.1). */
export const NAMES_MIN = 240;
export const NAMES_MAX = 480;

export interface GanttViewSettings {
  links: LinksMode;
  labels: LabelsMode;
  /** A dragged width of the left column, or null for the default of the layout. */
  namesWidth: number | null;
  namesCollapsed: boolean;
  /** Highlight the critical path — only offered when the server computes one (§7.2). */
  criticalPath: boolean;
}

export const GANTT_VIEW_KEY = "skh.work.gantt.view";
export const DEFAULT_GANTT_VIEW: GanttViewSettings = { links: "auto", labels: "auto", namesWidth: null, namesCollapsed: false, criticalPath: false };

/** The remembered «Вид» of the Gantt in this browser; anything unknown falls back to the defaults. */
export function readGanttView(): GanttViewSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(readPreference(GANTT_VIEW_KEY) ?? "null");
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GANTT_VIEW };
  const value = raw as Record<string, unknown>;
  const links = LINKS_MODES.includes(value.links as LinksMode) ? (value.links as LinksMode) : "auto";
  const labels = value.labels === "none" ? "none" : "auto";
  const width = typeof value.namesWidth === "number" && Number.isFinite(value.namesWidth) ? Math.min(NAMES_MAX, Math.max(NAMES_MIN, Math.round(value.namesWidth))) : null;
  return { links, labels, namesWidth: width, namesCollapsed: value.namesCollapsed === true, criticalPath: value.criticalPath === true };
}

export function writeGanttView(settings: GanttViewSettings): void {
  writePreference(GANTT_VIEW_KEY, JSON.stringify(settings));
}

// --- text measurement -------------------------------------------------------------------------------------------

const FONT_STACK = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const TEXT_FONTS: Record<TextRole, string> = {
  label: `500 12.5px ${FONT_STACK}`,
  "label-strong": `600 12.5px ${FONT_STACK}`,
  scale: `400 12px ${FONT_STACK}`,
  "scale-strong": `600 12.5px ${FONT_STACK}`,
  marker: `400 12px ${FONT_STACK}`,
  today: `600 11.5px ${FONT_STACK}`,
};

interface Measurer2d {
  font: string;
  measureText: (text: string) => { width: number };
}

/**
 * A text measure on an offscreen canvas with a cache per font and string (no DOM layout is read). Without a canvas
 * (jsdom) the approximate measure is used. `reset()` drops the cache — after the web font has loaded.
 */
export function createTextMeasure(): TextMeasure & { reset: () => void } {
  let context: Measurer2d | null = null;
  try {
    if (typeof OffscreenCanvas !== "undefined") context = new OffscreenCanvas(1, 1).getContext("2d") as Measurer2d | null;
  } catch {
    context = null;
  }
  const caches = new Map<TextRole, Map<string, number>>();
  const measure = ((text: string, role: TextRole = "label") => {
    if (!context) return approximateMeasure(text, role);
    let cache = caches.get(role);
    if (!cache) {
      cache = new Map();
      caches.set(role, cache);
    }
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    context.font = TEXT_FONTS[role];
    const width = Math.ceil(context.measureText(text).width);
    if (cache.size > 5000) cache.clear();
    cache.set(text, width);
    return width;
  }) as TextMeasure & { reset: () => void };
  measure.reset = () => caches.clear();
  return measure;
}
