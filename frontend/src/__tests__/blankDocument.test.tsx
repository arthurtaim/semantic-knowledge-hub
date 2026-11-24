import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlankDocumentInfo, DocumentTypeInfo, ImportPreview, ProposalDetail } from "../api/types";
import { fieldsFromBlank, fieldsFromProposal, toMetadata } from "../lib/authoring";
import { DocumentCreatePage } from "../pages/DocumentCreatePage";
import { ImportPage } from "../pages/ImportPage";
import { checkResponse, NEW_DOC_ID, newDocumentProposal, session, templates } from "./fixtures";
import { memoryStorage, mockApi, renderRoutes, type MockRoute, type RecordedCall } from "./helpers";

const CREATE = { "/documents/new": <DocumentCreatePage /> };
const location = () => screen.getByTestId("location").textContent;
const AFTER_CHECK = { timeout: 1500 };

const blankInfo: BlankDocumentInfo = {
  id_prefix: "SEM-DOC",
  suggested_id: "SEM-DOC-001",
  suggested_path: "docs/SEM-DOC-001.md",
  default_type: "guide",
};

const documentTypes: DocumentTypeInfo[] = (["architecture", "process", "guide", "glossary"] as const).map((type) => ({
  type,
  templates: [],
  required_fields: ["id", "title", "type", "status", "owner", "tags"],
  system_fields: ["id", "status", "template", "template_version", "created_at", "updated_at", "origin"],
  human_fields: ["title", "owner", "summary", "tags"],
}));

const BLANK_BODY = "# Заметки о витрине\n\nСвободный текст со ссылкой [[SEM-ARCH-001]].\n\n## Контекст\nВитрина собирается ночью.\n";

/** A stored blank draft: no template, its own section. */
function blankProposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  const content =
    "---\nid: SEM-DOC-001\ntitle: Заметки о витрине\ntype: guide\nstatus: draft\nowner: unassigned\ntags: []\n---\n\n" +
    BLANK_BODY;
  return newDocumentProposal({
    template_id: null,
    template_version: null,
    template_current_version: null,
    document_id: "SEM-DOC-001",
    document_title: "Заметки о витрине",
    document_path: "docs/SEM-DOC-001.md",
    reason: "Записать, что известно о витрине",
    proposed_content: content,
    new_document: {
      metadata: {
        id: "SEM-DOC-001",
        title: "Заметки о витрине",
        type: "guide",
        status: "draft",
        owner: "unassigned",
        tags: [],
        related_ids: [],
        source_refs: [],
        reviewed_at: null,
      },
      body: BLANK_BODY,
    },
    ...overrides,
  });
}

function blankRoutes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { path: /^\/api\/authoring\/templates(\?include_hidden=true)?$/, body: templates },
    { path: "/api/authoring/blank", body: blankInfo },
    { path: "/api/document-types", body: documentTypes },
    { method: "POST", path: "/api/authoring/check", body: checkResponse({ path: "docs/SEM-DOC-001.md" }) },
  ];
}

const posts = (calls: RecordedCall[], url: string) => calls.filter((c) => c.method === "POST" && c.url === url);

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("«Пустой документ» on the create page", () => {
  it("comes first, next to «По шаблону», and opens the editor with a title and a section only", async () => {
    mockApi(blankRoutes());
    renderRoutes("/documents/new", CREATE);
    // the template flow is unchanged, after the blank document
    expect(await screen.findByRole("radio", { name: /Архитектура/ })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["Пустой документ", "По шаблону"]);
    expect(screen.getByRole("button", { name: "Открыть редактор" })).toBeDisabled();

    const start = screen.getByRole("button", { name: "Начать писать" });
    expect(start).toBeDisabled();
    expect(screen.getByText("Укажите название, чтобы начать.")).toBeInTheDocument();
    const section = screen.getByRole("combobox", { name: "Раздел каталога" });
    // only the types the server lists; the general section by default
    await waitFor(() => expect(within(section).getAllByRole("option")).toHaveLength(4));
    expect(section).toHaveValue("guide");
    expect(within(section).getByRole("option", { name: "Руководства" })).toBeInTheDocument();
    await userEvent.selectOptions(section, "process");
    await userEvent.type(screen.getByRole("textbox", { name: /^Название/ }), "Регламент сверки");
    await userEvent.click(screen.getByRole("button", { name: "Начать писать" }));

    const title = await screen.findByRole("textbox", { name: /^Название/ });
    expect(title).toHaveValue("Регламент сверки");
    const body = screen.getByRole("textbox", { name: /Markdown/ }) as HTMLTextAreaElement;
    expect(body.value).toBe("# Регламент сверки\n\n"); // no skeleton: free Markdown
    expect(screen.getByRole("combobox", { name: "Раздел каталога" })).toHaveValue("process");
    expect(screen.getByText("Происхождение").parentElement).toHaveTextContent("без шаблона");
    expect(screen.getByText(/Свободный Markdown: обязательных разделов нет/)).toBeInTheDocument();
    // live preview from the server, as for template documents
    expect(await screen.findByText("Предпросмотр документа", {}, AFTER_CHECK)).toBeInTheDocument();
  });

  it("saves without a template and with the chosen section", async () => {
    const calls = mockApi(
      blankRoutes([{ method: "POST", path: "/api/authoring/drafts", status: 201, body: blankProposal() }]),
    );
    renderRoutes("/documents/new", CREATE);
    await userEvent.type(await screen.findByRole("textbox", { name: /^Название/ }), "Заметки о витрине");
    await userEvent.click(screen.getByRole("button", { name: "Начать писать" }));
    await userEvent.type(await screen.findByRole("textbox", { name: /Причина \/ цель/ }), "Записать, что известно");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(location()).toBe(`/documents/new?draft=${NEW_DOC_ID}`));
    const post = posts(calls, "/api/authoring/drafts");
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toMatchObject({
      template_id: null,
      metadata: { id: "", title: "Заметки о витрине", status: "draft", type: "guide" },
      body: "# Заметки о витрине\n\n",
    });
    const check = posts(calls, "/api/authoring/check").at(-1);
    expect(check?.body).toMatchObject({ template_id: null, metadata: { type: "guide" } });
  });

  it("form helpers keep the section only for a document without a template", () => {
    expect(toMetadata(fieldsFromBlank("Х", "glossary")).type).toBe("glossary");
    expect(fieldsFromProposal(blankProposal())?.type).toBe("guide");
    expect(fieldsFromProposal(newDocumentProposal())?.type).toBeNull();
    expect("type" in toMetadata(fieldsFromProposal(newDocumentProposal())!)).toBe(false);
  });
});

describe("Editor of a draft without a template", () => {
  it("opens a stored blank draft (also an import) in the editor with WikiLinks, preview and AI actions", async () => {
    mockApi(
      blankRoutes([
        { path: `/api/drafts/${NEW_DOC_ID}`, body: blankProposal({ origin: "import" }) },
        {
          path: "/api/links/suggest?q=SEM-AR&limit=8",
          body: [
            {
              document_id: "SEM-ARCH-001",
              title: "Архитектура слоя",
              status: "approved",
              type: "architecture",
              matched: "id",
              alias: null,
              insert: "[[SEM-ARCH-001|Архитектура слоя]]",
            },
          ],
        },
      ]),
    );
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    const body = (await screen.findByRole("textbox", { name: /Markdown/ })) as HTMLTextAreaElement;
    expect(body.value).toBe(BLANK_BODY);
    expect(screen.getByText(/Документ импортирован из Markdown/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Раздел каталога" })).toHaveValue("guide");

    // AI actions that make sense without a template; the completeness check waits for one
    const ai = screen.getByRole("region", { name: "ИИ-помощник по черновику" });
    for (const name of ["Предложить метаданные", "Найти связанные", "Пересказать"]) {
      expect(within(ai).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(ai).queryByRole("button", { name: "Проверить полноту" })).toBeNull();
    expect(within(ai).getByText(/Проверка полноты появится, когда к черновику применён шаблон/)).toBeInTheDocument();

    // `[[` autocomplete works the same as with a template
    await userEvent.type(body, "См. [[[[SEM-AR");
    const listbox = await screen.findByRole("listbox", { name: "Документы для ссылки" });
    expect(await within(listbox).findAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(body.value).toContain("См. [[SEM-ARCH-001|Архитектура слоя]]"));
    expect(listbox).not.toBeInTheDocument();

    // preview mode
    await userEvent.click(screen.getByRole("button", { name: "Просмотр" }));
    expect(await screen.findByText("Предпросмотр документа", {}, AFTER_CHECK)).toBeInTheDocument();

  });

  it("keeps the completeness check for a template draft and hides the AI panel when AI is disabled", async () => {
    mockApi(blankRoutes([{ path: `/api/drafts/${NEW_DOC_ID}`, body: newDocumentProposal() }]));
    const view = renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE);
    const ai = await screen.findByRole("region", { name: "ИИ-помощник по черновику" });
    expect(within(ai).getByRole("button", { name: "Проверить полноту" })).toBeInTheDocument();
    view.unmount();

    mockApi(blankRoutes([{ path: `/api/drafts/${NEW_DOC_ID}`, body: blankProposal() }]));
    renderRoutes(`/documents/new?draft=${NEW_DOC_ID}`, CREATE, {
      ...session,
      features: { ...session.features, ai_mode: "disabled", ai_authoring: false },
    });
    expect(await screen.findByRole("textbox", { name: /Markdown/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ИИ-помощник по черновику" })).toBeNull();
  });
});

describe("Import of a file without a template", () => {
  it("opens the imported draft in the editor, not on the proposal page", async () => {
    const content = "---\nid: SEM-IMP-001\ntitle: Импорт\ntype: process\nstatus: draft\nowner: team\ntags: []\n---\n\n# Импорт\n";
    const preview: ImportPreview = {
      state: "ready",
      has_frontmatter: true,
      document_id: "SEM-IMP-001",
      title: "Импорт",
      fields: [{ field: "id", value: "SEM-IMP-001", origin: "existing", note: "из YAML файла", evidence: [] }],
      missing: [],
      templates: [],
      issues: [],
      body: "# Импорт\n",
      preview_html: "<h1>Импорт</h1>",
      content,
      source_path: null,
      keeps_original_metadata: true,
    };
    mockApi([
      { path: "/api/documents/import/staging", body: [] },
      { method: "POST", path: "/api/documents/import/preview", body: preview },
      { method: "POST", path: "/api/documents/import", status: 201, body: blankProposal({ origin: "import" }) },
    ]);
    renderRoutes("/documents/import", { "/documents/import": <ImportPage /> });
    await userEvent.type(screen.getByRole("textbox", { name: "Или вставьте текст" }), "# Импорт");
    await userEvent.click(screen.getByRole("button", { name: "Показать предпросмотр" }));
    await screen.findByRole("heading", { name: "Предпросмотр импорта: «Импорт»" });
    await userEvent.click(screen.getByRole("button", { name: /Создать черновик/ }));
    await waitFor(() => expect(location()).toBe(`/documents/new?draft=${NEW_DOC_ID}`));
  });
});
