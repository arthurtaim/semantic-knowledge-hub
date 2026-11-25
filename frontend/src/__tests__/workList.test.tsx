import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "../pages/ProjectPage";
import { mockApi, renderRoutes } from "./helpers";
import { ASSIGNEES, capabilities, gantt, planTasks, preview, project, projectRoutes, READ_ONLY, task } from "./workFixtures";

/* M6 «Список»: the task tree, inline editing with optimistic locking, filters in the URL, create task / subtask. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROUTES = { "/projects/:key": <ProjectPage /> };

function row(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`tr[data-task-key="${key}"]`);
  if (!element) throw new Error(`no row ${key}`);
  return element;
}

describe("Task list", () => {
  it("shows the hierarchy (subtasks 3 levels deep) with expand / collapse, marks and the plan revision", async () => {
    const user = userEvent.setup();
    mockApi(projectRoutes());
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    expect(screen.getByTestId("plan-revision")).toHaveTextContent("Ревизия плана 7");
    expect(row("ARIS-3")).toHaveAttribute("data-depth", "3");
    // M6-10 / overdue: a milestone and an overdue task carry words, not only colour.
    expect(within(row("ARIS-6")).getByText("Веха")).toBeInTheDocument();
    expect(within(row("ARIS-9")).getByText(/Просрочена \(срок 19 нояб\.\)/)).toBeInTheDocument();
    expect(within(row("ARIS-5")).getByText("Ждёт ARIS-4")).toBeInTheDocument();
    expect(within(row("ARIS-7")).getByRole("button", { name: /Начало ARIS-7: Без дат/ })).toBeInTheDocument();
    // M6-26: the end column shows the last day (inclusive), not end_exclusive.
    expect(within(row("ARIS-5")).getByRole("button", { name: /Последний день ARIS-5: 1 дек\./ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Свернуть подзадачи ARIS-1" }));
    expect(document.querySelector('tr[data-task-key="ARIS-2"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Развернуть подзадачи ARIS-1" }));
    expect(row("ARIS-2")).toBeInTheDocument();
  });

  it("M6-02 (list part): changes a status inline with the expected version, without a reload", async () => {
    const user = userEvent.setup();
    const tasks = planTasks();
    const updated = { ...tasks[3]!, status: "review" as const, version: 2 };
    let saved = false;
    const calls = mockApi([
      {
        method: "PATCH",
        path: "/api/tasks/t4",
        body: () => {
          saved = true;
          return updated;
        },
      },
      ...projectRoutes({ snapshot: () => gantt(saved ? tasks.map((t) => (t.id === "t4" ? updated : t)) : tasks, { plan_revision: saved ? 8 : 7 }) }),
    ]);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    await user.selectOptions(screen.getByRole("combobox", { name: "Статус ARIS-4 Маппинг метаданных" }), "review");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/tasks/t4");
    expect(patch?.body).toEqual({ expected_version: 1, status: "review" });
    expect(screen.getByRole("combobox", { name: "Статус ARIS-4 Маппинг метаданных" })).toHaveValue("review");
    // The snapshot is re-read quietly (no loading state): every view now shows the new plan revision.
    await waitFor(() => expect(screen.getByTestId("plan-revision")).toHaveTextContent("Ревизия плана 8"));
    expect(screen.getByRole("combobox", { name: "Статус ARIS-4 Маппинг метаданных" })).toHaveValue("review");
    expect(screen.queryByText("Загружаем проект…")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/projects/ARIS/gantt")).toHaveLength(2);
  });

  it("M6-17: a stale version (409) rolls back, re-reads the snapshot and says what happened", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const fresh = planTasks().map((t) => (t.key === "ARIS-4" ? { ...t, version: 5, priority: "critical" as const } : t));
    mockApi([
      {
        method: "PATCH",
        path: "/api/tasks/t4",
        status: 409,
        body: { code: "stale_task", message: "Задача уже изменена — обновите данные.", request_id: "r", details: { current_version: 5 } },
      },
      ...projectRoutes({
        snapshot: () => {
          reads += 1;
          return reads > 1 ? gantt(fresh, { plan_revision: 9 }) : gantt();
        },
      }),
    ]);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    await user.selectOptions(screen.getByRole("combobox", { name: "Приоритет ARIS-4 Маппинг метаданных" }), "low");
    expect(await screen.findByText(/ARIS-4 уже изменили в другом месте/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Приоритет ARIS-4 Маппинг метаданных" })).toHaveValue("critical"));
    expect(screen.getByTestId("plan-revision")).toHaveTextContent("Ревизия плана 9");
  });

  it("rolls back an optimistic change when the server refuses it and shows the server's message", async () => {
    const user = userEvent.setup();
    mockApi([
      {
        method: "PATCH",
        path: "/api/tasks/t4",
        status: 422,
        body: { code: "invalid_assignee", message: "Такого исполнителя нет в проекте.", request_id: "r", details: {} },
      },
      ...projectRoutes(),
    ]);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    const select = screen.getByRole("combobox", { name: "Исполнитель ARIS-4 Маппинг метаданных" });
    // Options are grouped by the demo team's roles; the operator (no role) comes first.
    expect(within(select).getByRole("group", { name: "Аналитик" })).toHaveTextContent("Анна Лебедева (демо)");
    expect(within(select).getByRole("group", { name: "Разработчик" })).toHaveTextContent("Дмитрий Орлов (демо)");
    await user.selectOptions(select, "demo-dev-1");
    expect(await screen.findByText("ARIS-4: Такого исполнителя нет в проекте.")).toBeInTheDocument();
    expect(select).toHaveValue("demo-analyst-1");
  });

  it("renames inline (Enter saves, Esc cancels)", async () => {
    const user = userEvent.setup();
    const calls = mockApi([{ method: "PATCH", path: "/api/tasks/t7", body: { ...planTasks()[6]!, title: "Документация", version: 2 } }, ...projectRoutes()]);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Изменить: Название ARIS-7" }));
    await user.keyboard("{Escape}");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Изменить: Название ARIS-7" }));
    const input = screen.getByRole("textbox", { name: "Название ARIS-7" });
    await user.clear(input);
    await user.type(input, "Документация{Enter}");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expected_version: 1, title: "Документация" }));
  });

  it("a date that would break a dependency opens the schedule preview instead of failing silently", async () => {
    const user = userEvent.setup();
    const calls = mockApi([
      {
        method: "PATCH",
        path: "/api/tasks/t4",
        status: 422,
        body: { code: "schedule_conflict", message: "Новые даты нарушают зависимость FS.", request_id: "r", details: { reason: "fs_violation" } },
      },
      { method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() },
      ...projectRoutes(),
    ]);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /Начало ARIS-4/ }));
    const input = screen.getByLabelText("Начало ARIS-4");
    await user.clear(input);
    await user.type(input, "2026-11-30{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Изменение сроков ARIS-4" });
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expected_version: 1, start_date: "2026-11-30" });
    expect(calls.find((c) => c.url.endsWith("/schedule/preview"))?.body).toMatchObject({
      mode: "shift_successors",
      changes: [{ task_id: "t4", start_date: "2026-11-30", duration_workdays: 1 }],
    });
    expect(await within(dialog).findByText("Сдвинутся зависимые: 1")).toBeInTheDocument();
  });

  it("filters by status, assignee, overdue and milestone through the URL (one model for every view)", async () => {
    const user = userEvent.setup();
    mockApi(projectRoutes());
    renderRoutes("/projects/ARIS?view=list&overdue=1", ROUTES);
    await screen.findByRole("table");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(row("ARIS-9")).toBeInTheDocument();
    expect(screen.getByText("Найдено: 1 из 9")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/ARIS?view=list");
    // Planner v2: «Вехи» lives in «Ещё»; once chosen it is a chip with a remove button in the same row.
    await user.click(screen.getByRole("button", { name: "Ещё" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Вехи" }));
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("location")).toHaveTextContent("milestone=1");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Убрать фильтр «Вехи»" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("milestone=1");
    await user.click(screen.getByRole("button", { name: "Исполнитель" }));
    // The menu shows the demo team's distribution: each person's role and how many tasks of the project they hold.
    const anna = screen.getByRole("menuitemradio", { name: /Анна Лебедева \(демо\)/ });
    expect(anna).toHaveTextContent("Аналитик");
    expect(anna).toHaveTextContent(/1$/);
    expect(screen.getByRole("menuitemradio", { name: /Дмитрий Орлов \(демо\)/ })).toHaveTextContent(/Разработчик.*0$/);
    await user.click(anna);
    expect(screen.getByTestId("location")).toHaveTextContent("assignee=demo-analyst-1");
    expect(Array.from(document.querySelectorAll("tbody tr")).map((r) => r.getAttribute("data-task-key"))).toEqual(["ARIS-4"]);
  });

  it("M6-01: creates a subtask from a row with the parent preset and opens it", async () => {
    const user = userEvent.setup();
    const created = task({ key: "ARIS-10", title: "Новая подзадача", parent_task_id: "t4", depth: 2 });
    let reads = 0;
    const calls = mockApi([
      { method: "POST", path: "/api/projects/p1/tasks", status: 201, body: created },
      ...projectRoutes({
        snapshot: () => {
          reads += 1;
          return reads > 1 ? gantt([...planTasks(), created]) : gantt();
        },
      }),
    ]);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Добавить подзадачу к ARIS-4" }));
    const dialog = screen.getByRole("dialog", { name: "Подзадача к ARIS-4" });
    expect(within(dialog).getByLabelText("Родительская задача")).toHaveValue("t4");
    await user.type(within(dialog).getByLabelText(/Название/), "Новая подзадача");
    await user.selectOptions(within(dialog).getByLabelText("Исполнитель"), "demo-analyst-1");
    await user.click(within(dialog).getByRole("radio", { name: "Начало и длительность" }));
    await user.type(within(dialog).getByLabelText("Начало"), "2026-11-30");
    await user.click(within(dialog).getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("task=ARIS-10"));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      title: "Новая подзадача",
      parent_task_id: "t4",
      assignee_id: "demo-analyst-1",
      start_date: "2026-11-30",
      duration_workdays: 1,
      is_milestone: false,
    });
    expect(await screen.findByText("Задача ARIS-10 создана.")).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).getByRole("heading", { level: 2, name: "ARIS-10: Новая подзадача" })).toBeInTheDocument();
  });

  it("M6-19/M6-20: read-only mode shows values as text — no selects, no edit buttons, no «Задача»", async () => {
    mockApi(projectRoutes({ caps: READ_ONLY, proj: project({ my_role: "read_only" }) }));
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    expect(screen.getByText("Только просмотр — изменения задач отключены")).toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Изменить/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Добавить подзадачу/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Задача" })).not.toBeInTheDocument();
    expect(within(row("ARIS-4")).getByText("В работе")).toBeInTheDocument();
    expect(within(row("ARIS-4")).getByText(ASSIGNEES[1]!.display_name)).toBeInTheDocument();
  });

  it("a viewer of a team project (membership) gets no write controls either", async () => {
    mockApi(projectRoutes({ caps: capabilities({ mode: "membership", label: "Командный режим — права участников проекта" }), proj: project({ my_role: "viewer" }) }));
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });

  it("an unknown project is a clear «not found», not a stack trace", async () => {
    mockApi([
      { path: "/api/work/capabilities", body: capabilities() },
      { path: "/api/projects/NOPE", status: 404, body: { code: "not_found", message: "Не найдено.", request_id: "r" } },
      { path: "/api/projects/NOPE/gantt", status: 404, body: { code: "not_found", message: "Не найдено.", request_id: "r" } },
    ]);
    renderRoutes("/projects/NOPE", ROUTES);
    expect(await screen.findByRole("heading", { level: 1, name: "Проект не найден" })).toBeInTheDocument();
  });
});
