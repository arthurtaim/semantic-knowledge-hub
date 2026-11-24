import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AiMode, AskResponse, AskStreamEvent, SessionResponse } from "../api/types";
import { Layout } from "../components/Layout";
import { AskPage } from "../pages/AskPage";
import { DocumentCreatePage } from "../pages/DocumentCreatePage";
import { DocumentPage } from "../pages/DocumentPage";
import { ExplorerPage } from "../pages/ExplorerPage";
import { ProposalEditorPage } from "../pages/ProposalEditorPage";
import { arisDetail, documentPage, facets, insufficientAnswer, session, templates } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

const STREAM = "/api/assistant/ask/stream";
const withMode = (ai_mode: AiMode, extra: Partial<SessionResponse["features"]> = {}): SessionResponse => ({
  ...session,
  features: { ...session.features, ai_mode, ...extra },
});

function streamRoute(response: AskResponse): MockRoute {
  return {
    method: "POST",
    path: STREAM,
    respond: (init) => {
      const stream = ndjsonStream();
      const result = stream.respond(init);
      stream.push({ type: "final", response } satisfies AskStreamEvent);
      stream.close();
      return result;
    },
  };
}

const closest = { path: /^\/api\/documents\?query=/, body: documentPage };
const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);

async function askSla() {
  await userEvent.type(screen.getByLabelText("Вопрос"), "Какой SLA у интеграции с ЦФТ?");
  await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
  return screen.findByRole("heading", { name: "В базе знаний нет ответа на этот вопрос" });
}

describe("«Недостаточно данных» card", () => {
  it("says what and where was searched, lists the closest documents (not as evidence) and three steps", async () => {
    mockApi([streamRoute(insufficientAnswer), closest]);
    renderAt("/ask", "/ask", <AskPage />);
    const card = (await askSla()).closest("section") as HTMLElement;
    expect(within(card).getByText("Подтверждений в доступных источниках не найдено.")).toBeInTheDocument();
    expect(within(card).getByText(/Искали «Какой SLA у интеграции с ЦФТ\?» — документы команды — утверждённые/)).toBeInTheDocument();
    expect(within(card).getByText(/Не найдено в источниках/)).toHaveTextContent("«ЦФТ»");
    expect(within(card).getByText(/это не подтверждение ответа/)).toBeInTheDocument();
    expect(await within(card).findByRole("link", { name: "ARIS integration — questions for discovery" })).toHaveAttribute(
      "href",
      "/documents/SEM-INT-ARIS-001",
    );
    expect(card.querySelector(".citation, .citations")).toBeNull(); // partial matches are not citations

    const steps = within(card).getAllByRole("listitem").filter((li) => li.closest(".insufficient__steps"));
    expect(steps).toHaveLength(3);
    expect(within(card).getByText(/Confluence Data Center не подключён/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Искать в корпоративных источниках" })).toBeNull();
    expect(within(card).getByRole("link", { name: "Создать черновик документа" })).toHaveAttribute("href", "/documents/new");
    await userEvent.click(within(card).getByRole("button", { name: "Уточнить вопрос" }));
    expect(screen.getByLabelText("Вопрос")).toHaveValue("Какой SLA у интеграции с ЦФТ?");
    expect(screen.getByLabelText("Вопрос")).toHaveFocus();
    // Next steps of a supported answer are not repeated under the card.
    expect(screen.queryByRole("group", { name: "Что дальше" })).toBeNull();
  });

  it("runs a separate, labelled corporate-only request when corporate sources are available", async () => {
    const calls = mockApi([streamRoute(insufficientAnswer), closest]);
    renderAt("/ask", "/ask", <AskPage />, withMode("mock", { corporate_search: "mock" }));
    const card = (await askSla()).closest("section") as HTMLElement;
    expect(within(card).getByText(/mock-коннектор/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Искать в корпоративных источниках" }));
    await screen.findAllByRole("heading", { name: "Ассистент" });
    expect(posts(calls)).toHaveLength(2);
    expect(posts(calls)[1]?.body).toMatchObject({ question: "Какой SLA у интеграции с ЦФТ?", sources: ["corporate"], history: [] });
    expect(screen.getAllByText(/Где искать: Корпоративные/).length).toBeGreaterThan(0);
  });
});

describe("Four AI modes: no dead controls", () => {
  it("disabled: the ask page explains and searches instead of offering a button that fails", () => {
    renderAt("/ask", "/ask", <AskPage />, withMode("disabled"));
    expect(screen.getByRole("heading", { level: 1, name: "Спросить базу знаний" })).toBeInTheDocument();
    expect(screen.getByText(/ИИ в этой установке отключён/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Вопрос")).toBeNull();
    expect(screen.queryByRole("button", { name: "Отправить" })).toBeNull();
    // UI v2: the assistant field in its search form — no file or skill controls at all.
    expect(screen.getByRole("textbox", { name: "Поиск по базе знаний" })).toHaveAttribute("placeholder", "Найти в базе знаний");
    expect(screen.queryByRole("button", { name: "Файл" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Навык" })).toBeNull();
  });

  // UI v2: the sidebar's first item is the assistant (the start page); without AI it is the start page by name.
  it("disabled: the main navigation has no «Ассистент»; other modes keep it", () => {
    const { unmount } = renderAt("/documents", "/documents", <Layout>x</Layout>, withMode("disabled"));
    const nav = screen.getByRole("navigation", { name: "Основная навигация" });
    expect(within(nav).queryByRole("link", { name: "Ассистент" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Главная" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Документы" })).toHaveAttribute("aria-current", "page");
    unmount();
    renderAt("/documents", "/documents", <Layout>x</Layout>, withMode("mock"));
    expect(within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("link", { name: "Ассистент" })).toBeInTheDocument();
  });

  it("disabled: the explorer does not offer «Спросить ИИ об этих документах»", async () => {
    const routes = [
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?query=ARIS&page=1&size=20", body: documentPage },
    ];
    mockApi(routes);
    const { unmount } = renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />, withMode("disabled"));
    await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(screen.queryByRole("link", { name: "Спросить ИИ об этих документах" })).toBeNull();
    unmount();
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />, withMode("mock"));
    expect(await screen.findByRole("link", { name: "Спросить ИИ об этих документах" })).toBeInTheDocument();
  });

  it("disabled: the document page has no AI entry points; mock keeps them", async () => {
    const routes = [
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: { items: [], total: 0 } },
    ];
    mockApi(routes);
    const { unmount } = renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />, withMode("disabled"));
    await screen.findByRole("complementary", { name: "Паспорт документа" });
    expect(screen.getByRole("link", { name: "Предложить изменение" })).toBeInTheDocument(); // the manual path
    expect(screen.queryByRole("link", { name: "Спросить ассистента" })).toBeNull();
    expect(screen.queryByRole("link", { name: "ИИ-помощник" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "ИИ-помощник по документу" })).toBeNull();
    unmount();
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />, withMode("mock"));
    expect(await screen.findByRole("heading", { name: "ИИ-помощник по документу" })).toBeInTheDocument();
  });

  it("disabled: a new document is created manually only — the AI option is not offered", async () => {
    mockApi([{ path: /^\/api\/authoring\/templates(\?include_hidden=true)?$/, body: templates }]);
    renderRoutes("/documents/new", { "/documents/new": <DocumentCreatePage /> }, withMode("disabled", { ai_authoring: false }));
    expect(await screen.findByRole("radio", { name: "Вручную" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "С помощью AI" })).toBeNull();
    expect(screen.getByText("ИИ в этой установке отключён — документ создаётся вручную по шаблону.")).toBeInTheDocument();
  });

  it("propose change: mock shows the AI action disabled with a one-line reason; disabled hides the section", async () => {
    mockApi([{ path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail }]);
    const { unmount } = renderAt("/proposals/new?document=SEM-INT-ARIS-001", "/proposals/new", <ProposalEditorPage />);
    const button = await screen.findByRole("button", { name: "Подготовить черновик" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/В демо-режиме ИИ не генерирует правки/);
    unmount();
    renderAt("/proposals/new?document=SEM-INT-ARIS-001", "/proposals/new", <ProposalEditorPage />, withMode("disabled"));
    expect(await screen.findByRole("textbox", { name: "Текст документа" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Черновик от ИИ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Подготовить черновик" })).toBeNull();
  });
});
