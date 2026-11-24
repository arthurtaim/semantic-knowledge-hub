import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSession } from "../lib/session";
import { ComposerPalette, ComposerTrigger, isEditable } from "./ComposerPalette";
import { AiModeChip, DemoPill } from "./HeaderStatus";

const NAV = [
  { to: "/", label: "Главная", end: true },
  { to: "/documents", label: "База знаний", end: false },
  { to: "/graph", label: "Граф", end: false },
  { to: "/templates", label: "Шаблоны", end: false },
  { to: "/ask", label: "Спросить", end: false },
  { to: "/proposals", label: "Предложения", end: false },
  { to: "/integrations", label: "Интеграции", end: false },
];

function modeLabel(mode: string): string {
  return mode === "local_demo" ? "локальное демо" : mode;
}

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const session = useSession();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const onHome = location.pathname === "/";

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // ⌘K / Ctrl+K anywhere, «/» outside text fields: the home page focuses its own field, other pages open
  // the palette.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandK = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditable(event.target);
      if (!commandK && !slash) return;
      event.preventDefault();
      const hero = onHome ? document.getElementById("home-composer-input") : null;
      if (hero) hero.focus();
      else setPaletteOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onHome]);

  // Esc closes the open mobile menu and returns focus to «Меню» (focus is not lost inside a hidden list).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuToggle.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <NavLink to="/" className="brand" aria-label="Semantic Knowledge Hub — на главную">
            <span className="brand__mark" aria-hidden="true" />
            <span className="brand__text">
              <span className="brand__name">Semantic Knowledge Hub</span>
              <span className="brand__team">команда семантического слоя</span>
            </span>
          </NavLink>
          <button
            ref={menuToggle}
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Закрыть" : "Меню"}
          </button>
          <nav id="primary-nav" className={`nav${menuOpen ? " nav--open" : ""}`} aria-label="Основная навигация">
            <ul>
              {NAV.filter((item) => item.to !== "/ask" || session?.features.ai_mode !== "disabled").map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="nav__link">
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
            {session ? (
              <p className="nav__identity" title={`Режим: ${modeLabel(session.auth_mode)}`}>
                <span className="nav__user">{session.user.display_name}</span>
                <span className="nav__mode">{modeLabel(session.auth_mode)}</span>
              </p>
            ) : null}
          </nav>
        </div>
      </header>
      {/* The tool row under the bar: «Спросить или найти», the AI mode and the demo status (it replaces the
          full-width demo band). */}
      <div className="toolbar">
        <div className="toolbar__inner">
          {/* The home page's hero is the same field, so the trigger is not repeated there. */}
          {onHome ? null : <ComposerTrigger buttonRef={trigger} onOpen={() => setPaletteOpen(true)} />}
          <div className="toolbar__status">
            <AiModeChip />
            <DemoPill />
          </div>
        </div>
      </div>
      <main id="main" className="content" tabIndex={-1}>
        {children}
      </main>
      {paletteOpen ? <ComposerPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}
