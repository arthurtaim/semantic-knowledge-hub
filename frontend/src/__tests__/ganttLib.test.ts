import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chartRange,
  createTextMeasure,
  DAY_WIDTH,
  decideLabel,
  effectiveLinks,
  fitDayWidth,
  fitStartDay,
  GANTT_ZOOM_KEY,
  linksNote,
  markerText,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
  pathSegments,
  projectSpan,
  resolveZoom,
  routeDependency,
  scaleRows,
  scaleUnits,
  scrollForDay,
  summarySpans,
  wheelDayWidth,
  zoomForDayWidth,
  type LabelInput,
  type TextMeasure,
} from "../lib/gantt";
import { writePreference } from "../lib/storage";
import { isoWeekday, toDay } from "../lib/work";
import { planTasks, task, TODAY } from "./workFixtures";

/*
 * Planner v2, the Gantt's geometry without UI (docs/ui-v2/planner/specs/PLANNER_V2.md §8 «Юнит»): zoom levels and
 * «Вписать», the adaptive scale and its edge cells, the «сегодня» mark, label placement, markers outside the window,
 * arrow routing and the «Авто» links mode.
 */

/** 7 px per character: deterministic widths instead of a canvas. */
const measure7: TextMeasure = (text) => text.length * 7;
const RANGE = { start: toDay("2026-10-26"), end: toDay("2027-01-04") }; // Mon 26 Oct 2026
const today = toDay(TODAY); // Wed 25 Nov 2026

/** This jsdom has no localStorage: a memory one per test. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("zoom", () => {
  it("chooses the scale units for 36, 16, 5, 1.8 and 0.62 px per day", () => {
    expect(scaleUnits(DAY_WIDTH.day)).toEqual({ bottom: "day", top: "month" });
    expect(scaleUnits(DAY_WIDTH.week)).toEqual({ bottom: "week", top: "month" });
    expect(scaleUnits(DAY_WIDTH.month)).toEqual({ bottom: "month", top: "quarter" });
    expect(scaleUnits(DAY_WIDTH.quarter)).toEqual({ bottom: "month", top: "quarter" });
    expect(scaleUnits(DAY_WIDTH.year)).toEqual({ bottom: "quarter", top: "year" });
    expect(scaleUnits(0.1)).toEqual({ bottom: "year", top: "year" });
  });

  it("resolveZoom: new values and the first planner's values from the URL and the stored setting; «Вписать» first", () => {
    expect(resolveZoom(new URLSearchParams())).toBe("fit");
    for (const zoom of ["day", "week", "month", "quarter", "year", "fit"]) expect(resolveZoom(new URLSearchParams(`zoom=${zoom}`))).toBe(zoom);
    writePreference(GANTT_ZOOM_KEY, "month"); // remembered by the first planner
    expect(resolveZoom(new URLSearchParams())).toBe("month");
    expect(resolveZoom(new URLSearchParams("zoom=bogus"))).toBe("month");
    writePreference(GANTT_ZOOM_KEY, "quarter");
    expect(resolveZoom(new URLSearchParams("zoom=day"))).toBe("day"); // the URL wins
    writePreference(GANTT_ZOOM_KEY, "hours");
    expect(resolveZoom(new URLSearchParams())).toBe("fit");
  });

  it("«Вписать»: the whole project plus 3 + 12 days; an empty project and a single milestone stay within the range", () => {
    const span = projectSpan(planTasks());
    expect(span).toEqual({ start: toDay("2026-11-02"), end: toDay("2026-12-09") });
    expect(fitDayWidth(900, span)).toBeCloseTo(900 / (37 + 15), 6);
    expect(fitStartDay(span, today)).toBe(toDay("2026-10-30"));
    // empty project: today with the margins, never an infinite or zero scale
    expect(projectSpan([task({ key: "ARIS-1" })])).toBeNull();
    expect(fitDayWidth(900, null)).toBe(MAX_DAY_WIDTH);
    expect(fitStartDay(null, today)).toBe(today - 3);
    // one milestone: a point, the same clamped scale
    const milestone = projectSpan([task({ key: "ARIS-2", is_milestone: true, start_date: "2026-12-02", end_exclusive: "2026-12-02", duration_workdays: 0 })]);
    expect(milestone).toEqual({ start: toDay("2026-12-02"), end: toDay("2026-12-02") });
    expect(fitDayWidth(900, milestone)).toBe(MAX_DAY_WIDTH);
    // a very long project never goes below the minimum
    expect(fitDayWidth(300, { start: 0, end: 5000 })).toBe(MIN_DAY_WIDTH);
  });

  it("Ctrl/⌘ + wheel zooms smoothly within 0.5–48 px per day; a fixed level is recognised", () => {
    expect(wheelDayWidth(16, -100)).toBeGreaterThan(16);
    expect(wheelDayWidth(16, 100)).toBeLessThan(16);
    expect(wheelDayWidth(48, -5000)).toBe(MAX_DAY_WIDTH);
    expect(wheelDayWidth(0.5, 5000)).toBe(MIN_DAY_WIDTH);
    expect(wheelDayWidth(16, -1, 1)).toBeCloseTo(wheelDayWidth(16, -16), 6); // lines → pixels
    expect(zoomForDayWidth(16)).toBe("week");
    expect(zoomForDayWidth(1.8)).toBe("quarter");
    expect(zoomForDayWidth(17)).toBeNull();
  });

  it("the drawn range starts on a Monday, covers every task and today and leaves a visible width on each side", () => {
    const range = chartRange(planTasks(), TODAY, DAY_WIDTH.day, 900);
    expect(isoWeekday(range.start)).toBe(1);
    expect(range.start).toBeLessThanOrEqual(toDay("2026-11-02") - 25);
    expect(range.end).toBeGreaterThanOrEqual(toDay("2026-12-09") + 25);
    const year = chartRange(planTasks(), TODAY, DAY_WIDTH.year, 900);
    expect((toDay("2026-11-02") - year.start) * DAY_WIDTH.year).toBeGreaterThanOrEqual(900);
    expect(scrollForDay(range.start + 10, 100, range, 36)).toBe(260);
    expect(scrollForDay(range.start, 100, range, 36)).toBe(0); // never negative
  });
});

describe("the scale", () => {
  it("day zoom: day numbers, weekends marked; the top row names the month", () => {
    const rows = scaleRows(RANGE, 36, { x0: 0, x1: 900 }, today, measure7);
    expect(rows.bottom[0]).toMatchObject({ x: 0, width: 36, label: "26", weekend: false });
    expect(rows.bottom.find((c) => c.day === toDay("2026-10-31"))?.weekend).toBe(true);
    expect(rows.top.map((c) => c.label)).toEqual(["Октябрь 2026", "Ноябрь 2026"]);
  });

  it("edge cells: a month cut by the window's left edge is named in full, shortened, or not at all", () => {
    // 2 days of October visible (72 px): «Октябрь 2026» needs 84 + 16 → «окт.»
    const two = scaleRows(RANGE, 36, { x0: 4 * 36, x1: 1000 }, today, measure7);
    expect(two.top[0]).toMatchObject({ x: 144, width: 72, label: "окт.", title: "Октябрь 2026" });
    // 1 day (36 px < 44): nothing, so nothing overlaps
    const one = scaleRows(RANGE, 36, { x0: 5 * 36, x1: 1000 }, today, measure7);
    expect(one.top[0]).toMatchObject({ width: 36, label: "" });
    // weeks: «26 окт.» from 76 px, the day number when narrower
    const weeks = scaleRows(RANGE, 16, { x0: 0, x1: 900 }, today, measure7);
    expect(weeks.bottom[0]).toMatchObject({ width: 112, label: "26 окт." });
    const cut = scaleRows(RANGE, 16, { x0: 112 - 70, x1: 900 }, today, measure7);
    expect(cut.bottom[0]).toMatchObject({ width: 70, label: "26" });
  });

  it("month, quarter and year zooms: months in full or short, quarters, years", () => {
    const month = scaleRows(RANGE, 5, { x0: 0, x1: 900 }, today, measure7);
    expect(month.bottom.find((c) => c.day === toDay("2027-01-01"))?.label).toBe("Январь");
    expect(month.top[0]?.label).toBe("IV кв. 2026");
    const quarter = scaleRows(RANGE, 1.8, { x0: 0, x1: 900 }, today, measure7);
    expect(quarter.bottom.find((c) => c.day === toDay("2027-01-01"))?.label).toBe("янв.");
    // December lies under the «сегодня» mark at this scale: its label gives way
    expect(quarter.bottom.find((c) => c.day === toDay("2026-12-01"))?.label).toBe("");
    const wide = { start: toDay("2025-12-29"), end: toDay("2030-01-07") };
    const year = scaleRows(wide, 0.62, { x0: 0, x1: 900 }, today, (text) => text.length * 6);
    // IV кв. 2026 and I кв. 2027 lie under the «сегодня» mark (25 нояб.) and give way; 2028 is complete
    expect(year.bottom.slice(1, 9).map((c) => c.label)).toEqual(["I кв.", "II кв.", "III кв.", "", "", "II кв.", "III кв.", "IV кв."]);
    expect(year.bottom.slice(9, 13).map((c) => c.label)).toEqual(["I кв.", "II кв.", "III кв.", "IV кв."]);
    expect(year.top.map((c) => c.label).slice(1, 3)).toEqual(["2026", "2027"]);
  });

  it("the «сегодня» mark sits mid-day in the bottom row and hides the labels it covers", () => {
    const rows = scaleRows(RANGE, 36, { x0: 900, x1: 1800 }, today, measure7);
    expect(rows.today).toMatchObject({ x: 30.5 * 36, label: "25 нояб." });
    const label = (iso: string) => rows.bottom.find((c) => c.day === toDay(iso))?.label;
    expect([label("2026-11-23"), label("2026-11-24"), label("2026-11-25"), label("2026-11-26"), label("2026-11-27")]).toEqual(["23", "", "", "", "27"]);
    // today outside the window: no mark, nothing hidden
    const before = scaleRows(RANGE, 36, { x0: 0, x1: 900 }, today, measure7);
    expect(before.today).toBeNull();
  });
});

describe("labels on bars (§3.5)", () => {
  const base: LabelInput = { kind: "task", x: 100, width: 200, lateEnd: null, done: false, textWidth: 100, window: { x0: 0, x1: 900 }, labels: "auto" };

  it("inside when the visible part is wider than the text + 16 px (+14 px for the tick of «Готово»)", () => {
    expect(decideLabel(base)).toEqual({ place: "inside", x: 108, width: 200 });
    expect(decideLabel({ ...base, width: 125 })).toEqual({ place: "inside", x: 108, width: 125 });
    expect(decideLabel({ ...base, width: 125, done: true })).toEqual({ place: "right", x: 233, maxWidth: 900 - 6 - 233 });
  });

  it("otherwise 8 px to the right of the bar or of the overdue hatching, never to the left; no room → none", () => {
    expect(decideLabel({ ...base, width: 50 })).toEqual({ place: "right", x: 158, maxWidth: 736 });
    expect(decideLabel({ ...base, width: 50, lateEnd: 300 })).toEqual({ place: "right", x: 308, maxWidth: 586 });
    expect(decideLabel({ ...base, x: 800, width: 50 })).toEqual({ place: "none" }); // 36 px < 56 to the edge
    expect(decideLabel({ ...base, x: 780, width: 50 })).toEqual({ place: "right", x: 838, maxWidth: 56 });
  });

  it("«Без подписей» drops labels to the right; labels inside stay", () => {
    expect(decideLabel({ ...base, width: 50, labels: "none" })).toEqual({ place: "none" });
    expect(decideLabel({ ...base, labels: "none" })).toMatchObject({ place: "inside" });
  });

  it("a bar that starts before the window keeps its label pinned to the window's left edge", () => {
    expect(decideLabel({ ...base, x: -50, width: 300 })).toEqual({ place: "inside", x: 8, width: 250 });
    expect(decideLabel({ ...base, x: -50, width: 300, done: true, window: { x0: 0, x1: 900 } })).toEqual({ place: "inside", x: 22, width: 250 });
  });

  it("milestones and summaries are labelled to the right, never inside", () => {
    expect(decideLabel({ ...base, kind: "milestone", x: 93, width: 14, textWidth: 1 })).toEqual({ place: "right", x: 115, maxWidth: 779 });
    expect(decideLabel({ ...base, kind: "summary" })).toEqual({ place: "right", x: 308, maxWidth: 586 });
  });

  it("tasks wholly outside the window get a marker at the edge; the hatching counts as part of the task", () => {
    expect(decideLabel({ ...base, x: -300, width: 100 })).toEqual({ place: "before", x: 4 });
    expect(decideLabel({ ...base, x: -300, width: 100, lateEnd: 50 })).toEqual({ place: "right", x: 58, maxWidth: 836 });
    expect(decideLabel({ ...base, x: 950, width: 100 })).toEqual({ place: "after", x: 896 });
    expect(decideLabel({ ...base, x: 950, width: 100, labels: "none" })).toEqual({ place: "after", x: 896 });
    expect(markerText("before", toDay("2026-11-02"), toDay("2026-11-10"), false)).toBe("‹ 2 нояб. – 9 нояб.");
    expect(markerText("before", toDay("2026-11-27"), toDay("2026-11-27"), true)).toBe("‹ 27 нояб.");
    expect(markerText("after", toDay("2026-11-27"), toDay("2026-12-05"), false)).toBe("27 нояб. ›");
  });
});

describe("summary tasks (§3.4)", () => {
  it("cover their own dates and all their descendants' dates; a task without scheduled subtasks is not a summary", () => {
    const spans = summarySpans(planTasks());
    expect(spans.get("t1")).toEqual({ start: toDay("2026-11-02"), end: toDay("2026-11-10") });
    expect(spans.get("t2")).toEqual({ start: toDay("2026-11-02"), end: toDay("2026-11-05") });
    expect(spans.has("t3")).toBe(false);
    expect(spans.has("t4")).toBe(false);
    const wider = summarySpans([
      task({ key: "ARIS-1", start_date: "2026-11-02", end_exclusive: "2026-11-03" }),
      task({ key: "ARIS-2", parent_task_id: "t1", start_date: "2026-11-05", end_exclusive: "2026-11-10" }),
      task({ key: "ARIS-3" }),
      task({ key: "ARIS-4", parent_task_id: "t3", depth: 2, start_date: "2026-12-01", end_exclusive: "2026-12-03" }),
      task({ key: "ARIS-5", parent_task_id: "t4", depth: 3, is_milestone: true, start_date: "2026-12-10", end_exclusive: "2026-12-10" }),
    ]);
    expect(wider.get("t1")).toEqual({ start: toDay("2026-11-02"), end: toDay("2026-11-10") });
    // an undated parent takes its subtree's span, a milestone counts as its day
    expect(wider.get("t3")).toEqual({ start: toDay("2026-12-01"), end: toDay("2026-12-10") });
  });
});

describe("arrows (§3.6)", () => {
  it("usual case: the vertical right after the predecessor, the horizontal on the successor's row", () => {
    expect(routeDependency(100, 18, 200, 54, 36)).toBe("M100 18H106V54H200");
    expect(routeDependency(100, 18, 114, 54, 36)).toBe("M100 18H106V54H114"); // x2 - 8 = x1 + 6 still fits
  });

  it("a successor that starts earlier: along the grid line above its row", () => {
    expect(routeDependency(200, 18, 100, 54, 36)).toBe("M200 18H206V36H92V54H100");
    expect(routeDependency(100, 18, 113, 54, 36)).toBe("M100 18H106V36H105V54H113");
  });

  it("a successor above the predecessor: along the grid line below the successor's row", () => {
    expect(routeDependency(200, 90, 100, 18, 36)).toBe("M200 90H206V36H92V18H100");
    expect(routeDependency(100, 90, 200, 18, 36)).toBe("M100 90H106V18H200");
  });

  it("splits a route into segments (for the overlap checks)", () => {
    expect(pathSegments("M200 18H206V36H92V54H100")).toEqual([
      { x1: 200, y1: 18, x2: 206, y2: 18 },
      { x1: 206, y1: 18, x2: 206, y2: 36 },
      { x1: 206, y1: 36, x2: 92, y2: 36 },
      { x1: 92, y1: 36, x2: 92, y2: 54 },
      { x1: 92, y1: 54, x2: 100, y2: 54 },
    ]);
  });

  it("«Авто»: every link from 8 px per day, only the selected task's from 1.5 px, none below", () => {
    expect(effectiveLinks("auto", DAY_WIDTH.day)).toBe("all");
    expect(effectiveLinks("auto", DAY_WIDTH.week)).toBe("all");
    expect(effectiveLinks("auto", 8)).toBe("all");
    expect(effectiveLinks("auto", DAY_WIDTH.month)).toBe("selected");
    expect(effectiveLinks("auto", DAY_WIDTH.quarter)).toBe("selected");
    expect(effectiveLinks("auto", 1.5)).toBe("selected");
    expect(effectiveLinks("auto", DAY_WIDTH.year)).toBe("none");
    expect(effectiveLinks("all", DAY_WIDTH.year)).toBe("all");
    expect(effectiveLinks("none", DAY_WIDTH.day)).toBe("none");
    expect(linksNote("all", true)).toBe("Связи выбранной выделены");
    expect(linksNote("selected", true)).toBe("Связи — только у выбранной задачи");
    expect(linksNote("none", false)).toBe("Связи скрыты");
  });
});

describe("text measurement", () => {
  it("falls back to fixed widths without a canvas (jsdom) and is stable for the same string", () => {
    const measure = createTextMeasure();
    expect(measure("abc")).toBe(22);
    expect(measure("abc", "scale")).toBe(measure("abc", "scale"));
    measure.reset();
    expect(measure("abc")).toBe(22);
  });
});
