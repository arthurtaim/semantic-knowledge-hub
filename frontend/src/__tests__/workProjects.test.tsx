import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "../pages/ProjectsPage";
import { mockApi, renderRoutes } from "./helpers";
import { capabilities, project, READ_ONLY } from "./workFixtures";

/* M6 «Проекты»: the overview reads every number from the API and starts from the work mode. */

afterEach(() => vi.restoreAllMocks());

const LIST = {
  items: [
    project(),
    project({
      id: "p2",
      key: "DQI",
      title: "Dataset Quality Initiative (демо)",
      stats: {
        total: 10,
        by_status: { todo: 6, in_progress: 1, review: 1, done: 2 },
        open: 8,
        blocked: 5,
        overdue: 0,
        milestones: 1,
        unscheduled: 2,
        next_milestone: null,
      },
    }),
  ],
  total: 2,
};

describe("Projects overview", () => {
  it("M6-01: shows each project with progress, dates, overdue, unscheduled and the next milestone from the API", async () => {
    mockApi([
      { path: "/api/work/capabilities", body: capabilities() },
      { path: "/api/projects", body: LIST },
    ]);
    renderRoutes("/projects", { "/projects": <ProjectsPage /> });
    const card = (await screen.findByRole("heading", { name: "ARIS Metadata Integration (демо)" })).closest("article") as HTMLElement;
    expect(within(card).getByRole("progressbar", { name: "Готово задач в ARIS" })).toHaveAttribute("aria-valuetext", "5 из 14");
    expect(within(card).getByText("Готово 5 из 14")).toBeInTheDocument();
    expect(within(card).getByText("2 нояб. 2026 – 10 дек. 2026")).toBeInTheDocument();
    const stats = within(card).getByText("Просрочено").closest("div") as HTMLElement;
    expect(stats).toHaveTextContent("1");
    expect(stats).toHaveClass("is-alert");
    expect(within(card).getByRole("link", { name: "Маппинг согласован" })).toHaveAttribute("href", "/projects/ARIS?view=gantt&task=ARIS-10");
    const dqi = screen.getByRole("heading", { name: "Dataset Quality Initiative (демо)" }).closest("article") as HTMLElement;
    expect(within(dqi).getByText("Без дат").closest("div")).toHaveTextContent("2");
    expect(within(dqi).getByText("Все вехи пройдены")).toBeInTheDocument();
    // The mode is said as the server says it; no team is claimed.
    expect(screen.getByText("Локальная демонстрация — один оператор")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать проект" })).toBeInTheDocument();
  });

  it("M6-20/M6-35: read-only mode shows the reason and no write control at all", async () => {
    mockApi([
      { path: "/api/work/capabilities", body: READ_ONLY },
      { path: "/api/projects", body: LIST },
    ]);
    renderRoutes("/projects", { "/projects": <ProjectsPage /> });
    await screen.findByRole("heading", { name: "ARIS Metadata Integration (демо)" });
    expect(screen.getByText("Только просмотр — изменения задач отключены")).toBeInTheDocument();
    expect(screen.getByText(/WORK_PUBLIC_EXPOSURE=true/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Создать проект" })).not.toBeInTheDocument();
  });

  it("says the module is off instead of showing an empty list (TASK_SYSTEM=disabled)", async () => {
    const calls = mockApi([{ path: "/api/work/capabilities", body: capabilities({ enabled: false, mode: "disabled", can_write: false, label: "Модуль задач отключён" }) }]);
    renderRoutes("/projects", { "/projects": <ProjectsPage /> });
    expect(await screen.findByText("Модуль задач отключён", { selector: ".feedback__title" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/projects"))).toBe(false);
  });

  it("creates a project with an idempotency key and opens it", async () => {
    const user = userEvent.setup();
    const calls = mockApi([
      { path: "/api/work/capabilities", body: capabilities() },
      { path: "/api/projects", body: { items: [], total: 0 } },
      { method: "POST", path: "/api/projects", status: 201, body: project({ id: "p9", key: "NEW", title: "Новый проект" }) },
    ]);
    renderRoutes("/projects", { "/projects": <ProjectsPage />, "/projects/:key": <p>Страница проекта</p> });
    expect(await screen.findByText("Проектов пока нет")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Создать проект" }));
    const dialog = screen.getByRole("dialog", { name: "Новый проект" });
    await user.type(within(dialog).getByLabelText(/Ключ/), "new1");
    expect(within(dialog).getByLabelText(/Ключ/)).toHaveValue("NEW1");
    await user.type(within(dialog).getByLabelText(/Название/), "Новый проект");
    await user.click(within(dialog).getByRole("button", { name: "Создать проект" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects/NEW"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ key: "NEW1", title: "Новый проект" });
    expect((post?.body as { client_request_id: string }).client_request_id).toMatch(/^[A-Za-z0-9-]{8,}$/);
  });
});
