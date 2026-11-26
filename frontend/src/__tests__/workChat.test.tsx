import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantSkill, StoredTurnRequest, WorkChangeProposal, WorkProposalRef } from "../api/types";
import { AnswerView } from "../components/AssistantTurn";
import { AskWorkProposal } from "../components/AskWorkProposal";
import { Composer, parseTaskKeys } from "../components/Composer";
import { ProjectPage } from "../pages/ProjectPage";
import { missingInput } from "../lib/assistant";
import { requestOf } from "../lib/conversationStore";
import { toAskRequest, useComposer, type ComposerMessage } from "../lib/useComposer";
import type { SkillsState } from "../lib/useSkills";
import { skills, supportedAnswer } from "./fixtures";
import { mockApi, renderRoutes } from "./helpers";
import { project, projectRoutes } from "./workFixtures";

/* M7 chat work skills (docs/WORK_CHAT_SKILLS.md): the composer sends a work context only with a work skill and an
 * explicitly chosen project; the work proposal card re-reads the CURRENT state from the work API (never the document AI
 * proposals API) and only links to the review; the change review applies exactly the operations a person kept, once. */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const workSkill = (id: string, name: string, access: "read" | "draft"): AssistantSkill => ({
  id,
  name,
  description: name,
  access,
  requires: { document: false, selection: false, attachment: false, project: true },
  prompt_optional: id === "analyze_project",
  available: true,
  unavailable_reason: null,
  work: true,
});
const ANALYZE = workSkill("analyze_project", "Проанализировать проект", "read");
const PLAN = workSkill("draft_task_plan", "Составить план задач", "draft");
const CHANGES = workSkill("propose_task_changes", "Предложить изменения задач", "draft");
const WCP = "WCP-0123456789abcdef";

function message(overrides: Partial<ComposerMessage> = {}): ComposerMessage {
  return {
    conversationId: "conv-test-0001",
    question: "Разбей на задачи",
    skill: PLAN,
    work: { projectKey: "ARIS", taskKeys: [], proposalId: null },
    clientRequestId: "send-test-0001",
    attachments: [],
    documents: [],
    selection: null,
    scope: "team",
    includeDrafts: false,
    includeDeprecated: false,
    ...overrides,
  };
}

describe("the work context of a message", () => {
  it("is sent only with a work skill and a chosen project, with the send's idempotency key", () => {
    expect(toAskRequest(message()).work_context).toEqual({ project_key: "ARIS", client_request_id: "send-test-0001" });
    const refine = toAskRequest(message({ work: { projectKey: "ARIS", taskKeys: ["ARIS-6"], proposalId: "WAP-0123456789abcdef" } }));
    expect(refine.work_context).toEqual({
      project_key: "ARIS",
      task_keys: ["ARIS-6"],
      proposal_id: "WAP-0123456789abcdef",
      client_request_id: "send-test-0001",
    });
    const answer = skills.find((s) => s.id === "answer") ?? null;
    expect(toAskRequest(message({ skill: answer })).work_context).toBeUndefined();
    expect(toAskRequest(message({ work: { projectKey: null, taskKeys: [], proposalId: null } })).work_context).toBeUndefined();
  });

  it("requires a project for a work skill and parses task keys", () => {
    expect(missingInput(PLAN, { documents: 0, selection: false, attachments: 0, question: "abc", project: false })).toBe("project");
    expect(missingInput(PLAN, { documents: 0, selection: false, attachments: 0, question: "abc", project: true })).toBeNull();
    expect(parseTaskKeys("aris-6, ARIS-8;aris-6  bad x-1")).toEqual(["ARIS-6", "ARIS-8"]);
  });

  it("a reopened work turn re-sends its references and the same key", () => {
    const stored: StoredTurnRequest = {
      question: "ARIS-6 на ревью",
      skill: { id: "propose_task_changes", name: "Предложить изменения задач", access: "draft" },
      sources: ["team"],
      include_drafts: false,
      include_deprecated: false,
      search_external: false,
      documents: [],
      attachments: [],
      selection: null,
      work: { project_key: "ARIS", task_keys: ["ARIS-6"], proposal_id: null, client_request_id: "send-old-0001" },
    };
    expect(requestOf(stored, "conv-test-0001").work_context).toEqual({
      project_key: "ARIS",
      task_keys: ["ARIS-6"],
      client_request_id: "send-old-0001",
    });
  });
});

function ComposerHarness({ onSend, registry }: { onSend: (m: ComposerMessage) => void; registry: SkillsState }) {
  const composer = useComposer({ defaults: { skill: PLAN } });
  return <Composer variant="dialog" composer={composer} onSend={onSend} skills={registry} inputId="composer-field" />;
}

describe("the project chooser", () => {
  it("never preselects a project — not even the only one — and sending waits for the choice", async () => {
    mockApi([{ path: "/api/projects", body: { items: [project()], total: 1 } }]);
    const onSend = vi.fn();
    renderRoutes("/", { "/": <ComposerHarness onSend={onSend} registry={{ items: [ANALYZE, PLAN, CHANGES], failed: false }} /> });
    const select = (await screen.findByLabelText("Проект")) as HTMLSelectElement;
    await screen.findByRole("option", { name: /ARIS — ARIS Metadata/ });
    expect(select.value).toBe("");
    await userEvent.type(screen.getByLabelText("Вопрос"), "Разбей интеграцию на задачи");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    expect(screen.getByText(/нужен проект/)).toBeInTheDocument();
    await userEvent.selectOptions(select, "ARIS");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0]?.[0] as ComposerMessage;
    expect(sent.work?.projectKey).toBe("ARIS");
    expect(toAskRequest(sent).work_context?.client_request_id).toMatch(/^[A-Za-z0-9._:-]{8,80}$/);
  });
});

function ref(overrides: Partial<WorkProposalRef> = {}): WorkProposalRef {
  return {
    kind: "task_plan",
    id: "WAP-0123456789abcdef",
    project_key: "ARIS",
    state: "ready",
    app_path: "/projects/ARIS?proposal=WAP-0123456789abcdef",
    task_count: 4,
    dependency_count: 3,
    change_count: 0,
    revised_from: null,
    requires_confirmation: true,
    ...overrides,
  };
}

describe("the work proposal card", () => {
  it("re-reads the plan from the work API, links to the project review and never calls the document AI API", async () => {
    const calls = mockApi([
      { path: "/api/work-ai/proposals/WAP-0123456789abcdef", body: { id: "WAP-0123456789abcdef", state: "ready", stale_reasons: [] } },
    ]);
    const onRefine = vi.fn();
    renderRoutes("/", { "/": <AskWorkProposal reference={ref()} onRefine={onRefine} /> });
    expect(await screen.findByText(/Состояние: готово к проверке/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Проверить план" });
    expect(link).toHaveAttribute("href", "/projects/ARIS?proposal=WAP-0123456789abcdef");
    expect(calls.map((c) => c.url)).toEqual(["/api/work-ai/proposals/WAP-0123456789abcdef"]);
    expect(calls.some((c) => c.url.startsWith("/api/ai/proposals"))).toBe(false);
    expect(screen.queryByRole("button", { name: /Создать|Применить/ })).toBeNull(); // no write from the chat
    await userEvent.click(screen.getByRole("button", { name: "Уточнить" }));
    expect(onRefine).toHaveBeenCalledWith(expect.objectContaining({ id: "WAP-0123456789abcdef" }));
  });

  it("says a stored proposal became stale (the answer's old state is not trusted)", async () => {
    mockApi([
      { path: `/api/work-ai/change-proposals/${WCP}`, body: { id: WCP, state: "stale", stale_reasons: ["task_changed"] } },
    ]);
    renderRoutes("/", {
      "/": <AskWorkProposal reference={ref({ kind: "task_changes", id: WCP, app_path: `/projects/ARIS?changes=${WCP}`, change_count: 2 })} onRefine={vi.fn()} />,
    });
    expect(await screen.findByText(/Устарело — подготовьте заново: задача изменена/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Уточнить" })).toBeNull();
    expect(screen.getByRole("link", { name: "Проверить изменения" })).toHaveAttribute("href", `/projects/ARIS?changes=${WCP}`);
  });

  it("a proposal the reader can no longer open is reported, without a link", async () => {
    mockApi([{ path: "/api/work-ai/proposals/WAP-0123456789abcdef", status: 404, body: { code: "not_found", message: "Нет", request_id: "t" } }]);
    renderRoutes("/", { "/": <AskWorkProposal reference={ref()} /> });
    expect(await screen.findByText(/Предложение недоступно/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

function changeSet(overrides: Partial<WorkChangeProposal> = {}): WorkChangeProposal {
  return {
    id: WCP,
    project_id: "p1",
    project_key: "ARIS",
    kind: "task_changes",
    schema_version: "work_changes.v1",
    status: "suggested",
    state: "ready",
    stale_reasons: [],
    provider: "internal_api",
    request: "ARIS-6 на ревью, ARIS-8 high",
    goal: "Статусы",
    base_plan_revision: 7,
    current_plan_revision: 7,
    created_at: "2026-11-26T10:00:00Z",
    expires_at: "2026-11-27T10:00:00Z",
    decided_at: null,
    changes: [
      {
        operation_id: "op1",
        task_id: "t6",
        task_key: "ARIS-6",
        task_title: "Сопоставить атрибуты",
        field: "status",
        field_label: "Статус",
        before: "in_progress",
        after: "review",
        current: "in_progress",
        expected_version: 3,
        current_version: 3,
        reason: "готово к ревью",
        included: true,
        state: "ok",
      },
      {
        operation_id: "op2",
        task_id: "t8",
        task_key: "ARIS-8",
        task_title: "Правила для справочников",
        field: "priority",
        field_label: "Приоритет",
        before: "medium",
        after: "high",
        current: "medium",
        expected_version: 1,
        current_version: 1,
        reason: "",
        included: true,
        state: "ok",
      },
    ],
    issues: [{ code: "unsupported_field", message: "Это поле предложением не меняется — изменение отброшено. Исполнителя меняют в карточке задачи.", local_id: "ARIS-9", severity: "warning" }],
    assumptions: [],
    sources: [],
    can_apply: true,
    applied_operation_ids: [],
    applied_task_keys: [],
    revised_from: null,
    ...overrides,
  };
}

describe("the change review", () => {
  it("shows was → will be, applies only the kept operations once and reads the result back", async () => {
    let current = changeSet();
    const calls = mockApi([
      ...projectRoutes(),
      { path: `/api/work-ai/change-proposals/${WCP}`, body: () => current },
      {
        method: "POST",
        path: `/api/work-ai/change-proposals/${WCP}/apply`,
        respond: () => {
          current = changeSet({ status: "applied", state: "applied", applied_operation_ids: ["op1"], applied_task_keys: ["ARIS-6"], can_apply: false });
          return new Response(
            JSON.stringify({ proposal_id: WCP, project_id: "p1", applied: true, plan_revision: 8, applied_operations: 1, updated_tasks: [], replayed: false }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    ]);
    renderRoutes(`/projects/ARIS?changes=${WCP}`, { "/projects/:key": <ProjectPage /> });
    const list = await screen.findByRole("list", { name: "Предложенные изменения" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first!).getByText("В работе")).toBeInTheDocument();
    expect(within(first!).getByText("На проверке")).toBeInTheDocument();
    expect(within(second!).getByText("Высокий")).toBeInTheDocument();
    expect(screen.getByText(/Исполнителя меняют в карточке задачи/)).toBeInTheDocument();
    await userEvent.click(within(second!).getByRole("checkbox"));
    const apply = screen.getByRole("button", { name: "Применить изменения (1)" });
    await userEvent.dblClick(apply);
    expect(await screen.findByText(/Изменения применены/)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/apply"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ operation_ids: ["op1"], expected_plan_revision: 7, client_request_id: expect.any(String) });
  });

  it("a stale change-set says so and cannot be applied", async () => {
    mockApi([
      ...projectRoutes(),
      {
        path: `/api/work-ai/change-proposals/${WCP}`,
        body: changeSet({ state: "stale", stale_reasons: ["plan_changed"], can_apply: false }),
      },
    ]);
    renderRoutes(`/projects/ARIS?changes=${WCP}`, { "/projects/:key": <ProjectPage /> });
    expect(await screen.findByText(/Предложение устарело — подготовьте заново: задачи проекта изменились/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Применить изменения/ })).toBeDisabled();
  });

  it("a 409 on apply keeps the selection and shows the stale banner", async () => {
    mockApi([
      ...projectRoutes(),
      { path: `/api/work-ai/change-proposals/${WCP}`, body: changeSet() },
      {
        method: "POST",
        path: `/api/work-ai/change-proposals/${WCP}/apply`,
        status: 409,
        body: { code: "proposal_stale", message: "Задачи проекта изменились после подготовки предложения — подготовьте новое.", details: { reason: "plan_changed" }, request_id: "t" },
      },
    ]);
    renderRoutes(`/projects/ARIS?changes=${WCP}`, { "/projects/:key": <ProjectPage /> });
    await userEvent.click(await screen.findByRole("button", { name: "Применить изменения (2)" }));
    await waitFor(() => expect(screen.getByText(/Предложение устарело — подготовьте заново\. Задачи проекта изменились/)).toBeInTheDocument());
  });
});

describe("more of the review and the compact panel", () => {
  it("UI-07 «Отклонить» closes the change-set without applying anything", async () => {
    let current = changeSet();
    const calls = mockApi([
      ...projectRoutes(),
      { path: `/api/work-ai/change-proposals/${WCP}`, body: () => current },
      {
        method: "POST",
        path: `/api/work-ai/change-proposals/${WCP}/reject`,
        respond: () => {
          current = changeSet({ status: "rejected", state: "rejected", can_apply: false });
          return new Response(JSON.stringify(current), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
    ]);
    renderRoutes(`/projects/ARIS?changes=${WCP}`, { "/projects/:key": <ProjectPage /> });
    await userEvent.click(await screen.findByRole("button", { name: "Отклонить" }));
    expect(await screen.findByText("Предложение отклонено: задачи не менялись.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(false);
    expect(screen.queryByRole("button", { name: /Применить изменения/ })).toBeNull();
  });

  it("UI-11 the review works from the keyboard alone: Space unchecks, Enter applies", async () => {
    const calls = mockApi([
      ...projectRoutes(),
      { path: `/api/work-ai/change-proposals/${WCP}`, body: changeSet() },
      {
        method: "POST",
        path: `/api/work-ai/change-proposals/${WCP}/apply`,
        body: { proposal_id: WCP, project_id: "p1", applied: true, plan_revision: 8, applied_operations: 1, updated_tasks: [], replayed: false },
      },
    ]);
    renderRoutes(`/projects/ARIS?changes=${WCP}`, { "/projects/:key": <ProjectPage /> });
    const second = await screen.findByRole("checkbox", { name: /Применить: ARIS-8, Приоритет/ });
    second.focus();
    await userEvent.keyboard(" ");
    expect(second).not.toBeChecked();
    const apply = screen.getByRole("button", { name: "Применить изменения (1)" });
    apply.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/apply"))).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith("/apply"))?.body).toMatchObject({ operation_ids: ["op1"] });
  });

  it("UI-12 the compact document panel shows the work card with a working deep link (no refine there)", async () => {
    mockApi([{ path: `/api/work-ai/change-proposals/${WCP}`, body: changeSet() }]);
    const answer = {
      ...supportedAnswer,
      citations: [],
      confidence: "partial" as const,
      work_proposal: ref({ kind: "task_changes", id: WCP, app_path: `/projects/ARIS?changes=${WCP}`, change_count: 2 }),
    };
    const request = { question: "ARIS-6 на ревью", sources: ["team" as const], include_drafts: false, include_deprecated: false };
    renderRoutes("/", {
      "/": <AnswerView answer={answer} request={request} turnNo={1} onRefine={() => {}} onAskCorporate={() => {}} compact />,
    });
    const link = await screen.findByRole("link", { name: "Проверить изменения" });
    expect(link).toHaveAttribute("href", `/projects/ARIS?changes=${WCP}`);
    expect(screen.queryByRole("button", { name: "Уточнить" })).toBeNull();
  });
});
