import { expect, test, type Page } from "@playwright/test";

/*
 * «Документы» v2 on the offline demo stack (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §6): the tree, the branch
 * list and the preview of «Список», «Требуют внимания» with the server's count, the URL and «Назад», the document
 * page's path by the tree, and the phone's one screen at a time. Synthetic documents only.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

/** A fresh browser: no remembered view or open branches. */
async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    try {
      localStorage.removeItem("skh.documents.view");
      localStorage.removeItem("skh.documents.tree");
    } catch {
      /* storage blocked: nothing to clear */
    }
  });
}

test("V2-01 «Список» is the default: tree → Интеграции → ARIS → a document → preview → «Открыть»", async ({ page }) => {
  const problems = watch(page);
  await fresh(page);
  await page.goto("/documents");
  await expect(page).toHaveURL(/\/documents\?view=list$/);
  await expect(page.getByRole("group", { name: "Вид раздела" }).getByRole("button", { name: "Список" })).toHaveAttribute("aria-pressed", "true");

  const tree = page.getByRole("tree", { name: "Разделы и документы" });
  await tree.getByRole("treeitem", { name: /^Интеграции, 19 документов/ }).locator(".doc-tree__row").first().click();
  // the computed groups of the demo base, with the API's counts
  const integration = tree.getByRole("treeitem", { name: /^Интеграции/ });
  await expect(integration.getByRole("group").first().getByRole("treeitem", { name: /^(ARIS|CATIA|CRM|Data Catalog|ERP|Общие правила),/ })).toHaveText(
    [/ARIS.*8/, /CATIA.*2/, /CRM.*1/, /Data Catalog.*1/, /ERP.*1/, /Общие правила.*6/],
  );
  await tree.getByRole("treeitem", { name: /^ARIS, 8 документов/ }).locator(".doc-tree__row").first().click();
  await expect(page).toHaveURL(/node=integration%2Faris/);
  const list = page.getByRole("region", { name: "Интеграции / ARIS" });
  await expect(list.locator(".docs-row")).toHaveCount(8);

  await list.getByRole("link", { name: "ARIS → Catalog: обзор потока (демо)" }).click();
  await expect(page).toHaveURL(/doc=DEMO-INT-001/);
  const preview = page.getByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" });
  await expect(preview.getByText("Интеграции / ARIS")).toBeVisible();
  await expect(preview.getByText("ARIS, Data Catalog")).toBeVisible();
  const api = await (await page.request.get("/api/documents/tree")).json();
  await expect(preview.getByRole("link", { name: new RegExp(`^${api.documents["DEMO-INT-001"].link_count} документ`) })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "ARIS → Catalog: обзор потока (демо)" })).toHaveAttribute("aria-selected", "true");
  // One primary per view (the owner's decision): «Создать документ»; «Открыть» is secondary, the title is a link.
  await expect(page.locator(".button--primary")).toHaveText(["Создать документ"]);
  await expect(preview.getByRole("heading", { level: 2 }).getByRole("link")).toHaveAttribute("href", "/documents/DEMO-INT-001");

  await preview.getByRole("link", { name: "Открыть" }).click();
  await expect(page).toHaveURL(/\/documents\/DEMO-INT-001$/);
  // the path of the document page follows the tree
  const path = page.locator(".page-toolbar .crumbs");
  await expect(path.locator("li")).toHaveText(["Документы", "Интеграции", "ARIS", "ARIS → Catalog: обзор потока (демо)"]);
  // «Назад» returns to the list with the document chosen
  await page.goBack();
  await expect(page).toHaveURL(/node=integration%2Faris&doc=DEMO-INT-001/);
  await expect(page.getByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("V2-02 «Требуют внимания»: the server's count, the same documents in the list", async ({ page }) => {
  await fresh(page);
  const api = await (await page.request.get("/api/documents/tree")).json();
  const flagged = Object.values(api.documents as Record<string, { attention: boolean }>).filter((d) => d.attention).length;
  expect(api.attention_total).toBe(flagged);
  // 12 on the synthetic base while no other approved review is older than 180 days (until 7 Dec 2026)
  if (Date.now() < Date.parse("2026-12-07")) expect(api.attention_total).toBe(12);

  await page.goto("/documents?view=list");
  const attention = page.getByRole("tree").getByRole("treeitem", { name: new RegExp(`^Требуют внимания, ${api.attention_total} `) });
  await expect(attention.locator(".doc-tree__attention")).toHaveText(String(api.attention_total));
  await attention.locator(".doc-tree__row").click();
  const list = page.getByRole("region", { name: "Требуют внимания" });
  await expect(list.locator(".docs-row")).toHaveCount(api.attention_total);
  // deprecated first, struck through; only non-approved rows carry a status word
  await expect(list.locator(".docs-row").first()).toHaveClass(/docs-row--deprecated/);
  await expect(list.locator(".docs-row .docs-row__status")).toHaveCount(10);
});

test("V2-03 the toolbar search lists results in the middle column; the tree stays", async ({ page }) => {
  await fresh(page);
  await page.goto("/documents?view=list&node=source");
  await page.getByRole("searchbox", { name: "Найти в документах" }).fill("маппинг");
  await expect(page).toHaveURL(/q=%D0%BC%D0%B0%D0%BF%D0%BF%D0%B8%D0%BD%D0%B3/);
  const results = page.getByRole("region", { name: "Результаты: «маппинг»" });
  await expect(results.locator(".docs-row").first()).toBeVisible();
  await expect(results.locator(".docs-row mark").first()).toBeVisible();
  await expect(results.getByText(/^Почему найдено:/).first()).toBeVisible();
  await expect(page.getByRole("tree")).toBeVisible();
  await results.getByRole("button", { name: "Сбросить поиск" }).click();
  await expect(page.getByRole("region", { name: "Системы-источники" })).toBeVisible();
});

interface TreeEntry {
  status: string;
  type: string;
  attention: boolean;
  review_state: string;
  owner_missing: boolean;
}

/** The API's documents of a section with a status (what an overview cell counts). */
function countOf(api: { documents: Record<string, TreeEntry> }, type: string | null, test: (d: TreeEntry) => boolean): number {
  return Object.values(api.documents).filter((d) => (type === null || d.type === type) && test(d)).length;
}

test("V2-05 «Обзор»: the API's totals; the cell «Интеграции / Черновики» opens exactly those rows in «Таблица»", async ({ page }) => {
  const problems = watch(page);
  await fresh(page);
  const api = await (await page.request.get("/api/documents/tree")).json();
  const approved = countOf(api, null, (d) => d.status === "approved");
  await page.goto("/documents?view=overview");
  const overview = page.getByRole("region", { name: new RegExp(`^${api.total} документ.*, ${approved} утвержден`) });
  await expect(overview).toBeVisible();
  // «Требуют внимания» = the API's attention_total (12 on the demo base until 7 Dec 2026)
  await expect(overview.getByRole("link", { name: `${api.attention_total} требуют внимания` })).toBeVisible();
  if (Date.now() < Date.parse("2026-12-07")) expect(api.attention_total).toBe(12);

  const drafts = countOf(api, "integration", (d) => d.status === "draft");
  if (Date.now() < Date.parse("2026-12-07")) expect(drafts).toBe(2);
  const cell = overview.getByRole("link", { name: new RegExp(`^Интеграции: ${drafts} черновик`) });
  await expect(cell).toHaveText(String(drafts));
  await cell.click();
  await expect(page).toHaveURL(/view=table&type=integration&status=draft$/);
  const table = page.getByRole("table");
  await expect(table.locator(".docs-table__row")).toHaveCount(drafts);
  await expect(page.getByText(`${drafts} из ${api.total}`)).toBeVisible();
  for (const state of await table.locator(".docs-table__row .status-mark").allTextContents()) expect(state).toBe("Черновик");

  // a section opens «Список» with it open in the tree
  await page.goBack();
  await overview.getByRole("link", { name: "Интеграции", exact: true }).click();
  await expect(page).toHaveURL(/view=list&node=integration$/);
  await expect(page.getByRole("treeitem", { name: /^Интеграции, / })).toHaveAttribute("aria-expanded", "true");
  expect(problems).toEqual([]);
});

test("V2-06 «Таблица»: «Только требующие внимания» = the API's count, a filter menu, a header sort", async ({ page }) => {
  const problems = watch(page);
  await fresh(page);
  const api = await (await page.request.get("/api/documents/tree")).json();
  await page.goto("/documents?view=table");
  const table = page.getByRole("table");
  await expect(table.locator(".docs-table__row")).toHaveCount(api.total);
  await page.getByRole("button", { name: "Только требующие внимания" }).click();
  await expect(page).toHaveURL(/attention=1/);
  await expect(table.locator(".docs-table__row")).toHaveCount(api.attention_total);
  await expect(page.getByText(`${api.attention_total} из ${api.total}`)).toBeVisible();

  // Состояние → Без владельца (a checkbox menu: it stays open; Esc closes it)
  await page.getByRole("button", { name: "Состояние: все" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Без владельца/ }).click();
  await page.keyboard.press("Escape");
  const ownerless = countOf(api, null, (d) => d.attention && d.owner_missing);
  await expect(table.locator(".docs-table__row")).toHaveCount(ownerless);
  await expect(table.locator(".docs-table__no-owner")).toHaveCount(ownerless);

  // header sort: «Название» ascending, then descending
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  const name = table.getByRole("columnheader", { name: "Название" });
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  const ascending = await table.locator(".docs-table__title").allTextContents();
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", "descending");
  const descending = await table.locator(".docs-table__title").allTextContents();
  expect(descending).toEqual([...ascending].reverse());
  expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" })));
  // the header stays while the rows scroll
  await table.locator(".docs-table__row").last().scrollIntoViewIfNeeded();
  await expect(name).toBeInViewport();
  expect(problems).toEqual([]);
});

test("@mobile V2-04 phone: the tree, then the branch, then the document page", async ({ page }) => {
  await fresh(page);
  await page.goto("/documents");
  const tree = page.getByRole("tree");
  await tree.getByRole("treeitem", { name: /^Системы-источники/ }).locator(".doc-tree__row").first().click();
  const list = page.getByRole("region", { name: "Системы-источники" });
  await expect(list.locator(".docs-row")).toHaveCount(12);
  await expect(page.getByRole("tree")).toHaveCount(0);
  await list.getByRole("link", { name: "CRM: карточки и идентификаторы" }).click();
  await expect(page).toHaveURL(/\/documents\/DEMO-SRC-004$/);
  await page.goBack();
  // slice 7: «Назад» is in the toolbar
  await page.locator(".page-toolbar").getByRole("button", { name: "Назад" }).click();
  await expect(page).toHaveURL(/\/documents\?view=list$/);
  await expect(page.getByRole("tree")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("@mobile V2-07 phone: «Обзор» lists the sections with chips, «Таблица» shows cards; no sideways scroll", async ({ page }) => {
  const problems = watch(page);
  await fresh(page);
  const api = await (await page.request.get("/api/documents/tree")).json();
  await page.goto("/documents?view=overview");
  await expect(page.getByRole("table")).toHaveCount(0);
  const sections = page.getByRole("list", { name: "Документы по разделам и состояниям" });
  await expect(sections).toBeVisible();
  const drafts = countOf(api, "integration", (d) => d.status === "draft");
  const chip = sections.getByRole("link", { name: new RegExp(`^Интеграции: ${drafts} черновик`) });
  await expect(chip).toHaveText(`Черновики: ${drafts}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await chip.click();
  await expect(page).toHaveURL(/view=table&type=integration&status=draft$/);
  await expect(page.locator(".docs-card")).toHaveCount(drafts);
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // the filters are a sheet
  await page.getByRole("button", { name: /^Фильтры \(2\)$/ }).click();
  const sheet = page.getByRole("dialog", { name: "Фильтры" });
  await sheet.getByRole("button", { name: /Только требующие внимания/ }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/attention=1/);
  await expect(page.locator(".docs-card")).toHaveCount(countOf(api, "integration", (d) => d.status === "draft" && d.attention));
  expect(problems).toEqual([]);
});

test("V2-08 narrower screens: the preview is a sheet below 1280 px, the tree a sheet from the left below 960 px", async ({ page }) => {
  const problems = watch(page);
  await fresh(page);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/documents?view=list&node=integration%2Faris");
  const list = page.getByRole("region", { name: "Интеграции / ARIS" });
  await expect(page.getByRole("tree")).toBeVisible();
  await list.getByRole("link", { name: "ARIS → Catalog: обзор потока (демо)" }).click();
  const preview = page.getByRole("dialog", { name: "Просмотр документа" });
  await expect(preview.getByRole("article", { name: "ARIS → Catalog: обзор потока (демо)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByRole("tree")).toHaveCount(0);
  const open = page.getByRole("button", { name: "Разделы" });
  await open.click();
  const sheet = page.getByRole("dialog", { name: "Разделы" });
  await expect(sheet.getByRole("tree")).toBeVisible();
  // from the left edge (once its slide-in has finished)
  await expect.poll(async () => Math.round((await sheet.boundingBox())?.x ?? -1)).toBe(0);
  expect((await sheet.boundingBox())?.width ?? 900).toBeLessThan(450);
  await sheet.getByRole("treeitem", { name: /^CATIA, / }).locator(".doc-tree__row").first().click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Интеграции / CATIA" })).toBeVisible();
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});
