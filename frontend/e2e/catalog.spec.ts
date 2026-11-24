import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 round 2 on the offline demo stack: the catalog's «Связи» column is the API's `link_count` — the same number
 * as the document page's «Связи» — and «Обновлён» is the document's own date from its metadata. The synthetic
 * fixtures carry no `updated_at`, so the column says «—» instead of the time the files were loaded.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

async function rowCells(page: Page, title: string): Promise<string[]> {
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
  return row.getByRole("cell").allTextContents();
}

test("R2-01 catalog «Связи» equals the document page; «Обновлён» is the document's date, «—» without one", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Название", "Статус", "Владелец", "Обновлён", "Связи"]);

  const title = "Semantic Layer — demonstration architecture";
  const cells = await rowCells(page, title);
  const links = Number(cells[cells.length - 1]);
  expect(Number.isInteger(links)).toBe(true);
  expect(cells[cells.length - 2]).toBe("—"); // the fixture has no `updated_at`; the load time is not shown
  // Not a single row shows the time the workspace was seeded.
  await expect(table.getByText(/только что|мин\. назад|сегодня/)).toHaveCount(0);

  await table.getByRole("link", { name: title, exact: true }).click();
  const properties = page.locator(".doc-props");
  await expect(properties.getByRole("button", { name: /документ|нет связей/ })).toHaveText(
    links === 0 ? "нет связей" : new RegExp(`^${links} документ`),
  );

  // Sorting «Сначала новые» uses the same date: without dates the order is by title — the documents seeded last
  // do not jump to the top.
  await page.goto("/documents?sort=updated");
  await page.getByRole("button", { name: /^Группировка:/ }).click();
  await page.getByRole("menuitemradio", { name: "Без группировки" }).click();
  const titles = await page.locator(".catalog-row .catalog__title").allTextContents();
  expect(titles.length).toBeGreaterThan(50);
  const lower = titles.map((t) => t.toLowerCase());
  expect(lower).toEqual([...lower].sort());
  expect(problems).toEqual([]);
});
