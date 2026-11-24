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
  await page.getByRole("button", { name: "Разделы" }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
