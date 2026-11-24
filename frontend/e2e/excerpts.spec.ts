import { expect, test, type Page } from "@playwright/test";

/*
 * Owner's review, round 2, on the offline demo stack (AI_PROVIDER=mock, synthetic documents): an excerpt from a
 * Markdown table is shown as rows and cells — never glued headers — and «Не найдено в документах» never names
 * function words.
 */

const TABLE_QUESTION = "Что является источником и получателем для потока DEMO-INT-001?";
const ask = (question: string) => `/ask?q=${encodeURIComponent(question)}&run=1`;

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test("R2-01 a table excerpt: rows under «Источники», « — » in the card; function words are never «не найдены»", async ({ page }) => {
  await page.goto(ask(TABLE_QUESTION));
  const sources = page.getByRole("region", { name: "Источники" });
  const table = sources.getByRole("table", { name: "Строки таблицы из раздела «Источник и получатель»" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText(["Роль", "Система", "Код", "Комментарий"]);
  await expect(table.getByRole("row").filter({ hasText: "Получатель" }).getByRole("cell")).toHaveText([
    "Получатель",
    "Data Catalog",
    "SYS-CAT",
    "каталог активов, профиль DEMO-SRC-007",
  ]);
  await expect(sources).not.toContainText("Роль Система Код Комментарий");

  const marker = page.locator(".answer__text").getByRole("link", { name: "Источник 1" });
  await marker.hover();
  const card = page.locator(`[id="${await marker.getAttribute("aria-describedby")}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator(".cite-card__row--head")).toHaveText("Роль — Система — Код — Комментарий");
  await expect(card).toContainText("Получатель — Data Catalog — SYS-CAT — каталог активов");

  // Each question in its own tab (a new dialog): only «через», «который» are missing → no line at all.
  const onlyFunctionWords = await page.context().newPage();
  await onlyFunctionWords.goto(ask("Кто владелец потока между ARIS и каталогом, через который идут данные?"));
  const first = onlyFunctionWords.locator(".answer").last();
  await expect(first.getByRole("region", { name: "Источники" })).toBeVisible();
  await expect(first.locator(".answer__unsupported")).toHaveCount(0);
  const meaningful = await page.context().newPage();
  await meaningful.goto(ask("Как часто запускается поток из ARIS в каталог и что будет при сбое?"));
  const line = meaningful.locator(".answer").last().locator(".answer__unsupported");
  await expect(line).toContainText("Не найдено в документах: «часто»");
  await expect(line).not.toContainText("будет");
});

test("@mobile R2-02 on a phone a table excerpt stacks as «заголовок: значение» and nothing scrolls sideways", async ({ page }) => {
  await page.goto(ask(TABLE_QUESTION));
  const table = page.getByRole("region", { name: "Источники" }).getByRole("table").first();
  await expect(table).toBeVisible();
  const label = await table
    .getByRole("cell", { name: "SYS-ARIS" })
    .evaluate((cell) => getComputedStyle(cell, "::before").content);
  expect(label).toContain("Код");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
