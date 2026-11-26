import { expect, test, type Page } from "@playwright/test";

/*
 * Local-first adaptive RAG (docs/ADAPTIVE_RAG.md) against a stack whose backend talks to the SCRIPTED MODEL double
 * (backend/tests/support/scripted_model.py: its gap check says «need_external» for «лимит» / «требован», otherwise
 * «sufficient») AND the synthetic Confluence corpus (CONFLUENCE_CONNECTOR=mock). Selected only when E2E_SCRIPTED_URL
 * is set; skipped when the stack has no Confluence. Passing here is not evidence about a real model.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(String(err)));
  return problems;
}

async function corporateConfigured(page: Page): Promise<boolean> {
  const session = (await (await page.request.get("/api/session", { headers: { "X-SKH-Client": "web" } })).json()) as {
    features: { corporate_search: string };
  };
  return session.features.corporate_search !== "disabled";
}

async function askBoth(page: Page, question: string) {
  await page.goto("/ask");
  await page.getByLabel("Вопрос").fill(question);
  await page.getByRole("button", { name: /^Где искать:/ }).click();
  await page.getByRole("radio", { name: "Оба", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ассистент", exact: true }).first()).toBeVisible();
}

test("adaptive RAG: a gap in the team documents is searched in Confluence and named in words", async ({ page }) => {
  test.skip(!(await corporateConfigured(page)), "Confluence is not configured on this stack");
  const problems = watch(page);
  await askBoth(page, "Какой лимит размера пакета выгрузки CATIA в каталог?");
  await expect(
    page.getByText(/^Внешний источник: запрос к Confluence \(причина: в документах команды не хватает части сведений\)/),
  ).toBeVisible();
  // The API says the same, with codes and counts only (no question text, no queries).
  const response = await page.request.post("/api/assistant/ask", {
    headers: { "X-SKH-Client": "web" },
    data: { question: "Какой лимит размера пакета выгрузки CATIA в каталог?", sources: ["team", "corporate"] },
  });
  const body = (await response.json()) as {
    evidence_gate: { decision: string; model_calls: number; queries: number };
    external: { called: boolean; focused: boolean; searches: number };
  };
  expect(body.evidence_gate.decision).toBe("need_external");
  expect(body.evidence_gate.model_calls).toBe(1);
  expect(body.external.called && body.external.focused).toBe(true);
  expect(body.external.searches).toBeLessThanOrEqual(2);
  expect(JSON.stringify(body.evidence_gate)).not.toContain("CATIA");
  expect(problems).toEqual([]);
});

test("adaptive RAG: sufficient team documents mean no Confluence call", async ({ page }) => {
  test.skip(!(await corporateConfigured(page)), "Confluence is not configured on this stack");
  const problems = watch(page);
  await askBoth(page, "Как часто метаданные ARIS обновляются в каталоге?");
  await expect(page.getByText(/^Внешний источник: запрос к Confluence/)).toHaveCount(0);
  const response = await page.request.post("/api/assistant/ask", {
    headers: { "X-SKH-Client": "web" },
    data: { question: "Как часто метаданные ARIS обновляются в каталоге?", sources: ["team", "corporate"] },
  });
  const body = (await response.json()) as { evidence_gate: { decision: string }; external: unknown };
  expect(body.evidence_gate.decision).toBe("sufficient");
  expect(body.external).toBeNull();
  expect(problems).toEqual([]);
});
