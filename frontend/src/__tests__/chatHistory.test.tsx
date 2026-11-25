import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskResponse, AskStreamEvent, ConversationList, ConversationSummary, StoredConversation } from "../api/types";
import { SessionContext } from "../lib/session";
import { AskPage } from "../pages/AskPage";
import { HomePage } from "../pages/HomePage";
import { freshSync, proposalSummary, session, skills, storedConversation, storedTurn, supportedAnswer } from "./fixtures";
import { memoryStorage, mockApi, ndjsonStream, type MockRoute, type RecordedCall } from "./helpers";

/*
 * The reported defect (chat history is not persisted): a reopened recent dialog asked its question again, leaving
 * /ask for another section aborted an answer in flight and lost the dialog, and a reload lost it too. The dialog's
 * turns now live in a module-level store keyed by the conversation id (in flight across navigation) and on the
 * server per user and browser (GET /api/assistant/conversations/{id}); `/ask?c=<id>` opens a stored conversation
 * without asking again.
 */

const STREAM = "/api/assistant/ask/stream";
const CONV = "conv-0123456789abcdef01234567";
const QUESTION = "Какие слои у архитектуры?"; // the question of `storedTurn()`

const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);

const mockEvents = (response: AskResponse): AskStreamEvent[] => [
  { type: "status", stage: "retrieving" },
  { type: "status", stage: "validating" },
  { type: "final", response },
];

function streamRoute(response: AskResponse = supportedAnswer): MockRoute {
  return {
    method: "POST",
    path: STREAM,
    respond: (init) => {
      const stream = ndjsonStream();
      const result = stream.respond(init);
      stream.push(...mockEvents(response));
      stream.close();
      return result;
    },
  };
}

function summaryOf(conversation: StoredConversation): ConversationSummary {
  const summary: Partial<StoredConversation> = { ...conversation };
  delete summary.turns;
  delete summary.index_generation;
  return summary as ConversationSummary;
}

function list(items: StoredConversation[]): ConversationList {
  return {
    items: items.map(summaryOf),
    total: items.length,
    enabled: true,
    retention_days: 30,
  };
}

function baseRoutes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: "/api/assistant/skills", body: skills },
    { path: /^\/api\/drafts/, body: { items: [proposalSummary({ status: "draft" })], total: 1 } },
    { path: "/api/documents?size=100", body: { items: [], total: 0, page: 1, size: 100 } },
    { path: "/api/index/status", body: freshSync },
  ];
}

function Elsewhere() {
  return <p>Раздел «Документы»</p>;
}

/** The test drives navigation like a sidebar link or the Back button; the pages stay real. */
const router: { navigate: NavigateFunction | null; location: string } = { navigate: null, location: "" };

function NavProbe() {
  router.navigate = useNavigate();
  const location = useLocation();
  router.location = `${location.pathname}${location.search}`;
  return null;
}

function renderApp(path: string) {
  return render(
    <SessionContext.Provider value={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/documents" element={<Elsewhere />} />
        </Routes>
        <NavProbe />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

const go = (to: string | number) =>
  act(async () => {
    if (typeof to === "number") await router.navigate?.(to);
    else await router.navigate?.(to);
  });
const search = () => router.location.slice(router.location.indexOf("?") >= 0 ? router.location.indexOf("?") : router.location.length);

const dialog = () => screen.getByRole("region", { name: "Диалог" });

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Chat history: the reported defect", () => {
  it("reopening a recent dialog shows its stored answer and does NOT ask again", async () => {
    // A dialog remembered by this browser before (the localStorage entry of earlier versions) and stored on the server.
    window.localStorage.setItem(
      "skh.recent-questions.v1:local-demo-user",
      JSON.stringify([{ question: QUESTION, at: "2026-11-24T10:00:00Z", skill: null, sources: 1, context: null, conversation_id: CONV }]),
    );
    const calls = mockApi(
      baseRoutes([
        streamRoute(),
        { path: "/api/assistant/conversations?limit=5", body: list([storedConversation()]) },
        { path: `/api/assistant/conversations/${CONV}`, body: storedConversation() },
      ]),
    );
    renderApp("/");
    const recent = (await screen.findByRole("heading", { name: "Недавние диалоги" })).closest("section") as HTMLElement;
    await userEvent.click(await within(recent).findByRole("link", { name: new RegExp(QUESTION.slice(0, 12)) }));
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    expect(within(dialog()).getByText(QUESTION)).toHaveClass("turn__bubble");
    expect(search()).toBe(`?c=${CONV}`);
  });

  it("leaving /ask for another section does not abort the answer in flight; coming back shows it, asked once", async () => {
    const stream = ndjsonStream();
    const calls = mockApi(baseRoutes([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]));
    renderApp("/ask");
    await userEvent.type(screen.getByLabelText("Вопрос"), `${QUESTION}{Enter}`);
    expect(await screen.findByText("Ищу источники…")).toBeInTheDocument();

    await go("/documents");
    expect(screen.getByText("Раздел «Документы»")).toBeInTheDocument();
    expect(stream.state.aborted).toBe(false);
    await act(async () => {
      stream.push(...mockEvents(supportedAnswer));
      stream.close();
    });

    await go(-1);
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(within(dialog()).getByText(QUESTION)).toHaveClass("turn__bubble");
    expect(posts(calls)).toHaveLength(1);
  });

  it("a reload of /ask?c=<id> restores the conversation from the server without asking", async () => {
    const calls = mockApi(baseRoutes([streamRoute(), { path: `/api/assistant/conversations/${CONV}`, body: storedConversation() }]));
    renderApp(`/ask?c=${CONV}`);
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(within(dialog()).getByText(QUESTION)).toHaveClass("turn__bubble");
    expect(posts(calls)).toHaveLength(0);
  });

  it("?q=…&run=1 starts a new conversation once: the URL becomes ?c=<id>, Back and Forward never ask again", async () => {
    const calls = mockApi(baseRoutes([streamRoute()]));
    renderApp(`/ask?${new URLSearchParams({ q: QUESTION, run: "1" }).toString()}`);
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    await waitFor(() => expect(search()).toMatch(/^\?c=conv-[0-9a-f]{24}$/));
    await go("/documents");
    await go(-1);
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    await go("/documents");
    await go(-1);
    await screen.findByText("Подтверждено источниками");
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("Chat history: a stored conversation in the dialog", () => {
  it("continues the conversation: the same id, the stored answers as context, the last skill and live file in the field", async () => {
    const file = { id: "ATT-00000000000000aa", name: "aris.csv", available: true, size: 2048, mime: "text/csv", summary: "12 строк", expires_at: "2099-01-01T00:00:00Z" };
    const gone = { id: "ATT-00000000000000bb", name: "old.csv", available: false, size: null, mime: null, summary: null, expires_at: null };
    const first = storedTurn();
    const second = storedTurn({
      seq: 2,
      request: {
        ...first.request,
        question: "Сверь с выгрузкой",
        skill: { id: "compare_with_file", name: "Сравнить с файлом", access: "read" },
        attachments: [file, gone],
      },
    });
    const calls = mockApi(baseRoutes([streamRoute(), { path: `/api/assistant/conversations/${CONV}`, body: storedConversation([first, second]) }]));
    renderApp(`/ask?c=${CONV}`);
    expect(await screen.findAllByText("Подтверждено источниками")).toHaveLength(2);
    expect(await screen.findByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeInTheDocument();
    const field = screen.getByLabelText("Вопрос");
    expect(field).toHaveValue("");
    const chips = screen.getAllByRole("list", { name: "Приложено к сообщению" }).at(-1) as HTMLElement;
    expect(within(chips).getByRole("button", { name: "Убрать файл «old.csv»" }).closest(".chip")).toHaveClass("chip--unavailable");
    expect(field).toHaveAccessibleDescription(/С учётом 2 предыдущих ответов/);

    await userEvent.type(field, "А какие ограничения?{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({
      question: "А какие ограничения?",
      conversation_id: CONV,
      skill_id: "compare_with_file",
      attachment_ids: [file.id],
      history: [
        { question: QUESTION, answer: supportedAnswer.answer },
        { question: "Сверь с выгрузкой", answer: supportedAnswer.answer },
      ],
    });
    expect(posts(calls)[0]?.headers["X-SKH-Browser"]).toMatch(/^[0-9a-f]{32}$/);
    expect(await screen.findAllByText("Подтверждено источниками")).toHaveLength(3);
  });

  it("shows a failed turn with its error and a retry, an interrupted one honestly — neither is run by itself", async () => {
    const failed = storedTurn({
      status: "failed",
      response: null,
      error: { code: "ai_timeout", message: "Модель не ответила за отведённое время.", status: 504 },
      answer_generation: null,
    });
    const calls = mockApi(baseRoutes([streamRoute(), { path: `/api/assistant/conversations/${CONV}`, body: storedConversation([failed]) }]));
    renderApp(`/ask?c=${CONV}`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Модель не ответила вовремя");
    expect(alert).toHaveTextContent("Модель не ответила за отведённое время.");
    expect(posts(calls)).toHaveLength(0);
    await userEvent.click(within(alert).getByRole("button", { name: "Повторить запрос" }));
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.body).toMatchObject({ question: QUESTION, conversation_id: CONV, history: [] });
  });

  it("an answer that never arrived says so and offers «Повторить запрос»", async () => {
    const interrupted = storedTurn({ status: "interrupted", response: null, completed_at: null, answer_generation: null });
    const calls = mockApi(baseRoutes([streamRoute(), { path: `/api/assistant/conversations/${CONV}`, body: storedConversation([interrupted]) }]));
    renderApp(`/ask?c=${CONV}`);
    expect(await screen.findByText(/Ответ не был получен/)).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(1);
    expect(screen.queryByText(/Ответ не был получен/)).toBeNull();
  });

  it("says when the base changed since the answer, and hides an answer whose sources the reader can no longer see", async () => {
    const changed = storedTurn({
      generation_changed: true,
      notes: ["Ответ дан по поколению g3; база с тех пор обновлена (сейчас g5)."],
    });
    const withheld = storedTurn({
      seq: 2,
      request: { ...storedTurn().request, question: "Что в закрытом плане?" },
      response: null,
      withheld: "sources_unavailable",
      notes: ["Ответ скрыт: часть его источников вам сейчас недоступна. Задайте вопрос заново — ответ будет построен по доступным документам."],
    });
    const calls = mockApi(baseRoutes([streamRoute(), { path: `/api/assistant/conversations/${CONV}`, body: storedConversation([changed, withheld]) }]));
    renderApp(`/ask?c=${CONV}`);
    expect(await screen.findByText("Ответ дан по поколению g3; база с тех пор обновлена (сейчас g5).")).toBeInTheDocument();
    expect(screen.getByText(/Ответ скрыт: часть его источников вам сейчас недоступна/)).toBeInTheDocument();
    expect(screen.getAllByText("Подтверждено источниками")).toHaveLength(1);
    expect(posts(calls)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Задать вопрос заново" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({ question: "Что в закрытом плане?", conversation_id: CONV });
  });

  it("«Удалить диалог» asks first, deletes it on the server and opens an empty dialog", async () => {
    const calls = mockApi(
      baseRoutes([
        { path: `/api/assistant/conversations/${CONV}`, body: storedConversation() },
        { method: "DELETE", path: `/api/assistant/conversations/${CONV}`, status: 204 },
      ]),
    );
    renderApp(`/ask?c=${CONV}`);
    await screen.findByText("Подтверждено источниками");
    await userEvent.click(screen.getByRole("button", { name: "Удалить диалог" }));
    expect(screen.getByText(/Удалить этот диалог из истории\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Удалить диалог" }));
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(router.location).toBe("/ask"));
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/assistant/conversations/${CONV}`]);
    expect(screen.queryByRole("region", { name: "Диалог" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Спросить базу знаний" })).toBeInTheDocument();
  });

  it("a conversation the history does not have (deleted, another browser) is said, not invented", async () => {
    const calls = mockApi(baseRoutes([streamRoute()]));
    renderApp(`/ask?c=${CONV}`);
    expect(await screen.findByText(/Этого диалога нет в истории этого браузера/)).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });

  it("plain /ask (a link from another section) continues this tab's dialog; «Новый диалог» starts an empty one", async () => {
    const calls = mockApi(baseRoutes([streamRoute()]));
    renderApp("/ask");
    await userEvent.type(screen.getByLabelText("Вопрос"), `${QUESTION}{Enter}`);
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    await go("/documents");
    await go("/ask");
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    await waitFor(() => expect(search()).toMatch(/^\?c=conv-/));
    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Диалог" })).toBeNull());
    expect(posts(calls)).toHaveLength(1);
  });
});
