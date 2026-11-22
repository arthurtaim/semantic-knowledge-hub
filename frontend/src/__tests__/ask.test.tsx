import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AskPage } from "../pages/AskPage";
import { insufficientAnswer, supportedAnswer } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

describe("Ask the knowledge base", () => {
  it("shows a grounded demo answer with clickable citations", async () => {
    const calls = mockApi([{ method: "POST", path: "/api/assistant/ask", body: supportedAnswer }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "What layers does the architecture have?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));

    expect(await screen.findByText("Подтверждено источником")).toBeInTheDocument();
    expect(screen.getByText("Демо-режим, без языковой модели")).toBeInTheDocument();
    const marker = screen.getByRole("link", { name: "Источник 1" });
    expect(marker).toHaveAttribute("href", "#cite-1");
    const source = screen.getByRole("link", { name: "Semantic Layer — demonstration architecture" });
    expect(source).toHaveAttribute("href", "/documents/SEM-ARCH-001#semantic-layer-demonstration-architecture");
    expect(screen.getByText("Корпоративные источники не подключены.")).toBeInTheDocument();

    const request = calls.find((c) => c.method === "POST");
    expect(request?.headers["X-SKH-Client"]).toBe("web");
    expect(request?.body).toEqual({
      question: "What layers does the architecture have?",
      sources: ["team"],
      include_drafts: false,
      include_deprecated: false,
    });
  });

  it("states insufficient evidence and lists excluded drafts", async () => {
    mockApi([{ method: "POST", path: "/api/assistant/ask", body: insufficientAnswer }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.click(screen.getByRole("button", { name: "Какой SLA у интеграции с ЦФТ?" }));
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByText("Недостаточно данных")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Источники" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Не использованы как доказательство" })).toBeInTheDocument();
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

  it("surfaces a disabled assistant clearly", async () => {
    mockApi([
      {
        method: "POST",
        path: "/api/assistant/ask",
        status: 503,
        body: { code: "assistant_disabled", message: "Ассистент отключён конфигурацией.", request_id: "r" },
      },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Что такое ревизия?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    expect(await screen.findByText("Интеграция недоступна")).toBeInTheDocument();
  });
});
