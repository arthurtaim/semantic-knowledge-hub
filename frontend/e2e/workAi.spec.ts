import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * M6 Step 5 in the browser against a stack whose backend talks to the SCRIPTED MODEL double
 * (backend/tests/support/scripted_model.py) — selected only when E2E_SCRIPTED_URL is set (playwright.config.ts,
 * «scripted» / «scripted-mobile»). The double stands in for a model; passing here is NOT evidence about a real model.
 * Synthetic data only; every test makes its own project.
 *
 * - «План с ассистентом» (was «AI план») → typed proposal → review → nothing exists before «Создать задачи» (M6-13) → apply creates the reviewed
 *   tasks, dependencies and links in one go (M6-14); «Отклонить» creates nothing (M6-15);
 * - the chat answers about overdue tasks from `work_inspect` facts (M6-39) with links to the tasks;
 * - @mobile: the review fits a phone without sideways scrolling.
 */

const HEADERS = { "X-SKH-Client": "e2e" };

async function call<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(path, { method, headers: HEADERS, data });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

function uniqueKey(prefix: string): string {
  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-6)}${Math.floor(Math.random() * 10)}`.slice(0, 10);
}

async function createProject(request: APIRequestContext, prefix: string): Promise<string> {
  const key = uniqueKey(prefix);
  await call(request, "POST", "/api/projects", { key, title: `E2E ${key} (синтетический)` });
  return key;
}

async function nextMonday(request: APIRequestContext, key: string): Promise<string> {
  const { today } = await call<{ today: string }>(request, "GET", `/api/projects/${key}/gantt`);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (((8 - date.getUTCDay()) % 7) || 7));
  return date.toISOString().slice(0, 10);
}

async function taskCount(request: APIRequestContext, key: string): Promise<number> {
  return (await call<{ total: number }>(request, "GET", `/api/projects/${key}/tasks`)).total;
}

async function requestPlan(page: Page, key: string, start: string | null) {
  await page.goto(`/projects/${key}?view=list`);
  await page.getByRole("button", { name: "План с ассистентом" }).click();
  const sheet = page.getByRole("dialog", { name: "План с ассистентом" });
  await sheet.getByLabel(/Что нужно сделать/).fill("Подготовь задачи по маппингу полей ARIS");
  await sheet.getByLabel("Документы-источники").fill("DEMO-INT-002");
  await sheet.getByRole("button", { name: /DEMO-INT-002/ }).click();
  if (start) await sheet.getByLabel("Плановое начало").fill(start);
  await sheet.getByRole("button", { name: "Подготовить предложение" }).click();
  const review = page.getByRole("dialog", { name: "Предложение AI: план задач" });
  await expect(review.getByText(/Ничего не создано, пока вы не нажмёте «Создать задачи»/)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/proposal=WAP-/);
  return review;
}

test.describe("M6 «AI план» (scripted model)", () => {
  test("M6-13/M6-14 review → nothing before «Создать задачи» → the reviewed tasks, dependencies and links exist", async ({ page }) => {
    const key = await createProject(page.request, "AIP");
    const start = await nextMonday(page.request, key);
    const review = await requestPlan(page, key, start);
    await expect(review.getByRole("link", { name: /DEMO-INT-002/ }).first()).toBeVisible();
    await expect(review.locator(".plan-task")).toHaveCount(5);
    await expect(review.locator("[data-issue]").first()).toBeVisible();
    expect(await taskCount(page.request, key)).toBe(0); // M6-13: a proposal writes nothing
    // the person drops the milestone and renames the first task
    await review.getByRole("checkbox", { name: "Создать задачу «Готово к приёмке»" }).uncheck();
    const title = review.getByRole("textbox", { name: /^Название «Разобрать требования/ });
    await title.fill("Разобрать маппинг полей (проверено)");
    await review.getByRole("button", { name: "Создать задачи (4)" }).click();
    await expect(page.getByText(/создано задач по предложению AI — 4/)).toBeVisible();
    await expect(page).not.toHaveURL(/proposal=/);
    const tasks = await call<{ items: { key: string; title: string; start_date: string | null; link_count: number | null }[] }>(
      page.request,
      "GET",
      `/api/projects/${key}/tasks`,
    );
    expect(tasks.items.map((t) => t.title)).toContain("Разобрать маппинг полей (проверено)");
    expect(tasks.items.map((t) => t.title)).not.toContain("Готово к приёмке");
    const first = tasks.items.find((t) => t.title === "Разобрать маппинг полей (проверено)");
    expect(first?.start_date).toBe(start);
    expect(first?.link_count).toBe(1);
    await page.getByRole("button", { name: "Гант", exact: true }).click();
    await expect(page.locator(`g.gantt-bar[data-task-key="${first?.key}"]`)).toBeVisible();
  });

  test("M6-15 «Отклонить» creates nothing", async ({ page }) => {
    const key = await createProject(page.request, "AIR");
    const review = await requestPlan(page, key, null);
    await review.getByRole("button", { name: "Отклонить" }).click();
    await expect(review.getByText("Предложение отклонено: задачи не создавались.")).toBeVisible();
    expect(await taskCount(page.request, key)).toBe(0);
  });

  test("M6-39 the chat answers about overdue tasks only from work facts, with links to the tasks", async ({ page }) => {
    const overdue = await call<{ items: { key: string }[]; total: number }>(page.request, "GET", "/api/projects/RAG/tasks?overdue=true");
    await page.goto("/");
    const field = page.getByRole("textbox", { name: "Вопрос" });
    await field.fill("Какие задачи RAG просрочены?");
    await field.press("Enter");
    const facts = page.getByRole("region", { name: "Данные системы SKH" }).first();
    const card = facts.getByRole("listitem").first();
    await expect(card).toContainText("По данным модуля «Работа» SKH");
    await expect(card).toContainText("проект RAG");
    for (const item of overdue.items) {
      const row = facts.locator(".fact-item").filter({ has: page.locator(".fact-item__id", { hasText: new RegExp(`^${item.key}$`) }) });
      await expect(row.getByRole("link").first()).toHaveAttribute("href", `/tasks/${item.key}`);
      await expect(row).toContainText(/В работе|К работе|На проверке/); // a task status in words, not a document status
    }
    await expect(page.locator(".answer__text").first()).toContainText(String(overdue.total));
  });
});

test.describe("M6 «AI план» on a phone (scripted model)", () => {
  test("@mobile the review fits 390 px without sideways scrolling", async ({ page }) => {
    const key = await createProject(page.request, "AIM");
    await page.setViewportSize({ width: 390, height: 844 });
    const review = await requestPlan(page, key, await nextMonday(page.request, key));
    await expect(review.locator(".plan-task").first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const width = window.innerWidth;
      return Array.from(document.querySelectorAll(".work-plan *"))
        .filter((el) => el.getBoundingClientRect().right > width + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(" ")[0]}`)
        .slice(0, 5);
    });
    expect(overflow).toEqual([]);
  });
});
