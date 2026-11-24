import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProposal, AskResponse, AskStreamEvent, Citation, SystemFact, ToolStepInfo } from "../api/types";
import { answerWithSources } from "../components/AnswerParts";
import type { Turn } from "../components/AssistantTurn";
import { failedChecks, factLabels, factValueText, filtersText, toolActivity } from "../lib/systemFacts";
import { historyFrom } from "../lib/useAssistantTurns";
import { AskPage } from "../pages/AskPage";
import { supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, type MockRoute, type RecordedCall } from "./helpers";

/*
 * M5.7 (docs/AI_NATIVE_TOOLS.md, spec §04 «UI v2 — minimal changes only»): system facts of an AI-native answer are
 * shown as «По данным реестра SKH» cards with the server's value; `[F1]` becomes a marker leading to its card;
 * general knowledge is labelled; follow-ups send the referent back; tool rounds never glue preliminary texts;
 * unavailable, zero and not found stay different things.
 */

const STREAM = "/api/assistant/ask/stream";

function streamRoute(...events: AskStreamEvent[]): MockRoute {
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

const final = (response: AskResponse): AskStreamEvent[] => [{ type: "final", response }];
const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);

async function ask(question = "Сколько документов в базе?") {
  const field = screen.getByLabelText("Вопрос");
  await userEvent.type(field, question);
  await userEvent.keyboard("{Enter}");
  return (await screen.findAllByRole("heading", { name: "Ассистент" })).at(-1) as HTMLElement;
}

function fact(overrides: Partial<SystemFact> = {}): SystemFact {
  return {
    ref: "F1",
    tool: "catalog_query",
    operation: "count",
    label: "Документы в доступном каталоге SKH",
    value: 83,
    unit: "documents",
    effective_filters: {},
    definition: null,
    access_scope: "visible_to_request_context",
    source: "skh_document_registry",
    generation: "g7",
    as_of: "2026-11-24T09:00:00Z",
    items: [],
    truncated: false,
    breakdown: null,
    ...overrides,
  };
}

function step(overrides: Partial<ToolStepInfo> = {}): ToolStepInfo {
  return {
    call_id: "T1",
    round: 1,
    tool: "catalog_query",
    operation: "count",
    outcome: "ok",
    duration_ms: 1,
    result_count: 83,
    fact_ref: "F1",
    error_code: null,
    message: null,
    ...overrides,
  };
}

function toolAnswer(overrides: Partial<AskResponse> = {}): AskResponse {
  return {
    ...supportedAnswer,
    mode: "internal_api",
    warnings: [],
    citations: [],
    answer: "В доступном вам каталоге SKH — 83 уникальных документов [F1]. Версии и фрагменты поиска не входят.",
    system_facts: [fact()],
    tool_steps: [step()],
    general_knowledge: false,
    conversation_context: [{ tool: "catalog_query", operation: "count", filters: {}, document_ids: [], value: 83 }],
    ...overrides,
  };
}

const facts = () => screen.getByRole("region", { name: "Данные системы SKH" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("System facts: «По данным реестра SKH» cards", () => {
  it("shows the value of the server's observation, not the number the model wrote", async () => {
    // The model miscounted in its text: the card still shows the registry's value.
    mockApi([streamRoute(...final(toolAnswer({ answer: "В каталоге примерно 80 документов [F1]." })))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const card = within(facts()).getByRole("listitem");
    expect(card).toHaveAttribute("id", "fact-1-F1");
    expect(card).toHaveTextContent("По данным реестра SKH — Документы в доступном каталоге SKH");
    expect(card).toHaveTextContent("83 документа");
    expect(card).toHaveTextContent("Весь доступный вам каталог, без фильтров");
    expect(card).toHaveTextContent("Область: доступный вам каталог");
    expect(card).toHaveTextContent("срез g7");
    expect(card.querySelector("time")).toHaveAttribute("dateTime", "2026-11-24T09:00:00Z");
    expect(facts()).toHaveTextContent("это не цитата из документа");
    // A registry number is not a document quote: no «Источники» block, no closest matches, no «нет ответа».
    expect(screen.queryByRole("region", { name: "Источники" })).toBeNull();
    expect(screen.queryByText(/В базе знаний нет ответа/)).toBeNull();
  });

  it("turns [F1] into a marker С1: focus shows what it stands for, a click moves focus to its card", async () => {
    mockApi([streamRoute(...final(toolAnswer()))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const text = document.querySelector(".answer__text") as HTMLElement;
    expect(text).not.toHaveTextContent("[F1]");
    const marker = within(text).getByRole("link", { name: "Данные системы С1" });
    expect(marker).toHaveTextContent("С1");
    expect(marker).toHaveClass("fact-ref");
    expect(marker).toHaveAttribute("href", "#fact-1-F1");

    act(() => marker.focus());
    const tip = screen.getByRole("tooltip");
    expect(tip).toBeVisible();
    expect(tip).toHaveTextContent("По данным реестра SKH");
    expect(tip).toHaveTextContent("Документы в доступном каталоге SKH: 83 документа");
    expect(marker).toHaveAccessibleDescription(/83 документа/);

    await userEvent.click(marker);
    expect(document.getElementById("fact-1-F1")).toHaveFocus();
  });

  it("keeps document citations as they are, apart from the system facts", async () => {
    const citation = supportedAnswer.citations[0] as Citation;
    mockApi([
      streamRoute(
        ...final(
          toolAnswer({
            answer: "Утверждённых документов с тегом aris — 9 [F1]. Документы описывают четыре слоя [1].",
            citations: [citation],
            system_facts: [fact({ value: 9, effective_filters: { status: ["approved"], tags: ["aris"] } })],
          }),
        ),
      ),
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Сколько утверждённых документов об ARIS и где пробелы?");
    const text = document.querySelector(".answer__text") as HTMLElement;
    expect(within(text).getByRole("link", { name: "Источник 1" })).toHaveClass("cite-ref--team");
    expect(within(text).getByRole("link", { name: "Данные системы С1" })).toHaveClass("fact-ref");
    const sources = screen.getByRole("region", { name: "Источники" });
    expect(within(sources).getByRole("region", { name: "Документы команды" })).toHaveTextContent(citation.title);
    expect(sources).not.toHaveTextContent("реестр");
    expect(facts()).toHaveTextContent("9 документов");
    expect(facts()).toHaveTextContent("Фильтр: статус: утверждён · тег: aris");
    expect(facts()).not.toHaveTextContent(citation.title);
  });

  it("shows the filters really applied, the definition, the items as links and an honest truncation", async () => {
    const listed = fact({
      operation: "list",
      label: "Документы доступного каталога SKH",
      value: 9,
      effective_filters: { status: ["approved"], tags: ["aris"], text: "ARIS", sort: "updated" },
      definition: "text «ARIS»: полнотекстовое совпадение. Это не системный тег.",
      items: [
        { id: "DEMO-INT-001", title: "ARIS → каталог", kind: "document", status: "approved", detail: "integration · владелец: demo-team", app_path: "/documents/DEMO-INT-001" },
        { id: "DEMO-GOV-012", title: "Правила ARIS", kind: "document", status: "in_review", detail: null, app_path: "/documents/DEMO-GOV-012" },
      ],
      truncated: true,
    });
    mockApi([streamRoute(...final(toolAnswer({ answer: "Последние: DEMO-INT-001, DEMO-GOV-012 [F1].", system_facts: [listed] })))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Покажи последние ARIS-документы");
    const card = within(facts()).getAllByRole("listitem")[0] as HTMLElement;
    expect(card).toHaveTextContent(
      "Фильтр: статус: утверждён · тег: aris · текст содержит «ARIS» · порядок: сначала недавно обновлённые",
    );
    expect(card).toHaveTextContent("Это не системный тег.");
    const items = within(card).getByRole("list", { name: "Объекты: Документы доступного каталога SKH" });
    expect(within(items).getByRole("link", { name: "ARIS → каталог" })).toHaveAttribute("href", "/documents/DEMO-INT-001");
    expect(within(items).getByText("На ревью")).toBeInTheDocument();
    expect(card).toHaveTextContent("Показаны первые 2 из 9.");
  });

  it("says a zero is a zero within the scope — not an error and not «no documents in the base»", async () => {
    const zero = fact({ operation: "list", value: 0, effective_filters: { tags: ["aris"], owner_missing: true } });
    mockApi([streamRoute(...final(toolAnswer({ answer: "ARIS-документов без владельца нет [F1].", system_facts: [zero] })))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Какие ARIS-документы без владельца?");
    expect(facts()).toHaveTextContent("0 документов");
    expect(facts()).toHaveTextContent("Нет совпадений в этой области — это ноль, а не ошибка проверки.");
    expect(facts()).toHaveTextContent("Фильтр: тег: aris · владелец не назначен");
    expect(screen.queryByRole("list", { name: "Что не удалось проверить" })).toBeNull();
  });

  it("labels an answer from general knowledge quietly, and nothing else", async () => {
    const general = toolAnswer({
      answer: "RAG — подход, при котором модель отвечает по найденным фрагментам.",
      confidence: "partial",
      system_facts: [],
      tool_steps: [],
      conversation_context: [],
      general_knowledge: true,
    });
    mockApi([streamRoute(...final(general))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Что такое RAG?");
    expect(screen.getByText("Общие знания, не данные SKH")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Данные системы SKH" })).toBeNull();
    expect(screen.queryByText(/В базе знаний нет ответа/)).toBeNull();
  });

  it("does not label an ordinary fact answer as general knowledge", async () => {
    mockApi([streamRoute(...final(toolAnswer()))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    expect(screen.queryByText("Общие знания, не данные SKH")).toBeNull();
  });

  it("copies the facts with their source along with the answer", () => {
    const answer = toolAnswer({ system_facts: [fact({ effective_filters: { status: ["approved"] } })] });
    const text = answerWithSources(answer, new Map(), false);
    expect(text).toContain("— 83 уникальных документов [С1].");
    expect(text).toContain("Данные системы SKH:\n[С1] По данным реестра SKH — Документы в доступном каталоге SKH: 83 документа (фильтр: статус: утверждён)");
  });
});

describe("System facts: follow-ups and streaming", () => {
  it("sends the previous answer's referent back with the follow-up («из них»)", async () => {
    const referent = { tool: "catalog_query", operation: "count", filters: { tags: ["aris"] }, document_ids: [], value: 13 };
    const calls = mockApi([streamRoute(...final(toolAnswer({ conversation_context: [referent] })))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Сколько документов по ARIS?");
    await ask("А сколько из них утверждено?");
    expect(posts(calls)).toHaveLength(2);
    expect(posts(calls)[1]?.body).toMatchObject({
      question: "А сколько из них утверждено?",
      history: [{ question: "Сколько документов по ARIS?", context: [referent] }],
    });
  });

  it("builds history without a context for answers that had no system facts", () => {
    const base = { request: { question: "Что такое RAG?", sources: ["team"], include_drafts: false, include_deprecated: false } };
    const turns = [
      { ...base, id: 1, phase: "done", response: toolAnswer({ conversation_context: [] }) },
      {
        ...base,
        id: 2,
        phase: "done",
        response: toolAnswer({
          conversation_context: Array.from({ length: 7 }, (_, i) => ({ tool: "catalog_query", operation: "count", filters: {}, document_ids: [], value: i })),
        }),
      },
    ] as unknown as Turn[];
    const history = historyFrom(turns);
    expect(history[0]).not.toHaveProperty("context");
    expect(history[1]?.context).toHaveLength(5);
  });

  it("starts a new preliminary text in every model round and names the check in one short line", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Сколько документов в базе?");
    await userEvent.keyboard("{Enter}");
    const send = (...events: AskStreamEvent[]) =>
      act(async () => {
        stream.push(...events);
      });

    await send({ type: "status", stage: "retrieving" }, { type: "status", stage: "generating", round: 1, passages: 6, provider: "claude_cli" });
    await send({ type: "delta", text: "Сейчас посчитаю документы." });
    expect(await screen.findByText("Сейчас посчитаю документы.")).toBeInTheDocument();

    await send({ type: "tool_call", call_id: "T1", round: 1, tool: "catalog_query", operation: "count" });
    expect(await screen.findByText("Проверяю каталог…")).toHaveAttribute("role", "status");
    await send({ type: "tool_result", call_id: "T1", step: step() });
    expect(screen.getByText("Проверяю каталог…")).toBeInTheDocument();

    await send({ type: "status", stage: "generating", round: 2, passages: 6, provider: "claude_cli" });
    expect(screen.queryByText("Проверяю каталог…")).toBeNull();
    expect(screen.getByText("Формулирую ответ с Claude Code CLI… (найдено 6 фрагментов)")).toBeInTheDocument();
    expect(screen.queryByText("Сейчас посчитаю документы.")).toBeNull(); // the round-1 text is gone, not glued on
    await send({ type: "delta", text: "В каталоге 83 документа [F1]." });
    const preliminary = (await screen.findByText("Предварительный текст модели — цитаты ещё не проверены")).closest("section") as HTMLElement;
    expect(within(preliminary).getByText("В каталоге 83 документа [F1].")).toBeInTheDocument();

    await send({ type: "status", stage: "validating" }, ...final({ ...toolAnswer(), mode: "claude_cli" }));
    stream.close();
    expect(await screen.findByRole("region", { name: "Данные системы SKH" })).toHaveTextContent("83 документа");
    expect(screen.queryByText("Предварительный текст модели — цитаты ещё не проверены")).toBeNull();
  });

  it("names each kind of check while it runs", () => {
    expect(["catalog_query", "knowledge_search", "graph_inspect", "templates_inspect", "drafts_propose", "x"].map(toolActivity)).toEqual([
      "Проверяю каталог…",
      "Ищу в документах…",
      "Смотрю граф связей…",
      "Смотрю шаблоны…",
      "Готовлю предложение…",
      "Проверяю данные системы…",
    ]);
  });
});

describe("System facts: honest states", () => {
  const down = step({ outcome: "unavailable", fact_ref: null, result_count: null, error_code: "registry_unavailable", message: "Реестр документов сейчас недоступен: проверить нельзя." });
  const serverText =
    "Недостаточно данных: в найденных источниках нет подтверждённого ответа на вопрос.\n\nНе удалось проверить: Реестр документов сейчас недоступен: проверить нельзя.";

  it("an unavailable registry is «could not check» — never «no answer in the base» with near matches", async () => {
    const calls = mockApi([
      streamRoute(
        ...final(toolAnswer({ answer: serverText, confidence: "insufficient_evidence", system_facts: [], tool_steps: [down], conversation_context: [] })),
      ),
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const card = screen.getByRole("region", { name: "Не удалось проверить данные системы" });
    expect(card).toHaveTextContent("Ассистент не называет чисел и фактов, которые не смог проверить.");
    const checks = within(card).getByRole("list", { name: "Что не удалось проверить" });
    expect(within(checks).getByRole("listitem")).toHaveTextContent(
      "Не проверено — источник недоступен. Реестр документов сейчас недоступен: проверить нельзя.",
    );
    expect(screen.queryByText(/В базе знаний нет ответа/)).toBeNull();
    expect(screen.queryByText("Ближайшие совпадения")).toBeNull();
    expect(screen.queryByText(/Нет документов/)).toBeNull();
    expect(screen.queryByText(/\{/)).toBeNull(); // no raw JSON anywhere
    expect(calls.some((c) => c.url.startsWith("/api/documents"))).toBe(false);
    await userEvent.click(within(card).getByRole("button", { name: "Уточнить вопрос" }));
    expect(screen.getByLabelText("Вопрос")).toHaveValue("Сколько документов в базе?");
  });

  it("an answer that stands shows what else could not be checked: unavailable, denied and not found apart", async () => {
    const steps = [
      step(),
      step({ call_id: "T2", tool: "graph_inspect", operation: "links", outcome: "not_found", fact_ref: null, error_code: "document_not_found", message: "Документ X-1 не найден в доступном каталоге." }),
      step({ call_id: "T3", tool: "templates_inspect", operation: "list", outcome: "timeout", fact_ref: null, error_code: "timeout", message: "Реестр шаблонов не ответил вовремя." }),
      step({ call_id: "T4", outcome: "denied", fact_ref: null, error_code: "forbidden", message: "Нет прав на это действие." }),
      step({ call_id: "T5", outcome: "invalid", fact_ref: null, error_code: "duplicate_call", message: "Такой вызов уже выполнен (T1): используй его результат выше." }),
    ];
    mockApi([streamRoute(...final(toolAnswer({ confidence: "partial", tool_steps: steps })))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const checks = screen.getByRole("list", { name: "Что не удалось проверить" });
    const items = within(checks).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.outcome)).toEqual(["not_found", "timeout", "denied"]);
    expect(items[0]).toHaveTextContent("Не найдено в доступной вам области. Документ X-1 не найден в доступном каталоге.");
    expect(items[1]).toHaveTextContent("Не проверено — нет ответа вовремя. Реестр шаблонов не ответил вовремя.");
    expect(items[2]).toHaveTextContent("Нет доступа. Нет прав на это действие.");
    expect(checks).not.toHaveTextContent("используй"); // a refused repeat is not a failure and never a model instruction
    expect(facts()).toHaveTextContent("83 документа");
  });

  it("does not repeat a check the server already reported in the answer text", () => {
    const answer = toolAnswer({
      answer: "Не удалось завершить ответ: модель перестала отвечать.\nНе удалось проверить: Реестр документов сейчас недоступен: проверить нельзя.",
      tool_steps: [step(), down],
    });
    expect(failedChecks(answer)).toEqual([]);
    expect(failedChecks({ ...answer, answer: "Ответ." }).map((s) => s.outcome)).toEqual(["unavailable"]);
  });
});

describe("System facts: a proposal from the conversation", () => {
  const proposal: AiProposal = {
    id: "AIP-0123456789abcdef",
    kind: "draft_from_prompt",
    status: "suggested",
    created_at: "2026-11-24T10:00:00Z",
    decided_at: null,
    mode: "internal_api",
    base: { draft_id: null, edit_version: null, document_id: null, revision: null, template_id: "integration", template_version: 2, index_generation: "g1" },
    summary: "Шаблон: «Интеграция» v2.",
    items: [
      { id: "draft", kind: "draft", field: null, section: null, target_id: null, current: null, proposed: { title: "ARIS → витрина" }, reason: "Черновик по шаблону", evidence: [], applicable: true },
    ],
    warnings: [],
    insufficient: false,
    graph_link: null,
    applied_items: [],
    result_draft_id: null,
  };
  const proposalFact = fact({
    tool: "drafts_propose",
    operation: "draft_from_prompt",
    label: "Предложение ИИ (требует решения пользователя)",
    value: 1,
    unit: "items",
    source: "skh_ai_proposals",
    effective_filters: { kind: "draft_from_prompt" },
    items: [{ id: proposal.id, title: "Шаблон: «Интеграция» v2.", kind: "proposal", status: "suggested", detail: "ничего не применено", app_path: null }],
  });

  it("reuses the proposal card: the marker leads there, nothing is applied until Accept", async () => {
    const calls = mockApi([
      streamRoute(
        ...final(
          toolAnswer({
            answer: `Подготовлено предложение ${proposal.id} [F1]: ничего не применено.`,
            system_facts: [proposalFact],
            tool_steps: [step({ tool: "drafts_propose", operation: "draft_from_prompt" })],
            proposal: { id: proposal.id, kind: "draft_from_prompt", status: "suggested", graph_link: null },
          }),
        ),
      ),
      { path: `/api/ai/proposals/${proposal.id}`, body: proposal },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Сделай черновик описания интеграции ARIS с витриной");
    // One card for the proposal — the existing one; no second «fact» card repeating it.
    expect(screen.queryByRole("region", { name: "Данные системы SKH" })).toBeNull();
    const card = screen.getByRole("region", { name: "Предложение ИИ: Черновик по запросу" });
    expect(within(card).getByText(/Ничего не применено/)).toBeInTheDocument();
    expect(within(card).getByText("ИИ")).toBeInTheDocument();

    const marker = screen.getByRole("link", { name: "Данные системы С1" });
    expect(marker).toHaveAttribute("href", "#proposal-1");
    await userEvent.click(marker);
    expect(card).toHaveFocus();

    await userEvent.click(within(card).getByRole("button", { name: "Открыть предложение" }));
    expect(await within(card).findByRole("button", { name: /Создать черновик \(1\)/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/api/ai/proposals"))).toHaveLength(0);
  });
});

describe("lib/systemFacts", () => {
  it("numbers markers in the order of the facts and words values with their unit", () => {
    expect([...factLabels([fact({ ref: "F2" }), fact({ ref: "F5" })]).entries()]).toEqual([
      ["F2", "С1"],
      ["F5", "С2"],
    ]);
    expect(factValueText(fact({ value: 1 }))).toBe("1 документ");
    expect(factValueText(fact({ value: 1234 }))).toMatch(/^1\s234 документа$/);
    expect(factValueText(fact({ value: 0 }))).toBe("0 документов");
    expect(factValueText(fact({ value: 2, unit: "relations" }))).toBe("2 связи");
    expect(factValueText(fact({ value: 2, unit: "version" }))).toBe("версия 2");
    expect(factValueText(fact({ value: null }))).toBeNull();
  });

  it("puts graph and template filters into words", () => {
    expect(filtersText(fact({ source: "skh_knowledge_graph", effective_filters: { document_id: "SEM-DEC-001", direction: "in" } }))).toBe(
      "Фильтр: документ: SEM-DEC-001 · входящие ссылки",
    );
    expect(filtersText(fact({ source: "skh_template_registry", effective_filters: { status: "active", doc_type: "integration" } }))).toBe(
      "Фильтр: статус шаблона: активен · тип документа: интеграции",
    );
    expect(filtersText(fact({ source: "skh_template_registry", effective_filters: {} }))).toBeNull();
    expect(filtersText(fact({ effective_filters: { eligible_for_answers: true } }))).toBe(
      "Фильтр: только документы, которые ассистент может цитировать",
    );
  });
});
