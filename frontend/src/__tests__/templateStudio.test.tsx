import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  AiProposal,
  StudioCheck,
  StudioIssue,
  StudioOptions,
  StudioState,
  TemplateComparison,
  TemplateDetail,
  TemplateSpec,
  TemplateSummary,
} from "../api/types";
import { parseBody, renderBody, sectionsFromMarkdown } from "../lib/templateSpec";
import { TemplateDetailPage } from "../pages/TemplateDetailPage";
import { TemplateEditorPage } from "../pages/TemplateEditorPage";
import { TemplatesPage } from "../pages/TemplatesPage";
import { mockApi, renderAt, renderRoutes } from "./helpers";

/*
 * Template Studio (docs/TEMPLATE_HUB.md): the builder and the Markdown editor are one structure, server issues are
 * shown next to their fields, activation is confirmed, history and diff are visible, AI only proposes.
 */

const spec = (over: Partial<TemplateSpec> = {}): TemplateSpec => ({
  template_id: "exchange_spec",
  title: "Обмен данными",
  description: "Описание обмена.",
  category: "Интеграции",
  doc_type: "integration",
  id_prefix: "SEM-EXCH",
  owner: "team",
  labels: ["обмен"],
  default_tags: [],
  sections: [
    { title: "Назначение", required: true, hint: "зачем", content: "" },
    { title: "Периодичность", required: true, hint: "как часто", content: "" },
    { title: "Ссылки", required: false, hint: "", content: "" },
  ],
  required_metadata: ["title", "owner"],
  optional_metadata: [],
  validation: ["Указана периодичность"],
  instructions: "",
  ai_guidance: "",
  example: "",
  changes: "",
  breaking: false,
  migration: "",
  status: "active",
  ...over,
});

const options = (over: Partial<StudioOptions> = {}): StudioOptions => ({
  doc_types: ["integration", "guide", "dataset"],
  metadata_fields: ["aliases", "owner", "related_ids", "tags", "title"],
  statuses: ["active", "deprecated", "archived"],
  reserved_ids: ["new", "studio"],
  prefixes: { "SEM-INT": "integration" },
  template_id_pattern: "^[a-z][a-z0-9_]{1,40}$",
  id_prefix_pattern: "^[A-Z]",
  max_sections: 40,
  permissions: { view: true, create: true, edit: true, activate: true },
  ai: { available: true, mode: "internal_api", reason: null },
  defaults: spec({ template_id: "", title: "", id_prefix: "", sections: [{ title: "Назначение", required: true, hint: "", content: "" }] }),
  ...over,
});

const check = (over: Partial<StudioCheck> = {}): StudioCheck => ({
  valid: true,
  issues: [],
  activation: "new_version",
  next_version: 2,
  schema_changed: true,
  changed_fields: ["sections"],
  source: "---\ntemplate_id: exchange_spec\n---\n## Назначение\n",
  preview: {
    document_id: "SEM-EXCH-001",
    markdown: "---\nid: SEM-EXCH-001\n---\n# Новый документ\n",
    html: "<h1>Новый документ</h1><h2>Назначение</h2>",
    sections: [{ title: "Назначение", required: true, hint: "зачем" }],
  },
  ...over,
});

const studioState = (over: Partial<StudioState> = {}): StudioState => ({
  template_id: "exchange_spec",
  kind: "created",
  revision: 3,
  current_version: 1,
  current: spec(),
  draft: null,
  versions: [
    { version: 1, status: "active", current: true, source: "studio", first_seen: "2026-11-20T10:00:00+00:00", changes: "", breaking: false, activated_by: "local-demo-user", activated_at: "2026-11-20T10:00:00+00:00", documents: 2 },
  ],
  events: [
    { at: "2026-11-20T10:00:00+00:00", actor: "local-demo-user", action: "activated", version: 1, revision: 2, summary: "Активирована v1" },
    { at: "2026-11-20T09:00:00+00:00", actor: "local-demo-user", action: "created", version: null, revision: 1, summary: "Создан черновик шаблона" },
  ],
  shipped_version: null,
  shipped_update: null,
  updated_by: "local-demo-user",
  updated_at: "2026-11-20T10:00:00+00:00",
  ai_proposal_id: null,
  ...over,
});

const comparison: TemplateComparison = {
  template_id: "exchange_spec",
  from_version: 1,
  to_version: 2,
  sections_added: ["Мониторинг"],
  sections_removed: [],
  became_required: [],
  became_optional: [],
  metadata_required_added: [],
  metadata_required_removed: [],
  validation_added: [],
  validation_removed: [],
  status_change: null,
  breaking: false,
  migration: "",
  changes: "",
  fields_changed: ["sections"],
  source_diff: {
    unified: "",
    lines: [
      { kind: "hunk", old_no: null, new_no: null, text: "@@ -1,2 +1,4 @@" },
      { kind: "add", old_no: null, new_no: 3, text: "## Мониторинг" },
    ],
    additions: 1,
    deletions: 0,
    changed: true,
  },
  to_draft: true,
};

const optionsRoute = (over: Partial<StudioOptions> = {}) => ({ path: "/api/templates/studio/options", body: options(over) });

// --- one structure, two views --------------------------------------------------------------------------------------
describe("templateSpec: Markdown ↔ sections", () => {
  it("round-trips a body with a hint, a table and a bare placeholder exactly", () => {
    const body =
      "## Определение\n> Требует уточнения: краткое определение.\n\n## Атрибуты\n> Требует уточнения: атрибуты.\n\n| A | B |\n|---|---|\n\n## Шаги\n1. Требует уточнения: шаг.\n\n## Пусто\n> Требует уточнения\n";
    const parsed = parseBody(body);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sections.map((s) => [s.title, s.hint, s.content])).toEqual([
      ["Определение", "краткое определение.", ""],
      ["Атрибуты", "атрибуты.", "| A | B |\n|---|---|"],
      ["Шаги", "", "1. Требует уточнения: шаг."],
      ["Пусто", "", ""],
    ]);
    expect(renderBody(parsed.sections)).toBe(body);
  });

  it("says why a text cannot be mapped and keeps required flags by title", () => {
    expect(parseBody("# Заголовок\n## А\n").problems[0]).toMatch(/первого уровня/);
    expect(parseBody("Вступление\n## А\n").problems[0]).toMatch(/до первого раздела/);
    const next = sectionsFromMarkdown("## ссылки\n\n## Новый\n", spec().sections);
    expect(next.sections.map((s) => [s.title, s.required])).toEqual([
      ["ссылки", false],
      ["Новый", true],
    ]);
  });
});

// --- the catalogue -----------------------------------------------------------------------------------------------
const tile = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: "exchange_spec",
  title: "Обмен данными",
  description: "",
  doc_type: "integration",
  category: "Интеграции",
  owner: "team",
  labels: [],
  status: "draft",
  version: 1,
  versions: [],
  updated: "",
  listed: true,
  required_sections: 2,
  optional_sections: 1,
  documents: 0,
  source: "studio",
  has_draft: true,
  shipped_update: null,
  ...over,
});

describe("Template catalogue: studio actions", () => {
  it("offers «Создать шаблон» and «Создать с помощью AI», marks drafts and studio templates", async () => {
    mockApi([optionsRoute(), { path: "/api/templates", body: [tile()] }]);
    renderAt("/templates", "/templates", <TemplatesPage />);
    expect(await screen.findByRole("link", { name: "Создать шаблон" })).toHaveAttribute("href", "/templates/new");
    expect(screen.getByRole("button", { name: "Создать с помощью AI" })).toBeEnabled();
    const card = await screen.findByText("ещё не активирован");
    expect(card.closest("li")).toHaveTextContent("создан в студии");
  });

  it("explains in one line why AI is unavailable without a language model, and hides it when AI is off", async () => {
    mockApi([optionsRoute({ ai: { available: false, mode: "mock", reason: "Без языковой модели структуру шаблона не предложить." } }), { path: "/api/templates", body: [] }]);
    const first = renderAt("/templates", "/templates", <TemplatesPage />);
    const button = await screen.findByRole("button", { name: "Создать с помощью AI" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Без языковой модели/);
    first.unmount();
    mockApi([optionsRoute({ ai: { available: false, mode: "disabled", reason: "ИИ отключён" } }), { path: "/api/templates", body: [] }]);
    renderAt("/templates", "/templates", <TemplatesPage />);
    expect(await screen.findByRole("link", { name: "Создать шаблон" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Создать с помощью AI" })).toBeNull();
  });

  it("shows no studio actions to a reader without the right to create", async () => {
    mockApi([
      optionsRoute({ permissions: { view: true, create: false, edit: false, activate: false } }),
      { path: "/api/templates", body: [tile({ status: "active", has_draft: false })] },
    ]);
    renderAt("/templates", "/templates", <TemplatesPage />);
    await screen.findByText("Обмен данными");
    expect(screen.queryByRole("link", { name: "Создать шаблон" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Создать с помощью AI" })).toBeNull();
  });
});

// --- the editor --------------------------------------------------------------------------------------------------
describe("Template Studio editor", () => {
  it("keeps the section builder and the Markdown editor in sync, and reports Markdown that cannot be mapped", async () => {
    mockApi([optionsRoute()]);
    renderRoutes("/templates/new", { "/templates/new": <TemplateEditorPage /> });
    await userEvent.click(await screen.findByRole("tab", { name: "Разделы" }));
    await userEvent.click(screen.getByRole("button", { name: "Добавить раздел" }));
    const titles = screen.getAllByLabelText("Название раздела");
    expect(titles[1]).toHaveFocus();
    await userEvent.type(titles[1] as HTMLElement, "Источники");
    await userEvent.click(screen.getAllByRole("checkbox", { name: "Обязательный" })[1] as HTMLElement); // optional now

    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    const markdown = screen.getByLabelText("Текст шаблона в Markdown") as HTMLTextAreaElement;
    expect(markdown.value).toBe("## Назначение\n> Требует уточнения\n\n## Источники\n> Требует уточнения\n");
    fireEvent.change(markdown, { target: { value: `${markdown.value}\n## Периодичность\n> Требует уточнения: как часто\n` } });
    await userEvent.click(screen.getByRole("tab", { name: "Разделы" }));
    const after = screen.getAllByLabelText("Название раздела").map((el) => (el as HTMLInputElement).value);
    expect(after).toEqual(["Назначение", "Источники", "Периодичность"]);
    expect((screen.getAllByRole("checkbox", { name: "Обязательный" })[1] as HTMLInputElement).checked).toBe(false); // kept

    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    fireEvent.change(screen.getByLabelText("Текст шаблона в Markdown"), { target: { value: "# Заголовок\n\n## А\n" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/первого уровня/);
    expect(screen.getByRole("button", { name: "Сохранить черновик" })).toBeDisabled();
    await userEvent.click(screen.getByRole("tab", { name: /Разделы/ }));
    expect(screen.getByText(/Конструктор показывает последнюю/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Название раздела")).toHaveLength(3); // the last mapped structure
    await userEvent.click(screen.getByRole("button", { name: "Вернуть Markdown по конструктору" }));
    expect(screen.getByRole("button", { name: "Сохранить черновик" })).toBeEnabled();
  });

  it("reorders sections with buttons and with Alt+arrows, keeping the focus on the moved section", async () => {
    mockApi([optionsRoute(), { path: "/api/templates/exchange_spec/studio", body: studioState() }]);
    renderRoutes("/templates/exchange_spec/edit", { "/templates/:id/edit": <TemplateEditorPage /> });
    await userEvent.click(await screen.findByRole("tab", { name: "Разделы" }));
    const values = () => screen.getAllByLabelText("Название раздела").map((el) => (el as HTMLInputElement).value);
    await userEvent.click(screen.getByRole("button", { name: "Опустить раздел «Назначение»" }));
    expect(values()).toEqual(["Периодичность", "Назначение", "Ссылки"]);
    expect(screen.getByRole("button", { name: "Опустить раздел «Назначение»" })).toHaveFocus();
    const title = screen.getAllByLabelText("Название раздела")[2] as HTMLElement;
    title.focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(values()).toEqual(["Периодичность", "Ссылки", "Назначение"]);
    expect(screen.getAllByLabelText("Название раздела")[1]).toHaveFocus();
    expect(screen.getByText(/Раздел «Ссылки» перемещён: позиция 2 из 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Удалить раздел «Ссылки»" }));
    expect(values()).toEqual(["Периодичность", "Назначение"]);
  });

  it("shows server issues next to their fields, counts them on tabs and takes the person to a field", async () => {
    const issues: StudioIssue[] = [
      { field: "id_prefix", code: "id_prefix_taken", message: "Префикс SEM-INT уже использует шаблон «integration».", severity: "error" },
      { field: "sections.1.title", code: "section_title_duplicate", message: "Раздел «Назначение» уже есть.", severity: "error" },
      { field: "owner", code: "owner_missing", message: "Укажите владельца шаблона.", severity: "warning" },
    ];
    const calls = mockApi([optionsRoute(), { method: "POST", path: "/api/templates/studio/validate", body: check({ valid: false, issues }) }]);
    renderRoutes("/templates/new", { "/templates/new": <TemplateEditorPage /> });
    await userEvent.type(await screen.findByLabelText(/^Название\s*\*/), "Обмен");
    await userEvent.click(screen.getByRole("button", { name: "Проверить" }));
    const prefix = await screen.findByLabelText(/^Префикс ID документов/);
    expect(prefix).toHaveAttribute("aria-invalid", "true");
    expect(prefix).toHaveAccessibleDescription(/уже использует шаблон «integration»/);
    expect(screen.getByLabelText(/^Владелец шаблона/)).toHaveAccessibleDescription(/Укажите владельца/);
    expect(screen.getByRole("tab", { name: "Разделы (1)" })).toBeInTheDocument();
    expect(screen.getByText("Ошибок: 2 · предупреждений: 1")).toBeInTheDocument();
    const sent = calls.find((c) => c.url === "/api/templates/studio/validate")?.body as { spec: TemplateSpec };
    expect(sent.spec.title).toBe("Обмен");

    await userEvent.click(screen.getByRole("button", { name: "Разделы №2" }));
    const sectionTitle = screen.getAllByLabelText("Название раздела")[0] as HTMLElement; // only one section in defaults
    expect(screen.getByRole("tab", { name: "Разделы (1)" })).toHaveAttribute("aria-selected", "true");
    expect(sectionTitle).toBeInTheDocument();
  });

  it("creates a new template as a draft and opens it in the editor", async () => {
    const calls = mockApi([
      optionsRoute(),
      { method: "POST", path: "/api/templates/studio", status: 201, body: { state: studioState({ current_version: null, current: null }), check: check() } },
      { path: "/api/templates/exchange_spec/studio", body: studioState({ current_version: null, current: null, draft: { spec: spec(), base_version: null, saved_by: "local-demo-user", saved_at: "2026-11-24T10:00:00+00:00", check: check({ activation: "new_template", next_version: 1 }) } }) },
    ]);
    renderRoutes("/templates/new", { "/templates/new": <TemplateEditorPage />, "/templates/:id/edit": <TemplateEditorPage /> });
    await userEvent.type(await screen.findByLabelText(/^Название\s*\*/), "Обмен данными");
    await userEvent.type(screen.getByLabelText(/^ID шаблона/), "exchange_spec");
    await userEvent.type(screen.getByLabelText(/^Префикс ID документов/), "sem-exch");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/templates/exchange_spec/edit"));
    const sent = calls.find((c) => c.method === "POST" && c.url === "/api/templates/studio")?.body as { spec: TemplateSpec };
    expect(sent.spec).toMatchObject({ template_id: "exchange_spec", title: "Обмен данными", id_prefix: "SEM-EXCH" });
    expect(await screen.findByText(/Черновик шаблона сохранён/)).toBeInTheDocument();
    expect(screen.getByText("ещё не активирован")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Активировать" })).toBeEnabled();
  });

  it("saves a draft with the revision it was based on and explains a conflict with another editor", async () => {
    const calls = mockApi([
      optionsRoute(),
      { path: "/api/templates/exchange_spec/studio", body: studioState() },
      {
        method: "PUT",
        path: "/api/templates/exchange_spec/studio/draft",
        status: 409,
        body: { code: "template_conflict", message: "Шаблон уже изменён: other, 10:00 (ревизия 4, у вас 3). Обновите редактор.", request_id: "r", details: { current_revision: 4 } },
      },
    ]);
    renderRoutes("/templates/exchange_spec/edit", { "/templates/:id/edit": <TemplateEditorPage /> });
    const description = await screen.findByLabelText(/^Описание/);
    await userEvent.type(description, " Уточнено.");
    expect(screen.getByText("несохранённые изменения")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText("Шаблон уже изменил кто-то другой")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Загрузить сохранённое/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Оставить мои правки/ })).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT")?.body as { expected_revision: number; spec: TemplateSpec };
    expect(put.expected_revision).toBe(3);
    expect(put.spec.description).toBe("Описание обмена. Уточнено.");
    expect((screen.getByLabelText(/^Описание/) as HTMLTextAreaElement).value).toBe("Описание обмена. Уточнено."); // kept
  });

  it("activates a saved draft only after a confirmation that shows the outcome and the changes", async () => {
    const draft = { spec: spec({ sections: [...spec().sections, { title: "Мониторинг", required: true, hint: "", content: "" }] }), base_version: 1, saved_by: "local-demo-user", saved_at: "2026-11-24T10:00:00+00:00", check: check() };
    const activated = studioState({ revision: 5, current_version: 2, current: draft.spec, draft: null });
    const calls = mockApi([
      optionsRoute(),
      { path: "/api/templates/exchange_spec/studio", body: studioState({ draft, revision: 4 }) },
      { path: /\/api\/templates\/exchange_spec\/studio\/compare\?from=1&to=draft$/, body: comparison },
      { method: "POST", path: "/api/templates/exchange_spec/studio/activate", body: { action: "activated", version: 2, state: activated } },
    ]);
    renderRoutes("/templates/exchange_spec/edit", { "/templates/:id/edit": <TemplateEditorPage /> });
    expect(await screen.findByText(/Будет создана версия v2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Активировать" }));
    const dialog = await screen.findByRole("dialog", { name: "Активировать шаблон" });
    expect(within(dialog).getByText(/Будет создана версия v2/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мониторинг")).toBeInTheDocument();
    expect(within(dialog).getByText(/Документы и черновики, созданные раньше/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/activate"))).toBe(false); // nothing before confirm
    await userEvent.click(within(dialog).getByRole("button", { name: "Активировать v2" }));
    expect(await screen.findByText(/Действует v2\. Новые документы создаются по ней/)).toBeInTheDocument();
    const sent = calls.find((c) => c.method === "POST" && c.url.endsWith("/activate"))?.body;
    expect(sent).toEqual({ expected_revision: 4 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not activate with unsaved edits or without the right to activate", async () => {
    const draft = { spec: spec(), base_version: 1, saved_by: "u", saved_at: "2026-11-24T10:00:00+00:00", check: check({ activation: "info_update", next_version: 1 }) };
    mockApi([optionsRoute({ permissions: { view: true, create: true, edit: true, activate: false } }), { path: "/api/templates/exchange_spec/studio", body: studioState({ draft }) }]);
    renderRoutes("/templates/exchange_spec/edit", { "/templates/:id/edit": <TemplateEditorPage /> });
    const activate = await screen.findByRole("button", { name: "Активировать" });
    expect(activate).toBeDisabled();
    expect(activate).toHaveAccessibleDescription(/Нет права активировать/);
  });

  it("shows the version history with authors, the event log and a diff against the draft", async () => {
    const draft = { spec: spec(), base_version: 1, saved_by: "local-demo-user", saved_at: "2026-11-24T10:00:00+00:00", check: check() };
    mockApi([
      optionsRoute(),
      { path: "/api/templates/exchange_spec/studio", body: studioState({ draft }) },
      { path: /\/studio\/compare\?from=1&to=draft$/, body: comparison },
    ]);
    renderRoutes("/templates/exchange_spec/edit?tab=history", { "/templates/:id/edit": <TemplateEditorPage /> });
    const versions = await screen.findByRole("region", { name: "Версии" });
    expect(versions).toHaveTextContent("v1");
    expect(versions).toHaveTextContent("активировал local-demo-user");
    expect(versions).toHaveTextContent("документов на этой версии: 2");
    expect(versions).toHaveTextContent("Черновик");
    const log = screen.getByRole("region", { name: "Журнал изменений" });
    expect(log).toHaveTextContent("Активирована версия");
    expect(log).toHaveTextContent("Создан черновик");
    await userEvent.click(screen.getByRole("button", { name: "Сравнить" }));
    expect(await screen.findByText("Добавлены разделы")).toBeInTheDocument();
    expect(screen.getByText(/черновик \(v2\)/)).toBeInTheDocument();
    expect(screen.getByText("Изменения в тексте шаблона")).toBeInTheDocument();
  });

  it("opens an AI proposal for editing and saves it as the person's draft (the Accept)", async () => {
    const proposal: AiProposal = {
      id: "AIP-0123456789abcdef",
      kind: "draft_template",
      status: "suggested",
      created_at: "2026-11-24T10:00:00+00:00",
      decided_at: null,
      mode: "internal_api",
      base: { draft_id: null, edit_version: null, document_id: null, revision: null, template_id: null, template_version: null, index_generation: "g" },
      summary: "Предложен шаблон",
      items: [{ id: "template", kind: "template", field: null, section: null, target_id: null, current: null, proposed: spec({ title: "Обмен (ИИ)" }), reason: "", evidence: [], applicable: true }],
      warnings: ["Похоже на существующий шаблон «Интеграция» (integration): совпадают разделы: назначение."],
      insufficient: false,
      graph_link: null,
      applied_items: [],
      result_draft_id: null,
    };
    const calls = mockApi([
      optionsRoute(),
      { path: "/api/ai/proposals/AIP-0123456789abcdef", body: proposal },
      { method: "POST", path: "/api/templates/studio", status: 201, body: { state: studioState(), check: check() } },
      { path: "/api/templates/exchange_spec/studio", body: studioState() },
    ]);
    renderRoutes("/templates/new?proposal=AIP-0123456789abcdef", { "/templates/new": <TemplateEditorPage />, "/templates/:id/edit": <TemplateEditorPage /> });
    expect(await screen.findByText(/Предложение ИИ\./)).toBeInTheDocument();
    expect(screen.getByText(/Похоже на существующий шаблон «Интеграция»/)).toBeInTheDocument();
    const title = screen.getByLabelText(/^Название\s*\*/);
    expect(title).toHaveValue("Обмен (ИИ)");
    await userEvent.clear(title);
    await userEvent.type(title, "Обмен (проверено)");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/templates/exchange_spec/edit"));
    const sent = calls.find((c) => c.method === "POST" && c.url === "/api/templates/studio")?.body as { spec: TemplateSpec; ai_proposal_id: string };
    expect(sent.ai_proposal_id).toBe("AIP-0123456789abcdef");
    expect(sent.spec.title).toBe("Обмен (проверено)");
  });

  it("asks the AI from the catalogue and only proposes: the proposal opens in the editor", async () => {
    const proposal = {
      id: "AIP-0123456789abcdef",
      kind: "draft_template",
      status: "suggested",
      summary: "Предложен шаблон «Обмен»: разделов 3.",
      warnings: ["Похоже на существующий шаблон «Интеграция» (integration)."],
      items: [{ id: "template", kind: "template", proposed: spec(), applicable: true }],
    };
    const calls = mockApi([optionsRoute(), { path: "/api/templates", body: [] }, { method: "POST", path: "/api/ai/proposals", status: 201, body: proposal }]);
    renderRoutes("/templates", { "/templates": <TemplatesPage />, "/templates/new": <p>Редактор</p> });
    await userEvent.click(await screen.findByRole("button", { name: "Создать с помощью AI" }));
    const panel = await screen.findByRole("dialog", { name: "Создать шаблон с помощью ИИ" });
    await userEvent.click(within(panel).getByRole("button", { name: "Подставить пример" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Предложить шаблон" }));
    expect(await within(panel).findByText(/Похоже на существующий шаблон/)).toBeInTheDocument();
    expect(within(panel).getByRole("list", { name: "Предложенные разделы" })).toHaveTextContent("Периодичность");
    expect(calls.find((c) => c.url === "/api/ai/proposals")?.body).toMatchObject({ kind: "draft_template" });
    await userEvent.click(within(panel).getByRole("button", { name: "Открыть в редакторе" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/templates/new?proposal=AIP-0123456789abcdef");
  });
});

describe("Template page: «Редактировать»", () => {
  const detail = {
    id: "mapping",
    title: "Маппинг",
    description: "",
    doc_type: "standard",
    category: "Семантика",
    owner: "team",
    labels: [],
    status: "active",
    version: 2,
    versions: [1, 2, 3],
    updated: "",
    listed: true,
    required_sections: 1,
    optional_sections: 0,
    documents: 0,
    source: "shipped",
    has_draft: true,
    shipped_update: 3,
    id_prefix: "SEM-MAP",
    default_tags: [],
    sections: [{ title: "Назначение", required: true, hint: "" }],
    required_metadata: ["title"],
    optional_metadata: [],
    validation: [],
    instructions: "",
    ai_guidance: "",
    example: "",
    example_html: "",
    skeleton: "## Назначение\n",
    changes: "",
    breaking: false,
    migration: "",
    history: [{ version: 2, status: "active", active: true, first_seen: "2026-11-20", changes: "", breaking: false }],
    used_by: [],
    my_open_drafts: {},
  } as unknown as TemplateDetail;

  it("links to the editor and says what is pending (a draft, a shipped update)", async () => {
    mockApi([optionsRoute(), { path: "/api/templates/mapping", body: detail }]);
    renderAt("/templates/mapping", "/templates/:id", <TemplateDetailPage />);
    expect(await screen.findByRole("link", { name: "Редактировать" })).toHaveAttribute("href", "/templates/mapping/edit");
    expect(screen.getByText(/Есть неактивированный черновик изменений/)).toBeInTheDocument();
    expect(screen.getByText(/В поставке приложения появилась версия/)).toBeInTheDocument();
  });

  it("has no «Редактировать» without the right to edit", async () => {
    mockApi([optionsRoute({ permissions: { view: true, create: false, edit: false, activate: false } }), { path: "/api/templates/mapping", body: detail }]);
    renderAt("/templates/mapping", "/templates/:id", <TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "Редактировать" })).toBeNull();
  });
});
