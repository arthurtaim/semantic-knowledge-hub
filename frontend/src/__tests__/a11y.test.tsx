import { render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { SafeHtml } from "../components/SafeHtml";
import { usePinnedBottom } from "../lib/usePinnedBottom";
import { DocumentPage } from "../pages/DocumentPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { arisDetail, session } from "./fixtures";
import { mockApi, mockViewport, renderAt } from "./helpers";

const drafts = { items: [], total: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("moves between document segments with the arrow keys, Home and End (roving tabindex)", async () => {
    mockApi([
      { path: "/api/documents/SEM-INT-ARIS-001", body: arisDetail },
      { path: "/api/drafts?document_id=SEM-INT-ARIS-001", body: drafts },
    ]);
    renderAt("/documents/SEM-INT-ARIS-001", "/documents/:id", <DocumentPage />);
    // UI v2 segments: Текст / Связи / История / Markdown (formerly Документ / Метаданные / Исходный Markdown).
    const rendered = await screen.findByRole("tab", { name: "Текст" });
    const metadata = screen.getByRole("tab", { name: "Связи" });
    const raw = screen.getByRole("tab", { name: "Markdown" });
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

  // UI v2: below 960 px the sidebar is a slide-over drawer opened by «Меню» in the page toolbar.
  it("opens the drawer from «Меню», keeps Tab inside it, closes it with Esc and returns focus to «Меню»", async () => {
    mockViewport(390);
    mockApi([{ path: "/api/session", body: session }]);
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <App />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole("button", { name: "Меню" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("app-sidebar")).toHaveAttribute("inert");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const drawer = screen.getByRole("dialog", { name: "Меню" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer).not.toHaveAttribute("inert");
    const close = within(drawer).getByRole("button", { name: "Закрыть меню" });
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    const brand = within(drawer).getByRole("link", { name: /Knowledge Hub/ });
    expect(brand).toHaveFocus();
    await userEvent.tab({ shift: true }); // wraps to the last control
    expect(within(drawer).getByRole("button", { name: /Демо-пользователь/ })).toHaveFocus();
    await userEvent.tab(); // and back to the first
    expect(brand).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Меню" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
});

describe("UI v2 phase F accessibility", () => {
  it("gives a document table or code block that scrolls in its own frame a tab stop (keyboard scrolling)", () => {
    // jsdom has no layout: the code block is wider than its frame, the table fits.
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "PRE" ? 640 : 300;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    render(
      <MemoryRouter>
        <SafeHtml className="prose" html={"<pre><code>SELECT * FROM very_long_table_name;</code></pre><table><tr><td>A</td></tr></table>"} />
      </MemoryRouter>,
    );
    expect(document.querySelector("pre")).toHaveAttribute("tabindex", "0");
    expect(document.querySelector("table")).not.toHaveAttribute("tabindex");
    vi.restoreAllMocks();
  });

  it("publishes the pinned field's height for html scroll-padding-bottom and removes it on unmount (2.4.11)", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 131.4 } as DOMRect);
    function Pinned() {
      const ref = useRef<HTMLDivElement>(null);
      usePinnedBottom(ref);
      return <div ref={ref}>поле</div>;
    }
    const { unmount } = render(<Pinned />);
    expect(document.documentElement.style.getPropertyValue("--pinned-bottom")).toBe("132px");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--pinned-bottom")).toBe("");
    vi.restoreAllMocks();
  });
});
