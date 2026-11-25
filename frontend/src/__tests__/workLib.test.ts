import { afterEach, describe, expect, it, vi } from "vitest";
import { plannedChange } from "../components/work/GanttChart";
import {
  addWorkdays,
  buildTree,
  canWriteProject,
  countWorkdays,
  EMPTY_FILTERS,
  filterParams,
  filtersFromParams,
  formatPlan,
  formatPlanShort,
  groupTasks,
  initials,
  fromDay,
  isoWeekday,
  lastWorkday,
  nextWorkday,
  pluralWorkdays,
  readHiddenColumns,
  resolveListGroup,
  toDay,
  visibleRows,
  writeHiddenColumns,
} from "../lib/work";
import { memoryStorage } from "./helpers";
import { ASSIGNEES, capabilities, planTasks, project, READ_ONLY, task, TODAY } from "./workFixtures";

afterEach(() => vi.unstubAllGlobals());

/*
 * M6 UI helpers: the calendar mirror, the drag arithmetic, the filter model, the tree (docs/WORK_MANAGEMENT.md «UI»).
 * The Gantt's scale, bar geometry and arrows moved to lib/gantt.ts with Planner v2: ganttLib.test.ts covers them.
 */

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

  it("makes the initials of an avatar from a name (the «(демо)» note and hyphens handled)", () => {
    expect(initials("Анна Лебедева (демо)")).toBe("АЛ");
    expect(initials("Демо-пользователь (localhost)")).toBe("ДП");
    expect(initials("Олег")).toBe("О");
    expect(initials("  ")).toBe("?");
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

describe("the list: plan cell, groups, columns (Planner v2 §4)", () => {
  it("writes «10 – 19 нояб.» within a month, both months across them, one date for a milestone", () => {
    const t = (start: string, last: string) => task({ key: "ARIS-1", start_date: start, end_exclusive: start, last_day: last, scheduled: true });
    expect(formatPlanShort(t("2026-11-10", "2026-11-19"), TODAY)).toBe("10 – 19 нояб.");
    expect(formatPlanShort(t("2026-11-27", "2026-12-04"), TODAY)).toBe("27 нояб. – 4 дек.");
    expect(formatPlanShort(t("2026-11-27", "2026-11-27"), TODAY)).toBe("27 нояб.");
    expect(formatPlanShort(task({ key: "ARIS-2", is_milestone: true, start_date: "2026-12-02", end_exclusive: "2026-12-02" }), TODAY)).toBe("2 дек.");
    expect(formatPlanShort(task({ key: "ARIS-3" }), TODAY)).toBe("Без дат");
  });

  it("groups by status (work in progress first), priority and assignee; empty groups are left out", () => {
    const tasks = planTasks();
    expect(groupTasks(tasks, "status", ASSIGNEES).map((g) => [g.label, g.tasks.length])).toEqual([
      ["В работе", 2],
      ["К работе", 4],
      ["Готово", 3],
    ]);
    expect(groupTasks(tasks, "priority", ASSIGNEES).map((g) => [g.label, g.tasks.length])).toEqual([
      ["Критичный", 1],
      ["Высокий", 1],
      ["Средний", 7],
    ]);
    expect(groupTasks(tasks, "assignee", ASSIGNEES).map((g) => [g.label, g.tasks.map((t) => t.key).length])).toEqual([
      ["Анна Лебедева (демо)", 1],
      ["Не назначен", 8],
    ]);
  });

  it("keeps the grouping in the URL or the stored setting, and the hidden columns in this browser", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(resolveListGroup(new URLSearchParams())).toBe("none");
    expect(resolveListGroup(new URLSearchParams("group=priority"))).toBe("priority");
    window.localStorage.setItem("skh.work.list.group", "assignee");
    expect(resolveListGroup(new URLSearchParams())).toBe("assignee");
    expect(resolveListGroup(new URLSearchParams("group=bogus"))).toBe("assignee");
    writeHiddenColumns(new Set(["due", "priority"]));
    expect([...readHiddenColumns()].sort()).toEqual(["due", "priority"]);
    window.localStorage.setItem("skh.work.list.columns", '["title", 3, "dates"]');
    expect([...readHiddenColumns()]).toEqual(["dates"]);
  });
});

