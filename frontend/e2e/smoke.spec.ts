import { expect, test, type Page } from "@playwright/test";

/** Collects console errors and CSP violations so the smoke test fails on them. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

test("AC-01..AC-04: start, search ARIS, open document, empty search", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await expect(page.getByRole("note")).toContainText("Демо-данные.");
  await expect(page.getByRole("heading", { name: "Разделы" })).toBeVisible();

  // The hero is «Спросить или найти»: switch it to search, then search.
  await page.getByRole("button", { name: "Найти в документах" }).click();
  await page.getByRole("combobox", { name: "Поиск по базе знаний" }).fill("ARIS");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  const result = page.getByRole("link", { name: "ARIS integration — questions for discovery" });
  await expect(result).toBeVisible();
  // 83-document demo base: other ARIS documents may rank first, so check the row of this document.
  const row = page.locator(".result", { has: result });
  await expect(row).toContainText("Черновик");
  await expect(row).toContainText("Локальный workspace");

  await result.click();
  // UI v2: the former passport is «Сведения о документе» (a right panel opened from «Все сведения»).
  await page.getByRole("button", { name: "Все сведения" }).click();
  const details = page.getByRole("complementary", { name: "Сведения о документе" });
  await expect(details).toContainText("Черновик");
  await expect(details).toContainText("demo-team");
  await expect(details).toContainText("local://SEM-INT-ARIS-001");
  await expect(details).toContainText("sha256:");

  await page.goto("/documents?query=квазизвездный");
  await expect(page.getByText("По запросу «квазизвездный» ничего не найдено")).toBeVisible();
  expect(problems).toEqual([]);
});

test("AC-05..AC-07: grounded answer with valid citation, insufficient evidence, corporate disabled", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill("Где хранится каноническая база знаний команды?");
  await page.getByLabel("Оба").check({ force: true });
  await expect(page.getByText(/Корпоративные источники \(Confluence Data Center\) не подключены/)).toBeVisible();
  await page.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(page.getByText("Подтверждено источниками")).toBeVisible();
  await expect(page.locator(".scope-status")).toContainText("Не подключено");

  const citation = page.locator(".citation").first();
  await expect(citation).toContainText("Каноническая база знаний команды хранится в отдельном репозитории GitLab");
  await citation.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/documents\/SEM-OVERVIEW-001#/);
  await expect(page.locator(".prose .is-targeted")).toBeVisible();

  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill("Какой SLA у интеграции с ЦФТ?");
  await page.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(page.locator(".confidence")).toHaveText("Недостаточно данных");
  await expect(page.locator(".citations")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("AC-08..AC-10: propose, inspect diff, reject and mark ready without touching the source", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/SEM-PROC-001");
  const revision = await page.locator(".doc-props__revision").getAttribute("title");

  for (const decision of ["reject", "ready"] as const) {
    await page.goto("/proposals/new?document=SEM-PROC-001");
    const editor = page.getByLabel(/Текст документа/);
    const raw = await editor.inputValue();
    await editor.fill(raw.replace("4. Authorized team members decide whether to merge.", "4. Authorized reviewers decide whether to merge."));
    await page.getByLabel("Причина изменения").fill(`E2E ${decision}`);
    await page.getByRole("button", { name: "Создать предложение" }).click();

    const diff = page.getByRole("table", { name: "Изменения построчно" });
    await expect(diff).toContainText("Authorized reviewers decide whether to merge.");
    await expect(page.getByText("Проверка метаданных и содержимого пройдена.")).toBeVisible();

    if (decision === "reject") {
      await page.getByRole("button", { name: "Отклонить" }).click();
      await page.getByRole("button", { name: "Подтвердить отклонение" }).click();
      await expect(page.getByText("Предложение отклонено. Документ не изменён.")).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Отметить «Готово к ревью»" }).click();
      await expect(page.getByText(/отмечено «Готово к ревью»\. Документ не изменён/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Отправить в GitLab" })).toBeDisabled();
    }
  }

  await page.goto("/documents/SEM-PROC-001");
  await expect(page.locator(".doc-props__revision")).toHaveAttribute("title", revision ?? "");
  await expect(page.locator(".doc-head__status")).toContainText("Утверждён");
  expect(problems).toEqual([]);
});

test("Integration status is honest", async ({ page }) => {
  await page.goto("/integrations");
  const gitlab = page.locator(".integration", { hasText: "GitLab (каноническая база знаний)" });
  await expect(gitlab).toContainText("Не подключено");
  await expect(page.locator(".integration", { hasText: "Confluence Data Center (MCP" })).toContainText("Не подключено");
  await expect(page.locator(".integration", { hasText: "AI-провайдер" })).toContainText("Демо (mock)");
  await expect(page.locator(".integration", { hasText: "Система задач" })).toContainText("Не подключено");
});

test("@mobile phone layout has no horizontal scroll and a working menu", async ({ page }) => {
  await page.goto("/documents/SEM-ARCH-001");
  await expect(page.getByRole("heading", { level: 1, name: "Semantic Layer — demonstration architecture" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // UI v2: «Меню» in the page toolbar opens the sidebar as a drawer; a link closes it.
  await page.getByRole("button", { name: "Меню" }).click();
  const drawer = page.getByRole("dialog", { name: "Меню" });
  await drawer.getByRole("navigation", { name: "Основная навигация" }).getByRole("link", { name: "Предложения" }).click();
  await expect(page.getByRole("heading", { name: "Предложения изменений", level: 1 })).toBeVisible();
  await expect(drawer).toBeHidden();
});
