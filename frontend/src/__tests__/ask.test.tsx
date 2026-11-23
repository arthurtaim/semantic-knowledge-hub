import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError, api } from "../api/client";
import type { AskResponse, AskStreamEvent } from "../api/types";
import { AskPage } from "../pages/AskPage";
import { insufficientAnswer, supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, type MockRoute, type RecordedCall } from "./helpers";

const STREAM = "/api/assistant/ask/stream";

/** A stream route that answers every request with the given events at once (as the mock provider does). */
function streamRoute(...events: (object | string)[]): MockRoute {
  return {
    method: "POST",
    path: STREAM,
    respond: (init) => {
      const stream = ndjsonStream();
      const response = stream.respond(init);
      stream.push(...events);
      stream.close();
      return response;
    },
  };
}

/** The event sequence of the mock provider: status stages and the validated answer, no deltas. */
const mockEvents = (response: AskResponse): AskStreamEvent[] => [
  { type: "status", stage: "retrieving" },
  { type: "status", stage: "generating", passages: response.citations.length, provider: "mock" },
  { type: "status", stage: "validating" },
  { type: "final", response },
];

const claudeAnswer: AskResponse = { ...supportedAnswer, mode: "claude_cli", warnings: [] };
const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);
const send = (stream: ReturnType<typeof ndjsonStream>, ...events: (object | string)[]) =>
  act(async () => {
    stream.push(...events);
  });

describe("Ask the knowledge base", () => {
  it("shows a grounded demo answer with clickable citations", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "What layers does the architecture have?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));

    expect(await screen.findByText("Подтверждено источником")).toBeInTheDocument();
    expect(screen.getByText("Демо-режим, без языковой модели")).toBeInTheDocument();
    const marker = screen.getByRole("link", { name: "Источник 1" });
    expect(marker).toHaveAttribute("href", "#cite-1-1");
    expect(document.getElementById("cite-1-1")).toHaveTextContent("This local demonstration models");
    const source = screen.getByRole("link", { name: "Semantic Layer — demonstration architecture" });
    expect(source).toHaveAttribute("href", "/documents/SEM-ARCH-001#semantic-layer-demonstration-architecture");
    expect(screen.getByText("Корпоративные источники не подключены.")).toBeInTheDocument();

    const request = posts(calls)[0];
    expect(request?.headers["X-SKH-Client"]).toBe("web");
    expect(request?.headers.Accept).toBe("application/x-ndjson");
    expect(request?.body).toEqual({
      question: "What layers does the architecture have?",
      sources: ["team"],
      include_drafts: false,
      include_deprecated: false,
      history: [],
    });
  });

  it("states insufficient evidence and lists excluded drafts", async () => {
    mockApi([streamRoute({ type: "status", stage: "retrieving" }, { type: "final", response: insufficientAnswer })]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.click(screen.getByRole("button", { name: "Какой SLA у интеграции с ЦФТ?" }));
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByText("Недостаточно данных")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Источники" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Не использованы как доказательство" })).toBeInTheDocument();
    expect(screen.getByText("Подтверждений в доступных источниках не найдено.")).toBeInTheDocument();
    expect(screen.getByText(/Не найдено в источниках/)).toHaveTextContent("«ЦФТ»");
  });

  it("submits with Ctrl+Enter from the question field and clears it after the validated answer", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    const field = screen.getByLabelText("Вопрос");
    expect(field).toHaveAccessibleDescription(/Ctrl\+Enter/);
    await userEvent.type(field, "Что такое ревизия?");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Подтверждено источником")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(1);
    expect(field).toHaveValue("");
    expect(screen.getByText("Что такое ревизия?")).toBeInTheDocument(); // the question stays in the conversation
  });

  it("states near the top of the answer that corporate sources were not used", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои у архитектуры?");
    await userEvent.click(screen.getByLabelText("Оба"));
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByText("Корпоративные источники не использованы.")).toBeInTheDocument();
    expect(screen.getByText(/ответ построен только по документам команды/)).toBeInTheDocument();
    expect(posts(calls)[0]?.body).toMatchObject({ sources: ["team", "corporate"] });
  });

  it("prefills the question from the home page search", () => {
    mockApi([]);
    renderAt("/ask?q=FTS5", "/ask", <AskPage />);
    expect(screen.getByLabelText("Вопрос")).toHaveValue("FTS5");
  });

  it("explains that corporate sources are not connected", async () => {
    mockApi([]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.click(screen.getByLabelText("Оба"));
    expect(screen.getByText(/Корпоративные источники \(Confluence Data Center\) не подключены/)).toBeInTheDocument();
  });

  it("validates the question length before calling the API", async () => {
    const calls = mockApi([]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("не менее 3 символов");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a disabled assistant clearly (HTTP 503 before the stream) and keeps the question", async () => {
    mockApi([
      {
        method: "POST",
        path: STREAM,
        status: 503,
        body: { code: "assistant_disabled", message: "Ассистент отключён конфигурацией.", request_id: "r" },
      },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Что такое ревизия?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByText("Интеграция недоступна")).toBeInTheDocument();
    expect(screen.getByText("Ассистент отключён конфигурацией.")).toBeInTheDocument();
    expect(screen.getByLabelText("Вопрос")).toHaveValue("Что такое ревизия?");

    mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    await userEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));
    expect(await screen.findByText("Подтверждено источником")).toBeInTheDocument();
    expect(screen.queryByText("Интеграция недоступна")).toBeNull();
    expect(screen.getByLabelText("Вопрос")).toHaveValue("");
  });
});

describe("Streaming answers", () => {
  it("shows the stages and the preliminary text, then replaces it with the validated answer", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои у архитектуры?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));

    expect(await screen.findByText("Ищем источники…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отменить" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ищем подтверждения…" })).toBeDisabled();

    await send(stream, { type: "status", stage: "retrieving" });
    await send(stream, { type: "status", stage: "generating", passages: 5, provider: "claude_cli" });
    expect(await screen.findByText("Claude формирует ответ… (найдено 5 фрагментов)")).toBeInTheDocument();

    // A line split across chunks is buffered until its newline arrives.
    await send(stream, '{"type":"delta","te', 'xt":"Слоёв четыре [C1]"}\n', { type: "delta", text: ", включая витрину." });
    const label = await screen.findByText("Предварительный текст модели — цитаты ещё не проверены");
    const preliminary = label.closest("section") as HTMLElement;
    expect(preliminary).toHaveAttribute("aria-live", "polite");
    expect(within(preliminary).getByText("Слоёв четыре [C1], включая витрину.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ответ" })).toBeNull();

    await send(stream, { type: "status", stage: "validating" });
    expect(await screen.findByText("Проверяем цитаты…")).toBeInTheDocument();
    await send(stream, { type: "final", response: claudeAnswer });
    stream.close();

    expect(await screen.findByRole("heading", { name: "Ответ" })).toBeInTheDocument();
    expect(screen.getByText("Подтверждено источником")).toBeInTheDocument();
    expect(screen.getByText("Claude Code CLI (личный тест), цитаты сверены с источниками")).toBeInTheDocument();
    expect(screen.queryByText("Предварительный текст модели — цитаты ещё не проверены")).toBeNull();
    expect(screen.queryByText(/Слоёв четыре/)).toBeNull();
    expect(screen.queryByText("Проверяем цитаты…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Спросить" })).toBeEnabled();
  });

  it("uses a provider-neutral stage text for other providers", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои у архитектуры?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    await send(stream, { type: "status", stage: "generating", passages: 1, provider: "internal_api" });
    expect(await screen.findByText("Формируем ответ… (найден 1 фрагмент)")).toBeInTheDocument();
    await send(stream, { type: "final", response: { ...supportedAnswer, mode: "internal_api" } });
    expect(await screen.findByText("Внутренняя модель, цитаты сверены с источниками")).toBeInTheDocument();
  });

  it("keeps the question and offers a retry when the stream ends with an error event", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    const field = screen.getByLabelText("Вопрос");
    await userEvent.type(field, "Какие слои у архитектуры?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    await send(
      stream,
      { type: "status", stage: "retrieving" },
      { type: "status", stage: "generating", passages: 2, provider: "claude_cli" },
      { type: "delta", text: "Черновой текст модели" },
    );
    expect(await screen.findByText("Черновой текст модели")).toBeInTheDocument();
    await send(stream, {
      type: "error",
      code: "ai_timeout",
      message: "Claude Code не ответил за отведённое время.",
      status: 503,
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Модель не ответила вовремя");
    expect(alert).toHaveTextContent("Claude Code не ответил за отведённое время.");
    expect(screen.queryByText("Черновой текст модели")).toBeNull();
    expect(screen.queryByText("Предварительный текст модели — цитаты ещё не проверены")).toBeNull();
    expect(field).toHaveValue("Какие слои у архитектуры?");

    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    await userEvent.click(within(alert).getByRole("button", { name: "Повторить запрос" }));
    expect(await screen.findByText("Подтверждено источником")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("Какие слои у архитектуры?")).toHaveLength(1); // the failed turn was replaced
    expect(posts(calls)[0]?.body).toMatchObject({ question: "Какие слои у архитектуры?", history: [] });
  });

  it("cancels a running request: aborts the fetch, marks the turn and restores the question", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    const field = screen.getByLabelText("Вопрос");
    await userEvent.type(field, "Какие слои у архитектуры?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    await send(stream, { type: "status", stage: "generating", passages: 3, provider: "claude_cli" }, { type: "delta", text: "Начало ответа" });
    expect(await screen.findByText("Начало ответа")).toBeInTheDocument();
    await userEvent.clear(field); // even a cleared field gets the question back

    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(await screen.findByText(/Запрос отменён/)).toBeInTheDocument();
    expect(stream.state.aborted).toBe(true);
    expect(field).toHaveValue("Какие слои у архитектуры?");
    expect(screen.queryByText("Начало ответа")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Спросить" })).toBeEnabled();
  });

  it("sends the previous validated answers as history; failed turns are excluded and answers truncated", async () => {
    const longAnswer: AskResponse = { ...supportedAnswer, answer: `${"А".repeat(4500)} [1]` };
    let calls = mockApi([streamRoute(...mockEvents(longAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    const field = screen.getByLabelText("Вопрос");
    await userEvent.type(field, "Какие слои у архитектуры?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByRole("heading", { name: "Ответ" })).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(/с учётом 1 предыдущего ответа/);

    // A failed follow-up is not context for the next question.
    calls = mockApi([
      streamRoute({ type: "error", code: "ai_busy", message: "Ассистент занят другим запросом. Подождите.", status: 429 }),
    ]);
    await userEvent.type(field, "А какие у неё ограничения?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByText("Ассистент занят другим запросом. Подождите.")).toBeInTheDocument();
    expect(posts(calls)[0]?.body).toMatchObject({
      question: "А какие у неё ограничения?",
      history: [{ question: "Какие слои у архитектуры?", answer: "А".repeat(4000) }],
    });

    calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    await userEvent.clear(field);
    await userEvent.type(field, "А что с витриной?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Ответ" })).toHaveLength(2));
    expect(screen.queryByText("А какие у неё ограничения?")).toBeNull(); // the failed turn was replaced
    expect(posts(calls)[0]?.body).toMatchObject({
      question: "А что с витриной?",
      history: [{ question: "Какие слои у архитектуры?", answer: "А".repeat(4000) }],
    });
    // Ids stay unique per turn and the markers point at their own turn.
    expect(document.getElementById("answer-title-1")).toHaveTextContent("Ответ");
    expect(document.getElementById("answer-title-2")).toHaveTextContent("Ответ");
    const markers = screen.getAllByRole("link", { name: "Источник 1" });
    expect(markers.map((m) => m.getAttribute("href"))).toEqual(["#cite-1-1", "#cite-2-1"]);
    expect(document.getElementById("cite-2-1")).toBeInTheDocument();
  });

  it("keeps at most the last 6 completed turns as history", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    const field = screen.getByLabelText("Вопрос");
    for (let n = 1; n <= 8; n += 1) {
      await userEvent.type(field, `Тема номер ${n}`);
      await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
      await waitFor(() => expect(screen.getAllByRole("heading", { name: "Ответ" })).toHaveLength(n));
    }
    const historyOf = (index: number) =>
      (posts(calls)[index]?.body as { history: { question: string }[] }).history.map((turn) => turn.question);
    expect(historyOf(6)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Тема номер ${n}`));
    // The 8th question sees 7 completed turns but sends only the last 6, oldest first.
    expect(historyOf(7)).toEqual([2, 3, 4, 5, 6, 7].map((n) => `Тема номер ${n}`));
  });

  it("starts a new conversation without history", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    const field = screen.getByLabelText("Вопрос");
    expect(screen.queryByRole("button", { name: "Новый диалог" })).toBeNull();
    await userEvent.type(field, "Какие слои у архитектуры?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByRole("heading", { name: "Ответ" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    expect(screen.queryByRole("heading", { name: "Ответ" })).toBeNull();
    expect(screen.queryByText("Какие слои у архитектуры?")).toBeNull();
    expect(field).toHaveFocus();

    await userEvent.type(field, "Где хранится база знаний?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByRole("heading", { name: "Ответ" })).toBeInTheDocument();
    expect(posts(calls)[1]?.body).toMatchObject({ question: "Где хранится база знаний?", history: [] });
  });
});

describe("api.askStream", () => {
  const payload = { question: "Что такое ревизия?", sources: ["team" as const], include_drafts: false, include_deprecated: false };

  it("reports every event in order and resolves with the final answer", async () => {
    mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    const seen: string[] = [];
    const answer = await api.askStream(payload, { onEvent: (e) => seen.push(e.type === "status" ? e.stage : e.type) });
    expect(seen).toEqual(["retrieving", "generating", "validating", "final"]);
    expect(answer).toEqual(supportedAnswer);
  });

  it("rejects a stream that ends without a terminal event", async () => {
    mockApi([streamRoute({ type: "status", stage: "retrieving" })]);
    await expect(api.askStream(payload)).rejects.toMatchObject({ code: "stream_incomplete" });
  });

  it("rejects a broken line as an invalid stream", async () => {
    mockApi([streamRoute("not json\n")]);
    const error = await api.askStream(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "invalid_stream", status: 502 });
  });

  it("turns an aborted signal into a cancellation", async () => {
    mockApi([]);
    const controller = new AbortController();
    controller.abort();
    await expect(api.askStream(payload, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
      message: "Запрос отменён.",
    });
  });
});
