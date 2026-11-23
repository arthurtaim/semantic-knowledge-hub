import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSession } from "../lib/session";
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

  useEffect(() => setMenuOpen(false), [location.pathname]);

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
              {NAV.map((item) => (
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
      {/* The tool row under the bar: the AI mode and the demo status (replaces the full-width demo band). */}
      <div className="toolbar">
        <div className="toolbar__inner">
          <div className="toolbar__status">
            <AiModeChip />
            <DemoPill />
          </div>
        </div>
      </div>
      <main id="main" className="content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
