import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "../pages/ProjectPage";
import { mockApi, renderRoutes } from "./helpers";
import { gantt, planTasks, project, projectRoutes, READ_ONLY, stubPointerAndFrames } from "./workFixtures";

/* M6 «Доска»: columns by status; drag-and-drop, the menu and Alt + arrows save the status; errors roll back. */

const ROUTES = { "/projects/:key": <ProjectPage /> };
const COLUMNS = ["todo", "in_progress", "review", "done"] as const;

beforeEach(() => stubPointerAndFrames(vi.stubGlobal));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function card(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.board-card[data-task-key="${key}"]`);
  if (!element) throw new Error(`no card ${key}`);
  return element;
}

function column(status: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.board__column[data-status="${status}"]`) as HTMLElement;
}

/** Lays the four columns out side by side, 300 px each (jsdom has no layout). */
function layColumns() {
  COLUMNS.forEach((status, index) => {
    vi.spyOn(column(status), "getBoundingClientRect").mockReturnValue(new DOMRect(index * 300, 100, 290, 800));
  });
}

function dragCard(key: string, toX: number, finish: "up" | "cancel" = "up") {
  const target = card(key);
  fireEvent.pointerDown(target, { clientX: 50, clientY: 150, button: 0, pointerId: 5 });
  for (let i = 1; i <= 5; i += 1) fireEvent.pointerMove(target, { clientX: 50 + ((toX - 50) * i) / 5, clientY: 160, pointerId: 5 });
  if (finish === "up") fireEvent.pointerUp(target, { clientX: toX, clientY: 160, pointerId: 5 });
  else fireEvent.pointerCancel(target, { pointerId: 5 });
}

describe("Board", () => {
  it("shows a column per status with counts, overdue / blocked / milestone marks on cards", async () => {
    mockApi(projectRoutes());
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    expect(within(column("todo")).getByLabelText("задач: 4")).toBeInTheDocument();
    expect(within(column("done")).getByLabelText("задач: 3")).toBeInTheDocument();
    expect(within(card("ARIS-9")).getByText(/Просрочена:/)).toBeInTheDocument();
    expect(within(card("ARIS-5")).getByText("Ждёт ARIS-4")).toBeInTheDocument();
    expect(within(card("ARIS-6")).getByRole("img", { name: "Веха" })).toBeInTheDocument();
  });

  it("M6-02: dragging a card to «В работе» saves the status through PATCH with the version; the list sees it", async () => {
    const user = userEvent.setup();
    const tasks = planTasks();
    let saved = false;
    const calls = mockApi([
      {
        method: "PATCH",
        path: "/api/tasks/t7",
        body: () => {
          saved = true;
          return { ...tasks[6]!, status: "in_progress", version: 2 };
        },
      },
      ...projectRoutes({ snapshot: () => gantt(saved ? tasks.map((t) => (t.id === "t7" ? { ...t, status: "in_progress" as const, version: 2 } : t)) : tasks) }),
    ]);
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    layColumns();
    dragCard("ARIS-7", 350);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expected_version: 1, status: "in_progress" }));
    await waitFor(() => expect(within(column("in_progress")).getByText("Документация без дат")).toBeInTheDocument());
    expect(card("ARIS-7").style.transform).toBe("");
    // The click that ends a drag does not open the task.
    expect(screen.getByTestId("location")).not.toHaveTextContent("task=");
    // Same data in the list (M6-36).
    await user.click(screen.getByRole("button", { name: "Список" }));
    expect(screen.getByRole("button", { name: "Статус ARIS-7 Документация без дат: В работе" })).toBeInTheDocument();
  });

  it("a drag released over the same column or cancelled changes nothing", async () => {
    const calls = mockApi(projectRoutes());
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    layColumns();
    dragCard("ARIS-7", 120);
    dragCard("ARIS-7", 950, "cancel");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(within(column("todo")).getByText("Документация без дат")).toBeInTheDocument();
  });

  it("rolls the card back and says why when the server refuses the move", async () => {
    mockApi([
      { method: "PATCH", path: "/api/tasks/t7", status: 403, body: { code: "forbidden", message: "Изменения задач недоступны.", request_id: "r", details: {} } },
      ...projectRoutes(),
    ]);
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    layColumns();
    dragCard("ARIS-7", 950);
    expect(await screen.findByText(/ARIS-7 не перенесена в «Готово»: Изменения задач недоступны\. Карточка возвращена\./)).toBeInTheDocument();
    expect(within(column("todo")).getByText("Документация без дат")).toBeInTheDocument();
  });

  it("WCAG 2.5.7: Alt + → on a focused card and the card's menu move it without dragging; focus follows", async () => {
    const user = userEvent.setup();
    // The server's state: every PATCH changes it, and the quiet re-read returns it.
    let tasks = planTasks();
    const patch = (id: string, status: "in_progress" | "done") => () => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status, version: t.version + 1 } : t));
      return tasks.find((t) => t.id === id);
    };
    const calls = mockApi([
      { method: "PATCH", path: "/api/tasks/t7", body: patch("t7", "in_progress") },
      { method: "PATCH", path: "/api/tasks/t5", body: patch("t5", "done") },
      ...projectRoutes({ snapshot: () => gantt(tasks) }),
    ]);
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    const title = within(card("ARIS-7")).getByRole("link", { name: "Документация без дат" });
    title.focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await waitFor(() => expect(calls.find((c) => c.url === "/api/tasks/t7")?.body).toEqual({ expected_version: 1, status: "in_progress" }));
    await waitFor(() => expect(document.activeElement).toBe(within(card("ARIS-7")).getByRole("link", { name: "Документация без дат" })));
    expect(card("ARIS-7").closest(".board__column")).toBe(column("in_progress"));
    await user.click(within(card("ARIS-5")).getByRole("button", { name: "Сменить статус ARIS-5" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Готово" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/tasks/t5")?.body).toEqual({ expected_version: 1, status: "done" }));
  });

  it("read-only: no drag, no menus, no keyboard moves", async () => {
    const user = userEvent.setup();
    const calls = mockApi(projectRoutes({ caps: READ_ONLY, proj: project({ my_role: "read_only" }) }));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    expect(screen.queryByRole("button", { name: /Сменить статус/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Перетащите карточку/)).not.toBeInTheDocument();
    layColumns();
    dragCard("ARIS-7", 950);
    within(card("ARIS-7")).getByRole("link").focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await act(async () => Promise.resolve());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
