import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { DocumentPage } from "../pages/DocumentPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { arisDetail, session } from "./fixtures";
import { mockApi, renderAt } from "./helpers";

const drafts = { items: [], total: 0 };

describe("Phase 4 accessibility", () => {
  it("gives the 404 page and a page-level error an H1", async () => {
    renderAt("/nope", "*", <NotFoundPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Такой страницы нет" })).toBeInTheDocument();

    mockApi([
      { path: "/api/documents/NOPE", status: 404, body: { code: "document_not_found", message: "Нет.", request_id: "r" } },
      { path: "/api/drafts?document_id=NOPE", body: drafts },
    ]);
    renderAt("/documents/NOPE", "/documents/:id", <DocumentPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Документ не найден" })).toBeInTheDocument();
  });

  it("moves between document tabs with the arrow keys, Home and End (roving tabindex)", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    const rendered = await screen.findByRole("tab", { name: "Документ" });
    const metadata = screen.getByRole("tab", { name: "Метаданные" });
    const raw = screen.getByRole("tab", { name: "Исходный Markdown" });
    expect(rendered).toHaveAttribute("tabindex", "0");
    expect(metadata).toHaveAttribute("tabindex", "-1");

    rendered.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(metadata).toHaveFocus();
    expect(metadata).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{End}");
    expect(raw).toHaveFocus();
    expect(raw).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(rendered).toHaveFocus(); // wraps
    await userEvent.keyboard("{ArrowLeft}");
    expect(raw).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(rendered).toHaveAttribute("aria-selected", "true");
  });

  it("closes the mobile menu with Esc and returns focus to «Меню»", async () => {
    mockApi([{ path: "/api/session", body: session }]);
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <App />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole("button", { name: "Меню" });
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Закрыть" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    const closed = screen.getByRole("button", { name: "Меню" });
    expect(closed).toHaveAttribute("aria-expanded", "false");
    expect(closed).toHaveFocus();
  });
});
