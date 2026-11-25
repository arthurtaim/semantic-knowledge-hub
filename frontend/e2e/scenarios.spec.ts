import { expect, test, type Page } from "@playwright/test";

/*
 * E2E-01…E2E-07, E2E-12 on the offline demo stack (synthetic fixtures, mock AI, no integrations).
 * E2E-08…E2E-11 run against the GitLab TEST DOUBLE in gitlab.spec.ts.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

test("E2E-01 home: the assistant field, quick skills and what waits for a decision", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await expect(page.getByRole("note")).toContainText("Демо-данные.");
  // UI v2 phase C: the start page is the assistant; the team scope is the default.
  await expect(page.getByRole("heading", { name: "Что нужно найти или подготовить?", level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Вопрос" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Где искать: Команда" })).toBeVisible();
  const quick = page.getByRole("group", { name: "Быстрые навыки" });
  for (const name of ["Черновик документа", "Что перепроверить", "Найти связи", "Сравнить с файлом"]) {
    await expect(quick.getByRole("button", { name })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Ждёт вашего решения" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test("E2E-02 search: query, sort by date, empty result", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Поиск" }).click();
  const palette = page.getByRole("dialog", { name: "Спросить или найти" });
  await palette.getByRole("button", { name: "Найти в документах" }).click();
  await palette.getByRole("combobox", { name: "Поиск по базе знаний" }).fill("ревизия");
  await palette.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\?query=/);
  // «Документы» v2: the results are rows of «Список»
  await expect(page.locator(".docs-row").first()).toBeVisible();

  // «Документы» v2: «Таблица» sorts by a header click (the «Вид» menu and «Обновлён» of the old table are gone).
  await page.goto("/documents?view=table");
  const reviewed = page.getByRole("columnheader", { name: "Проверен" });
  await expect(reviewed).toHaveAttribute("aria-sort", "ascending");
  await reviewed.getByRole("button").click();
  await expect(page).toHaveURL(/sort=-reviewed/);
  await expect(reviewed).toHaveAttribute("aria-sort", "descending");
  await page.goto("/documents?query=квазизвездный");
  await expect(page.getByText("По запросу «квазизвездный» ничего не найдено")).toBeVisible();
  expect(problems).toEqual([]);
});

test("E2E-03 document with metadata and provenance", async ({ page }) => {
  await page.goto("/documents/SEM-ARCH-001");
  // UI v2: the key facts under the title, every other former passport field in «Сведения о документе».
  const properties = page.locator(".doc-props");
  for (const text of ["demo-team", "Архитектура", "Локальный workspace", "sha256:"]) {
    await expect(properties).toContainText(text);
  }
  await page.getByRole("button", { name: "Все сведения" }).click();
  const details = page.getByRole("complementary", { name: "Сведения о документе" });
  for (const text of ["SEM-ARCH-001", "Архитектура", "demo-team", "Утверждён", "sha256:", "Дата ревизии"]) {
    await expect(details).toContainText(text);
  }
  await expect(details).toContainText("внешней ссылки нет"); // local workspace: no fake link
  await expect(details.getByRole("link", { name: /ARIS integration/ })).toBeVisible(); // related document
  await expect(page.getByRole("link", { name: "Предложить изменение" })).toBeVisible();
});

test("E2E-04 assistant answer with a verified citation (demo mode)", async ({ page }) => {
  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill("Где хранится каноническая база знаний команды?");
  await page.getByLabel("Вопрос").press("Control+Enter");
  await expect(page.getByText("Подтверждено источниками")).toBeVisible();
  await expect(page.locator(".answer .answer__mode")).toHaveText("Без языковой модели: дословные выдержки");
  // Synthetic fixtures: their origin is one quiet line of the answer, not a warning on every answer.
  await expect(page.locator(".answer .answer__provenance")).toHaveText("Источники: синтетические (учебные)");
  await expect(page.locator(".answer .notice--warning")).toHaveCount(0);
  const citation = page.locator(".source").first();
  await expect(citation).toContainText("Каноническая база знаний команды хранится в отдельном репозитории GitLab");
  await expect(citation).toContainText("Утверждён");
  await expect(citation).toContainText("sha256:");
  await citation.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/documents\/SEM-OVERVIEW-001#/);
});

test("E2E-05 question without evidence → «Недостаточно данных»", async ({ page }) => {
  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill("Какой SLA у интеграции с ЦФТ?");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator(".confidence")).toHaveText("Недостаточно данных");
  await expect(page.getByText("Подтверждений в доступных источниках не найдено.")).toBeVisible();
  await expect(page.locator(".source")).toHaveCount(0);
});

test("E2E-06/07 create a proposal and review the diff; the source stays unchanged", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/SEM-STD-001");
  const revision = await page.locator(".doc-props__revision").getAttribute("title");
  await page.goto("/proposals/new?document=SEM-STD-001");
  const editor = page.getByLabel(/Текст документа/);
  await editor.fill((await editor.inputValue()) + "\nДобавлено правило E2E-06.\n");
  await page.getByLabel("Причина изменения").fill("E2E-06: новое правило оформления");
  await page.getByRole("button", { name: "Создать предложение" }).click();

  await expect(page.getByRole("heading", { name: "Этапы предложения" })).toBeVisible();
  await expect(page.getByText("Исходный документ не изменён — пока существует только предложение.")).toBeVisible();
  const diff = page.getByRole("table", { name: "Изменения построчно" });
  await expect(diff).toContainText("Добавлено правило E2E-06.");
  await page.getByRole("tab", { name: "До и после" }).click();
  await expect(page.getByText("Добавлено правило E2E-06.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Отправить в GitLab" })).toBeDisabled(); // not configured offline

  await page.goto("/documents/SEM-STD-001");
  await expect(page.locator(".doc-props__revision")).toHaveAttribute("title", revision ?? "");
  expect(problems).toEqual([]);
});

test("@mobile E2E-12 phone: home, menu, document and proposal pages fit the screen", async ({ page }) => {
  for (const path of ["/", "/documents", "/documents/SEM-ARCH-001", "/documents/DEMO-SEM-002", "/proposals", "/integrations"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  // Mobile emulation widens the layout viewport to the content, so also check the Markdown body itself:
  // a wide table must scroll inside its own box (DEMO-SEM-002 has a 5-column attribute table).
  await page.goto("/documents/DEMO-SEM-002");
  const prose = page.locator(".prose").first();
  await expect(prose.locator("table").first()).toBeVisible();
  const proseOverflow = await prose.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(proseOverflow, "document body wider than its box").toBeLessThanOrEqual(0);
  await page.goto("/");
  await page.getByRole("button", { name: "Меню" }).click();
  await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("link", { name: "Документы" }).click();
  // UI v2: the catalog is «Документы», as in the sidebar; the toolbar shows the name, the H1 keeps the outline.
  await expect(page.getByRole("heading", { name: "Документы", level: 1 })).toBeAttached();
  await expect(page.locator(".page-toolbar")).toContainText("Документы");
});

test("E2E-13 AI-first entry: Ctrl+K → question → the answer with its sources → the marker opens the cited section", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Спросить или найти" });
  const field = dialog.getByRole("combobox", { name: "Спросить или найти" });
  await expect(field).toBeFocused();
  await field.fill("Где хранится каноническая база знаний команды?");
  await expect(dialog.getByRole("option").first()).toContainText("Спросить ИИ");
  await field.press("Enter");

  await expect(page).toHaveURL(/\/ask\?c=conv-/); // the dialog is named in the URL (chat history)
  await expect(page.getByText("Подтверждено источниками")).toBeVisible();
  await expect(page.locator(".answer .answer__mode")).toHaveText("Без языковой модели: дословные выдержки");
  // UI v2: the quotes are in «Источники» (team documents in their own group), not repeated in the text.
  const sources = page.getByRole("region", { name: "Источники" });
  await expect(sources.getByRole("region", { name: "Документы команды" }).locator(".source").first()).toContainText("Утверждён");

  const marker = page.getByRole("link", { name: "Источник 1" }).first();
  await marker.hover();
  await expect(page.getByRole("tooltip").first()).toContainText("Документы команды");
  await marker.click();
  await expect(page).toHaveURL(/\/documents\/SEM-OVERVIEW-001#/);
  await page.goBack();
  await expect(page.getByText("Подтверждено источниками")).toBeVisible(); // the answer is kept in memory
  expect(problems).toEqual([]);
});
