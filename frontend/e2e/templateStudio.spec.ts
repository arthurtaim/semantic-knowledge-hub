import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * Template Studio on the offline demo stack (synthetic fixtures, mock AI): a person creates a template, checks it,
 * saves a draft, activates it and creates a document from it; then edits it into a new version while an existing
 * draft keeps its pinned version. Every template here is new and uniquely named (type «Продукт», which the template
 * recommendation never picks for other scenarios), so shipped templates and other specs are not affected.
 * With E2E_DISABLED_URL (AI_PROVIDER=disabled) the catalogue offers manual creation and no AI action.
 */
const HEADERS = { "X-SKH-Client": "e2e" };
const DISABLED_URL = process.env.E2E_DISABLED_URL;

function suffix(): string {
  return `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

interface Created {
  id: string;
  title: string;
  prefix: string;
}

function spec(n: string, extra: Record<string, unknown> = {}) {
  return {
    template_id: `e2e_tpl_${n}`,
    title: `E2E шаблон ${n}`,
    description: "Синтетический шаблон E2E.",
    category: "E2E",
    doc_type: "overview",
    id_prefix: `SEM-E${n}`,
    owner: "e2e-team",
    labels: [],
    default_tags: [],
    sections: [
      { title: "Назначение", required: true, hint: "зачем нужен документ", content: "" },
      { title: "Периодичность", required: true, hint: "как часто", content: "" },
    ],
    required_metadata: ["title", "owner"],
    optional_metadata: [],
    validation: [],
    instructions: "",
    ai_guidance: "",
    example: "",
    changes: "",
    breaking: false,
    migration: "",
    status: "active",
    ...extra,
  };
}

/** A template created and activated through the API (the setup of the «edit» scenario). */
async function activeTemplate(request: APIRequestContext): Promise<Created> {
  const n = suffix();
  const payload = spec(n);
  const created = await request.post("/api/templates/studio", { headers: HEADERS, data: { spec: payload } });
  expect(created.status()).toBe(201);
  const revision = (await created.json()).state.revision;
  const activated = await request.post(`/api/templates/${payload.template_id}/studio/activate`, {
    headers: HEADERS,
    data: { expected_revision: revision },
  });
  expect(activated.status()).toBe(200);
  return { id: payload.template_id, title: payload.title, prefix: payload.id_prefix };
}

/** The UI flow: «Создать шаблон» → properties (one validation error on the way) → sections → check → save. */
async function createInEditor(page: Page, n: string, mobile = false): Promise<Created> {
  const created = { id: `e2e_tpl_${n}`, title: `E2E шаблон ${n}`, prefix: `SEM-E${n}` };
  await page.goto("/templates");
  await page.getByRole("link", { name: "Создать шаблон" }).click();
  await expect(page).toHaveURL(/\/templates\/new$/);
  await page.getByLabel(/^Название\s*\*/).fill(created.title);
  await page.getByLabel(/^ID шаблона/).fill(created.id);
  await page.getByLabel(/^Тип документа/).selectOption("overview");
  await page.getByLabel(/^Категория/).fill("E2E");
  await page.getByLabel(/^Владелец шаблона/).fill("e2e-team");
  await page.getByRole("textbox", { name: "Описание", exact: true }).fill("Синтетический шаблон E2E.");
  // «Проверить» before the prefix is set: the error is shown next to the field
  await page.getByRole("button", { name: "Проверить" }).click();
  const prefix = page.getByLabel(/^Префикс ID документов/);
  await expect(prefix).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#tpl-id_prefix-issues")).toContainText("Префикс ID");
  await prefix.fill(created.prefix);

  await page.getByRole("tab", { name: /^Разделы/ }).click();
  await page.getByLabel("Подсказка автору").first().fill("зачем нужен документ");
  await page.getByRole("button", { name: "Добавить раздел" }).click();
  await page.getByLabel("Название раздела").nth(1).fill("Ссылки");
  await page.getByRole("button", { name: "Добавить раздел" }).click();
  await page.getByLabel("Название раздела").nth(2).fill("Периодичность");
  // keyboard reorder: Alt+↑ moves «Периодичность» above «Ссылки»
  await page.getByLabel("Название раздела").nth(2).press("Alt+ArrowUp");
  await expect(page.getByLabel("Название раздела").nth(1)).toHaveValue("Периодичность");
  await page.getByRole("checkbox", { name: "Обязательный" }).nth(2).uncheck();
  if (mobile) await noHorizontalScroll(page);

  await page.getByRole("tab", { name: /^Markdown/ }).click();
  await expect(page.getByLabel("Текст шаблона в Markdown")).toHaveValue(
    "## Назначение\n> Требует уточнения: зачем нужен документ\n\n## Периодичность\n> Требует уточнения\n\n## Ссылки\n> Требует уточнения\n",
  );
  await page.getByRole("tab", { name: /^Предпросмотр/ }).click();
  await expect(page.locator(".studio-preview__doc h2").first()).toHaveText("Назначение");
  await page.getByRole("button", { name: "Проверить" }).click();
  await expect(page.getByText("Проверка пройдена: ошибок нет.")).toBeVisible();
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page).toHaveURL(new RegExp(`/templates/${created.id}/edit$`));
  await expect(page.getByText(/Черновик шаблона сохранён/)).toBeVisible();
  return created;
}

async function activate(page: Page, label: string, expectText: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Активировать", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Активировать шаблон" });
  await expect(dialog).toContainText(expectText);
  await dialog.getByRole("button", { name: label }).click();
  await expect(dialog).toHaveCount(0);
}

async function offered(request: APIRequestContext, id: string): Promise<{ version: number } | undefined> {
  const templates = (await (await request.get("/api/authoring/templates", { headers: HEADERS })).json()) as { id: string; version: number }[];
  return templates.find((t) => t.id === id);
}

test("Template Studio: create → check → draft → activate → a document from the new template", async ({ page }) => {
  const created = await createInEditor(page, suffix());
  expect(await offered(page.request, created.id)).toBeUndefined(); // a draft is never offered to documents
  const row = page.getByText("ещё не активирован");
  await expect(row).toBeVisible();

  await activate(page, "Активировать v1", /станет действующим как v1/);
  await expect(page.getByText(/Действует v1\. Новые документы создаются по ней/)).toBeVisible();
  expect((await offered(page.request, created.id))?.version).toBe(1);

  // the catalogue shows it as active, made in the studio
  await page.goto("/templates");
  const tile = page.locator(`li[data-template='${created.id}']`);
  await expect(tile).toContainText("Активен");
  await expect(tile).toContainText("создан в студии");

  // the existing authoring flow: «Использовать шаблон» → editor → save a draft pinned to v1
  await tile.getByRole("link", { name: created.title }).click();
  await page.getByRole("link", { name: "Использовать шаблон" }).click();
  await page.getByRole("button", { name: "Открыть редактор" }).click();
  await expect(page.getByLabel(/^Текст в формате Markdown/)).toHaveValue(/## Периодичность/);
  await page.getByLabel(/^Название/).fill(`Документ по ${created.title}`);
  await page.getByLabel(/^Владелец/).fill("e2e-team");
  await page.getByLabel(/^Причина \/ цель документа/).fill("E2E: документ по новому шаблону");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page).toHaveURL(/draft=[0-9a-f]{32}/);
  const draftId = new URL(page.url()).searchParams.get("draft") ?? "";
  const draft = await (await page.request.get(`/api/drafts/${draftId}`, { headers: HEADERS })).json();
  expect(draft.template_id).toBe(created.id);
  expect(draft.template_version).toBe(1);
  expect(draft.document_id).toBe(`${created.prefix}-001`);
});

test("Template Studio: editing an existing template makes a new version; an existing draft keeps its own", async ({ page }) => {
  const created = await activeTemplate(page.request);
  const old = await page.request.post("/api/authoring/drafts", {
    headers: HEADERS,
    data: {
      template_id: created.id,
      metadata: { title: "Документ на v1", owner: "e2e", tags: [] },
      body: "# Документ на v1\n\n## Назначение\nТекст.\n\n## Периодичность\nРаз в сутки.\n",
      reason: "E2E: документ по v1",
    },
  });
  expect(old.status()).toBe(201);
  const oldDraft = await old.json();

  await page.goto(`/templates/${created.id}`);
  await page.getByRole("link", { name: "Редактировать" }).click();
  await expect(page).toHaveURL(new RegExp(`/templates/${created.id}/edit$`));
  await page.getByRole("tab", { name: /^Разделы/ }).click();
  await page.getByRole("button", { name: "Добавить раздел" }).click();
  await page.getByLabel("Название раздела").nth(2).fill("Мониторинг");
  await page.getByRole("tab", { name: /^Свойства/ }).click();
  await page.getByLabel(/^Что изменилось/).fill("v2: добавлен раздел «Мониторинг».");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByText(/Черновик сохранён\. Будет создана версия v2/)).toBeVisible();
  expect((await offered(page.request, created.id))?.version).toBe(1); // the draft changed nothing yet

  await activate(page, "Активировать v2", /Будет создана версия v2/);
  await expect(page.getByText(/Действует v2\./)).toBeVisible();
  expect((await offered(page.request, created.id))?.version).toBe(2);

  // history: who activated what, and the diff v1 → v2
  await page.getByRole("tab", { name: /^История/ }).click();
  const versions = page.getByRole("region", { name: "Версии" });
  await expect(versions).toContainText("v2");
  await expect(versions).toContainText("активировал local-demo-user");
  await page.getByLabel("Было").selectOption("1");
  await page.getByLabel("Стало").selectOption("2");
  await page.getByRole("button", { name: "Сравнить" }).click();
  await expect(page.locator(".compare__result")).toContainText("Мониторинг");

  // the existing draft is still pinned to v1 and is validated against it
  const after = await (await page.request.get(`/api/drafts/${oldDraft.id}`, { headers: HEADERS })).json();
  expect(after.template_version).toBe(1);
  expect(after.template_current_version).toBe(2);
  await page.goto(`/documents/new?draft=${oldDraft.id}`);
  await expect(page.getByText(/Черновик создан по шаблону v1; актуальная версия — v2/)).toBeVisible();
});

test("@mobile Template Studio on a phone: create, activate, no horizontal scroll", async ({ page }) => {
  const created = await createInEditor(page, suffix(), true);
  await noHorizontalScroll(page);
  await activate(page, "Активировать v1", /станет действующим как v1/);
  await expect(page.getByText(/Действует v1\./)).toBeVisible();
  await page.getByRole("tab", { name: /^История/ }).click();
  await noHorizontalScroll(page);
  await page.goto(`/templates/${created.id}`);
  await expect(page.getByRole("link", { name: "Редактировать" })).toBeVisible();
  await noHorizontalScroll(page);
});

test("@mobile the catalogue offers «Создать шаблон»; AI without a language model says why it is unavailable", async ({ page }) => {
  await page.goto("/templates");
  await expect(page.getByRole("link", { name: "Создать шаблон" })).toBeVisible();
  const ai = page.getByRole("button", { name: "Создать с помощью AI" });
  await expect(ai).toBeDisabled();
  await expect(page.getByText(/Без языковой модели структуру шаблона не предложить/)).toBeVisible();
  await noHorizontalScroll(page);
});

test("with AI disabled the catalogue still creates templates and offers no AI action", async ({ page }) => {
  test.skip(!DISABLED_URL, "E2E_DISABLED_URL is not set");
  await page.goto(`${DISABLED_URL}/templates`);
  await expect(page.getByRole("link", { name: "Создать шаблон" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Создать с помощью AI" })).toHaveCount(0);
});
