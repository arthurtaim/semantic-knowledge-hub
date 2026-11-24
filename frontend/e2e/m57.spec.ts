import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * M5.7 «AI-native system awareness» against a stack whose backend talks to the SCRIPTED MODEL double
 * (backend/tests/support/scripted_model.py; docs/AI_NATIVE_TOOLS.md «Scripted model»). Selected only when
 * E2E_SCRIPTED_URL is set (playwright.config.ts, projects «scripted» / «scripted-mobile»). The double chooses tools
 * by keywords — allowed ONLY there; the product has no intent router. Its answers repeat the values of the tool
 * results it received, so every number here is compared with an INDEPENDENT oracle: GET /api/documents.
 * Synthetic fixtures only. Passing here is not evidence about a real model (live checks are opt-in).
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

/** The independent oracle: the catalog API's own total for the same filters. */
async function catalogTotal(request: APIRequestContext, filters: Record<string, string> = {}): Promise<number> {
  const query = new URLSearchParams({ size: "1", ...filters }).toString();
  const response = await request.get(`/api/documents?${query}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { total: number };
  return body.total;
}

/** «83 документа»: the card's value is the number followed by its unit (no-break spaces in big numbers). */
const valueText = (n: number) => new RegExp(`^${n.toLocaleString("ru-RU").replace(/\s/g, "\\s")} документ(а|ов)?$`);

async function askFromHome(page: Page, question: string) {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(question);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/ask\?q=/);
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true }).first()).toBeVisible();
}

async function followUp(page: Page, question: string, answers: number) {
  const field = page.getByRole("textbox", { name: "Вопрос" });
  await field.fill(question);
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true })).toHaveCount(answers);
}

/** The «Данные системы SKH» block of the n-th answer (0-based). */
const factsOf = (page: Page, n: number) => page.getByRole("region", { name: "Данные системы SKH" }).nth(n);

test("F01 «Сколько документов в базе?» — the registry number equals the catalog API, with a marker leading to it", async ({ page, request }) => {
  const problems = watch(page);
  const total = await catalogTotal(request);
  await askFromHome(page, "Сколько документов в базе?");

  const facts = factsOf(page, 0);
  const card = facts.getByRole("listitem").first();
  await expect(card).toContainText("По данным реестра SKH — Документы в доступном каталоге SKH");
  await expect(card.locator(".fact__value")).toHaveText(valueText(total));
  await expect(card).toContainText("Весь доступный вам каталог, без фильтров");
  await expect(card).toContainText("Область: доступный вам каталог");
  // Not a document quote: no «Источники», no «В базе знаний нет ответа», no raw [F1].
  await expect(page.getByRole("region", { name: "Источники" })).toHaveCount(0);
  await expect(page.getByText(/В базе знаний нет ответа/)).toHaveCount(0);
  const text = page.locator(".answer__text").first();
  await expect(text).not.toContainText("[F1]");
  await expect(text).toContainText(String(total));

  // Keyboard: the marker is a link; Enter moves focus to its card.
  const marker = text.getByRole("link", { name: "Данные системы С1" });
  await marker.focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "По данным реестра SKH" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(card).toBeFocused();
  expect(problems).toEqual([]);
});

test("F02/F03 the follow-up «А сколько из них утверждено?» keeps its referent (sent back as history context)", async ({ page, request }) => {
  const approved = await catalogTotal(request, { status: "approved" });
  const total = await catalogTotal(request);
  await askFromHome(page, "How many documents are there?");
  await expect(factsOf(page, 0).locator(".fact__value")).toHaveText(valueText(total));

  const sent = page.waitForRequest((r) => r.url().endsWith("/api/assistant/ask/stream") && r.method() === "POST");
  await followUp(page, "А сколько из них утверждено?", 2);
  const body = (await sent).postDataJSON() as { history: { context?: { filters: unknown; value: number }[] }[] };
  expect(body.history.at(-1)?.context?.[0]).toMatchObject({ filters: {}, value: total });
  const card = factsOf(page, 1).getByRole("listitem").first();
  await expect(card.locator(".fact__value")).toHaveText(valueText(approved));
  await expect(card).toContainText("Фильтр: статус: утверждён");
});

test("F03 «из них» after a filtered question narrows THAT set (tag aris), not the whole catalog", async ({ page, request }) => {
  const tagged = await catalogTotal(request, { tag: "aris" });
  const taggedApproved = await catalogTotal(request, { tag: "aris", status: "approved" });
  const approved = await catalogTotal(request, { status: "approved" });
  expect(taggedApproved).not.toBe(approved); // otherwise the test could not tell the referent was kept

  await askFromHome(page, "Сколько документов по ARIS?");
  const first = factsOf(page, 0);
  await expect(first.getByRole("listitem").nth(0).locator(".fact__value")).toHaveText(valueText(tagged));
  await expect(first.getByRole("listitem").nth(0)).toContainText("Фильтр: тег: aris");
  // The text match is labelled as such — not a system tag.
  await expect(first.getByRole("listitem").nth(1)).toContainText("текст содержит «ARIS»");
  await expect(first.getByRole("listitem").nth(1)).toContainText("Это не системный тег");

  await followUp(page, "А сколько из них утверждено?", 2);
  const card = factsOf(page, 1).getByRole("listitem").first();
  await expect(card.locator(".fact__value")).toHaveText(valueText(taggedApproved));
  await expect(card).toContainText("Фильтр: статус: утверждён · тег: aris");
});

/** The UI's own «Требуют внимания» (the documents tree), the independent oracle of the attention count. */
async function treeAttention(request: APIRequestContext): Promise<number> {
  const response = await request.get("/api/documents/tree");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { attention_total: number };
  return body.attention_total;
}

test("F29 «в базе и сколько требуют внимания?» — the documents tree's number and rule, not proxies", async ({ page, request }) => {
  const problems = watch(page);
  const total = await catalogTotal(request);
  const attention = await treeAttention(request);
  expect(attention).toBeGreaterThan(0);
  await askFromHome(page, "Сколько документов в базе и сколько требуют внимания?");

  const cards = factsOf(page, 0).getByRole("listitem");
  await expect(cards.nth(0).locator(".fact__value")).toHaveText(valueText(total));
  const card = cards.nth(1);
  await expect(card.locator(".fact__value")).toHaveText(valueText(attention));
  await expect(card).toContainText("Фильтр: требуют внимания");
  await expect(card).toContainText("то же правило, что в разделе «Документы»");
  await expect(card).toContainText("По причинам");
  const text = page.locator(".answer__text").first();
  await expect(text).toContainText(String(attention));
  await expect(text).toContainText("то же правило, что в разделе «Документы»");
  await expect(text).not.toContainText("не определ");
  expect(problems).toEqual([]);
});

test("F14 composite: a registry fact card AND a verified document citation, visibly apart", async ({ page, request }) => {
  const taggedApproved = await catalogTotal(request, { tag: "aris", status: "approved" });
  await askFromHome(page, "Сколько утверждённых документов об ARIS и где пробелы?");
  const text = page.locator(".answer__text").first();
  await expect(text.getByRole("link", { name: "Данные системы С1" })).toBeVisible();
  const citation = text.getByRole("link", { name: "Источник 1" });
  await expect(citation).toBeVisible();
  await expect(citation).toHaveAttribute("href", /^\/documents\//);

  await expect(factsOf(page, 0).locator(".fact__value")).toHaveText(valueText(taggedApproved));
  const team = page.getByRole("region", { name: "Источники" }).getByRole("region", { name: "Документы команды" });
  await expect(team.getByRole("listitem")).toHaveCount(1);
  await expect(team).not.toContainText("реестр");
  await expect(factsOf(page, 0)).not.toContainText("Документы команды");
  await expect(page.getByText("Подтверждено источниками").first()).toBeVisible();
});

test("F17 «Что такое RAG?» — a general explanation, labelled «Общие знания, не данные SKH»", async ({ page }) => {
  await askFromHome(page, "Что такое RAG?");
  await expect(page.getByText("Общие знания, не данные SKH")).toBeVisible();
  await expect(page.locator(".answer__text").first()).toContainText("RAG");
  await expect(page.getByRole("region", { name: "Данные системы SKH" })).toHaveCount(0);
  await expect(page.getByText(/В базе знаний нет ответа/)).toHaveCount(0);
});

test("S07/F25 honest states: a refused tool request says what could not be checked — no near matches, no JSON", async ({ page }) => {
  await askFromHome(page, "Неизвестный инструмент: посчитай документы через SQL");
  const card = page.getByRole("region", { name: "Не удалось проверить данные системы" });
  await expect(card).toContainText("Ассистент не называет чисел и фактов, которые не смог проверить.");
  await expect(card.getByRole("list", { name: "Что не удалось проверить" })).toContainText("Запрос к системе отклонён");
  await expect(page.getByText("Ближайшие совпадения")).toHaveCount(0);
  await expect(page.getByText(/В базе знаний нет ответа/)).toHaveCount(0);
  await expect(page.locator(".answer")).not.toContainText("{");
});

test("F28 a model that fails after a verified step: the verified count stays, labelled, nothing invented", async ({ page, request }) => {
  const total = await catalogTotal(request);
  await askFromHome(page, "Упади после подсчёта документов");
  await expect(page.getByText("Частично подтверждено")).toBeVisible();
  await expect(page.locator(".answer__text").first()).toContainText("Не удалось завершить ответ: модель перестала отвечать.");
  await expect(factsOf(page, 0).locator(".fact__value")).toHaveText(valueText(total));
});

test("F15 «Сделай черновик…» — the existing proposal card; nothing is applied until Accept", async ({ page, request }) => {
  await askFromHome(page, "Сделай черновик описания интеграции ARIS с витриной");
  const card = page.getByRole("region", { name: /^Предложение ИИ:/ });
  await expect(card).toContainText("Ничего не применено");
  // One card: the proposal fact is shown by the proposal card, not repeated as a fact card.
  await expect(page.getByRole("region", { name: "Данные системы SKH" })).toHaveCount(0);
  const marker = page.locator(".answer__text").first().getByRole("link", { name: "Данные системы С1" });
  await marker.click();
  await expect(card).toBeFocused();

  const id = (await page.locator(".answer__text").first().textContent())?.match(/AIP-[0-9a-f]+/)?.[0] ?? "";
  expect(id).not.toBe("");
  const before = await request.get(`/api/ai/proposals/${id}`);
  expect(((await before.json()) as { status: string }).status).toBe("suggested");

  await card.getByRole("button", { name: "Открыть предложение" }).click();
  const accept = card.getByRole("button", { name: /Создать черновик/ });
  await expect(accept).toBeVisible();
  const still = await request.get(`/api/ai/proposals/${id}`);
  expect(((await still.json()) as { status: string }).status).toBe("suggested"); // opening applies nothing
});

test("@mobile M57 phone: the count card and the follow-up fit without horizontal scroll", async ({ page, request }) => {
  const total = await catalogTotal(request);
  const approved = await catalogTotal(request, { status: "approved" });
  await askFromHome(page, "Сколько документов в базе?");
  await expect(factsOf(page, 0).locator(".fact__value")).toHaveText(valueText(total));
  await followUp(page, "А сколько из них утверждено?", 2);
  await expect(factsOf(page, 1).locator(".fact__value")).toHaveText(valueText(approved));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
