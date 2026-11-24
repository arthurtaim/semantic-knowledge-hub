import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentPage } from "../api/types";
import { formatWhen } from "../lib/labels";
import { HomePage } from "../pages/HomePage";
import {
  actionableProposals,
  arisSummary,
  documentPage,
  facets,
  freshSync,
  integrations,
  proposalSummary,
  session,
  staleSync,
} from "./fixtures";
import { mockApi, renderAt, renderRoutes, type MockRoute } from "./helpers";

const undated = { ...arisSummary, id: "SEM-GLOSS-001", title: "Glossary without a date", updated_at: null };
const recentPage: DocumentPage = { items: [{ ...arisSummary, index_state: "stale" }, undated], total: 2, page: 1, size: 5 };

function homeRoutes(overrides: Partial<Record<"recent" | "drafts" | "index" | "facets", MockRoute>> = {}): MockRoute[] {
  return [
    overrides.facets ?? { path: "/api/knowledge/facets", body: facets },
    { path: "/api/documents?size=100", body: documentPage },
    { path: "/api/integrations/status", body: integrations },
    overrides.recent ?? { path: "/api/documents?sort=updated&size=5", body: recentPage },
    overrides.drafts ?? { path: "/api/drafts", body: actionableProposals },
    overrides.index ?? { path: "/api/index/status", body: freshSync },
  ];
}

/** An in-memory localStorage (jsdom on this Node has none; the app treats a missing one as empty). */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe("Home page", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes the hero the «Спросить или найти» field: team scope by default, a question opens its answer", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", { "/": <HomePage /> });
    expect(screen.queryByRole("link", { name: "Спросить ассистента" })).toBeNull(); // retired
    const field = screen.getByRole("combobox", { name: "Спросить или найти" });
    expect(field).toHaveAttribute("id", "home-composer-input");
    expect(screen.getByRole("radio", { name: "Команда" })).toBeChecked();
    expect(screen.getByRole("link", { name: "Создать документ" })).toHaveAttribute("href", "/documents/new");
    await userEvent.type(field, "Что такое ревизия?{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/ask?q=%D0%A7%D1%82%D0%BE+%D1%82%D0%B0%D0%BA%D0%BE%D0%B5+%D1%80%D0%B5%D0%B2%D0%B8%D0%B7%D0%B8%D1%8F%3F&run=1",
    );
  });

  it("asks in the chosen scope and says when corporate sources are not connected", async () => {
    mockApi(homeRoutes());
    renderRoutes("/", { "/": <HomePage /> });
    await userEvent.click(screen.getByRole("radio", { name: "Оба" }));
    expect(screen.getByText(/Корпоративные источники \(Confluence Data Center\) не подключены/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Спросить или найти" }), "Где SLA?{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("&run=1&scope=both");
  });

  it("searches from the hero in «Найти в документах» mode; the scope switch belongs to questions only", async () => {
    mockApi([...homeRoutes(), { path: /^\/api\/documents\?query=/, body: documentPage }]);
    renderRoutes("/", { "/": <HomePage /> });
    await userEvent.click(screen.getByRole("button", { name: "Найти в документах" }));
    expect(screen.queryByRole("radio", { name: "Команда" })).toBeNull();
    await userEvent.type(screen.getByRole("combobox", { name: "Поиск по базе знаний" }), "ревизия");
    await userEvent.click(screen.getByRole("button", { name: "Найти" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/documents?query=%D1%80%D0%B5%D0%B2%D0%B8%D0%B7%D0%B8%D1%8F");
  });

  it("is search only without AI: no mode switch, no scope, no recent questions", async () => {
    window.localStorage.setItem("skh.recent-questions.v1:local-demo-user", JSON.stringify(["Старый вопрос"]));
    mockApi(homeRoutes());
    renderRoutes("/", { "/": <HomePage /> }, { ...session, features: { ...session.features, ai_mode: "disabled" } });
    expect(screen.getByRole("combobox", { name: "Поиск по базе знаний" })).toHaveAttribute("placeholder", "Найти в базе знаний…");
    expect(screen.queryByRole("group", { name: "Режим поля" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Команда" })).toBeNull();
    expect(screen.queryByText("Недавние вопросы")).toBeNull();
    expect(screen.getByText(/ИИ в этой установке отключён/)).toBeInTheDocument();
  });

  it("lists the user's recent questions from this browser and clears them", async () => {
    window.localStorage.setItem(
      "skh.recent-questions.v1:local-demo-user",
      JSON.stringify(["Где хранится база?", "Что такое ревизия?"]),
    );
    mockApi(homeRoutes());
    renderRoutes("/", { "/": <HomePage /> });
    const recent = screen.getByRole("heading", { name: "Недавние вопросы" }).closest("section") as HTMLElement;
    expect(within(recent).getByRole("link", { name: "Где хранится база?" }).getAttribute("href")).toMatch(/^\/ask\?q=.+&run=1$/);
    expect(within(recent).getByText(/Хранятся только в этом браузере/)).toBeInTheDocument();
    await userEvent.click(within(recent).getByRole("button", { name: "Очистить" }));
    expect(screen.queryByRole("heading", { name: "Недавние вопросы" })).toBeNull();
    expect(window.localStorage.getItem("skh.recent-questions.v1:local-demo-user")).toBeNull();
  });

  it("lists recently updated documents by date and proposals that need action", async () => {
    const calls = mockApi(homeRoutes());
    renderAt("/", "/", <HomePage />);

    const recent = (await screen.findByRole("heading", { name: "Недавно обновлённые" })).closest("section") as HTMLElement;
    const doc = await within(recent).findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(doc).toHaveAttribute("href", "/documents/SEM-INT-ARIS-001");
    expect(within(recent).getByText(formatWhen(arisSummary.updated_at).text, { exact: false })).toBeInTheDocument();
    expect(within(recent).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    expect(within(recent).queryByText("Glossary without a date")).toBeNull();
    expect(calls.some((c) => c.url === "/api/documents?sort=updated&size=5")).toBe(true);

    const proposals = screen.getByRole("heading", { name: "Предложения, требующие действия" }).closest("section") as HTMLElement;
    const links = await within(proposals).findAllByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(["/proposals/p-draft", "/proposals/p-failed"]);
    expect(within(proposals).getByText("Ошибка отправки")).toBeInTheDocument();
    expect(within(proposals).getAllByText("Изменение документа")).toHaveLength(2);
    expect(within(proposals).queryByText("Уже в GitLab")).toBeNull();
    expect(within(proposals).queryByText("Уже принято")).toBeNull();
    expect(screen.queryByText(/Данные могут быть устаревшими/)).toBeNull();
  });

  it("shows honest empty states instead of invented content", async () => {
    mockApi(
      homeRoutes({
        recent: { path: "/api/documents?sort=updated&size=5", body: { ...recentPage, items: [undated], total: 1 } },
        drafts: { path: "/api/drafts", body: { items: [proposalSummary({ status: "merged" })], total: 1 } },
      }),
    );
    renderAt("/", "/", <HomePage />);
    expect(await screen.findByText(/Источник не сообщает даты обновления документов/)).toBeInTheDocument();
    expect(await screen.findByText("Нет предложений, требующих действия")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Перейти в каталог документов" })).toHaveAttribute("href", "/documents");
  });

  it("warns plainly when the knowledge index is stale", async () => {
    mockApi(homeRoutes({ index: { path: "/api/index/status", body: staleSync } }));
    renderAt("/", "/", <HomePage />);
    expect(await screen.findByText("Данные могут быть устаревшими.")).toBeInTheDocument();
    expect(screen.getByText(/Показаны версии документов на момент последней успешной синхронизации/)).toBeInTheDocument();
    expect(screen.getByText("GitLab недоступен: тайм-аут соединения.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Состояние синхронизации" })).toHaveAttribute("href", "/integrations");
  });

  it("shows an error with a retry when the API fails", async () => {
    mockApi(
      homeRoutes({
        facets: {
          path: "/api/knowledge/facets",
          status: 500,
          body: { code: "internal_error", message: "Внутренняя ошибка сервера.", request_id: "home-1" },
        },
      }),
    );
    renderAt("/", "/", <HomePage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Внутренняя ошибка сервера.");
    expect(within(alert).getByRole("button", { name: "Повторить" })).toBeInTheDocument();
    // Independent blocks still load.
    expect(await screen.findByRole("heading", { name: "Недавно обновлённые" })).toBeInTheDocument();
  });
});
