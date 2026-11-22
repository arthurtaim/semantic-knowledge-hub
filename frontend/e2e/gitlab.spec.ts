import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * @gitlab scenarios: the backend runs with KNOWLEDGE_BACKEND=gitlab against the loopback GitLab
 * TEST DOUBLE (backend/tests/support/gitlab_mock.py). They prove the application flow and the adapter
 * contract as modelled by the mock — not the behaviour of a real GitLab instance.
 */
const MOCK = "http://127.0.0.1:8929";

async function mock(request: APIRequestContext, path: string, data?: unknown): Promise<void> {
  const response = await request.post(`${MOCK}/__mock__/${path}`, { data: data ?? {} });
  expect(response.ok(), path).toBeTruthy();
}

async function createReadyProposal(page: Page, docId: string, line: string): Promise<void> {
  await page.goto(`/proposals/new?document=${docId}`);
  const editor = page.getByLabel(/Текст документа/);
  await editor.fill((await editor.inputValue()) + `\n${line}\n`);
  await page.getByLabel("Причина изменения").fill(`E2E: ${line}`);
  await page.getByRole("button", { name: "Создать предложение" }).click();
  await expect(page.getByRole("heading", { name: "Этапы предложения" })).toBeVisible();
  await page.getByRole("button", { name: "Отметить «Готово к ревью»" }).click();
  await expect(page.getByText(/отмечено «Готово к ревью»/)).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await mock(request, "reset");
});

test("@gitlab E2E-09 send to GitLab mock → MR → merge in GitLab → knowledge base updated", async ({ page, request }) => {
  await page.goto("/documents/SEM-ARCH-001");
  const passport = page.getByRole("complementary", { name: "Паспорт документа" });
  await expect(passport).toContainText("GitLab");
  await expect(passport.getByRole("link", { name: "Открыть в GitLab" })).toHaveAttribute(
    "href",
    /127\.0\.0\.1:8929\/skh-test\/knowledge-base-MOCK\/-\/blob\/[0-9a-f]{40}\/docs\/SEM-ARCH-001\.md/,
  );
  const baseRevision = await page.locator(".passport__fields .doc-id").nth(1).textContent();

  await createReadyProposal(page, "SEM-ARCH-001", "Строка E2E-09 после merge.");
  await page.getByRole("button", { name: "Отправить в GitLab" }).click();
  await expect(page.getByText(/Предложение отправлено в GitLab: создан Merge Request/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Merge Request в GitLab" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Открыть Merge Request в GitLab" })).toHaveAttribute(
    "href",
    `${MOCK}/skh-test/knowledge-base-MOCK/-/merge_requests/1`,
  );
  await expect(page.getByText(/kb\/update\/SEM-ARCH-001-/).first()).toBeVisible();
  await expect(page.getByText("Исходный документ не изменён — пока существует только предложение.")).toBeVisible();

  const state = await (await request.get(`${MOCK}/__mock__/state`)).json();
  expect(state.merge_requests).toHaveLength(1);
  expect(state.protected_write_attempts).toBe(0);

  await mock(request, "merge-requests/1/merge"); // a reviewer merges in GitLab
  await page.getByRole("button", { name: "Проверить статус в GitLab" }).click();
  await expect(page.getByText("GitLab подтвердил merge.")).toBeVisible();
  await expect(page.getByText("Изменение принято в GitLab и попало в базу знаний.")).toBeVisible();

  await page.goto("/documents/SEM-ARCH-001");
  await expect(page.getByText("Строка E2E-09 после merge.")).toBeVisible();
  await expect(page.locator(".passport__fields .doc-id").nth(1)).not.toHaveText(baseRevision ?? "");
});

test("@gitlab E2E-08 revision conflict: nothing is overwritten and the proposal is kept", async ({ page, request }) => {
  await createReadyProposal(page, "SEM-GLOSS-001", "Термин из предложения E2E-08.");
  await mock(request, "commit", { path: "docs/SEM-GLOSS-001.md", append: "\nПравка другого автора E2E-08.\n" });
  await page.getByRole("button", { name: "Отправить в GitLab" }).click();
  await expect(page.getByRole("heading", { name: "Как продолжить после конфликта" })).toBeVisible();
  await expect(page.getByText("Исходный документ изменился после создания предложения.", { exact: true })).toBeVisible();
  await expect(page.locator(".diff, [role=table]").first()).toContainText("Термин из предложения E2E-08.");
  await expect(page.getByRole("link", { name: "Создать новое предложение на основе актуальной версии" })).toBeVisible();

  const state = await (await request.get(`${MOCK}/__mock__/state`)).json();
  expect(state.merge_requests).toHaveLength(0);
  expect(Object.keys(state.branches)).toEqual(["main"]);
  await page.goto("/documents/SEM-GLOSS-001");
  await expect(page.getByText("Правка другого автора E2E-08.")).toBeVisible();
});

test("@gitlab E2E-10 GitLab error keeps the local proposal; retry creates exactly one MR", async ({ page, request }) => {
  await createReadyProposal(page, "SEM-PROC-001", "Шаг из предложения E2E-10.");
  await mock(request, "faults", { method: "POST", path_contains: "/repository/commits", status: 503 });
  await page.getByRole("button", { name: "Отправить в GitLab" }).click();
  await expect(page.getByRole("heading", { name: "Отправка в GitLab не удалась" })).toBeVisible();
  await expect(page.getByText("Ошибка отправки").first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Изменения построчно" })).toContainText("Шаг из предложения E2E-10.");

  await page.reload(); // the proposal survives a reload: it is stored locally
  await expect(page.getByRole("heading", { name: "Отправка в GitLab не удалась" })).toBeVisible();
  await page.getByRole("button", { name: "Повторить отправку" }).click();
  await expect(page.getByRole("link", { name: "Открыть Merge Request в GitLab" })).toBeVisible();
  const state = await (await request.get(`${MOCK}/__mock__/state`)).json();
  expect(state.merge_requests).toHaveLength(1);
  expect(state.protected_write_attempts).toBe(0);
});

test("@gitlab E2E-11 unavailable Confluence MCP is shown as such", async ({ page }) => {
  await page.goto("/integrations");
  const mcp = page.locator(".integration", { hasText: "Confluence Data Center" });
  await expect(mcp).toContainText("Ошибка");
  await expect(mcp).toContainText("MCP недоступен");
  await expect(page.locator(".integration", { hasText: "GitLab (каноническая база знаний)" })).toContainText(
    "knowledge-base-MOCK",
  );

  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill("Где хранится каноническая база знаний команды?");
  await page.getByLabel("Оба").check({ force: true });
  await page.getByRole("button", { name: "Спросить" }).click();
  await expect(page.getByText("Корпоративные источники не использованы.")).toBeVisible();
  await expect(page.getByText(/сейчас недоступен/)).toBeVisible();
  await expect(page.locator(".citation").first()).toContainText("GitLab");
});
