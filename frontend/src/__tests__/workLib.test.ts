import { describe, expect, it } from "vitest";
import { plannedChange } from "../components/work/GanttChart";
import {
  addWorkdays,
  barGeometry,
  buildTree,
  canWriteProject,
  countWorkdays,
  DAY_WIDTH,
  dependencyPath,
  EMPTY_FILTERS,
  filterParams,
  filtersFromParams,
  formatPlan,
  fromDay,
  ganttRange,
  isoWeekday,
  lastWorkday,
  nextWorkday,
  pluralWorkdays,
  scaleCells,
  toDay,
  visibleRows,
} from "../lib/work";
import { capabilities, planTasks, project, READ_ONLY, task, TODAY } from "./workFixtures";

/* M6 UI helpers: the calendar mirror, the time scale, the filter model, the tree (docs/WORK_MANAGEMENT.md «UI»). */

describe("calendar mirror (Mon–Fri, [start, end_exclusive))", () => {
  it("M6-09: Fri 2026-11-27 for one working day ends before Sat; the FS successor starts Mon 2026-11-30", () => {
    const friday = toDay("2026-11-27");
    expect(isoWeekday(friday)).toBe(5);
    const end = addWorkdays(friday, 1);
    expect(fromDay(end)).toBe("2026-11-28");
    expect(fromDay(nextWorkday(end))).toBe("2026-11-30");
    // Mon 2026-11-30 + 2 working days → end exclusive Wed 2026-12-02
    expect(fromDay(addWorkdays(toDay("2026-11-30"), 2))).toBe("2026-12-02");
  });

  it("counts working days and finds the last occupied one", () => {
    expect(countWorkdays(toDay("2026-11-27"), toDay("2026-12-02"))).toBe(3); // Fri, Mon, Tue
    expect(lastWorkday(toDay("2026-11-27"), toDay("2026-11-30"))).toBe(toDay("2026-11-27")); // [Fri, Mon) → Fri
    expect(lastWorkday(toDay("2026-11-28"), toDay("2026-11-30"))).toBeNull(); // a weekend only
    expect(fromDay(addWorkdays(toDay("2026-11-28"), 1))).toBe("2026-12-01"); // a Saturday start → Monday
  });

  it("M6-26: a bar ends at the boundary after last_day — no «+1 day», no lost day", () => {
    const range = { start: toDay("2026-11-23"), end: toDay("2026-12-21") };
    const dw = DAY_WIDTH.day;
    const friday = barGeometry({ start_date: "2026-11-27", end_exclusive: "2026-11-28", is_milestone: false }, range, dw);
    expect(friday).toEqual({ x: 4 * dw, width: dw, milestone: false }); // exactly Friday's column
    const milestone = barGeometry({ start_date: "2026-12-02", end_exclusive: "2026-12-02", is_milestone: true }, range, dw);
    expect(milestone).toEqual({ x: 9 * dw, width: 0, milestone: true }); // M6-10: a point on the day boundary
    expect(barGeometry({ start_date: null, end_exclusive: null, is_milestone: false }, range, dw)).toBeNull(); // M6-27
  });

  it("formats the plan with the last day (inclusive), never the exclusive end", () => {
    const t = task({ key: "ARIS-1", start_date: "2026-11-27", end_exclusive: "2026-12-02", last_day: "2026-12-01", duration_workdays: 3 });
    expect(formatPlan(t, TODAY)).toBe("27 нояб. – 1 дек.");
    expect(formatPlan(task({ key: "ARIS-2" }), TODAY)).toBe("Без дат");
    expect(pluralWorkdays(1)).toBe("1 раб. день");
    expect(pluralWorkdays(3)).toBe("3 раб. дня");
    expect(pluralWorkdays(12)).toBe("12 раб. дней");
  });
});

describe("Gantt drag arithmetic", () => {
  const friday = task({ key: "ARIS-4", start_date: "2026-11-27", end_exclusive: "2026-11-28", last_day: "2026-11-27", duration_workdays: 1 });

  it("a move keeps the working-day duration and lands on a working day, like the server", () => {
    const moved = plannedChange(friday, "move", 1); // onto Saturday → Monday
    expect(moved?.start).toBe("2026-11-30");
    expect(moved?.endExclusive).toBe("2026-12-01");
    expect(moved?.change).toEqual({ task_id: "t4", start_date: "2026-11-28", duration_workdays: 1 });
  });

  it("a resize changes the exclusive end and keeps at least one working day", () => {
    const longer = plannedChange(friday, "resize", 4); // edge from Sat to Wed → last day Tue
    expect(longer?.change).toEqual({ task_id: "t4", start_date: "2026-11-27", end_exclusive: "2026-12-02" });
    const shorter = plannedChange(friday, "resize", -3);
    expect(shorter?.endExclusive).toBe("2026-11-28");
  });

  it("a milestone moves as a point (duration 0) and never gets a duration", () => {
    const milestone = task({ key: "ARIS-6", is_milestone: true, start_date: "2026-12-02", end_exclusive: "2026-12-02", duration_workdays: 0 });
    expect(plannedChange(milestone, "move", 2)?.change).toEqual({ task_id: "t6", start_date: "2026-12-04", duration_workdays: 0 });
    expect(plannedChange(milestone, "resize", 2)?.change.duration_workdays).toBe(0);
  });

  it("the time scale starts on a Monday, covers every task and today, and labels months and days", () => {
    const range = ganttRange(planTasks(), TODAY, "2026-11-02", "2026-12-09");
    expect(isoWeekday(range.start)).toBe(1);
    expect(range.start).toBeLessThanOrEqual(toDay("2026-11-02"));
    expect(range.end).toBeGreaterThanOrEqual(toDay("2026-12-09"));
    const cells = scaleCells(range, "day", DAY_WIDTH.day);
    expect(cells.top.map((c) => c.label)).toContain("Ноябрь 2026");
    expect(cells.bottom).toHaveLength(range.end - range.start);
    const weeks = scaleCells(range, "week", DAY_WIDTH.week);
    expect(weeks.bottom).toHaveLength((range.end - range.start) / 7);
    expect(scaleCells(range, "month", DAY_WIDTH.month).top[0]?.label).toBe("2026");
  });

  it("draws an FS arrow from the predecessor's end to the successor's start", () => {
    expect(dependencyPath(100, 18, 200, 54, 36)).toBe("M100,18 H192 V54 H200");
    expect(dependencyPath(200, 18, 100, 54, 36)).toContain("V36"); // back around a later end
  });
});

describe("filters and the tree", () => {
  it("keeps the filters in the URL and reads them back", () => {
    const filters = { ...EMPTY_FILTERS, q: "маппинг", status: ["todo" as const, "review" as const], assignee: "none", overdue: true };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filterParams(filters))) if (v) params.set(k, v);
    expect(params.toString()).toBe("q=%D0%BC%D0%B0%D0%BF%D0%BF%D0%B8%D0%BD%D0%B3&status=todo%2Creview&assignee=none&overdue=1");
    expect(filtersFromParams(params)).toEqual(filters);
    expect(filtersFromParams(new URLSearchParams("status=bogus,done")).status).toEqual(["done"]);
  });

  it("shows ancestors of a matching subtask as context and hides collapsed branches", () => {
    const tree = buildTree(planTasks());
    const all = visibleRows(tree, EMPTY_FILTERS, new Set());
    expect(all.map((r) => r.task.key).slice(0, 3)).toEqual(["ARIS-1", "ARIS-2", "ARIS-3"]);
    const collapsed = visibleRows(tree, EMPTY_FILTERS, new Set(["t1"]));
    expect(collapsed.map((r) => r.task.key)).not.toContain("ARIS-2");
    const found = visibleRows(tree, { ...EMPTY_FILTERS, q: "опросник" }, new Set());
    expect(found.map((r) => [r.task.key, r.context])).toEqual([
      ["ARIS-1", true],
      ["ARIS-2", true],
      ["ARIS-3", false],
    ]);
  });

  it("allows writes only when the mode and the project role do", () => {
    expect(canWriteProject(capabilities(), project())).toBe(true);
    expect(canWriteProject(READ_ONLY, project({ my_role: "read_only" }))).toBe(false);
    expect(canWriteProject(capabilities({ mode: "membership" }), project({ my_role: "viewer" }))).toBe(false);
    expect(canWriteProject(capabilities({ mode: "membership" }), project({ my_role: "member" }))).toBe(true);
    // The demo stand's one shared login (owner decision 2026-11-25) writes as the single operator.
    expect(canWriteProject(capabilities({ mode: "shared_login" }), project({ my_role: "shared_login" }))).toBe(true);
    expect(canWriteProject(capabilities(), project({ status: "archived" }))).toBe(false);
  });
});
