import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AskResponse, AskStreamEvent, Citation } from "../api/types";
import { AskPage } from "../pages/AskPage";
import { supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, renderRoutes, type MockRoute } from "./helpers";

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

const teamCitation = supportedAnswer.citations[0] as Citation;
const corporateCitation: Citation = {
  ref: 2,
  source_type: "confluence",
  document_id: "200101",
  title: "Регламент заморозки изменений метаданных (демо)",
  source_uri: "mock-confluence://OPS/200101",
  revision: "3",
  status: null,
  section: "Когда действует заморозка",
  section_anchor: null,
  excerpt: "Заморозка действует в последнюю неделю квартала.",
  retrieved_at: "2026-11-23T12:00:00Z",
  is_demo: true,
  app_path: "/corporate/200101",
  source_kind: "confluence_mcp",
  source_id: "confluence:demo-wiki:200101:3",
  external_status: "unknown",
};

const mixed: AskResponse = {
  ...supportedAnswer,
  mode: "internal_api",
  warnings: [],
  answer: "Четыре слоя [1]. Заморозка — в последнюю неделю квартала [2].",
  citations: [teamCitation, corporateCitation],
};

async function ask(question = "Какие слои у архитектуры?") {
  await userEvent.type(screen.getByLabelText("Вопрос"), question);
  await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
  return screen.findByRole("heading", { name: "Ответ" });
}

describe("Evidence-first answer", () => {
  it("puts the quoted evidence before the explanation and names the support level as a category", async () => {
    mockApi([streamRoute(...final(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const evidence = screen.getByRole("heading", { name: "Доказательства" });
    const explanation = screen.getByRole("heading", { name: "Объяснение" });
    expect(evidence.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Подтверждено источниками")).toHaveClass("confidence--supported");
    expect(screen.queryByText(/%/)).toBeNull();
    // Mock output is labelled «Демо»; it is not generated text, so it carries no «ИИ» label.
    expect(screen.getByText("Демо", { selector: ".demo-tag" })).toBeInTheDocument();
    expect(screen.queryByText("ИИ", { selector: ".ai-label" })).toBeNull();
  });

  it("never mixes team documents and corporate pages in one list; generated text is labelled «ИИ»", async () => {
    mockApi([streamRoute(...final(mixed))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const team = screen.getByRole("region", { name: "Документы команды" });
    const corporate = screen.getByRole("region", { name: "Корпоративные источники" });
    expect(within(team).getAllByRole("listitem")).toHaveLength(1);
    expect(within(team).getByText(teamCitation.title)).toBeInTheDocument();
    expect(within(team).queryByText(corporateCitation.title)).toBeNull();
    expect(within(corporate).getAllByRole("listitem")).toHaveLength(1);
    expect(within(corporate).getByText(/не утверждённые документы команды/)).toBeInTheDocument();
    expect(screen.getByText("ИИ", { selector: ".ai-label" })).toBeInTheDocument();
    expect(screen.queryByText("Демо", { selector: ".demo-tag" })).toBeNull();
  });

  it("shows the cited passage, document, source, status and revision on marker hover and focus; a click opens the section", async () => {
    mockApi([streamRoute(...final(mixed))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const marker = screen.getByRole("link", { name: "Источник 1" });
    expect(marker).toHaveAttribute("href", teamCitation.app_path);
    const card = document.getElementById(marker.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(card).toHaveAttribute("role", "tooltip");
    expect(card).not.toBeVisible();
    await userEvent.hover(marker);
    expect(card).toBeVisible();
    expect(within(card).getByText(teamCitation.title)).toBeInTheDocument();
    expect(within(card).getByText("Документ команды")).toBeInTheDocument();
    expect(within(card).getByText("Утверждён")).toBeInTheDocument();
    expect(within(card).getByText("sha256:0b52b3c3")).toBeInTheDocument();
    expect(card).toHaveTextContent(teamCitation.excerpt);
    await userEvent.unhover(marker);
    expect(card).not.toBeVisible();

    const external = screen.getByRole("link", { name: "Источник 2" });
    act(() => external.focus());
    const externalCard = document.getElementById(external.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(externalCard).toBeVisible();
    expect(within(externalCard).getByText("Confluence · версия 3")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(externalCard).not.toBeVisible();
  });

  it("offers next steps that work: open the cited team document, propose a change through review, refine the question", async () => {
    mockApi([streamRoute(...final(mixed))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Какие слои у архитектуры?");
    const next = screen.getByRole("group", { name: "Что дальше" });
    expect(within(next).getByRole("link", { name: "Открыть документ" })).toHaveAttribute("href", teamCitation.app_path);
    const propose = within(next).getByRole("link", { name: "Предложить правку по этому ответу" });
    expect(propose).toHaveAttribute("href", "/proposals/new?document=SEM-ARCH-001");
    expect(propose).toHaveAccessibleDescription(/черновик, diff и ревью/);
    await userEvent.click(within(next).getByRole("button", { name: "Уточнить вопрос" }));
    const field = screen.getByLabelText("Вопрос");
    expect(field).toHaveValue("Какие слои у архитектуры?");
    expect(field).toHaveFocus();
  });

  it("does not offer document actions when only corporate pages support the answer", async () => {
    mockApi([streamRoute(...final({ ...mixed, citations: [corporateCitation], answer: "Заморозка [2]." }))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const next = screen.getByRole("group", { name: "Что дальше" });
    expect(within(next).queryByRole("link")).toBeNull();
    expect(within(next).getByRole("button", { name: "Уточнить вопрос" })).toBeInTheDocument();
  });

  it("shows the answer stages as a track", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои?");
    await userEvent.click(screen.getByRole("button", { name: "Спросить" }));
    const track = await screen.findByRole("list", { name: "Этапы ответа" });
    expect(within(track).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Ищу источники",
      "Формирую ответ",
      "Проверяю цитаты",
    ]);
    expect(within(track).getByText("Ищу источники")).toHaveAttribute("aria-current", "step");
    stream.push({ type: "status", stage: "validating" });
    expect(await within(track).findByText("Проверяю цитаты")).toHaveAttribute("aria-current", "step");
    stream.push({ type: "final", response: supportedAnswer });
    stream.close();
    expect(await screen.findByRole("heading", { name: "Ответ" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Этапы ответа" })).toBeNull();
  });

  it("keeps the answers when the reader follows a citation and comes back (memory only)", async () => {
    mockApi([streamRoute(...final(supportedAnswer))]);
    renderRoutes("/ask", {
      "/ask": <AskPage />,
      "/documents/:id": <Link to="/ask">Вернуться к ответу</Link>,
    });
    await ask();
    await userEvent.click(screen.getByRole("link", { name: "Источник 1" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/documents/SEM-ARCH-001");
    await userEvent.click(screen.getByRole("link", { name: "Вернуться к ответу" }));
    expect(screen.getByRole("heading", { name: "Ответ" })).toBeInTheDocument();
    expect(screen.getByText("Какие слои у архитектуры?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    expect(screen.queryByRole("heading", { name: "Ответ" })).toBeNull();
  });
});
