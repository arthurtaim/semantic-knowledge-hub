import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkProposal } from "../api/types";
import { ProjectPage } from "../pages/ProjectPage";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";
import { capabilities, projectRoutes, READ_ONLY } from "./workFixtures";

/* M6 Step 5: «AI план» — the entry only with a planning-capable provider and write rights, the request, the review of
 * the typed proposal (sources, issues, edits, server dates), apply / reject, a stale proposal. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROUTES = { "/projects/:key": <ProjectPage /> };
const FEATURES = { critical_path: false, comments: false, document_links: true, ai_proposals: true, lag: false };
const AI_ON = capabilities({ features: FEATURES });
const ID = "WAP-0123456789abcdef";

function proposal(overrides: Partial<WorkProposal> = {}): WorkProposal {
  return {
    id: ID,
    project_id: "p1",
    project_key: "ARIS",
    kind: "task_plan",
    schema_version: "work_plan.v1",
    status: "suggested",
    state: "ready",
    stale_reasons: [],
    provider: "internal_api",
    request: "Подготовь задачи по маппингу",
    goal: "Маппинг полей",
    start_date: "2026-11-27",
    parent_task_id: null,
    parent_task_key: null,
    base_plan_revision: 7,
    current_plan_revision: 7,
    created_at: "2026-11-25T10:00:00Z",
    expires_at: "2026-11-26T10:00:00Z",
    decided_at: null,
    tasks: [
      {
        local_id: "t1",
        title: "Разобрать маппинг полей",
        description: "Выписать требования.",
        priority: "high",
        estimate_workdays: 2,
        is_milestone: false,
        parent_local_id: null,
        assignee_id: null,
        sources: [{ document_id: "DEMO-INT-002", revision: "sha256:aa", quote: "Маппинг полей ARIS на каталог", verified: true, title: "ARIS → Catalog", status: "approved", state: "current" }],
        duplicate_of: null,
        start_date: "2026-11-27",
        end_exclusive: "2026-12-01",
        last_day: "2026-11-30",
        included: true,
      },
      {
        local_id: "t2",
        title: "Реализовать загрузку",
        description: "",
        priority: "medium",
        estimate_workdays: 3,
        is_milestone: false,
        parent_local_id: null,
        assignee_id: null,
        sources: [],
        duplicate_of: "ARIS-11",
        start_date: "2026-12-01",
        end_exclusive: "2026-12-04",
        last_day: "2026-12-03",
        included: true,
      },
      {
        local_id: "t3",
        title: "Готово",
        description: "",
        priority: "medium",
        estimate_workdays: 0,
        is_milestone: true,
        parent_local_id: null,
        assignee_id: null,
        sources: [],
        duplicate_of: null,
        start_date: "2026-12-04",
        end_exclusive: "2026-12-04",
        last_day: null,
        included: true,
      },
    ],
    dependencies: [
      { predecessor: "t1", successor: "t2", kind: "FS" },
      { predecessor: "t2", successor: "t3", kind: "FS" },
    ],
    sources: [
      { document_id: "DEMO-INT-002", revision: "sha256:aa", quote: null, verified: true, title: "ARIS → Catalog", status: "approved", state: "current" },
      { document_id: "SEM-INT-ARIS-001", revision: "sha256:bb", quote: null, verified: true, title: "ARIS discovery", status: "draft", state: "current" },
    ],
    assumptions: ["Исполнители не назначены — их выбирает человек."],
    issues: [
      { code: "assignee_ignored", message: "Модель указала исполнителя — отброшено: исполнителя выбирает человек.", local_id: "t1", severity: "warning" },
      { code: "no_sources", message: "Нет опоры в документах — это допущение модели, проверьте.", local_id: "t2", severity: "warning" },
    ],
    can_apply: true,
    applied_task_keys: [],
    ...overrides,
  };
}

function routes(extra: MockRoute[] = [], caps = AI_ON): MockRoute[] {
  return [
    ...extra,
    { path: "/api/projects/p1/documents", body: { project_id: "p1", knowledge_available: true, items: [] } },
    ...projectRoutes({ caps }),
  ];
}

describe("«AI план»", () => {
  it("is absent without a planning-capable AI provider and in read-only mode", async () => {
    mockApi(routes([], capabilities({ features: { ...FEATURES, ai_proposals: false } })));
    const { unmount } = renderRoutes("/projects/ARIS?view=list", ROUTES);
    expect(await screen.findByRole("button", { name: "Задача" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI план" })).not.toBeInTheDocument();
    unmount();
    vi.restoreAllMocks();
    mockApi(routes([], { ...READ_ONLY, features: FEATURES }));
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await screen.findByText(/Только просмотр/);
    expect(screen.queryByRole("button", { name: "AI план" })).not.toBeInTheDocument();
  });

  it("sends the request with the chosen documents and start, then opens the review in the URL", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        { path: /^\/api\/links\/suggest\?q=DEMO/, body: [{ document_id: "DEMO-INT-002", title: "ARIS → Catalog", status: "approved", type: "integration", matched: "id", alias: null, insert: "" }] },
        { method: "POST", path: "/api/work-ai/proposals", status: 201, body: proposal() },
        { path: `/api/work-ai/proposals/${ID}`, body: proposal() },
      ]),
    );
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await user.click(await screen.findByRole("button", { name: "AI план" }));
    const sheet = screen.getByRole("dialog", { name: "AI план" });
    await user.type(within(sheet).getByLabelText(/Что нужно сделать/), "Подготовь задачи по маппингу");
    await user.type(within(sheet).getByLabelText("Документы-источники"), "DEMO");
    await user.click(await within(sheet).findByRole("button", { name: /DEMO-INT-002 ARIS → Catalog/ }));
    await user.type(within(sheet).getByLabelText("Плановое начало"), "2026-11-27");
    await user.click(within(sheet).getByRole("button", { name: "Подготовить предложение" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/work-ai/proposals")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.url === "/api/work-ai/proposals")!.body as Record<string, unknown>;
    expect(sent).toEqual({ project_id: "p1", request: "Подготовь задачи по маппингу", document_ids: ["DEMO-INT-002"], start_date: "2026-11-27" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain(`proposal=${ID}`));
    expect(await screen.findByText(/Ничего не создано, пока вы не нажмёте «Создать задачи»/)).toBeInTheDocument();
  });

  it("shows sources, issues and server dates; edits, drops and applies exactly what the person reviewed", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        { path: `/api/work-ai/proposals/${ID}`, body: proposal() },
        { method: "POST", path: `/api/work-ai/proposals/${ID}/preview`, body: proposal() },
        {
          method: "POST",
          path: `/api/work-ai/proposals/${ID}/apply`,
          body: { proposal_id: ID, project_id: "p1", applied: true, plan_revision: 8, created_tasks: [], created_dependencies: 1, created_links: 1, replayed: false },
        },
      ]),
    );
    renderRoutes(`/projects/ARIS?view=list&proposal=${ID}`, ROUTES);
    const sheet = await screen.findByRole("dialog", { name: "Предложение AI: план задач" });
    await within(sheet).findByText("Подготовь задачи по маппингу");
    expect(within(sheet).getByText(/Не утверждён \(черновик\)/)).toBeInTheDocument();
    expect(within(sheet).getByText(/исполнителя выбирает человек/)).toBeInTheDocument();
    expect(within(sheet).getByText("Похожая задача уже есть: ARIS-11.")).toBeInTheDocument();
    expect(within(sheet).getByText(/27 нояб\. – 30 нояб\./)).toBeInTheDocument();
    expect(within(sheet).getByText("Маппинг полей ARIS на каталог")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("checkbox", { name: "Создать задачу «Готово»" }));
    const title = within(sheet).getByRole("textbox", { name: "Название «Разобрать маппинг полей»" });
    await user.clear(title);
    await user.type(title, "Разобрать маппинг");
    await user.click(within(sheet).getByRole("checkbox", { name: "Реализовать загрузку → Готово" }));
    await user.click(within(sheet).getByRole("button", { name: "Пересчитать сроки" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/preview"))).toBe(true));
    await user.click(within(sheet).getByRole("button", { name: "Создать задачи (2)" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith("/apply"))!.body as Record<string, unknown>;
    expect(sent.expected_plan_revision).toBe(7);
    expect(typeof sent.client_request_id).toBe("string");
    expect(sent.excluded_dependencies).toEqual([{ predecessor: "t2", successor: "t3" }]);
    expect(sent.tasks).toEqual(expect.arrayContaining([{ local_id: "t3", include: false }, { local_id: "t1", title: "Разобрать маппинг" }]));
    expect(await screen.findByText(/создано задач по предложению AI — 0, зависимостей — 1, связей с документами — 1/)).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).not.toContain("proposal=");
  });

  it("a stale proposal cannot be applied and offers «Подготовить заново»", async () => {
    mockApi(routes([{ path: `/api/work-ai/proposals/${ID}`, body: proposal({ state: "stale", stale_reasons: ["source_changed", "plan_changed"], can_apply: false }) }]));
    renderRoutes(`/projects/ARIS?view=list&proposal=${ID}`, ROUTES);
    const sheet = await screen.findByRole("dialog", { name: "Предложение AI: план задач" });
    expect(await within(sheet).findByText(/документ-источник изменился; план проекта изменился после подготовки/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Создать задачи/ })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Подготовить заново" })).toBeInTheDocument();
  });

  it("reject closes the proposal without tasks; a refused plan says why and stores nothing", async () => {
    const user = userEvent.setup();
    mockApi(
      routes([
        { path: `/api/work-ai/proposals/${ID}`, body: proposal() },
        { method: "POST", path: `/api/work-ai/proposals/${ID}/reject`, body: proposal({ status: "rejected", state: "rejected", can_apply: false }) },
      ]),
    );
    renderRoutes(`/projects/ARIS?view=list&proposal=${ID}`, ROUTES);
    const sheet = await screen.findByRole("dialog", { name: "Предложение AI: план задач" });
    await user.click(await within(sheet).findByRole("button", { name: "Отклонить" }));
    expect(await within(sheet).findByText("Предложение отклонено: задачи не создавались.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Создать задачи/ })).not.toBeInTheDocument();
  });

  it("a plan the server refused (cycle) is explained and nothing is opened", async () => {
    const user = userEvent.setup();
    mockApi(
      routes([
        {
          method: "POST",
          path: "/api/work-ai/proposals",
          status: 422,
          body: { code: "proposal_invalid", message: "Зависимости в предложении образуют цикл: t1 → t2 → t1.", details: { reason: "dependency_cycle", cycle: ["t1", "t2", "t1"] }, request_id: "r" },
        },
      ]),
    );
    renderRoutes("/projects/ARIS?view=list", ROUTES);
    await user.click(await screen.findByRole("button", { name: "AI план" }));
    const sheet = screen.getByRole("dialog", { name: "AI план" });
    await user.type(within(sheet).getByLabelText(/Что нужно сделать/), "Сделай цикл");
    await user.click(within(sheet).getByRole("button", { name: "Подготовить предложение" }));
    expect(await within(sheet).findByText(/Сервер отклонил план модели/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Ничего не сохранено/)).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).not.toContain("proposal=");
  });
});
