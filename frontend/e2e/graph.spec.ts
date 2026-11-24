import { expect, test, type Page } from "@playwright/test";

/*
 * M5.6.2 knowledge graph on the offline demo stack (83 synthetic documents, mock Confluence corpus, mock AI):
 * global list view, a neighbourhood with edge provenance, the evidence graph of an answer that needed Confluence,
 * and the phone layout.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

const details = (page: Page) => page.getByRole("complementary", { name: "Сведения об узле" });

test("M5.6 graph: navigation, global graph and its list view", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("link", { name: "Карта знаний" }).click();
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.getByRole("heading", { name: "Граф знаний", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: /Схема графа: \d+ узл/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Условные обозначения" })).toBeVisible();

  await page.getByRole("radio", { name: "Списком" }).check({ force: true });
  const nodes = page.getByRole("region", { name: /^Узлы/ });
  await expect(nodes.getByText("DEMO-INT-002", { exact: true })).toBeVisible();
  await nodes.getByRole("button", { name: "ARIS → Catalog: маппинг полей (демо)" }).click();
  await expect(details(page).getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeFocused();
  await expect(details(page)).toContainText("Указано в");
  expect(problems).toEqual([]);
});

test("M5.6 graph: neighbourhood of DEMO-INT-002 shows DEMO-SEM-002 and why they are linked", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/DEMO-INT-002");
  await page.getByRole("tab", { name: "Связи" }).click(); // UI v2: links are a segment of the document
  await page.getByRole("link", { name: "Связи на графе" }).click();
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-INT-002$/);

  const panel = details(page);
  await expect(panel.getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeVisible();
  const mapsTo = panel.locator(".graph-why", { hasText: "отображается в" });
  await expect(mapsTo).toContainText("Логическая модель: BusinessProcess");
  await expect(mapsTo).toContainText("DEMO-INT-002");
  await expect(mapsTo).toContainText("relations.maps_to");
  await expect(mapsTo).toContainText("integrations/DEMO-INT-002.md");
  await expect(mapsTo).toContainText("sha256:");

  // Keyboard: focus the node on the canvas and select it with Enter.
  const entity = page.getByRole("button", { name: /^Логическая модель: BusinessProcess\./ });
  await entity.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeVisible();
  await expect(panel).toContainText("DEMO-SEM-002");
  await panel.getByRole("link", { name: "Показать соседей" }).click();
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-SEM-002$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-INT-002$/);
  await expect(page.getByRole("navigation", { name: "Путь" })).toContainText("Окружение DEMO-INT-002");
  // Back restores the neighbourhood together with the node that was selected in it.
  await expect(page.getByRole("button", { name: /^ARIS → Catalog: маппинг полей \(демо\)\./ })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("M5.6 ask with both sources: a Confluence citation and the evidence graph of the answer", async ({ page }) => {
  // Needs the synthetic Confluence corpus (CONFLUENCE_CONNECTOR=mock); the default offline stack has none.
  const session = (await (await page.request.get("/api/session", { headers: { "X-SKH-Client": "web" } })).json()) as {
    features: { corporate_search: string };
  };
  test.skip(session.features.corporate_search === "disabled", "Confluence is not configured on this stack");
  const problems = watch(page);
  const question = "Когда действует окно заморозки изменений метаданных?";
  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill(question);
  await page.getByLabel("Оба").check({ force: true });
  await page.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(page.getByText("Подтверждено источниками")).toBeVisible();

  const citation = page.locator(".citation", { hasText: "Регламент заморозки изменений метаданных (демо)" }).first();
  await expect(citation).toContainText(/Confluence · версия \d+/);
  await expect(citation).toContainText("статус не подтверждён");
  await expect(page.getByText(/^Внешний источник: запрос к Confluence \(причина: /)).toBeVisible();

  const rating = page.getByRole("group", { name: "Оценка источника «Регламент заморозки изменений метаданных (демо)»" });
  await rating.getByRole("button", { name: "Подошёл", exact: true }).click();
  await expect(rating.getByRole("button", { name: "Подошёл", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(rating).toContainText("Отзыв учтён");

  await page.getByRole("link", { name: "Граф ответа" }).click();
  await expect(page).toHaveURL(/\/graph\?trace=TRACE-[0-9a-f]{16}$/);
  expect(decodeURIComponent(page.url())).not.toContain("заморозки"); // the question never goes into the URL
  await expect(page.getByRole("heading", { name: "Граф ответа", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^Регламент заморозки изменений метаданных \(демо\)\. Внешняя страница Confluence, статус не подтверждён/,
    }),
  ).toBeVisible();
  // The question node is selected by default: its links say what was found and what was cited.
  const panel = details(page);
  await expect(panel).toContainText("процитирована в ответе");
  await expect(panel).toContainText("подошёл"); // the feedback just given is on the evidence edge
  expect(problems).toEqual([]);
});

test("@mobile graph: lists by default, details after a selection, no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const path of ["/graph", "/graph?focus=DEMO-INT-002"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("radio", { name: "Списком" })).toBeChecked();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.locator(".graph-list__node", { hasText: "Логическая модель: BusinessProcess" }).first().click();
  await expect(details(page).getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeFocused();
  await page.getByRole("radio", { name: "Схема" }).check({ force: true });
  await expect(page.getByRole("group", { name: /Схема графа/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
