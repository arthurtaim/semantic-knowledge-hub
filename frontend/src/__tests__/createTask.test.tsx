import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskRequest, AskResponse, AssistantSkill, TaskDraft } from "../api/types";
import { AskTaskDraft } from "../components/AskTaskDraft";
import { AnswerView } from "../components/AssistantTurn";
import { Composer } from "../components/Composer";
import { toAskRequest, useComposer, type ComposerMessage } from "../lib/useComposer";
import { supportedAnswer } from "./fixtures";
import { mockApi, renderRoutes } from "./helpers";
import { ASSIGNEES, project, task } from "./workFixtures";

/*
 * «Создать задачу» (design 2026-11-27 §5.4): the task-draft card. The person edits it and creates the task with the
 * regular task API — one POST per card (double click), then the document links; nothing is created by words.
 */

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    project_key: "RAG",
    title: "Обновить витрину",
    description: "Нужно: обновить витрину.",
    priority: "medium",
    assignee_id: null,
    assignee_hint: null,
    due_date: "2026-12-05",
    start_date: null,
    end_date: null,
    origin: { project: "request", title: "assistant", description: "assistant", due_date: "request" },
    missing: [],
    issues: [],
    documents: [],
    auto_started: false,
    client_request_id: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

const RAG = project({ id: "p-rag", key: "RAG", title: "RAG-ассистент (демо)" });
const OLD = project({ id: "p-old", key: "OLD", title: "Архивный", status: "archived" });
const CREATED = task({ key: "RAG-7", id: "t-7", title: "Обновить витрину", project_id: "p-rag" });

function routes(extra: Parameters<typeof mockApi>[0] = []) {
  return mockApi([
    { path: /^\/api\/projects(\?.*)?$/, body: { items: [RAG, OLD], total: 2 } },
    { path: /^\/api\/work\/assignees/, body: ASSIGNEES },
    ...extra,
  ]);
}

function show(value: TaskDraft, props: { onAnswerNormally?: () => void } = {}) {
  return renderRoutes("/", { "/": <AskTaskDraft draft={value} {...props} /> });
}

describe("task-draft card", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows where each value came from and marks the person's edits", async () => {
    routes();
    show(draft());
    expect(await screen.findByDisplayValue("Обновить витрину")).toBeInTheDocument();
    expect(screen.getAllByText("предложение ассистента").length).toBeGreaterThan(0);
    expect(screen.getAllByText("из вашего запроса").length).toBeGreaterThan(0);
    const title = screen.getByLabelText("Название");
    await userEvent.clear(title);
    await userEvent.type(title, "Пересобрать витрину");
    expect(screen.getByText("изменено вами")).toBeInTheDocument();
  });

  it("highlights the missing project and title and keeps the button disabled", async () => {
    routes();
    show(draft({ project_key: null, title: "", missing: ["project", "title"], origin: {} }));
    expect(await screen.findByText("Выберите проект")).toBeInTheDocument();
    expect(screen.getByText("Укажите название")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать задачу" })).toBeDisabled();
    // the archived project is never offered
    expect(screen.queryByRole("option", { name: /Архивный/ })).not.toBeInTheDocument();
  });

  it("asks for the end when only the start is given", async () => {
    routes();
    show(draft({ start_date: "2026-12-01" }));
    expect(await screen.findByText("Укажите окончание или очистите начало")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать задачу" })).toBeDisabled();
  });

  it("creates the task with ONE request on a double click and shows the result", async () => {
    const calls = routes([{ path: "/api/projects/RAG/tasks", method: "POST", status: 201, body: CREATED }]);
    show(draft({ start_date: "2026-12-01", end_date: "2026-12-04", assignee_id: "demo-analyst-1" }));
    const button = await screen.findByRole("button", { name: "Создать задачу" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.dblClick(button);
    expect(await screen.findByText(/Задача RAG-7 создана/)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/projects/RAG/tasks");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      title: "Обновить витрину",
      description: "Нужно: обновить витрину.",
      priority: "medium",
      assignee_id: "demo-analyst-1",
      due_date: "2026-12-05",
      start_date: "2026-12-01",
      end_exclusive: "2026-12-05",
      client_request_id: "0123456789abcdef0123456789abcdef",
    });
    expect(screen.getByRole("link", { name: "Открыть задачу" })).toHaveAttribute("href", "/projects/RAG?task=RAG-7");
  });

  it("links the context document after the task; a failed link keeps the task and offers a retry", async () => {
    let linkAttempts = 0;
    const calls = routes([
      { path: "/api/projects/RAG/tasks", method: "POST", status: 201, body: CREATED },
      {
        path: "/api/tasks/t-7/links",
        method: "POST",
        respond: () => {
          linkAttempts += 1;
          return linkAttempts === 1
            ? new Response(JSON.stringify({ code: "forbidden", message: "Нет прав", request_id: "t" }), { status: 403 })
            : new Response(JSON.stringify({ id: "l1" }), { status: 201, headers: { "Content-Type": "application/json" } });
        },
      },
    ]);
    show(draft({ documents: [{ document_id: "SEM-STD-001", title: "Стандарт", revision: "r1" }] }));
    expect(await screen.findByRole("checkbox", { name: /Связать с документом «Стандарт»/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    expect(await screen.findByText("Задача создана, связь с документом не добавлена — добавьте её в задаче.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Добавить связь" }));
    await waitFor(() => expect(linkAttempts).toBe(2));
    const link = calls.find((c) => c.method === "POST" && c.url === "/api/tasks/t-7/links");
    expect(link?.body).toMatchObject({ document_id: "SEM-STD-001" });
    expect(await screen.findByText(/Связь с документом «Стандарт» добавлена/)).toBeInTheDocument();
  });

  it("shows the server's real 422 errors at their field, and 403 as a clear message", async () => {
    // shapes exactly as the task API sends them (no `details.field` for these)
    routes([
      {
        path: "/api/projects/RAG/tasks",
        method: "POST",
        status: 422,
        body: { code: "invalid_date_range", message: "В интервале нет ни одного рабочего дня (Пн–Пт).", request_id: "t", details: { reason: "no_workdays" } },
      },
    ]);
    show(draft({ start_date: "2026-12-05", end_date: "2026-12-06" }));
    await userEvent.click(await screen.findByRole("button", { name: "Создать задачу" }));
    const weekend = await screen.findByText("В интервале нет ни одного рабочего дня (Пн–Пт).");
    expect(weekend.closest(".ask-task-draft__field")).toHaveTextContent("Окончание");
    vi.restoreAllMocks();
    routes([
      {
        path: "/api/projects/RAG/tasks",
        method: "POST",
        status: 422,
        body: { code: "invalid_assignee", message: "Исполнитель не найден среди доступных.", request_id: "t", details: { assignee_id: "ghost" } },
      },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    const assignee = await screen.findByText("Исполнитель не найден среди доступных.");
    expect(assignee.closest(".ask-task-draft__field")).toHaveTextContent("Исполнитель");
    vi.restoreAllMocks();
    routes([{ path: "/api/projects/RAG/tasks", method: "POST", status: 403, body: { code: "forbidden", message: "x", request_id: "t" } }]);
    await userEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    expect(await screen.findByText("Нет прав на создание задач в этом проекте.")).toBeInTheDocument();
  });

  it("a retried link of the second document does not reuse the first document's key", async () => {
    const keys = new Map<string, string>();
    let failB = true;
    routes([
      { path: "/api/projects/RAG/tasks", method: "POST", status: 201, body: CREATED },
      {
        path: "/api/tasks/t-7/links",
        method: "POST",
        respond: (init) => {
          const body = JSON.parse(String(init?.body)) as { document_id: string; client_request_id: string };
          const seen = keys.get(body.client_request_id);
          if (seen && seen !== body.document_id) {
            return new Response(JSON.stringify({ code: "conflict", message: "key reused", request_id: "t" }), { status: 409 });
          }
          if (body.document_id === "DOC-B" && failB) {
            failB = false;
            return new Response(JSON.stringify({ code: "unavailable", message: "x", request_id: "t" }), { status: 503 });
          }
          keys.set(body.client_request_id, body.document_id);
          return new Response(JSON.stringify({ id: `l-${body.document_id}` }), { status: 201, headers: { "Content-Type": "application/json" } });
        },
      },
    ]);
    show(
      draft({
        documents: [
          { document_id: "DOC-A", title: "Документ А", revision: "r1" },
          { document_id: "DOC-B", title: "Документ Б", revision: "r1" },
        ],
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Создать задачу" }));
    await userEvent.click(await screen.findByRole("button", { name: "Добавить связь" }));
    expect(await screen.findByText(/Связь с документом «Документ Б» добавлена/)).toBeInTheDocument();
    expect(screen.getByText(/Связь с документом «Документ А» добавлена/)).toBeInTheDocument();
  });

  it("offers «Ответить как обычно» only when the skill started by itself", async () => {
    routes();
    const onAnswerNormally = vi.fn();
    const { unmount } = show(draft({ auto_started: true }), { onAnswerNormally });
    await userEvent.click(await screen.findByRole("button", { name: "Ответить как обычно" }));
    expect(onAnswerNormally).toHaveBeenCalledOnce();
    unmount();
    show(draft({ auto_started: false }), { onAnswerNormally });
    await screen.findByDisplayValue("Обновить витрину");
    expect(screen.queryByRole("button", { name: "Ответить как обычно" })).not.toBeInTheDocument();
  });

  it("shows an assignee named in the request that matched nobody", async () => {
    routes();
    show(draft({ assignee_hint: "Петрова" }));
    expect(await screen.findByText("Исполнитель из запроса: «Петрова» — выберите")).toBeInTheDocument();
  });
});

const CREATE: AssistantSkill = {
  id: "create_task",
  name: "Создать задачу",
  description: "Подготовит черновик задачи",
  access: "draft",
  requires: { document: false, selection: false, attachment: false, project: false },
  prompt_optional: false,
  available: true,
  unavailable_reason: null,
  work: true,
};

function CreateHarness({ onSend }: { onSend: (m: ComposerMessage) => void }) {
  const composer = useComposer({ defaults: { skill: CREATE } });
  return <Composer variant="dialog" composer={composer} onSend={onSend} skills={{ items: [CREATE], failed: false }} inputId="composer-field" />;
}

describe("«Создать задачу» in the composer and the dialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows «Проект» without «Задачи» and sends without a project", async () => {
    mockApi([{ path: "/api/projects", body: { items: [RAG], total: 1 } }]);
    const onSend = vi.fn();
    renderRoutes("/", { "/": <CreateHarness onSend={onSend} /> });
    await screen.findByLabelText("Проект");
    expect(screen.queryByLabelText("Задачи")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Вопрос"), "обновить витрину до 5 декабря");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const sent = onSend.mock.calls[0]?.[0] as ComposerMessage;
    const request = toAskRequest(sent);
    expect(request.skill_id).toBe("create_task");
    expect(request.work_context).toBeUndefined();
  });

  it("the turn shows the card and «Ответить как обычно» asks the same question as a plain answer", async () => {
    routes();
    const onAnswerNormally = vi.fn();
    const request: AskRequest = { question: "создай задачу обновить витрину", sources: ["team"], include_drafts: false, include_deprecated: false };
    const answer: AskResponse = {
      ...supportedAnswer,
      citations: [],
      answer: "Проверьте черновик задачи и нажмите «Создать задачу». Задача создаётся только кнопкой.",
      skill: { id: "create_task", name: "Создать задачу", access: "draft" },
      task_draft: draft({ auto_started: true }),
    };
    renderRoutes("/", {
      "/": <AnswerView answer={answer} request={request} turnNo={1} onRefine={vi.fn()} onAskCorporate={vi.fn()} onAnswerNormally={onAnswerNormally} />,
    });
    await userEvent.click(await screen.findByRole("button", { name: "Ответить как обычно" }));
    expect(onAnswerNormally).toHaveBeenCalledWith({ ...request, skill_id: "answer", work_context: undefined });
  });
});
