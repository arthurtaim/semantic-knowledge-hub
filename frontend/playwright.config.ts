import { defineConfig, devices } from "@playwright/test";

/*
 * Two stacks, no external sites:
 * - "desktop" / "mobile": the offline demo stack (docker compose or `make dev`), E2E_BASE_URL.
 * - "gitlab-mock": started here — the loopback GitLab TEST DOUBLE (backend/tests/support/gitlab_mock.py),
 *   a backend in KNOWLEDGE_BACKEND=gitlab mode (e2e/gitlab-stack.sh) and a Vite dev server proxying to it.
 *   Scenarios tagged @gitlab run there. A mock MR is NOT evidence that a real GitLab behaves the same.
 */
const withGitLabStack = !process.env.E2E_SKIP_GITLAB_STACK;

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
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
    {
      name: "gitlab-mock",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1360, height: 900 },
        baseURL: "http://127.0.0.1:5175",
      },
      grep: /@gitlab/,
    },
  ],
});
