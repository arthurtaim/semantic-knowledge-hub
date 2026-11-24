import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { Link, useLocation } from "react-router-dom";
import type { SessionResponse } from "../../api/types";
import { canAsk } from "../../lib/aiMode";
import { activeNav, navGroups, type NavItem } from "../../lib/routes";
import { THEME_CHOICES, THEME_LABEL, useTheme, type ThemeChoice } from "../../lib/theme";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { Menu } from "../ui/Popover";
import { Tooltip } from "../ui/Tooltip";
import type { NavCounts } from "./useNavCounts";

/** ⌘K on a Mac, Ctrl K elsewhere — as the search button shows it. */
export function searchKeysLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/i.test(platform) ? "⌘K" : "Ctrl K";
}

export function collapseKeysLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/i.test(platform) ? "⌘\\" : "Ctrl+\\";
}

const THEME_ICON: Record<ThemeChoice, IconName> = { system: "monitor", light: "sun", dark: "moon" };

/** «ДП» for «Демо-пользователь (localhost)»: the first letters of the first two words. */
export function initials(name: string): string {
  const words = name.split(/[\s\-–—()]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase("ru") ?? "")
    .join("");
}

function modeLabel(mode: string): string {
  const label = mode === "local_demo" ? "локальное демо" : mode;
  return label.charAt(0).toLocaleUpperCase("ru") + label.slice(1);
}

interface SidebarProps {
  id: string;
  session: SessionResponse | null;
  counts: NavCounts;
  /** Icon rail (wide screens only). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Below 960 px the sidebar is a slide-over drawer. */
  drawer: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  onOpenSearch: () => void;
  searchRef: Ref<HTMLButtonElement>;
}

/**
 * The left sidebar (docs/ui-v2/specs/03_SCREENS.md §1, design-source/Sidebar.dc.html): workspace, search (the
 * ⌘K palette), the navigation in groups, the user with the theme menu. On wide screens it collapses to an icon
 * rail; below 960 px it is a modal drawer with a scrim, Esc, a focus trap and focus return (handled by Layout).
 */
export function Sidebar({
  id,
  session,
  counts,
  collapsed,
  onToggleCollapsed,
  drawer,
  drawerOpen,
  onCloseDrawer,
  onOpenSearch,
  searchRef,
}: SidebarProps) {
  const { pathname, search } = useLocation();
  const active = activeNav(pathname, search);
  const ask = canAsk(session?.features.ai_mode);
  const rail = collapsed && !drawer;
  const panelRef = useRef<HTMLDivElement>(null);
  const modal = drawer && drawerOpen;

  // The drawer takes focus when it opens (its first control: «Закрыть меню»).
  useEffect(() => {
    if (modal) panelRef.current?.querySelector<HTMLElement>(".sidebar__close")?.focus();
  }, [modal]);

  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!modal || event.key !== "Tab") return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') ?? [],
    ).filter((el) => !el.closest("[hidden]"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const countOf = (item: NavItem): number | null =>
    item.id === "documents" ? counts.documents : item.id === "proposals" ? counts.proposals : item.id === "review" ? counts.review : null;

  /**
   * What a screen reader hears after the item's name (its description); the visible number is hidden from it.
   * Worded unlike any page text, so a search for a page's own words never lands in the sidebar.
   */
  const countText = (item: NavItem, value: number): string =>
    item.id === "documents" ? `Документов: ${value}` : item.id === "review" ? `Ждут ревью: ${value}` : `Предложений: ${value}`;

  const link = (item: NavItem) => {
    const current = active === item.id;
    const value = countOf(item);
    const shown = value !== null && value > 0 && !rail ? value : null;
    const describedBy = shown !== null ? `${id}-count-${item.id}` : undefined;
    const element = (
      <Link
        to={item.to}
        className={`sidebar__link${current ? " is-active" : ""}`}
        aria-current={current ? "page" : undefined}
        aria-describedby={describedBy}
      >
        <Icon name={item.icon} />
        <span className={rail ? "visually-hidden" : "sidebar__label"}>{item.label}</span>
        {shown !== null ? (
          <>
            <span className={item.id === "review" ? "sidebar__badge" : "sidebar__count"} aria-hidden="true">
              {shown}
            </span>
            <span id={describedBy} hidden>
              {countText(item, shown)}
            </span>
          </>
        ) : null}
      </Link>
    );
    return rail ? (
      <Tooltip content={item.label} side="right" asLabel>
        {element}
      </Tooltip>
    ) : (
      element
    );
  };

  const user = session?.user;
  const theme = useTheme();
  const keys = searchKeysLabel();

  return (
    <div
      ref={panelRef}
      id={id}
      className={`sidebar${rail ? " sidebar--rail" : ""}${drawer ? " sidebar--drawer" : ""}${modal ? " is-open" : ""}`}
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? true : undefined}
      aria-label={modal ? "Меню" : undefined}
      inert={drawer && !drawerOpen ? true : undefined}
      onKeyDown={trapTab}
    >
      <div className="sidebar__head">
        <Link to="/" className="sidebar__brand" aria-label="Knowledge Hub, семантический слой — на главную">
          <span className="brand__mark" aria-hidden="true" />
          {rail ? null : (
            <span className="sidebar__workspace" aria-hidden="true">
              <span className="sidebar__product">Knowledge Hub</span>
              <span className="sidebar__team">Семантический слой</span>
            </span>
          )}
        </Link>
        {drawer ? (
          <IconButton icon="close" label="Закрыть меню" size="sm" className="sidebar__close" onClick={onCloseDrawer} />
        ) : (
          <Tooltip content={`${collapsed ? "Развернуть" : "Свернуть"} панель (${collapseKeysLabel()})`} side={collapsed ? "right" : "bottom"}>
            <IconButton
              icon="sidebar"
              label={collapsed ? "Развернуть боковую панель" : "Свернуть боковую панель"}
              size="sm"
              className="sidebar__collapse"
              aria-expanded={!collapsed}
              aria-controls={id}
              aria-keyshortcuts={"Control+\\ Meta+\\"}
              onClick={onToggleCollapsed}
            />
          </Tooltip>
        )}
      </div>

      {(() => {
        const searchButton = (
          <button
            ref={searchRef}
            type="button"
            className="sidebar__search"
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K /"
            onClick={() => {
              if (drawer) onCloseDrawer();
              onOpenSearch();
            }}
          >
            <Icon name="search" size={15} />
            <span className={rail ? "visually-hidden" : "sidebar__search-text"}>Поиск</span>
            {rail ? null : (
              <kbd className="sidebar__keys" aria-hidden="true">
                {keys}
              </kbd>
            )}
          </button>
        );
        return rail ? (
          <Tooltip content={`Поиск (${keys})`} side="right" asLabel>
            {searchButton}
          </Tooltip>
        ) : (
          searchButton
        );
      })()}

      <nav className="sidebar__nav" aria-label="Основная навигация">
        {navGroups(ask).map((group) => (
          <div key={group.id} className="sidebar__group">
            {group.label ? (
              <p className={rail ? "visually-hidden" : "sidebar__group-label"} id={`${id}-${group.id}`}>
                {group.label}
              </p>
            ) : null}
            <ul aria-labelledby={group.label ? `${id}-${group.id}` : undefined}>
              {group.items.map((item) => (
                <li key={item.id}>{link(item)}</li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="sidebar__foot">
        <Menu
          label="Пользователь и вид"
          side="top"
          align="start"
          header={
            user ? (
              <>
                <span className="menu__header-name">{user.display_name}</span>
                <span className="menu__header-meta">{modeLabel(session?.auth_mode ?? "")}</span>
              </>
            ) : undefined
          }
          trigger={(props) => (
            <button type="button" className="sidebar__user" {...props}>
              <span className="sidebar__avatar" aria-hidden="true">
                {user ? initials(user.display_name) : <Icon name="monitor" size={14} />}
              </span>
              <span className={rail ? "visually-hidden" : "sidebar__user-text"}>
                {user ? (
                  <>
                    <span className="sidebar__user-name">{user.display_name}</span>
                    <span className="sidebar__user-mode">{modeLabel(session?.auth_mode ?? "")}</span>
                  </>
                ) : (
                  <span className="sidebar__user-name">Вид</span>
                )}
              </span>
            </button>
          )}
          groups={[
            {
              label: "Тема",
              radio: true,
              items: THEME_CHOICES.map((choice) => ({
                id: choice,
                label: THEME_LABEL[choice],
                icon: THEME_ICON[choice],
                checked: theme[0] === choice,
                onSelect: () => theme[1](choice),
              })),
            },
          ]}
        />
      </div>
    </div>
  );
}
