import type { IconName } from "../components/ui/Icon";

/*
 * The shell's map of the routes in App.tsx (docs/ui-v2/specs/03_SCREENS.md §1): sidebar items, which item a
 * route belongs to, the default path shown in the page toolbar, the browser tab title and the content width.
 * Routes themselves do not change here.
 */

export type NavId = "assistant" | "review" | "documents" | "map" | "templates" | "proposals" | "publications" | "integrations";

export interface NavItem {
  id: NavId;
  label: string;
  icon: IconName;
  to: string;
}

export interface NavGroup {
  id: string;
  /** No label for the first group (Ассистент, Ревью). */
  label: string | null;
  items: NavItem[];
}

/** The proposals list filtered to what waits for review: there is no reviewer assignment («на мне») in the API. */
export const REVIEW_HREF = "/proposals?status=ready_for_review";

/**
 * There is no list of publications: a publication is a step of a document (its page) and a job page
 * (/publications/:jobId). The one global place where publishing is visible is the Confluence publisher on the
 * integrations page (its mode and whether it is connected).
 */
export const PUBLICATIONS_HREF = "/integrations#integration-confluence_publisher";

export function navGroups(askAvailable: boolean): NavGroup[] {
  return [
    {
      id: "main",
      label: null,
      items: [
        // Without an AI provider the start page is a search page, not an assistant.
        askAvailable
          ? { id: "assistant", label: "Ассистент", icon: "assistant", to: "/" }
          : { id: "assistant", label: "Главная", icon: "home", to: "/" },
        { id: "review", label: "Ревью", icon: "review", to: REVIEW_HREF },
      ],
    },
    {
      id: "knowledge",
      label: "Знания",
      items: [
        { id: "documents", label: "Документы", icon: "documents", to: "/documents" },
        { id: "map", label: "Карта знаний", icon: "map", to: "/graph" },
        { id: "templates", label: "Шаблоны", icon: "templates", to: "/templates" },
      ],
    },
    {
      id: "work",
      label: "Работа",
      items: [
        { id: "proposals", label: "Предложения", icon: "proposals", to: "/proposals" },
        { id: "publications", label: "Публикации", icon: "publications", to: PUBLICATIONS_HREF },
      ],
    },
    {
      id: "system",
      label: "Система",
      items: [{ id: "integrations", label: "Интеграции", icon: "integrations", to: "/integrations" }],
    },
  ];
}

/** Which sidebar item the current location belongs to (null: a page outside the navigation, e.g. 404). */
export function activeNav(pathname: string, search: string): NavId | null {
  if (pathname === "/" || pathname === "/ask" || pathname.startsWith("/ask/")) return "assistant";
  if (pathname === "/proposals" && new URLSearchParams(search).get("status") === "ready_for_review") return "review";
  if (pathname.startsWith("/proposals")) return "proposals";
  if (pathname.startsWith("/documents")) return "documents";
  if (pathname.startsWith("/graph")) return "map";
  if (pathname.startsWith("/templates")) return "templates";
  if (pathname.startsWith("/publications/")) return "publications";
  if (pathname.startsWith("/integrations")) return "integrations";
  return null;
}

export interface Crumb {
  label: string;
  /** A link back up the path; the last crumb (the current page) has none. */
  to?: string;
}

const DOCS: Crumb = { label: "Документы", to: "/documents" };

/**
 * The path the page toolbar shows until (or unless) the page sets a more specific one with <PageToolbar>.
 * One crumb is a plain title.
 */
export function defaultCrumbs(pathname: string, askAvailable: boolean): Crumb[] {
  if (pathname === "/") return [{ label: askAvailable ? "Ассистент" : "Главная" }];
  if (pathname === "/ask") return [{ label: "Ассистент" }];
  if (pathname === "/documents") return [{ label: "Документы" }];
  if (pathname === "/documents/new") return [DOCS, { label: "Новый документ" }];
  if (pathname === "/documents/import") return [DOCS, { label: "Новый документ", to: "/documents/new" }, { label: "Импорт Markdown" }];
  if (pathname.startsWith("/documents/")) return [DOCS, { label: "Документ" }];
  if (pathname === "/graph") return [{ label: "Карта знаний" }];
  if (pathname === "/templates") return [{ label: "Шаблоны" }];
  if (pathname.startsWith("/templates/")) return [{ label: "Шаблоны", to: "/templates" }, { label: "Шаблон" }];
  if (pathname === "/proposals") return [{ label: "Предложения" }];
  if (pathname === "/proposals/new") return [{ label: "Предложения", to: "/proposals" }, { label: "Новое предложение" }];
  if (pathname.startsWith("/proposals/")) return [{ label: "Предложения", to: "/proposals" }, { label: "Предложение" }];
  if (pathname.startsWith("/publications/")) return [{ label: "Публикации", to: PUBLICATIONS_HREF }, { label: "Публикация" }];
  if (pathname === "/integrations") return [{ label: "Интеграции" }];
  if (pathname.startsWith("/corporate/")) return [{ label: "Корпоративная страница" }];
  return [{ label: "Страница не найдена" }];
}

/** The browser tab title: the page's own name, then the product. */
export function documentTitle(pathname: string, askAvailable: boolean): string {
  const crumbs = defaultCrumbs(pathname, askAvailable);
  return `${crumbs[crumbs.length - 1]?.label ?? "Semantic Knowledge Hub"} — база знаний семантического слоя`;
}

/**
 * How wide the page content is: tables and the map use the full width of the work area, the dialog a text
 * column (≤ 780 px), everything else a centred column up to 80 rem.
 */
export function contentWidth(pathname: string): "wide" | "text" | "default" {
  if (pathname === "/graph" || pathname === "/documents" || pathname === "/proposals") return "wide";
  if (pathname === "/ask") return "text";
  return "default";
}
