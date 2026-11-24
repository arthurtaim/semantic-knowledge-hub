import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DocumentPage } from "../pages/DocumentPage";
import { arisDetail, gitlabDetail } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

const drafts = { items: [], total: 0 };

describe("Document detail", () => {
  it("renders metadata passport with provenance", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const passport = await screen.findByRole("complementary", { name: "Паспорт документа" });
    expect(within(passport).getByText("Черновик")).toBeInTheDocument();
    expect(within(passport).getByText("demo-team")).toBeInTheDocument();
    expect(within(passport).getByText("sha256:df6c505c42a7e51e")).toBeInTheDocument();
    expect(within(passport).getByText("local://SEM-INT-ARIS-001")).toBeInTheDocument();
    expect(within(passport).getByRole("link", { name: "Semantic Layer — demonstration architecture" })).toHaveAttribute(
      "href",
      "/documents/SEM-ARCH-001",
    );
    expect(screen.getAllByText(/Демо-данные/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Предложить изменение" })).toHaveAttribute(
      "href",
      "/proposals/new?document=SEM-INT-ARIS-001",
    );
  });

  it("links the document's neighbourhood on the knowledge graph", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    expect(await screen.findByRole("link", { name: "Связи на графе" })).toHaveAttribute(
      "href",
      "/graph?focus=SEM-INT-ARIS-001",
    );
  });

  it("sanitizes hostile HTML before rendering", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    const { container } = renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await screen.findByRole("heading", { name: "ARIS", level: 1 });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
    expect(container.querySelector('a[href="/documents/SEM-ARCH-001"]')).not.toBeNull();
  });

  it("switches to the raw Markdown view", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Исходный Markdown" }));
    expect(screen.getByText(/id: SEM-INT-ARIS-001/)).toBeInTheDocument();
  });

  it("shows a not-found state for unknown documents", async () => {
    mockApi([
      { path: "/api/documents/NOPE", status: 404, body: { code: "document_not_found", message: "Документ NOPE не найден.", request_id: "r1" } },
      { path: "/api/drafts?document_id=NOPE", body: drafts },
    ]);
    renderAt("/documents/NOPE", "/documents/:id", <DocumentPage />);
    expect(await screen.findByText("Документ не найден")).toBeInTheDocument();
  });

  it("does not invent an external link for a local workspace document", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const passport = await screen.findByRole("complementary", { name: "Паспорт документа" });
    expect(within(passport).getByText("Дата ревизии")).toBeInTheDocument();
    expect(within(passport).getByText(/Документ хранится в локальном workspace/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Открыть в GitLab/ })).toBeNull();
    expect(screen.queryByText("Версия может быть устаревшей")).toBeNull();
  });

  it("links to the exact GitLab revision and flags a stale index state", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: gitlabDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const passport = await screen.findByRole("complementary", { name: "Паспорт документа" });
    const link = within(passport).getByRole("link", { name: "Открыть в GitLab" });
    expect(link).toHaveAttribute("href", gitlabDetail.web_url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(passport).getByText("3f2a9c1d")).toBeInTheDocument();
    expect(within(passport).getByText("GitLab")).toBeInTheDocument();
    expect(within(passport).getByText("Версия может быть устаревшей")).toBeInTheDocument();
    expect(screen.getByText("Версия может быть устаревшей.")).toBeInTheDocument();
    expect(screen.queryByText(/локальном workspace/)).toBeNull();
  });
});
