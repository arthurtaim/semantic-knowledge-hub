import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IntegrationsPage } from "../pages/IntegrationsPage";
import { freshSync, integrations } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

const failing = {
  ...integrations.items[0],
  name: "gitlab_proposals",
  title: "GitLab Merge Requests для предложений",
  state: "error" as const,
  human_readable_message: "Проверка соединения не прошла.",
};

describe("Integrations list", () => {
  it("lists failed, connected and demo integrations first and groups the unconfigured ones", async () => {
    mockApi([
      { path: "/api/integrations/status", body: { ...integrations, items: [...integrations.items, failing] } },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    await screen.findByRole("heading", { name: "AI-провайдер" });

    const order = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(order.slice(0, 4)).toEqual([
      "GitLab Merge Requests для предложений",
      "Локальная база знаний",
      "AI-провайдер",
      "Не подключено",
    ]);
    const group = screen.getByRole("heading", { name: "Не подключено", level: 2 }).nextElementSibling as HTMLElement;
    for (const item of within(group).getAllByRole("listitem")) {
      expect(within(item).getByText("Не подключено", { selector: ".state" })).toBeInTheDocument();
    }
    expect(within(group).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows target, access, last check and capabilities as facts of the row", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    const row = (await screen.findByRole("heading", { name: "AI-провайдер" })).closest("li") as HTMLElement;
    const facts = within(row).getByText("Цель").closest("dl") as HTMLElement;
    for (const term of ["Цель", "Доступ", "Последняя проверка", "Возможности"]) {
      expect(within(facts).getByText(term)).toBeInTheDocument();
    }
    expect(within(facts).getByText("extractive_answers")).toBeInTheDocument();
  });
});

const discoveryStats = {
  discovery: {
    traces: 2,
    links_by_feedback: { unrated: 12, relevant: 1 },
    invalidated_sources: 0,
    retention_hours: 24,
    stores_query_text: false,
    policy_version: "discovery-v1",
  },
  external: {
    requests: 2,
    mcp_calls: 5,
    cache_hits: 3,
    cache_misses: 3,
    timeouts: 0,
    errors: 0,
    rejected: 0,
    revoked_or_deleted: 0,
    evicted: 0,
    cache_pages: 3,
    cache_limit: 100,
    cache_ttl_seconds: 86400,
    breaker: "closed",
    max_concurrent_seen: 1,
    concurrency_limit: 2,
    latency_p50_ms: 5.77,
    latency_p95_ms: 7.0,
    limits: {},
  },
};

describe("Discovery memory and the external source", () => {
  it("shows cache, MCP calls, latency, breaker and retention, and erases the memory after a confirmation", async () => {
    let purged = false;
    const calls = mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
      { path: "/api/discovery/stats", body: () => (purged ? { ...discoveryStats, discovery: { ...discoveryStats.discovery, traces: 0 } } : discoveryStats) },
      {
        method: "DELETE",
        path: "/api/discovery",
        body: () => {
          purged = true;
          return { removed_records: 14, removed_cache_pages: 3 };
        },
      },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    const section = (await screen.findByRole("heading", { name: "Память поиска и внешний источник" })).closest("section") as HTMLElement;
    expect(await within(section).findByText("3 из 100")).toBeInTheDocument();
    expect(within(section).getByText("Вызовы MCP").nextElementSibling).toHaveTextContent("5");
    expect(within(section).getByText("Задержка p95").nextElementSibling).toHaveTextContent("7 мс");
    expect(within(section).getByText(/в норме — запросы к Confluence выполняются/)).toBeInTheDocument();
    expect(within(section).getByText("24 часа")).toBeInTheDocument();
    expect(within(section).getByText("текст вопросов не хранится")).toBeInTheDocument();

    await userEvent.click(within(section).getByRole("button", { name: "Очистить память поиска" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(within(section).getByText(/Удалить следы ответов, отзывы и кэш внешних страниц\?/)).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Подтвердить очистку" }));
    expect(await within(section).findByText(/удалено записей — 14, страниц кэша — 3/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/discovery"]);
    await waitFor(() => expect(within(section).getByText("Следов ответов").nextElementSibling).toHaveTextContent("0"));
  });

  it("says when the external source is not connected", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
      { path: "/api/discovery/stats", body: { discovery: discoveryStats.discovery, external: { enabled: false } } },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    expect(await screen.findByText("Внешний источник не подключён — запросов к Confluence нет.")).toBeInTheDocument();
  });

  it("shows the index generation and what the last sync changed", async () => {
    mockApi([
      { path: "/api/integrations/status", body: integrations },
      { path: "/api/knowledge/issues", body: [] },
      {
        path: "/api/index/status",
        body: {
          ...freshSync,
          generation: 4,
          last_sync: {
            generation: 4,
            applied: true,
            added: ["DEMO-INT-020"],
            updated: ["DEMO-INT-002", "DEMO-SEM-002"],
            renamed: [],
            deleted: [],
            unchanged: 80,
            rejected: [],
            checksum: "0f91",
            elapsed_ms: 99.3,
            full_rebuild: false,
            finished_at: "2026-11-23T12:00:00+00:00",
          },
        },
      },
    ]);
    renderAt("/integrations", "/integrations", <IntegrationsPage />);
    const section = (await screen.findByRole("heading", { name: "Синхронизация и поисковый индекс" })).closest("section") as HTMLElement;
    expect(await within(section).findByText("Поколение индекса")).toBeInTheDocument();
    expect(within(section).getByText("Поколение индекса").nextElementSibling).toHaveTextContent("4");
    expect(within(section).getByText("Последняя синхронизация").nextElementSibling).toHaveTextContent(
      "добавлено 1, обновлено 2, переименовано 0, удалено 0, без изменений 80",
    );
  });
});
