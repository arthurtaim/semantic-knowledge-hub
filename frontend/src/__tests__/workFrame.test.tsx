import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoPill } from "../components/HeaderStatus";
import { PageToolbar, ToolbarSlotsContext } from "../components/shell/PageToolbar";
import { overdueText, projectDates, projectSummary } from "../components/work/ProjectStrip";
import { workModeText } from "../components/work/WorkBits";
import { SessionContext } from "../lib/session";
import { ProjectPage } from "../pages/ProjectPage";
import { session } from "./fixtures";
import { mockApi, mockViewport, renderRoutes } from "./helpers";
import { capabilities, planTasks, project, projectRoutes, READ_ONLY, TODAY } from "./workFixtures";

/*
 * Planner v2, the project page frame (docs/ui-v2/planner/specs/PLANNER_V2.md §2): one project line with numbers
 * from the loaded data, the work mode as the «Демо-данные» tooltip while writes are allowed and a visible line when
 * they are not, one filter row with «Ещё» and chips, and the narrower layouts.
 */

const ROUTES = { "/projects/:key": <ProjectPage /> };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the project line", () => {
  it("shows status, dates, «Готово N из M», overdue, the next milestone and the plan revision from the loaded project", async () => {
    mockApi(projectRoutes());
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    const strip = await screen.findByRole("group", { name: "Сводка проекта" });
    expect(screen.getByRole("heading", { level: 1, name: "ARIS Metadata Integration (демо)" })).toBeInTheDocument();
    expect(within(strip).getByText("Активный")).toBeInTheDocument();
    expect(within(strip).getByText("2 нояб. – 10 дек. 2026")).toBeInTheDocument();
    expect(within(strip).getByText("Готово 5 из 14")).toBeInTheDocument();
    expect(within(strip).getByRole("link", { name: "Маппинг согласован" })).toHaveAttribute("href", "/projects/ARIS?view=list&task=ARIS-10");
    expect(within(strip).getByText(/27 нояб\./)).toBeInTheDocument();
    expect(within(strip).getByTestId("plan-revision")).toHaveTextContent("Ревизия плана 7");
    // «1 просрочена» switches the «Просроченные» filter, both ways
    const overdue = within(strip).getByRole("button", { name: "1 просрочена" });
    expect(overdue).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(overdue);
    expect(screen.getByTestId("location")).toHaveTextContent("overdue=1");
    expect(within(strip).getByRole("button", { name: "1 просрочена" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Убрать фильтр «Просроченные»" })).toBeInTheDocument();
  });

  it("counts from the snapshot when the project has no stats; plural forms and open dates", () => {
    const summary = projectSummary({ stats: null }, planTasks(), TODAY);
    expect(summary).toEqual({ done: 3, total: 9, overdue: 1, nextMilestone: { key: "ARIS-6", title: "Готовность к пилоту", date: "2026-12-02" } });
    expect([1, 2, 5, 11, 21, 22].map(overdueText)).toEqual(["1 просрочена", "2 просрочены", "5 просрочено", "11 просрочено", "21 просрочена", "22 просрочены"]);
    expect(projectDates({ start_date: "2026-11-02", target_date: "2026-12-10" })).toBe("2 нояб. – 10 дек. 2026");
    expect(projectDates({ start_date: "2026-12-20", target_date: "2027-01-15" })).toBe("20 дек. 2026 – 15 янв. 2027");
    expect(projectDates({ start_date: null, target_date: null })).toBe("Сроки не заданы");
  });

  it("below 1100 px keeps status, dates and progress; the rest is behind «⋯»; a phone keeps status and progress", async () => {
    const user = userEvent.setup();
    mockViewport(1000);
    mockApi(projectRoutes());
    const { unmount } = renderRoutes("/projects/ARIS?view=list", ROUTES);
    const strip = await screen.findByRole("group", { name: "Сводка проекта" });
    expect(within(strip).getByText("2 нояб. – 10 дек. 2026")).toBeVisible();
    expect(within(strip).queryByRole("button", { name: "1 просрочена" })).not.toBeInTheDocument(); // hidden in «⋯» while closed
    await user.click(within(strip).getByRole("button", { name: "Ещё о проекте" }));
    expect(within(strip).getByRole("button", { name: "1 просрочена" })).toBeVisible();
    expect(within(strip).getByTestId("plan-revision")).toHaveTextContent("Ревизия плана 7");
    unmount();
    mockViewport(390);
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    const phone = await screen.findByRole("group", { name: "Сводка проекта" });
    expect(within(phone).getByText("Готово 5 из 14")).toBeInTheDocument();
    expect(within(phone).getByText("2 нояб. – 10 дек. 2026")).not.toBeVisible(); // behind «⋯»
  });
});

describe("the work mode", () => {
  it("while writes are allowed it is not a banner: the page gives it to «Демо-данные» as a note", async () => {
    const setDemoNote = vi.fn();
    mockApi(projectRoutes());
    render(
      <ToolbarSlotsContext.Provider value={{ lead: null, actions: null, register: () => () => {}, setDemoNote }}>
        <PageToolbar title="Проект" demoNote={workModeText(capabilities())} />
      </ToolbarSlotsContext.Provider>,
    );
    expect(setDemoNote).toHaveBeenLastCalledWith(
      "Локальная демонстрация — один оператор. Исполнители «(демо)» — вымышленная команда для примера, не учётные записи.",
    );
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("group", { name: "Сводка проекта" });
    expect(screen.queryByText("Локальная демонстрация — один оператор")).not.toBeInTheDocument();
  });

  it("«Демо-данные» shows the note as its tooltip and description", async () => {
    const user = userEvent.setup();
    render(
      <SessionContext.Provider value={session}>
        <MemoryRouter>
          <DemoPill note="Локальная демонстрация — один оператор." />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    const pill = screen.getByRole("button", { name: "Демо-данные" });
    expect(pill).toHaveAccessibleDescription("Локальная демонстрация — один оператор.");
    await user.hover(pill);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Локальная демонстрация — один оператор.");
  });

  it("when writes are off it stays a visible line with a lock and the reason", async () => {
    mockApi(projectRoutes({ caps: READ_ONLY, proj: project({ my_role: "read_only" }) }));
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    const line = (await screen.findByText("Только просмотр — изменения задач отключены")).closest(".work-mode") as HTMLElement;
    expect(line).toBeVisible();
    expect(line.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(line).toHaveTextContent(/WORK_PUBLIC_EXPOSURE=true/);
  });
});

describe("the filter row", () => {
  it("«Ещё» holds priority, overdue and milestones; each chosen one is a chip with a remove button", async () => {
    const user = userEvent.setup();
    mockApi(projectRoutes());
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByRole("table");
    expect(screen.getByText("9 задач")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ещё" }));
    const menu = screen.getByRole("menu", { name: "Ещё фильтры" });
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Высокий" }));
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Критичный" }));
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("location")).toHaveTextContent("priority=high%2Ccritical");
    expect(screen.getByText("Приоритет: Высокий, Критичный")).toBeInTheDocument();
    expect(screen.getByText("Найдено: 2 из 9")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Убрать фильтр «Приоритет: Высокий, Критичный»" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("priority=");
    expect(screen.getByText("9 задач")).toBeInTheDocument();
  });
});
