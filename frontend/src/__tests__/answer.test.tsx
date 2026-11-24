import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProposal, AskResponse, AskStreamEvent, Citation } from "../api/types";
import { handOff } from "../lib/conversation";
import { EMPTY_DRAFT, type ComposerMessage } from "../lib/useComposer";
import { AskPage } from "../pages/AskPage";
import type { HomeHandOff } from "../pages/HomePage";
import { attachmentReady, skills, supportedAnswer } from "./fixtures";
import { mockApi, ndjsonStream, renderAt, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

/* The answer in the dialog (docs/ui-v2/specs/02_ASSISTANT.md §2, design-03). */

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
const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST" && c.url === STREAM);

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
const fileCitation: Citation = {
  ref: 3,
  source_type: "attachment",
  document_id: "ATT-0123456789abcdef",
  title: "aris_export_2026-11.csv",
  source_uri: "attachment://ATT-0123456789abcdef",
  revision: "",
  status: null,
  section: null,
  section_anchor: null,
  excerpt: "aris_object_guid;aris_status;aris_comment",
  retrieved_at: "2026-11-24T10:00:00Z",
  is_demo: false,
  app_path: null,
  attachment_id: "ATT-0123456789abcdef",
  attachment_name: "aris_export_2026-11.csv",
  locator: "строка 1",
};

const mixed: AskResponse = {
  ...supportedAnswer,
  mode: "internal_api",
  warnings: [],
  answer: "Четыре слоя [1]. Заморозка — в последнюю неделю квартала [2]. В файле есть колонка aris_comment [3].",
  citations: [teamCitation, corporateCitation, fileCitation],
};

/** The demo provider's text: a prefix, numbered verbatim quotes, the files header, server notes. */
const demoWithFile: AskResponse = {
  ...supportedAnswer,
  confidence: "partial",
  answer: [
    "Демо-режим: ответ сформирован без языковой модели — ниже приведены дословные выдержки из найденных документов.",
    "",
    `1. «${teamCitation.excerpt}» [1]`,
    "",
    "Вложения этого диалога (дословно, без выводов):",
    `2. «${fileCitation.excerpt}» [2]`,
    "",
    "В процитированных фрагментах не встречаются: «aris_comment».",
    "",
    "Исключены из доказательной базы по статусу: SEM-INT-ARIS-001 (draft), DEMO-INT-018 (deprecated).",
  ].join("\n"),
  citations: [teamCitation, { ...fileCitation, ref: 2 }],
  excluded_sources: [
    { document_id: "SEM-INT-ARIS-001", title: "ARIS integration — questions for discovery", status: "draft", reason: "Неутверждённый документ исключён." },
    { document_id: "DEMO-INT-018", title: "Ночная полная выгрузка ARIS", status: "deprecated", reason: "Устаревший документ исключён из доказательной базы." },
  ],
  skill: { id: "compare_with_file", name: "Сравнить с файлом", access: "read" },
};

async function ask(question = "Какие слои у архитектуры?") {
  await userEvent.type(screen.getByLabelText("Вопрос"), question);
  await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
  return screen.findByRole("heading", { name: "Ассистент" });
}

/** Elements with this text that a reader sees (the citation cards are hidden until hover or focus). */
const visible = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => el.closest("[hidden]") === null);

afterEach(() => vi.unstubAllGlobals());

describe("Answer: support, text and markers", () => {
  it("names the support level as a category, labels the demo and never repeats a quote in the text", async () => {
    mockApi([streamRoute(...final(demoWithFile))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    expect(screen.getByText("Частично подтверждено")).toHaveClass("confidence--partial");
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText("Демо-режим: выдержки без языковой модели")).toBeInTheDocument();
    expect(screen.queryByText("ИИ", { selector: ".ai-label" })).toBeNull(); // not generated text
    // Each quote is shown once — under «Источники»; the text only points to it.
    expect(visible(teamCitation.excerpt)).toHaveLength(1);
    expect(visible(fileCitation.excerpt)).toHaveLength(1);
    expect(screen.getByText(/Без языковой модели ассистент не делает выводов/)).toBeInTheDocument();
    const text = document.querySelector(".answer__text") as HTMLElement;
    expect(within(text).getByRole("link", { name: "Источник 1" })).toBeInTheDocument();
    expect(within(text).getByRole("link", { name: "Источник Ф1" })).toHaveTextContent("Ф1");
    // Server notes go where they belong: not-found words in amber, excluded documents under «Источники».
    expect(screen.getByText("Нет подтверждения в источниках:").parentElement).toHaveTextContent("«aris_comment»");
    expect(text).not.toHaveTextContent("Исключены из доказательной базы");
  });

  it("labels generated text «ИИ» and numbers markers per group: 1 team, К1 corporate, Ф1 attachment", async () => {
    mockApi([streamRoute(...final(mixed))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    expect(screen.getByText("ИИ", { selector: ".ai-label" })).toBeInTheDocument();
    expect(screen.getByText("Внутренняя модель, цитаты сверены с источниками")).toBeInTheDocument();
    const text = document.querySelector(".answer__text") as HTMLElement;
    expect(within(text).getAllByRole("link").map((l) => l.textContent)).toEqual(["1", "К1", "Ф1"]);
    expect(within(text).getByRole("link", { name: "Источник К1" })).toHaveClass("cite-ref--corporate");
    expect(within(text).getByRole("link", { name: "Источник Ф1" })).toHaveClass("cite-ref--attachment");
  });

  it("shows the card on hover and focus: number, document, status, the quote with the question's words, section, scope, revision", async () => {
    mockApi([streamRoute(...final(mixed))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Какие слои у demonstration архитектуры?");
    const marker = screen.getByRole("link", { name: "Источник 1" });
    expect(marker).toHaveAttribute("href", teamCitation.app_path); // the cited section
    const card = document.getElementById(marker.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(card).toHaveAttribute("role", "tooltip");
    expect(card).not.toBeVisible();
    await userEvent.hover(marker);
    expect(card).toBeVisible();
    expect(within(card).getByText("1", { selector: ".cite-pill" })).toBeInTheDocument();
    expect(within(card).getByText(teamCitation.title)).toBeInTheDocument();
    expect(within(card).getByText("Утверждён")).toBeInTheDocument();
    expect(within(card).getByText(`Раздел «${teamCitation.section}»`)).toBeInTheDocument();
    expect(within(card).getByText("Документы команды")).toBeInTheDocument();
    expect(within(card).getByText("ред. sha256:0b52b3c3")).toBeInTheDocument();
    expect(card).toHaveTextContent(teamCitation.excerpt);
    expect(within(card).getByText("demonstration", { selector: "mark" })).toBeInTheDocument();
    await userEvent.unhover(marker);
    expect(card).not.toBeVisible();

    const external = screen.getByRole("link", { name: "Источник К1" });
    act(() => external.focus());
    const externalCard = document.getElementById(external.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(externalCard).toBeVisible();
    expect(within(externalCard).getByText("Корпоративные · Confluence, версия 3")).toBeInTheDocument();
    expect(within(externalCard).getByText("статус не подтверждён")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(externalCard).not.toBeVisible();

    const file = screen.getByRole("link", { name: "Источник Ф1" });
    expect(file).toHaveAttribute("href", "#cite-1-3"); // a file has no page: its row under «Источники»
    act(() => file.focus());
    const fileCard = document.getElementById(file.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(within(fileCard).getByText("aris_export_2026-11.csv, строка 1")).toBeInTheDocument();
    expect(within(fileCard).getByText("Вложение этого диалога")).toBeInTheDocument();
  });
});

describe("Answer: sources", () => {
  it("keeps team documents, corporate pages and attachments in separate groups, with the attachment note", async () => {
    mockApi([streamRoute(...final(mixed))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const sources = screen.getByRole("region", { name: "Источники" });
    const team = within(sources).getByRole("region", { name: "Документы команды" });
    const corporate = within(sources).getByRole("region", { name: "Корпоративные" });
    const files = within(sources).getByRole("region", { name: "Вложения этого диалога" });
    expect(within(team).getAllByRole("listitem")).toHaveLength(1);
    expect(within(team).getByRole("link", { name: teamCitation.title })).toHaveAttribute("href", teamCitation.app_path);
    expect(within(team).getByText("Утверждён")).toBeInTheDocument();
    expect(within(team).getByText(teamCitation.excerpt)).toBeInTheDocument();
    expect(within(team).queryByText(corporateCitation.title)).toBeNull();
    expect(within(corporate).getAllByRole("listitem")).toHaveLength(1);
    expect(within(corporate).getByText(/не утверждённые документы команды/)).toBeInTheDocument();
    expect(within(files).getByText("aris_export_2026-11.csv, строка 1")).toBeInTheDocument();
    expect(within(files).getByText("Вложение")).toBeInTheDocument();
    expect(within(files).getByText("Файл виден только в этом диалоге и не попадает в базу знаний.")).toBeInTheDocument();
    expect(within(files).queryByText(teamCitation.title)).toBeNull();
  });

  it("folds documents that may not answer into one line and shows them on request", async () => {
    mockApi([streamRoute(...final(demoWithFile))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const sources = screen.getByRole("region", { name: "Источники" });
    expect(within(sources).getByText("2 документа не использованы: черновики и устаревшие.")).toBeInTheDocument();
    const show = within(sources).getByRole("button", { name: "Показать" });
    const list = document.getElementById(show.getAttribute("aria-controls") ?? "") as HTMLElement;
    expect(list).toHaveAttribute("aria-label", "Не использованы как доказательство");
    expect(list).not.toBeVisible();
    expect(show).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(show);
    expect(list).toBeVisible();
    expect(within(list).getByRole("link", { name: "Ночная полная выгрузка ARIS" })).toHaveAttribute("href", "/documents/DEMO-INT-018");
    expect(within(sources).getByRole("button", { name: "Скрыть" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("Answer: what to do next", () => {
  it("makes the change proposal the main action when the answer is only partly supported; copies with sources", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockApi([streamRoute(...final(demoWithFile))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask();
    const next = screen.getByRole("group", { name: "Что дальше" });
    const propose = within(next).getByRole("link", { name: "Предложить правку" });
    expect(propose).toHaveClass("button--primary");
    expect(propose).toHaveAttribute("href", "/proposals/new?document=SEM-ARCH-001");
    expect(propose).toHaveAccessibleDescription(/черновик, diff и ревью/);
    expect(within(next).getByRole("link", { name: "Открыть документ" })).toHaveClass("button--secondary");
    expect(next.querySelectorAll(".button--primary")).toHaveLength(1);
    await userEvent.click(within(next).getByRole("button", { name: "Копировать с источниками" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain("Источники:");
    expect(copied).toContain(`[1] ${teamCitation.title}`);
    expect(copied).toContain("[Ф1] aris_export_2026-11.csv, строка 1 — вложение этого диалога");
    expect(await within(next).findByText("Ответ скопирован вместе с источниками.")).toBeInTheDocument();
  });

  it("opens the cited document as the main action of a supported answer; «Уточнить вопрос» refills the field", async () => {
    mockApi([streamRoute(...final(supportedAnswer))]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Какие слои у архитектуры?");
    const next = screen.getByRole("group", { name: "Что дальше" });
    expect(within(next).getByRole("link", { name: "Открыть документ" })).toHaveClass("button--primary");
    expect(within(next).getByRole("link", { name: "Предложить правку" })).toHaveClass("button--secondary");
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
});

describe("Answer: a skill's proposal", () => {
  const proposal: AiProposal = {
    id: "AIP-0123456789abcdef",
    kind: "draft_from_prompt",
    status: "suggested",
    created_at: "2026-11-24T10:00:00Z",
    decided_at: null,
    mode: "mock",
    base: { draft_id: null, edit_version: null, document_id: null, revision: null, template_id: "integration", template_version: 2, index_generation: "g1" },
    summary: "Шаблон: «Интеграция» v2.",
    items: [
      { id: "draft", kind: "draft", field: null, section: null, target_id: null, current: null, proposed: { title: "External Registry" }, reason: "Черновик по шаблону", evidence: [], applicable: true },
    ],
    warnings: [],
    insufficient: false,
    graph_link: null,
    applied_items: [],
    result_draft_id: null,
  };
  const withProposal: AskResponse = {
    ...supportedAnswer,
    answer: "Шаблон: «Интеграция» v2. Источников: 4, проверенных цитат: 1.",
    skill: { id: "draft_document", name: "Черновик документа", access: "draft" },
    proposal: { id: proposal.id, kind: "draft_from_prompt", status: "suggested", graph_link: null },
  };

  it("shows a proposal card; nothing is applied until the user accepts in the opened proposal", async () => {
    const calls = mockApi([
      streamRoute(...final(withProposal)),
      { path: `/api/ai/proposals/${proposal.id}`, body: proposal },
      {
        method: "POST",
        path: `/api/ai/proposals/${proposal.id}/accept`,
        body: { ...proposal, status: "applied", applied_items: ["draft"], result_draft_id: "d".repeat(32) },
      },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await ask("Черновик интеграции с внешним реестром");
    const card = screen.getByRole("region", { name: "Предложение ИИ: Черновик по запросу" });
    expect(within(card).getByText("Демо")).toBeInTheDocument();
    expect(within(card).getByText(/Ничего не применено/)).toBeInTheDocument();
    const open = within(card).getByRole("button", { name: "Открыть предложение" });
    expect(open).toHaveClass("button--primary"); // the answer's main action
    expect(screen.queryByRole("group", { name: "Что дальше" })?.querySelector(".button--primary")).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/api/ai/proposals"))).toBe(false);

    await userEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const accept = await within(card).findByRole("button", { name: /Создать черновик \(1\)/ });
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/accept"))).toHaveLength(0);
    await userEvent.click(accept);
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/accept")).map((c) => c.body)).toEqual([{ item_ids: ["draft"] }]);
    expect(await within(card).findByRole("link", { name: "Открыть черновик" })).toHaveAttribute("href", `/documents/new?draft=${"d".repeat(32)}`);
  });
});

describe("Dialog: messages with skills, files and documents", () => {
  it("runs a message handed over from the home page at once, shows what was attached and keeps the chips", async () => {
    const skill = skills.find((s) => s.id === "compare_with_file") ?? null;
    const file = attachmentReady();
    const message: ComposerMessage = {
      conversationId: "conv-0123456789abcdef01234567",
      question: "Совпадает ли выгрузка с маппингом?",
      skill,
      attachments: [file],
      documents: [{ id: "DEMO-INT-002", title: "ARIS → Catalog: маппинг полей (демо)", status: "approved" }],
      selection: null,
      scope: "team",
      includeDrafts: false,
      includeDeprecated: false,
    };
    handOff<HomeHandOff>({
      conversationId: message.conversationId,
      draft: {
        ...EMPTY_DRAFT,
        skill,
        files: [{ key: "file-1", name: file.name, size: file.size, status: "ready", attachment: file, error: null }],
        documents: message.documents,
      },
      message,
    });
    const calls = mockApi([streamRoute(...final(demoWithFile))]);
    renderAt("/ask", "/ask", <AskPage />);
    await screen.findByRole("heading", { name: "Ассистент" });
    expect(posts(calls)[0]?.body).toEqual({
      question: "Совпадает ли выгрузка с маппингом?",
      sources: ["team"],
      include_drafts: false,
      include_deprecated: false,
      history: [],
      conversation_id: "conv-0123456789abcdef01234567",
      skill_id: "compare_with_file",
      attachment_ids: ["ATT-0123456789abcdef"],
      context_document_ids: ["DEMO-INT-002"],
    });
    const dialog = screen.getByRole("region", { name: "Диалог" });
    const attached = within(dialog).getByRole("list", { name: "Приложено к сообщению" });
    expect(within(attached).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Сравнить с файлом",
      "aris_export_2026-11.csv",
      "ARIS → Catalog: маппинг полей (демо)",
    ]);
    // The skill and the file stay in the field as removable chips for the next message.
    expect(screen.getByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Убрать файл «aris_export_2026-11.csv»" })).toBeInTheDocument();
    expect(screen.getByLabelText("Вопрос")).toHaveValue("");
  });

  it("says what a skill is missing without offering a retry that would fail the same way", async () => {
    mockApi([
      {
        method: "POST",
        path: STREAM,
        status: 422,
        body: { code: "skill_input_missing", message: "Для навыка «Проверить актуальность» нужно: документ.", request_id: "r", details: { missing: ["document"] } },
      },
    ]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Проверь актуальность");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Навыку не хватает данных");
    expect(alert).toHaveTextContent("нужно: документ");
    expect(within(alert).queryByRole("button", { name: "Повторить запрос" })).toBeNull();
  });

  it("shows the answer stages as a track", async () => {
    const stream = ndjsonStream();
    mockApi([{ method: "POST", path: STREAM, respond: (init) => stream.respond(init) }]);
    renderAt("/ask", "/ask", <AskPage />);
    await userEvent.type(screen.getByLabelText("Вопрос"), "Какие слои?");
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const track = await screen.findByRole("list", { name: "Этапы ответа" });
    expect(within(track).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Ищу источники",
      "Формулирую ответ",
      "Проверяю цитаты",
    ]);
    expect(within(track).getByText("Ищу источники")).toHaveAttribute("aria-current", "step");
    stream.push({ type: "status", stage: "validating" });
    expect(await within(track).findByText("Проверяю цитаты")).toHaveAttribute("aria-current", "step");
    stream.push({ type: "final", response: supportedAnswer });
    stream.close();
    expect(await screen.findByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Этапы ответа" })).toBeNull();
  });

  it("keeps the answers when the reader follows a citation and comes back (memory only)", async () => {
    mockApi([streamRoute(...final(supportedAnswer))]);
    renderRoutes("/ask", {
      "/ask": <AskPage />,
      "/documents/:id": <Link to="/ask">Вернуться к ответу</Link>,
    });
    await ask();
    await userEvent.click(screen.getAllByRole("link", { name: "Источник 1" })[0] as HTMLElement);
    expect(screen.getByTestId("location")).toHaveTextContent("/documents/SEM-ARCH-001");
    await userEvent.click(screen.getByRole("link", { name: "Вернуться к ответу" }));
    expect(screen.getByRole("heading", { name: "Ассистент" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Диалог" })).getByText("Какие слои у архитектуры?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Новый диалог" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Ассистент" })).toBeNull());
  });
});
