import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * M6 «Работа» in the browser (docs/WORK_MANAGEMENT.md «UI»), offline demo stack, synthetic data only. Every test makes
 * its own project (a unique key) so it never edits the seeded demo projects or another test's data.
 *
 * - desktop: create project / task / subtask (M6-01), inline edit (M6-17 path), board drag (M6-02), Gantt drag →
 *   preview → apply → dependants shifted (M6-03, M6-04), cancel writes nothing (M6-30), one plan revision (M6-36);
 * - @mobile: the overview, a project's three views at 390 / 360 px without sideways scrolling, a status change on the
 *   phone, the Gantt as a timeline whose dates change through the task form;
 * - read-only (M6-20, M6-35): only when E2E_WORK_READONLY_URL points at a stack with WORK_PUBLIC_EXPOSURE=true or
 *   WORK_WRITES_ENABLED=false — no write control at all, and the API refuses writes.
 */

const HEADERS = { "X-SKH-Client": "e2e" };
const READONLY_URL = process.env.E2E_WORK_READONLY_URL;

interface Task {
  id: string;
  key: string;
  status: string;
  start_date: string | null;
  end_exclusive: string | null;
  last_day: string | null;
  version: number;
}

async function call<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(path, { method, headers: HEADERS, data });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

function uniqueKey(prefix: string): string {
  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-6)}${Math.floor(Math.random() * 10)}`.slice(0, 10);
}

/** The next Monday after the server's «today» (project time zone). */
async function nextMonday(request: APIRequestContext, key: string): Promise<string> {
  const { today } = await call<{ today: string }>(request, "GET", `/api/projects/${key}/gantt`);
  const date = new Date(`${today}T00:00:00Z`);
  const weekday = date.getUTCDay(); // 0 = Sunday
  date.setUTCDate(date.getUTCDate() + (((8 - weekday) % 7) || 7));
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createProject(request: APIRequestContext, prefix: string): Promise<string> {
  const key = uniqueKey(prefix);
  await call(request, "POST", "/api/projects", { key, title: `E2E ${key} (синтетический)` });
  return key;
}

/** A → B (FS): A is one working day on Monday, B one day on Tuesday. */
async function chain(request: APIRequestContext, key: string) {
  const monday = await nextMonday(request, key);
  const a = await call<Task>(request, "POST", `/api/projects/${key}/tasks`, { title: "Анализ (A)", start_date: monday, duration_workdays: 1 });
  const b = await call<Task>(request, "POST", `/api/projects/${key}/tasks`, { title: "Разработка (B)", start_date: addDays(monday, 1), duration_workdays: 1 });
  await call(request, "POST", `/api/tasks/${b.id}/dependencies`, { predecessor_task_id: a.id });
  return { monday, a, b };
}

async function dragBar(page: Page, key: string, dx: number) {
  const body = page.locator(`g.gantt-bar[data-task-key="${key}"] [data-part="body"]`);
  await body.scrollIntoViewIfNeeded();
  const box = await body.boundingBox();
  if (!box) throw new Error(`no bar ${key}`);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 6, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(box.x + 6 + (dx * i) / 8, y);
  await page.mouse.up();
}

/** Elements sticking out of the window, except inside the Gantt's own scroller (a tab stop that scrolls in its frame). */
async function sideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const problems: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.closest(".gantt__scroller, svg, .visually-hidden, [hidden]")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || (style.position === "fixed" && rect.left >= width)) continue;
      if (rect.right > width + 1) problems.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(" ")[0]} → ${Math.round(rect.right)}px`);
      if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches(".gantt__scroller")) {
        problems.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(" ")[0]} scrolls sideways`);
      }
    }
    return problems.slice(0, 5);
  });
}

test.describe("M6 work management", () => {
  test("M6-01 creates a project, a task and a subtask in the UI; the views share one plan", async ({ page }) => {
    const key = uniqueKey("UI");
    await page.goto("/projects");
    await expect(page.getByText("Локальная демонстрация — один оператор")).toBeVisible();
    await page.getByRole("button", { name: "Создать проект" }).click();
    const projectSheet = page.getByRole("dialog", { name: "Новый проект" });
    await projectSheet.getByLabel(/Ключ/).fill(key);
    await projectSheet.getByLabel(/Название/).fill(`E2E ${key} (синтетический)`);
    await projectSheet.getByRole("button", { name: "Создать проект" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}$`));
    await expect(page.getByText("В проекте пока нет задач")).toBeVisible();

    await page.getByRole("button", { name: "Задача" }).click();
    const taskSheet = page.getByRole("dialog", { name: "Новая задача" });
    await taskSheet.getByLabel(/Название/).fill("Собрать требования");
    await taskSheet.getByLabel("Исполнитель").selectOption({ label: "Аналитик (демо)" });
    await taskSheet.getByRole("radio", { name: "Начало и длительность" }).check();
    await taskSheet.getByLabel("Начало", { exact: true }).fill(await nextMonday(page.request, key));
    await taskSheet.getByLabel("Рабочих дней").fill("3");
    await taskSheet.getByRole("button", { name: "Создать задачу" }).click();
    await expect(page).toHaveURL(new RegExp(`task=${key}-1`));
    const panel = page.getByRole("complementary", { name: `${key}-1: Собрать требования` });
    await expect(panel.getByText("3 раб. дня")).toBeVisible();

    await panel.getByRole("button", { name: "Добавить подзадачу" }).click();
    const subSheet = page.getByRole("dialog", { name: `Подзадача к ${key}-1` });
    await subSheet.getByLabel(/Название/).fill("Интервью с владельцем");
    await subSheet.getByRole("button", { name: "Создать задачу" }).click();
    await expect(page).toHaveURL(new RegExp(`task=${key}-2`));
    await page.getByRole("button", { name: `Закрыть: ${key}-2: Интервью с владельцем` }).click();

    const subRow = page.locator(`tr[data-task-key="${key}-2"]`);
    await expect(subRow).toHaveAttribute("data-depth", "2");
    await expect(page.getByRole("button", { name: `Свернуть подзадачи ${key}-1` })).toBeVisible();
    const revision = await page.getByTestId("plan-revision").textContent();
    for (const view of ["Доска", "Гант"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await expect(page.getByTestId("plan-revision")).toHaveText(revision ?? "");
    }
    await expect(page.locator(`g.gantt-bar[data-task-key="${key}-1"]`)).toBeVisible();
    await expect(page.getByRole("region", { name: /Без дат/ }).getByRole("button", { name: new RegExp(`${key}-2`) })).toBeVisible();
  });

  test("M6-17 path: inline edits are saved with the version and survive a reload", async ({ page }) => {
    const key = await createProject(page.request, "ED");
    await call(page.request, "POST", `/api/projects/${key}/tasks`, { title: "Черновик плана" });
    await page.goto(`/projects/${key}?view=list`);
    const priority = page.getByRole("combobox", { name: `Приоритет ${key}-1 Черновик плана` });
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/tasks/"));
    await priority.selectOption("high");
    expect((await saved).status()).toBe(200);
    await page.getByRole("button", { name: `Изменить: Название ${key}-1` }).click();
    await page.getByRole("textbox", { name: `Название ${key}-1` }).fill("План работ");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: "План работ" })).toBeVisible();
    await expect.poll(async () => (await call<{ title: string; priority: string }>(page.request, "GET", `/api/tasks/${key}-1`)).title).toBe("План работ");
    await page.reload();
    await expect(page.getByRole("combobox", { name: `Приоритет ${key}-1 План работ` })).toHaveValue("high");
  });

  test("M6-02 dragging a card to «В работе» saves the status; the list shows it", async ({ page }) => {
    const key = await createProject(page.request, "BD");
    await call(page.request, "POST", `/api/projects/${key}/tasks`, { title: "Проверить маппинг" });
    await page.goto(`/projects/${key}?view=board`);
    const card = page.locator(`.board-card[data-task-key="${key}-1"]`);
    const target = page.locator('.board__column[data-status="in_progress"]');
    const from = await card.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error("no layout");
    await page.mouse.move(from.x + from.width / 2, from.y + 12);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(from.x + from.width / 2 + ((to.x + to.width / 2 - from.x - from.width / 2) * i) / 10, from.y + 12 + ((to.y + 40 - from.y - 12) * i) / 10);
    }
    await page.mouse.up();
    await expect(target.locator(`.board-card[data-task-key="${key}-1"]`)).toBeVisible();
    await expect.poll(async () => (await call<Task>(page.request, "GET", `/api/tasks/${key}-1`)).status).toBe("in_progress");
    await page.getByRole("button", { name: "Список", exact: true }).click();
    await expect(page.getByRole("combobox", { name: `Статус ${key}-1 Проверить маппинг` })).toHaveValue("in_progress");
  });

  test("M6-03/M6-04 Gantt drag → preview of the dependants → «Применить» shifts them", async ({ page }) => {
    const key = await createProject(page.request, "GA");
    const { monday, a, b } = await chain(page.request, key);
    await page.goto(`/projects/${key}?view=gantt&zoom=day`);
    await expect(page.locator(`g.gantt-bar[data-task-key="${b.key}"]`)).toBeVisible();
    await expect(page.locator("[data-dependency-id]")).toHaveCount(1);
    await dragBar(page, a.key, 2 * 32); // Monday → Wednesday
    const dialog = page.getByRole("dialog", { name: `Изменение сроков ${a.key}` });
    await expect(dialog.getByText("Сдвинутся зависимые: 1")).toBeVisible();
    await expect(dialog.locator(`[data-task-key="${b.key}"]`)).toContainText(`после ${a.key}`);
    await expect(page.locator(`[data-ghost-for="${b.key}"]`)).toBeAttached();
    // Nothing is written before the confirmation (M6-30).
    expect((await call<Task>(page.request, "GET", `/api/tasks/${a.id}`)).start_date).toBe(monday);
    await dialog.getByRole("button", { name: "Применить" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Сроки применены: изменено задач — 2/)).toBeVisible();
    const after = await call<Task>(page.request, "GET", `/api/tasks/${b.id}`);
    expect((await call<Task>(page.request, "GET", `/api/tasks/${a.id}`)).start_date).toBe(addDays(monday, 2));
    expect(after.start_date).toBe(addDays(monday, 3)); // B right after A (FS), Thursday
    await page.getByRole("button", { name: "Список", exact: true }).click();
    await expect(page.getByRole("button", { name: new RegExp(`Начало ${b.key}:`) })).toContainText(String(Number(addDays(monday, 3).slice(8))));
  });

  test("M6-30 «Отмена» in the preview leaves every date as it was", async ({ page }) => {
    const key = await createProject(page.request, "GC");
    const { monday, a, b } = await chain(page.request, key);
    await page.goto(`/projects/${key}?view=gantt&zoom=day`);
    await dragBar(page, a.key, 2 * 32);
    const dialog = page.getByRole("dialog", { name: `Изменение сроков ${a.key}` });
    await expect(dialog.getByText("Сдвинутся зависимые: 1")).toBeVisible();
    await dialog.getByRole("button", { name: "Отмена" }).click();
    await expect(dialog).toBeHidden();
    expect((await call<Task>(page.request, "GET", `/api/tasks/${a.id}`)).start_date).toBe(monday);
    expect((await call<Task>(page.request, "GET", `/api/tasks/${b.id}`)).start_date).toBe(addDays(monday, 1));
    const { plan_revision } = await call<{ plan_revision: number }>(page.request, "GET", `/api/projects/${key}`);
    await expect(page.getByTestId("plan-revision")).toHaveText(`Ревизия плана ${plan_revision}`);
  });

  test("the keyboard moves a bar (WCAG 2.5.7) and the preview opens on Enter", async ({ page }) => {
    const key = await createProject(page.request, "GK");
    const { a } = await chain(page.request, key);
    await page.goto(`/projects/${key}?view=gantt&zoom=day`);
    await page.locator(`g.gantt-bar[data-task-key="${a.key}"]`).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Изменение сроков ${a.key}` });
    await expect(dialog.getByText("Сдвинутся зависимые: 1")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("M6 on a phone", () => {
  test("@mobile projects, list, board and Gantt fit 390 / 360 px; status changes on the phone", async ({ page }) => {
    const key = await createProject(page.request, "MO");
    await chain(page.request, key);
    await call(page.request, "POST", `/api/projects/${key}/tasks`, { title: "Без дат на телефоне" });
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/projects", `/projects/${key}?view=list`, `/projects/${key}?view=board`, `/projects/${key}?view=gantt`]) {
        await page.goto(path);
        await expect(page.locator("main h1").first()).toBeAttached();
        await page.waitForLoadState("networkidle");
        expect(await sideways(page), `${path} at ${width} px`).toEqual([]);
      }
    }
    await page.goto(`/projects/${key}?view=board`);
    await page.getByRole("button", { name: `Сменить статус ${key}-3` }).click();
    await page.getByRole("menuitemradio", { name: "На проверке" }).click();
    await expect.poll(async () => (await call<Task>(page.request, "GET", `/api/tasks/${key}-3`)).status).toBe("review");
    // The Gantt on a phone: no dragging; a bar opens the task, whose form changes the dates.
    await page.goto(`/projects/${key}?view=gantt`);
    await expect(page.getByText(/Сроки меняются в карточке задачи/)).toBeVisible();
    await page.locator(`.gantt-name[data-task-key="${key}-1"] .gantt-name__open`).click();
    const sheet = page.getByRole("dialog", { name: new RegExp(`${key}-1`) });
    await expect(sheet.getByRole("button", { name: "Изменить сроки" })).toBeVisible();
  });
});

test.describe("M6 read-only exposure", () => {
  test("M6-20/M6-35 a public or write-disabled stack shows no write control and the API refuses writes", async ({ page }) => {
    test.skip(!READONLY_URL, "E2E_WORK_READONLY_URL (a stack with WORK_PUBLIC_EXPOSURE=true or WORK_WRITES_ENABLED=false) is not set");
    const base = READONLY_URL as string;
    await page.goto(`${base}/projects`);
    await expect(page.getByText("Только просмотр — изменения задач отключены")).toBeVisible();
    await expect(page.getByRole("heading", { name: "ARIS Metadata Integration (демо)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Создать проект" })).toHaveCount(0);
    await page.goto(`${base}/projects/ARIS?view=list`);
    await expect(page.locator("tr[data-task-key]").first()).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Задача", exact: true })).toHaveCount(0);
    await page.goto(`${base}/projects/ARIS?view=board`);
    await expect(page.locator(".board-card").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Сменить статус/ })).toHaveCount(0);
    await page.goto(`${base}/projects/ARIS?view=gantt&task=ARIS-5`);
    await expect(page.locator("g.gantt-bar").first()).toBeVisible();
    await expect(page.locator("g.gantt-bar.is-draggable")).toHaveCount(0);
    await expect(page.getByText("История изменений не показывается в режиме только для просмотра.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Изменить сроки" })).toHaveCount(0);
    const refused = await page.request.post(`${base}/api/projects/ARIS/tasks`, { headers: HEADERS, data: { title: "Нельзя" } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).details.mode).toBe("read_only");
  });
});
