import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationsPage } from "../pages/IntegrationsPage";
import { integrations } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

const failing = {
  ...integrations.items[0],
  name: "gitlab_proposals",
  title: "GitLab Merge Requests для предложений",
  state: "error" as const,
  human_readable_message: "Проверка соединения не прошла.",
};

describe("Integrations list", () => {
  it("lists failed, connected and demo integrations first and groups the unconfigured ones", async () => {
    mockApi([
      { path: "/api/integrations/status", body: { ...integrations, items: [...integrations.items, failing] } },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    await screen.findByRole("heading", { name: "AI-провайдер" });

    const order = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(order.slice(0, 4)).toEqual([
      "GitLab Merge Requests для предложений",
      "Локальная база знаний",
      "AI-провайдер",
      "Не подключено",
    ]);
    const group = screen.getByRole("heading", { name: "Не подключено", level: 2 }).nextElementSibling as HTMLElement;
    for (const item of within(group).getAllByRole("listitem")) {
      expect(within(item).getByText("Не подключено", { selector: ".state" })).toBeInTheDocument();
    }
    expect(within(group).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows target, access, last check and capabilities as facts of the row", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    const row = (await screen.findByRole("heading", { name: "AI-провайдер" })).closest("li") as HTMLElement;
    const facts = within(row).getByText("Цель").closest("dl") as HTMLElement;
    for (const term of ["Цель", "Доступ", "Последняя проверка", "Возможности"]) {
      expect(within(facts).getByText(term)).toBeInTheDocument();
    }
    expect(within(facts).getByText("extractive_answers")).toBeInTheDocument();
  });
});
