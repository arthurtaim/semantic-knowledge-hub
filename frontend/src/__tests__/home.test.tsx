import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentPage, ProposalList } from "../api/types";
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
      "Проверить актуальность",
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
    expect(within(group).queryByRole("button", { name: "Проверить актуальность" })).toBeNull();
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

  it("sends a skill without a question to the dialog with its chip", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    await userEvent.click(await screen.findByRole("button", { name: "Найти связи" }));
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/ask$/);
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

  it("lists recent dialogs of this browser: question, skill and sources or the file, time; clears them", async () => {
    window.localStorage.setItem(
      "skh.recent-questions.v1:local-demo-user",
      JSON.stringify([
        { question: "Что отправляет ARIS в каталог?", at: new Date(Date.now() - 5 * 60_000).toISOString(), skill: null, sources: 3, context: null },
        { question: "Сверить выгрузку с маппингом ARIS", at: "2026-11-20T10:00:00Z", skill: "Сравнить с файлом", sources: 2, context: "aris_export_2026-11.csv" },
        "Старый вопрос из фазы 4",
      ]),
    );
    mockApi(homeRoutes());
    renderRoutes("/", routes);
    const recent = screen.getByRole("heading", { name: "Недавние диалоги" }).closest("section") as HTMLElement;
    const first = within(recent).getByRole("link", { name: /Что отправляет ARIS в каталог\?/ });
    expect(first.getAttribute("href")).toBe(askHref("Что отправляет ARIS в каталог?"));
    expect(first).toHaveTextContent("Ответ по базе, 3 источника");
    expect(first).toHaveTextContent("5 мин. назад");
    expect(within(recent).getByRole("link", { name: /Сверить выгрузку/ })).toHaveTextContent("Сравнить с файлом, aris_export_2026-11.csv");
    expect(within(recent).getByRole("link", { name: /Старый вопрос из фазы 4/ })).toHaveTextContent("Ответ по базе");
    expect(within(recent).getByText(/Хранятся только в этом браузере/)).toBeInTheDocument();
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить" }));
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
