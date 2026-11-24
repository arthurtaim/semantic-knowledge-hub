import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { CHECK_DELAY_MS } from "../components/DocumentEditor";
import { autoPath, fieldsFromProposal, retitleBody, splitList, toMetadata } from "../lib/authoring";
import { applyMarkdown } from "../lib/markdownEdit";
import { DocumentCreatePage } from "../pages/DocumentCreatePage";
import { ProposalDetailPage } from "../pages/ProposalDetailPage";
import { ProposalEditorPage } from "../pages/ProposalEditorPage";
import { ProposalsPage } from "../pages/ProposalsPage";
import {
  aiDraft,
  checkResponse,
  gitlabSession,
  NEW_DOC_BODY,
  NEW_DOC_ID,
  newDocumentProposal,
  proposal,
  proposalSummary,
  session,
  submittedProposal,
  templates,
} from "./fixtures";
import { mockApi, pendingUntilAborted, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

const CREATE = { "/documents/new": <DocumentCreatePage /> };
const location = () => screen.getByTestId("location").textContent;
/**
 * A wait for the result of the live check after typing: the editor debounces it by CHECK_DELAY_MS, so the wait is
 * that delay plus Testing Library's default 1 s — the default alone left half a second for the request and the
 * render, which a busy machine (the whole suite in parallel) sometimes needed.
 */
const AFTER_CHECK = { timeout: CHECK_DELAY_MS + 1000 };

function authoringRoutes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: /^\/api\/authoring\/templates(\?include_hidden=true)?$/, body: templates },
    { method: "POST", path: "/api/authoring/check", body: checkResponse() },
  ];
}

async function openManualEditor() {
  await userEvent.click(await screen.findByRole("radio", { name: /Архитектура/ }));
  await userEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  return screen.findByRole("textbox", { name: /^Название/ });
}

const posts = (calls: RecordedCall[], url: string, method = "POST") =>
  calls.filter((c) => c.method === method && c.url === url);

describe("Creating a document: type and mode", () => {
  it("lists templates with sections and opens the editor prefilled from the chosen template", async () => {
    mockApi(authoringRoutes());
    renderRoutes("/documents/new", CREATE);

    const card = (await screen.findByRole("radio", { name: /Архитектура/ })).closest("label") as HTMLElement;
    expect(within(card).getByText("Архитектура системы, компонента или контура семантического слоя.")).toBeInTheDocument();
    expect(within(card).getByText(/Назначение · Контекст · Компоненты/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /ADR/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Вручную" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "С помощью AI" })).toBeEnabled();
    expect(screen.getByText(/Демо-режим без языковой модели/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть редактор" })).toBeDisabled();

    await openManualEditor();
    // M5.6.3: the server allocates the ID at the first save; ID, status and origin are read-only.
    const id = screen.getByRole("textbox", { name: /^ID документа/ });
    expect(id).toHaveValue("");
    expect(id).toHaveAttribute("readonly");
    expect(screen.getByText(/ID выделит сервер при первом сохранении/)).toBeInTheDocument();
    expect(screen.getByText("Раздел каталога").parentElement).toHaveTextContent("Архитектура");
    expect(screen.getByText("Происхождение").parentElement).toHaveTextContent("создан вручную в редакторе");
    expect(screen.getByRole("textbox", { name: /^Владелец/ })).toHaveValue("local-demo-user");
    expect(screen.getByRole("textbox", { name: /^Владелец/ })).not.toBeRequired();
    expect(screen.getByRole("textbox", { name: /^Теги/ })).toHaveValue("architecture");
    expect(screen.getByRole("textbox", { name: /Путь в репозитории/ })).toHaveValue("");
    const body = screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
    expect(body.value.startsWith("# Название документа\n\n## Назначение")).toBe(true);
    expect(screen.getByText("Черновик ещё не сохранён")).toBeInTheDocument();
  });

  it("explains why the AI option is unavailable", async () => {
    mockApi(authoringRoutes());
    renderRoutes("/documents/new", CREATE, { ...session, features: { ...session.features, ai_authoring: false } });
    expect(await screen.findByRole("radio", { name: "С помощью AI" })).toBeDisabled();
    expect(screen.getByText(/AI-помощник для создания документов отключён/)).toBeInTheDocument();
  });

  it("keeps the path following the ID and the heading following the title", async () => {
    mockApi(authoringRoutes());
    renderRoutes("/documents/new", CREATE);
    const title = await openManualEditor();
    await userEvent.type(title, "Витрина метрик");
    const body = screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
    expect(body.value.startsWith("# Витрина метрик\n")).toBe(true);

    // An explicit opt-in sets the ID by hand (migrating a document with a known ID).
    await userEvent.click(screen.getByRole("checkbox", { name: /Задать ID вручную/ }));
    const id = screen.getByRole("textbox", { name: /^ID документа/ });
    expect(id).toHaveValue("SEM-ARCH-002");
    await userEvent.clear(id);
    await userEvent.type(id, "SEM-ARCH-777");
    expect(screen.getByRole("textbox", { name: /Путь в репозитории/ })).toHaveValue("docs/SEM-ARCH-777.md");
    // Live preview from the server (sanitized HTML) and the generated file.
    expect(await screen.findByText("Предпросмотр документа", {}, AFTER_CHECK)).toBeInTheDocument();
    expect(await screen.findByText("ID свободен", {}, AFTER_CHECK)).toBeInTheDocument();
  });
});

describe("Creating a document: manual flow", () => {
  it("saves with POST, switches the URL to the draft and saves again with PUT and the last version", async () => {
    const created = newDocumentProposal({ edit_version: 1 });
    const calls = mockApi(
      authoringRoutes([
        { method: "POST", path: "/api/authoring/drafts", status: 201, body: created },
        {
          method: "PUT",
          path: `/api/drafts/${NEW_DOC_ID}`,
          body: () => {
            const puts = calls.filter((c) => c.method === "PUT").length;
            return newDocumentProposal({ edit_version: puts + 1 });
          },
        },
      ]),
    );
    renderRoutes("/documents/new", CREATE);
    const title = await openManualEditor();
    await userEvent.type(title, "Витрина метрик");
    await userEvent.type(screen.getByRole("textbox", { name: /Причина \/ цель/ }), "Описать витрину");

    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText(/Черновик сохранён в/)).toBeInTheDocument();
    // React Router applies navigate() in a transition: the saved state can render a moment before the URL changes.
    await waitFor(() => expect(location()).toBe(`/documents/new?draft=${NEW_DOC_ID}`));
    const post = posts(calls, "/api/authoring/drafts");
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toMatchObject({
      template_id: "architecture",
      metadata: {
        id: "",
        title: "Витрина метрик",
        status: "draft",
        owner: "local-demo-user",
        tags: ["architecture"],
        related_ids: [],
        summary: null,
      },
      path: null,
      reason: "Описать витрину",
      origin: "manual",
      client_request_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
    });
    // The allocated ID is shown read-only from now on.
    expect(screen.getByRole("textbox", { name: /^ID документа/ })).toHaveValue(created.document_id);
    expect((post[0]?.body as { body: string }).body).toContain("# Витрина метрик");
    // The editor stays mounted on the new URL: the typed text is still there.
    expect(screen.getByRole("textbox", { name: /^Название/ })).toHaveValue("Витрина метрик");

    const body = screen.getByRole("textbox", { name: /Markdown/ });
    await userEvent.type(body, "Новый абзац.");
    expect(screen.getByText("Есть несохранённые изменения")).toHaveClass("save-state--dirty");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    // saved state: its own class (tick), not the "unsaved" ring or dot
    expect(await screen.findByText(/Черновик сохранён в/)).toHaveClass("save-state--saved");

    await userEvent.type(body, " Ещё.");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.body as Record<string, unknown>);
    expect(puts.map((b) => b.expected_version)).toEqual([1, 2]);
    expect(String(puts[1]?.body)).toContain("Новый абзац. Ещё.");
    expect(posts(calls, "/api/authoring/drafts")).toHaveLength(1);
    // Later checks exclude the draft itself from the ID/path uniqueness check.
    await waitFor(
      () =>
        expect(
          posts(calls, "/api/authoring/check").some(
            (c) => (c.body as { exclude_proposal_id?: string }).exclude_proposal_id === NEW_DOC_ID,
          ),
        ).toBe(true),
      AFTER_CHECK,
    );
  });

  it("keeps the text and shows the error on the ID field when the ID is taken (409)", async () => {
    const message = "Документ с ID SEM-ARCH-002 уже есть в базе знаний.";
    const calls = mockApi(
      authoringRoutes([
        {
          method: "POST",
          path: "/api/authoring/drafts",
          status: 409,
          body: {
            code: "document_id_taken",
            message,
            request_id: "r-409",
            details: {
              field: "id",
              validation: [{ severity: "error", code: "document_id_taken", message, field: "id" }],
            },
          },
        },
      ]),
    );
    renderRoutes("/documents/new", CREATE);
    const title = await openManualEditor();
    await userEvent.type(title, "Витрина метрик");
    await userEvent.type(screen.getByRole("textbox", { name: /Причина \/ цель/ }), "Описать витрину");
    const body = screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
    await userEvent.type(body, "Мой важный текст");

    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText("ID уже занят")).toBeInTheDocument();
    const idInput = screen.getByRole("textbox", { name: /^ID документа/ });
    expect(idInput).toHaveAttribute("aria-invalid", "true");
    expect(within(idInput.closest(".field") as HTMLElement).getByText(message)).toBeInTheDocument();
    expect(body.value).toContain("Мой важный текст");
    expect(screen.getByText(/Черновик не сохранён, но ваш текст остался в редакторе/)).toBeInTheDocument();
    expect(location()).toBe("/documents/new");
    expect(screen.getByRole("button", { name: "Отправить на ревью" })).toBeDisabled();
    expect(posts(calls, "/api/authoring/drafts")).toHaveLength(1);
  });

  it("requires the reason before saving and focuses the field", async () => {
    const calls = mockApi(authoringRoutes());
    renderRoutes("/documents/new", CREATE);
    const title = await openManualEditor();
    await userEvent.type(title, "Витрина метрик");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(screen.getByText("Укажите причину или цель — не короче 3 символов.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: /Причина \/ цель/ })).toHaveFocus());
    expect(posts(calls, "/api/authoring/drafts")).toHaveLength(0);
  });

  it("blocks review while validation reports errors and shows them next to the field", async () => {
    mockApi([
      { path: /^\/api\/authoring\/templates(\?include_hidden=true)?$/, body: templates },
      {
        method: "POST",
        path: "/api/authoring/check",
        body: checkResponse({
          validation: [
            { severity: "error", code: "invalid_id", message: "Поле `id` должно содержать латиницу.", field: "id" },
            { severity: "warning", code: "template_section_missing", message: "Нет разделов шаблона: Контекст.", field: null },
          ],
          error_count: 1,
          warning_count: 1,
        }),
      },
    ]);
    renderRoutes("/documents/new", CREATE);
    const title = await openManualEditor();
    await userEvent.type(title, "Витрина");
    await userEvent.type(screen.getByRole("textbox", { name: /Причина \/ цель/ }), "Описать витрину");
    expect(await screen.findByText("Поле `id` должно содержать латиницу.", {}, AFTER_CHECK)).toBeInTheDocument();
    expect(screen.getByText("Нет разделов шаблона: Контекст.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить на ревью" })).toBeDisabled();
    expect(screen.getByText("Исправьте ошибки проверки, чтобы отправить документ на ревью.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText(/Ошибок: 1, предупреждений: 1/)).toBeInTheDocument();
  });
});

describe("Creating a document with the AI helper", () => {
  it("fills the body from the demo helper and shows sources, quotes and the insufficient-data notice", async () => {
    const calls = mockApi(
      authoringRoutes([
        { method: "POST", path: "/api/authoring/ai-draft", body: aiDraft },
        { method: "POST", path: "/api/authoring/drafts", status: 201, body: newDocumentProposal({ origin: "ai_suggestion" }) },
      ]),
    );
    renderRoutes("/documents/new", CREATE);
    await userEvent.click(await screen.findByRole("radio", { name: "С помощью AI" }));
    await userEvent.click(screen.getByRole("radio", { name: /Архитектура/ }));
    await userEvent.click(screen.getByRole("button", { name: "Далее: запрос помощнику" }));

    expect(screen.getByText("Демо-режим: без языковой модели")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /^Название/ }), "Витрина метрик");
    await userEvent.type(screen.getByRole("textbox", { name: /Что должно быть в документе/ }), "Описать витрину метрик");
    await userEvent.type(screen.getByRole("textbox", { name: /Связанные документы/ }), "SEM-INT-ARIS-001");
    await userEvent.click(screen.getByRole("button", { name: "Подготовить черновик" }));

    const panel = (await screen.findByRole("heading", { name: "Источники и выдержки" })).closest("section") as HTMLElement;
    expect(posts(calls, "/api/authoring/ai-draft")[0]?.body).toEqual({
      template_id: "architecture",
      title: "Витрина метрик",
      request: "Описать витрину метрик",
      related_ids: ["SEM-INT-ARIS-001"],
    });
    expect(within(panel).getByText("Демо-режим: без языковой модели")).toBeInTheDocument();
    expect(within(panel).getByText("Недостаточно данных")).toBeInTheDocument();
    expect(within(panel).getByText("This local demonstration models a knowledge base with four layers")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Semantic Layer — demonstration architecture" })).toHaveAttribute(
      "href",
      "/documents/SEM-ARCH-001",
    );
    expect(within(panel).getByRole("link", { name: "SEM-ARCH-001" })).toHaveAttribute("href", "/documents/SEM-ARCH-001");
    expect(within(panel).getAllByText("sha256:0b52b3c3").length).toBeGreaterThan(0);
    expect(within(panel).getByText("Не подтверждено источниками")).toBeInTheDocument();
    expect(within(panel).getByText("Состав компонентов витрины не подтверждён источниками.")).toBeInTheDocument();
    expect(within(panel).getByText(/не утверждён и не используется как источник/)).toBeInTheDocument();

    const body = screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
    expect(body.value).toBe(aiDraft.body);
    expect(screen.getByRole("textbox", { name: /^Связанные документы/ })).toHaveValue("SEM-INT-ARIS-001, SEM-ARCH-001");
    expect(screen.queryByRole("option", { name: "Утверждён" })).toBeNull();
    expect(screen.getByText("Происхождение").parentElement).toHaveTextContent("предложение ИИ");
    expect(screen.getByText(/Текст подготовлен ИИ-помощником/)).toBeInTheDocument();
    expect(screen.getByText("Черновик ещё не сохранён")).toHaveClass("save-state--dirty");

    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(posts(calls, "/api/authoring/drafts")).toHaveLength(1));
    expect(posts(calls, "/api/authoring/drafts")[0]?.body).toMatchObject({
      origin: "ai_suggestion",
      reason: "Описать витрину метрик",
      metadata: { title: "Витрина метрик", related_ids: ["SEM-INT-ARIS-001", "SEM-ARCH-001"] },
    });
  });

  it("keeps the request when the AI helper is unavailable and offers to continue manually", async () => {
    mockApi(
      authoringRoutes([
        {
          method: "POST",
          path: "/api/authoring/ai-draft",
          status: 503,
          body: { code: "ai_authoring_unavailable", message: "AI-помощник для создания документов отключён.", request_id: "r-503" },
        },
      ]),
    );
    renderRoutes("/documents/new", CREATE);
    await userEvent.click(await screen.findByRole("radio", { name: "С помощью AI" }));
    await userEvent.click(screen.getByRole("radio", { name: /Архитектура/ }));
    await userEvent.click(screen.getByRole("button", { name: "Далее: запрос помощнику" }));
    await userEvent.type(screen.getByRole("textbox", { name: /^Название/ }), "Витрина метрик");
    const request = screen.getByRole("textbox", { name: /Что должно быть в документе/ });
    await userEvent.type(request, "Описать витрину");
    await userEvent.click(screen.getByRole("button", { name: "Подготовить черновик" }));

    expect(await screen.findByText("AI-помощник недоступен")).toBeInTheDocument();
    expect(request).toHaveValue("Описать витрину");
    await userEvent.click(screen.getByRole("button", { name: "Заполнить вручную" }));
    expect(await screen.findByRole("textbox", { name: /^Название/ })).toHaveValue("Витрина метрик");
    const body = screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
    expect(body.value.startsWith("# Витрина метрик\n")).toBe(true);
  });
});

describe("AI draft with a long-running provider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const claudeSession = { ...session, features: { ...session.features, ai_mode: "claude_cli" as const } };

  it("explains that Claude Code may take minutes and cancels the request on demand", async () => {
    const state = { aborted: false };
    const calls = mockApi(
      authoringRoutes([{ method: "POST", path: "/api/authoring/ai-draft", respond: pendingUntilAborted(state) }]),
    );
    renderRoutes("/documents/new", CREATE, claudeSession);
    await userEvent.click(await screen.findByRole("radio", { name: "С помощью AI" }));
    expect(screen.getByText(/подготовка может занять несколько минут/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Архитектура/ }));
    await userEvent.click(screen.getByRole("button", { name: "Далее: запрос помощнику" }));

    expect(screen.getByText("Claude Code CLI (личный тест)")).toHaveClass("ai-mode--claude_cli");
    await userEvent.type(screen.getByRole("textbox", { name: /^Название/ }), "Витрина метрик");
    const request = screen.getByRole("textbox", { name: /Что должно быть в документе/ });
    await userEvent.type(request, "Описать витрину метрик");
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Подготовить черновик" }));

    expect(await screen.findByText("Готовим черновик… с Claude Code это может занять несколько минут")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Подготовить черновик" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Заполнить вручную" })).toBeDisabled();
    expect(posts(calls, "/api/authoring/ai-draft")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(await screen.findByText(/Подготовка черновика отменена/)).toBeInTheDocument();
    expect(state.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Готовим черновик/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(request).toHaveValue("Описать витрину метрик");
    expect(screen.getByRole("button", { name: "Подготовить черновик" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Источники и выдержки" })).toBeNull(); // still the request step
  });

  it("keeps a provider-neutral waiting text for other providers", async () => {
    mockApi(authoringRoutes([{ method: "POST", path: "/api/authoring/ai-draft", respond: pendingUntilAborted() }]));
    renderRoutes("/documents/new", CREATE);
    await userEvent.click(await screen.findByRole("radio", { name: "С помощью AI" }));
    await userEvent.click(screen.getByRole("radio", { name: /Архитектура/ }));
    await userEvent.click(screen.getByRole("button", { name: "Далее: запрос помощнику" }));
    await userEvent.type(screen.getByRole("textbox", { name: /^Название/ }), "Витрина метрик");
    await userEvent.type(screen.getByRole("textbox", { name: /Что должно быть в документе/ }), "Описать витрину");
    await userEvent.click(screen.getByRole("button", { name: "Подготовить черновик" }));
    expect(await screen.findByText("Готовим черновик…")).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code/)).toBeNull();
  });

  it("waits up to five minutes for an AI draft instead of the default 30 seconds", async () => {
    vi.useFakeTimers();
    const state = { aborted: false };
    mockApi([{ method: "POST", path: "/api/authoring/ai-draft", respond: pendingUntilAborted(state) }]);
    const settled = api
      .aiDraft({ template_id: "architecture", title: "Витрина", request: "Описать витрину", related_ids: [] })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(state.aborted).toBe(true);
    expect(await settled).toMatchObject({ status: 0, code: "timeout" });
  });
});

describe("Resuming a stored draft", () => {
  const draftRoutes = (draft = newDocumentProposal(), extra: MockRoute[] = []) =>
    authoringRoutes([{ path: `/api/drafts/${NEW_DOC_ID}`, body: draft }, ...extra]);

  it("restores the form from the server and deletes the draft only after confirmation", async () => {
    const calls = mockApi(draftRoutes(newDocumentProposal(), [{ method: "DELETE", path: `/api/drafts/${NEW_DOC_ID}`, status: 204, body: null }]));
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, { ...CREATE, "/proposals": <ProposalsPageStub /> });

    expect(await screen.findByRole("textbox", { name: /^Название/ })).toHaveValue("Витрина метрик");
    expect(screen.getByRole("textbox", { name: /^Владелец/ })).toHaveValue("semantic-team");
    expect(screen.getByRole("textbox", { name: /Причина \/ цель/ })).toHaveValue("Описать витрину клиентских метрик");
    expect(screen.getByRole("textbox", { name: /Markdown/ })).toHaveValue(NEW_DOC_BODY);
    expect(screen.getByText(/Черновик сохранён в/)).toBeInTheDocument();
    // A draft's template is resolved among ALL templates (an unlisted one such as external_import too).
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/authoring/templates?include_hidden=true")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Удалить черновик" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText(/Удалить черновик безвозвратно\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Удалить безвозвратно" }));
    expect(await screen.findByText("Список предложений")).toBeInTheDocument();
    expect(location()).toBe("/proposals");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/drafts/${NEW_DOC_ID}`]);
  });

  it("marks a clean draft ready for review without re-saving and opens the proposal", async () => {
    const calls = mockApi(
      draftRoutes(newDocumentProposal(), [
        {
          method: "POST",
          path: `/api/drafts/${NEW_DOC_ID}/mark-ready`,
          body: newDocumentProposal({ status: "ready_for_review" }),
        },
      ]),
    );
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    await screen.findByRole("textbox", { name: /^Название/ });
    const submit = screen.getByRole("button", { name: "Отправить на ревью" });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(location()).toBe(`/proposals/${NEW_DOC_ID}`));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(posts(calls, `/api/drafts/${NEW_DOC_ID}/mark-ready`)).toHaveLength(1);
  });

  it("keeps the local text on a lost update (409 draft_modified) and offers to reload", async () => {
    let reads = 0;
    mockApi([
      {
        path: `/api/drafts/${NEW_DOC_ID}`,
        body: () => {
          reads += 1;
          return reads === 1
            ? newDocumentProposal()
            : newDocumentProposal({
                edit_version: 3,
                new_document: { ...newDocumentProposal().new_document!, body: "# Витрина метрик\n\nЧужая правка.\n" },
              });
        },
      },
      {
        method: "PUT",
        path: `/api/drafts/${NEW_DOC_ID}`,
        status: 409,
        body: { code: "draft_modified", message: "Черновик изменён в другом окне.", request_id: "r-1", details: { current_version: "3" } },
      },
      ...authoringRoutes(),
    ]);
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    const body = (await screen.findByRole("textbox", { name: /Markdown/ })) as HTMLTextAreaElement;
    await userEvent.type(body, "Моя правка.");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Черновик изменён в другом окне или другим пользователем")).toBeInTheDocument();
    expect(body.value).toContain("Моя правка.");
    await userEvent.click(screen.getByRole("button", { name: "Загрузить сохранённую версию" }));
    await waitFor(() => expect(body.value).toBe("# Витрина метрик\n\nЧужая правка.\n"));
    expect(screen.getByText(/Ваш прежний текст — ниже/)).toBeInTheDocument();
    expect(screen.getByText(/Моя правка\./, { selector: "code" })).toBeInTheDocument();
  });

  it("explains that a draft sent to review is no longer editable", async () => {
    mockApi(draftRoutes(newDocumentProposal({ status: "ready_for_review" })));
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    expect(await screen.findByText("Черновик больше нельзя редактировать")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть предложение" })).toHaveAttribute("href", `/proposals/${NEW_DOC_ID}`);
    expect(screen.queryByRole("textbox", { name: /Markdown/ })).toBeNull();
  });
});

function ProposalsPageStub() {
  return <p>Список предложений</p>;
}

describe("Proposal of a new document", () => {
  it("shows the operation, new-file wording, a fully added diff and edit/delete actions", async () => {
    const calls = mockApi([
      { path: `/api/drafts/${NEW_DOC_ID}`, body: newDocumentProposal() },
      { method: "DELETE", path: `/api/drafts/${NEW_DOC_ID}`, status: 204, body: null },
    ]);
    renderRoutes(`/proposals/${NEW_DOC_ID}`, { "/proposals/:id": <ProposalDetailPage />, "/proposals": <ProposalsPageStub /> });

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Новый документ «Витрина метрик»");
    expect(screen.getByText("Новый документ", { selector: ".op-badge" })).toBeInTheDocument();
    expect(screen.getByText("Документ появится в базе знаний только после merge в GitLab.")).toBeInTheDocument();
    expect(screen.getByText("новый файл")).toBeInTheDocument();
    expect(screen.getByText("документа ещё нет в базе знаний")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Содержимое нового файла" });
    const rows = within(table).getAllByRole("row").filter((r) => r.classList.contains("diff__row"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.classList.contains("diff__row--add"))).toBe(true);
    expect(screen.queryByRole("tab", { name: "До и после" })).toBeNull();
    expect(screen.getByText(/строк · новый файл/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Продолжить редактирование" })).toHaveAttribute(
      "href",
      `/documents/new?draft=${NEW_DOC_ID}`,
    );
    expect(screen.getByText(/Создан черновик нового документа/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Удалить черновик" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Удалить безвозвратно" }));
    expect(await screen.findByText("Список предложений")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("warns when the ID got taken before merge", async () => {
    mockApi([
      {
        path: `/api/drafts/${NEW_DOC_ID}`,
        body: newDocumentProposal({ source_document_state: "id_taken", current_revision: "sha256:other", can_mark_ready: false }),
      },
    ]);
    renderRoutes(`/proposals/${NEW_DOC_ID}`, { "/proposals/:id": <ProposalDetailPage /> });
    expect(await screen.findByText("Документ с ID SEM-ARCH-002 уже появился в базе знаний.")).toBeInTheDocument();
    expect(screen.getByText(/Измените ID, продолжив редактирование черновика/)).toBeInTheDocument();
  });

  it("offers a new draft with the same text after a create conflict", async () => {
    mockApi([
      {
        path: `/api/drafts/${NEW_DOC_ID}`,
        body: newDocumentProposal({ status: "conflict", source_document_state: "id_taken", current_revision: "sha256:other" }),
      },
    ]);
    renderRoutes(`/proposals/${NEW_DOC_ID}`, { "/proposals/:id": <ProposalDetailPage /> });
    expect(await screen.findByRole("link", { name: "Создать новый черновик с этим текстом" })).toHaveAttribute(
      "href",
      `/documents/new?from=${NEW_DOC_ID}`,
    );
    expect(screen.queryByRole("link", { name: /на основе актуальной версии/ })).toBeNull();
  });

  it("shows the knowledge-base revision after a confirmed merge", async () => {
    mockApi([
      {
        path: `/api/drafts/${NEW_DOC_ID}`,
        body: submittedProposal({
          ...newDocumentProposal(),
          status: "merged",
          can_refresh_status: false,
          can_edit: false,
          can_delete: false,
          merge_request_state: "merged",
          source_document_state: "updated_by_this_proposal",
          current_revision: "3f2a9c1d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
          merged_revision: "3f2a9c1d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
          synced_at: "2026-11-22T12:00:00Z",
        }),
      },
    ]);
    renderRoutes(`/proposals/${NEW_DOC_ID}`, { "/proposals/:id": <ProposalDetailPage /> }, gitlabSession);
    const notice = (await screen.findByText("Синхронизировано с базой знаний:")).closest(".notice") as HTMLElement;
    expect(within(notice).getByText("3f2a9c1d")).toBeInTheDocument();
    expect(within(notice).getByRole("link", { name: "Открыть документ в базе знаний" })).toHaveAttribute(
      "href",
      "/documents/SEM-ARCH-002",
    );
    expect(screen.getByText("Документ создан в GitLab и добавлен в базу знаний.")).toBeInTheDocument();
    expect(screen.getByText("Добавлено в базу знаний")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Продолжить редактирование" })).toBeNull();
  });

  it("starts a new draft from the text of a conflicted proposal with a fresh ID", async () => {
    mockApi(
      authoringRoutes([
        {
          path: `/api/drafts/${NEW_DOC_ID}`,
          body: newDocumentProposal({ status: "conflict", source_document_state: "id_taken" }),
        },
      ]),
    );
    renderRoutes(`/documents/new?from=${NEW_DOC_ID}`, CREATE);
    expect(await screen.findByRole("textbox", { name: /Markdown/ })).toHaveValue(NEW_DOC_BODY);
    expect(screen.getByRole("textbox", { name: /^ID документа/ })).toHaveValue("");
    expect(screen.getByText(/уже занят, поэтому сервер выделит новый свободный ID/)).toBeInTheDocument();
  });
});

describe("Proposals list and change drafts", () => {
  it("shows the operation of each proposal", async () => {
    mockApi([
      {
        path: "/api/drafts",
        body: {
          items: [
            proposalSummary({ id: "p-new", operation: "create", document_id: "SEM-ARCH-002", document_title: "Витрина метрик" }),
            proposalSummary({ id: "p-upd" }),
          ],
          total: 2,
        },
      },
    ]);
    renderRoutes("/proposals", { "/proposals": <ProposalsPage /> });
    const created = (await screen.findByRole("link", { name: "Витрина метрик" })).closest("tr") as HTMLElement;
    expect(within(created).getByText("Новый документ")).toBeInTheDocument();
    const updated = screen.getByRole("link", { name: "ARIS integration — questions for discovery" }).closest("tr") as HTMLElement;
    expect(within(updated).getByText("Изменение документа")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Операция" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Создать документ" })).toHaveAttribute("href", "/documents/new");
  });

  it("edits a stored change draft with PUT and the current version", async () => {
    const ID = "a".repeat(32);
    const calls = mockApi([
      { path: `/api/drafts/${ID}`, body: proposal({ edit_version: 4 }) },
      { method: "PUT", path: `/api/drafts/${ID}`, body: proposal({ edit_version: 5 }) },
    ]);
    renderRoutes(`/proposals/new?edit=${ID}`, { "/proposals/new": <ProposalEditorPage /> });
    const editor = await screen.findByRole("textbox", { name: /Текст документа/ });
    expect(editor).toHaveValue("a\nnew line\nc");
    const save = screen.getByRole("button", { name: "Сохранить черновик" });
    expect(save).toBeDisabled();
    await userEvent.type(editor, "\nd");
    await userEvent.click(save);
    await waitFor(() => expect(location()).toBe(`/proposals/${ID}`));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      expected_version: 4,
      reason: "Уточнение формулировки",
      proposed_content: "a\nnew line\nc\nd",
    });
  });

  it("links an update draft to its editor from the proposal page", async () => {
    const ID = "a".repeat(32);
    mockApi([{ path: `/api/drafts/${ID}`, body: proposal() }]);
    renderRoutes(`/proposals/${ID}`, { "/proposals/:id": <ProposalDetailPage /> });
    expect(await screen.findByRole("link", { name: "Продолжить редактирование" })).toHaveAttribute(
      "href",
      `/proposals/new?edit=${ID}`,
    );
    expect(screen.getByText("Изменение документа", { selector: ".op-badge" })).toBeInTheDocument();
  });
});

describe("Authoring helpers", () => {
  it("parses comma-separated lists and builds metadata", () => {
    expect(splitList(" a, b ,, a,\nc ")).toEqual(["a", "b", "c"]);
    const fields = fieldsFromProposal(newDocumentProposal());
    expect(fields).not.toBeNull();
    expect(fields?.pathEdited).toBe(false);
    expect(toMetadata({ ...fields!, summary: "  ", tags: "x, y" })).toMatchObject({ summary: null, tags: ["x", "y"] });
    expect(fieldsFromProposal(newDocumentProposal({ document_path: "custom/other.md" }))?.pathEdited).toBe(true);
    expect(autoPath("docs", "SEM-ARCH-003")).toBe("docs/SEM-ARCH-003.md");
    expect(autoPath("", "SEM-ARCH-003")).toBe("SEM-ARCH-003.md");
  });

  it("retitles the heading only while it still matches the title", () => {
    expect(retitleBody("# Название документа\n\nТекст", "", "Новое")).toBe("# Новое\n\nТекст");
    expect(retitleBody("# Свой заголовок\n\nТекст", "Старое", "Новое")).toBe("# Свой заголовок\n\nТекст");
  });

  it("applies Markdown toolbar actions at the cursor", () => {
    expect(applyMarkdown("heading", "текст", 0, 0)).toMatchObject({ text: "## текст", selectionStart: 3 });
    expect(applyMarkdown("bullets", "a\nb", 0, 3).text).toBe("- a\n- b");
    expect(applyMarkdown("numbers", "a\nb", 0, 3).text).toBe("1. a\n2. b");
    const link = applyMarkdown("link", "см. тут", 4, 7);
    expect(link.text).toBe("см. [тут](https://)");
    expect(link.text.slice(link.selectionStart, link.selectionEnd)).toBe("https://");
    const table = applyMarkdown("table", "Абзац", 5, 5);
    expect(table.text).toBe("Абзац\n\n| Колонка 1 | Колонка 2 |\n| --- | --- |\n| Значение | Значение |\n");
    expect(table.text.slice(table.selectionStart, table.selectionEnd)).toBe("Колонка 1");
    const code = applyMarkdown("code", "", 0, 0);
    expect(code.text).toBe("```\nкод\n```\n");
    expect(code.text.slice(code.selectionStart, code.selectionEnd)).toBe("код");
  });
});

describe("Template versions", () => {
  it("marks templates that have a newer version in the picker", async () => {
    mockApi([
      { path: /^\/api\/authoring\/templates(\?include_hidden=true)?$/, body: [{ ...templates[0], version: 2, previous_versions: [1] }, templates[1]] },
      { method: "POST", path: "/api/authoring/check", body: checkResponse() },
    ]);
    renderRoutes("/documents/new", CREATE);
    const card = (await screen.findByRole("radio", { name: "Архитектура" })).closest("label") as HTMLElement;
    expect(within(card).getByText("v2", { exact: false })).toHaveTextContent("версия шаблона v2");
    const adr = screen.getByRole("radio", { name: "ADR" }).closest("label") as HTMLElement;
    expect(within(adr).queryByText(/версия шаблона/)).toBeNull();
  });

  it("checks an older draft against its own template version and says that a newer one exists", async () => {
    const calls = mockApi(
      authoringRoutes([
        {
          path: `/api/drafts/${NEW_DOC_ID}`,
          body: newDocumentProposal({ template_version: 1, template_current_version: 2 }),
        },
      ]),
    );
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    await screen.findByRole("textbox", { name: /^Название/ });
    expect(
      screen.getByText(
        "Черновик создан по шаблону v1; актуальная версия — v2. Черновик проверяется по v1; переход на новую версию — отдельное действие автора.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(posts(calls, "/api/authoring/check").length).toBeGreaterThan(0));
    for (const check of posts(calls, "/api/authoring/check")) {
      expect((check.body as { template_version?: number }).template_version).toBe(1);
    }
  });

  it("shows no notice for a draft on the current template version", async () => {
    mockApi(
      authoringRoutes([
        { path: `/api/drafts/${NEW_DOC_ID}`, body: newDocumentProposal({ template_version: 2, template_current_version: 2 }) },
      ]),
    );
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    await screen.findByRole("textbox", { name: /^Название/ });
    expect(screen.queryByText(/Черновик создан по шаблону/)).toBeNull();
  });

  it("repeats the notice on the proposal page of the new document", async () => {
    mockApi([{ path: `/api/drafts/${NEW_DOC_ID}`, body: newDocumentProposal({ template_version: 1, template_current_version: 3 }) }]);
    renderRoutes(`/proposals/${NEW_DOC_ID}`, { "/proposals/:id": <ProposalDetailPage /> });
    expect(await screen.findByText(/Черновик создан по шаблону v1; актуальная версия — v3\./)).toBeInTheDocument();
  });
});
