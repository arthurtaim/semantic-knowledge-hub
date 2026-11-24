import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * Knowledge map on the offline demo stack (83 synthetic documents, mock Confluence corpus, mock AI): the
 * three modes, the list view, a neighbourhood with edge provenance, dragging nodes (UI v2 phase E,
 * docs/ui-v2/specs/04_KNOWLEDGE_GRAPH.md), pan and zoom, «Сбросить расположение», the evidence graph of an
 * answer, and the phone layout.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

const details = (page: Page) => page.getByRole("complementary", { name: "Сведения об узле" });
const graphNode = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`);

async function translate(locator: Locator): Promise<{ x: number; y: number }> {
  const transform = (await locator.getAttribute("transform")) ?? "";
  const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`no translate in «${transform}»`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function view(page: Page): Promise<{ x: number; y: number; k: number }> {
  const transform = (await page.locator(".graph-viewport").getAttribute("transform")) ?? "";
  const match = /translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`no view in «${transform}»`);
  return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) };
}

/** The centre of a node on screen, checked to be the node itself (not covered by the legend or a control). */
async function grip(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await graphNode(page, id).locator(".graph-node__shape").boundingBox();
  if (!box) throw new Error(`${id} is not drawn`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-node-id]")?.getAttribute("data-node-id"), point);
  expect(hit, `${id} can be grabbed`).toBe(id);
  return point;
}

async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  await page.mouse.up();
}

test("M5.6 graph: navigation, global graph and its list view", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("link", { name: "Карта знаний" }).click();
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.getByRole("heading", { name: "Карта знаний", level: 1 })).toBeAttached();
  await expect(page.getByRole("group", { name: /Схема графа: \d+ узл/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Вся база" })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Условные обозначения" })).toBeVisible();

  await page.getByRole("button", { name: "Списком" }).click();
  const nodes = page.getByRole("region", { name: /^Узлы/ });
  await expect(nodes.getByText("DEMO-INT-002", { exact: true })).toBeVisible();
  await nodes.getByRole("button", { name: "ARIS → Catalog: маппинг полей (демо)" }).click();
  await expect(details(page).getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeFocused();
  await expect(details(page)).toContainText("Указано в");
  expect(problems).toEqual([]);
});

test("M5.6 graph: neighbourhood of DEMO-INT-002 shows DEMO-SEM-002 and why they are linked", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/documents/DEMO-INT-002");
  await page.getByRole("link", { name: "Связи на графе" }).click();
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-INT-002$/);

  const panel = details(page);
  await expect(panel.getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeVisible();
  const mapsTo = panel.locator(".graph-why", { hasText: "отображается в" });
  await expect(mapsTo).toContainText("Логическая модель: BusinessProcess");
  await expect(mapsTo).toContainText("DEMO-INT-002");
  await expect(mapsTo).toContainText("relations.maps_to");
  await expect(mapsTo).toContainText("integrations/DEMO-INT-002.md");
  await expect(mapsTo).toContainText("sha256:");

  // Keyboard: focus the node on the canvas and select it with Enter.
  const entity = page.getByRole("button", { name: /^Логическая модель: BusinessProcess\./ });
  await entity.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeVisible();
  await expect(panel).toContainText("DEMO-SEM-002");
  await panel.getByRole("link", { name: "Показать соседей" }).click();
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-SEM-002$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-INT-002$/);
  await expect(page.getByRole("navigation", { name: "Путь" })).toContainText("Окружение DEMO-INT-002");
  // Back restores the neighbourhood together with the node that was selected in it.
  await expect(page.getByRole("button", { name: /^ARIS → Catalog: маппинг полей \(демо\)\./ })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("E2E-MAP-1 dragging a node moves only that node, with the mouse, without selecting it", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/graph?focus=DEMO-INT-002");
  const panel = details(page);
  await expect(panel.getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeVisible();
  const dragged = graphNode(page, "doc:DEMO-SEM-002");
  const neighbour = graphNode(page, "doc:DEMO-INT-001");
  const before = await translate(dragged);
  const neighbourBefore = await translate(neighbour);
  const { k } = await view(page);
  const reset = page.getByRole("button", { name: "Сбросить расположение" });
  await expect(reset).toBeDisabled();

  await dragBy(page, await grip(page, "doc:DEMO-SEM-002"), 120, 70);
  const after = await translate(dragged);
  // The node followed the mouse exactly (screen delta / zoom), and stays there.
  expect((after.x - before.x) * k).toBeCloseTo(120, 0);
  expect((after.y - before.y) * k).toBeCloseTo(70, 0);
  expect(await translate(neighbour)).toEqual(neighbourBefore);
  // Not a click: the URL and the details panel are as before.
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-INT-002$/);
  await expect(panel.getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Узел перемещён" })).toBeVisible();
  await expect(reset).toBeEnabled();

  // «Вписать» keeps it; «Сбросить расположение» puts it back and turns itself off.
  await page.getByRole("button", { name: "Вписать" }).click();
  expect(await translate(dragged)).toEqual(after);
  await reset.click();
  expect(await translate(dragged)).toEqual(before);
  await expect(reset).toBeDisabled();
  expect(problems).toEqual([]);
});

test("E2E-MAP-2 a click on a node still opens its details", async ({ page }) => {
  await page.goto("/graph?focus=DEMO-INT-002");
  await expect(details(page).getByRole("heading", { name: "ARIS → Catalog: маппинг полей (демо)" })).toBeVisible();
  const point = await grip(page, "doc:DEMO-SEM-002");
  await page.mouse.click(point.x, point.y);
  await expect(details(page).getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeVisible();
  await expect(graphNode(page, "doc:DEMO-SEM-002")).toHaveAttribute("aria-pressed", "true");
});

test("E2E-MAP-3 the background pans, the wheel zooms, nodes stay where they are", async ({ page }) => {
  await page.goto("/graph");
  await expect(page.getByRole("group", { name: /Схема графа/ })).toBeVisible();
  const svgBox = (await page.locator(".graph-canvas__svg").boundingBox())!;
  // An empty spot of the canvas: top-left, clear of the legend and the controls.
  const empty = { x: svgBox.x + 12, y: svgBox.y + 12 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("graph-canvas__svg"), empty)).toBe(true);
  const nodeBefore = await translate(graphNode(page, "doc:DEMO-INT-001"));
  const before = await view(page);
  await dragBy(page, empty, 80, 50);
  const panned = await view(page);
  expect(panned.x - before.x).toBeCloseTo(80, 0);
  expect(panned.y - before.y).toBeCloseTo(50, 0);
  expect(await translate(graphNode(page, "doc:DEMO-INT-001"))).toEqual(nodeBefore);

  await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await view(page)).k).toBeGreaterThan(panned.k);
  expect(await translate(graphNode(page, "doc:DEMO-INT-001"))).toEqual(nodeBefore);
});

test("E2E-MAP-4 three modes: «Вся база», «Вокруг узла» and «Граф ответа» from an assistant answer", async ({ page }) => {
  const session = (await (await page.request.get("/api/session", { headers: { "X-SKH-Client": "web" } })).json()) as {
    features: { ai_mode: string };
  };
  test.skip(session.features.ai_mode === "disabled", "The assistant is off on this stack");
  const problems = watch(page);
  await page.goto("/graph");
  const modes = page.getByRole("group", { name: "Режим карты" });
  await expect(modes.getByRole("radio", { name: "Вокруг узла" })).toBeDisabled();
  const target = page.getByRole("button", { name: /^ARIS → Catalog: обзор потока \(демо\)\./ });
  await target.focus();
  await page.keyboard.press("Enter");
  await expect(modes.getByRole("radio", { name: "Вокруг узла" })).toBeEnabled();
  await modes.getByRole("radio", { name: "Вокруг узла" }).click({ force: true });
  await expect(page).toHaveURL(/\/graph\?focus=DEMO-INT-001$/);
  await expect(modes.getByRole("radio", { name: "Вокруг узла" })).toBeChecked();
  await expect(graphNode(page, "doc:DEMO-INT-001")).toHaveAttribute("transform", "translate(0.0,0.0)");

  // The answer links to its own graph: the question in the centre, the cited sources around it.
  await page.goto(`/ask?q=${encodeURIComponent("Что отправляет ARIS в каталог?")}&run=1`);
  await page.getByRole("link", { name: "Граф ответа" }).first().click();
  await expect(page).toHaveURL(/\/graph\?trace=TRACE-[0-9a-f]{16}$/);
  await expect(page.getByRole("radio", { name: "Граф ответа" })).toBeChecked();
  const question = page.locator('[data-node-id^="query:TRACE-"]');
  await expect(question).toHaveAttribute("transform", "translate(0.0,0.0)");
  await expect(details(page)).toContainText("процитирована в ответе");
  await expect(page.locator(".graph-canvas__svg .graph-edge--unconfirmed").first()).toBeAttached();

  // Back to the whole base and to the same answer through the segments. A navigation is a transition: the URL
  // changes before the page shows the new mode, so wait for the segment before the next click.
  const answerUrl = page.url();
  await page.getByRole("radio", { name: "Вся база" }).click({ force: true });
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.getByRole("radio", { name: "Вся база" })).toBeChecked();
  await expect(page.getByRole("group", { name: /Схема графа: 97 узлов/ })).toBeVisible();
  await page.getByRole("radio", { name: "Граф ответа" }).click({ force: true });
  await expect(page).toHaveURL(answerUrl);
  await expect(page.getByRole("radio", { name: "Граф ответа" })).toBeChecked();
  expect(problems).toEqual([]);
});

test("M5.6 ask with both sources: a Confluence citation and the evidence graph of the answer", async ({ page }) => {
  // Needs the synthetic Confluence corpus (CONFLUENCE_CONNECTOR=mock); the default offline stack has none.
  const session = (await (await page.request.get("/api/session", { headers: { "X-SKH-Client": "web" } })).json()) as {
    features: { corporate_search: string };
  };
  test.skip(session.features.corporate_search === "disabled", "Confluence is not configured on this stack");
  const problems = watch(page);
  const question = "Когда действует окно заморозки изменений метаданных?";
  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill(question);
  await page.getByLabel("Оба").check({ force: true });
  await page.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(page.getByText("Подтверждено источниками")).toBeVisible();

  const citation = page.locator(".citation", { hasText: "Регламент заморозки изменений метаданных (демо)" }).first();
  await expect(citation).toContainText(/Confluence · версия \d+/);
  await expect(citation).toContainText("статус не подтверждён");
  await expect(page.getByText(/^Внешний источник: запрос к Confluence \(причина: /)).toBeVisible();

  const rating = page.getByRole("group", { name: "Оценка источника «Регламент заморозки изменений метаданных (демо)»" });
  await rating.getByRole("button", { name: "Подошёл", exact: true }).click();
  await expect(rating.getByRole("button", { name: "Подошёл", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(rating).toContainText("Отзыв учтён");

  await page.getByRole("link", { name: "Граф ответа" }).click();
  await expect(page).toHaveURL(/\/graph\?trace=TRACE-[0-9a-f]{16}$/);
  expect(decodeURIComponent(page.url())).not.toContain("заморозки"); // the question never goes into the URL
  await expect(page.getByRole("heading", { name: "Граф ответа", level: 1 })).toBeAttached();
  await expect(
    page.getByRole("button", {
      name: /^Регламент заморозки изменений метаданных \(демо\)\. Внешняя страница Confluence, статус не подтверждён/,
    }),
  ).toBeVisible();
  // The question node is selected by default: its links say what was found and what was cited.
  const panel = details(page);
  await expect(panel).toContainText("процитирована в ответе");
  await expect(panel).toContainText("подошёл"); // the feedback just given is on the evidence edge
  expect(problems).toEqual([]);
});

test("@mobile graph: lists by default, details in a sheet after a selection, no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const path of ["/graph", "/graph?focus=DEMO-INT-002"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Списком" })).toHaveAttribute("aria-pressed", "true");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.locator(".graph-list__node", { hasText: "Логическая модель: BusinessProcess" }).first().click();
  const sheet = details(page);
  await expect(sheet.getByRole("heading", { name: "Логическая модель: BusinessProcess" })).toBeFocused();
  await sheet.getByRole("button", { name: "Закрыть сведения" }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "Списком" }).click();
  await expect(page.getByRole("group", { name: /Схема графа/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
