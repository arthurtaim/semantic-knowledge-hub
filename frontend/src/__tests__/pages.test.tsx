import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CorporatePage as CorporatePageData, ImportPreview, TemplateDetail } from "../api/types";
import { Layout } from "../components/Layout";
import { CorporatePage } from "../pages/CorporatePage";
import { ImportPage } from "../pages/ImportPage";
import { IntegrationsPage } from "../pages/IntegrationsPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { ProposalsPage } from "../pages/ProposalsPage";
import { TemplateDetailPage } from "../pages/TemplateDetailPage";
import { TemplatesPage } from "../pages/TemplatesPage";
import { integrations, proposalSummary } from "./fixtures";
import { mockApi, mockViewport, renderAt } from "./helpers";

/*
 * UI v2 phase D — the remaining pages in the «toolbar, content, right panel» pattern: page actions live in the
 * page toolbar (at most one primary), H1s match the sidebar names, the logic is unchanged.
 */

const templateDetail: TemplateDetail = {
  id: "integration",
  title: "Интеграция",
  description: "Описание интеграции между системами.",
  doc_type: "integration",
  category: "Интеграции",
  owner: "demo-integration-team",
  labels: ["integration"],
  status: "active",
  version: 2,
  versions: [1, 2],
  updated: "2026-11-20",
  listed: true,
  required_sections: 1,
  optional_sections: 0,
  documents: 0,
  id_prefix: "SEM-INT",
  default_tags: ["integration"],
  sections: [{ title: "Назначение", required: true, hint: "зачем нужна интеграция" }],
  required_metadata: ["title", "owner"],
  optional_metadata: [],
  validation: [],
  instructions: "",
  ai_guidance: "",
  example: "",
  example_html: "",
  skeleton: "",
  changes: "",
  breaking: false,
  migration: "",
  history: [{ version: 2, status: "active", active: true, first_seen: "2026-11-20", changes: "v2", breaking: false }],
  used_by: [],
  my_open_drafts: {},
};

const toolbar = (container: HTMLElement) => container.querySelector(".page-toolbar") as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Other pages in the new system", () => {
  it("Шаблоны: the toolbar names the page with the real number of templates; the H1 matches the sidebar", async () => {
    mockApi([{ path: "/api/templates", body: [templateDetail, { ...templateDetail, id: "architecture", title: "Архитектура" }] }]);
    const { container } = renderAt("/templates", "/templates", <TemplatesPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Шаблоны" })).toBeInTheDocument();
    expect(await within(toolbar(container)).findByText("2")).toHaveClass("page-toolbar__count");
  });

  it("шаблон: its actions are in the toolbar, with «Использовать шаблон» the one primary", async () => {
    mockApi([{ path: "/api/templates/integration", body: templateDetail }]);
    const { container } = renderAt("/templates/integration", "/templates/:id", <TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: /Интеграция/ });
    const bar = toolbar(container);
    expect(within(bar).getByRole("link", { name: "Использовать шаблон" })).toHaveAttribute("href", "/documents/new?template=integration");
    expect(within(bar).getByRole("button", { name: "Создать с ИИ" })).toBeInTheDocument();
    expect(within(bar).getByRole("link", { name: "Сравнить версии" })).toHaveAttribute("href", "#compare");
    expect(container.querySelectorAll(".button--primary")).toHaveLength(1);
  });

  it("шаблон in the shell: the actions sit in the toolbar, and at the top of the content on a phone", async () => {
    mockApi([{ path: "/api/templates/integration", body: templateDetail }]);
    const shell = <Layout><TemplateDetailPage /></Layout>;
    const { container, unmount } = renderAt("/templates/integration", "/templates/:id", shell);
    await screen.findByRole("heading", { level: 1, name: /Интеграция/ });
    const actions = container.querySelector(".page-toolbar__actions") as HTMLElement;
    expect(within(actions).getByRole("link", { name: "Использовать шаблон" })).toBeInTheDocument();
    unmount();

    mockViewport(390);
    const phone = renderAt("/templates/integration", "/templates/:id", shell);
    await screen.findByRole("heading", { level: 1, name: /Интеграция/ });
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("link", { name: "Использовать шаблон" }).closest(".page-actions")).not.toBeNull();
    expect(phone.container.querySelector(".page-toolbar__actions")).toBeEmptyDOMElement();
  });

  it("Предложения: H1 as in the sidebar, «Создать документ» in the toolbar, the count from the API", async () => {
    mockApi([{ path: "/api/drafts", body: { items: [proposalSummary({})], total: 1 } }]);
    const { container } = renderAt("/proposals", "/proposals", <ProposalsPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Предложения" })).toBeInTheDocument();
    const bar = toolbar(container);
    expect(within(bar).getByRole("link", { name: "Создать документ" })).toHaveAttribute("href", "/documents/new");
    expect(await within(bar).findByText("1")).toHaveClass("page-toolbar__count");
  });

  it("Предложения on a phone: card rows with every column's facts instead of a table that scrolls sideways", async () => {
    mockViewport(390);
    mockApi([
      {
        path: "/api/drafts",
        body: {
          items: [
            proposalSummary({ id: "p-new", operation: "create", document_id: "SEM-ARCH-002", document_title: "Витрина метрик", warning_count: 2 }),
            proposalSummary({ id: "p-upd", merge_request_state: "opened", merge_request_url: "https://gitlab.example.test/mr/7" }),
          ],
          total: 2,
        },
      },
    ]);
    renderAt("/proposals", "/proposals", <ProposalsPage />);
    const list = await screen.findByRole("list", { name: "Предложения изменений" });
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const created = cards[0] as HTMLElement;
    expect(within(created).getByRole("link", { name: "Витрина метрик" })).toHaveAttribute("href", "/proposals/p-new");
    expect(within(created).getByText("SEM-ARCH-002")).toBeInTheDocument();
    expect(within(created).getByText("Новый документ")).toBeInTheDocument();
    expect(within(created).getByText("Предупреждений: 2")).toBeInTheDocument();
    expect(within(created).getByText("Изменения:")).toHaveClass("visually-hidden");
    const updated = cards[1] as HTMLElement;
    expect(within(updated).getByText("Изменение документа")).toBeInTheDocument();
    expect(within(updated).getByRole("link", { name: /Открыть MR в GitLab/ })).toHaveAttribute("href", "https://gitlab.example.test/mr/7");
  });

  it.each([
    [1440, "table"],
    [390, "list"],
  ] as const)("Импорт at %i px: the metadata fields with their origin as a %s (one column on a phone)", async (width, shape) => {
    mockViewport(width);
    const preview: ImportPreview = {
      state: "needs_metadata_review",
      has_frontmatter: false,
      document_id: "SEM-DQ-001",
      title: "Тестовый документ",
      fields: [
        { field: "id", value: "SEM-DQ-001", origin: "system", note: "выделит сервер при создании", evidence: [] },
        { field: "owner", value: null, origin: "missing", note: "владелец неизвестен: укажите его", evidence: [] },
      ],
      missing: ["owner"],
      templates: [],
      issues: [],
      body: "Текст.",
      preview_html: "<p>Текст.</p>",
      content: "# Тестовый документ\n\nТекст.\n",
      source_path: null,
      keeps_original_metadata: false,
    };
    mockApi([
      { path: "/api/documents/import/staging", body: [] },
      { method: "POST", path: "/api/documents/import/preview", body: preview },
      { path: "/api/templates", body: [] },
      { path: /^\/api\/templates\?/, body: [] },
      { path: "/api/document-types", body: [] },
    ]);
    renderAt("/documents/import", "/documents/import", <ImportPage />);
    await userEvent.type(screen.getByRole("textbox", { name: "Или вставьте текст" }), "# Тестовый документ");
    await userEvent.click(screen.getByRole("button", { name: "Показать предпросмотр" }));
    await screen.findByRole("heading", { name: "Предпросмотр импорта: «Тестовый документ»" });
    if (shape === "table") {
      const table = screen.getByRole("table", { name: "Поля метаданных и их происхождение" });
      expect(within(table).getByRole("rowheader", { name: "ID" })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("table", { name: "Поля метаданных и их происхождение" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Поля метаданных и их происхождение" })).toHaveClass("visually-hidden");
      const owner = screen.getByText("владелец неизвестен: укажите его").closest(".import-fields-list__row") as HTMLElement;
      expect(within(owner).getByRole("term")).toHaveTextContent("Владелец");
      expect(within(owner).getAllByRole("definition")[0]).toHaveTextContent("—");
      expect(within(owner).getByText("не указано")).toHaveClass("origin-badge--missing");
    }
  });

  it("Интеграции: H1 as in the sidebar, the list keeps its honest states", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Интеграции" })).toBeInTheDocument();
    expect(await screen.findByText("GitLab (каноническая база знаний)")).toBeInTheDocument();
  });

  it("Корпоративная страница: an external source laid out like a document, text kept as plain text", async () => {
    const page: CorporatePageData = {
      page_id: "200101",
      space: "OPS",
      title: "Регламент заморозки",
      body: "Первая строка.\n## Назначение\n<b>не HTML</b>",
      source_uri: "mock-confluence://OPS/200101",
      version: "3",
      updated_at: "2026-10-12",
      is_mock: true,
    };
    mockApi([{ path: "/api/corporate/pages/200101", body: page }]);
    const { container } = renderAt("/corporate/200101", "/corporate/:id", <CorporatePage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Регламент заморозки" })).toBeInTheDocument();
    expect(screen.getByText("Внешний источник")).toBeInTheDocument();
    expect(screen.getByText("Mock-коннектор", { selector: ".doc-head__demo" })).toBeInTheDocument();
    const props = container.querySelector(".doc-props") as HTMLElement;
    expect(within(props).getByText("OPS")).toBeInTheDocument();
    expect(within(props).getByText("mock-confluence://OPS/200101")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector(".corporate-page__body")).toHaveTextContent("<b>не HTML</b>");
  });

  it("404 offers the home page and the documents", async () => {
    renderAt("/nope", "*", <NotFoundPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Такой страницы нет" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "На главную" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "К документам" })).toHaveAttribute("href", "/documents");
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "На главную" })).toHaveFocus();
  });
});
