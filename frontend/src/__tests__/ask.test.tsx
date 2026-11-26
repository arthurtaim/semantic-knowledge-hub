import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError, api } from "../api/client";
import type { AskResponse, AskStreamEvent, Citation } from "../api/types";
import { AskPage } from "../pages/AskPage";
import { insufficientAnswer, session, supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

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

// UI v2: the question field is the Composer (label «Вопрос»); its send button is «Отправить», Enter sends.
const field = () => screen.getByLabelText("Вопрос");
const sendButton = () => screen.getByRole("button", { name: "Отправить" });

/** «Где искать» is a small panel of the composer: open it, choose, close it. */
async function chooseScope(label: "Команда" | "Корпоративные" | "Оба") {
  await userEvent.click(screen.getByRole("button", { name: /^Где искать:/ }));
  await userEvent.click(screen.getByRole("radio", { name: label }));
  await userEvent.keyboard("{Escape}");
}

describe("Asking from «Спросить или найти» (?run=1)", () => {
  it("asks once at once in the chosen scope; the URL then names the new dialog (?c=), not the question", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderRoutes("/ask?q=%D0%93%D0%B4%D0%B5%20%D0%B1%D0%B0%D0%B7%D0%B0%3F&run=1&scope=both", { "/ask": <AskPage /> });
    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.body).toMatchObject({ question: "Где база?", sources: ["team", "corporate"] });
    // react-router applies the URL change in a transition: it may land after the answer renders.
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("run=1"));
    // Back, Forward or a reload open this dialog (chat history) — they never ask the question again.
    const conversation = (posts(calls)[0]?.body as { conversation_id: string }).conversation_id;
    expect(screen.getByTestId("location")).toHaveTextContent(`/ask?c=${conversation}`);
    expect(screen.getByLabelText("Оба")).toBeChecked();
  });

  it("does not ask when the AI is disabled; the question stays in the field", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    const disabled = { ...session, features: { ...session.features, ai_mode: "disabled" as const } };
    renderRoutes("/ask?q=%D0%93%D0%B4%D0%B5%20%D0%B1%D0%B0%D0%B7%D0%B0%3F&run=1", { "/ask": <AskPage /> }, disabled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts(calls)).toHaveLength(0);
  });
});

describe("Ask the knowledge base", () => {
  it("shows a grounded demo answer with clickable citations", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "What layers does the architecture have?");
    await userEvent.click(sendButton());

    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(screen.getByText("Без языковой модели: дословные выдержки")).toBeInTheDocument();
    // The marker opens the cited document at the cited section (evidence first: the quote is listed above).
    const marker = screen.getByRole("link", { name: "Источник 1" });
    expect(marker).toHaveAttribute("href", "/documents/SEM-ARCH-001#semantic-layer-demonstration-architecture");
    expect(document.getElementById("cite-1-1")).toHaveTextContent("This local demonstration models");
    const source = screen.getByRole("link", { name: "Semantic Layer — demonstration architecture" });
    expect(source).toHaveAttribute("href", "/documents/SEM-ARCH-001#semantic-layer-demonstration-architecture");

    const request = posts(calls)[0];
    expect(request?.headers["X-SKH-Client"]).toBe("web");
    expect(request?.headers.Accept).toBe("application/x-ndjson");
    // The v0.3 body plus the dialog id; no skill, files or documents were chosen.
    expect(request?.body).toEqual({
      question: "What layers does the architecture have?",
      sources: ["team"],
      include_drafts: false,
      include_deprecated: false,
      history: [],
      conversation_id: expect.stringMatching(/^conv-[0-9a-f]{24}$/),
    });
  });

  it("states insufficient evidence and lists excluded drafts", async () => {
    mockApi([streamRoute({ type: "status", stage: "retrieving" }, { type: "final", response: insufficientAnswer })]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.click(screen.getByRole("button", { name: "Какой SLA у интеграции с ЦФТ?" }));
    await userEvent.click(sendButton());
    expect(await screen.findByText("Недостаточно данных")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Источники" })).toBeNull();
    // Excluded documents are folded into one line.
    expect(screen.getByText("1 документ не использован: черновик.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(screen.getByRole("list", { name: "Не использованы как доказательство" })).toHaveTextContent("ARIS integration");
    expect(screen.getByText("Подтверждений в доступных источниках не найдено.")).toBeInTheDocument();
    expect(screen.getByText(/Не найдено в источниках/)).toHaveTextContent("«ЦФТ»");
  });

  it("sends with Enter (Ctrl+Enter too) and clears the field after the validated answer", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Что такое ревизия?");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(1);
    expect(field()).toHaveValue("");
    // the question stays in the conversation, as the user's message
    expect(within(screen.getByRole("region", { name: "Диалог" })).getByText("Что такое ревизия?")).toHaveClass("turn__bubble");
  });

  it("states near the top of the answer that corporate sources were not used", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await chooseScope("Оба");
    await userEvent.click(sendButton());
    expect(await screen.findByText("Корпоративные источники не использованы.")).toBeInTheDocument();
    expect(screen.getByText(/ответ построен только по документам команды/)).toBeInTheDocument();
    expect(posts(calls)[0]?.body).toMatchObject({ sources: ["team", "corporate"] });
  });

  it("prefills the question from the home page search", () => {
    mockApi([]);
    renderAt("/ask?q=FTS5", "/ask", <AskPage />);
    expect(field()).toHaveValue("FTS5");
  });

  it("explains that corporate sources are not connected", async () => {
    mockApi([]);
    renderAt("/ask", "/ask", <AskPage />);
    await chooseScope("Оба");
    expect(screen.getByText(/Корпоративные источники \(Confluence Data Center\) не подключены — ответ будет/)).toBeInTheDocument();
  });

  it("validates the question length before calling the API; an empty field cannot be sent", async () => {
    const calls = mockApi([]);
    renderAt("/ask", "/ask", <AskPage />);
    expect(sendButton()).toBeDisabled();
    await userEvent.type(field(), "аб{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("не менее 3 символов");
    expect(calls.filter((c) => c.url === STREAM)).toHaveLength(0);
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
    await userEvent.type(field(), "Что такое ревизия?");
    await userEvent.click(sendButton());
    expect(await screen.findByText("Ассистент отключён")).toBeInTheDocument();
    expect(screen.getByText("Ассистент отключён конфигурацией.")).toBeInTheDocument();
    expect(field()).toHaveValue("Что такое ревизия?");

    mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    await userEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(screen.queryByText("Ассистент отключён")).toBeNull();
    expect(field()).toHaveValue("");
  });
});

describe("Streaming answers", () => {
  it("shows the stages and the preliminary text, then replaces it with the validated answer", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await userEvent.click(sendButton());

    expect(await screen.findByText("Ищу источники…")).toBeInTheDocument();
    // While the answer runs, the send button is «Отменить».
    expect(screen.getByRole("button", { name: "Отменить" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Отправить" })).toBeNull();

    await send(stream, { type: "status", stage: "retrieving" });
    await send(stream, { type: "status", stage: "generating", passages: 5, provider: "claude_cli" });
    expect(await screen.findByText("Формулирую ответ с Claude Code CLI… (найдено 5 фрагментов)")).toBeInTheDocument();

    // A line split across chunks is buffered until its newline arrives.
    await send(stream, '{"type":"delta","te', 'xt":"Слоёв четыре [C1]"}\n', { type: "delta", text: ", включая витрину." });
    const label = await screen.findByText("Предварительный текст модели — цитаты ещё не проверены");
    const preliminary = label.closest("section") as HTMLElement;
    expect(preliminary).toHaveAttribute("aria-live", "polite");
    expect(within(preliminary).getByText("Слоёв четыре [C1], включая витрину.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ассистент" })).toBeNull();

    await send(stream, { type: "status", stage: "validating" });
    expect(await screen.findByText("Проверяю цитаты…")).toBeInTheDocument();
    await send(stream, { type: "final", response: claudeAnswer });
    stream.close();

    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(screen.getByText("Подтверждено источниками")).toBeInTheDocument();
    expect(screen.getByText("Claude Code CLI (личный тест), цитаты сверены с источниками")).toBeInTheDocument();
    expect(screen.queryByText("Предварительный текст модели — цитаты ещё не проверены")).toBeNull();
    expect(screen.queryByText(/Слоёв четыре/)).toBeNull();
    expect(screen.queryByText("Проверяю цитаты…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(sendButton()).toBeInTheDocument();
  });

  it("uses a provider-neutral stage text for other providers", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await userEvent.click(sendButton());
    await send(stream, { type: "status", stage: "generating", passages: 1, provider: "internal_api" });
    expect(await screen.findByText("Формулирую ответ… (найден 1 фрагмент)")).toBeInTheDocument();
    await send(stream, { type: "final", response: { ...supportedAnswer, mode: "internal_api" } });
    expect(await screen.findByText("Внутренняя модель, цитаты сверены с источниками")).toBeInTheDocument();
  });

  it("keeps the question and offers a retry when the stream ends with an error event", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await userEvent.click(sendButton());
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
    expect(field()).toHaveValue("Какие слои у архитектуры?");

    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    await userEvent.click(within(alert).getByRole("button", { name: "Повторить запрос" }));
    expect(await screen.findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // the failed turn was replaced
    expect(within(screen.getByRole("region", { name: "Диалог" })).getAllByText("Какие слои у архитектуры?")).toHaveLength(1);
    expect(posts(calls)[0]?.body).toMatchObject({ question: "Какие слои у архитектуры?", history: [] });
  });

  it("cancels a running request: aborts the fetch, marks the turn and restores the question", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await userEvent.click(sendButton());
    await send(stream, { type: "status", stage: "generating", passages: 3, provider: "claude_cli" }, { type: "delta", text: "Начало ответа" });
    expect(await screen.findByText("Начало ответа")).toBeInTheDocument();
    await userEvent.clear(field()); // even a cleared field gets the question back

    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(await screen.findByText(/Запрос отменён/)).toBeInTheDocument();
    expect(stream.state.aborted).toBe(true);
    expect(field()).toHaveValue("Какие слои у архитектуры?");
    expect(screen.queryByText("Начало ответа")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(sendButton()).toBeEnabled();
  });

  it("sends the previous validated answers as history; failed turns are excluded and answers truncated", async () => {
    const longAnswer: AskResponse = { ...supportedAnswer, answer: `${"А".repeat(4500)} [1]` };
    let calls = mockApi([streamRoute(...mockEvents(longAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await userEvent.click(sendButton());
    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(field()).toHaveAccessibleDescription(/С учётом 1 предыдущего ответа/);

    // A failed follow-up is not context for the next question.
    calls = mockApi([
      streamRoute({ type: "error", code: "ai_busy", message: "Ассистент занят другим запросом. Подождите.", status: 429 }),
    ]);
    await userEvent.type(field(), "А какие у неё ограничения?");
    await userEvent.click(sendButton());
    // «busy» is a conflict, not a failure: amber, with a retry.
    expect(await screen.findByText("Ассистент занят другим запросом. Подождите.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("turn__conflict");
    expect(posts(calls)[0]?.body).toMatchObject({
      question: "А какие у неё ограничения?",
      history: [{ question: "Какие слои у архитектуры?", answer: "А".repeat(4000) }],
    });

    calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    await userEvent.clear(field());
    await userEvent.type(field(), "А что с витриной?");
    await userEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Ассистент" })).toHaveLength(2));
    expect(screen.queryByText("А какие у неё ограничения?")).toBeNull(); // the failed turn was replaced
    expect(posts(calls)[0]?.body).toMatchObject({
      question: "А что с витриной?",
      history: [{ question: "Какие слои у архитектуры?", answer: "А".repeat(4000) }],
    });
    // Ids stay unique per turn and the markers point at their own turn.
    expect(document.getElementById("answer-title-1")).toHaveTextContent("Ассистент");
    expect(document.getElementById("answer-title-2")).toHaveTextContent("Ассистент");
    // Markers open the cited document; each has its own passage card, and each turn its own evidence anchors.
    const markers = screen.getAllByRole("link", { name: "Источник 1" });
    const cards = markers.map((m) => m.getAttribute("aria-describedby"));
    expect(markers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cards).size).toBe(markers.length);
    expect(document.getElementById("cite-1-1")).toBeInTheDocument();
    expect(document.getElementById("cite-2-1")).toBeInTheDocument();
  });

  it("keeps at most the last 6 completed turns as history", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    for (let n = 1; n <= 8; n += 1) {
      await userEvent.type(field(), `Тема номер ${n}`);
      await userEvent.click(sendButton());
      await waitFor(() => expect(screen.getAllByRole("heading", { name: "Ассистент" })).toHaveLength(n));
    }
    const historyOf = (index: number) =>
      (posts(calls)[index]?.body as { history: { question: string }[] }).history.map((turn) => turn.question);
    expect(historyOf(6)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Тема номер ${n}`));
    // The 8th question sees 7 completed turns but sends only the last 6, oldest first.
    expect(historyOf(7)).toEqual([2, 3, 4, 5, 6, 7].map((n) => `Тема номер ${n}`));
  });

  it("starts a new conversation (a new dialog id) without history", async () => {
    const calls = mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "Какие слои у архитектуры?");
    await userEvent.click(sendButton());
    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    expect(screen.queryByRole("heading", { name: "Ассистент" })).toBeNull();
    expect(screen.queryByText("Какие слои у архитектуры?")).toBeNull();
    expect(field()).toHaveFocus();

    await userEvent.type(field(), "Где хранится база знаний?");
    await userEvent.click(sendButton());
    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(posts(calls)[1]?.body).toMatchObject({ question: "Где хранится база знаний?", history: [] });
    const ids = posts(calls).map((c) => (c.body as { conversation_id: string }).conversation_id);
    expect(ids[0]).not.toBe(ids[1]);
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

  it("M5.7: passes the model round and the tool events on; a malformed tool event is skipped, not fatal", async () => {
    const step = { call_id: "T1", round: 1, tool: "catalog_query", operation: "count", outcome: "ok", duration_ms: 0, result_count: 83, fact_ref: "F1", error_code: null, message: null };
    mockApi([
      streamRoute(
        { type: "status", stage: "generating", round: 1, passages: 2, provider: "claude_cli" },
        { type: "tool_call", call_id: "T1", round: 1, tool: "catalog_query", operation: "count" },
        { type: "tool_call", round: 1 },
        { type: "tool_result", call_id: "T1", step },
        { type: "status", stage: "generating", round: 2, passages: 2, provider: "claude_cli" },
        { type: "final", response: supportedAnswer },
      ),
    ]);
    const seen: AskStreamEvent[] = [];
    await api.askStream(payload, { onEvent: (e) => seen.push(e) });
    expect(seen.map((e) => e.type)).toEqual(["status", "tool_call", "tool_result", "status", "final"]);
    expect(seen[0]).toMatchObject({ stage: "generating", round: 1 });
    expect(seen[1]).toEqual({ type: "tool_call", call_id: "T1", round: 1, tool: "catalog_query", operation: "count" });
    expect(seen[2]).toEqual({ type: "tool_result", call_id: "T1", step });
    expect(seen[3]).toMatchObject({ stage: "generating", round: 2 });
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

// --- M5.6: Confluence evidence, relevance feedback, the evidence graph link ---

const TRACE = "TRACE-0123456789abcdef";

function confluenceCitation(ref: number, page: string, version: string, status: "approved" | "draft" | "unknown"): Citation {
  return {
    ref,
    source_type: "confluence",
    document_id: page,
    title: page === "200101" ? "Регламент заморозки изменений метаданных (демо)" : "Чек-лист ввода новой интеграции (демо)",
    source_uri: `mock-confluence://OPS/${page}`,
    revision: version,
    status: null,
    section: ref === 2 ? "Назначение" : "Когда действует заморозка",
    section_anchor: null,
    excerpt: `Выдержка ${ref}`,
    retrieved_at: "2026-11-23T12:00:00Z",
    is_demo: true,
    app_path: `/corporate/${page}`,
    source_kind: "confluence_mcp",
    source_id: `confluence:demo-wiki:${page}:${version}`,
    external_status: status,
    fragment_id: `s${ref}`,
    content_hash: "d11b9400f5fd",
  };
}

const externalAnswer: AskResponse = {
  ...supportedAnswer,
  answer: "Без языковой модели: дословные выдержки.\n\n1. «Выдержка 1» [1]\n2. «Выдержка 2» [2]\n3. «Выдержка 3» [3]",
  citations: [
    confluenceCitation(1, "200101", "3", "unknown"),
    confluenceCitation(2, "200101", "3", "unknown"),
    confluenceCitation(3, "200105", "2", "approved"),
  ],
  scopes: [
    { scope: "team", state: "connected", message: "Локальный workspace с демо-документами." },
    { scope: "corporate", state: "mock", message: "Mock-коннектор." },
  ],
  retrieval_trace_id: TRACE,
  index_generation: "g1",
  instructions_version: "-",
  external: {
    called: true,
    trigger: "low_term_coverage",
    candidates: 10,
    fetched: 2,
    cache_hits: 1,
    mcp_calls: 3,
    fragments: 4,
    rejected: [],
    degraded: false,
    elapsed_ms: 12.5,
    policy_version: "ext-v1",
  },
};

async function askExternal() {
  await userEvent.type(field(), "Когда действует окно заморозки?");
  await chooseScope("Оба");
  await userEvent.click(sendButton());
  return screen.findByText("Подтверждено источниками");
}

describe("Ask: Confluence evidence and the answer graph", () => {
  it("names the LOCAL_SUFFICIENCY v2 reason in words, not as a code", async () => {
    const external = externalAnswer.external;
    if (!external) throw new Error("fixture without an external block");
    const answer: AskResponse = { ...externalAnswer, external: { ...external, trigger: "specific_terms_not_covered" } };
    mockApi([streamRoute(...mockEvents(answer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await askExternal();

    expect(
      screen.getByText(
        "Внешний источник: запрос к Confluence (причина: в документах команды нет ключевого слова вопроса), загружено 2 стр., из кэша 1",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/specific_terms_not_covered/)).not.toBeInTheDocument();
  });

  it("labels Confluence citations with the page version and an unconfirmed status, and links the answer graph", async () => {
    mockApi([streamRoute(...mockEvents(externalAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await askExternal();

    expect(screen.getByRole("link", { name: "Граф ответа" })).toHaveAttribute("href", `/graph?trace=${TRACE}`);
    expect(
      screen.getByText(
        "Внешний источник: запрос к Confluence (причина: недостаточно данных в документах команды), загружено 2 стр., из кэша 1",
      ),
    ).toBeInTheDocument();
    const first = document.getElementById("cite-1-1") as HTMLElement;
    expect(within(first).getByText("Confluence · версия 3")).toBeInTheDocument();
    expect(within(first).getByText("статус не подтверждён")).toBeInTheDocument();
    const approved = document.getElementById("cite-1-3") as HTMLElement;
    expect(within(approved).getByText("Confluence · версия 2")).toBeInTheDocument();
    expect(within(approved).queryByText("статус не подтверждён")).toBeNull();
    // one set of controls per Confluence page, not per quoted fragment
    expect(screen.getAllByRole("button", { name: "Подошёл" })).toHaveLength(2);
    expect(within(document.getElementById("cite-1-2") as HTMLElement).queryByRole("button", { name: "Подошёл" })).toBeNull();
  });

  it("sends optional relevance feedback for one source and shows the server note", async () => {
    const calls = mockApi([
      streamRoute(...mockEvents(externalAnswer)),
      {
        method: "POST",
        path: "/api/discovery/feedback",
        body: { recorded: true, note: "Отзыв учтён для похожих вопросов. Статус и права доступа документа не меняются." },
      },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await askExternal();
    const group = screen.getByRole("group", { name: "Оценка источника «Регламент заморозки изменений метаданных (демо)»" });
    const relevant = within(group).getByRole("button", { name: "Подошёл" });
    expect(relevant).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(relevant);
    expect(await within(group).findByText(/Отзыв учтён для похожих вопросов/)).toBeInTheDocument();
    expect(relevant).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Не подошёл" })).toHaveAttribute("aria-pressed", "false");
    const feedback = calls.filter((c) => c.method === "POST" && c.url === "/api/discovery/feedback");
    expect(feedback.map((c) => c.body)).toEqual([
      { trace_id: TRACE, source_id: "confluence:demo-wiki:200101:3", verdict: "relevant" },
    ]);
    expect(feedback[0]?.headers["X-SKH-Client"]).toBe("web");
  });

  it("keeps the answer when feedback fails", async () => {
    mockApi([
      streamRoute(...mockEvents(externalAnswer)),
      {
        method: "POST",
        path: "/api/discovery/feedback",
        status: 404,
        body: { code: "discovery_link_not_found", message: "Источник этого ответа не найден или срок хранения истёк.", request_id: "f" },
      },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await askExternal();
    const group = screen.getByRole("group", { name: "Оценка источника «Чек-лист ввода новой интеграции (демо)»" });
    await userEvent.click(within(group).getByRole("button", { name: "Не подошёл" }));
    expect(await within(group).findByText(/Отзыв не сохранён: Источник этого ответа не найден/)).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Не подошёл" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Подтверждено источниками")).toBeInTheDocument();
  });

  it("proposes a Confluence page as a draft and opens the proposal", async () => {
    const calls = mockApi([
      streamRoute(...mockEvents(externalAnswer)),
      { method: "POST", path: "/api/discovery/propose", status: 201, body: { id: "c".repeat(32) } },
    ]);
    renderRoutes("/ask", { "/ask": <AskPage />, "/proposals/:id": <p>Страница предложения</p> });
    await askExternal();
    const group = screen.getByRole("group", { name: "Оценка источника «Регламент заморозки изменений метаданных (демо)»" });
    await userEvent.click(within(group).getByRole("button", { name: "Предложить в базу" }));
    expect(await screen.findByText("Страница предложения")).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe(`/proposals/${"c".repeat(32)}`);
    expect(calls.filter((c) => c.url === "/api/discovery/propose").map((c) => c.body)).toEqual([
      { trace_id: TRACE, source_id: "confluence:demo-wiki:200101:3" },
    ]);
  });

  it("shows no graph link or feedback controls for an answer without a trace", async () => {
    mockApi([streamRoute(...mockEvents(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(field(), "What layers?");
    await userEvent.click(sendButton());
    await screen.findByText("Подтверждено источниками");
    expect(screen.queryByRole("link", { name: "Граф ответа" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Подошёл" })).toBeNull();
    expect(screen.queryByText(/Внешний источник: запрос к Confluence/)).toBeNull();
  });
});
