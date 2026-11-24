import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CorporatePage as CorporatePageData, TemplateDetail } from "../api/types";
import { Layout } from "../components/Layout";
import { CorporatePage } from "../pages/CorporatePage";
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
