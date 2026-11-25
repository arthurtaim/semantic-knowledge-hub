import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/*
 * Chat history on the offline demo stack (AI_PROVIDER=mock; docs/API_CONTRACTS.md v0.7, docs/UI_REDESIGN.md «История
 * диалогов»). The reported defect: a dialog was not kept — clicking a recent dialog or coming back from another
 * section asked the question again. Now every completed answer is stored on the server for this user AND browser
 * (X-SKH-Browser, a random id in localStorage): coming back, reloading or reopening shows the stored answer and sends
 * no new ask request; another browser (context) sees nothing. Synthetic fixtures only.
 */

const QUESTION = "Где хранится каноническая база знаний команды?";

function watch(page: Page, allowed: RegExp[] = []): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !allowed.some((re) => re.test(msg.text()))) problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

/** Counts POST /api/assistant/ask(/stream) of this page. */
function countAsks(page: Page): { n: number } {
  const asks = { n: 0 };
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/assistant\/ask(\/stream)?$/.test(request.url())) asks.n += 1;
  });
  return asks;
}

const answer = (page: Page) => page.locator(".answer").first();
const dialog = (page: Page) => page.getByRole("region", { name: "Диалог", exact: true });

/** What the first answer in `scope` shows (its head, text and sources), without citation cards a hover may open. */
async function answerText(scope: Page | Locator): Promise<string> {
  return scope
    .locator(".answer")
    .first()
    .evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[role="tooltip"], .cite-card, time').forEach((node) => node.remove());
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    });
}

/** Asks from the home page and waits for the validated answer; returns the dialog's id from the URL. */
async function askFromHome(page: Page, question = QUESTION): Promise<string> {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(question);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/ask\?c=conv-[0-9a-f]{24}$/);
  await expect(answer(page).getByText("Подтверждено источниками")).toBeVisible();
  return new URL(page.url()).searchParams.get("c") ?? "";
}

async function noPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("H-01 ask → «Документы» → back: the same answer, exactly one ask request; Back/Forward never ask again", async ({ page }) => {
  const problems = watch(page);
  const asks = countAsks(page);
  const id = await askFromHome(page);
  const text = await answerText(page);

  await page.getByRole("navigation").getByRole("link", { name: "Документы" }).first().click();
  await expect(page).toHaveURL(/\/documents/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/ask\\?c=${id}$`));
  await expect.poll(() => answerText(page)).toBe(text);
  await expect(dialog(page).getByText(QUESTION, { exact: true })).toBeVisible();

  // Forward and Back again (the home page's `?q=…&run=1` was replaced by `?c=`).
  await page.goBack();
  await page.goForward();
  await expect.poll(() => answerText(page)).toBe(text);
  expect(asks.n).toBe(1);
  expect(problems).toEqual([]);
});

test("H-02 a reload restores the conversation from the server; a follow-up continues it", async ({ page }) => {
  const problems = watch(page);
  const asks = countAsks(page);
  const id = await askFromHome(page);
  const text = await answerText(page);

  await page.reload();
  await expect.poll(() => answerText(page)).toBe(text);
  await expect(dialog(page).getByText(QUESTION, { exact: true })).toBeVisible();
  expect(asks.n).toBe(1);

  const followUp = page.waitForRequest((r) => r.url().endsWith("/api/assistant/ask/stream") && r.method() === "POST");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill("Что такое ревизия документа?");
  await field.press("Enter");
  const body = (await followUp).postDataJSON() as { conversation_id: string; history: { question: string }[] };
  expect(body.conversation_id).toBe(id);
  expect(body.history.map((turn) => turn.question)).toEqual([QUESTION]);
  await expect(page.locator(".answer")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".answer")).toHaveCount(2);
  expect(asks.n).toBe(2);
  expect(problems).toEqual([]);
});

test("H-03 «Недавние диалоги» opens the stored dialog — also in a new tab — and never asks again", async ({ page, context }) => {
  const problems = watch(page);
  const asks = countAsks(page);
  const id = await askFromHome(page);
  const text = await answerText(page);

  await page.getByRole("navigation").getByRole("link", { name: "Ассистент" }).first().click();
  const recent = page.getByRole("region", { name: "Недавние диалоги" });
  await expect(recent).toContainText("Хранятся на сервере для этого браузера 30 дней");
  const row = recent.getByRole("link", { name: new RegExp(QUESTION.slice(0, 30)) });
  await expect(row).toHaveAttribute("href", `/ask?c=${id}`);
  await row.click();
  await expect.poll(() => answerText(page)).toBe(text);
  expect(asks.n).toBe(1);

  // A new tab of the same browser: the server has it.
  const tab = await context.newPage();
  const tabAsks = countAsks(tab);
  await tab.goto(`/ask?c=${id}`);
  await expect.poll(() => answerText(tab)).toBe(text);
  expect(tabAsks.n).toBe(0);
  expect(problems).toEqual([]);
});

async function otherBrowser(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
}

test("H-04 another browser does not see this browser's history, not even by its link", async ({ page, browser, baseURL }) => {
  const problems = watch(page);
  const id = await askFromHome(page);

  const other = await otherBrowser(browser, baseURL);
  const otherProblems = watch(other.page, [/status of 404/]);
  const otherAsks = countAsks(other.page);
  await other.page.goto("/");
  await expect(other.page.getByRole("heading", { name: "Что нужно найти или подготовить?" })).toBeVisible();
  await expect(other.page.getByRole("region", { name: "Недавние диалоги" })).toHaveCount(0);
  await other.page.goto(`/ask?c=${id}`);
  await expect(other.page.getByText(/Этого диалога нет в истории этого браузера/)).toBeVisible();
  await expect(other.page.locator(".answer")).toHaveCount(0);
  expect(otherAsks.n).toBe(0);
  await other.context.close();
  expect(problems).toEqual([]);
  expect(otherProblems).toEqual([]);
});

test("H-05 «Удалить диалог» and «Очистить историю» ask first, then delete on the server", async ({ page }) => {
  const problems = watch(page, [/status of 404/]);
  const first = await askFromHome(page);
  await askFromHome(page, "Что такое ревизия документа?");

  await page.getByRole("button", { name: "Удалить диалог" }).click();
  await expect(page.getByText(/Удалить этот диалог из истории\?/)).toBeVisible();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page).toHaveURL(/\/ask$/);
  await expect(dialog(page)).toHaveCount(0);

  await page.goto("/");
  const recent = page.getByRole("region", { name: "Недавние диалоги" });
  await expect(recent.getByRole("link")).toHaveCount(1);
  await expect(recent.getByRole("link").first()).toHaveAttribute("href", `/ask?c=${first}`);
  await recent.getByRole("button", { name: "Очистить историю" }).click();
  await expect(recent.getByText(/Удалить всю историю диалогов этого браузера\?/)).toBeVisible();
  await recent.getByRole("button", { name: "Очистить историю" }).click();
  await expect(page.getByRole("region", { name: "Недавние диалоги" })).toHaveCount(0);
  await page.goto(`/ask?c=${first}`);
  await expect(page.getByText(/Этого диалога нет в истории этого браузера/)).toBeVisible();
  expect(problems).toEqual([]);
});

test("H-06 the document panel keeps its conversation across leaving the page and a reload", async ({ page }) => {
  const problems = watch(page);
  const asks = countAsks(page);
  await page.goto("/documents/SEM-ARCH-001");
  await page.getByRole("button", { name: "Ассистент", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Ассистент" });
  const field = panel.getByRole("textbox", { name: "Вопрос по документу" });
  await field.fill("Какие слои у архитектуры?");
  await field.press("Enter");
  await expect(panel.locator(".answer").first()).toBeVisible();
  const text = await answerText(panel);
  const reopenedPanel = async () => {
    const shown = page.getByRole("complementary", { name: "Ассистент" });
    if ((await shown.count()) === 0) await page.getByRole("button", { name: "Ассистент", exact: true }).click();
    return page.getByRole("complementary", { name: "Ассистент" });
  };

  await page.getByRole("navigation").getByRole("link", { name: "Документы" }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/documents\/SEM-ARCH-001$/);
  const back = await reopenedPanel();
  await expect.poll(() => answerText(back)).toBe(text);

  await page.reload();
  const reloaded = await reopenedPanel();
  await expect.poll(() => answerText(reloaded)).toBe(text);
  expect(asks.n).toBe(1);
  expect(problems).toEqual([]);
});

test("@mobile H-07 on a phone (390 px) a reopened dialog fits, with «Удалить диалог» and «Новый диалог»", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watch(page);
  const asks = countAsks(page);
  const id = await askFromHome(page);
  await page.goto("/");
  await page.getByRole("region", { name: "Недавние диалоги" }).getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/ask\\?c=${id}$`));
  await expect(answer(page).getByText("Подтверждено источниками")).toBeVisible();
  await expect(page.getByRole("button", { name: "Удалить диалог" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Новый диалог" })).toBeVisible();
  await noPageOverflow(page);
  await page.getByRole("button", { name: "Удалить диалог" }).click();
  await expect(page.getByText(/Удалить этот диалог из истории\?/)).toBeVisible();
  await noPageOverflow(page);
  await page.getByRole("button", { name: "Отмена" }).click();
  await page.reload();
  await expect(answer(page).getByText("Подтверждено источниками")).toBeVisible();
  await noPageOverflow(page);
  expect(asks.n).toBe(1);
  expect(problems).toEqual([]);
});
