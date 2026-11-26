import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/*
 * M7 chat work skills (docs/WORK_CHAT_SKILLS.md) in the browser against a stack whose backend talks to the SCRIPTED
 * MODEL double (backend/tests/support/scripted_model.py) — selected only when E2E_SCRIPTED_URL is set
 * (playwright.config.ts, «scripted» / «scripted-mobile»). The double stands in for a model; passing here is NOT
 * evidence about a real model. Synthetic data only; every test makes its own project (the demo project ARIS is read).
 * Every mutation is read back through the work API (an independent oracle), never trusted from the UI.
 *
 * - STORY-01/02: the plan skill → a WAP card, no task before the review; «Уточнить» → a NEW proposal (the old one
 *   unchanged) → the project review → «Создать задачи» creates exactly the reviewed tasks;
 * - STORY-04: the change skill → a WCP card → the change review → one operation unchecked → «Применить изменения»
 *   applies only the kept one;
 * - STORY-03: the analysis skill answers with `skh_work` facts;
 * - STORY-07: a reload restores the cards from the history (re-read, typed work proposals); @mobile: the change review
 *   fits a phone and its confirmation button is reachable.
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

async function createProject(request: APIRequestContext, prefix: string, tasks: string[] = []): Promise<string> {
  const key = uniqueKey(prefix);
  await call(request, "POST", "/api/projects", { key, title: `E2E ${key} (синтетический)` });
  for (const title of tasks) await call(request, "POST", `/api/projects/${key}/tasks`, { title });
  return key;
}

async function taskCount(request: APIRequestContext, key: string): Promise<number> {
  return (await call<{ total: number }>(request, "GET", `/api/projects/${key}/tasks`)).total;
}

/** /ask, a work skill from the «Навык» list, the project chosen in the work row. */
async function startWorkSkill(page: Page, skill: string, project: string): Promise<Locator> {
  await page.goto("/ask");
  await page.getByRole("button", { name: "Навык", exact: true }).click();
  await page.getByRole("option", { name: new RegExp(skill) }).click();
  const select = page.getByLabel("Проект", { exact: true });
  await expect(select).toHaveValue(""); // never preselected
  await select.selectOption(project);
  return page.getByRole("textbox", { name: "Вопрос" });
}

test.describe("M7 chat work skills (scripted model)", () => {
  test("STORY-01/02 a plan from the chat is a proposal; a refinement is a new one; tasks appear only after «Создать задачи»", async ({ page }) => {
    const key = await createProject(page.request, "CHP");
    const field = await startWorkSkill(page, "Составить план задач", key);
    await field.fill("Подготовь задачи по маппингу полей ARIS");
    await field.press("Enter");
    const first = page.locator("[data-work-kind='task_plan']").first();
    await expect(first).toHaveAttribute("data-work-state", "ready", { timeout: 20_000 });
    await expect(first).toContainText(`План задач для ${key}`);
    const oldId = (await first.getAttribute("data-work-proposal")) ?? "";
    expect(oldId).toMatch(/^WAP-[0-9a-f]{16}$/);
    expect(await taskCount(page.request, key)).toBe(0); // STORY-01: nothing before the review

    await first.getByRole("button", { name: "Уточнить" }).click();
    await expect(page.getByText(`Уточняю ${oldId}`)).toBeVisible();
    await field.fill("Разбей первую задачу на три подзадачи");
    await field.press("Enter");
    const second = page.locator("[data-work-kind='task_plan']").nth(1);
    await expect(second).toContainText(`уточняет ${oldId}`, { timeout: 20_000 });
    const newId = (await second.getAttribute("data-work-proposal")) ?? "";
    expect(newId).not.toBe(oldId);
    const old = await call<{ status: string; tasks: unknown[] }>(page.request, "GET", `/api/work-ai/proposals/${oldId}`);
    expect(old.status).toBe("suggested"); // the refined proposal is unchanged
    const fresh = await call<{ tasks: { local_id: string; parent_local_id: string | null }[] }>(
      page.request,
      "GET",
      `/api/work-ai/proposals/${newId}`,
    );
    const firstLocal = fresh.tasks[0]?.local_id;
    expect(fresh.tasks.filter((t) => t.parent_local_id === firstLocal)).toHaveLength(3);
    expect(await taskCount(page.request, key)).toBe(0);

    await second.getByRole("link", { name: "Проверить план" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}\\?proposal=${newId}`));
    const review = page.getByRole("dialog", { name: "Предложение AI: план задач" });
    await expect(review.getByText(`Уточнение предложения`)).toBeVisible();
    const create = review.getByRole("button", { name: /^Создать задачи \(\d+\)$/ });
    const n = Number((await create.textContent())?.match(/\((\d+)\)/)?.[1]);
    await create.click();
    await expect(page.getByText(/создано задач по предложению AI/)).toBeVisible();
    expect(await taskCount(page.request, key)).toBe(n);
  });

  test("STORY-04 a change-set from the chat applies only the operations a person kept, in one go", async ({ page }) => {
    const key = await createProject(page.request, "CHC", ["Первая задача", "Вторая задача"]);
    const field = await startWorkSkill(page, "Предложить изменения задач", key);
    await page.getByLabel("Задачи", { exact: true }).fill(`${key}-1, ${key}-2`);
    await field.fill(`${key}-1 на ревью, ${key}-2 высокий приоритет`);
    await field.press("Enter");
    const card = page.locator("[data-work-kind='task_changes']").first();
    await expect(card).toHaveAttribute("data-work-state", "ready", { timeout: 20_000 });
    await expect(card).toContainText("изменений 2");
    const before = await call<{ status: string; priority: string; version: number }>(page.request, "GET", `/api/tasks/${key}-1`);
    expect(before.status).toBe("todo"); // nothing changed before the review

    await card.getByRole("link", { name: "Проверить изменения" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}\\?changes=WCP-`));
    const review = page.getByRole("dialog", { name: "Предложение AI: изменения задач" });
    await expect(review.locator(".work-change")).toHaveCount(2);
    await review.getByRole("checkbox", { name: `Применить: ${key}-2, Приоритет` }).uncheck();
    await review.getByRole("button", { name: "Применить изменения (1)" }).click();
    await expect(review.getByText(/Изменения применены/)).toBeVisible();
    const one = await call<{ status: string; version: number }>(page.request, "GET", `/api/tasks/${key}-1`);
    const two = await call<{ priority: string; version: number }>(page.request, "GET", `/api/tasks/${key}-2`);
    expect(one.status).toBe("review");
    expect(one.version).toBe(before.version + 1);
    expect(two.priority).toBe("medium"); // the unchecked operation was not applied
  });

  test("STORY-03 the analysis answers from work facts with links to the tasks", async ({ page }) => {
    const overdue = await call<{ items: { key: string }[]; total: number }>(page.request, "GET", "/api/projects/ARIS/tasks?overdue=true");
    const field = await startWorkSkill(page, "Проанализировать проект", "ARIS");
    await field.fill("Какие задачи просрочены?");
    await field.press("Enter");
    const facts = page.getByRole("region", { name: "Данные системы SKH" }).first();
    await expect(facts).toContainText("План проекта ARIS", { timeout: 20_000 });
    await expect(page.locator(".answer__text").first()).toContainText(`Просроченных задач в ARIS: ${overdue.total}`);
  });

  test("STORY-07 a reload restores the work cards from the history, re-read as work proposals", async ({ page }) => {
    const key = await createProject(page.request, "CHR", ["Задача"]);
    const field = await startWorkSkill(page, "Предложить изменения задач", key);
    await field.fill(`${key}-1 на ревью`);
    await field.press("Enter");
    const card = page.locator("[data-work-kind='task_changes']").first();
    await expect(card).toHaveAttribute("data-work-state", "ready", { timeout: 20_000 });
    await expect(page).toHaveURL(/\/ask\?c=conv-/);
    const reads: string[] = [];
    page.on("request", (request) => reads.push(new URL(request.url()).pathname));
    await page.reload();
    const restored = page.locator("[data-work-kind='task_changes']").first();
    await expect(restored).toHaveAttribute("data-work-state", "ready");
    expect(reads.some((p) => p.startsWith("/api/work-ai/change-proposals/WCP-"))).toBe(true);
    expect(reads.some((p) => p.startsWith("/api/ai/proposals"))).toBe(false); // never fetched as a document proposal
    expect(reads.some((p) => p === "/api/assistant/ask" || p === "/api/assistant/ask/stream")).toBe(false); // not asked again
  });
});

test.describe("M7 change review on a phone (scripted model)", () => {
  test("@mobile the change review fits 375 px and «Применить изменения» is reachable", async ({ page }) => {
    const key = await createProject(page.request, "CHM", ["Задача на телефоне"]);
    const created = await call<{ id: string }>(page.request, "POST", "/api/work-ai/change-proposals", {
      project_id: key,
      request: `${key}-1 на ревью`,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${key}?changes=${created.id}`);
    const review = page.getByRole("dialog", { name: "Предложение AI: изменения задач" });
    const apply = review.getByRole("button", { name: "Применить изменения (1)" });
    await apply.scrollIntoViewIfNeeded();
    await expect(apply).toBeVisible();
    await expect(apply).toBeEnabled();
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
