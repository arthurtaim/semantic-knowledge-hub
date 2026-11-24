import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AiMode, IntegrationsResponse } from "../api/types";
import { Layout } from "../components/Layout";
import { integrations, session } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

const withMode = (ai_mode: AiMode) => ({ ...session, features: { ...session.features, ai_mode } });

const internalApi: IntegrationsResponse = {
  ...integrations,
  items: [
    {
      name: "ai_provider",
      title: "AI-провайдер",
      kind: "ai",
      state: "connected",
      capabilities: ["grounded_answers"],
      human_readable_message: "Внутренний AI API отвечает (проверка /models).",
      details: { provider: "internal_api", model: "bank-llm-7b" },
      target: "real",
      access: "read",
      checked_at: null,
    },
  ],
};

describe("Header: AI mode chip and demo tag", () => {
  it("replaces the full-width band with a demo tag whose facts open on demand", async () => {
    renderAt("/", "/", <Layout>page</Layout>);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Демо-данные.");
    const tag = within(note).getByRole("button", { name: "Демо-данные" });
    expect(tag).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/Confluence не подключён/)).not.toBeVisible();

    await userEvent.click(tag);
    expect(tag).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Confluence не подключён/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(tag).toHaveAttribute("aria-expanded", "false");
    expect(tag).toHaveFocus();
    expect(document.querySelector(".demo-band")).toBeNull();
  });

  it.each([
    ["mock", "ИИ: демо"],
    ["internal_api", "ИИ: внутренняя модель"],
    ["claude_cli", "ИИ: Claude CLI (эксперимент)"],
    ["disabled", "ИИ отключён"],
  ] as const)("names the AI mode %s on every page", (mode, label) => {
    renderAt("/documents", "/documents", <Layout>page</Layout>, withMode(mode));
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("explains provider, model, scope and limits in the chip's popover", async () => {
    const calls = mockApi([{ path: "/api/integrations/status", body: internalApi }]);
    renderAt("/", "/", <Layout>page</Layout>, withMode("internal_api"));
    await userEvent.click(screen.getByRole("button", { name: "ИИ: внутренняя модель" }));
    const details = document.getElementById("ai-mode-details") as HTMLElement;
    expect(within(details).getByText("Внутренняя модель банка (OpenAI-совместимый API)")).toBeVisible();
    expect(await within(details).findByText("bank-llm-7b")).toBeInTheDocument();
    expect(within(details).getByText(/Корпоративные источники — только отдельным помеченным запросом/)).toBeInTheDocument();
    expect(within(details).getByText(/сервер сверяет каждую цитату/)).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "Подробнее о подключениях" })).toHaveAttribute("href", "/integrations");
    expect(calls.filter((c) => c.url === "/api/integrations/status")).toHaveLength(1);
  });

  it("says plainly that the app works without AI when it is disabled", async () => {
    mockApi([{ path: "/api/integrations/status", body: integrations }]);
    renderAt("/", "/", <Layout>page</Layout>, withMode("disabled"));
    await userEvent.click(screen.getByRole("button", { name: "ИИ отключён" }));
    const details = document.getElementById("ai-mode-details") as HTMLElement;
    expect(within(details).getByText(/Поиск, документы, ручное редактирование и ревью работают полностью/)).toBeVisible();
    expect(within(details).queryByText("Где ищет")).toBeNull();
  });
});
