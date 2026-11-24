import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 round 2 on the offline demo stack: the catalog's «Связи» column is the API's `link_count` — the same number
 * as the document page's «Связи» — and «Обновлён» is the document's own date from its metadata (`updated_at`;
 * «—» for a fixture without one), never the time the files were loaded.
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
  // «Документы» v2: the table is the «Таблица» view («Список» with the tree is the default).
  await page.goto("/documents?view=table");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Название", "Статус", "Владелец", "Обновлён", "Связи"]);

  const title = "Semantic Layer — demonstration architecture";
  const cells = await rowCells(page, title);
  const links = Number(cells[cells.length - 1]);
  expect(Number.isInteger(links)).toBe(true);
  // A dated fixture shows its own front-matter `updated_at` (2026-11-20), never the load time.
  const dated = await (await page.request.get("/api/documents/SEM-ARCH-001")).json();
  expect(dated.metadata_updated_at).toBe("2026-11-20");
  expect(cells[cells.length - 2]).toMatch(/^20 нояб\.? 2026/);
  // A fixture without `updated_at` (a draft that was never reviewed) says «—».
  const undated = await rowCells(page, "External Registry: внешний справочник");
  expect(undated[undated.length - 2]).toBe("—");
  // Not a single row shows the time the workspace was seeded.
  await expect(table.getByText(/только что|мин\. назад|сегодня/)).toHaveCount(0);

  await table.getByRole("link", { name: title, exact: true }).click();
  const properties = page.locator(".doc-props");
  await expect(properties.getByRole("button", { name: /документ|нет связей/ })).toHaveText(
    links === 0 ? "нет связей" : new RegExp(`^${links} документ`),
  );

  // Sorting «Сначала новые» uses the same date: newest first, documents without a date last (by title) — the
  // documents seeded last do not jump to the top. The table shows exactly the API's order.
  const api = await (await page.request.get("/api/documents?sort=updated&size=100")).json();
  const dates: (string | null)[] = api.items.map((i: { metadata_updated_at: string | null }) => i.metadata_updated_at);
  const known = dates.filter((d): d is string => d !== null);
  expect(known.length).toBeGreaterThan(50);
  expect(known).toEqual([...known].sort().reverse());
  expect(dates.slice(known.length).every((d) => d === null)).toBe(true);
  await page.goto("/documents?view=table&sort=updated");
  await page.getByRole("button", { name: /^Группировка:/ }).click();
  await page.getByRole("menuitemradio", { name: "Без группировки" }).click();
  const titles = await page.locator(".catalog-row .catalog__title").allTextContents();
  expect(titles).toEqual(api.items.map((i: { title: string }) => i.title));
  expect(problems).toEqual([]);
});
