import { expect, test, type Page } from "@playwright/test";

/*
 * Workstream A against the SCRIPTED MODEL double (backend/tests/support/scripted_model.py, scenario «оформи»):
 * a Markdown answer — heading, bold, list, inline code, GFM table — with a verified citation and a system fact in a
 * paragraph, a list item and table cells. Selected only when E2E_SCRIPTED_URL is set (projects «scripted» /
 * «scripted-mobile»). The double is not a model; this checks the rendering contract, not answer quality.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

const QUESTION = "Оформи сводку по ARIS в Markdown";

async function askFromHome(page: Page) {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(QUESTION);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/ask\?c=conv-/); // the dialog is named in the URL (chat history)
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true }).first()).toBeVisible();
  return page.locator(".answer__text").first();
}

/** The page never scrolls sideways: a wide table scrolls in its own frame. */
async function noPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a Markdown answer renders formatted, with working citation and system-data markers", async ({ page }) => {
  const problems = watch(page);
  const text = await askFromHome(page);

  await expect(text.getByRole("heading", { name: "Сводка по ARIS" })).toBeVisible();
  await expect(text.locator("strong", { hasText: "Что нашлось:" })).toBeVisible();
  await expect(text.locator("li")).toHaveCount(2);
  await expect(text.locator("code", { hasText: "BusinessProcess" })).toBeVisible();
  await expect(text.getByRole("table")).toBeVisible();
  // No Markdown syntax and no raw model markers are left on screen.
  for (const raw of ["**", "## ", "| --- |", "[C", "[F1]"]) await expect(text).not.toContainText(raw);
  // A code sample stays code; an unverified [7] stays text.
  await expect(text.locator("code", { hasText: "[1]" })).toBeVisible();
  await expect(text).toContainText("Пометка [7] не проверена");

  // Verified markers in a paragraph, a list item and table cells.
  const facts = text.getByRole("link", { name: "Данные системы С1" });
  await expect(facts).toHaveCount(2);
  await expect(text.locator("p").getByRole("link", { name: "Данные системы С1" })).toBeVisible();
  await expect(text.locator("td").getByRole("link", { name: "Данные системы С1" })).toBeVisible();
  const citations = text.getByRole("link", { name: "Источник 1" });
  await expect(citations).toHaveCount(2);
  await expect(text.locator("li").getByRole("link", { name: "Источник 1" })).toBeVisible();
  await expect(text.locator("td").getByRole("link", { name: "Источник 1" })).toBeVisible();

  // Tooltip on hover; the system-data marker moves focus to its card on Enter.
  const inList = text.locator("li").getByRole("link", { name: "Источник 1" });
  await inList.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Документы команды" })).toBeVisible();
  const fact = text.locator("p").getByRole("link", { name: "Данные системы С1" });
  await fact.focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "По данным реестра SKH" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Данные системы SKH" }).getByRole("listitem").first()).toBeFocused();

  // A marker in a table cell: its card is not clipped by the table's scroll frame (it opens below the frame).
  const frame = text.locator(".answer-md__frame--table");
  await text.locator("td").getByRole("link", { name: "Источник 1" }).hover();
  const tableCard = page.getByRole("tooltip").filter({ hasText: "Документы команды" });
  await expect(tableCard).toBeVisible();
  const [frameBox, cardBox] = [await frame.boundingBox(), await tableCard.boundingBox()];
  expect(frameBox && cardBox && cardBox.y + cardBox.height > frameBox.y + frameBox.height).toBeTruthy();
  expect(await frame.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await page.mouse.move(0, 0);

  // The numbering matches «Источники»; the citation opens the cited document.
  await expect(page.getByRole("region", { name: "Источники" })).toBeVisible();
  await noPageOverflow(page);
  const href = await inList.getAttribute("href");
  expect(href).toMatch(/^\/documents\//);
  await inList.click();
  await expect(page).toHaveURL(new RegExp(href?.split("#")[0] ?? "/documents/"));
  expect(problems).toEqual([]);
});

test("@mobile a Markdown answer stays inside the phone screen: the table scrolls in its own frame", async ({ page }) => {
  const problems = watch(page);
  const text = await askFromHome(page);
  await expect(text.locator("strong", { hasText: "Что нашлось:" })).toBeVisible();
  await expect(text.getByRole("table")).toBeVisible();
  await expect(text.getByRole("link", { name: "Источник 1" })).toHaveCount(2);
  await expect(text.getByRole("link", { name: "Данные системы С1" })).toHaveCount(2);
  await expect(text).not.toContainText("**");
  const frame = text.locator(".answer-md__frame--table");
  const box = await frame.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width).toBeTruthy();
  await noPageOverflow(page);
  await text.locator("li").getByRole("link", { name: "Источник 1" }).click();
  await expect(page).toHaveURL(/\/documents\//);
  expect(problems).toEqual([]);
});
