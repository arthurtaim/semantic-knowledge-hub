import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationList, ConversationSummary, DocumentPage, ProposalList } from "../api/types";
import { askHref } from "../lib/assistant";
import { peekHandOff } from "../lib/conversation";
import { HomePage, type HomeHandOff } from "../pages/HomePage";
import { arisSummary, documentPage, freshSync, proposalSummary, session, skills, staleSync } from "./fixtures";
import { memoryStorage, mockApi, renderRoutes, type MockRoute } from "./helpers";

/* The home page is the assistant (docs/ui-v2/specs/02_ASSISTANT.md §1, design-01/02). */

/** «Ждёт вашего решения» asks the server for «Ревью»: ready for review and not the reader's own. */
const REVIEW_PATH = "/api/drafts?status=ready_for_review&exclude_own=true";

const review: ProposalList = {
  items: [
    proposalSummary({
      id: "p-ready",
      status: "ready_for_review",
      author: "colleague",
      document_title: "Archive Store: исторические снимки",
      updated_at: "2026-11-23T10:00:00Z",
    }),
  ],
  total: 1,
};

const withOwnerless: DocumentPage = {
  items: [
    { ...arisSummary, id: "SEM-PROC-OLD-001", title: "Old process", type: "process", owner: "unassigned", owner_missing: true },
    { ...arisSummary, id: "DEMO-SRC-010", title: "Source without owner", type: "source", owner: "unassigned", owner_missing: true },
    arisSummary,
  ],
  total: 3,
  page: 1,
  size: 100,
};

function homeRoutes(overrides: Partial<Record<"skills" | "drafts" | "documents" | "index", MockRoute>> = {}): MockRoute[] {
  return [
    overrides.skills ?? { path: "/api/assistant/skills", body: skills },
    overrides.drafts ?? { path: REVIEW_PATH, body: review },
    overrides.documents ?? { path: "/api/documents?size=100", body: withOwnerless },
    overrides.index ?? { path: "/api/index/status", body: freshSync },
  ];
}

const routes = { "/": <HomePage />, "/ask": <p>Диалог</p> };

describe("Home page: the assistant", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks «Что нужно найти или подготовить?» with the field and «Новый диалог» in the toolbar", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    expect(screen.getByRole("heading", { level: 1, name: "Что нужно найти или подготовить?" })).toBeInTheDocument();
    expect(screen.getByText(/отвечает только по документам команды и показывает цитаты/)).toBeInTheDocument();
    const field = screen.getByLabelText("Вопрос");
    expect(field).toHaveAttribute("id", "home-composer-input");
    expect(field).toHaveAttribute("placeholder", "Спросите, опишите задачу или перетащите файл");
    expect(screen.getByRole("button", { name: "Новый диалог" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Файл" })).toBeInTheDocument();
  });

  it("offers the four quick skills from the registry; one puts its chip into the field", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    const group = await screen.findByRole("group", { name: "Быстрые навыки" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Черновик документа",
      "Что перепроверить",
      "Найти связи",
      "Сравнить с файлом",
    ]);
    const compare = within(group).getByRole("button", { name: "Сравнить с файлом" });
    await userEvent.click(compare);
    expect(compare).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeInTheDocument();
    expect(screen.getByLabelText("Вопрос")).toHaveFocus();
    expect(screen.getByText(/Навыку «Сравнить с файлом» нужен файл/)).toBeInTheDocument();
  });

  it("shows only quick skills that the current mode can run", async () => {
    const limited = skills.map((s) => (s.id === "check_freshness" ? { ...s, available: false, unavailable_reason: "нет" } : s));
    mockApi(homeRoutes({ skills: { path: "/api/assistant/skills", body: limited } }));
    renderRoutes("/", routes);
    const group = await screen.findByRole("group", { name: "Быстрые навыки" });
    expect(within(group).queryByRole("button", { name: "Что перепроверить" })).toBeNull();
    expect(within(group).getAllByRole("button")).toHaveLength(3);
  });

  it("opens the answer of a plain question (`?q=…&run=1`) and hands the message to the dialog", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Что такое ревизия?{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(askHref("Что такое ревизия?"));
    const handed = peekHandOff<HomeHandOff>();
    expect(handed?.message).toMatchObject({ question: "Что такое ревизия?", skill: null, scope: "team" });
    expect(handed?.conversationId).toBe(handed?.message.conversationId);
  });

  it("sends a skill to the dialog with its chip once it has what it needs («Найти связи»: a document or a question)", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    await userEvent.click(await screen.findByRole("button", { name: "Найти связи" }));
    // requires.document_or_question: an empty field does not send (the server would refuse it).
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByText(/Навыку «Найти связи» нужен документ или вопрос/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Вопрос"), "Выгрузка регионов{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(askHref("Выгрузка регионов"));
    const handed = peekHandOff<HomeHandOff>();
    expect(handed?.message.skill?.id).toBe("find_related");
    expect(handed?.draft.skill?.id).toBe("find_related");
  });

  it("«Новый диалог» empties the field and its chips", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    await userEvent.click(await screen.findByRole("button", { name: "Черновик документа" }));
    await userEvent.type(screen.getByLabelText("Вопрос"), "Интеграция с реестром");
    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    expect(screen.getByLabelText("Вопрос")).toHaveValue("");
    expect(screen.queryByRole("list", { name: "Приложено к сообщению" })).toBeNull();
  });

  it("lists this browser's conversations from the server's chat history; a row opens the stored dialog; clears them", async () => {
    const recentRow = (overrides: Partial<ConversationSummary>): ConversationSummary => ({
      id: "conv-home-0001",
      title: "Что отправляет ARIS в каталог?",
      origin: "dialog",
      document: null,
      turn_count: 1,
      created_at: new Date(Date.now() - 6 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      last_status: "done",
      last_skill: null,
      last_sources: 3,
      context: null,
      ...overrides,
    });
    const list: ConversationList = {
      items: [
        recentRow({ turn_count: 2 }),
        recentRow({
          id: "conv-home-0002",
          title: "Сверить выгрузку с маппингом ARIS",
          last_skill: { id: "compare_with_file", name: "Сравнить с файлом", access: "read" },
          context: "aris_export_2026-11.csv",
          updated_at: "2026-11-20T10:00:00Z",
        }),
        recentRow({ id: "conv-home-0003", title: "Кто владелец?", last_status: "interrupted", last_sources: null }),
        recentRow({ id: "conv-home-0004", title: "Объяснить", origin: "document", document: { id: "SEM-ARCH-001", title: "Архитектура" } }),
      ],
      total: 4,
      enabled: true,
      retention_days: 30,
    };
    let cleared = false;
    const calls = mockApi([
      ...homeRoutes(),
      { path: "/api/assistant/conversations?limit=5", body: () => (cleared ? { ...list, items: [], total: 0 } : list) },
      {
        method: "DELETE",
        path: "/api/assistant/conversations",
        respond: () => {
          cleared = true;
          return new Response(JSON.stringify({ deleted: 4 }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
    ]);
    renderRoutes("/", routes);
    const recent = (await screen.findByRole("heading", { name: "Недавние диалоги" })).closest("section") as HTMLElement;
    const first = within(recent).getByRole("link", { name: /Что отправляет ARIS в каталог\?/ });
    // The stored dialog — never `?q=…&run=1`, which would ask again.
    expect(first.getAttribute("href")).toBe("/ask?c=conv-home-0001");
    expect(first).toHaveTextContent("Ответ по базе, 3 источника · 2 вопроса");
    expect(first).toHaveTextContent("5 мин. назад");
    expect(within(recent).getByRole("link", { name: /Сверить выгрузку/ })).toHaveTextContent("Сравнить с файлом, aris_export_2026-11.csv");
    expect(within(recent).getByRole("link", { name: /Кто владелец\?/ })).toHaveTextContent("Ответ по базе, ответ не получен");
    expect(within(recent).getByRole("link", { name: /Объяснить/ })).toHaveTextContent("По документу «Архитектура»");
    expect(within(recent).getByText(/Хранятся на сервере для этого браузера 30 дней/)).toBeInTheDocument();
    const browser = calls.find((call) => call.url === "/api/assistant/conversations?limit=5")?.headers["X-SKH-Browser"];
    expect(browser).toMatch(/^[0-9a-f]{32}$/);

    // «Очистить историю» asks first; «Отмена» keeps everything.
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить историю" }));
    expect(within(recent).getByText(/Удалить всю историю диалогов этого браузера\?/)).toBeInTheDocument();
    await userEvent.click(within(recent).getByRole("button", { name: "Отмена" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить историю" }));
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить историю" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Недавние диалоги" })).toBeNull());
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual(["/api/assistant/conversations"]);
  });

  it("without the server's history shows what this browser remembered: rows put the dialog back, never ask again", async () => {
    window.localStorage.setItem(
      "skh.recent-questions.v1:local-demo-user",
      JSON.stringify([
        { question: "Что отправляет ARIS в каталог?", at: new Date(Date.now() - 5 * 60_000).toISOString(), skill: null, sources: 3, context: null, conversation_id: "conv-local-0001" },
        { question: "Сверить выгрузку с маппингом ARIS", at: "2026-11-20T10:00:00Z", skill: "Сравнить с файлом", sources: 2, context: "aris_export_2026-11.csv" },
        "Старый вопрос из фазы 4",
      ]),
    );
    mockApi([...homeRoutes(), { path: "/api/assistant/conversations?limit=5", status: 503, body: { code: "unavailable", message: "Нет связи." } }]);
    renderRoutes("/", routes);
    const recent = (await screen.findByRole("heading", { name: "Недавние диалоги" })).closest("section") as HTMLElement;
    const first = within(recent).getByRole("link", { name: /Что отправляет ARIS в каталог\?/ });
    expect(first.getAttribute("href")).toBe("/ask?c=conv-local-0001");
    expect(first).toHaveTextContent("Ответ по базе, 3 источника");
    expect(first).toHaveTextContent("5 мин. назад");
    const old = within(recent).getByRole("link", { name: /Старый вопрос из фазы 4/ });
    expect(old).toHaveTextContent("Ответ по базе");
    expect(old.getAttribute("href")).not.toContain("run=1");
    expect(within(recent).getByRole("link", { name: /Сверить выгрузку/ })).toHaveTextContent("Сравнить с файлом, aris_export_2026-11.csv");
    expect(within(recent).getByText(/История на сервере недоступна — показаны записи этого браузера/)).toBeInTheDocument();
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить историю" }));
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить историю" }));
    expect(screen.queryByRole("heading", { name: "Недавние диалоги" })).toBeNull();
    expect(window.localStorage.getItem("skh.recent-questions.v1:local-demo-user")).toBeNull();
  });

  it("«Ждёт вашего решения»: others' proposals ready for review and documents without an owner — from the API only", async () => {
    const calls = mockApi(homeRoutes());
    renderRoutes("/", routes);
    const waiting = screen.getByRole("heading", { name: "Ждёт вашего решения" }).closest("section") as HTMLElement;
    const ready = await within(waiting).findByRole("link", { name: /Archive Store: исторические снимки/ });
    expect(ready).toHaveAttribute("href", "/proposals/p-ready");
    expect(ready).toHaveTextContent("Готово к ревью · Изменение документа");
    // The server leaves out drafts and the reader's own proposals: the page asks for exactly «Ревью».
    expect(calls.filter((call) => call.url.startsWith("/api/drafts")).map((call) => call.url)).toEqual([REVIEW_PATH]);
    const owners = await within(waiting).findByRole("link", { name: /2 документа без владельца/ });
    expect(owners).toHaveTextContent("Процессы и системы-источники");
    expect(owners).toHaveAttribute("href", "/documents?owner=unassigned");
  });

  it("invents nothing: no owner row when the catalogue page is incomplete, a plain note when nothing waits", async () => {
    const partial: DocumentPage = { ...withOwnerless, total: 250 };
    mockApi(
      homeRoutes({
        drafts: { path: REVIEW_PATH, body: { items: [], total: 0 } },
        documents: { path: "/api/documents?size=100", body: partial },
      }),
    );
    renderRoutes("/", routes);
    const waiting = screen.getByRole("heading", { name: "Ждёт вашего решения" }).closest("section") as HTMLElement;
    expect(await within(waiting).findByText("Сейчас ничего не ждёт решения.")).toBeInTheDocument();
    expect(within(waiting).queryByText(/без владельца/)).toBeNull();
  });

  it("says when the review list cannot be read", async () => {
    mockApi(
      homeRoutes({
        drafts: { path: REVIEW_PATH, status: 500, body: { code: "internal_error", message: "x", request_id: "r" } },
        documents: { path: "/api/documents?size=100", body: documentPage },
      }),
    );
    renderRoutes("/", routes);
    expect(await screen.findByText("Не удалось получить предложения на ревью.")).toBeInTheDocument();
  });

  it("warns plainly when the knowledge index is stale", async () => {
    mockApi(homeRoutes({ index: { path: "/api/index/status", body: staleSync } }));
    renderRoutes("/", routes);
    expect(await screen.findByText("Данные могут быть устаревшими.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Состояние синхронизации" })).toHaveAttribute("href", "/integrations");
  });

  it("without AI: «Что нужно найти?», a search field, no skills, no recent dialogs, no «Новый диалог»", async () => {
    window.localStorage.setItem("skh.recent-questions.v1:local-demo-user", JSON.stringify(["Старый вопрос"]));
    const calls = mockApi(homeRoutes());
    renderRoutes("/", routes, { ...session, features: { ...session.features, ai_mode: "disabled" } });
    expect(screen.getByRole("heading", { level: 1, name: "Что нужно найти?" })).toBeInTheDocument();
    const field = screen.getByLabelText("Поиск по базе знаний");
    expect(field).toHaveAttribute("placeholder", "Найти в базе знаний");
    expect(screen.queryByRole("group", { name: "Быстрые навыки" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Файл" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Навык" })).toBeNull();
    expect(screen.queryByText("Недавние диалоги")).toBeNull();
    expect(screen.queryByRole("button", { name: "Новый диалог" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ждёт вашего решения" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/assistant/skills")).toBe(false);
    await userEvent.type(field, "ревизия{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/documents?query=%D1%80%D0%B5%D0%B2%D0%B8%D0%B7%D0%B8%D1%8F");
  });
});
