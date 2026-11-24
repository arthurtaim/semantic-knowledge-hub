import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * Answer provenance (docs/API_CONTRACTS.md «Answer provenance», docs/UI_REDESIGN.md «Происхождение источников»)
 * against the SCRIPTED MODEL double (backend/tests/support/scripted_model.py: «модель данных», «интересны»,
 * «реальные данные»). Selected only when E2E_SCRIPTED_URL is set (projects «scripted» / «scripted-mobile»). The stack
 * serves the synthetic fixtures (LOCAL_CONTENT_IS_DEMO=true): an ordinary answer says so in ONE quiet line — no warning
 * notice on every turn, no mark repeated on every source; asked whether the data are real, the answer discloses it
 * from the catalog's facets, named «По происхождению». The double is not a model: this checks the presentation.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

async function catalogTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get("/api/documents?size=1");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { total: number }).total;
}

async function askFromHome(page: Page, question: string) {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(question);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/ask\?c=conv-/); // the dialog is named in the URL (chat history)
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true }).first()).toBeVisible();
}

async function followUp(page: Page, question: string, answers: number) {
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(question);
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true })).toHaveCount(answers);
}

const answerAt = (page: Page, n: number) => page.locator("section.answer").nth(n);

/** An ordinary answer over synthetic sources: one quiet line, no notice, no per-source repetition. */
async function quietlySynthetic(page: Page, n: number) {
  const answer = answerAt(page, n);
  await expect(answer.locator(".answer__provenance")).toHaveText("Источники: синтетические (учебные)");
  await expect(answer.locator(".notice--warning")).toHaveCount(0);
  await expect(answer.locator(".source-origin")).toHaveCount(0);
  await expect(answer).not.toContainText("Используются только демо-документы");
  await expect(answer.getByRole("region", { name: "Источники" }).locator(".source").first()).toBeVisible();
}

test("«Какая у нас модель данных?», then «нам интересны демо-файлы»: answers with one provenance line, no banner", async ({ page }) => {
  const problems = watch(page);
  await askFromHome(page, "Какая у нас модель данных?");
  await quietlySynthetic(page, 0);
  // The AI mode is a separate thing, said in the head: it names the provider (internal model or the personal Claude
  // Code CLI — the scripted double runs behind either transport) and never calls synthetic content «демо».
  const mode = answerAt(page, 0).locator(".answer__mode");
  await expect(mode).toContainText(/Внутренняя модель|Claude Code CLI/);
  await expect(mode).not.toContainText(/демо/i);

  await followUp(page, "нам интересны демо-файлы", 2);
  await quietlySynthetic(page, 1);
  expect(problems).toEqual([]);
});

test("«Это реальные данные банка?» — disclosed from the catalog: «По происхождению», named, counted like the API", async ({ page, request }) => {
  const total = await catalogTotal(request);
  await askFromHome(page, "Это реальные данные банка?");
  const answer = answerAt(page, 0);
  await expect(answer.locator(".answer__text")).toContainText("синтетические");
  const card = answer.getByRole("region", { name: "Данные системы SKH" }).getByRole("listitem").first();
  const row = card.locator(".fact__breakdown div", { has: page.locator("dt", { hasText: "По происхождению" }) });
  await expect(row.locator("dd")).toHaveText(`синтетические ${total.toLocaleString("ru-RU")}`);
  await expect(card).not.toContainText("provenance");
  // A bare catalog breakdown cites no document: the answer makes no per-answer provenance claim.
  await expect(answer.locator(".answer__provenance")).toHaveCount(0);
  await expect(answer.locator(".notice--warning")).toHaveCount(0);
});

test("@mobile the provenance line fits the phone screen", async ({ page }) => {
  await askFromHome(page, "Какая у нас модель данных?");
  await quietlySynthetic(page, 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
