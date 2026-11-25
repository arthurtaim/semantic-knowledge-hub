import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 round 2, decision 8, on the offline demo stack (AI_PROVIDER=mock), since the chat history (docs/API_CONTRACTS.md
 * v0.7): a recent dialog reopens as it was — its stored answers, never asked again — and its field keeps the skill,
 * the dialog and its files: a file the server still keeps is sent again in the same dialog; a deleted or expired one
 * is a grey chip «файл больше недоступен» that is never sent. The attached file is synthetic and built in the test.
 */

const SYNTHETIC_CSV = [
  "aris_object_guid;aris_object_name;aris_model_path;aris_owner_role;aris_last_change;aris_status;aris_comment",
  "guid-demo-9101;Синтетический процесс;Демо-модель/Тест;process-owner-demo;2026-11-01T10:00:00+03:00;released;вымышленная строка",
].join("\n");
const FILE = "aris_recent_synthetic.csv";
const QUESTION = "Совпадает ли синтетическая выгрузка с маппингом ARIS?";

function watch(page: Page, allowed: RegExp[] = []): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !allowed.some((re) => re.test(msg.text()))) problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

/** «Сравнить с файлом» with a synthetic csv and a question, from the home page; waits for the answer. */
async function askWithFile(page: Page) {
  await page.goto("/");
  await page.getByRole("group", { name: "Быстрые навыки" }).getByRole("button", { name: "Сравнить с файлом" }).click();
  await page.setInputFiles('input[type="file"]', { name: FILE, mimeType: "text/csv", buffer: Buffer.from(SYNTHETIC_CSV, "utf-8") });
  await expect(page.getByRole("list", { name: "Приложено к сообщению" })).toContainText(/2 строки/);
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(QUESTION);
  await field.press("Enter");
  await expect(page.getByRole("region", { name: "Источники" }).getByRole("region", { name: "Вложения этого диалога" })).toContainText(FILE);
}

function countAsks(page: Page): { n: number } {
  const asks = { n: 0 };
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/assistant\/ask(\/stream)?$/.test(request.url())) asks.n += 1;
  });
  return asks;
}

async function reopenNewest(page: Page) {
  await page.goto("/");
  const recent = page.getByRole("region", { name: "Недавние диалоги" });
  await recent.getByRole("link", { name: new RegExp(QUESTION.slice(0, 20)) }).first().click();
  await expect(page).toHaveURL(/\/ask\?c=conv-[0-9a-f]{24}$/);
}

const composerChips = (page: Page) => page.locator(".composer__chips");
const fileChip = (page: Page) => composerChips(page).locator(".chip").filter({ hasText: FILE });
const files = (page: Page) => page.getByRole("region", { name: "Источники" }).getByRole("region", { name: "Вложения этого диалога" });

test("R2-02 a reopened dialog shows its answer, never asked again; its skill and live file continue it", async ({ page }) => {
  const problems = watch(page);
  const asks = countAsks(page);
  await askWithFile(page);
  await reopenNewest(page);

  // The stored answer, as it was — no new request.
  await expect(page.getByRole("region", { name: "Диалог", exact: true })).toContainText(QUESTION);
  await expect(files(page).first()).toContainText(FILE);
  expect(asks.n).toBe(1);
  // The field continues the dialog: the skill and the live file stay as chips, the answered question does not.
  await expect(page.getByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeVisible();
  await expect(fileChip(page)).toContainText("2 строки");
  await expect(fileChip(page)).not.toHaveClass(/chip--unavailable/);
  await expect(page.getByRole("textbox", { name: "Вопрос" })).toHaveValue("");

  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill("Есть ли в выгрузке синтетический процесс?");
  await field.press("Enter");
  await expect(files(page)).toHaveCount(2); // the server found the file in the same dialog again
  await expect(files(page).nth(1).getByText(/^Источник Ф1$/)).toHaveCount(1);
  expect(asks.n).toBe(2);
  expect(problems).toEqual([]);
});

test("R2-03 a file deleted on the server comes back grey after a reload and is never sent", async ({ page }) => {
  const problems = watch(page);
  await askWithFile(page);
  // Removing the chip deletes the file on the server (the stored answer keeps its name).
  const deleted = page.waitForRequest((r) => r.method() === "DELETE" && /\/api\/assistant\/attachments\//.test(r.url()));
  await page.getByRole("button", { name: `Убрать файл «${FILE}»` }).click();
  await deleted;

  await page.reload(); // this tab's memory is gone: the field comes from the stored dialog
  await expect(page.getByRole("region", { name: "Диалог", exact: true })).toContainText(QUESTION);
  await expect(fileChip(page)).toHaveClass(/chip--unavailable/);
  await expect(fileChip(page)).toContainText("файл больше недоступен");
  await expect(page.getByText("Навыку «Сравнить с файлом» нужен файл")).toBeVisible();
  await expect(page.getByRole("button", { name: "Отправить" })).toBeDisabled();
  expect(problems).toEqual([]);
});

test("R2-04 a skill run without a question reopens with its proposal, its skill and its document", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.pressSequentially("/кратко");
  await field.press("Enter");
  await field.pressSequentially("@ARIS");
  await expect(page.getByRole("listbox", { name: "Документы" }).getByRole("option").first()).toBeVisible();
  await field.press("Enter");
  const documentChip = page.getByRole("button", { name: /^Убрать документ «/ });
  await expect(documentChip).toBeVisible();
  const documentName = ((await documentChip.getAttribute("aria-label")) ?? "").replace(/^Убрать документ «|»$/g, "");
  await field.press("Enter"); // «Кратко пересказать» runs without a question
  await expect(page.getByRole("region", { name: /^Предложение ИИ:/ })).toBeVisible();

  await page.goto("/");
  const row = page.locator(".assistant-home__row").filter({ hasText: "Кратко пересказать" }).first();
  await expect(row).toHaveAttribute("href", /^\/ask\?c=conv-[0-9a-f]{24}$/);
  await row.click();
  // The stored proposal card, never run again; the field keeps the skill and its document for the next message.
  await expect(page.getByRole("region", { name: /^Предложение ИИ:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Убрать навык «Кратко пересказать»" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Убрать документ «${documentName}»` })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Вопрос" })).toHaveValue("");
  expect(problems).toEqual([]);
});
