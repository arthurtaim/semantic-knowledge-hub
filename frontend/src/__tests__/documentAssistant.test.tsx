import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiMode, AiProposal, AskResponse, AskStreamEvent, AssistantSkill, DocumentDetail, SessionResponse } from "../api/types";
import { ASSISTANT_OPEN_KEY, DocumentPage } from "../pages/DocumentPage";
import { arisDetail, attachmentReady, session, skills, storedConversation, storedTurn, supportedAnswer } from "./fixtures";
import { memoryStorage, mockApi, mockViewport, ndjsonStream, renderAt, type MockRoute, type RecordedCall } from "./helpers";

/*
 * UI v2 phase D (docs/ui-v2/specs/03_SCREENS.md §3, design-04): the document's assistant panel (toolbar toggle,
 * ⌘J / Ctrl+J, context chips, quick actions mapped to skills, a short conversation) and the floating bar over a
 * selection in the text.
 */

const DOC_ID = "SEM-ARCH-001";
const STREAM = "/api/assistant/ask/stream";

/** A document with a hidden H1, an intro and two sections — enough to find the nearest heading of a selection. */
const archDetail: DocumentDetail = {
  ...arisDetail,
  id: DOC_ID,
  title: "Semantic Layer — demonstration architecture",
  type: "architecture",
  status: "approved",
  content_html:
    '<h1 id="semantic-layer-demonstration-architecture">Semantic Layer — demonstration architecture</h1>' +
    "<p>This local demonstration models a knowledge base with four layers.</p>" +
    '<h2 id="principles">Principles</h2>' +
    // As the backend renders it: a line break between list items.
    "<ul>\n<li>A document always has a stable ID and an approval status.</li>\n<li>Search results reference their source document.</li>\n</ul>" +
    '<h2 id="unknowns">Unknowns</h2><p>Actual corporate systems have not been supplied.</p>',
  sections: [
    { heading: "Semantic Layer — demonstration architecture", anchor: "semantic-layer-demonstration-architecture", level: 1, text: "This local demonstration models a knowledge base with four layers." },
    { heading: "Principles", anchor: "principles", level: 2, text: "A document always has a stable ID and an approval status.\nSearch results reference their source document." },
    { heading: "Unknowns", anchor: "unknowns", level: 2, text: "Actual corporate systems have not been supplied." },
  ],
};

const withMode = (ai_mode: AiMode): SessionResponse => ({ ...session, features: { ...session.features, ai_mode } });

function streamOf(response: AskResponse): MockRoute {
  return {
    method: "POST",
    path: STREAM,
    respond: () =>
      new Response(`${JSON.stringify({ type: "final", response } satisfies AskStreamEvent)}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
  };
}

const PROPOSALS_OF_DOC = `/api/ai/proposals?document_id=${DOC_ID}`;

function routes(extra: MockRoute[] = [], registry: AssistantSkill[] = skills): MockRoute[] {
  return [
    ...extra,
    { path: `/api/documents/${DOC_ID}`, body: archDetail },
    { path: `/api/drafts?document_id=${DOC_ID}`, body: { items: [], total: 0 } },
    { path: "/api/assistant/skills", body: registry },
    // The document's earlier AI proposals (none unless a test says otherwise).
    { path: PROPOSALS_OF_DOC, body: [] },
  ];
}

/** An M5.6.3 metadata proposal for this document, as GET /api/ai/proposals/{id} returns it. */
const metadataProposal: AiProposal = {
  id: "AIP-00000000000000m1",
  kind: "suggest_metadata",
  status: "suggested",
  created_at: "2026-11-24T10:00:00Z",
  decided_at: null,
  mode: "mock",
  base: { draft_id: null, edit_version: null, document_id: DOC_ID, revision: "sha256:abc", template_id: null, template_version: null, index_generation: "g1" },
  summary: "Предложены теги по утверждённым документам.",
  items: [
    { id: "tags", kind: "metadata", field: "tags", section: null, target_id: null, current: ["architecture"], proposed: ["architecture", "layers"], reason: "Слово «layers» есть в тексте", evidence: [], applicable: true },
  ],
  warnings: [],
  insufficient: false,
  graph_link: null,
  applied_items: [],
  result_draft_id: null,
};

const asks = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST" && call.url === STREAM);

function renderDocument(mode: AiMode = "mock") {
  return renderAt(`/documents/${DOC_ID}`, "/documents/:id", <DocumentPage />, withMode(mode));
}

/** The page title (the Markdown's own H1 is in the text too, hidden by CSS the tests do not load). */
const loaded = () => screen.findByText(archDetail.title, { selector: ".doc-head__title" });
const toggle = () => screen.getByRole("button", { name: "Ассистент" });
const panel = () => screen.getByRole("complementary", { name: "Ассистент" });
const queryPanel = () => screen.queryByRole("complementary", { name: "Ассистент" });
const prose = () => document.querySelector("#doc-panel .prose") as HTMLElement;

/** Selects `text` inside the element that holds it, as a mouse or Shift+arrows would. */
function select(text: string, root: HTMLElement = prose()): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    const at = data.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }
  throw new Error(`not found: ${text}`);
}

/** Mouse: press in the text, select, release — the bar appears once the selection settles. */
function mouseSelect(text: string): void {
  fireEvent.mouseDown(prose(), { button: 0 });
  select(text);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.mouseUp(document, { button: 0 });
}

/** Keyboard (Shift+arrows): only selection changes, no mouse. */
function keyboardSelect(text: string, root?: HTMLElement): void {
  select(text, root);
  fireEvent(document, new Event("selectionchange"));
}

/** The bar is in the page while the text is shown; `hidden` until there is a selection. */
const bar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Действия с выделением"]');

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe("Document assistant panel", () => {
  it("is closed by default and toggles with «Ассистент» (pressed state, focus in the field, focus back)", async () => {
    mockApi(routes());
    renderDocument();
    await loaded();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(queryPanel()).toBeNull();

    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(within(panel()).getByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(within(panel()).getByText("ИИ: без модели")).toBeInTheDocument();
    const field = within(panel()).getByRole("textbox", { name: "Вопрос по документу" });
    expect(field).toHaveAttribute("placeholder", "Спросите про этот документ");
    expect(field).toHaveFocus();

    await userEvent.click(within(panel()).getByRole("button", { name: "Закрыть: Ассистент" }));
    expect(queryPanel()).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(toggle()).toHaveFocus();
  });

  it("toggles with ⌘J and Ctrl+J — also on a Russian layout — but not while typing in another field", async () => {
    mockApi(routes());
    renderDocument();
    await loaded();

    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", metaKey: true });
    expect(queryPanel()).not.toBeNull();
    // From the panel's own field the shortcut closes it.
    fireEvent.keyDown(within(panel()).getByRole("textbox", { name: "Вопрос по документу" }), { key: "j", code: "KeyJ", ctrlKey: true });
    expect(queryPanel()).toBeNull();
    // «о» is J on a Russian layout: the key code decides.
    fireEvent.keyDown(document.body, { key: "о", code: "KeyJ", ctrlKey: true });
    expect(queryPanel()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "о", code: "KeyJ", ctrlKey: true });
    expect(queryPanel()).toBeNull();

    // Typing elsewhere: the shortcut belongs to that field.
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    fireEvent.keyDown(other, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(queryPanel()).toBeNull();
    other.remove();
  });

  it("remembers that it was left open (and closed) on a wide screen", async () => {
    mockApi(routes());
    const first = renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    expect(localStorage.getItem(ASSISTANT_OPEN_KEY)).toBe("1");
    first.unmount();

    const second = renderDocument();
    expect(await screen.findByRole("complementary", { name: "Ассистент" })).toBeInTheDocument();
    expect(within(panel()).getByRole("textbox", { name: "Вопрос по документу" })).not.toHaveFocus(); // not the reader's action
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle());
    expect(localStorage.getItem(ASSISTANT_OPEN_KEY)).toBeNull();
    second.unmount();

    renderDocument();
    await loaded();
    expect(queryPanel()).toBeNull();
  });

  it("does not open by itself as a sheet below 1200 px, even when it was left open", async () => {
    localStorage.setItem(ASSISTANT_OPEN_KEY, "1");
    mockViewport(1024);
    mockApi(routes());
    renderDocument();
    await loaded();
    expect(screen.queryByRole("dialog", { name: "Ассистент" })).toBeNull();
    await userEvent.click(toggle());
    const sheet = screen.getByRole("dialog", { name: "Ассистент" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(within(sheet).getByRole("button", { name: "Закрыть: Ассистент" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Ассистент" })).toBeNull();
    expect(toggle()).toHaveFocus();
  });

  it("as a sheet, steps aside when a citation opens a place in this document", async () => {
    mockViewport(1024);
    mockApi(routes([streamOf(supportedAnswer)]));
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    const sheet = screen.getByRole("dialog", { name: "Ассистент" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Объяснить раздел" }));
    const marker = await within(sheet).findByRole("link", { name: "Источник 1" });
    await userEvent.click(marker);
    expect(screen.queryByRole("dialog", { name: "Ассистент" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Текст" })).toHaveAttribute("aria-selected", "true");
  });

  it("is one right panel with «Сведения»: opening one closes the other", async () => {
    mockApi(routes());
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    expect(queryPanel()).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Все сведения" }));
    expect(screen.getByRole("complementary", { name: "Сведения о документе" })).toBeInTheDocument();
    expect(queryPanel()).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle());
    expect(queryPanel()).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Сведения о документе" })).toBeNull();
  });

  it("shows the context as chips and runs a quick action with the skill and this document", async () => {
    const calls = mockApi(routes([streamOf(supportedAnswer)]));
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    const context = within(panel()).getByRole("region", { name: "Контекст" });
    expect(within(context).getByText("Этот документ")).toBeInTheDocument();
    expect(within(context).queryByText(/Выделение/)).toBeNull();
    // The document is context of every message: not repeated as a chip in the field.
    expect(within(panel()).queryByRole("button", { name: /Убрать документ/ })).toBeNull();

    const actions = within(panel()).getByRole("list", { name: "Быстрые действия" });
    expect(Array.from(actions.querySelectorAll(".doc-assistant__action")).map((item) => item.textContent)).toEqual([
      "Объяснить раздел",
      "Найти связанные",
      "Что перепроверить",
      "Предложить правку",
    ]);
    await userEvent.click(within(actions).getByRole("button", { name: "Что перепроверить" }));

    await waitFor(() => expect(asks(calls)).toHaveLength(1));
    const body = asks(calls)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ question: "", skill_id: "check_freshness", context_document_ids: [DOC_ID], sources: ["team"] });
    expect(body.conversation_id).toMatch(/^conv-[0-9a-f]{24}$/);
    expect(body.selection).toBeUndefined();

    const conversation = within(panel()).getByRole("region", { name: "Переписка" });
    expect(within(conversation).getByText("Что перепроверить", { selector: ".turn__bubble" })).toBeInTheDocument();
    const answer = await within(conversation).findByRole("region", { name: "Ассистент" });
    expect(within(answer).getByText("Подтверждено источниками")).toBeInTheDocument();
    // The mode (no language model) — not the content: the synthetic sources are the provenance line.
    expect(within(answer).getByText("Без модели", { selector: ".mode-tag" })).toBeInTheDocument();
    expect(within(answer).getByText("Источники: синтетические (учебные)")).toBeInTheDocument();
    expect(within(answer).getByRole("link", { name: "Источник 1" })).toHaveAttribute(
      "href",
      `/documents/${DOC_ID}#semantic-layer-demonstration-architecture`,
    );
    const sources = within(answer).getByRole("region", { name: "Источники" });
    expect(within(sources).getByRole("region", { name: "Документы команды" })).toHaveTextContent("раздел «Semantic Layer — demonstration architecture»");
    // A category, never a percentage.
    expect(answer.textContent).not.toMatch(/\d+\s?%/);
  });

  it("asks a question from the compact field with this document as context, keeping the same conversation", async () => {
    const calls = mockApi(routes([streamOf(supportedAnswer)]));
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    const field = within(panel()).getByRole("textbox", { name: "Вопрос по документу" });
    await userEvent.type(field, "Где ещё требуется стабильный ID?{Enter}");
    await waitFor(() => expect(asks(calls)).toHaveLength(1));
    expect(asks(calls)[0]?.body).toMatchObject({ question: "Где ещё требуется стабильный ID?", context_document_ids: [DOC_ID] });
    await within(panel()).findByRole("region", { name: "Ассистент" });
    expect(field).toHaveValue("");

    await userEvent.type(field, "А где ещё?{Enter}");
    await waitFor(() => expect(asks(calls)).toHaveLength(2));
    const [first, second] = asks(calls).map((call) => call.body as { conversation_id: string; history: unknown[] });
    expect(second?.conversation_id).toBe(first?.conversation_id);
    expect(second?.history).toEqual([{ question: "Где ещё требуется стабильный ID?", answer: supportedAnswer.answer }]);
  });

  it("M5.7: shows system facts compact under the panel's answer and sends their referent with a follow-up", async () => {
    const referent = { tool: "catalog_query", operation: "count", filters: {}, document_ids: [], value: 83 };
    const withFact: AskResponse = {
      ...supportedAnswer,
      mode: "internal_api",
      warnings: [],
      citations: [],
      answer: "В доступном вам каталоге SKH — 83 уникальных документов [F1].",
      system_facts: [
        {
          ref: "F1",
          tool: "catalog_query",
          operation: "count",
          label: "Документы в доступном каталоге SKH",
          value: 83,
          unit: "documents",
          effective_filters: {},
          definition: null,
          access_scope: "visible_to_request_context",
          source: "skh_document_registry",
          generation: "g1",
          as_of: "2026-11-24T09:00:00Z",
          items: [],
          truncated: false,
          breakdown: null,
        },
      ],
      conversation_context: [referent],
    };
    const calls = mockApi(routes([streamOf(withFact)]));
    renderAt(`/documents/${DOC_ID}`, "/documents/:id", <DocumentPage />, withMode("internal_api"));
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    const field = within(panel()).getByRole("textbox", { name: "Вопрос по документу" });
    await userEvent.type(field, "Сколько документов в базе?{Enter}");
    const block = await within(panel()).findByRole("region", { name: "Данные системы SKH" });
    expect(block).toHaveClass("facts--compact");
    expect(block).toHaveTextContent("83 документа");
    expect(within(panel()).getByRole("link", { name: "Данные системы С1" })).toHaveAttribute("href", "#fact-1-F1");

    await userEvent.type(field, "А сколько из них утверждено?{Enter}");
    await waitFor(() => expect(asks(calls)).toHaveLength(2));
    expect((asks(calls)[1]?.body as { history: unknown[] }).history).toEqual([
      { question: "Сколько документов в базе?", answer: withFact.answer, context: [referent] },
    ]);
  });

  it("keeps the files attached in the panel when the document is left: the conversation continues (chat history)", async () => {
    const attachment = attachmentReady({ id: "ATT-00000000000000aa" });
    const calls = mockApi(
      routes([
        { method: "POST", path: "/api/assistant/attachments", status: 201, body: attachment },
        { method: "DELETE", path: `/api/assistant/attachments/${attachment.id}`, status: 204 },
      ]),
    );
    const { unmount } = renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    await userEvent.upload(within(panel()).getByLabelText("Файлы для этого диалога"), new File(["a;b\n"], "fields.csv", { type: "text/csv" }));
    expect(await within(panel()).findByRole("button", { name: "Убрать файл «fields.csv»" })).toBeInTheDocument();
    const upload = calls.find((call) => call.method === "POST" && call.url === "/api/assistant/attachments");
    expect((upload?.body as FormData).get("conversation_id")).toMatch(/^conv-/);
    unmount();
    // Deleted only with the conversation (from the history) or when its 24 hours run out.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("«Предложить правку» opens the manual path when the AI cannot rewrite (mock); an unavailable skill says why", async () => {
    const registry = skills.map((skill) =>
      skill.id === "check_freshness" ? { ...skill, available: false, unavailable_reason: "Нужна языковая модель." } : skill,
    );
    mockApi(routes([], registry));
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    const actions = within(panel()).getByRole("list", { name: "Быстрые действия" });
    const manual = await within(actions).findByRole("link", { name: "Предложить правку" });
    expect(manual).toHaveAttribute("href", `/proposals/new?document=${DOC_ID}`);
    expect(manual).toHaveAccessibleDescription(
      "Нет языковой модели (режим mock): переписать раздел нельзя. Откроется ручное предложение изменения.",
    );
    const freshness = within(actions).getByRole("button", { name: "Что перепроверить" });
    expect(freshness).toBeDisabled();
    expect(freshness).toHaveAccessibleDescription("Нужна языковая модель.");
  });

  it("holds the former «ИИ-помощник по документу»: «Ещё по документу» runs a skill, its proposal is accepted only on Accept", async () => {
    const answer: AskResponse = {
      ...supportedAnswer,
      answer: metadataProposal.summary,
      citations: [],
      skill: { id: "suggest_metadata", name: "Предложить метаданные", access: "draft" },
      proposal: { id: metadataProposal.id, kind: "suggest_metadata", status: "suggested", graph_link: null },
    };
    const draftId = "d".repeat(32);
    const calls = mockApi(
      routes([
        streamOf(answer),
        { path: `/api/ai/proposals/${metadataProposal.id}`, body: metadataProposal },
        {
          method: "POST",
          path: `/api/ai/proposals/${metadataProposal.id}/accept`,
          body: { ...metadataProposal, status: "applied", applied_items: ["tags"], result_draft_id: draftId },
        },
      ]),
    );
    renderDocument();
    await loaded();
    // The block under the text is gone: the actions live in the panel only.
    expect(screen.queryByRole("heading", { name: "ИИ-помощник по документу" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Действия ИИ" })).toBeNull();

    await userEvent.click(toggle());
    const more = within(panel()).getByRole("list", { name: "Ещё по документу" });
    expect(Array.from(more.querySelectorAll(".doc-assistant__action")).map((item) => item.textContent)).toEqual([
      "Кратко пересказать",
      "Проверить полноту",
      "Предложить метаданные",
    ]);
    await userEvent.click(within(more).getByRole("button", { name: "Предложить метаданные" }));
    await waitFor(() => expect(asks(calls)).toHaveLength(1));
    expect(asks(calls)[0]?.body).toMatchObject({ question: "", skill_id: "suggest_metadata", context_document_ids: [DOC_ID] });

    const card = await within(panel()).findByRole("region", { name: "Предложение ИИ: Метаданные" });
    expect(within(card).getByText(/Ничего не применено/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Открыть предложение" }));
    const accept = await within(card).findByRole("button", { name: /Применить выбранное \(0\)/ });
    expect(accept).toBeDisabled(); // nothing is chosen, nothing applies
    await userEvent.click(within(card).getByRole("checkbox", { name: "Принять: Поле «Теги»" }));
    expect(calls.some((call) => call.url.endsWith("/accept"))).toBe(false);
    await userEvent.click(within(card).getByRole("button", { name: /Применить выбранное \(1\)/ }));
    expect(calls.filter((call) => call.url.endsWith("/accept")).map((call) => call.body)).toEqual([{ item_ids: ["tags"] }]);
    expect(await within(card).findByRole("link", { name: "Открыть черновик" })).toHaveAttribute("href", `/proposals/${draftId}`);
  });

  it("lists the document's earlier AI proposals that wait for a decision, with Reject in place — and only those", async () => {
    const decided: AiProposal = { ...metadataProposal, id: "AIP-00000000000000m2", status: "rejected" };
    const calls = mockApi(
      routes([
        { path: PROPOSALS_OF_DOC, body: [metadataProposal, decided] },
        { path: `/api/ai/proposals/${metadataProposal.id}`, body: metadataProposal },
        { method: "POST", path: `/api/ai/proposals/${metadataProposal.id}/reject`, body: { ...metadataProposal, status: "rejected" } },
      ]),
    );
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    const pending = await within(panel()).findByRole("region", { name: "Ждут решения: 1" });
    // Folded: one line until the reader opens it.
    expect(within(pending).queryByRole("region", { name: "Предложение ИИ: Метаданные" })).toBeNull();
    const fold = within(pending).getByRole("button", { name: "Ждут решения: 1" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    const card = within(pending).getByRole("region", { name: "Предложение ИИ: Метаданные" });
    const open = within(card).getByRole("button", { name: "Открыть предложение" });
    expect(open).toHaveClass("button--secondary"); // not the panel's main action
    await userEvent.click(open);
    await userEvent.click(await within(card).findByRole("button", { name: "Отклонить" }));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.url)).toEqual([`/api/ai/proposals/${metadataProposal.id}/reject`]);
    expect(await within(card).findByText("Предложение отклонено — ничего не изменено.", { selector: ".ask-proposal__note" })).toBeInTheDocument();
  });

  it("does not repeat in «Ждут решения» a proposal that is already in this visit's conversation", async () => {
    const answer: AskResponse = {
      ...supportedAnswer,
      answer: metadataProposal.summary,
      citations: [],
      skill: { id: "suggest_metadata", name: "Предложить метаданные", access: "draft" },
      proposal: { id: metadataProposal.id, kind: "suggest_metadata", status: "suggested", graph_link: null },
    };
    mockApi(routes([streamOf(answer), { path: PROPOSALS_OF_DOC, body: [metadataProposal] }]));
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    expect(await within(panel()).findByRole("region", { name: "Ждут решения: 1" })).toBeInTheDocument();
    await userEvent.click(within(panel()).getByRole("button", { name: "Предложить метаданные" }));
    const conversation = within(panel()).getByRole("region", { name: "Переписка" });
    expect(await within(conversation).findByRole("region", { name: "Предложение ИИ: Метаданные" })).toBeInTheDocument();
    expect(within(panel()).queryByRole("region", { name: /Ждут решения/ })).toBeNull();
    expect(within(panel()).getAllByRole("region", { name: "Предложение ИИ: Метаданные" })).toHaveLength(1);
  });

  it("says so when the document's AI proposals cannot be read, and says nothing without the right to propose", async () => {
    mockApi(routes([{ path: PROPOSALS_OF_DOC, status: 500, body: { code: "internal_error", message: "x", request_id: "r" } }]));
    const first = renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    expect(await within(panel()).findByText("Не удалось загрузить предложения ИИ к документу.")).toBeInTheDocument();
    first.unmount();
    mockApi(routes([{ path: PROPOSALS_OF_DOC, status: 403, body: { code: "forbidden", message: "x", request_id: "r" } }]));
    renderDocument();
    await waitFor(() => expect(queryPanel()).not.toBeNull()); // remembered open
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(within(panel()).queryByText("Не удалось загрузить предложения ИИ к документу.")).toBeNull();
    expect(within(panel()).queryByRole("region", { name: /Ждут решения/ })).toBeNull();
  });

  it("does not exist with AI_PROVIDER=disabled: no toggle, no panel, no ⌘J, no selection bar", async () => {
    const calls = mockApi(routes());
    renderDocument("disabled");
    await loaded();
    expect(screen.queryByRole("button", { name: "Ассистент" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", metaKey: true });
    expect(queryPanel()).toBeNull();
    keyboardSelect("A document always has a stable ID");
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(bar()).toBeNull();
    // The manual path stays.
    expect(screen.getByRole("link", { name: "Предложить изменение" })).toHaveAttribute("href", `/proposals/new?document=${DOC_ID}`);
    expect(calls.some((call) => call.url === "/api/assistant/skills")).toBe(false);
  });
});

describe("Selection bar", () => {
  it("appears over a mouse selection in the text, not during the drag", async () => {
    mockApi(routes());
    renderDocument();
    await loaded();
    fireEvent.mouseDown(prose(), { button: 0 });
    select("stable ID");
    fireEvent(document, new Event("selectionchange"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(bar()).not.toBeVisible();
    fireEvent.mouseUp(document, { button: 0 });
    const toolbar = await screen.findByRole("toolbar", { name: "Действия с выделением" });
    await waitFor(() => expect(toolbar).toBeVisible());
    expect(within(toolbar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Объяснить", "Найти связанные"]);
    expect(within(toolbar).getByRole("link", { name: "Предложить правку" })).toHaveAttribute("href", `/proposals/new?document=${DOC_ID}`);
  });

  it("appears for a keyboard selection, and not for blanks or a selection outside the text", async () => {
    mockApi(routes());
    renderDocument();
    const title = await loaded();
    keyboardSelect("Search results");
    await waitFor(() => expect(bar()).toBeVisible());

    // The page title is not the document text.
    keyboardSelect("Semantic Layer", title);
    await waitFor(() => expect(bar()).not.toBeVisible());
    // Whitespace only.
    const space = document.createTextNode("   ");
    prose().querySelector("p")?.append(space);
    const range = document.createRange();
    range.selectNodeContents(space);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(bar()).not.toBeVisible();
  });

  it("is reached with Alt+F10, moves with the arrow keys, and Esc closes it and returns focus", async () => {
    mockApi(routes());
    renderDocument();
    await loaded();
    keyboardSelect("approval status");
    const toolbar = await screen.findByRole("toolbar", { name: "Действия с выделением" });
    await waitFor(() => expect(toolbar).toBeVisible());
    expect(toolbar).toHaveAttribute("aria-keyshortcuts", "Alt+F10");
    expect(screen.getByText("Действия с выделением: Alt+F10")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "F10", code: "F10", altKey: true });
    const [explain, related] = within(toolbar).getAllByRole("button");
    const manual = within(toolbar).getByRole("link", { name: "Предложить правку" });
    expect(explain).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(related).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(manual).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(explain).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(manual).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(explain).toHaveFocus();
    // One tab stop: the others are reached with the arrows.
    expect(related).toHaveAttribute("tabindex", "-1");

    await userEvent.keyboard("{Escape}");
    expect(toolbar).not.toBeVisible();
    expect(document.querySelector(".doc-text")).toHaveFocus();
    expect(window.getSelection()?.toString()).toBe("approval status");
    // The same selection does not bring it back.
    fireEvent(document, new Event("selectionchange"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(toolbar).not.toBeVisible();
  });

  it("«Объяснить» opens the panel with the selection chip and sends the exact text and the nearest heading", async () => {
    const calls = mockApi(routes([streamOf(supportedAnswer)]));
    renderDocument();
    await loaded();
    mouseSelect("A document always has a stable ID and an approval status.");
    const toolbar = await screen.findByRole("toolbar", { name: "Действия с выделением" });
    await waitFor(() => expect(toolbar).toBeVisible());
    await userEvent.click(within(toolbar).getByRole("button", { name: "Объяснить" }));

    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    const context = within(panel()).getByRole("region", { name: "Контекст" });
    expect(within(context).getByText("Выделение: 1 строка")).toBeInTheDocument();
    await waitFor(() => expect(asks(calls)).toHaveLength(1));
    expect(asks(calls)[0]?.body).toMatchObject({
      question: "",
      skill_id: "explain",
      context_document_ids: [DOC_ID],
      selection: { document_id: DOC_ID, section_anchor: "principles", text: "A document always has a stable ID and an approval status." },
    });
    const conversation = within(panel()).getByRole("region", { name: "Переписка" });
    expect(within(conversation).getByRole("list", { name: "Приложено к сообщению" })).toHaveTextContent("Выделение: 1 строка");
    expect(await within(conversation).findByRole("region", { name: "Ассистент" })).toBeInTheDocument();

    // The chip is removable: the next message goes without the selection.
    await userEvent.click(within(context).getByRole("button", { name: "Убрать выделение из контекста" }));
    expect(within(context).queryByText(/Выделение/)).toBeNull();
  });

  it("counts lines across list items and takes the intro's anchor from the hidden title heading", async () => {
    const calls = mockApi(routes([streamOf(supportedAnswer)]));
    renderDocument();
    await loaded();
    const items = prose().querySelectorAll("li");
    const range = document.createRange();
    range.setStart(items[0]?.firstChild as Text, 2);
    range.setEnd(items[1]?.firstChild as Text, 6);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const selected = window.getSelection()?.toString();
    expect(selected).toBe("document always has a stable ID and an approval status.\nSearch");
    fireEvent(document, new Event("selectionchange"));
    const toolbar = await screen.findByRole("toolbar", { name: "Действия с выделением" });
    await waitFor(() => expect(toolbar).toBeVisible());
    await userEvent.click(within(toolbar).getByRole("button", { name: "Найти связанные" }));
    expect(within(panel()).getByRole("region", { name: "Контекст" })).toHaveTextContent("Выделение: 2 строки");
    await waitFor(() => expect(asks(calls)).toHaveLength(1));
    const sent = asks(calls)[0]?.body as { skill_id: string; selection: { text: string; section_anchor: string } };
    expect(sent.skill_id).toBe("find_related");
    expect(sent.selection).toEqual({ document_id: DOC_ID, section_anchor: "principles", text: selected });
    await within(panel()).findByRole("region", { name: "Ассистент" });

    keyboardSelect("four layers");
    await waitFor(() => expect(bar()).toBeVisible());
    await userEvent.click(within(bar() as HTMLElement).getByRole("button", { name: "Объяснить" }));
    await waitFor(() => expect(asks(calls)).toHaveLength(2));
    expect((asks(calls)[1]?.body as { selection: { section_anchor: string } }).selection.section_anchor).toBe(
      "semantic-layer-demonstration-architecture",
    );
  });

  it("says so honestly when the server does not find the selected text (selection_not_found)", async () => {
    mockApi(
      routes([
        {
          method: "POST",
          path: STREAM,
          status: 422,
          body: { code: "selection_not_found", message: "Выделенный текст не найден в документе (возможно, документ изменился).", request_id: "r1" },
        },
      ]),
    );
    renderDocument();
    await loaded();
    keyboardSelect("stable ID");
    await waitFor(() => expect(bar()).toBeVisible());
    await userEvent.click(within(bar() as HTMLElement).getByRole("button", { name: "Объяснить" }));
    const conversation = within(panel()).getByRole("region", { name: "Переписка" });
    expect(await within(conversation).findByText("Выделенный текст не найден в документе")).toBeInTheDocument();
    expect(within(conversation).getByText("Выделенный текст не найден в документе (возможно, документ изменился).")).toBeInTheDocument();
    expect(within(conversation).getByText(/Сервер сверяет выделение с текстом документа дословно/)).toBeInTheDocument();
    // Repeating the same request would fail the same way: no retry.
    expect(within(conversation).queryByRole("button", { name: "Повторить запрос" })).toBeNull();
    expect(within(conversation).queryByRole("region", { name: "Ассистент" })).toBeNull();
  });

  it("opening the panel with ⌘J takes a selection in the text as context", async () => {
    mockApi(routes());
    renderDocument();
    await loaded();
    select("Search results reference their source document.");
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", metaKey: true });
    const context = within(panel()).getByRole("region", { name: "Контекст" });
    expect(within(context).getByText("Выделение: 1 строка")).toBeInTheDocument();
  });
});

describe("Document assistant panel: chat history", () => {
  const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);
  const final = (response: AskResponse): AskStreamEvent => ({ type: "final", response });

  it("leaving the document mid-answer does not cancel it: coming back shows the answer in the panel, asked once", async () => {
    const stream = ndjsonStream();
    const calls = mockApi(routes([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]));
    const first = renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    await userEvent.type(within(panel()).getByLabelText("Вопрос по документу"), "Какие слои у архитектуры?{Enter}");
    expect(await within(panel()).findByText("Ищу источники…")).toBeInTheDocument();
    first.unmount();
    expect(stream.state.aborted).toBe(false);
    await act(async () => {
      stream.push({ type: "status", stage: "retrieving" }, final(supportedAnswer));
      stream.close();
    });

    renderDocument();
    await loaded();
    if (!queryPanel()) await userEvent.click(toggle());
    expect(await within(panel()).findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.body).toMatchObject({ origin: "document", context_document_ids: [DOC_ID] });
  });

  it("after a reload continues the document's latest stored conversation without asking; follow-ups join it", async () => {
    const turn = storedTurn({ request: { ...storedTurn().request, documents: [{ id: DOC_ID, title: archDetail.title }] } });
    const stored = storedConversation([turn], { origin: "document", document: { id: DOC_ID, title: archDetail.title } });
    const summary: Partial<typeof stored> = { ...stored };
    delete summary.turns;
    delete summary.index_generation;
    const calls = mockApi(
      routes([
        {
          path: `/api/assistant/conversations?origin=document&document_id=${DOC_ID}&limit=1`,
          body: { items: [summary], total: 1, enabled: true, retention_days: 30 },
        },
        { path: `/api/assistant/conversations/${stored.id}`, body: stored },
        streamOf(supportedAnswer),
      ]),
    );
    renderDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Ассистент" }));
    expect(await within(panel()).findByText("Подтверждено источниками")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    // The document is the panel's context, shown once above — not repeated on the stored message.
    expect(within(panel()).queryByRole("list", { name: "Приложено к сообщению" })).toBeNull();

    await userEvent.type(within(panel()).getByLabelText("Вопрос по документу"), "А какие ограничения?{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({
      conversation_id: stored.id,
      origin: "document",
      history: [{ question: "Какие слои у архитектуры?", answer: supportedAnswer.answer }],
    });
    expect(await within(panel()).findAllByText("Подтверждено источниками")).toHaveLength(2);

    // «Новый разговор»: the next message starts another conversation about this document.
    await userEvent.click(within(panel()).getByRole("button", { name: "Новый разговор" }));
    expect(within(panel()).queryByText("Подтверждено источниками")).toBeNull();
  });
});

