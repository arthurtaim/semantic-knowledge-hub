import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 phase D (docs/ui-v2/specs/03_SCREENS.md §3, design-04): the assistant panel of a document and the floating
 * bar over a selection, on the offline demo stack (AI_PROVIDER=mock); with E2E_DISABLED_URL (AI_PROVIDER=disabled)
 * neither exists. Synthetic documents only.
 */

const DISABLED_URL = process.env.E2E_DISABLED_URL;
const SENTENCE = "A document always has a stable ID and an approval status.";

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test("D-01 the assistant panel answers a question about the document with a citation", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/SEM-ARCH-001");
  const toggle = page.getByRole("button", { name: "Ассистент", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  const panel = page.getByRole("complementary", { name: "Ассистент" });
  await expect(panel.getByRole("region", { name: "Контекст" })).toContainText("Этот документ");
  await expect(panel.getByRole("list", { name: "Быстрые действия" })).toContainText("Что перепроверить");
  const field = panel.getByRole("textbox", { name: "Вопрос по документу" });
  await expect(field).toBeFocused();
  await field.fill("Где ещё требуется стабильный ID?");
  await field.press("Enter");

  const answer = panel.getByRole("region", { name: "Переписка" }).getByRole("region", { name: "Ассистент" });
  await expect(answer).toBeVisible();
  // The mode (no language model) and, apart from it, the origin of the sources (synthetic fixtures).
  await expect(answer.getByText("Без модели", { exact: true })).toBeVisible();
  await expect(answer.locator(".answer__provenance")).toHaveText("Источники: синтетические (учебные)");
  const marker = answer.locator(".answer__text").getByRole("link", { name: "Источник 1" });
  await expect(marker).toHaveAttribute("href", /^\/documents\/SEM-ARCH-001#/);
  await expect(answer.getByRole("region", { name: "Источники" }).getByRole("region", { name: "Документы команды" })).toBeVisible();

  // ⌘J / Ctrl+J from the panel's own field closes it; the state is remembered for the next visit.
  await field.press("Control+KeyJ");
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Ассистент" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("D-02 a selected sentence → «Объяснить» answers in the panel with the selection as context", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/SEM-ARCH-001");
  await page.locator("#doc-panel .prose").getByText(SENTENCE).click({ clickCount: 3 });
  const bar = page.getByRole("toolbar", { name: "Действия с выделением" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveText(["Объяснить", "Найти связанные"]);
  // The AI cannot rewrite in the demo: «Предложить правку» is the manual change editor.
  await expect(bar.getByRole("link", { name: "Предложить правку" })).toHaveAttribute("href", "/proposals/new?document=SEM-ARCH-001");

  const request = page.waitForRequest((req) => req.url().endsWith("/api/assistant/ask/stream") && req.method() === "POST");
  await bar.getByRole("button", { name: "Объяснить" }).click();
  const sent = (await request).postDataJSON() as { skill_id: string; selection: { section_anchor: string; text: string } };
  expect(sent.skill_id).toBe("explain");
  expect(sent.selection.section_anchor).toBe("principles");
  expect(sent.selection.text.trim()).toBe(SENTENCE);

  const panel = page.getByRole("complementary", { name: "Ассистент" });
  await expect(panel.getByRole("region", { name: "Контекст" })).toContainText("Выделение: 1 строка");
  const conversation = panel.getByRole("region", { name: "Переписка" });
  await expect(conversation.getByRole("list", { name: "Приложено к сообщению" })).toContainText("Выделение: 1 строка");
  const answer = conversation.getByRole("region", { name: "Ассистент" });
  await expect(answer.getByText("Подтверждено источниками")).toBeVisible();
  await expect(answer.getByRole("region", { name: "Источники" })).toContainText(SENTENCE);
  expect(problems).toEqual([]);
});

test("D-03 the bar is reached with Alt+F10, moves with arrows, closes with Esc; a drag shows it only on release", async ({ page }) => {
  await page.goto("/documents/SEM-ARCH-001");
  const bar = page.getByRole("toolbar", { name: "Действия с выделением" });
  const words = await page.locator("#doc-panel .prose").getByText("Actual corporate systems").boundingBox();
  if (!words) throw new Error("no text box");
  await page.mouse.move(words.x + 1, words.y + words.height / 2);
  await page.mouse.down();
  await page.mouse.move(words.x + 60, words.y + words.height / 2, { steps: 4 });
  await expect(bar).toBeHidden();
  await page.mouse.up();
  await expect(bar).toBeVisible();
  // Shift+arrows extend the selection; the bar follows it.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(bar).toBeVisible();

  await page.keyboard.press("Alt+F10");
  await expect(bar.getByRole("button", { name: "Объяснить" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(bar.getByRole("button", { name: "Найти связанные" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect(page.locator(".doc-text")).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);

  // Not for a selection outside the text.
  await page.locator(".doc-head__title").click({ clickCount: 3 });
  await expect(bar).toBeHidden();
});

test("@mobile D-04 on a phone the panel is a bottom sheet without horizontal scroll", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/SEM-ARCH-001");
  await page.getByRole("button", { name: "Ассистент", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Ассистент" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Закрыть: Ассистент" })).toBeFocused();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  // Docked to the bottom edge once it has slid up.
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    return box ? Math.round(box.y + box.height) : null;
  }).toBe(viewport.height);
  expect((await sheet.boundingBox())?.width).toBeLessThanOrEqual(viewport.width);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await sheet.getByRole("button", { name: "Найти связанные" }).click();
  await expect(sheet.getByRole("region", { name: "Переписка" }).getByRole("region", { name: "Ассистент" })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(problems).toEqual([]);
});

for (const [name, tag] of [["D-05", ""], ["D-06", "@mobile "]] as const) {
  test(`${tag}${name} AI_PROVIDER=disabled: no assistant button, panel, ⌘J or selection bar`, async ({ page }) => {
    test.skip(!DISABLED_URL, "E2E_DISABLED_URL (a stack with AI_PROVIDER=disabled) is not set");
    await page.goto(`${DISABLED_URL}/documents/SEM-ARCH-001`);
    await expect(page.locator(".doc-head__title")).toHaveText("Semantic Layer — demonstration architecture");
    await expect(page.getByRole("button", { name: "Ассистент", exact: true })).toHaveCount(0);
    await page.keyboard.press("Control+KeyJ");
    await expect(page.getByRole("complementary", { name: "Ассистент" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Ассистент" })).toHaveCount(0);
    await page.locator("#doc-panel .prose").getByText(SENTENCE).click({ clickCount: 3 });
    await expect(page.locator('[role="toolbar"][aria-label="Действия с выделением"]')).toHaveCount(0);
    // The page stays complete: the manual change path is there.
    await expect(page.getByRole("link", { name: "Предложить изменение" })).toHaveAttribute("href", "/proposals/new?document=SEM-ARCH-001");
  });
}
