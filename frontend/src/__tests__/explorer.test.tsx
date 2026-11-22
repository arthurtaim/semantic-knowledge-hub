import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ExplorerPage } from "../pages/ExplorerPage";
import { documentPage, emptyPage, facets } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

describe("Knowledge explorer", () => {
  it("shows search results with status, provenance and highlighted snippet", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: "/api/documents?query=ARIS&page=1&size=20", body: documentPage },
    ]);
    renderAt("/documents?query=ARIS", "/documents", <ExplorerPage />);

    const link = await screen.findByRole("link", { name: "ARIS integration — questions for discovery" });
    expect(link).toHaveAttribute("href", "/documents/SEM-INT-ARIS-001");
    const result = link.closest("li") as HTMLElement;
    expect(within(result).getByText("Черновик")).toBeInTheDocument();
    expect(within(result).getByText("SEM-INT-ARIS-001")).toBeInTheDocument();
    expect(within(result).getByText("Локальный workspace")).toBeInTheDocument();
    expect(within(result).getByText("ARIS", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText(/1 документ по запросу «ARIS»/)).toBeInTheDocument();
  });

  it("shows an explicit empty state instead of inventing results", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?query=/, body: emptyPage },
    ]);
    renderAt("/documents?query=nothing", "/documents", <ExplorerPage />);
    expect(await screen.findByText("По запросу «nothing» ничего не найдено")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem", { name: /ARIS/ })).toHaveLength(0);
  });

  it("applies a status filter through the URL-backed query", async () => {
    const calls = mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, body: documentPage },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    await screen.findByRole("link", { name: /ARIS integration/ });
    await userEvent.click(screen.getByRole("button", { name: /Черновик/ }));
    expect(calls.some((c) => c.url.includes("status=draft"))).toBe(true);
    expect(screen.getByRole("button", { name: /Черновик/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("reports server errors with the request id", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: facets },
      { path: /\/api\/documents\?/, status: 500, body: { code: "internal_error", message: "Внутренняя ошибка сервера.", request_id: "abc123" } },
    ]);
    renderAt("/documents", "/documents", <ExplorerPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Внутренняя ошибка сервера.");
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });
});
