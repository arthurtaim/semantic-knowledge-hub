import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 phase C (docs/ui-v2/specs/02_ASSISTANT.md): the assistant field on the offline demo stack (AI_PROVIDER=mock)
 * and, when E2E_DISABLED_URL points at a stack with AI_PROVIDER=disabled, the same field as a search box.
 * The attached file is synthetic and built in the test; «Новый диалог» deletes it again.
 */

const SYNTHETIC_CSV = [
  "aris_object_guid;aris_object_name;aris_model_path;aris_owner_role;aris_last_change;aris_status;aris_comment",
  "guid-demo-9001;Синтетический процесс;Демо-модель/Тест;process-owner-demo;2026-11-01T10:00:00+03:00;released;вымышленная строка",
].join("\n");

const DISABLED_URL = process.env.E2E_DISABLED_URL;

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

test("C-01 a skill via «/», a document via «@», a csv → «Сравнить с файлом» answers with Ф1 in «Вложения этого диалога»", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });

  // «/» at the start of the line opens the skill registry; typing filters, Enter chooses.
  await field.pressSequentially("/сравн");
  const skills = page.getByRole("listbox", { name: "Навыки" });
  await expect(skills.getByRole("option", { name: /Сравнить с файлом/ })).toContainText("чтение");
  await field.press("Enter");
  await expect(page.getByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeVisible();
  await expect(field).toHaveValue("");

  // «@» searches the knowledge base; the chosen document becomes a chip (context).
  await field.pressSequentially("@маппинг");
  const documents = page.getByRole("listbox", { name: "Документы" });
  await expect(documents.getByRole("option").first()).toContainText("DEMO-");
  await field.press("Enter");
  await expect(page.getByRole("button", { name: /^Убрать документ «/ })).toBeVisible();

  // A synthetic file: «Читаю…», then ready with the server's summary.
  await page.setInputFiles('input[type="file"]', {
    name: "aris_export_synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(SYNTHETIC_CSV, "utf-8"),
  });
  const chips = page.getByRole("list", { name: "Приложено к сообщению" });
  await expect(chips).toContainText(/2 строки/);

  await field.fill("Что отправляет ARIS в каталог? Совпадает ли выгрузка с маппингом?");
  await field.press("Enter");
  await expect(page).toHaveURL(/\/ask\?q=/);
  const dialog = page.getByRole("region", { name: "Диалог" });
  await expect(dialog.getByRole("list", { name: "Приложено к сообщению" })).toContainText("Сравнить с файлом");
  await expect(dialog.getByRole("list", { name: "Приложено к сообщению" })).toContainText("aris_export_synthetic.csv");
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true })).toBeVisible();

  const files = page.getByRole("region", { name: "Источники" }).getByRole("region", { name: "Вложения этого диалога" });
  await expect(files).toContainText("aris_export_synthetic.csv, строка 1");
  await expect(files).toContainText("Файл виден только в этом диалоге и не попадает в базу знаний.");
  const marker = page.locator(".answer__text").getByRole("link", { name: "Источник Ф1" });
  await expect(marker).toHaveText("Ф1");
  await marker.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Вложение этого диалога" })).toBeVisible();

  // The skill and the file stay as chips; «Новый диалог» clears them (the file is deleted on the server).
  await expect(page.getByRole("button", { name: "Убрать файл «aris_export_synthetic.csv»" })).toBeVisible();
  await page.getByRole("button", { name: "Новый диалог" }).click();
  await expect(page.getByRole("button", { name: "Убрать файл «aris_export_synthetic.csv»" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("C-02 the field refuses an unsupported file without uploading it; a draft skill gives a proposal card", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  // The drop goes to the rendered form: on a cold dev server `querySelector` could still find nothing.
  await expect(page.getByRole("textbox", { name: "Вопрос" })).toBeVisible();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["not a diagram"], "scheme.vsdx"));
    document.querySelector("form.composer")?.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("list", { name: "Приложено к сообщению" })).toContainText("формат не поддерживается");
  await page.getByRole("button", { name: "Убрать файл «scheme.vsdx»" }).click();

  await page.getByRole("group", { name: "Быстрые навыки" }).getByRole("button", { name: "Черновик документа" }).click();
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill("Черновик интеграции синтетического реестра с каталогом");
  await field.press("Enter");
  const card = page.getByRole("region", { name: /^Предложение ИИ:/ });
  await expect(card).toContainText("Ничего не применено");
  await card.getByRole("button", { name: "Открыть предложение" }).click();
  await expect(card.locator(".ai-proposal")).toBeVisible();
  expect(problems).toEqual([]);
});

test("@mobile C-03 the field on a phone: icons, the skill list and chips fit without horizontal scroll", async ({ page }) => {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await page.getByRole("button", { name: "Навык", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Навыки" })).toBeVisible();
  await field.press("Escape");
  await page.getByRole("group", { name: "Быстрые навыки" }).getByRole("button", { name: "Найти связи" }).click();
  await expect(page.getByRole("button", { name: "Убрать навык «Найти связи»" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // «Найти связи» needs a document or a question (the server checks it): give it a question.
  await field.fill("ARIS и каталог");
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true })).toBeVisible();
  const after = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(after).toBeLessThanOrEqual(0);
});

for (const [name, tag] of [["C-04", ""], ["C-05", "@mobile "]] as const) {
  test(`${tag}${name} AI_PROVIDER=disabled: the field is a knowledge-base search without file or skill controls`, async ({ page }) => {
    test.skip(!DISABLED_URL, "E2E_DISABLED_URL (a stack with AI_PROVIDER=disabled) is not set");
    await page.goto(`${DISABLED_URL}/`);
    await expect(page.getByRole("heading", { name: "Что нужно найти?", level: 1 })).toBeVisible();
    const field = page.getByRole("textbox", { name: "Поиск по базе знаний" });
    await expect(field).toHaveAttribute("placeholder", "Найти в базе знаний");
    await expect(page.getByRole("button", { name: "Файл" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Навык", exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Быстрые навыки" })).toHaveCount(0);
    await field.fill("ARIS");
    await expect(page.getByRole("listbox", { name: "Подсказки" }).getByRole("option").first()).toBeVisible();
    await field.press("Enter");
    await expect(page).toHaveURL(/\/documents\?query=ARIS$/);

    await page.goto(`${DISABLED_URL}/ask`);
    await expect(page.getByRole("heading", { name: "Спросить базу знаний", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Отправить" })).toHaveCount(0);
  });
}
