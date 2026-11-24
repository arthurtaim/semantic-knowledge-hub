import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentLinks } from "../api/types";
import { ASSISTANT_OPEN_KEY, DETAILS_OPEN_KEY, DocumentPage } from "../pages/DocumentPage";
import { arisDetail, gitlabDetail, proposalSummary } from "./fixtures";
import { memoryStorage, mockApi, mockViewport, renderAt, renderRoutes, type MockRoute } from "./helpers";

const drafts = { items: [], total: 0 };
const links: DocumentLinks = {
  document_id: "SEM-INT-ARIS-001",
  generation: "g7",
  outgoing: [
    {
      target: { document_id: "SEM-ARCH-001", title: "Semantic Layer — demonstration architecture", status: "approved", type: "architecture" },
      relation: "references",
      via: ["related_ids"],
      labels: [],
      lines: [],
    },
  ],
  backlinks: [
    {
      source: { document_id: "SEM-ARCH-001", title: "Semantic Layer — demonstration architecture", status: "approved", type: "architecture" },
      relation: "references",
      via: ["related_ids"],
      lines: [],
      excerpts: [],
    },
    {
      source: { document_id: "SEM-DEC-001", title: "ADR-демо", status: "approved", type: "decision" },
      relation: "references",
      via: ["inline"],
      lines: [4],
      excerpts: ["См. [[SEM-INT-ARIS-001]]"],
    },
  ],
  unresolved: [],
};

function documentRoutes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
    { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
  ];
}

/** The properties grid under the title (a description list). */
const properties = () => screen.getByText("Владелец", { selector: ".doc-props dt" }).closest("dl") as HTMLElement;

beforeEach(() => {
  // «Сведения» remembers whether it was left open: every test starts from an empty store.
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Document detail", () => {
  it("shows the status line, the title and the six properties instead of a boxed passport", async () => {
    mockApi(documentRoutes([{ path: "/api/documents/SEM-INT-ARIS-001/links", body: links }]));
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "ARIS integration — questions for discovery" })).toBeInTheDocument();
    expect(screen.getByText("Демо-документ")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Паспорт документа" })).toBeNull();

    const props = properties();
    const value = (term: string) => within(props).getByText(term).nextElementSibling as HTMLElement;
    expect(within(props).getAllByRole("term").map((t) => t.textContent)).toEqual([
      "Владелец",
      "Раздел",
      "Проверен",
      "Источник",
      "Ревизия",
      "Связи",
    ]);
    expect(value("Владелец")).toHaveTextContent("demo-team");
    expect(within(value("Раздел")).getByRole("link", { name: "Интеграции" })).toHaveAttribute("href", "/documents?type=integration");
    expect(value("Проверен")).toHaveTextContent("Проверка не требуется");
    expect(value("Источник")).toHaveTextContent("Локальный workspace");
    expect(value("Ревизия")).toHaveTextContent("sha256:df6c505c");
    expect(within(value("Ревизия")).getByText("sha256:df6c505c")).toHaveAttribute("title", "sha256:df6c505c42a7e51e");
    // A real number from the links API: distinct documents across outgoing links and backlinks.
    expect(await within(value("Связи")).findByRole("button", { name: "2 документа" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Предложить изменение" })).toHaveAttribute(
      "href",
      "/proposals/new?document=SEM-INT-ARIS-001",
    );
  });

  it("does not invent a link count when the links did not load", async () => {
    mockApi(documentRoutes([{ path: "/api/documents/SEM-INT-ARIS-001/links", status: 500, body: { code: "x", message: "Сбой.", request_id: "r" } }]));
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const props = (await screen.findByText("Связи", { selector: "dt" })).parentElement as HTMLElement;
    expect(await within(props).findByText("не загрузились")).toBeInTheDocument();
    expect(within(props).queryByRole("button")).toBeNull();
  });

  it("opens «Связи» from the property and keeps the links and the graph link there", async () => {
    mockApi(documentRoutes([{ path: "/api/documents/SEM-INT-ARIS-001/links", body: links }]));
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await userEvent.click(await screen.findByRole("button", { name: "2 документа" }));
    const tab = screen.getByRole("tab", { name: "Связи" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(tab).toHaveFocus());
    const panel = screen.getByRole("tabpanel", { name: "Связи" });
    expect(within(panel).getByRole("heading", { name: "Связи документа" })).toBeInTheDocument();
    expect(within(panel).getByRole("region", { name: /Обратные ссылки/ })).toHaveTextContent("ADR-демо");
    expect(within(panel).getByRole("link", { name: "Связи на графе" })).toHaveAttribute("href", "/graph?focus=SEM-INT-ARIS-001");
  });

  it("has four segments — Текст, Связи, История, Markdown — and no repeated content between them", async () => {
    mockApi(documentRoutes());
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Текст", "Связи", "История", "Markdown"]);
    expect(screen.getByRole("tabpanel", { name: "Текст" })).toHaveTextContent("Body");
    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(screen.getByRole("tabpanel", { name: "Markdown" })).toHaveTextContent("id: SEM-INT-ARIS-001");
    expect(screen.queryByText("Body")).toBeNull();
  });

  it("«История» lists the real revision and the proposals of this document, and says what it does not know", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      {
        path: "/api/drafts?document_id=SEM-INT-ARIS-001",
        body: { items: [proposalSummary({ reason: "Уточнить вопросы", status: "merged" })], total: 1 },
      },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "История" }));
    const panel = screen.getByRole("tabpanel", { name: "История" });
    expect(within(panel).getByText("sha256:df6c505c42a7e51e")).toBeInTheDocument();
    expect(within(panel).getByText(/локальный workspace не хранит прежние ревизии/)).toBeInTheDocument();
    const proposal = within(panel).getByRole("link", { name: "Уточнить вопросы" });
    expect(proposal).toHaveAttribute("href", `/proposals/${"a".repeat(32)}`);
    expect(within(proposal.closest("li") as HTMLElement).getByText("Принято (merge)")).toBeInTheDocument();
    // No publication API answer: an honest state, not an invented one.
    expect(await within(panel).findByText("Состояние публикации недоступно.")).toBeInTheDocument();
  });

  it("«История» says so when there were no proposals", async () => {
    mockApi(documentRoutes());
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "История" }));
    expect(screen.getByText("К этому документу предложений изменений не было.")).toBeInTheDocument();
  });

  it("opens the segment that holds an anchor from the URL", async () => {
    mockApi(documentRoutes([{ path: "/api/documents/SEM-INT-ARIS-001/links", body: links }]));
    renderAt("/documents/SEM-INT-ARIS-001#doc-links", "/documents/:id", <DocumentPage />);
    expect(await screen.findByRole("tab", { name: "Связи" })).toHaveAttribute("aria-selected", "true");
  });

  it("puts every former passport field in «Сведения о документе», opened from the page and closed with Esc", async () => {
    mockApi(documentRoutes());
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const open = await screen.findByRole("button", { name: "Все сведения" });
    await userEvent.click(open);
    const details = screen.getByRole("complementary", { name: "Сведения о документе" });
    expect(within(details).getByRole("heading", { name: "Сведения о документе" })).toHaveFocus();
    for (const text of [
      "SEM-INT-ARIS-001",
      "Черновик",
      "sha256:df6c505c42a7e51e",
      "Дата ревизии",
      "local://SEM-INT-ARIS-001",
      "SEM-INT-ARIS-001.md",
      "demo-team",
      "Synthetic discovery questions.",
      "Ссылки в тексте",
    ]) {
      expect(details).toHaveTextContent(text);
    }
    expect(within(details).getByText(/Документ хранится в локальном workspace/)).toBeInTheDocument();
    expect(within(details).getByText("Демо-данные.")).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "aris" })).toHaveAttribute("href", "/documents?tag=aris");
    expect(within(details).getByRole("link", { name: "Semantic Layer — demonstration architecture" })).toHaveAttribute(
      "href",
      "/documents/SEM-ARCH-001",
    );
    expect(screen.queryByRole("link", { name: /Открыть в GitLab/ })).toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Сведения о документе" })).toBeNull();
    expect(open).toHaveFocus();
  });

  it("opens «Сведения» from «Ещё» and closes it with its own button", async () => {
    mockApi(documentRoutes());
    renderRoutes("/documents/SEM-INT-ARIS-001", { "/documents/:id": <DocumentPage /> });
    await userEvent.click(await screen.findByRole("button", { name: "Ещё" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Сведения о документе" }));
    const details = screen.getByRole("complementary", { name: "Сведения о документе" });
    await userEvent.click(within(details).getByRole("button", { name: "Закрыть: Сведения о документе" }));
    expect(screen.queryByRole("complementary", { name: "Сведения о документе" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Показать на карте знаний" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/graph?focus=SEM-INT-ARIS-001");
  });

  it("is a modal sheet below 1200 px: focus goes to «Закрыть», Esc returns it", async () => {
    mockViewport(1024);
    mockApi(documentRoutes());
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const open = await screen.findByRole("button", { name: "Все сведения" });
    await userEvent.click(open);
    const sheet = screen.getByRole("dialog", { name: "Сведения о документе" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(within(sheet).getByRole("button", { name: "Закрыть: Сведения о документе" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).toHaveFocus();
  });

  it("remembers that «Сведения» was left open on a wide screen, and that it was closed", async () => {
    mockApi(documentRoutes());
    const first = renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Все сведения" }));
    expect(localStorage.getItem(DETAILS_OPEN_KEY)).toBe("1");
    first.unmount();

    const second = renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const details = await screen.findByRole("complementary", { name: "Сведения о документе" });
    await userEvent.click(within(details).getByRole("button", { name: "Закрыть: Сведения о документе" }));
    expect(localStorage.getItem(DETAILS_OPEN_KEY)).toBeNull();
    second.unmount();

    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await screen.findByRole("button", { name: "Все сведения" });
    expect(screen.queryByRole("complementary", { name: "Сведения о документе" })).toBeNull();
  });

  it("does not open «Сведения» by itself as a sheet below 1200 px, even when it was left open", async () => {
    localStorage.setItem(DETAILS_OPEN_KEY, "1");
    mockViewport(1024);
    mockApi(documentRoutes());
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await screen.findByRole("button", { name: "Все сведения" });
    expect(screen.queryByRole("dialog", { name: "Сведения о документе" })).toBeNull();
  });

  it("keeps one right panel remembered: opening «Сведения» forgets the assistant, and back", async () => {
    localStorage.setItem(ASSISTANT_OPEN_KEY, "1");
    mockApi([...documentRoutes(), { path: "/api/assistant/skills", body: [] }]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    expect(await screen.findByRole("complementary", { name: "Ассистент" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Все сведения" }));
    expect(localStorage.getItem(DETAILS_OPEN_KEY)).toBe("1");
    expect(localStorage.getItem(ASSISTANT_OPEN_KEY)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ассистент" }));
    expect(localStorage.getItem(ASSISTANT_OPEN_KEY)).toBe("1");
    expect(localStorage.getItem(DETAILS_OPEN_KEY)).toBeNull();
  });

  it("still opens and closes «Сведения» when the browser storage is blocked", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    mockApi(documentRoutes());
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Все сведения" }));
    const details = screen.getByRole("complementary", { name: "Сведения о документе" });
    await userEvent.click(within(details).getByRole("button", { name: "Закрыть: Сведения о документе" }));
    expect(screen.queryByRole("complementary", { name: "Сведения о документе" })).toBeNull();
  });

  it("sanitizes hostile HTML before rendering", async () => {
    mockApi(documentRoutes());
    const { container } = renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await screen.findByRole("heading", { name: "ARIS", level: 1 });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
    expect(container.querySelector('a[href="/documents/SEM-ARCH-001"]')).not.toBeNull();
  });

  it("shows a not-found state for unknown documents", async () => {
    mockApi([
      { path: "/api/documents/NOPE", status: 404, body: { code: "document_not_found", message: "Документ NOPE не найден.", request_id: "r1" } },
      { path: "/api/drafts?document_id=NOPE", body: drafts },
    ]);
    renderAt("/documents/NOPE", "/documents/:id", <DocumentPage />);
    expect(await screen.findByText("Документ не найден")).toBeInTheDocument();
  });

  it("links to the exact GitLab revision and flags a stale index state", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: gitlabDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await screen.findByRole("heading", { level: 1, name: "ARIS integration — questions for discovery" });
    const props = properties();
    const link = within(props).getByRole("link", { name: "Открыть в GitLab" });
    expect(link).toHaveAttribute("href", gitlabDetail.web_url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(props).getByText("3f2a9c1d")).toBeInTheDocument();
    expect(within(props).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    expect(screen.getByText("Версия может быть устаревшей.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Все сведения" }));
    const details = screen.getByRole("complementary", { name: "Сведения о документе" });
    expect(within(details).getByRole("link", { name: "Открыть в GitLab" })).toHaveAttribute("href", gitlabDetail.web_url);
    expect(details).toHaveTextContent("gitlab://semantic-kb/docs/SEM-INT-ARIS-001.md");
    expect(screen.queryByText(/локальном workspace/)).toBeNull();
  });
});
