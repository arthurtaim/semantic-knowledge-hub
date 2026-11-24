import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AiMode, AssistantAttachment, SearchResponse, SessionResponse } from "../api/types";
import { Composer, type ComposerVariant } from "../components/Composer";
import { missingInput } from "../lib/assistant";
import { useComposer, type ComposerMessage } from "../lib/useComposer";
import type { SkillsState } from "../lib/useSkills";
import { attachmentReady, session, skills } from "./fixtures";
import { mockApi, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

/*
 * The assistant field (docs/ui-v2/specs/02_ASSISTANT.md §3, design-07): chips, Enter / Shift+Enter, «/» skills,
 * «@» documents, files (button, drop, paste) with their states, send rules and the four AI modes.
 */

const withMode = (ai_mode: AiMode): SessionResponse => ({ ...session, features: { ...session.features, ai_mode } });
const registry: SkillsState = { items: skills, failed: false };
const byId = (id: string) => skills.find((s) => s.id === id);

function Harness({ onSend, variant = "home", skillsState = registry }: { onSend: (m: ComposerMessage) => void; variant?: ComposerVariant; skillsState?: SkillsState }) {
  const composer = useComposer();
  return <Composer variant={variant} composer={composer} onSend={onSend} skills={skillsState} inputId="composer-field" />;
}

function setup(options: { mode?: AiMode; variant?: ComposerVariant; routes?: MockRoute[] } = {}) {
  const calls = mockApi(options.routes ?? []);
  const onSend = vi.fn<(m: ComposerMessage) => void>();
  renderRoutes(
    "/",
    { "/": <Harness onSend={onSend} variant={options.variant} />, "/documents": <p>Каталог</p>, "/documents/:id": <p>Документ</p> },
    withMode(options.mode ?? "mock"),
  );
  const field = screen.getByLabelText(options.mode === "disabled" ? "Поиск по базе знаний" : "Вопрос") as HTMLTextAreaElement;
  return { calls, onSend, field };
}

const searchResult = (id: string, title: string, section: string | null, status: "approved" | "in_review") => ({
  id,
  title,
  type: "integration" as const,
  status,
  owner: "demo-integration-team",
  source: "local" as const,
  source_uri: `local://${id}`,
  revision: "sha256:490657a706958d6b",
  tags: [],
  excerpt: "…",
  excerpt_segments: [],
  section,
  section_anchor: null,
  score: 10,
  is_demo: true,
});

const searchBody: SearchResponse = {
  query: "маппинг",
  items: [
    searchResult("DEMO-INT-002", "ARIS → Catalog: маппинг полей (демо)", "Входные данные (Inputs)", "approved"),
    searchResult("DEMO-INT-002", "ARIS → Catalog: маппинг полей (демо)", "Ограничения", "approved"),
    searchResult("DEMO-INT-011", "Маппинг сущностей CATIA (демо)", null, "in_review"),
  ],
  total: 3,
  scopes: [],
  warnings: [],
};

/** An upload that answers only when `resolve` is called (to see «Читаю…»). */
function deferredUpload() {
  let resolve: (body: AssistantAttachment) => void = () => undefined;
  const route: MockRoute = {
    method: "POST",
    path: "/api/assistant/attachments",
    respond: () =>
      new Promise<Response>((done) => {
        resolve = (body) => done(new Response(JSON.stringify(body), { status: body.status === "ready" ? 201 : 200 }));
      }),
  };
  return { route, resolve: (body: AssistantAttachment) => act(async () => resolve(body)) };
}

const csv = (name = "aris_export_2026-11.csv", content = "aris_object_guid;aris_status\n") => new File([content], name, { type: "text/csv" });
const uploads = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === "/api/assistant/attachments");

describe("Composer: text, Enter and chips", () => {
  it("sends on Enter, adds a line on Shift+Enter, and carries the scope and options", async () => {
    const { field, onSend } = setup();
    expect(field).toHaveAttribute("placeholder", "Спросите, опишите задачу или перетащите файл");
    const send = screen.getByRole("button", { name: "Отправить" });
    expect(send).toBeDisabled(); // empty and no skill
    await userEvent.type(field, "Что отправляет ARIS{Shift>}{Enter}{/Shift}в каталог?");
    expect(field).toHaveValue("Что отправляет ARIS\nв каталог?");
    expect(onSend).not.toHaveBeenCalled();
    expect(send).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({
      question: "Что отправляет ARIS\nв каталог?",
      skill: null,
      attachments: [],
      documents: [],
      scope: "team",
      includeDrafts: false,
      includeDeprecated: false,
    });
    expect(onSend.mock.calls[0]?.[0].conversationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
  });

  it("rejects a question shorter than 3 characters without sending", async () => {
    const { field, onSend } = setup();
    await userEvent.type(field, "аб{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("не менее 3 символов");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the AI mode on the right and «Где искать» switches the scope (with a note when Confluence is off)", async () => {
    const { field, onSend } = setup();
    expect(screen.getByText("ИИ: без модели")).toBeInTheDocument();
    const scope = screen.getByRole("button", { name: "Где искать: Команда" });
    await userEvent.click(scope);
    expect(scope).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Оба" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Черновики и документы на ревью" }));
    expect(screen.getByRole("button", { name: "Где искать: Оба, с черновиками" })).toBeInTheDocument();
    expect(screen.getByText(/Корпоративные источники \(Confluence Data Center\) не подключены — ответ будет/)).toBeInTheDocument();
    await userEvent.type(field, "Где SLA?{Enter}");
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ scope: "both", includeDrafts: true });
  });
});

describe("Composer: skills («Навык» and «/»)", () => {
  it("lists skills after «/» at the start of a line with access and reasons; typing filters; Enter chooses", async () => {
    const { field } = setup();
    await userEvent.type(field, "/");
    const list = screen.getByRole("listbox", { name: "Навыки" });
    expect(field).toHaveAttribute("aria-controls", list.id);
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(skills.length);
    expect(options[0]).toHaveAttribute("aria-selected", "true"); // Enter takes the first available
    expect(field).toHaveAttribute("aria-activedescendant", options[0]?.id);
    const draft = within(list).getByRole("option", { name: /Черновик документа/ });
    expect(draft).toHaveTextContent("создаёт черновик");
    expect(within(list).getByRole("option", { name: /Найти связи/ })).toHaveTextContent("чтение");
    const unavailable = within(list).getByRole("option", { name: /Улучшить раздел/ });
    expect(unavailable).toHaveAttribute("aria-disabled", "true");
    expect(unavailable).toHaveTextContent("Нет языковой модели (режим mock): переписать раздел нельзя.");

    await userEvent.type(field, "черн");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Черновик документа")]);
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("listbox", { name: "Навыки" })).toBeNull();
    expect(field).toHaveValue(""); // «/черн» is replaced by the chip
    const chips = screen.getByRole("list", { name: "Приложено к сообщению" });
    expect(within(chips).getByText("Черновик документа")).toBeInTheDocument();
    expect(screen.getByText("создаёт черновик", { selector: ".composer__mode" })).toBeInTheDocument();
  });

  it("does not choose an unavailable skill; Esc closes the list and keeps the text; «/» mid-line is just a slash", async () => {
    const { field } = setup();
    await userEvent.type(field, "/улучш");
    const list = screen.getByRole("listbox", { name: "Навыки" });
    expect(within(list).getByRole("option")).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(list).getByRole("option"));
    expect(screen.queryByRole("list", { name: "Приложено к сообщению" })).toBeNull();
    expect(screen.getByText(/Навык «Улучшить раздел» недоступен/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Навыки" })).toBeNull();
    expect(field).toHaveValue("/улучш");
    await userEvent.clear(field);
    await userEvent.type(field, "a/b");
    expect(screen.queryByRole("listbox", { name: "Навыки" })).toBeNull();
  });

  it("opens the list from «Навык», moves with the arrows and puts one skill chip (a second replaces it)", async () => {
    const { field } = setup();
    const button = screen.getByRole("button", { name: "Навык" });
    expect(button).toHaveAttribute("aria-haspopup", "listbox");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(field).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("button", { name: "Убрать навык «Объяснить»" })).toBeInTheDocument();
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("option", { name: /Найти связи/ }));
    expect(screen.queryByRole("button", { name: "Убрать навык «Объяснить»" })).toBeNull();
    expect(screen.getByRole("button", { name: "Убрать навык «Найти связи»" })).toBeInTheDocument();
  });

  it("runs a skill whose question is optional with an empty field; a skill that needs a document says so", async () => {
    const { field, onSend } = setup();
    await userEvent.type(field, "/перепров{Enter}");
    // «Что перепроверить» needs a document: no send until one is chosen.
    expect(screen.getByText(/Навыку «Что перепроверить» нужен документ/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Убрать навык «Что перепроверить»" }));
    // «Найти связи» needs a document OR a question (requires.document_or_question): an empty field no longer
    // sends a request the server would refuse with skill_input_missing.
    await userEvent.type(field, "/связи{Enter}");
    // The placeholder no longer offers an empty field to a skill that needs a document or a question.
    expect(field).toHaveAttribute("placeholder", "Напишите вопрос или выберите документ");
    const hint = "Навыку «Найти связи» нужен документ или вопрос: кнопка «Документ», @ в тексте или напишите вопрос.";
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(field, "ар");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled(); // under 3 characters is no question
    await userEvent.type(field, "хив");
    expect(screen.queryByText(hint)).toBeNull();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ question: "архив", skill: byId("find_related") });
  });

  it("«документ или вопрос»: a chosen document is enough, the field may stay empty", () => {
    const related = { ...byId("find_related")!, requires: { ...byId("find_related")!.requires } };
    const context = { documents: 0, selection: false, attachments: 0 };
    expect(missingInput(related, { ...context, question: "" })).toBe("document_or_question");
    expect(missingInput(related, { ...context, documents: 1, question: "" })).toBeNull();
    expect(missingInput(related, { ...context, selection: true })).toBeNull();
    expect(missingInput(related, { ...context, question: "  ab  " })).toBe("document_or_question");
    expect(missingInput(related, { ...context, question: "abc" })).toBeNull();
    // A registry without the new key (an older server) keeps the old behaviour.
    const older = { ...related, requires: { document: false, selection: false, attachment: false } };
    expect(missingInput(older, { ...context, question: "" })).toBeNull();
  });

  it("keeps the send button off for a skill that needs a question until one is typed", async () => {
    const { field } = setup();
    await userEvent.type(field, "/ответ{Enter}");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    await userEvent.type(field, "Где хранится база?");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled();
  });

  it("removes the last chip with Backspace in an empty field, then the one before", async () => {
    const { field } = setup({ routes: [{ path: /^\/api\/search\?/, body: searchBody }] });
    await userEvent.type(field, "/связи{Enter}@мапп");
    await screen.findByRole("option", { name: /CATIA/ });
    await userEvent.keyboard("{Enter}");
    const chips = screen.getByRole("list", { name: "Приложено к сообщению" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(2);
    expect(field).toHaveValue("");
    await userEvent.keyboard("{Backspace}");
    expect(within(chips).getAllByRole("listitem")).toHaveLength(1);
    expect(within(chips).getByText("Найти связи")).toBeInTheDocument();
    await userEvent.keyboard("{Backspace}");
    expect(screen.queryByRole("list", { name: "Приложено к сообщению" })).toBeNull();
  });
});

describe("Composer: documents («Документ» and «@»)", () => {
  it("searches the knowledge base after «@» and turns the chosen document into a context chip", async () => {
    const { field, calls, onSend } = setup({ routes: [{ path: /^\/api\/search\?/, body: searchBody }] });
    await userEvent.type(field, "Сравни с @маппинг");
    const list = await screen.findByRole("listbox", { name: "Документы" });
    const rows = await within(list).findAllByRole("option");
    expect(rows).toHaveLength(2); // one row per document
    expect(rows[0]).toHaveTextContent("ARIS → Catalog: маппинг полей (демо)");
    expect(rows[0]).toHaveTextContent("DEMO-INT-002, раздел «Входные данные (Inputs)»");
    expect(rows[0]).toHaveTextContent("Утверждён");
    expect(rows[1]).toHaveTextContent("На ревью");
    expect(calls.map((c) => c.url)).toContain(`/api/search?q=${encodeURIComponent("маппинг")}&limit=8`);
    await userEvent.keyboard("{Enter}");
    expect(field).toHaveValue("Сравни с ");
    expect(screen.getByRole("button", { name: "Убрать документ «ARIS → Catalog: маппинг полей (демо)»" })).toBeInTheDocument();
    await userEvent.type(field, "этим{Enter}");
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({
      question: "Сравни с этим",
      documents: [{ id: "DEMO-INT-002", title: "ARIS → Catalog: маппинг полей (демо)", status: "approved" }],
    });
  });

  it("«Документ» types «@» at the caret and asks for a name; an e-mail-like «a@b» does not open the list", async () => {
    const { field } = setup({ routes: [{ path: /^\/api\/search\?/, body: searchBody }] });
    await userEvent.type(field, "Сравни");
    await userEvent.click(screen.getByRole("button", { name: "Документ" }));
    expect(field).toHaveValue("Сравни @");
    expect(field).toHaveFocus();
    expect(screen.getByText("Введите название или ID документа.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.clear(field);
    await userEvent.type(field, "user@example");
    expect(screen.queryByRole("listbox", { name: "Документы" })).toBeNull();
  });
});

describe("Composer: files", () => {
  it("uploads a chosen file to this dialog: «Читаю…», then the size and the server's summary; send waits", async () => {
    const upload = deferredUpload();
    const { field, calls, onSend } = setup({ routes: [upload.route] });
    await userEvent.type(field, "Сверь выгрузку");
    await userEvent.upload(screen.getByLabelText("Файлы для этого диалога"), csv());
    const chips = screen.getByRole("list", { name: "Приложено к сообщению" });
    expect(within(chips).getByText("Читаю…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
    const form = uploads(calls)[0]?.body as FormData;
    expect([...form.keys()]).toEqual(["conversation_id", "file"]);
    expect(form.get("conversation_id")).toMatch(/^conv-[0-9a-f]{24}$/);

    await upload.resolve(attachmentReady({ summary: "3 листа" }));
    expect(await within(chips).findByText("48 КБ · 3 листа")).toBeInTheDocument();
    expect(screen.getByText("Файл «aris_export_2026-11.csv» прочитан: 3 листа.")).toBeInTheDocument(); // live region
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(onSend.mock.calls[0]?.[0].attachments.map((a) => a.id)).toEqual(["ATT-0123456789abcdef"]);
    expect(onSend.mock.calls[0]?.[0].conversationId).toBe(form.get("conversation_id"));
  });

  it("shows what the server refused and what the field refuses itself (format, size, count)", async () => {
    const { calls } = setup({
      routes: [
        {
          method: "POST",
          path: "/api/assistant/attachments",
          body: attachmentReady({ status: "error", error_code: "unreadable", summary: null, expires_at: null }),
        },
      ],
    });
    const huge = csv("big.csv");
    Object.defineProperty(huge, "size", { value: 21 * 1024 * 1024 });
    // Dropped files are not filtered by the picker's `accept`: the field checks them itself.
    const form = screen.getByLabelText("Вопрос").closest("form") as HTMLFormElement;
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [new File(["x"], "scheme.vsdx"), huge, csv("broken.csv")], items: [] } });
    const chips = screen.getByRole("list", { name: "Приложено к сообщению" });
    expect(within(chips).getByText("формат не поддерживается")).toBeInTheDocument();
    expect(within(chips).getByText("больше 20 МБ")).toBeInTheDocument();
    expect(await within(chips).findByText("не удалось прочитать")).toBeInTheDocument();
    expect(uploads(calls)).toHaveLength(1); // only broken.csv went to the server
    // An error chip can be removed without a server call.
    await userEvent.click(screen.getByRole("button", { name: "Убрать файл «scheme.vsdx»" }));
    expect(within(chips).queryByText("формат не поддерживается")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses an 11th file in the dialog before uploading it", async () => {
    let n = 0;
    const { calls } = setup({
      routes: [{ method: "POST", path: "/api/assistant/attachments", body: () => attachmentReady({ id: `ATT-${String(++n).padStart(16, "0")}` }) }],
    });
    const files = Array.from({ length: 11 }, (_, i) => csv(`f${i}.csv`));
    await userEvent.upload(screen.getByLabelText("Файлы для этого диалога"), files);
    expect(await screen.findByText("не больше 10 файлов в диалоге")).toBeInTheDocument();
    await waitFor(() => expect(uploads(calls)).toHaveLength(10));
  });

  it("deletes a ready file on the server when its chip is removed", async () => {
    const { calls } = setup({
      routes: [
        { method: "POST", path: "/api/assistant/attachments", status: 201, body: attachmentReady() },
        { method: "DELETE", path: "/api/assistant/attachments/ATT-0123456789abcdef", status: 204 },
      ],
    });
    await userEvent.upload(screen.getByLabelText("Файлы для этого диалога"), csv());
    await screen.findByText("48 КБ · 1 240 строк");
    await userEvent.click(screen.getByRole("button", { name: "Убрать файл «aris_export_2026-11.csv»" }));
    expect(screen.queryByText("aris_export_2026-11.csv")).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/assistant/attachments/ATT-0123456789abcdef"]);
  });

  it("lights up the whole field while files are dragged over it, with their number and size, and attaches them on drop", async () => {
    const { calls } = setup({ routes: [{ method: "POST", path: "/api/assistant/attachments", status: 201, body: attachmentReady() }] });
    const form = screen.getByLabelText("Вопрос").closest("form") as HTMLFormElement;
    const a = csv("a.csv");
    const b = csv("b.csv");
    Object.defineProperty(a, "size", { value: 700 * 1024 });
    Object.defineProperty(b, "size", { value: 734 * 1024 });
    const dataTransfer = { types: ["Files"], files: [a, b], items: [], dropEffect: "none" };
    fireEvent.dragEnter(form, { dataTransfer });
    expect(screen.getByText("Отпустите, чтобы прикрепить")).toBeInTheDocument();
    expect(screen.getByText("2 файла, 1,4 МБ")).toBeInTheDocument();
    fireEvent.dragLeave(form, { dataTransfer });
    expect(screen.queryByText("Отпустите, чтобы прикрепить")).toBeNull();
    fireEvent.dragEnter(form, { dataTransfer });
    fireEvent.drop(form, { dataTransfer });
    expect(screen.queryByText("Отпустите, чтобы прикрепить")).toBeNull();
    await waitFor(() => expect(uploads(calls)).toHaveLength(2));
  });

  it("attaches a file pasted from the clipboard", async () => {
    const { field, calls } = setup({ routes: [{ method: "POST", path: "/api/assistant/attachments", status: 201, body: attachmentReady() }] });
    fireEvent.paste(field, { clipboardData: { files: [csv()], types: ["Files"] } });
    expect(await screen.findByText("48 КБ · 1 240 строк")).toBeInTheDocument();
    expect(uploads(calls)).toHaveLength(1);
  });
});

describe("Composer: AI modes and variants", () => {
  it("disabled: a search field — no «Файл» or «Навык» at all; Enter opens the catalogue search", async () => {
    const { field } = setup({ mode: "disabled", routes: [{ path: /^\/api\/search\?/, body: searchBody }] });
    expect(field).toHaveAttribute("placeholder", "Найти в базе знаний");
    expect(screen.queryByRole("button", { name: "Файл" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Навык" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Документ" })).toBeNull();
    expect(screen.queryByLabelText("Файлы для этого диалога")).toBeNull();
    expect(screen.getByText("Документы команды")).toBeInTheDocument();
    expect(screen.getByRole("search")).toBeInTheDocument();
    await userEvent.type(field, "/ARIS");
    expect(screen.queryByRole("listbox", { name: "Навыки" })).toBeNull(); // «/» is text here
    await userEvent.clear(field);
    await userEvent.type(field, "маппинг");
    const matches = await screen.findByRole("listbox", { name: "Подсказки" });
    expect(await within(matches).findAllByRole("option")).toHaveLength(2);
    expect(within(matches).queryByRole("option", { selected: true })).toBeNull(); // nothing preselected
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(`/documents?query=${encodeURIComponent("маппинг")}`);
  });

  it("disabled: ↓ + Enter opens an instant match", async () => {
    const { field } = setup({ mode: "disabled", routes: [{ path: /^\/api\/search\?/, body: searchBody }] });
    await userEvent.type(field, "маппинг");
    await screen.findAllByRole("option");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/documents/DEMO-INT-002");
  });

  it("compact: icon buttons with names, no document button and no scope switch", () => {
    setup({ variant: "compact" });
    expect(screen.getByRole("button", { name: "Прикрепить файл" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Навык" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Документ" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Где искать/ })).toBeNull();
  });

  it("says when the skill registry cannot be read instead of showing an empty list", async () => {
    mockApi([]);
    const onSend = vi.fn();
    renderRoutes("/", { "/": <Harness onSend={onSend} skillsState={{ items: null, failed: true }} /> });
    await userEvent.click(screen.getByRole("button", { name: "Навык" }));
    expect(screen.getByText("Список навыков сейчас недоступен.")).toBeInTheDocument();
  });
});
