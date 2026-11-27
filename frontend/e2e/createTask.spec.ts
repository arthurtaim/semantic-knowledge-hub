import { expect, test, type APIRequestContext } from "@playwright/test";

/*
 * «Создать задачу» from the chat (docs/superpowers/specs/2026-11-27-chat-create-task-design.md) in the browser against
 * a stack whose backend talks to the SCRIPTED MODEL double — selected only when E2E_SCRIPTED_URL is set
 * («scripted» / «scripted-mobile» in playwright.config.ts). Passing here is NOT evidence about a real model.
 * Synthetic data only; every test makes its own project; every task is read back through the work API.
 *
 * - a phrase auto-starts the skill → a task-draft card → the project chosen in the card → «Создать задачу» creates
 *   exactly one task (nothing before the click);
 * - everything named in the phrase → the card is complete → one click; the due date and the assignee are kept;
 * - «Ответить как обычно» gives a plain answer to the same question;
 * - the task-plan skill keeps a due date named in the request (the review shows it);
 * - @mobile: the card fits a 375 px phone and «Создать задачу» is reachable.
 */

const HEADERS = { "X-SKH-Client": "e2e" };

type Task = { key: string; title: string; due_date: string | null; assignee_id: string | null };

async function call<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(path, { method, headers: HEADERS, data });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function createProject(request: APIRequestContext, prefix: string): Promise<string> {
  const key = `${prefix}${Date.now().toString(36).toUpperCase().slice(-6)}${Math.floor(Math.random() * 10)}`.slice(0, 10);
  await call(request, "POST", "/api/projects", { key, title: `E2E ${key} (синтетический)` });
  return key;
}

async function tasks(request: APIRequestContext, key: string): Promise<Task[]> {
  return (await call<{ items: Task[] }>(request, "GET", `/api/projects/${key}/tasks`)).items;
}

test.describe("«Создать задачу» in the chat (scripted model)", () => {
  test("a phrase starts the skill; the task appears only after «Создать задачу»", async ({ page }) => {
    const key = await createProject(page.request, "CTA");
    await page.goto("/ask");
    const field = page.getByRole("textbox", { name: "Вопрос" });
    await field.fill("создай задачу проверить загрузку справочника");
    await field.press("Enter");
    const card = page.locator("[data-task-draft='draft']");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByLabel("Название")).toHaveValue("Проверить загрузку справочника");
    await expect(card.getByText("Выберите проект", { exact: true })).toBeVisible();
    expect(await tasks(page.request, key)).toHaveLength(0);

    await card.getByLabel("Проект").selectOption(key);
    await card.getByRole("button", { name: "Создать задачу" }).click();
    const created = page.locator("[data-task-draft='created']");
    await expect(created).toContainText(`Задача ${key}-1 создана`);
    const list = await tasks(page.request, key);
    expect(list.map((t) => t.title)).toEqual(["Проверить загрузку справочника"]);
    await expect(created.getByRole("link", { name: "Открыть задачу" })).toHaveAttribute("href", `/projects/${key}?task=${key}-1`);
  });

  test("everything named in the phrase → one click keeps the due date and the assignee", async ({ page }) => {
    const key = await createProject(page.request, "CTB");
    await page.goto("/ask");
    const field = page.getByRole("textbox", { name: "Вопрос" });
    await field.fill(`создай задачу в проекте ${key} обновить витрину до 20 декабря на Лебедеву`);
    await field.press("Enter");
    const card = page.locator("[data-task-draft='draft']");
    await expect(card.getByLabel("Проект")).toHaveValue(key, { timeout: 20_000 });
    await expect(card.getByLabel("Срок")).toHaveValue(/-12-20$/);
    await card.getByRole("button", { name: "Создать задачу" }).click();
    await expect(page.locator("[data-task-draft='created']")).toBeVisible();
    const [only] = await tasks(page.request, key);
    expect(only?.title).toBe("Обновить витрину");
    expect(only?.due_date).toMatch(/-12-20$/);
    expect(only?.assignee_id).toBe("demo-analyst-1");
  });

  test("«Ответить как обычно» answers the same question without a card", async ({ page }) => {
    await page.goto("/ask");
    const field = page.getByRole("textbox", { name: "Вопрос" });
    await field.fill("создай задачу описать стандарт метаданных");
    await field.press("Enter");
    await expect(page.locator("[data-task-draft='draft']")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Ответить как обычно" }).click();
    await expect(page.locator(".turn")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator("[data-task-draft]")).toHaveCount(1); // the second turn is a plain answer
  });

  test("the task-plan skill keeps a due date named in the request", async ({ page }) => {
    const key = await createProject(page.request, "CTP");
    await page.goto("/ask");
    await page.getByRole("button", { name: "Навык", exact: true }).click();
    await page.getByRole("option", { name: /Составить план задач/ }).click();
    await page.getByLabel("Проект", { exact: true }).selectOption(key);
    const field = page.getByRole("textbox", { name: "Вопрос" });
    await field.fill("Подготовь задачи по маппингу полей ARIS до 20 декабря");
    await field.press("Enter");
    const card = page.locator("[data-work-kind='task_plan']").first();
    await expect(card).toHaveAttribute("data-work-state", "ready", { timeout: 20_000 });
    await card.getByRole("link", { name: "Проверить план" }).click();
    const review = page.getByRole("dialog", { name: "Предложение AI: план задач" });
    await expect(review.getByLabel("Срок").first()).toHaveValue(/-12-20$/);
  });

  test("@mobile the task-draft card fits 375 px and «Создать задачу» is reachable", async ({ page }) => {
    const key = await createProject(page.request, "CTM");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/ask");
    const field = page.getByRole("textbox", { name: "Вопрос" });
    await field.fill(`создай задачу в проекте ${key} проверить индекс`);
    await field.press("Enter");
    const card = page.locator("[data-task-draft='draft']");
    await expect(card).toBeVisible({ timeout: 20_000 });
    const button = card.getByRole("button", { name: "Создать задачу" });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await button.click();
    await expect(page.locator("[data-task-draft='created']")).toBeVisible();
    expect(await tasks(page.request, key)).toHaveLength(1);
  });
});
