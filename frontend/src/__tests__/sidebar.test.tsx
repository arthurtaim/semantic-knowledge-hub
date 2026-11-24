import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout, SIDEBAR_COLLAPSED_KEY } from "../components/Layout";
import { PageToolbar } from "../components/shell/PageToolbar";
import { initials } from "../components/shell/Sidebar";
import { SessionContext } from "../lib/session";
import { activeNav, defaultCrumbs, documentTitle, contentWidth } from "../lib/routes";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { facets, proposalSummary, session } from "./fixtures";
import { memoryStorage, mockApi, mockViewport } from "./helpers";

function renderShell(path: string, page: React.ReactNode = <p>Страница</p>, value = session) {
  return render(
    <SessionContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<Layout>{page}</Layout>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "Основная навигация" });

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

describe("Sidebar", () => {
  it("collapses to an icon rail with the button and Ctrl+\\, keeps names for assistive technology and remembers it", async () => {
    const { unmount } = renderShell("/documents");
    const collapse = screen.getByRole("button", { name: "Свернуть боковую панель" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse).toHaveAttribute("aria-keyshortcuts", "Control+\\ Meta+\\");
    await userEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "Развернуть боковую панель" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("app-sidebar")).toHaveClass("sidebar--rail");
    // Icons only, but every item keeps its name and current state.
    expect(within(nav()).getByRole("link", { name: "Документы" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByText("Документы", { selector: "a > span" })).toHaveClass("visually-hidden");
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
    unmount();

    renderShell("/documents");
    expect(screen.getByRole("button", { name: "Развернуть боковую панель" })).toBeInTheDocument();
    await userEvent.keyboard("{Control>}\\{/Control}");
    expect(screen.getByRole("button", { name: "Свернуть боковую панель" })).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
  });

  it("shows a rail item's name as a tooltip on focus", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    renderShell("/");
    const link = within(nav()).getByRole("link", { name: "Карта знаний" });
    act(() => link.focus());
    const tooltip = link.parentElement?.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip).toHaveTextContent("Карта знаний");
    expect(tooltip).toBeVisible();
    expect(link).not.toHaveAttribute("aria-describedby"); // the name is not announced twice
  });

  it("switches the theme from the user menu and remembers the choice", async () => {
    renderShell("/");
    const user = screen.getByRole("button", { name: /Демо-пользователь \(localhost\)/ });
    await userEvent.click(user);
    const menu = screen.getByRole("menu", { name: "Пользователь и вид" });
    const theme = within(menu).getByRole("group", { name: "Тема" });
    expect(within(theme).getByRole("menuitemradio", { name: "Как в системе" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(theme).getByRole("menuitemradio", { name: "Тёмная" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(user).toHaveFocus();

    // Keyboard: ↓ opens the menu, End jumps, Enter chooses.
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Как в системе" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("shows counts only from the API: documents, proposals and the green review badge", async () => {
    mockApi([
      { path: "/api/knowledge/facets", body: { ...facets, total: 83 } },
      {
        path: "/api/drafts",
        body: {
          items: [
            proposalSummary({ id: "a", status: "ready_for_review" }),
            proposalSummary({ id: "b", status: "draft" }),
            proposalSummary({ id: "c", status: "ready_for_review" }),
          ],
          total: 3,
        },
      },
    ]);
    renderShell("/");
    const documents = within(nav()).getByRole("link", { name: "Документы" });
    expect(await within(documents).findByText("83")).toHaveClass("sidebar__count");
    expect(documents).toHaveAccessibleDescription("Документов: 83");
    const review = within(nav()).getByRole("link", { name: "Ревью" });
    expect(await within(review).findByText("2")).toHaveClass("sidebar__badge");
    expect(review).toHaveAccessibleDescription("Ждут ревью: 2");
    expect(within(nav()).getByRole("link", { name: "Предложения" })).toHaveAccessibleDescription("Предложений: 3");
  });

  it("shows no count when the API does not answer", async () => {
    mockApi([]);
    renderShell("/");
    await act(async () => {});
    expect(nav().querySelector(".sidebar__count, .sidebar__badge")).toBeNull();
  });

  it("marks «Ревью» for the review filter and «Публикации» for a publication job", () => {
    const { unmount } = renderShell("/proposals?status=ready_for_review");
    expect(within(nav()).getByRole("link", { name: "Ревью" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByRole("link", { name: "Предложения" })).not.toHaveAttribute("aria-current");
    unmount();
    renderShell("/publications/job-1");
    expect(within(nav()).getByRole("link", { name: "Публикации" })).toHaveAttribute("aria-current", "page");
  });

  it("opens the search palette from «Поиск» and returns focus to it", async () => {
    renderShell("/documents");
    const search = screen.getByRole("button", { name: "Поиск" });
    await userEvent.click(search);
    expect(screen.getByRole("dialog", { name: "Спросить или найти" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(search).toHaveFocus();
  });
});

describe("Drawer below 960 px", () => {
  it("has no rail button, closes on the scrim and on navigation", async () => {
    mockViewport(390);
    const { container } = renderShell("/documents");
    expect(screen.queryByRole("button", { name: /боковую панель/ })).toBeNull();
    const menu = screen.getByRole("button", { name: "Меню" });
    await userEvent.click(menu);
    expect(screen.getByRole("dialog", { name: "Меню" })).toBeInTheDocument();
    await userEvent.click(container.querySelector(".scrim") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Меню" })).toBeNull();
    expect(menu).toHaveFocus();

    await userEvent.click(menu);
    await userEvent.click(within(screen.getByRole("dialog", { name: "Меню" })).getByRole("link", { name: "Шаблоны" }));
    expect(screen.queryByRole("dialog", { name: "Меню" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "Шаблоны" })).toHaveAttribute("aria-current", "page");
  });

  it("stays wide at 960 px and more", () => {
    mockViewport(960);
    renderShell("/documents");
    expect(screen.queryByRole("button", { name: "Меню" })).toBeNull();
    expect(screen.getByRole("button", { name: "Свернуть боковую панель" })).toBeInTheDocument();
  });
});

describe("Page toolbar", () => {
  it("shows the route's default title, the demo badge and the AI-mode chip on every page", () => {
    renderShell("/integrations");
    const bar = screen.getByRole("banner");
    expect(within(bar).getByText("Интеграции")).toHaveClass("page-toolbar__title");
    expect(within(bar).getByRole("button", { name: "Демо-данные" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "ИИ: демо" })).toBeInTheDocument();
  });

  it("takes a page's own path and actions instead of the default", () => {
    renderShell(
      "/documents/SEM-ARCH-001",
      <>
        <PageToolbar
          crumbs={[{ label: "Документы", to: "/documents" }, { label: "Архитектура", to: "/documents?type=architecture" }, { label: "Semantic Layer" }]}
          actions={<button type="button">Предложить изменение</button>}
        />
        <h1>Semantic Layer</h1>
      </>,
    );
    const bar = screen.getByRole("banner");
    const path = within(bar).getByRole("navigation", { name: "Путь" });
    expect(within(path).getByRole("link", { name: "Документы" })).toHaveAttribute("href", "/documents");
    expect(within(path).getByText("Semantic Layer")).toHaveAttribute("aria-current", "page");
    expect(within(bar).queryByText("Документ")).toBeNull(); // the default path stepped aside
    expect(within(bar).getByRole("button", { name: "Предложить изменение" })).toBeInTheDocument();
    // The page keeps its own H1.
    expect(screen.getByRole("heading", { level: 1, name: "Semantic Layer" })).toBeInTheDocument();
  });

  it("renders inline when a page is shown without the shell", () => {
    render(
      <MemoryRouter>
        <PageToolbar crumbs={[{ label: "Шаблоны", to: "/templates" }, { label: "Спецификация датасета" }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Путь" })).toHaveTextContent("ШаблоныСпецификация датасета");
  });
});

describe("Route map", () => {
  it("gives every route of App.tsx a sidebar item (or none), a path and a width", () => {
    const routes: [string, string | null, string, string][] = [
      ["/", "assistant", "Ассистент", "default"],
      ["/ask", "assistant", "Ассистент", "text"],
      ["/documents", "documents", "Документы", "wide"],
      ["/documents/new", "documents", "Документы / Новый документ", "default"],
      ["/documents/import", "documents", "Документы / Новый документ / Импорт Markdown", "default"],
      ["/documents/SEM-ARCH-001", "documents", "Документы / Документ", "wide"], // its own text column + a right panel
      ["/graph", "map", "Карта знаний", "wide"],
      ["/templates", "templates", "Шаблоны", "default"],
      ["/templates/dataset_spec", "templates", "Шаблоны / Шаблон", "default"],
      ["/proposals", "proposals", "Предложения", "wide"],
      ["/proposals/new", "proposals", "Предложения / Новое предложение", "default"],
      ["/proposals/p-1", "proposals", "Предложения / Предложение", "default"],
      ["/publications/job-1", "publications", "Публикации / Публикация", "default"],
      ["/integrations", "integrations", "Интеграции", "default"],
      ["/corporate/200101", null, "Корпоративная страница", "default"],
      ["/no-such-page", null, "Страница не найдена", "default"],
    ];
    for (const [path, item, crumbs, width] of routes) {
      expect(activeNav(path, ""), path).toBe(item);
      expect(defaultCrumbs(path, true).map((c) => c.label).join(" / "), path).toBe(crumbs);
      expect(contentWidth(path), path).toBe(width);
    }
    expect(defaultCrumbs("/", false)[0]?.label).toBe("Главная");
    expect(documentTitle("/graph", true)).toBe("Карта знаний — база знаний семантического слоя");
    expect(initials("Демо-пользователь (localhost)")).toBe("ДП");
  });
});
