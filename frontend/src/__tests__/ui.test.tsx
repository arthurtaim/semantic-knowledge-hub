import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton, buttonClass } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { ICON_NAMES, Icon } from "../components/ui/Icon";
import { Menu, Popover } from "../components/ui/Popover";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { StatusMark } from "../components/ui/StatusMark";
import { Tooltip } from "../components/ui/Tooltip";
import { readThemeChoice, THEME_STORAGE_KEY, useTheme } from "../lib/theme";
import { memoryStorage } from "./helpers";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

describe("Icon", () => {
  it("draws every icon of the set as a decorative 16 px line icon", () => {
    expect(ICON_NAMES).toEqual(
      expect.arrayContaining([
        "search", "assistant", "review", "documents", "map", "templates", "proposals", "publications", "integrations",
        "file", "paperclip", "skill", "at", "send", "close", "plus", "chevron", "more", "approved", "clock", "info", "upload",
      ]),
    );
    const { container } = render(
      <>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </>,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(ICON_NAMES.length);
    for (const svg of svgs) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("width", "16");
      expect(svg.getAttribute("stroke-width")).toBe("1.75");
      expect(svg.childElementCount).toBeGreaterThan(0);
    }
  });

  it("is an image with a name only when it stands alone", () => {
    render(<Icon name="approved" label="Утверждён" />);
    expect(screen.getByRole("img", { name: "Утверждён" })).toBeInTheDocument();
  });
});

describe("Button", () => {
  it("renders the variants as one family and never submits by accident", () => {
    render(
      <>
        <Button variant="primary">Создать документ</Button>
        <Button>Отмена</Button>
        <Button variant="quiet" icon="plus" size="sm">
          Фильтр
        </Button>
      </>,
    );
    const primary = screen.getByRole("button", { name: "Создать документ" });
    expect(primary).toHaveClass("button", "button--primary");
    expect(primary).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveClass("button--secondary");
    const quiet = screen.getByRole("button", { name: "Фильтр" });
    expect(quiet).toHaveClass("button--quiet", "button--sm");
    expect(quiet.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(buttonClass("primary", "sm", "x")).toBe("button button--primary button--sm x");
  });

  it("names an icon-only button by its label", async () => {
    const onClick = vi.fn();
    render(<IconButton icon="more" label="Ещё действия" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Ещё действия" });
    expect(button).toHaveClass("button--icon", "button--quiet");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("SegmentedControl", () => {
  function Views() {
    const [value, setValue] = useState<"list" | "table" | "map">("table");
    return (
      <>
        <SegmentedControl
          label="Вид"
          value={value}
          onChange={setValue}
          options={[
            { value: "list", label: "Список" },
            { value: "table", label: "Таблица" },
            { value: "map", label: "Карта", disabled: true, hint: "Нет карты для этого списка" },
          ]}
          describedBy="views-hint"
        />
        <p id="views-hint">Выбор запоминается.</p>
        <output>{value}</output>
      </>
    );
  }

  it("is a named group of radio buttons with one choice", async () => {
    render(<Views />);
    const group = screen.getByRole("group", { name: "Вид" });
    expect(within(group).getByRole("radio", { name: "Таблица" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "Список" }));
    expect(within(group).getByRole("radio", { name: "Список" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("list");
    expect(within(group).getByRole("radio", { name: "Карта" })).toBeDisabled();
    // UI v2 phase F: the one segmented style (.segmented, the raised chosen segment) — the map and the create page
    // use this component; a disabled option says why on hover; the group is described by the page's hint.
    expect(group).toHaveClass("segmented");
    expect(group).toHaveAccessibleDescription("Выбор запоминается.");
    expect(within(group).getByRole("radio", { name: "Карта" }).closest("label")).toHaveAttribute("title", "Нет карты для этого списка");
    expect(within(group).getByRole("radio", { name: "Список" }).closest("label")).not.toHaveAttribute("title");
  });
});

describe("Chip", () => {
  it("has its own named remove button", async () => {
    const onRemove = vi.fn();
    render(
      <Chip tone="filter" onRemove={onRemove} removeLabel="Убрать фильтр: Статус">
        Статус: Утверждён
      </Chip>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Убрать фильтр: Статус" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("can be a toggle and carries the skill tone", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Chip tone="skill" icon="skill" onClick={onClick} selected>
        Черновик документа
      </Chip>,
    );
    const toggle = screen.getByRole("button", { name: "Черновик документа" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(onClick).toHaveBeenCalledOnce();
    expect(container.firstElementChild).toHaveClass("chip--skill");
  });
});

describe("StatusMark", () => {
  it.each([
    ["approved", "Утверждён"],
    ["in_review", "На ревью"],
    ["draft", "Черновик"],
    ["deprecated", "Устарел"],
  ] as const)("shows %s as text and a shape", (status, text) => {
    const { container } = render(<StatusMark status={status} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark).toHaveTextContent(text);
    expect(mark).toHaveClass(`status-mark--${status}`);
    expect(mark).toHaveAttribute("data-status", status);
    expect(mark.querySelector(status === "approved" ? "svg" : ".status-mark__shape")).toHaveAttribute("aria-hidden", "true");
  });

  it("names an external source", () => {
    render(<StatusMark status={null} />);
    expect(screen.getByText("Внешний источник")).toHaveClass("status-mark--external");
  });
});

describe("Popover", () => {
  function renderPopover() {
    return render(
      <MemoryRouter>
        <Popover id="facts" trigger={(props) => <button {...props}>Подробнее</button>}>
          <p>Документы синтетические.</p>
        </Popover>
        <button type="button">Снаружи</button>
      </MemoryRouter>,
    );
  }

  it("opens from its button, closes on Esc and returns focus", async () => {
    renderPopover();
    const trigger = screen.getByRole("button", { name: "Подробнее" });
    expect(trigger).toHaveAttribute("aria-controls", "facts");
    expect(screen.getByText("Документы синтетические.")).not.toBeVisible();
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Документы синтетические.")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes on a press outside", async () => {
    renderPopover();
    await userEvent.click(screen.getByRole("button", { name: "Подробнее" }));
    await userEvent.click(screen.getByRole("button", { name: "Снаружи" }));
    expect(screen.getByRole("button", { name: "Подробнее" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Menu (APG menu button)", () => {
  function ThemeMenu({ onPick }: { onPick: (value: string) => void }) {
    const [value, setValue] = useState("system");
    const pick = (next: string) => {
      setValue(next);
      onPick(next);
    };
    return (
      <>
        <Menu
          label="Пользователь"
          header={<span>Демо-пользователь</span>}
          trigger={(props) => (
            <button type="button" {...props}>
              Меню пользователя
            </button>
          )}
          groups={[
            {
              label: "Тема",
              radio: true,
              items: [
                { id: "system", label: "Как в системе", checked: value === "system", onSelect: () => pick("system") },
                { id: "light", label: "Светлая", checked: value === "light", onSelect: () => pick("light") },
                { id: "dark", label: "Тёмная", checked: value === "dark", onSelect: () => pick("dark") },
              ],
            },
            { items: [{ id: "integrations", label: "Интеграции", onSelect: () => pick("integrations") }] },
          ]}
        />
        <button type="button">Дальше</button>
      </>
    );
  }

  it("opens on ↓ at the first item, moves with arrows (wrapping), Home and End, and chooses with Enter", async () => {
    const onPick = vi.fn();
    render(<ThemeMenu onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: "Меню пользователя" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Пользователь" });
    expect(within(menu).getByRole("group", { name: "Тема" })).toBeInTheDocument();
    const system = within(menu).getByRole("menuitemradio", { name: "Как в системе" });
    expect(system).toHaveFocus();
    expect(system).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowUp}");
    expect(within(menu).getByRole("menuitem", { name: "Интеграции" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(system).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(within(menu).getByRole("menuitem", { name: "Интеграции" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(menu).getByRole("menuitemradio", { name: "Светлая" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("light");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("opens on ↑ at the last item, finds an item by its first letter and closes on Esc", async () => {
    const onPick = vi.fn();
    render(<ThemeMenu onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: "Меню пользователя" });
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Интеграции" })).toHaveFocus();
    await userEvent.keyboard("т");
    expect(screen.getByRole("menuitemradio", { name: "Тёмная" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(onPick).toHaveBeenCalledWith("dark");
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Тёмная" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab and on a press outside without choosing", async () => {
    const onPick = vi.fn();
    render(<ThemeMenu onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: "Меню пользователя" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Как в системе" })).toHaveFocus();
    await userEvent.tab();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Дальше" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("Tooltip", () => {
  it("describes its control on hover and on focus, and Esc hides it", async () => {
    render(
      <Tooltip content="Свернуть боковую панель (Ctrl+\)" delayMs={0}>
        <button type="button">Свернуть</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Свернуть" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(button).toHaveAttribute("aria-describedby", tip.id);
    expect(tip).not.toBeVisible();
    await userEvent.hover(button);
    expect(tip).toBeVisible();
    await userEvent.unhover(button);
    expect(tip).not.toBeVisible();
    act(() => button.focus());
    expect(tip).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(tip).not.toBeVisible();
    expect(button).toHaveFocus();
  });

  it("only shows a label that the control already has (an icon rail)", () => {
    render(
      <Tooltip content="Документы" side="right" asLabel>
        <a href="/documents" aria-label="Документы">
          <Icon name="documents" />
        </a>
      </Tooltip>,
    );
    const link = screen.getByRole("link", { name: "Документы" });
    expect(link).not.toHaveAttribute("aria-describedby");
  });
});

describe("Theme", () => {
  it("defaults to the system theme and applies and remembers a choice", () => {
    expect(readThemeChoice()).toBe("system");
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]("dark"));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(result.current[0]).toBe("dark");
    act(() => result.current[1]("system"));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("still works when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(readThemeChoice()).toBe("system");
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]("light"));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
