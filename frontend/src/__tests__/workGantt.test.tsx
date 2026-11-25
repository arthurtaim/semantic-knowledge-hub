import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkTask } from "../api/types";
import { ProjectPage } from "../pages/ProjectPage";
import { mockApi, renderRoutes } from "./helpers";
import { gantt, planTasks, preview, project, projectRoutes, READ_ONLY, stubPointerAndFrames, task } from "./workFixtures";

/*
 * M6 «Гант»: bars from the server's [start, end_exclusive), milestones, arrows, the unscheduled pool, zoom; drag / resize /
 * keyboard → the schedule preview → «Применить» (one idempotency key per confirmation) or «Отмена»; stale previews.
 */

const ROUTES = { "/projects/:key": <ProjectPage /> };
const DAY = 36; // px per day at the «День» zoom (Planner v2)

beforeEach(() => stubPointerAndFrames(vi.stubGlobal));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const APPLIED = {
  preview_id: "pv1",
  project_id: "p1",
  applied: true,
  plan_revision: 8,
  changed_tasks: [] as WorkTask[],
  added_dependencies: [],
  correlation_id: "pv1",
  replayed: false,
};

function bar(key: string): SVGGElement {
  const element = document.querySelector<SVGGElement>(`g.gantt-bar[data-task-key="${key}"]`);
  if (!element) throw new Error(`no bar ${key}`);
  return element;
}

function body(key: string): SVGElement {
  return bar(key).querySelector<SVGElement>("[data-part='body']") as SVGElement;
}

/** A bar's left edge on the drawn range (the range itself depends on the window, so tests compare positions). */
function x(key: string): number {
  return Number(body(key).getAttribute("x"));
}

function dragBy(target: Element, dx: number, finish: "up" | "cancel" = "up") {
  fireEvent.pointerDown(target, { clientX: 500, clientY: 100, button: 0, pointerId: 9 });
  for (let i = 1; i <= 4; i += 1) fireEvent.pointerMove(target, { clientX: 500 + (dx * i) / 4, clientY: 101, pointerId: 9 });
  if (finish === "up") fireEvent.pointerUp(target, { clientX: 500 + dx, clientY: 101, pointerId: 9 });
  else fireEvent.pointerCancel(target, { pointerId: 9 });
}

async function openGantt(path = "/projects/ARIS?view=gantt&zoom=day") {
  renderRoutes(path, ROUTES);
  await screen.findByRole("group", { name: "Полосы задач" });
}

describe("Gantt", () => {
  it("draws [start, end_exclusive) bars, a milestone diamond, FS arrows, today, locked / late states and the unscheduled pool", async () => {
    mockApi(projectRoutes());
    await openGantt();
    expect(body("ARIS-4").getAttribute("width")).toBe(String(DAY)); // one day: Friday only (M6-26)
    expect(body("ARIS-5").getAttribute("width")).toBe(String(2 * DAY)); // Mon–Tue
    expect(x("ARIS-5") - x("ARIS-4")).toBe(3 * DAY); // Fri 27 Nov → Mon 30 Nov
    expect(bar("ARIS-6").querySelector(".gantt-bar__diamond")).not.toBeNull(); // M6-10
    expect(bar("ARIS-6")).toHaveAccessibleName(/Готовность к пилоту, веха 2 дек\./);
    expect(document.querySelectorAll("[data-dependency-id]")).toHaveLength(2);
    expect(bar("ARIS-8")).toHaveClass("is-locked");
    expect(bar("ARIS-8")).not.toHaveClass("is-draggable");
    expect(bar("ARIS-9")).toHaveClass("is-late");
    expect(bar("ARIS-9")).toHaveAccessibleName(/просрочена, срок 19 нояб\./);
    expect(document.querySelector(".gantt__today")).not.toBeNull();
    // M6-27: a task without dates is never drawn as «today» — it waits in the pool.
    expect(document.querySelector('g.gantt-bar[data-task-key="ARIS-7"]')).toBeNull();
    const pool = screen.getByRole("region", { name: /Без дат/ });
    expect(within(pool).getByRole("button", { name: /ARIS-7 Документация без дат/ })).toBeInTheDocument();
  });

  it("zooms to week, month, quarter and year; the zoom is kept in the URL", async () => {
    const user = userEvent.setup();
    mockApi(projectRoutes());
    await openGantt();
    await user.click(screen.getByRole("radio", { name: "Неделя" }));
    expect(screen.getByTestId("location")).toHaveTextContent("zoom=week");
    expect(body("ARIS-5").getAttribute("width")).toBe(String(2 * 16));
    expect(document.querySelectorAll(".gantt__weekend").length).toBeGreaterThan(0); // shaded from 10 px per day
    await user.click(screen.getByRole("radio", { name: "Месяц" }));
    expect(body("ARIS-5").getAttribute("width")).toBe(String(2 * 5));
    expect(document.querySelectorAll(".gantt__weekend")).toHaveLength(0);
    // quarter and year: a bar never gets narrower than 6 px, so every task stays visible
    await user.click(screen.getByRole("radio", { name: "Квартал" }));
    expect(screen.getByTestId("location")).toHaveTextContent("zoom=quarter");
    expect(body("ARIS-5").getAttribute("width")).toBe("6");
    await user.click(screen.getByRole("radio", { name: "Год" }));
    expect(body("ARIS-5").getAttribute("width")).toBe("6");
  });

  it("M6-03: drag → preview of the consequences → «Применить» with one idempotency key; the plan is re-read", async () => {
    let applied = false;
    const shifted = planTasks().map((t) =>
      t.key === "ARIS-4"
        ? { ...t, start_date: "2026-11-30", end_exclusive: "2026-12-01", last_day: "2026-11-30", version: 2 }
        : t.key === "ARIS-5"
          ? { ...t, start_date: "2026-12-01", end_exclusive: "2026-12-03", last_day: "2026-12-02", version: 2 }
          : t,
    );
    const calls = mockApi([
      { method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() },
      {
        method: "POST",
        path: "/api/projects/p1/schedule/apply",
        body: () => {
          applied = true;
          return { ...APPLIED, changed_tasks: shifted.filter((t) => t.version === 2) };
        },
      },
      ...projectRoutes({ snapshot: () => (applied ? gantt(shifted, { plan_revision: 8 }) : gantt()) }),
    ]);
    await openGantt();
    dragBy(body("ARIS-4"), 3 * DAY);
    const dialog = await screen.findByRole("dialog", { name: "Изменение сроков ARIS-4" });
    expect(calls.find((c) => c.url.endsWith("/schedule/preview"))?.body).toEqual({
      mode: "shift_successors",
      changes: [{ task_id: "t4", start_date: "2026-11-30", duration_workdays: 1 }],
    });
    // The dependant and the requested task are listed before anything changes, and drawn as ghosts.
    expect(await within(dialog).findByText("Сдвинутся зависимые: 1")).toBeInTheDocument();
    const shiftedItem = within(dialog).getByText("Загрузчик").closest("li") as HTMLElement;
    expect(shiftedItem).toHaveTextContent("30 нояб. – 1 дек., 2 раб. дня → станет 1 дек. – 2 дек., 2 раб. дня");
    expect(shiftedItem).toHaveTextContent("+1 раб. день · после ARIS-4");
    expect(document.querySelector('[data-ghost-for="ARIS-5"]')).not.toBeNull();
    expect(calls.some((c) => c.url.endsWith("/schedule/apply"))).toBe(false);
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const apply = calls.find((c) => c.url.endsWith("/schedule/apply"));
    expect(apply?.body).toMatchObject({ preview_id: "pv1", expected_plan_revision: 7 });
    expect((apply?.body as { client_request_id: string }).client_request_id.length).toBeGreaterThanOrEqual(8);
    expect(await screen.findByText(/Сроки применены: изменено задач — 2\. Ревизия плана 8\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("plan-revision")).toHaveTextContent("Ревизия плана 8"));
    expect(x("ARIS-5") - x("ARIS-4")).toBe(DAY); // ARIS-4 Mon 30 Nov, ARIS-5 Tue 1 Dec
    expect(document.querySelector("[data-ghost-for]")).toBeNull();
  });

  it("«Отмена» writes nothing and puts the bar back", async () => {
    const user = userEvent.setup();
    const calls = mockApi([{ method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() }, ...projectRoutes()]);
    await openGantt();
    const before = x("ARIS-4");
    dragBy(body("ARIS-4"), 3 * DAY);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Сдвинутся зависимые: 1");
    await user.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/schedule/apply"))).toBe(false);
    expect(x("ARIS-4")).toBe(before);
    expect(document.querySelector("[data-ghost-for]")).toBeNull();
  });

  it("a drag that is cancelled by the browser (pointercancel) or stays within the day asks nothing", async () => {
    const calls = mockApi(projectRoutes());
    await openGantt();
    dragBy(body("ARIS-4"), 3 * DAY, "cancel");
    dragBy(body("ARIS-4"), 10);
    expect(calls.some((c) => c.url.endsWith("/schedule/preview"))).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("resizing the right edge sends the new exclusive end (duration in working days)", async () => {
    const calls = mockApi([{ method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() }, ...projectRoutes()]);
    await openGantt();
    dragBy(bar("ARIS-5").querySelector("[data-part='resize']") as Element, 2 * DAY);
    await screen.findByRole("dialog");
    expect(calls.find((c) => c.url.endsWith("/schedule/preview"))?.body).toMatchObject({
      changes: [{ task_id: "t5", start_date: "2026-11-30", end_exclusive: "2026-12-04" }],
    });
  });

  it("a retry of the same confirmation reuses its idempotency key", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const calls = mockApi([
      { method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() },
      {
        method: "POST",
        path: "/api/projects/p1/schedule/apply",
        respond: () => {
          attempt += 1;
          return attempt === 1
            ? new Response(JSON.stringify({ code: "internal_error", message: "Сбой сети.", request_id: "r" }), { status: 502 })
            : new Response(JSON.stringify({ ...APPLIED, replayed: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
      ...projectRoutes(),
    ]);
    await openGantt();
    dragBy(body("ARIS-4"), 3 * DAY);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Сдвинутся зависимые: 1");
    await user.click(within(dialog).getByRole("button", { name: "Применить" }));
    expect(await within(dialog).findByText("Сбой сети.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const keys = calls.filter((c) => c.url.endsWith("/schedule/apply")).map((c) => (c.body as { client_request_id: string }).client_request_id);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await screen.findByText(/повтор того же подтверждения/)).toBeInTheDocument();
  });

  it("M6-31: 409 stale_schedule re-reads the plan and computes the preview again; nothing is applied blindly", async () => {
    const user = userEvent.setup();
    let previews = 0;
    let applies = 0;
    const calls = mockApi([
      {
        method: "POST",
        path: "/api/projects/p1/schedule/preview",
        body: () => {
          previews += 1;
          return preview({ preview_id: `pv${previews}`, base_plan_revision: previews === 1 ? 7 : 8 });
        },
      },
      {
        method: "POST",
        path: "/api/projects/p1/schedule/apply",
        respond: () => {
          applies += 1;
          return applies === 1
            ? new Response(JSON.stringify({ code: "stale_schedule", message: "План изменился.", request_id: "r", details: { reason: "plan_revision" } }), { status: 409 })
            : new Response(JSON.stringify({ ...APPLIED, preview_id: "pv2" }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
      ...projectRoutes(),
    ]);
    await openGantt();
    const reads = () => calls.filter((c) => c.url === "/api/projects/ARIS/gantt").length;
    dragBy(body("ARIS-4"), 3 * DAY);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Сдвинутся зависимые: 1");
    const before = reads();
    await user.click(within(dialog).getByRole("button", { name: "Применить" }));
    expect(await within(dialog).findByText(/Пока вы смотрели предпросмотр, план проекта изменился/)).toBeInTheDocument();
    await waitFor(() => expect(previews).toBe(2));
    expect(reads()).toBe(before + 1);
    await within(dialog).findByText("Сдвинутся зависимые: 1");
    await user.click(within(dialog).getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const bodies = calls.filter((c) => c.url.endsWith("/schedule/apply")).map((c) => c.body as { preview_id: string; expected_plan_revision: number; client_request_id: string });
    expect(bodies.map((b) => [b.preview_id, b.expected_plan_revision])).toEqual([
      ["pv1", 7],
      ["pv2", 8],
    ]);
    expect(bodies[0]?.client_request_id).not.toBe(bodies[1]?.client_request_id);
  });

  it("M6-08/M6-29: conflicts keep «Применить» disabled; «Только эта задача» asks the server again", async () => {
    const user = userEvent.setup();
    const calls = mockApi([
      {
        method: "POST",
        path: "/api/projects/p1/schedule/preview",
        body: preview({
          can_apply: false,
          conflicts: [{ code: "locked_successor", task_id: "t8", key: "ARIS-8", related_task_ids: ["t4"], message: "Закреплённая задача должна сдвинуться." }],
        }),
      },
      ...projectRoutes(),
    ]);
    await openGantt();
    dragBy(body("ARIS-4"), 3 * DAY);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Конфликты — применить нельзя")).toBeInTheDocument();
    expect(within(dialog).getByText(/Зависимой задаче с закреплёнными сроками пришлось бы сдвинуться/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Применить" })).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: "Только эта задача" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule/preview"))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith("/schedule/preview"))[1]?.body).toMatchObject({ mode: "only_this_task" });
  });

  it("a deadline warning needs an explicit tick before «Применить»", async () => {
    const user = userEvent.setup();
    const calls = mockApi([
      {
        method: "POST",
        path: "/api/projects/p1/schedule/preview",
        body: preview({ warnings: [{ code: "due_date_exceeded", task_id: "t6", key: "ARIS-6", due_date: "2026-12-02", last_day: "2026-12-03", message: "Срок превышен." }] }),
      },
      { method: "POST", path: "/api/projects/p1/schedule/apply", body: APPLIED },
      ...projectRoutes(),
    ]);
    await openGantt();
    dragBy(body("ARIS-4"), 3 * DAY);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/закончится 3 дек\. — позже срока 2 дек\./)).toBeInTheDocument();
    const apply = within(dialog).getByRole("button", { name: "Применить" });
    expect(apply).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /срок будет превышен/ }));
    expect(apply).toBeEnabled();
    await user.click(apply);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/schedule/apply"))?.body).toMatchObject({ accept_warnings: true }));
  });

  it("WCAG 2.5.7: a focused bar moves with ←/→ and resizes with Shift + ←/→; Enter previews, Esc cancels", async () => {
    const user = userEvent.setup();
    const calls = mockApi([{ method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() }, ...projectRoutes()]);
    await openGantt();
    const before = x("ARIS-4");
    bar("ARIS-4").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByText(/ARIS-4: 30 нояб\.\. Enter — показать последствия, Esc — отменить\./)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByText("Изменение отменено.")).toBeInTheDocument();
    expect(x("ARIS-4")).toBe(before);
    await user.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}{Enter}");
    await screen.findByRole("dialog");
    expect(calls.find((c) => c.url.endsWith("/schedule/preview"))?.body).toMatchObject({
      changes: [{ task_id: "t4", start_date: "2026-11-27", end_exclusive: "2026-12-02" }],
    });
  });

  it("Enter without a pending change opens the task; a locked task says why it does not move", async () => {
    const user = userEvent.setup();
    const calls = mockApi(projectRoutes());
    await openGantt();
    bar("ARIS-8").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(/ARIS-8: сроки закреплены/)).toBeInTheDocument();
    dragBy(body("ARIS-8"), 3 * DAY);
    expect(calls.some((c) => c.url.endsWith("/schedule/preview"))).toBe(false);
    bar("ARIS-4").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("task=ARIS-4");
  });

  it("read-only: nothing drags, arrows do nothing, the hint says so", async () => {
    const user = userEvent.setup();
    const calls = mockApi(projectRoutes({ caps: READ_ONLY, proj: project({ my_role: "read_only" }) }));
    await openGantt();
    expect(screen.getByText("Только просмотр.")).toBeInTheDocument();
    expect(bar("ARIS-4")).not.toHaveClass("is-draggable");
    expect(document.querySelector("[data-part='resize']")).toBeNull();
    dragBy(body("ARIS-4"), 3 * DAY);
    bar("ARIS-4").focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(calls.some((c) => c.url.endsWith("/schedule/preview"))).toBe(false);
  });

  it("Planner v2: summary brackets, overdue hatching, markers outside the window, today, labels beside bars, routed arrows", async () => {
    mockApi(projectRoutes());
    await openGantt();
    // ARIS-1 and ARIS-2 have scheduled subtasks: brackets over them (their subtasks' dates change, not theirs)
    expect(bar("ARIS-1")).toHaveClass("gantt-bar--summary");
    expect(bar("ARIS-1").querySelector(".gantt-bar__summary")).not.toBeNull();
    expect(bar("ARIS-1")).not.toHaveClass("is-draggable");
    expect(bar("ARIS-1")).toHaveAccessibleName(/сроки по подзадачам: 2 нояб\. – 9 нояб\./);
    expect(bar("ARIS-3")).not.toHaveClass("gantt-bar--summary");
    // they lie before the window (today is at 30 % of it): a marker with their dates at its left edge
    expect(screen.getByRole("button", { name: "ARIS-1: 2 нояб. – 9 нояб. — показать на шкале" })).toHaveTextContent("‹ 2 нояб. – 9 нояб.");
    // ARIS-9 is overdue: hatched from its end (Fri 20 Nov) to the start of today (Wed 25 Nov)
    const hatch = bar("ARIS-9").querySelector(".gantt-bar__hatch") as SVGRectElement;
    expect(Number(hatch.getAttribute("x"))).toBe(x("ARIS-9") + 4 * DAY);
    expect(Number(hatch.getAttribute("width"))).toBe(5 * DAY);
    // today: a line through the middle of the day and the «25 нояб.» mark in the scale
    expect(document.querySelector(".gantt__today-mark")).toHaveTextContent("25 нояб.");
    expect(Number(document.querySelector(".gantt__today")?.getAttribute("x1"))).toBe(x("ARIS-4") - 1.5 * DAY);
    expect(Array.from(document.querySelectorAll(".gantt__scale-top")).map((cell) => cell.textContent)).toContain("Ноябрь 2026");
    // a one-day bar is too short for its title: it goes 8 px to the right, on a backing
    const label = Array.from(document.querySelectorAll<HTMLElement>(".gantt__label")).find((el) => el.textContent === "Маппинг метаданных");
    expect(parseFloat(label?.style.left ?? "")).toBe(x("ARIS-4") + DAY + 8);
    // ARIS-4 → ARIS-5: the vertical right after ARIS-4's end (before its label), the horizontal on ARIS-5's row
    const row = (index: number) => index * 36 + 18;
    expect(document.querySelector('[data-dependency-id="d1"] .gantt-arrow__line')?.getAttribute("d")).toBe(
      `M${x("ARIS-4") + DAY} ${row(3)}H${x("ARIS-4") + DAY + 6}V${row(4)}H${x("ARIS-5")}`,
    );
  });

  it("a bar wide enough for its title carries it inside; «Готово» adds its tick; a summary does not move", async () => {
    const user = userEvent.setup();
    const tasks = [
      task({ key: "ARIS-1", title: "Длинная", status: "done", start_date: "2026-11-23", end_exclusive: "2026-11-28", last_day: "2026-11-27", duration_workdays: 5 }),
      task({ key: "ARIS-2", title: "Родитель", start_date: "2026-11-30", end_exclusive: "2026-12-01", last_day: "2026-11-30", duration_workdays: 1, child_count: 1 }),
      task({ key: "ARIS-3", title: "Подзадача", parent_task_id: "t2", depth: 2, start_date: "2026-12-01", end_exclusive: "2026-12-03", last_day: "2026-12-02", duration_workdays: 2 }),
    ];
    mockApi(projectRoutes({ snapshot: gantt(tasks, { dependencies: [] }) }));
    await openGantt();
    expect(bar("ARIS-1").querySelector(".gantt-bar__text")).toHaveTextContent("Длинная");
    expect(bar("ARIS-1").querySelector(".gantt-bar__tick")).not.toBeNull();
    expect(Array.from(document.querySelectorAll(".gantt__label")).map((el) => el.textContent)).not.toContain("Длинная");
    // the bracket covers the parent's own day and its subtask: 30 Nov – 2 Dec
    const bracket = body("ARIS-2");
    expect(bracket.getAttribute("d")).toMatch(new RegExp(`^M${x("ARIS-3") - DAY},`));
    bar("ARIS-2").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("ARIS-2: сроки по подзадачам — меняйте сроки подзадач.")).toBeInTheDocument();
  });

  it("M6-23: 200 tasks — only the visible window of rows is in the DOM, scrolling brings the others", async () => {
    const many: WorkTask[] = [];
    for (let i = 1; i <= 200; i += 1) {
      const start = `2026-${i % 2 ? "11" : "12"}-${String((i % 20) + 1).padStart(2, "0")}`;
      many.push(task({ key: `ARIS-${i}`, title: `Задача ${i}`, start_date: start, end_exclusive: start, is_milestone: i % 50 === 0, duration_workdays: 0 }));
      if (i % 50 !== 0) {
        const t = many[many.length - 1]!;
        many[many.length - 1] = { ...t, end_exclusive: `${start.slice(0, 8)}${String(Number(start.slice(8)) + 1).padStart(2, "0")}`, last_day: start, duration_workdays: 1 };
      }
    }
    mockApi(projectRoutes({ snapshot: gantt(many, { dependencies: [] }) }));
    const started = performance.now();
    await openGantt();
    const elapsed = performance.now() - started;
    const drawn = document.querySelectorAll("g.gantt-bar").length;
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(40);
    expect(document.querySelector('g.gantt-bar[data-task-key="ARIS-150"]')).toBeNull();
    const scroller = document.querySelector(".gantt__scroller") as HTMLElement;
    await act(async () => {
      scroller.scrollTop = 150 * 36;
      fireEvent.scroll(scroller);
    });
    expect(document.querySelector('g.gantt-bar[data-task-key="ARIS-150"]')).not.toBeNull();
    expect(document.querySelectorAll("g.gantt-bar").length).toBeLessThan(60);
    expect(elapsed).toBeLessThan(5000);
  });
});
