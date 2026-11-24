import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * M5 publication in the browser (@gitlab = integration_mock stack): loopback TEST DOUBLES of GitLab (:8929)
 * and Confluence Data Center REST (:8931). The full E2E-23…36 matrix, including auth/outage/lost-answer and
 * restart cases, also runs at API level in backend/tests/test_publications.py. Doubles ≠ real Confluence.
 */
const GITLAB = "http://127.0.0.1:8929";
const CONFLUENCE = "http://127.0.0.1:8931";
const API_HEADERS = { "X-SKH-Client": "e2e" };
// Titles carry the time in base36: a 13-digit Date.now() sometimes passes the Luhn check and is (rightly)
// rejected by the server as a payment card number, which made these scenarios flaky.

interface ConfluenceState {
  pages: { id: string; title: string; version: number; parent: string | null; properties: Record<string, { document_id: string }> }[];
  write_requests: number;
}

async function confluence(request: APIRequestContext): Promise<ConfluenceState> {
  return (await request.get(`${CONFLUENCE}/__mock__/state`)).json();
}

/** Create, review, submit and merge a new approved document through the API (the UI flow is E2E-18). */
async function mergedDocument(page: Page, request: APIRequestContext, title: string): Promise<string> {
  const id = `SEM-PUB-${Date.now().toString().slice(-7)}`;
  const templates = await (await page.request.get("/api/authoring/templates")).json();
  const skeleton = templates.find((t: { id: string }) => t.id === "architecture").skeleton as string;
  const draft = await page.request.post("/api/authoring/drafts", {
    headers: API_HEADERS,
    data: {
      template_id: "architecture",
      metadata: { id, title, owner: "semantic-team", status: "approved" },
      body: `# ${title}\n\nТекст для публикации, **важное** правило.\n\n${skeleton}`,
      reason: "E2E: документ для публикации",
    },
  });
  expect(draft.status()).toBe(201);
  await mergeProposal(page, request, (await draft.json()).id);
  return id;
}

async function mergeProposal(page: Page, request: APIRequestContext, proposalId: string): Promise<void> {
  expect((await page.request.post(`/api/drafts/${proposalId}/mark-ready`, { headers: API_HEADERS })).ok()).toBeTruthy();
  const submitted = await page.request.post(`/api/drafts/${proposalId}/submit`, { headers: API_HEADERS });
  expect(submitted.ok()).toBeTruthy();
  const iid = (await submitted.json()).merge_request.iid;
  expect((await request.post(`${GITLAB}/__mock__/merge-requests/${iid}/merge`)).ok()).toBeTruthy();
  const merged = await (await page.request.post(`/api/drafts/${proposalId}/refresh-status`, { headers: API_HEADERS })).json();
  expect(merged.status).toBe("merged");
}

async function updateDocument(page: Page, request: APIRequestContext, id: string, text: string): Promise<void> {
  const doc = await (await page.request.get(`/api/documents/${id}`)).json();
  const created = await page.request.post("/api/drafts", {
    headers: API_HEADERS,
    data: {
      document_id: id,
      base_revision: doc.revision,
      proposed_content: `${doc.raw.trimEnd()}\n\n${text}\n`,
      reason: "E2E: утверждённое изменение",
    },
  });
  expect(created.status()).toBe(201);
  await mergeProposal(page, request, (await created.json()).id);
}

/** UI v2: «Публикация в Confluence» lives in the «История» segment of the document. */
async function openPublication(page: Page, id: string): Promise<void> {
  await page.goto(`/documents/${id}`);
  await page.getByRole("tab", { name: "История" }).click();
}

async function openPreview(page: Page, id: string): Promise<void> {
  await openPublication(page, id);
  const block = page.locator("#publication");
  await expect(block.getByRole("heading", { name: "Публикация в Confluence" })).toBeVisible();
  await block.getByRole("link", { name: "Открыть предпросмотр" }).click();
  await expect(page).toHaveURL(/\/publications\/[0-9a-f]{32}$/);
  await expect(page.getByRole("heading", { name: "Публикация в Confluence", level: 1 })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${GITLAB}/__mock__/reset`);
  await request.post(`${CONFLUENCE}/__mock__/reset`);
});

test("@gitlab E2E-23/24/25/26/27 merged document → dry-run without writes → page created → updated → repeat is a no-op", async ({ page, request }) => {
  const title = `Публикация E2E ${Date.now().toString(36)}`;
  const id = await mergedDocument(page, request, title);
  await openPublication(page, id);
  await expect(page.locator("#publication")).toContainText("Предпросмотр готов");
  await expect(page.locator("#publication")).toContainText("тестовый дубль Confluence");

  await openPreview(page, id);
  await expect(page.getByTestId("publication-action")).toHaveText("Будет создана новая страница");
  await expect(page.getByRole("table", { name: "Содержимое новой страницы" })).toContainText("<strong>важное</strong>");
  expect((await confluence(request)).write_requests).toBe(0); // E2E-24: the dry-run wrote nothing

  await page.getByRole("button", { name: "Опубликовать в Confluence" }).click();
  await expect(page.getByText("Опубликовано в Confluence").first()).toBeVisible();
  let state = await confluence(request);
  const created = state.pages.filter((p) => p.title === title);
  expect(created).toHaveLength(1); // E2E-25: exactly one new page
  expect(created[0].parent).toBe("5000001");
  expect(created[0].properties["skh-managed-document"].document_id).toBe(id);

  // E2E-26: the next approved change updates the same page with version + 1
  await updateDocument(page, request, id, "Абзац второй утверждённой ревизии.");
  await openPreview(page, id);
  await expect(page.getByTestId("publication-action")).toContainText(`Будет обновлена страница ${created[0].id} (версия 1 → 2)`);
  await expect(page.getByRole("table", { name: "Изменения страницы построчно" })).toContainText("Абзац второй утверждённой ревизии.");
  await page.getByRole("button", { name: "Опубликовать в Confluence" }).click();
  await expect(page.getByText("Опубликовано в Confluence").first()).toBeVisible();
  state = await confluence(request);
  expect(state.pages.filter((p) => p.title === title).map((p) => p.version)).toEqual([2]);

  // E2E-27: preparing again for the same revision changes nothing in Confluence
  const writes = state.write_requests;
  await openPublication(page, id);
  await expect(page.locator("#publication")).toContainText("Опубликован");
  await page.locator("#publication").getByRole("button", { name: "Подготовить публикацию" }).click();
  await expect(page.getByTestId("publication-action")).toHaveText("Изменений нет — новая версия не создаётся");
  await page.getByRole("button", { name: "Опубликовать в Confluence" }).click();
  await expect(page.getByText("Опубликовано в Confluence").first()).toBeVisible();
  state = await confluence(request);
  expect(state.write_requests).toBe(writes);
  expect(state.pages.filter((p) => p.title === title).map((p) => p.version)).toEqual([2]);
});

test("@gitlab E2E-28 manual edit in Confluence → conflict, the page is not overwritten", async ({ page, request }) => {
  const title = `Ручная правка E2E ${Date.now().toString(36)}`;
  const id = await mergedDocument(page, request, title);
  await openPreview(page, id);
  await page.getByRole("button", { name: "Опубликовать в Confluence" }).click();
  await expect(page.getByText("Опубликовано в Confluence").first()).toBeVisible();
  const pageId = (await confluence(request)).pages.find((p) => p.title === title)?.id ?? "";
  await request.post(`${CONFLUENCE}/__mock__/pages/${pageId}/edit`, { data: {} });

  await updateDocument(page, request, id, "Изменение после ручной правки.");
  await openPublication(page, id);
  await expect(page.locator("#publication")).toContainText("Конфликт");
  await page.locator("#publication").getByRole("link", { name: "Открыть предпросмотр" }).click();
  await expect(page.getByRole("heading", { name: "Страница изменена в Confluence вручную" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Ручная правка построчно" })).toContainText("Ручная правка");
  await expect(page.getByRole("button", { name: "Опубликовать в Confluence" })).toBeDisabled();
  expect((await confluence(request)).pages.find((p) => p.id === pageId)?.version).toBe(2);
});

test("@gitlab E2E-31 lost answer after a successful create is reconciled without a duplicate", async ({ page, request }) => {
  const title = `Потерянный ответ E2E ${Date.now().toString(36)}`;
  const id = await mergedDocument(page, request, title);
  await openPreview(page, id);
  await request.post(`${CONFLUENCE}/__mock__/faults`, {
    data: { method: "POST", path_contains: "/rest/api/content", mode: "apply_then_status", status: 504 },
  });
  await page.getByRole("button", { name: "Опубликовать в Confluence" }).click();
  await expect(page.getByText("Опубликовано в Confluence").first()).toBeVisible();
  expect((await confluence(request)).pages.filter((p) => p.title === title)).toHaveLength(1);
});

test("@gitlab E2E-33/36 unmerged revision and a foreign page with the same title are never published", async ({ page, request }) => {
  // fixtures sit in the mock's initial commit: no merged MR proves that revision
  await openPublication(page, "SEM-ARCH-001");
  await page.locator("#publication").getByRole("button", { name: "Подготовить публикацию" }).click();
  await expect(page.getByText("Публикация заблокирована:", { exact: true })).toBeVisible();
  await expect(page.getByText(/merged MR/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Опубликовать в Confluence" })).toBeDisabled();

  const id = await mergedDocument(page, request, "Чужая страница (MOCK)");
  await openPreview(page, id);
  await expect(page.getByTestId("publication-action")).toHaveText("Конфликт — страница не будет изменена");
  await expect(page.getByText(/созданная не приложением/).first()).toBeVisible();
  expect((await confluence(request)).write_requests).toBe(0);
});
