import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { canAsk } from "../lib/aiMode";
import { contentWidth, defaultCrumbs } from "../lib/routes";
import { useSession } from "../lib/session";
import { readPreference, writePreference } from "../lib/storage";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ComposerPalette, isEditable } from "./ComposerPalette";
import { AiModeChip, DemoPill } from "./HeaderStatus";
import { ToolbarPath, ToolbarSlotsContext, type ToolbarSlots } from "./shell/PageToolbar";
import { Sidebar } from "./shell/Sidebar";
import { useNavCounts } from "./shell/useNavCounts";
import { IconButton } from "./ui/Button";

/** Below this width the sidebar is a slide-over drawer (docs/ui-v2/specs/03_SCREENS.md §1). */
export const DRAWER_QUERY = "(max-width: 959.98px)";
export const SIDEBAR_COLLAPSED_KEY = "skh.sidebar.collapsed";
const SIDEBAR_ID = "app-sidebar";

/** ⌘K / Ctrl+K on any keyboard layout (the key code, not the character: «л» on a Russian layout). */
function isCommandK(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === "k" || event.code === "KeyK");
}

function isCollapseShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "\\" || event.code === "Backslash");
}

/**
 * The application shell: the left sidebar (an icon rail when collapsed, a drawer below 960 px), the 52 px page
 * toolbar with the path, the page's actions, the demo badge and the AI-mode chip, and the content area.
 */
export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const session = useSession();
  const drawer = useMediaQuery(DRAWER_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readPreference(SIDEBAR_COLLAPSED_KEY) === "1");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const counts = useNavCounts(location.pathname);
  const onHome = location.pathname === "/";

  // Toolbar slots: a page's <PageToolbar> portals its path and actions here.
  const [lead, setLead] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [pageToolbars, setPageToolbars] = useState(0);
  const register = useCallback(() => {
    setPageToolbars((n) => n + 1);
    return () => setPageToolbars((n) => n - 1);
  }, []);
  const slots = useMemo<ToolbarSlots>(() => ({ lead, actions, register }), [lead, actions, register]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      writePreference(SIDEBAR_COLLAPSED_KEY, value ? null : "1");
      return !value;
    });
  }, []);

  const closeDrawer = useCallback((returnFocus = true) => {
    setDrawerOpen(false);
    if (returnFocus) menuButton.current?.focus();
  }, []);

  // Any navigation (even to the same page) closes the drawer; so does growing past 960 px.
  useEffect(() => setDrawerOpen(false), [location.key]);
  useEffect(() => {
    if (!drawer) setDrawerOpen(false);
  }, [drawer]);

  // ⌘K / Ctrl+K anywhere, «/» outside text fields: the home page focuses its own field, other pages open the
  // palette. ⌘\ / Ctrl+\ collapses the sidebar to icons (wide screens).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCollapseShortcut(event)) {
        if (drawer) return;
        event.preventDefault();
        toggleCollapsed();
        return;
      }
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditable(event.target);
      if (!isCommandK(event) && !slash) return;
      event.preventDefault();
      const hero = onHome ? document.getElementById("home-composer-input") : null;
      if (hero) hero.focus();
      else setPaletteOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onHome, drawer, toggleCollapsed]);

  // Esc closes the open drawer and returns focus to «Меню».
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      closeDrawer();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, closeDrawer]);

  const width = contentWidth(location.pathname);
  const shellClass = ["shell", drawer ? "shell--drawer" : collapsed ? "shell--rail" : ""].filter(Boolean).join(" ");

  return (
    <ToolbarSlotsContext.Provider value={slots}>
      <div className={shellClass}>
        <a className="skip-link" href="#main">
          Перейти к содержимому
        </a>
        <Sidebar
          id={SIDEBAR_ID}
          session={session}
          counts={counts}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          drawer={drawer}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => closeDrawer()}
          onOpenSearch={() => setPaletteOpen(true)}
          searchRef={searchButton}
        />
        {drawer && drawerOpen ? <div className="scrim" aria-hidden="true" onClick={() => closeDrawer()} /> : null}
        <div className="workspace">
          <header className="page-toolbar">
            {drawer ? (
              <IconButton
                ref={menuButton}
                icon="menu"
                label="Меню"
                className="page-toolbar__menu"
                aria-expanded={drawerOpen}
                aria-controls={SIDEBAR_ID}
                onClick={() => setDrawerOpen(true)}
              />
            ) : null}
            <div className="page-toolbar__lead">
              {pageToolbars > 0 ? null : <ToolbarPath crumbs={defaultCrumbs(location.pathname, canAsk(session?.features.ai_mode))} />}
              <div className="page-toolbar__slot" ref={setLead} />
            </div>
            <div className="page-toolbar__end">
              <div className="page-toolbar__status">
                <DemoPill />
                <AiModeChip />
              </div>
              <div className="page-toolbar__actions" ref={setActions} />
            </div>
          </header>
          <main id="main" className={`content content--${width}`} tabIndex={-1}>
            <div className="content__inner">{children}</div>
          </main>
        </div>
        {paletteOpen ? <ComposerPalette onClose={() => setPaletteOpen(false)} /> : null}
      </div>
    </ToolbarSlotsContext.Provider>
  );
}
