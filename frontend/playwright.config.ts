import { defineConfig, devices } from "@playwright/test";

/*
 * Two stacks, no external sites:
 * - "desktop" / "mobile": the offline demo stack (docker compose or `make dev`), E2E_BASE_URL.
 * - "gitlab-mock": started here — loopback TEST DOUBLES of GitLab (:8929), Confluence MCP (:8930) and
 *   Confluence Data Center REST (:8931) from backend/tests/support, a backend in
 *   INTEGRATION_PROFILE=integration_mock (e2e/gitlab-stack.sh) and a Vite dev server proxying to it.
 *   Scenarios tagged @gitlab run there. Passing against doubles is NOT evidence about real systems.
 * - "scripted" / "scripted-mobile" (M5.7, only when E2E_SCRIPTED_URL is set): e2e/m57.spec.ts and
 *   e2e/answerMarkdown.spec.ts (Markdown answers with markers) against a UI whose
 *   backend talks to the SCRIPTED MODEL double (backend/tests/support/scripted_model.py, docs/AI_NATIVE_TOOLS.md
 *   «Scripted model»). The double stands in for a model that chooses tools; it is not evidence about a real model.
 *   Without the variable these specs are not selected at all, so the ordinary suites stay as they are.
 */
const withGitLabStack = !process.env.E2E_SKIP_GITLAB_STACK;
const scriptedUrl = process.env.E2E_SCRIPTED_URL;
const SCRIPTED_SPECS = /(m57|answerMarkdown)\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: withGitLabStack
    ? [
        {
          command: "cd ../backend && ../.venv/bin/python -m tests.support.gitlab_mock --port 8929",
          url: "http://127.0.0.1:8929/__mock__/state",
          reuseExistingServer: false,
          timeout: 30_000,
        },
        {
          command: "cd ../backend && ../.venv/bin/python -m tests.support.mcp_mock --port 8930",
          url: "http://127.0.0.1:8930/__mock__/state",
          reuseExistingServer: false,
          timeout: 30_000,
        },
        {
          command:
            "cd ../backend && ../.venv/bin/python -m tests.support.confluence_mock --port 8931 --public-url http://127.0.0.1:8931/confluence",
          url: "http://127.0.0.1:8931/__mock__/state",
          reuseExistingServer: false,
          timeout: 30_000,
        },
        {
          command: "sh e2e/gitlab-stack.sh",
          url: "http://127.0.0.1:8011/api/health",
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: "npx vite",
          env: { SKH_BACKEND_URL: "http://127.0.0.1:8011", FRONTEND_PORT: "5175" },
          url: "http://127.0.0.1:5175",
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ]
    : undefined,
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } },
      grepInvert: /@mobile|@gitlab/,
      testIgnore: SCRIPTED_SPECS,
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/, testIgnore: SCRIPTED_SPECS },
    {
      name: "gitlab-mock",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1360, height: 900 },
        baseURL: "http://127.0.0.1:5175",
      },
      grep: /@gitlab(?!-mobile)/,
      testIgnore: SCRIPTED_SPECS,
    },
    {
      name: "gitlab-mock-mobile",
      use: { ...devices["Pixel 7"], baseURL: "http://127.0.0.1:5175" },
      grep: /@gitlab-mobile/,
      testIgnore: SCRIPTED_SPECS,
    },
    ...(scriptedUrl
      ? [
          {
            name: "scripted",
            use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 }, baseURL: scriptedUrl },
            testMatch: SCRIPTED_SPECS,
            grepInvert: /@mobile/,
          },
          {
            name: "scripted-mobile",
            use: { ...devices["Pixel 7"], baseURL: scriptedUrl },
            testMatch: SCRIPTED_SPECS,
            grep: /@mobile/,
          },
        ]
      : []),
  ],
});
