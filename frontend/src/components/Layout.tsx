import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSession } from "../lib/session";

const NAV = [
  { to: "/", label: "Главная", end: true },
  { to: "/documents", label: "База знаний", end: false },
  { to: "/ask", label: "Спросить", end: false },
  { to: "/proposals", label: "Предложения", end: false },
  { to: "/integrations", label: "Интеграции", end: false },
];

function demoFacts(session: ReturnType<typeof useSession>): string[] {
  if (!session) return ["Документы синтетические и не описывают банк."];
  const facts: string[] = [];
  if (session.demo_content) facts.push("Документы синтетические и не описывают банк.");
  if (session.knowledge_backend === "local") facts.push("GitLab не подключён.");
  if (session.features.corporate_search === "disabled") facts.push("Confluence не подключён.");
  if (session.features.corporate_search === "mock") facts.push("Confluence заменён mock-коннектором.");
  if (session.features.ai_mode === "mock") facts.push("Ассистент отвечает дословными выдержками, без языковой модели.");
  return facts;
}

function DemoBand() {
  const facts = demoFacts(useSession());
  if (facts.length === 0) return null;
  return (
    <div className="demo-band" role="note">
      <strong>Демо-данные.</strong> <span>{facts.join(" ")}</span>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const session = useSession();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <header className="sidebar">
        {/* The header stretches to the full page height (dark column); its content stays in view while scrolling. */}
        <div className="sidebar__inner">
          <div className="sidebar__top">
            <NavLink to="/" className="brand" aria-label="Semantic Knowledge Hub — на главную">
              <span className="brand__mark" aria-hidden="true" />
              <span className="brand__text">
                <span className="brand__name">Semantic Knowledge Hub</span>
                <span className="brand__team">команда семантического слоя</span>
              </span>
            </NavLink>
            <button
              type="button"
              className="menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="primary-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? "Закрыть" : "Меню"}
            </button>
          </div>
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
              <p className="nav__identity">
                {session.user.display_name}
                <br />
                Режим: {session.auth_mode === "local_demo" ? "локальное демо" : session.auth_mode}
              </p>
            ) : null}
          </nav>
        </div>
      </header>
      <div className="workspace">
        <DemoBand />
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
