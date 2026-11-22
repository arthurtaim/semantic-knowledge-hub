import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { IntegrationsPage } from "../pages/IntegrationsPage";
import { documentPage, facets, integrations, session } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

describe("Application shell", () => {
  it("shows navigation and a conspicuous demo notice", async () => {
    mockApi([
      { path: "/api/session", body: session },
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?size=100", body: documentPage },
      { path: "/api/integrations/status", body: integrations },
    ]);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Основная навигация" });
    for (const name of ["Главная", "База знаний", "Спросить", "Предложения", "Интеграции"]) {
      expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(await screen.findByText(/Confluence не подключён/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Демо-данные.");
    expect(await screen.findByRole("heading", { name: "Разделы" })).toBeInTheDocument();
  });

  it("is keyboard navigable from the skip link", async () => {
    mockApi([{ path: "/api/session", body: session }]);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Перейти к содержимому" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: /Semantic Knowledge Hub/ })).toHaveFocus();
  });
});

describe("Integrations page", () => {
  it("never shows unconfigured integrations as connected", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    const gitlab = (await screen.findByRole("heading", { name: "GitLab (каноническая база знаний)" })).closest("li") as HTMLElement;
    expect(within(gitlab).getByText("Не подключено", { selector: ".state" })).toBeInTheDocument();
    const confluence = screen.getByRole("heading", { name: /Confluence Data Center/ }).closest("li") as HTMLElement;
    expect(within(confluence).getByText("Не подключено", { selector: ".state" })).toBeInTheDocument();
    expect(screen.queryAllByText("Подключено", { selector: ".state" })).toHaveLength(1); // only local knowledge
    const ai = screen.getByRole("heading", { name: "AI-провайдер" }).closest("li") as HTMLElement;
    expect(within(ai).getByText("Демо (mock)")).toBeInTheDocument();
  });
});
