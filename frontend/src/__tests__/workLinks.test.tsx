import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentTasks, ProjectDocuments, TaskLink, TaskLinks } from "../api/types";
import { DocumentTasksPanel } from "../components/work/DocumentTasks";
import { filtersFromParams, matchesFilters, EMPTY_FILTERS } from "../lib/work";
import { ProjectPage } from "../pages/ProjectPage";
import { TaskPage } from "../pages/TaskPage";
import { mockApi, renderRoutes, type MockRoute } from "./helpers";
import { capabilities, gantt, planTasks, projectRoutes, READ_ONLY, task } from "./workFixtures";

/* M6 Step 4: task ↔ document links in the task card, the document filter of the work views, the document's tasks. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROUTES = { "/projects/:key": <ProjectPage />, "/tasks/:key": <TaskPage /> };
const LINKS_ON = capabilities({ features: { critical_path: false, comments: false, document_links: true, ai_proposals: false, lag: false } });

function doc(id: string, title: string, status: "approved" | "draft" | "deprecated" | "in_review" = "approved", revision = "rev-new-0002") {
  return { document_id: id, title, type: "integration", status, version: "1.2", revision, is_demo: true, app_path: `/documents/${id}` };
}

function link(overrides: Partial<TaskLink> & { id: string }): TaskLink {
  return {
    task_id: "t5",
    relation: "implements",
    source_system: "skh",
    state: "current",
    document: doc("DEMO-INT-002", "ARIS → Catalog: маппинг полей (демо)", "approved", "rev-0001"),
    revision_at_link: "rev-0001",
    deprecated: false,
    approved: true,
    created_by: "local-demo-user",
    created_at: "2026-11-24T10:00:00Z",
    ...overrides,
  };
}

const LINKS: TaskLinks = {
  task_id: "t5",
  task_key: "ARIS-5",
  knowledge_available: true,
  generation: "g3",
  items: [
    link({ id: "l1" }),
    link({ id: "l2", relation: "requires", state: "revision_changed", document: doc("DEMO-INT-003", "ARIS: валидационные ограничения (демо)", "approved", "sha256:f6e5d4c3b2a1"), revision_at_link: "sha256:a1b2c3d4e5f6" }),
    link({ id: "l3", relation: "requires", document: doc("DEMO-INT-018", "Ночная полная выгрузка ARIS (устаревший поток)", "deprecated", "rev-x"), revision_at_link: "rev-x", deprecated: true, approved: false }),
    link({ id: "l4", state: "unavailable", document: null, revision_at_link: null, approved: false }),
  ],
};

function routes(extra: MockRoute[] = [], caps = LINKS_ON, links: TaskLinks = LINKS): MockRoute[] {
  return [
    ...extra,
    { path: "/api/tasks/t5/links", body: links },
    { path: "/api/projects/p1/documents", body: { project_id: "p1", knowledge_available: true, items: [] } satisfies ProjectDocuments },
    ...projectRoutes({ caps }),
  ];
}

async function openDocs() {
  renderRoutes("/projects/ARIS?view=list&task=ARIS-5", ROUTES);
  const panel = await screen.findByRole("complementary", { name: "ARIS-5: Загрузчик" });
  const section = (await within(panel).findByTestId("task-documents")) as HTMLElement;
  await within(section).findByRole("list", { name: "Документы задачи ARIS-5" });
  return section;
}

describe("Task documents", () => {
  it("shows every link as the current snapshot has it — changed, deprecated, unavailable without details", async () => {
    mockApi(routes());
    const section = await openDocs();
    expect(within(section).getByRole("link", { name: "DEMO-INT-002 ARIS → Catalog: маппинг полей (демо)" })).toHaveAttribute("href", "/documents/DEMO-INT-002");
    const changed = section.querySelector('[data-link-id="l2"]') as HTMLElement;
    expect(within(changed).getByText(/Документ изменён после связывания: ревизия a1b2c3d4 → f6e5d4c3/)).toBeInTheDocument();
    expect(within(changed).getByRole("button", { name: "Отметить DEMO-INT-003 как проверенный" })).toBeInTheDocument();
    const deprecated = section.querySelector('[data-link-id="l3"]') as HTMLElement;
    expect(within(deprecated).getByText(/устарел \(deprecated\)/)).toBeInTheDocument();
    const hidden = section.querySelector('[data-link-id="l4"]') as HTMLElement;
    expect(hidden).toHaveTextContent("Документ недоступен — удалён или нет доступа");
    expect(within(hidden).queryByRole("link")).not.toBeInTheDocument();
    expect(within(hidden).getByRole("button", { name: "Убрать связь с недоступным документом" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Связать с документом" })).toBeInTheDocument();
  });

  it("«Проверено» acknowledges the new revision and «Убрать» removes a link; both re-read the plan", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        { method: "POST", path: "/api/tasks/t5/links/l2/acknowledge", body: link({ id: "l2" }) },
        { method: "DELETE", path: "/api/tasks/t5/links/l4", body: { link_id: "l4", task_id: "t5" } },
      ]),
    );
    const section = await openDocs();
    const before = calls.filter((c) => c.url === "/api/projects/ARIS/gantt").length;
    await user.click(within(section).getByRole("button", { name: "Отметить DEMO-INT-003 как проверенный" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/acknowledge"))).toBe(true));
    expect(await screen.findByText(/отмечено как проверенное/)).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "Убрать связь с недоступным документом" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/tasks/t5/links/l4")).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/projects/ARIS/gantt").length).toBeGreaterThanOrEqual(before + 2));
  });

  it("links a document found by ID or title, with the chosen relation and one request id", async () => {
    const user = userEvent.setup();
    const calls = mockApi(
      routes([
        {
          path: /^\/api\/links\/suggest\?q=SEM/,
          body: [{ document_id: "SEM-ARCH-001", title: "Semantic Layer — demonstration architecture", status: "approved", type: "architecture", matched: "id", alias: null, insert: "[[SEM-ARCH-001]]" }],
        },
        { method: "POST", path: "/api/tasks/t5/links", status: 201, body: link({ id: "l9", document: doc("SEM-ARCH-001", "Semantic Layer"), relation: "verifies" }) },
      ]),
    );
    const section = await openDocs();
    await user.click(within(section).getByRole("button", { name: "Связать с документом" }));
    const form = within(section).getByRole("form", { name: "Связать с документом" });
    await user.type(within(form).getByLabelText("Документ"), "SEM");
    await user.click(await within(form).findByRole("button", { name: /SEM-ARCH-001 Semantic Layer/ }));
    await user.selectOptions(within(form).getByLabelText("Связь"), "verifies");
    await user.click(within(form).getByRole("button", { name: "Связать" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/tasks/t5/links")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.url === "/api/tasks/t5/links")!.body as Record<string, string>;
    expect(sent.document_id).toBe("SEM-ARCH-001");
    expect(sent.relation).toBe("verifies");
    expect(sent.client_request_id).toMatch(/^link-t5-/);
    expect(await screen.findByText("ARIS-5 связана с SEM-ARCH-001.")).toBeInTheDocument();
  });

  it("read-only: links are shown, nothing can be linked, acknowledged or removed", async () => {
    mockApi(routes([], { ...READ_ONLY, features: LINKS_ON.features }));
    const section = await openDocs();
    expect(within(section).queryByRole("button")).not.toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /DEMO-INT-002/ })).toBeInTheDocument();
  });

  it("an unreadable knowledge source is said out loud; no document facts and no linking", async () => {
    mockApi(routes([], LINKS_ON, { ...LINKS, knowledge_available: false, generation: null, items: [link({ id: "l1", state: "unverified", document: null, revision_at_link: null })] }));
    renderRoutes("/projects/ARIS?view=list&task=ARIS-5", ROUTES);
    const panel = await screen.findByRole("complementary", { name: "ARIS-5: Загрузчик" });
    const section = (await within(panel).findByTestId("task-documents")) as HTMLElement;
    expect(await within(section).findByText(/База знаний сейчас недоступна/)).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Связать с документом" })).not.toBeInTheDocument();
    expect(within(section).getByText("Не проверено: база знаний сейчас недоступна")).toBeInTheDocument();
  });
});

describe("Document filter of the work views", () => {
  it("one `doc` filter narrows List, Board and Gantt to the tasks linked to that document", async () => {
    const tasks = planTasks().map((t) => (t.key === "ARIS-4" || t.key === "ARIS-5" ? { ...t, document_ids: ["DEMO-INT-002"], link_count: 1 } : t));
    mockApi([
      {
        path: "/api/projects/p1/documents",
        body: { project_id: "p1", knowledge_available: true, items: [{ document: doc("DEMO-INT-002", "ARIS → Catalog: маппинг полей (демо)"), task_count: 2, changed_count: 0 }] } satisfies ProjectDocuments,
      },
      ...projectRoutes({ caps: LINKS_ON, snapshot: gantt(tasks) }),
    ]);
    renderRoutes("/projects/ARIS?view=board&doc=demo-int-002", ROUTES);
    await waitFor(() => expect(document.querySelectorAll(".board-card").length).toBeGreaterThan(0));
    const keys = Array.from(document.querySelectorAll(".board-card[data-task-key]")).map((n) => n.getAttribute("data-task-key"));
    expect(new Set(keys)).toEqual(new Set(["ARIS-4", "ARIS-5"]));
    expect(screen.getByRole("button", { name: /Документ: demo-int-002/ })).toBeInTheDocument();
    expect(screen.getByText(/Найдено: 2 из/)).toBeInTheDocument();
  });

  it("matches case-insensitively, ignores an invalid id and never matches hidden documents", () => {
    const linked = task({ key: "ARIS-1", document_ids: ["DEMO-INT-002"] });
    const unknown = task({ key: "ARIS-2", document_ids: null });
    const filters = { ...EMPTY_FILTERS, doc: "demo-int-002" };
    expect(matchesFilters(linked, filters)).toBe(true);
    expect(matchesFilters(unknown, filters)).toBe(false);
    expect(filtersFromParams(new URLSearchParams("doc=../x")).doc).toBe("");
    expect(filtersFromParams(new URLSearchParams("doc=SEM-ARCH-001")).doc).toBe("SEM-ARCH-001");
  });
});

describe("Document page: tasks of a document", () => {
  const DATA: DocumentTasks = {
    document_id: "DEMO-INT-002",
    revision: "rev-1",
    total: 2,
    items: [
      { link_id: "l1", relation: "implements", state: "current", revision_at_link: "rev-1", task_id: "t5", task_key: "ARIS-5", title: "Загрузчик", status: "in_progress", project_id: "p1", project_key: "ARIS", project_title: "ARIS Metadata Integration (демо)", app_path: "/tasks/ARIS-5" },
      { link_id: "l2", relation: "verifies", state: "revision_changed", revision_at_link: "rev-0", task_id: "t7", task_key: "ARIS-7", title: "Проверка", status: "todo", project_id: "p1", project_key: "ARIS", project_title: "ARIS Metadata Integration (демо)", app_path: "/tasks/ARIS-7" },
    ],
  };

  it("lists the linked tasks with deep links and a project view filtered by the document", async () => {
    mockApi([{ path: "/api/documents/DEMO-INT-002/tasks", body: DATA }]);
    render(
      <MemoryRouter>
        <DocumentTasksPanel documentId="DEMO-INT-002" />
      </MemoryRouter>,
    );
    const section = await screen.findByTestId("document-tasks");
    expect(await within(section).findByRole("link", { name: "ARIS-5 Загрузчик" })).toHaveAttribute("href", "/tasks/ARIS-5");
    expect(within(section).getByText("Документ изменён после связывания")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /Задачи проекта «ARIS Metadata Integration \(демо\)» по документу/ })).toHaveAttribute(
      "href",
      "/projects/ARIS?view=list&doc=DEMO-INT-002",
    );
  });

  it("says when no task is linked, and disappears without the work module", async () => {
    mockApi([
      { path: "/api/documents/SEM-GLOSS-001/tasks", body: { document_id: "SEM-GLOSS-001", revision: "r", items: [], total: 0 } },
      { path: "/api/documents/OFF-001/tasks", status: 503, body: { code: "feature_unavailable", message: "Модуль задач отключён", request_id: "t" } },
    ]);
    const { unmount } = render(
      <MemoryRouter>
        <DocumentTasksPanel documentId="SEM-GLOSS-001" />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Задач, связанных с этим документом, нет/)).toBeInTheDocument();
    unmount();
    render(
      <MemoryRouter>
        <DocumentTasksPanel documentId="OFF-001" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByTestId("document-tasks")).not.toBeInTheDocument());
  });
});
