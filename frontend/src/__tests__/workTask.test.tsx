import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "../pages/ProjectPage";
import { TaskPage } from "../pages/TaskPage";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";
import { dependency, gantt, planTasks, preview, project, projectRoutes, READ_ONLY } from "./workFixtures";

/* M6 task detail: fields, subtasks, dependencies (add / remove, the cycle path), history, the «Документы» seam. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROUTES = { "/projects/:key": <ProjectPage />, "/tasks/:key": <TaskPage /> };
const tasks = planTasks();
const brief = (id: string) => {
  const t = tasks.find((x) => x.id === id)!;
  return { id: t.id, key: t.key, title: t.title, status: t.status, start_date: t.start_date, end_exclusive: t.end_exclusive, is_milestone: t.is_milestone };
};
const DEPS_OF_5 = {
  task_id: "t5",
  plan_revision: 7,
  predecessors: [{ dependency: dependency("d1", "t4", "t5"), task: brief("t4") }],
  successors: [{ dependency: dependency("d2", "t5", "t6"), task: brief("t6") }],
};
const HISTORY = {
  items: [
    {
      seq: 3,
      id: "e3",
      at: "2026-11-24T12:00:00Z",
      actor_id: "local-demo-user",
      actor_display: "Демо-пользователь (localhost)",
      operation: "task_updated",
      entity_type: "task",
      entity_id: "t5",
      project_id: "p1",
      task_id: "t5",
      task_key: "ARIS-5",
      correlation_id: null,
      changes: { status: { before: "todo", after: "in_progress" }, assignee_id: { before: null, after: "demo-analyst" }, description: { changed: true } },
    },
    {
      seq: 1,
      id: "e1",
      at: "2026-11-20T09:00:00Z",
      actor_id: "system:demo-seed",
      actor_display: "Демо-данные (синтетические)",
      operation: "task_created",
      entity_type: "task",
      entity_id: "t5",
      project_id: "p1",
      task_id: "t5",
      task_key: "ARIS-5",
      correlation_id: null,
      changes: {},
    },
  ],
  next_before_seq: null,
};

function routes(extra: MockRoute[] = [], base = projectRoutes()): MockRoute[] {
  return [
    ...extra,
    { path: "/api/tasks/t5/dependencies", body: DEPS_OF_5 },
    { path: /^\/api\/tasks\/t5\/activity/, body: HISTORY },
    ...base,
  ];
}

async function openPanel() {
  renderRoutes("/projects/ARIS?view=list&task=ARIS-5", ROUTES);
  const panel = await screen.findByRole("complementary", { name: "ARIS-5: Загрузчик" });
  await within(panel).findByText("Начнётся после");
  return panel;
}

describe("Task detail", () => {
  it("shows all fields, dependencies, history (who / when / what) and the «Документы» block for Step 4", async () => {
    mockApi(routes());
    const panel = await openPanel();
    expect(within(panel).getByRole("combobox", { name: "Статус ARIS-5 Загрузчик" })).toHaveValue("todo");
    expect(within(panel).getByText("30 нояб. – 1 дек.")).toBeInTheDocument();
    expect(within(panel).getByText(/2 раб\. дня/)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "ARIS-4 Маппинг метаданных" })).toHaveAttribute("href", expect.stringContaining("task=ARIS-4"));
    expect(within(panel).getByRole("link", { name: "ARIS-6 Готовность к пилоту" })).toBeInTheDocument();
    const history = within(panel).getByRole("heading", { name: "История" }).closest("section") as HTMLElement;
    expect(within(history).getByText("Демо-пользователь (localhost)")).toBeInTheDocument();
    expect(within(history).getByText("Статус: К работе → В работе")).toBeInTheDocument();
    expect(within(history).getByText("Исполнитель: — → Аналитик (демо)")).toBeInTheDocument();
    expect(within(history).getByText("Описание: изменено")).toBeInTheDocument();
    expect(within(history).getByText("создал(а) задачу")).toBeInTheDocument();
    const docs = within(panel).getByRole("heading", { name: "Документы" }).closest("section") as HTMLElement;
    expect(docs).toHaveAttribute("data-step4-seam", "task-documents");
    expect(within(docs).getByText(/ещё не подключены/)).toBeInTheDocument();
    expect(within(docs).queryByRole("button")).not.toBeInTheDocument();
  });

  it("removes a dependency with the plan revision and re-reads the plan", async () => {
    const user = userEvent.setup();
    const calls = mockApi(routes([{ method: "DELETE", path: "/api/tasks/t5/dependencies/d1?expected_plan_revision=7", body: { dependency_id: "d1", plan_revision: 8 } }]));
    const panel = await openPanel();
    const before = calls.filter((c) => c.url === "/api/projects/ARIS/gantt").length;
    await user.click(within(panel).getByRole("button", { name: "Убрать зависимость ARIS-4 → ARIS-5" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/projects/ARIS/gantt").length).toBe(before + 1));
    expect(await screen.findByText("Зависимость ARIS-4 → ARIS-5 убрана.")).toBeInTheDocument();
  });

  it("M6-05: a cycle is refused and the server's path is shown", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        {
          method: "POST",
          path: "/api/tasks/t5/dependencies",
          status: 422,
          body: {
            code: "dependency_cycle",
            message: "Зависимость создаёт цикл.",
            request_id: "r",
            details: { cycle: ["t5", "t6", "t5"], cycle_keys: ["ARIS-5", "ARIS-6", "ARIS-5"] },
          },
        },
      ]),
    );
    const panel = await openPanel();
    await user.selectOptions(within(panel).getByLabelText("Новая зависимость"), "predecessor");
    await user.selectOptions(within(panel).getByLabelText("Задача"), "t6");
    await user.click(within(panel).getByRole("button", { name: "Добавить зависимость" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Нельзя: зависимость замкнёт цикл.");
    expect(alert).toHaveTextContent("Цикл: ARIS-5 → ARIS-6 → ARIS-5");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ predecessor_task_id: "t6", expected_plan_revision: 7 });
  });

  it("a dependency the current dates violate is added through the preview (the dependants shift)", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        {
          method: "POST",
          path: "/api/tasks/t5/dependencies",
          status: 422,
          body: { code: "schedule_conflict", message: "Нарушена.", request_id: "r", details: { reason: "dependency_violated" } },
        },
        {
          method: "POST",
          path: "/api/projects/p1/schedule/preview",
          body: preview({ added_dependencies: [{ predecessor_task_id: "t8", successor_task_id: "t5", kind: "FS", lag_workdays: 0 }] }),
        },
        { method: "POST", path: "/api/projects/p1/schedule/apply", body: { preview_id: "pv1", project_id: "p1", applied: true, plan_revision: 8, changed_tasks: [], added_dependencies: [], correlation_id: "pv1", replayed: false } },
      ]),
    );
    const panel = await openPanel();
    await user.selectOptions(within(panel).getByLabelText("Задача"), "t8");
    await user.click(within(panel).getByRole("button", { name: "Добавить зависимость" }));
    await user.click(await within(panel).findByRole("button", { name: "Показать последствия" }));
    const inline = await within(panel).findByRole("region", { name: "Последствия изменения сроков" });
    expect(calls.find((c) => c.url.endsWith("/schedule/preview"))?.body).toMatchObject({
      changes: [],
      add_dependencies: [{ predecessor_task_id: "t8", successor_task_id: "t5", kind: "FS", lag_workdays: 0 }],
    });
    expect(await within(inline).findByText("Новые зависимости")).toBeInTheDocument();
    await user.click(within(inline).getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/schedule/apply"))).toBe(true));
    expect(await screen.findByText(/Зависимость добавлена, сдвинуто задач/)).toBeInTheDocument();
  });

  it("changes dates through the form and the inline preview (the keyboard alternative to dragging)", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        { method: "POST", path: "/api/projects/p1/schedule/preview", body: preview() },
        { method: "POST", path: "/api/projects/p1/schedule/apply", body: { preview_id: "pv1", project_id: "p1", applied: true, plan_revision: 8, changed_tasks: [], added_dependencies: [], correlation_id: "pv1", replayed: false } },
      ]),
    );
    const panel = await openPanel();
    await user.click(within(panel).getByRole("button", { name: "Изменить сроки" }));
    const last = within(panel).getByLabelText("Последний день");
    await user.clear(last);
    await user.type(last, "2026-12-02");
    expect(within(panel).getByText("Длительность: 3 раб. дня.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Показать последствия" }));
    const inline = await within(panel).findByRole("region", { name: "Последствия изменения сроков" });
    expect(calls.find((c) => c.url.endsWith("/schedule/preview"))?.body).toMatchObject({
      changes: [{ task_id: "t5", start_date: "2026-11-30", end_exclusive: "2026-12-03" }],
    });
    await user.click(await within(inline).findByRole("button", { name: "Применить" }));
    expect(await screen.findByText(/Сроки применены/)).toBeInTheDocument();
  });

  it("read-only: no write controls, and the private history is not requested", async () => {
    const calls = mockApi(routes([], projectRoutes({ caps: READ_ONLY, proj: project({ my_role: "read_only" }) })));
    const panel = await openPanel();
    expect(within(panel).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(panel).queryByRole("button", { name: /Убрать зависимость/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Изменить сроки" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /в архив/i })).not.toBeInTheDocument();
    expect(within(panel).getByText("История изменений не показывается в режиме только для просмотра.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/activity"))).toBe(false);
  });

  it("archives with a confirmation (subtasks with it) and closes the panel", async () => {
    const user = userEvent.setup();
    const calls = mockApi([
      { method: "DELETE", path: "/api/tasks/t1?expected_version=1&cascade=true", body: { archived: [tasks[0], tasks[1], tasks[2]], removed_dependency_ids: [], plan_revision: 8 } },
      { path: "/api/tasks/t1/dependencies", body: { task_id: "t1", plan_revision: 7, predecessors: [], successors: [] } },
      ...projectRoutes(),
    ]);
    renderRoutes("/projects/ARIS?view=list&task=ARIS-1", ROUTES);
    const panel = await screen.findByRole("complementary", { name: "ARIS-1: Анализ источника" });
    await user.click(within(panel).getByRole("button", { name: "Отправить в архив…" }));
    expect(within(panel).getByText(/вместе с подзадачами \(1\)/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "В архив" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("task="));
  });

  it("the task page /tasks/:key shows the same detail with the title as the H1", async () => {
    // The page reads the task by its key, then the project's snapshot by the project id.
    mockApi(routes([{ path: "/api/tasks/ARIS-5", body: tasks[4] }, { path: "/api/projects/p1", body: project() }, { path: "/api/projects/p1/gantt", body: gantt() }]));
    renderRoutes("/tasks/ARIS-5", ROUTES);
    expect(await screen.findByRole("heading", { level: 1, name: /Загрузчик/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "На диаграмме Ганта" })).toHaveAttribute("href", "/projects/ARIS?view=gantt&task=ARIS-5");
    // Dependencies arrive after the task (their own request).
    expect(await screen.findByRole("link", { name: "ARIS-4 Маппинг метаданных" })).toHaveAttribute("href", "/tasks/ARIS-4");
  });
});
