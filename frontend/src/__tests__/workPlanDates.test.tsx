import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkProposal } from "../api/types";
import { ProjectPage } from "../pages/ProjectPage";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";
import { capabilities, projectRoutes } from "./workFixtures";

/* Design 2026-11-27 §5.6: dates the person named in a task-plan request — a due date and a pinned period — are shown
 * in the review with their origin; the due date can be edited, the pin removed; the named plan start prefills the
 * start field. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROUTES = { "/projects/:key": <ProjectPage /> };
const AI_ON = capabilities({ features: { critical_path: false, comments: false, document_links: true, ai_proposals: true, lag: false } });
const ID = "WAP-00000000000000aa";

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
    request: "Загрузка с 1 по 4 декабря, срок до 5 декабря, старт плана с 1 декабря",
    goal: "Загрузка",
    start_date: "2026-12-01",
    suggested_start: "2026-12-01",
    parent_task_id: null,
    parent_task_key: null,
    base_plan_revision: 7,
    current_plan_revision: 7,
    created_at: "2026-11-27T10:00:00Z",
    expires_at: "2026-11-28T10:00:00Z",
    decided_at: null,
    tasks: [
      {
        local_id: "t1",
        title: "Загрузить данные",
        description: "",
        priority: "medium",
        estimate_workdays: 4,
        is_milestone: false,
        parent_local_id: null,
        assignee_id: null,
        sources: [],
        duplicate_of: null,
        start_date: "2026-12-01",
        end_exclusive: "2026-12-05",
        last_day: "2026-12-04",
        included: true,
        due_date: "2026-12-05",
        fixed_start: "2026-12-01",
        fixed_end: "2026-12-04",
      },
    ],
    dependencies: [],
    sources: [],
    assumptions: [],
    issues: [],
    can_apply: true,
    applied_task_keys: [],
    ...overrides,
  };
}

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: "/api/projects/p1/documents", body: { project_id: "p1", knowledge_available: true, items: [] } },
    ...projectRoutes({ caps: AI_ON }),
  ];
}

describe("dates from the request in the task-plan review", () => {
  it("shows the due date and the pin with their origin; edits the due date and removes the pin", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        { path: `/api/work-ai/proposals/${ID}`, body: proposal() },
        { method: "POST", path: `/api/work-ai/proposals/${ID}/preview`, body: proposal() },
        {
          method: "POST",
          path: `/api/work-ai/proposals/${ID}/apply`,
          body: { proposal_id: ID, project_id: "p1", applied: true, plan_revision: 8, created_tasks: [], created_dependencies: 0, created_links: 0, replayed: false },
        },
      ]),
    );
    renderRoutes(`/projects/ARIS?view=list&proposal=${ID}`, ROUTES);
    const sheet = await screen.findByRole("dialog", { name: "Предложение AI: план задач" });
    const due = (await within(sheet).findByLabelText("Срок")) as HTMLInputElement;
    expect(due.value).toBe("2026-12-05");
    expect(within(sheet).getByText(/Даты закреплены \(из вашего запроса\)/)).toBeInTheDocument();
    expect((within(sheet).getByLabelText("Плановое начало") as HTMLInputElement).value).toBe("2026-12-01");
    expect(within(sheet).getAllByText("из вашего запроса").length).toBeGreaterThanOrEqual(2);
    await user.clear(due);
    await user.type(due, "2026-12-10");
    await user.click(within(sheet).getByRole("button", { name: "Снять закрепление" }));
    expect(within(sheet).getByText(/Закрепление снято/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Пересчитать сроки" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/preview"))).toBe(true));
    await user.click(within(sheet).getByRole("button", { name: "Создать задачи (1)" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith("/apply"))!.body as Record<string, unknown>;
    expect(sent.tasks).toEqual([{ local_id: "t1", due_date: "2026-12-10", unpin_dates: true }]);
  });

  it("a plan without named dates shows no due date origin and no pin", async () => {
    const plain = proposal({
      suggested_start: null,
      tasks: [{ ...proposal().tasks[0]!, due_date: null, fixed_start: null, fixed_end: null }],
    });
    mockApi(routes([{ path: `/api/work-ai/proposals/${ID}`, body: plain }]));
    renderRoutes(`/projects/ARIS?view=list&proposal=${ID}`, ROUTES);
    const sheet = await screen.findByRole("dialog", { name: "Предложение AI: план задач" });
    expect(((await within(sheet).findByLabelText("Срок")) as HTMLInputElement).value).toBe("");
    expect(within(sheet).queryByText(/Даты закреплены/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText("из вашего запроса")).not.toBeInTheDocument();
  });
});
