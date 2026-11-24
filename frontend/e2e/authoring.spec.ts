import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * M4.6 authoring, E2E-13…E2E-22.
 * Untagged / @mobile: the offline demo stack (local workspace, mock AI) — drafts only, nothing reaches GitLab.
 * @gitlab: the integration_mock stack (loopback GitLab TEST DOUBLE) — branch, `create` commit, MR, merge, sync.
 */
const GITLAB = "http://127.0.0.1:8929";

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
}

async function openEditor(page: Page, template: RegExp, mode: "Вручную" | "С помощью AI" = "Вручную"): Promise<void> {
  // UI v2: the start page is the assistant (its «Черновик документа» skill drafts with AI); the manual
  // editor is the catalogue's «Создать документ» page.
  await page.goto("/documents/new");
  await page.getByRole("radio", { name: mode }).check({ force: true });
  await page.getByRole("radio", { name: template }).check({ force: true });
  await page.getByRole("button", { name: mode === "Вручную" ? "Открыть редактор" : "Далее: запрос помощнику" }).click();
}

async function fillRequired(page: Page, title: string, id?: string): Promise<void> {
  await page.getByLabel(/^Название/).fill(title);
  if (id) {
    // M5.6.3: the server allocates the ID; a known ID is an explicit opt-in under «Дополнительно».
    await page.getByText("Дополнительно", { exact: true }).click();
    await page.getByLabel(/Задать ID вручную/).check();
    await page.getByLabel(/^ID документа/).fill(id);
  }
  await page.getByLabel(/^Владелец/).fill("semantic-team");
  await page.getByLabel(/^Причина \/ цель документа/).fill(`E2E: ${title}`);
}

async function saveDraft(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page).toHaveURL(/draft=[0-9a-f]{32}/);
  await expect(page.getByText(/Черновик сохранён в/)).toBeVisible();
}

test("E2E-13/14/15 manual document from a template: structure, persistent draft, reload", async ({ page }) => {
  await openEditor(page, /Архитектура/);
  const body = page.getByLabel(/^Текст в формате Markdown/);
  for (const section of ["Назначение", "Контекст", "Компоненты", "Взаимодействия", "Зависимости", "Ограничения", "Решения", "Связанные документы"]) {
    await expect(body).toContainText(`## ${section}`);
  }
  await fillRequired(page, "Контур E2E-13");
  await expect(page.getByText("Черновик ещё не сохранён").first()).toBeVisible();
  await saveDraft(page);
  await body.fill((await body.inputValue()) + "\nАбзац, добавленный в E2E-13.\n");
  await expect(page.getByText("Есть несохранённые изменения").first()).toBeVisible();
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByText(/Черновик сохранён в/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/^Текст в формате Markdown/)).toHaveValue(/Абзац, добавленный в E2E-13\./);
  await expect(page.getByLabel(/^Название/)).toHaveValue("Контур E2E-13");
  // a draft is not knowledge: the catalog does not know it
  const id = await page.getByLabel(/^ID документа/).inputValue();
  expect((await page.request.get(`/api/documents/${id}`)).status()).toBe(404);
});

test("E2E-16 duplicate ID is blocked and the text is kept", async ({ page }) => {
  await openEditor(page, /Архитектура/);
  await fillRequired(page, "Дубликат E2E-16", "SEM-ARCH-001");
  const body = page.getByLabel(/^Текст в формате Markdown/);
  await body.fill((await body.inputValue()) + "\nТекст, который нельзя потерять (E2E-16).\n");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByText(/SEM-ARCH-001 уже есть в базе знаний/).first()).toBeVisible();
  await expect(body).toHaveValue(/Текст, который нельзя потерять \(E2E-16\)\./);
  await expect(page).not.toHaveURL(/draft=/);
});

test("E2E-17 draft → «Готово к ревью»; the new-file diff adds everything", async ({ page }) => {
  await openEditor(page, /Процесс команды/);
  await fillRequired(page, "Процесс E2E-17");
  await saveDraft(page);
  await page.getByRole("button", { name: "Отправить на ревью" }).click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f]{32}$/);
  await expect(page.getByText("Новый документ").first()).toBeVisible();
  await expect(page.getByText(/Готово к ревью/).first()).toBeVisible();
  const diff = page.getByRole("table", { name: "Содержимое нового файла" });
  await expect(diff).toContainText("## Назначение");
  await expect(diff.locator("tr.diff__row--remove, .diff__line--remove")).toHaveCount(0);
});

test("E2E-21 demo AI quotes approved sources and admits missing data", async ({ page }) => {
  await openEditor(page, /Архитектурное решение/, "С помощью AI");
  await page.getByLabel(/^Название/).fill("Решение о хранении базы знаний");
  await page.getByLabel(/^Что должно быть в документе/).fill("Опиши решение о хранении канонической базы знаний в GitLab");
  await page.getByRole("button", { name: "Подготовить черновик" }).click();
  const panel = page.getByRole("region", { name: "Источники и выдержки" }).or(page.locator("section", { hasText: "Источники и выдержки" })).first();
  await expect(panel).toContainText(/Демо-режим/);
  await expect(panel).toContainText("Подтверждённые выдержки");
  await expect(page.getByLabel(/^Текст в формате Markdown/)).toHaveValue(/Требует уточнения/);
  // status is read-only (a new document is a draft); the origin is recorded by the server
  await expect(page.locator(".field", { hasText: "Происхождение" })).toContainText("предложение ИИ");
  await expect(page.locator(".field", { hasText: /^Статус/ })).toContainText("Черновик");

  await openEditor(page, /Интеграция/, "С помощью AI");
  await page.getByLabel(/^Название/).fill("Квазизвёздный шлюз");
  await page.getByLabel(/^Что должно быть в документе/).fill("Опиши квазизвёздный шлюз");
  await page.getByRole("button", { name: "Подготовить черновик" }).click();
  await expect(page.getByText("Недостаточно данных").first()).toBeVisible();
});

test("@mobile E2E-22 the editor is usable on a phone", async ({ page }) => {
  await openEditor(page, /Бизнес-сущность/);
  await fillRequired(page, "Сущность E2E-22");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Просмотр" }).click();
  await expect(page.locator(".markdown, .preview, [class*=preview]").first()).toContainText("Определение");
  await page.getByRole("button", { name: "Текст" }).click();
  await expect(page.getByLabel(/^Текст в формате Markdown/)).toBeVisible();
  await saveDraft(page);
});

async function gitlabState(request: APIRequestContext): Promise<{ merge_requests: unknown[]; protected_write_attempts: number }> {
  return (await request.get(`${GITLAB}/__mock__/state`)).json();
}

test("@gitlab E2E-18/19/20 new document → branch + create commit → one MR → merge → in the knowledge base", async ({ page, request }) => {
  await request.post(`${GITLAB}/__mock__/reset`);
  const id = uniqueId("SEM-E2E");
  const marker = `Маркер${id.replace(/-/g, "")}`;
  await openEditor(page, /Архитектура/);
  await fillRequired(page, `Документ ${id}`, id);
  const body = page.getByLabel(/^Текст в формате Markdown/);
  await body.fill((await body.inputValue()) + `\n${marker}\n`);
  await saveDraft(page);
  await page.getByRole("button", { name: "Отправить на ревью" }).click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f]{32}$/);
  const proposalUrl = page.url();
  const proposalId = proposalUrl.split("/").pop() ?? "";

  await page.getByRole("button", { name: "Отправить в GitLab" }).click();
  await expect(page.getByRole("link", { name: "Открыть Merge Request в GitLab" })).toBeVisible();
  let state = await gitlabState(request);
  expect(state.merge_requests).toHaveLength(1);
  // E2E-19: a repeated submission is refused and creates no second MR
  const again = await page.request.post(`/api/drafts/${proposalId}/submit`, { headers: { "X-SKH-Client": "e2e" } });
  expect(again.status()).toBe(409);
  state = await gitlabState(request);
  expect(state.merge_requests).toHaveLength(1);
  expect(state.protected_write_attempts).toBe(0);

  // E2E-20: not in the knowledge base before the merge…
  expect((await page.request.get(`/api/documents/${id}`)).status()).toBe(404);
  const iid = (state.merge_requests[0] as { iid: number }).iid;
  await request.post(`${GITLAB}/__mock__/merge-requests/${iid}/merge`);
  await page.getByRole("button", { name: "Проверить статус в GitLab" }).click();
  await expect(page.getByText("GitLab подтвердил merge.")).toBeVisible();
  await expect(page.getByText(/Синхронизировано с базой знаний/)).toBeVisible();
  // …and searchable after the confirmed merge + sync
  await page.goto(`/documents?query=${encodeURIComponent(marker)}`);
  await expect(page.locator(".docs-row").first()).toContainText(id); // «Документы» v2: a row of «Список»
  await page.goto(`/documents/${id}`);
  await expect(page.locator(".doc-props")).toContainText("GitLab"); // UI v2: «Источник» in the properties
});
