import { expect, test, type Page } from "@playwright/test";

/*
 * UI v2 phase F (docs/ui-v2/TASK.md, docs/UI_REDESIGN.md «UI v2»): what jsdom cannot see — layout at phone widths,
 * the page-toolbar path next to the badges, the skip link and focus that must not end up under the sticky toolbar or
 * the dialog's pinned field (WCAG 2.2: 2.4.7, 2.4.11, 2.5.8). Offline demo stack, synthetic documents only.
 */

const PHONE_ROUTES = [
  "/",
  "/documents",
  "/documents/SEM-ARCH-001",
  "/documents/DEMO-INT-001",
  "/documents/new",
  "/documents/import",
  "/graph",
  "/templates",
  "/templates/integration",
  "/proposals",
  "/integrations",
  "/no-such-page",
];

/**
 * Elements sticking out of the viewport (unless a scrolling ancestor clips them) and boxes that scroll sideways.
 * A Markdown table or code block of a document may scroll in its own frame — then it must be a tab stop.
 */
async function sidewaysProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(" ")[0]}`;
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= width + 1) return true;
      }
      return false;
    };
    const problems: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || el.closest("[hidden], .visually-hidden, svg")) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || (style.position === "fixed" && rect.left >= width)) continue;
      if (rect.right > width + 1 && !clipped(el)) problems.push(`${name(el)} sticks out to ${Math.round(rect.right)}px`);
      if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
        const documentBlock = el.matches(".prose pre, .prose table");
        if (!documentBlock) problems.push(`${name(el)} scrolls sideways`);
        else if ((el as HTMLElement).tabIndex !== 0) problems.push(`${name(el)} scrolls but is not a tab stop`);
      }
    }
    return problems.slice(0, 5);
  });
}

/** Is the element (or a part of it) the top-most thing at its centre — not covered by a sticky bar or field? */
async function onTop(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.activeElement?.matches(sel) ? document.activeElement : document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(top && (top === el || el.contains(top)));
  }, selector);
}

test("@mobile F-01 at 360 and 390 px nothing scrolls sideways; lists and tables are one column", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of PHONE_ROUTES) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeAttached();
      await page.waitForLoadState("networkidle");
      expect(await sidewaysProblems(page), `${path} at ${width} px`).toEqual([]);
    }
  }
  // The proposals table is card rows on a phone.
  await page.goto("/proposals");
  await expect(page.getByRole("list", { name: "Предложения изменений" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("F-02 the toolbar path never runs under the badges; a narrow toolbar shows only the current page", async ({ page }) => {
  for (const width of [1360, 860, 700, 620]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/documents/DEMO-INT-001");
    const current = page.locator(".page-toolbar .crumbs [aria-current='page']");
    await expect(current).toBeVisible();
    // Measure the settled toolbar: the document's own path and actions («Ещё») replace the route's default path
    // only after the document loads; measuring before that compared a transient toolbar (flaky under load).
    await expect(page.locator(".page-toolbar").getByRole("button", { name: "Ещё", exact: true })).toBeVisible();
    await expect(current).toContainText("ARIS");
    // «Документы» v2: the path follows the documents tree — Документы / Интеграции / ARIS / the document.
    await expect(page.locator(".page-toolbar .crumbs li")).toHaveCount(4);
    if (width <= 860) {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Array.from(document.querySelectorAll(".page-toolbar .crumbs li")).filter(
                (li) => getComputedStyle(li).display !== "none",
              ).length,
          ),
        )
        .toBe(1);
    }
    const layout = await page.evaluate(() => {
      const lead = document.querySelector(".page-toolbar__lead")!.getBoundingClientRect();
      const end = document.querySelector(".page-toolbar__end")!.getBoundingClientRect();
      const crumbs = Array.from(document.querySelectorAll(".page-toolbar .crumbs li"))
        .filter((li) => getComputedStyle(li).display !== "none")
        .map((li) => li.getBoundingClientRect());
      return { leadRight: lead.right, endLeft: end.left, crumbRights: crumbs.map((r) => r.right), shown: crumbs.length };
    });
    expect(layout.leadRight, `${width} px`).toBeLessThanOrEqual(layout.endLeft);
    for (const right of layout.crumbRights) expect(right, `${width} px`).toBeLessThanOrEqual(layout.endLeft);
    if (width <= 860) expect(layout.shown, `${width} px: only the current page`).toBe(1);
    else expect(layout.shown).toBe(4);
  }
});

test("F-03 the skip link is visible above the sidebar and the toolbar when focused", async ({ page }) => {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Перейти к содержимому" });
  await expect(skip).toBeFocused();
  expect(await onTop(page, ".skip-link")).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("F-04 on /ask focus moving back from the pinned field lands above it, on 24 px targets", async ({ page }) => {
  await page.goto("/ask?q=" + encodeURIComponent("Что отправляет ARIS в каталог?") + "&run=1");
  const sources = page.locator(".source__title");
  await expect(sources.first()).toBeVisible({ timeout: 15_000 });
  for (const box of await sources.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
    expect(box).toBeGreaterThanOrEqual(24);
  }
  // From the field, Shift+Tab walks back through the answer: every stop is scrolled above the pinned field.
  await page.getByRole("textbox", { name: "Вопрос" }).focus();
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const inField = await page.evaluate(() => Boolean(document.activeElement?.closest(".dialog__composer")));
    if (inField) continue;
    expect(await onTop(page, ":focus"), `stop ${step}`).toBe(true);
  }
});
