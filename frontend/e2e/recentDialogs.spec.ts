import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 round 2, decision 8, on the offline demo stack (AI_PROVIDER=mock): a recent dialog reopens with its skill,
 * its dialog and its files — a file the server still keeps is sent again in the same dialog; an expired or
 * deleted one is a grey chip «файл больше недоступен» that is never sent (also after `attachment_not_found`).
 * The attached file is synthetic and built in the test.
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

interface Patch {
  entry?: Record<string, unknown>;
  file?: Record<string, unknown>;
}

/** Changes the newest recent dialog (and its first file) in this browser's storage. */
async function editNewest(page: Page, patch: Patch) {
  await page.evaluate(({ entry, file }: Patch) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("skh.recent-questions.v1:"));
    if (!key) throw new Error("no recent dialogs");
    const entries = JSON.parse(localStorage.getItem(key) ?? "[]") as { attachments: Record<string, unknown>[] }[];
    const newest = entries[0];
    if (!newest) throw new Error("no recent dialogs");
    Object.assign(newest, entry ?? {});
    Object.assign(newest.attachments[0] ?? {}, file ?? {});
    localStorage.setItem(key, JSON.stringify(entries));
  }, patch);
}

async function reopenNewest(page: Page) {
  await page.goto("/");
  const recent = page.getByRole("region", { name: "Недавние диалоги" });
  await recent.getByRole("link", { name: new RegExp(QUESTION.slice(0, 20)) }).first().click();
  await expect(page).toHaveURL(/\/ask$/);
}

const composerChips = (page: Page) => page.locator(".composer__chips");
const fileChip = (page: Page) => composerChips(page).locator(".chip").filter({ hasText: FILE });

test("R2-02 a reopened dialog brings back its skill and its live file, in the same dialog: Enter answers from the file again", async ({ page }) => {
  const problems = watch(page);
  await askWithFile(page);
  await reopenNewest(page);

  await expect(page.getByRole("button", { name: "Убрать навык «Сравнить с файлом»" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Вопрос" })).toHaveValue(QUESTION);
  await expect(fileChip(page)).toContainText("2 строки");
  await expect(fileChip(page)).not.toHaveClass(/chip--unavailable/);
  await expect(page.getByRole("region", { name: "Диалог" })).toHaveCount(0); // nothing ran by itself

  await page.getByRole("textbox", { name: "Вопрос" }).press("Enter");
  const files = page.getByRole("region", { name: "Источники" }).getByRole("region", { name: "Вложения этого диалога" });
  await expect(files).toContainText(FILE); // the server found the file in the restored dialog
  await expect(files.getByText(/^Источник Ф1$/)).toHaveCount(1);
  expect(problems).toEqual([]);
});

test("R2-03 an expired file comes back grey and is not sent; a deleted one too, also when only the server knows", async ({ page }) => {
  // The last step provokes `404 attachment_not_found` on purpose: the browser logs that response.
  const problems = watch(page, [/status of 404/]);
  await askWithFile(page);

  // Expired (past `expires_at`): grey, and the skill that needs a file says so instead of sending.
  await editNewest(page, { file: { expires_at: "2020-01-01T00:00:00Z" } });
  await reopenNewest(page);
  await expect(fileChip(page)).toHaveClass(/chip--unavailable/);
  await expect(fileChip(page)).toContainText("файл больше недоступен");
  await expect(page.getByText("Навыку «Сравнить с файлом» нужен файл")).toBeVisible();
  await expect(page.getByRole("button", { name: "Отправить" })).toBeDisabled();

  // «Новый диалог» deletes the dialog's files on the server — the recent dialog then shows the file as unavailable.
  await editNewest(page, { file: { expires_at: "2099-01-01T00:00:00Z" } });
  await reopenNewest(page);
  await expect(fileChip(page)).not.toHaveClass(/chip--unavailable/);
  await page.getByRole("button", { name: "Новый диалог" }).click();
  await reopenNewest(page);
  await expect(fileChip(page)).toHaveClass(/chip--unavailable/);

  // The server alone knows the file is gone (this browser forgot): the answer is `attachment_not_found`, the chip
  // turns grey and the next send goes without it.
  await editNewest(page, { entry: { skill: null, skill_id: null }, file: { gone: false } });
  await reopenNewest(page);
  await expect(fileChip(page)).not.toHaveClass(/chip--unavailable/);
  await page.getByRole("textbox", { name: "Вопрос" }).press("Enter");
  await expect(page.getByRole("region", { name: "Диалог" })).toContainText("Файл больше недоступен");
  await expect(fileChip(page)).toHaveClass(/chip--unavailable/);
  const resent = page.waitForRequest((r) => r.url().endsWith("/api/assistant/ask/stream") && r.method() === "POST");
  await page.getByRole("textbox", { name: "Вопрос" }).press("Enter");
  expect((await resent).postDataJSON()).not.toHaveProperty("attachment_ids");
  expect(problems).toEqual([]);
});

test("R2-04 a skill run without a question is a link: it reopens the skill and its document with an empty field", async ({ page }) => {
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
  await expect(row).toHaveAttribute("href", "/ask");
  await row.click();
  await expect(page.getByRole("button", { name: "Убрать навык «Кратко пересказать»" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Убрать документ «${documentName}»` })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Вопрос" })).toHaveValue("");
  await expect(page.getByRole("region", { name: "Диалог" })).toHaveCount(0);
  expect(problems).toEqual([]);
});
