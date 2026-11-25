import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * «Пустой документ» and «Применить шаблон» on the offline demo stack (synthetic fixtures, mock AI): a document
 * without a template — free Markdown with a `[[` link, saved and sent to review — and a template applied later after a
 * diff preview. Drafts and proposals only: nothing here becomes approved knowledge. With E2E_DISABLED_URL
 * (AI_PROVIDER=disabled) the blank editor stays complete without the AI panel.
 */
const HEADERS = { "X-SKH-Client": "e2e" };
const DISABLED_URL = process.env.E2E_DISABLED_URL;

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
}

async function draftJson(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/drafts/${id}`, { headers: HEADERS });
  expect(response.ok()).toBe(true);
  return response.json();
}

function draftIdFrom(page: Page): string {
  return new URL(page.url()).searchParams.get("draft") ?? "";
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** «Пустой документ»: a title and a section — and straight into the editor. */
async function startBlank(page: Page, title: string, base = ""): Promise<void> {
  await page.goto(`${base}/documents/new`);
  await expect(page.getByRole("heading", { level: 2, name: "Пустой документ" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "По шаблону" })).toBeVisible();
  await page.getByLabel(/^Название/).fill(title);
  const section = page.getByLabel("Раздел каталога");
  await expect(section).toHaveValue("guide");
  await section.selectOption("process");
  await page.getByRole("button", { name: "Начать писать" }).click();
  await expect(page.getByLabel(/^Текст в формате Markdown/)).toHaveValue(`# ${title}\n\n`);
  await expect(page.getByLabel("Раздел каталога")).toHaveValue("process");
}

/** Free Markdown with a `[[` link chosen from the autocomplete. */
async function writeWithLink(page: Page): Promise<void> {
  const body = page.getByLabel(/^Текст в формате Markdown/);
  await body.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type("Свободный текст без шаблона: что известно о сверке.\n\n## Контекст\nСм. [[DEMO-SRC-00");
  const listbox = page.getByRole("listbox", { name: "Документы для ссылки" });
  await expect(listbox.getByRole("option").first()).toContainText("DEMO-SRC-001");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(listbox).toHaveCount(0);
  expect(await body.inputValue()).toMatch(/См\. \[\[DEMO-SRC-001\|[^\]]+\]\]$/);
  // the server-side check renders it as a resolved link
  await expect(page.locator(".authoring__prose a.wikilink[href='/documents/DEMO-SRC-001']")).toBeAttached();
}

async function save(page: Page, reason: string): Promise<void> {
  await page.getByLabel(/^Причина \/ цель документа/).fill(reason);
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page).toHaveURL(/draft=[0-9a-f]{32}/);
  await expect(page.getByText(/Черновик сохранён в/)).toBeVisible();
}

async function applyArchitecture(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Применить шаблон", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Применить шаблон" });
  await expect(panel.getByText(/Весь текст сохраняется/)).toBeVisible();
  await panel.getByRole("combobox", { name: "Шаблон" }).selectOption("architecture");
  await expect(panel.getByRole("heading", { name: "Что изменится" })).toBeVisible();
  await expect(panel.getByText("Раздел каталога: «Процессы» → «Архитектура».")).toBeVisible();
  await expect(panel.locator(".apply-template__section--matched")).toContainText("Контекст");
  await expect(panel.locator(".apply-template__section--added").first()).toContainText("Назначение");
  await expect(panel.getByRole("table", { name: "Изменения после применения шаблона" })).toContainText("## Компоненты");
  await panel.getByRole("button", { name: "Применить шаблон", exact: true }).click();
  await expect(page.getByText(/Шаблон применён и закреплён/)).toBeVisible();
  await expect(panel).toHaveCount(0);
}

test("B-01 blank document: free Markdown with a [[ link → save → submit for review", async ({ page }) => {
  const title = unique("Заметки B-01");
  await startBlank(page, title);
  await expect(page.locator(".field", { has: page.getByText("Происхождение", { exact: true }) })).toContainText("без шаблона");
  await writeWithLink(page);
  await save(page, "E2E B-01");

  const draft = await draftJson(page.request, draftIdFrom(page));
  expect(draft.template_id).toBeNull();
  expect(draft.document_id).toMatch(/^SEM-DOC-\d{3,}$/);
  expect(draft.new_document.metadata).toMatchObject({ status: "draft", type: "process" });
  expect(draft.new_document.metadata.template).toBeUndefined();
  await expect(page.getByLabel(/^ID документа/)).toHaveValue(draft.document_id);

  await page.getByRole("button", { name: "Отправить на ревью" }).click();
  await expect(page).toHaveURL(new RegExp(`/proposals/${draft.id}$`));
  expect((await draftJson(page.request, draft.id)).status).toBe("ready_for_review");
  expect((await page.request.get(`/api/documents/${draft.document_id}`)).status()).toBe(404); // not knowledge yet
});

test("B-02 apply a template to a blank draft: diff → confirm → the text is kept, the template pinned", async ({ page }) => {
  const title = unique("Сверка B-02");
  await startBlank(page, title);
  await writeWithLink(page);
  await save(page, "E2E B-02");
  const id = draftIdFrom(page);
  await applyArchitecture(page);

  const draft = await draftJson(page.request, id);
  expect(draft.template_id).toBe("architecture");
  expect(draft.new_document.metadata).toMatchObject({ template: "architecture", type: "architecture" });
  expect(draft.new_document.body).toContain("Свободный текст без шаблона");
  expect(draft.new_document.body).toMatch(/\[\[DEMO-SRC-001\|[^\]]+\]\]/);
  expect(draft.new_document.body).toContain("## Компоненты\n> Требует уточнения");
  // the editor reopened with the pinned template
  await expect(page.locator(".field", { has: page.getByText("Раздел каталога", { exact: true }) })).toContainText(
    "шаблон «Архитектура»",
  );
  await page.getByRole("button", { name: "Отправить на ревью" }).click();
  await expect(page).toHaveURL(new RegExp(`/proposals/${id}$`));
});

test("B-03 «Применить шаблон» on an approved document creates a change proposal; the document stays", async ({ page }) => {
  const before = await (await page.request.get("/api/documents/SEM-ARCH-001", { headers: HEADERS })).json();
  await page.goto("/documents/SEM-ARCH-001");
  await page.getByRole("button", { name: "Ещё" }).click();
  await page.getByRole("menuitem", { name: /Применить шаблон/ }).click();
  const panel = page.getByRole("dialog", { name: "Применить шаблон" });
  await expect(panel.getByText(/Документ не изменится: будет создано предложение изменения/)).toBeVisible();
  await panel.getByRole("combobox", { name: "Шаблон" }).selectOption("architecture");
  await expect(panel.getByText("Раздел каталога не меняется: «Архитектура».")).toBeVisible();
  await panel.getByRole("button", { name: "Создать предложение изменения" }).click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f]{32}$/);
  const proposal = await draftJson(page.request, page.url().split("/").pop() ?? "");
  expect(proposal).toMatchObject({ operation: "update", status: "draft", base_revision: before.revision });
  const after = await (await page.request.get("/api/documents/SEM-ARCH-001", { headers: HEADERS })).json();
  expect(after.revision).toBe(before.revision);
  expect(after.raw).toBe(before.raw);
});

test("@mobile B-04 on a phone: blank document → [[ link → save → apply a template → submit", async ({ page }) => {
  const title = unique("Телефон B-04");
  await startBlank(page, title);
  await noHorizontalScroll(page);
  await writeWithLink(page);
  await save(page, "E2E B-04");
  await noHorizontalScroll(page);
  await applyArchitecture(page);
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Отправить на ревью" }).click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f]{32}$/);
});

test("B-07 unsaved edits: the sidebar, Back and a reload ask first; «Остаться» keeps the text (SYS-007)", async ({ page }) => {
  // Reached through in-app links, so Back has an in-app page to go to.
  await page.goto("/documents");
  await page.getByRole("link", { name: "Создать документ" }).click();
  await expect(page).toHaveURL(/\/documents\/new$/);
  await page.getByLabel(/^Название/).fill(unique("Уход B-07"));
  await page.getByRole("button", { name: "Начать писать" }).click();
  const body = page.getByLabel(/^Текст в формате Markdown/);
  await expect(body).toBeVisible();
  await save(page, "E2E B-07");
  const draftUrl = page.url();
  const id = draftIdFrom(page);
  const sidebar = page.getByRole("navigation", { name: "Основная навигация" });
  const projects = sidebar.getByRole("link", { name: "Проекты", exact: true });
  const confirm = page.getByRole("alertdialog", { name: "Есть несохранённые изменения" });

  // Saved: leaving does not ask.
  await projects.click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(confirm).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(draftUrl);
  await expect(page.getByText(/Черновик сохранён в/)).toBeVisible();

  const added = "Новый абзац, который ещё не сохранён.";
  await body.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type(`\n${added}`);
  await expect(page.getByText("Есть несохранённые изменения", { exact: true })).toBeVisible();

  // The sidebar: the dialog, focus on «Остаться»; staying keeps the URL and the text.
  await projects.click();
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Остаться" })).toBeFocused();
  await confirm.getByRole("button", { name: "Остаться" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page).toHaveURL(draftUrl);
  await expect(body).toHaveValue(new RegExp(`${added}$`));

  // The browser's Back: the same dialog; Esc stays and the address returns to the draft.
  await page.goBack();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(page).toHaveURL(draftUrl);
  await expect(body).toHaveValue(new RegExp(`${added}$`));

  // A reload: the browser's own beforeunload dialog; dismissing it keeps the page.
  const dialogs: string[] = [];
  page.once("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.evaluate(() => window.location.reload());
  await expect.poll(() => dialogs).toEqual(["beforeunload"]);
  await expect(body).toHaveValue(new RegExp(`${added}$`));

  // «Выйти без сохранения»: leaves, and the stored draft never got the paragraph.
  await projects.click();
  await confirm.getByRole("button", { name: "Выйти без сохранения" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(confirm).toHaveCount(0);
  expect((await draftJson(page.request, id)).new_document.body).not.toContain(added);
});

for (const [name, tag] of [["B-05", ""], ["B-06", "@mobile "]] as const) {
  test(`${tag}${name} AI_PROVIDER=disabled: the blank editor has no AI panel and still saves`, async ({ page }) => {
    test.skip(!DISABLED_URL, "E2E_DISABLED_URL (a stack with AI_PROVIDER=disabled) is not set");
    await startBlank(page, unique(`Без ИИ ${name}`), DISABLED_URL);
    await expect(page.getByRole("region", { name: "ИИ-помощник по черновику" })).toHaveCount(0);
    await page.getByLabel(/^Причина \/ цель документа/).fill(`E2E ${name}`);
    await page.getByRole("button", { name: "Сохранить черновик" }).click();
    await expect(page).toHaveURL(/draft=[0-9a-f]{32}/);
    await expect(page.getByRole("button", { name: "Применить шаблон" })).toBeEnabled();
  });
}
