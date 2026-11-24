import { expect, test, type Page } from "@playwright/test";

/*
 * «Создать с помощью AI» in Template Studio against the SCRIPTED MODEL double (backend/tests/support/scripted_model.py,
 * AI_PROVIDER=internal_api): runs only in the "scripted" projects (E2E_SCRIPTED_URL). The double answers the
 * model-agnostic template protocol with a deterministic proposal; it is not evidence about a real model.
 * The AI only proposes: the person edits the proposal, saves it as a draft and activates it as separate steps.
 */
const HEADERS = { "X-SKH-Client": "e2e" };
const PROMPT =
  "Создай шаблон для описания интеграции между системами: источники, датасеты, метаданные, маппинг, ограничения и периодичность обмена";

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function propose(page: Page): Promise<void> {
  await page.goto("/templates");
  await page.getByRole("button", { name: "Создать с помощью AI" }).click();
  const panel = page.getByRole("dialog", { name: "Создать шаблон с помощью ИИ" });
  await panel.getByLabel(/^Какой шаблон нужен/).fill(PROMPT);
  await panel.getByRole("button", { name: "Предложить шаблон" }).click();
  await expect(panel.getByRole("list", { name: "Предложенные разделы" })).toContainText("Периодичность обмена");
  await expect(panel).toContainText("Похоже на существующий шаблон «Интеграция» (integration)");
  await expect(panel).toContainText("Префикс ID «SEM-INT» занят");
}

test("AI proposes a template → the person edits it → saves a draft → activates it", async ({ page }) => {
  const before = (await (await page.request.get("/api/templates", { headers: HEADERS })).json()).length;
  await propose(page);
  expect((await (await page.request.get("/api/templates", { headers: HEADERS })).json()).length).toBe(before); // nothing yet
  await page.getByRole("dialog").getByRole("button", { name: "Открыть в редакторе" }).click();
  await expect(page).toHaveURL(/\/templates\/new\?proposal=AIP-[0-9a-f]{16}$/);
  await expect(page.getByText(/Предложение ИИ\./)).toBeVisible();

  const title = page.getByLabel(/^Название\s*\*/);
  await expect(title).toHaveValue("Обмен данными между системами");
  const edited = `Обмен данными (проверено ${Date.now().toString().slice(-6)})`;
  await title.fill(edited);
  const templateId = await page.getByLabel(/^ID шаблона/).inputValue();
  await page.getByRole("tab", { name: /^Разделы/ }).click();
  await page.getByRole("checkbox", { name: "Обязательный" }).nth(3).uncheck(); // «Метаданные» → optional
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page).toHaveURL(new RegExp(`/templates/${templateId}/edit$`));
  const state = await (await page.request.get(`/api/templates/${templateId}/studio`, { headers: HEADERS })).json();
  expect(state.ai_proposal_id).toMatch(/^AIP-/);
  expect(state.draft.spec.title).toBe(edited);
  expect(state.current_version).toBeNull(); // activation is a separate human step
  const proposal = await (await page.request.get(`/api/ai/proposals/${state.ai_proposal_id}`, { headers: HEADERS })).json();
  expect(proposal.status).toBe("applied");
  expect(proposal.result_template_id).toBe(templateId);

  await page.getByRole("button", { name: "Активировать", exact: true }).click();
  await page.getByRole("dialog", { name: "Активировать шаблон" }).getByRole("button", { name: "Активировать v1" }).click();
  await expect(page.getByText(/Действует v1\./)).toBeVisible();
  const offered = (await (await page.request.get("/api/authoring/templates", { headers: HEADERS })).json()) as { id: string; sections: string[] }[];
  const template = offered.find((t) => t.id === templateId);
  expect(template?.sections).toContain("Периодичность обмена");
  expect(template?.sections).not.toContain("Метаданные"); // the person's edit, not the AI's original
});

test("@mobile the AI proposal on a phone: rejecting it creates nothing", async ({ page }) => {
  await propose(page);
  await noHorizontalScroll(page);
  await page.getByRole("dialog").getByRole("button", { name: "Отклонить" }).click();
  await expect(page.getByText("Предложение отклонено — ничего не создано.")).toBeVisible();
});
