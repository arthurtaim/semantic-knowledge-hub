import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DocumentPage } from "../api/types";
import { formatDate } from "../lib/labels";
import { HomePage } from "../pages/HomePage";
import {
  actionableProposals,
  arisSummary,
  documentPage,
  facets,
  freshSync,
  integrations,
  proposalSummary,
  staleSync,
} from "./fixtures";
import { mockApi, renderAt, type MockRoute } from "./helpers";

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

describe("Home page", () => {
  it("puts the assistant next to search and carries the typed text over", async () => {
    mockApi(homeRoutes());
    renderAt("/", "/", <HomePage />);
    const ask = screen.getByRole("link", { name: "Спросить ассистента" });
    expect(ask).toHaveAttribute("href", "/ask");
    await userEvent.type(screen.getByLabelText("Поиск по базе знаний"), "ревизия");
    expect(ask).toHaveAttribute("href", "/ask?q=%D1%80%D0%B5%D0%B2%D0%B8%D0%B7%D0%B8%D1%8F");
    expect(await screen.findByRole("heading", { name: "Разделы" })).toBeInTheDocument();
  });

  it("lists recently updated documents by date and proposals that need action", async () => {
    const calls = mockApi(homeRoutes());
    renderAt("/", "/", <HomePage />);

    const recent = (await screen.findByRole("heading", { name: "Недавно обновлённые" })).closest("section") as HTMLElement;
    const doc = await within(recent).findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(doc).toHaveAttribute("href", "/documents/SEM-INT-ARIS-001");
    expect(within(recent).getByText(formatDate(arisSummary.updated_at))).toBeInTheDocument();
    expect(within(recent).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    expect(within(recent).queryByText("Glossary without a date")).toBeNull();
    expect(calls.some((c) => c.url === "/api/documents?sort=updated&size=5")).toBe(true);

    const proposals = screen.getByRole("heading", { name: "Предложения, требующие действия" }).closest("section") as HTMLElement;
    const links = await within(proposals).findAllByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(["/proposals/p-draft", "/proposals/p-failed"]);
    expect(within(proposals).getByText("Ошибка отправки")).toBeInTheDocument();
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
