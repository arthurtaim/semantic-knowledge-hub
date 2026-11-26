import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStatus, WorkTask } from "../api/types";
import { BOARD_WINDOW } from "../components/work/TaskBoard";
import { ProjectPage } from "../pages/ProjectPage";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";
import { gantt, projectRoutes, stubPointerAndFrames, task } from "./workFixtures";

/*
 * Remediation B2 (audit SYS-010): a long Board column renders a window of its cards — 1000 cards were 46 000 DOM
 * nodes and a 350 ms task — and grows on «Показать ещё» or when its end comes into view. Every count, the search,
 * the drag, the menu and Alt + ← / → work as before, also for a card outside the window.
 */

const ROUTES = { "/projects/:key": <ProjectPage /> };

/** ARIS-1 … ARIS-60 «В работе», ARIS-61 … ARIS-160 «К работе» (ARIS-95 has a title of its own). */
function bigPlan(): WorkTask[] {
  return Array.from({ length: 160 }, (_, i) => {
    const n = i + 1;
    const status: TaskStatus = n <= 60 ? "in_progress" : "todo";
    return task({ key: `ARIS-${n}`, title: n === 95 ? "Редкая проверка" : `Карточка ${n}`, status });
  });
}

function column(status: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.board__column[data-status="${status}"]`) as HTMLElement;
}

function cardsIn(status: string): string[] {
  return Array.from(column(status).querySelectorAll<HTMLElement>(".board-card")).map((c) => c.dataset.taskKey ?? "");
}

function card(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.board-card[data-task-key="${key}"]`);
  if (!element) throw new Error(`no card ${key}`);
  return element;
}

/** A server that keeps its state: each PATCH changes a task, the quiet re-read returns the new snapshot. */
function server(initial: WorkTask[]): MockRoute[] {
  let tasks = initial;
  const patch = (id: string): MockRoute => ({
    method: "PATCH",
    path: `/api/tasks/${id}`,
    respond: (init) => {
      const changes = JSON.parse(String(init?.body ?? "{}")) as Partial<WorkTask> & { expected_version?: number };
      delete changes.expected_version;
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...changes, version: t.version + 1 } : t));
      return new Response(JSON.stringify(tasks.find((t) => t.id === id)), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return [...initial.map((t) => patch(t.id)), ...projectRoutes({ snapshot: () => gantt(tasks, { dependencies: [] }) })];
}

beforeEach(() => stubPointerAndFrames(vi.stubGlobal));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Board window (B2)", () => {
  it("a long column renders its first cards; the count is the whole column; list positions are announced", async () => {
    mockApi(projectRoutes({ snapshot: gantt(bigPlan(), { dependencies: [] }) }));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    expect(cardsIn("todo")).toHaveLength(BOARD_WINDOW);
    expect(cardsIn("todo")[0]).toBe("ARIS-61");
    expect(within(column("todo")).getByLabelText("задач: 100")).toBeInTheDocument();
    expect(cardsIn("in_progress")).toHaveLength(BOARD_WINDOW);
    expect(within(column("in_progress")).getByLabelText("задач: 60")).toBeInTheDocument();
    const first = card("ARIS-61").closest("li") as HTMLElement;
    expect(first).toHaveAttribute("aria-setsize", "100");
    expect(first).toHaveAttribute("aria-posinset", "1");
    expect(within(column("review")).queryByRole("button", { name: /Показать ещё/ })).not.toBeInTheDocument();
    expect(BOARD_WINDOW * 4).toBeLessThan(1000);
  });

  it("«Показать ещё» adds the next cards and moves focus to the first new one", async () => {
    const user = userEvent.setup();
    mockApi(projectRoutes({ snapshot: gantt(bigPlan(), { dependencies: [] }) }));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    const more = within(column("todo")).getByRole("button", { name: /Показать ещё/ });
    expect(more).toHaveAccessibleName(/К работе/);
    await user.click(more);
    expect(cardsIn("todo")).toHaveLength(Math.min(100, BOARD_WINDOW * 2));
    const firstNew = `ARIS-${61 + BOARD_WINDOW}`;
    expect(document.activeElement).toBe(within(card(firstNew)).getByRole("link"));
    while (within(column("todo")).queryByRole("button", { name: /Показать ещё/ })) {
      await user.click(within(column("todo")).getByRole("button", { name: /Показать ещё/ }));
    }
    expect(cardsIn("todo")).toHaveLength(100);
  });

  it("the window grows by itself when the end of the column comes into view", async () => {
    let callback: IntersectionObserverCallback | null = null;
    const observed: Element[] = [];
    class FakeObserver {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {
        observed.length = 0;
      }
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    mockApi(projectRoutes({ snapshot: gantt(bigPlan(), { dependencies: [] }) }));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    const sentinel = observed.find((e) => (e as HTMLElement).dataset.status === "todo");
    expect(sentinel).toBeDefined();
    act(() => {
      callback?.([{ isIntersecting: true, target: sentinel } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(cardsIn("todo")).toHaveLength(Math.min(100, BOARD_WINDOW * 2));
    expect(cardsIn("in_progress")).toHaveLength(BOARD_WINDOW); // only the column whose end came into view
  });

  it("Alt + → into a column whose window ends earlier still shows the card there, and focus follows it", async () => {
    const user = userEvent.setup();
    const calls = mockApi(server(bigPlan()));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    // ARIS-61 goes after the 60 cards of «В работе» — beyond its window.
    within(card("ARIS-61")).getByRole("link").focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expected_version: 1, status: "in_progress" }));
    await waitFor(() => expect(card("ARIS-61").closest(".board__column")).toBe(column("in_progress")));
    await waitFor(() => expect(document.activeElement).toBe(within(card("ARIS-61")).getByRole("link")));
    expect(within(column("in_progress")).getByLabelText("задач: 61")).toBeInTheDocument();
    expect(within(column("todo")).getByLabelText("задач: 99")).toBeInTheDocument();
  });

  it("the card menu moves a card that is beyond the first window once it is shown", async () => {
    const user = userEvent.setup();
    const calls = mockApi(server(bigPlan()));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    await user.click(within(column("todo")).getByRole("button", { name: /Показать ещё/ }));
    const key = `ARIS-${61 + BOARD_WINDOW + 1}`;
    await user.click(within(card(key)).getByRole("button", { name: `Сменить статус ${key}` }));
    await user.click(screen.getByRole("menuitemradio", { name: "На проверке" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.url).toBe(`/api/tasks/t${61 + BOARD_WINDOW + 1}`));
    await waitFor(() => expect(cardsIn("review")).toEqual([key]));
  });

  it("dragging a card of a grown window saves its status", async () => {
    const calls = mockApi(server(bigPlan()));
    renderRoutes("/projects/ARIS?view=board", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    fireEvent.click(within(column("todo")).getByRole("button", { name: /Показать ещё/ }));
    const key = `ARIS-${61 + BOARD_WINDOW + 2}`;
    ["todo", "in_progress", "review", "done"].forEach((status, index) => {
      vi.spyOn(column(status), "getBoundingClientRect").mockReturnValue(new DOMRect(index * 300, 100, 290, 800));
    });
    const target = card(key);
    fireEvent.pointerDown(target, { clientX: 50, clientY: 150, button: 0, pointerId: 3 });
    for (let i = 1; i <= 5; i += 1) fireEvent.pointerMove(target, { clientX: 50 + (900 * i) / 5, clientY: 160, pointerId: 3 });
    fireEvent.pointerUp(target, { clientX: 950, clientY: 160, pointerId: 3 });
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expected_version: 1, status: "done" }));
    await waitFor(() => expect(cardsIn("done")).toEqual([key]));
  });

  it("the search filters every card of the column, not only the rendered ones", async () => {
    mockApi(projectRoutes({ snapshot: gantt(bigPlan(), { dependencies: [] }) }));
    renderRoutes("/projects/ARIS?view=board&q=Редкая", ROUTES);
    await screen.findByRole("heading", { name: /К работе/ });
    expect(cardsIn("todo")).toEqual(["ARIS-95"]);
    expect(within(column("todo")).getByLabelText("задач: 1")).toBeInTheDocument();
    expect(within(column("in_progress")).getByText("Нет задач по фильтрам")).toBeInTheDocument();
  });
});
