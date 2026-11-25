import { expect, test, type Page } from "@playwright/test";

/*
 * Chat history against the SCRIPTED MODEL double (backend/tests/support/scripted_model.py, scenario «оформи»): a
 * Markdown answer with verified citation and system-data markers, its fact card and its provenance line come back
 * from the server's history after a reload exactly as they were rendered live — without a new ask request.
 * Selected only when E2E_SCRIPTED_URL is set (projects «scripted» / «scripted-mobile»). The double is not a model.
 */

const QUESTION = "Оформи сводку по ARIS в Markdown";

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

function countAsks(page: Page): { n: number } {
  const asks = { n: 0 };
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/assistant\/ask(\/stream)?$/.test(request.url())) asks.n += 1;
  });
  return asks;
}

/** What the reader sees of the answer: its text, the markers, the formatting, the facts, the head line. */
async function rendered(page: Page) {
  await page.mouse.move(0, 0); // no citation card open by a hover
  const answer = page.locator(".answer").first();
  const text = answer.locator(".answer__text");
  await expect(text.getByRole("link", { name: "Источник 1" }).first()).toBeVisible();
  return {
    text: await text.innerText(),
    // The same markup; only React's generated ids (useId: `_r_9_`) depend on what rendered before.
    html: (await text.innerHTML()).replace(/_r_[0-9a-z]+_/g, "_r_"),
    markers: await text.getByRole("link").evaluateAll((links) => links.map((a) => a.getAttribute("aria-label") ?? a.textContent)),
    tables: await text.getByRole("table").count(),
    headings: await text.getByRole("heading").allInnerTexts(),
    head: await answer.locator(".answer__head").innerText(),
    facts: await page.getByRole("region", { name: "Данные системы SKH" }).first().innerText(),
  };
}

async function askAndRestore(page: Page) {
  const problems = watch(page);
  const asks = countAsks(page);
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(QUESTION);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/ask\?c=conv-[0-9a-f]{24}$/);
  const live = await rendered(page);
  expect(live.tables).toBe(1);
  expect(live.headings).toContain("Сводка по ARIS");

  await page.reload();
  const restored = await rendered(page);
  expect(restored).toEqual(live);
  expect(asks.n).toBe(1);
  return problems;
}

test("a Markdown answer with markers is restored identically after a reload, without asking again", async ({ page }) => {
  const problems = await askAndRestore(page);
  expect(problems).toEqual([]);
});

test("@mobile the restored Markdown answer is the same on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = await askAndRestore(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});
