import { expect, test, type Page } from "@playwright/test";

/*
 * «Публикации» on the offline demo stack, where publication to Confluence is not configured: the page must say so
 * honestly — with the server's own message and a way to the publisher's row — instead of showing an empty list.
 * The list with real jobs runs on the gitlab-mock stack (publication.spec.ts, E2E-37).
 */

interface Integration {
  name: string;
  state: string;
  human_readable_message: string;
}

async function publisher(page: Page): Promise<Integration> {
  const status = (await (await page.request.get("/api/integrations/status")).json()) as { items: Integration[] };
  const item = status.items.find((i) => i.name === "confluence_publisher");
  expect(item, "the integrations status reports the Confluence publisher").toBeTruthy();
  return item as Integration;
}

const scrollsSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test("«Публикации» with publication off: the server's message, what it needs, the publisher row; one current item", async ({ page }) => {
  const off = await publisher(page);
  expect(off.state).toBe("disabled"); // the demo stack has no Confluence REST target
  const jobs = await (await page.request.get("/api/publications/jobs")).json();
  expect(jobs.total).toBe(0);

  await page.goto("/publications");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Публикации" })).toBeVisible();
  await expect(main.getByText("Публикация в Confluence выключена")).toBeVisible();
  await expect(main.getByText(off.human_readable_message)).toBeVisible();
  await expect(main.getByText(/GitLab как источник смёрженных ревизий/)).toBeVisible();
  await expect(main.getByRole("table")).toHaveCount(0);
  await expect(main.getByText("Публикаций пока нет")).toHaveCount(0);
  expect(await scrollsSideways(page)).toBe(false);

  const nav = page.getByRole("navigation", { name: "Основная навигация" });
  const current = nav.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName("Публикации");

  await main.getByRole("link", { name: "Интеграции" }).click();
  await expect(page).toHaveURL(/\/integrations#integration-confluence_publisher$/);
  await expect(page.locator("#integration-confluence_publisher")).toBeInViewport();
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName("Интеграции");

  // The sidebar item opens the list again, and only it is current.
  await nav.getByRole("link", { name: "Публикации" }).click();
  await expect(page).toHaveURL(/\/publications$/);
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName("Публикации");
});

test("@mobile «Публикации» on a phone: the honest empty state at 390 and 360 px without sideways scrolling", async ({ page }) => {
  const off = await publisher(page);
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/publications");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: "Публикации" })).toBeVisible();
    await expect(main.getByText("Публикация в Confluence выключена")).toBeVisible();
    await expect(main.getByText(off.human_readable_message)).toBeVisible();
    const link = main.getByRole("link", { name: "Интеграции" });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())?.height ?? 0, `${width} px: the link is a 24 px target`).toBeGreaterThanOrEqual(24);
    expect(await scrollsSideways(page), `${width} px`).toBe(false);
  }
});
