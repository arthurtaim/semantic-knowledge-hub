import { expect, test, type Page } from "@playwright/test";

/*
 * «Таблица» of «Документы» v2 on the offline demo stack (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §3): «Связи» is
 * the API's `link_count` — the same number as the document page's «Связи» — and «Проверен» the review date of the
 * tree API, with the year. (UI v2 round 2 checked «Обновлён» here; the v2 table has «Проверен» instead — spec §3.)
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

test("R2-01 «Таблица»: «Связи» equals the document page; «Проверен» is the API's review date; sorting by «Связи»", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents?view=table");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Название", "Раздел", "Состояние", "Владелец", "Системы", "Проверен", "Связи"]);
  const tree = await (await page.request.get("/api/documents/tree")).json();

  const title = "Semantic Layer — demonstration architecture";
  const cells = await rowCells(page, title);
  const links = Number(cells[cells.length - 1]);
  expect(links).toBe(tree.documents["SEM-ARCH-001"].link_count);
  // «Проверен»: the tree's date with the year (2026-11-20 on the demo base)
  const reviewed: string = tree.documents["SEM-ARCH-001"].reviewed_at;
  expect(cells[5]).toContain(reviewed.slice(0, 4));
  expect(cells[5]).toMatch(new RegExp(`^${Number(reviewed.slice(8, 10))} `));
  // A draft needs no review: «не требуется».
  const draft = await rowCells(page, "External Registry: внешний справочник");
  expect(draft[5]).toBe("не требуетсяПроверка не требуется");
  // Not a single row shows the time the workspace was seeded.
  await expect(table.getByText(/только что|мин\. назад|сегодня/)).toHaveCount(0);

  // «Связи» descending: the API's link counts in order
  await table.getByRole("columnheader", { name: "Связи" }).getByRole("button").click();
  await table.getByRole("columnheader", { name: "Связи" }).getByRole("button").click();
  await expect(page).toHaveURL(/sort=-links/);
  await expect(table.getByRole("columnheader", { name: "Связи" })).toHaveAttribute("aria-sort", "descending");
  const shown = (await table.locator(".docs-table__row td:last-child").allTextContents()).map(Number);
  expect(shown).toHaveLength(tree.total);
  expect(shown).toEqual([...shown].sort((a, b) => b - a));
  expect(shown[0]).toBe(Math.max(...Object.values(tree.documents as Record<string, { link_count: number }>).map((d) => d.link_count)));

  await table.getByRole("link", { name: title, exact: true }).click();
  const properties = page.locator(".doc-props");
  await expect(properties.getByRole("button", { name: /документ|нет связей/ })).toHaveText(
    links === 0 ? "нет связей" : new RegExp(`^${links} документ`),
  );
  expect(problems).toEqual([]);
});
