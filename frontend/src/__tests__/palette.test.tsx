import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QuickFind } from "../components/QuickFind";
import { askHref } from "../lib/assistant";
import { SessionContext } from "../lib/session";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiMode, DocumentPage } from "../api/types";
import { Layout } from "../components/Layout";
import { arisSummary, session } from "./fixtures";
import { mockApi, renderRoutes } from "./helpers";

const withMode = (ai_mode: AiMode) => ({ ...session, features: { ...session.features, ai_mode } });
const matches: DocumentPage = { items: [arisSummary], total: 1, page: 1, size: 6 };

const routes = {
  "/documents": (
    <Layout>
      <p>Каталог</p>
    </Layout>
  ),
  "/documents/:id": (
    <Layout>
      <p>Документ</p>
    </Layout>
  ),
  "/ask": (
    <Layout>
      <p>Экран ответа</p>
    </Layout>
  ),
};

afterEach(() => {
  vi.useRealTimers();
});

// UI v2: the trigger is the sidebar's «Поиск» (it replaced the field-like button in the old tool row).
async function openPalette() {
  await userEvent.click(screen.getByRole("button", { name: "Поиск" }));
  return screen.getByRole("dialog");
}

describe("«Спросить или найти»: the ⌘K palette from the sidebar", () => {
  it("opens from a visible trigger as a dialog with a combobox, announces the shortcut, and returns focus on Esc", async () => {
    renderRoutes("/documents", routes);
    const trigger = screen.getByRole("button", { name: "Поиск" });
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K /");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    const dialog = await openPalette();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const input = within(dialog).getByRole("combobox", { name: "Спросить или найти" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("placeholder", "Спросить или найти…");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("opens with Ctrl+K and «/», but «/» types normally inside a text field", async () => {
    renderRoutes("/documents", {
      ...routes,
      "/documents": (
        <Layout>
          <label>
            Заметка
            <input />
          </label>
        </Layout>
      ),
    });
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("/");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.type(screen.getByLabelText("Заметка"), "a/b");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Заметка")).toHaveValue("a/b");
  });

  it("shows instant matches from the search API; ↓ + Enter opens a document", async () => {
    const calls = mockApi([{ path: /^\/api\/documents\?query=/, body: matches }]);
    renderRoutes("/documents", routes);
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox");
    await userEvent.type(input, "ARIS");
    const listbox = await within(dialog).findByRole("listbox", { name: "Подсказки" });
    expect(await within(listbox).findByRole("option", { name: /ARIS integration/ })).toBeInTheDocument();
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Спросить ИИ«ARIS»",
      expect.stringContaining("ARIS integration — questions for discovery"),
      "Все результатыпоиска «ARIS»",
    ]);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(within(listbox).queryByRole("option", { selected: true })).toBeNull(); // nothing preselected
    expect(calls.map((c) => c.url)).toContain("/api/documents?query=ARIS&size=6");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    const doc = within(listbox).getByRole("option", { name: /ARIS integration/ });
    expect(doc).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", doc.id);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/documents/SEM-INT-ARIS-001");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks the AI on Enter (team scope by default) and searches after Tab switches the mode", async () => {
    mockApi([{ path: /^\/api\/documents\?query=/, body: matches }]);
    renderRoutes("/documents", routes);
    let dialog = await openPalette();
    await userEvent.type(within(dialog).getByRole("combobox"), "Где хранится база?{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent(`${askHref("Где хранится база?")}`);
    expect(askHref("Где хранится база?")).toBe("/ask?q=%D0%93%D0%B4%D0%B5+%D1%85%D1%80%D0%B0%D0%BD%D0%B8%D1%82%D1%81%D1%8F+%D0%B1%D0%B0%D0%B7%D0%B0%3F&run=1");

    dialog = await openPalette();
    const input = within(dialog).getByRole("combobox");
    await userEvent.type(input, "ревизия");
    await within(dialog).findByRole("option", { name: /ARIS integration/ });
    await userEvent.tab();
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleName("Поиск по базе знаний");
    expect(within(dialog).getByRole("button", { name: "Найти в документах" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByRole("option", { name: /Спросить ИИ/ })).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/documents?query=%D1%80%D0%B5%D0%B2%D0%B8%D0%B7%D0%B8%D1%8F");
  });

  it("is a search field only when AI is disabled — no mode switch, no ask option", async () => {
    mockApi([{ path: /^\/api\/documents\?query=/, body: matches }]);
    renderRoutes("/documents", routes, withMode("disabled"));
    const trigger = screen.getByRole("button", { name: "Поиск" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Найти в базе знаний" });
    const input = within(dialog).getByRole("combobox", { name: "Поиск по базе знаний" });
    expect(input).toHaveAttribute("placeholder", "Найти в базе знаний…");
    expect(within(dialog).queryByRole("group", { name: "Режим поля" })).toBeNull();
    await userEvent.type(input, "ARIS");
    await within(dialog).findByRole("option", { name: /ARIS integration/ });
    expect(within(dialog).queryByRole("option", { name: /Спросить ИИ/ })).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/documents?query=ARIS");
  });

  it("switches to asking when the session arrives after the first render (and keeps a user's choice)", () => {
    const tree = (value: typeof session | null) => (
      <SessionContext.Provider value={value}>
        <MemoryRouter>
          <QuickFind variant="palette" inputId="c" />
        </MemoryRouter>
      </SessionContext.Provider>
    );
    const { rerender } = render(tree(null));
    expect(screen.getByRole("combobox", { name: "Поиск по базе знаний" })).toBeInTheDocument();
    rerender(tree(session));
    expect(screen.getByRole("combobox", { name: "Спросить или найти" })).toBeInTheDocument();
    rerender(tree(withMode("disabled")));
    expect(screen.getByRole("combobox", { name: "Поиск по базе знаний" })).toBeInTheDocument();
  });

  it("keeps the dialog's Tab order inside it", async () => {
    renderRoutes("/documents", routes);
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox");
    const submit = within(dialog).getByRole("button", { name: "Спросить" });
    submit.focus();
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Спросить ИИ" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(submit).toHaveFocus();
    expect(input).not.toHaveFocus();
  });

  it("debounces matches and ignores a stale answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockApi([{ path: /^\/api\/documents\?query=/, body: matches }]);
    renderRoutes("/documents", routes);
    const dialog = await openPalette();
    await userEvent.type(within(dialog).getByRole("combobox"), "AR");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(calls.filter((c) => c.url.startsWith("/api/documents?query=")).map((c) => c.url)).toEqual([
      "/api/documents?query=AR&size=6",
    ]);
  });
});
