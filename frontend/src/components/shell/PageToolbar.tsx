import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { Crumb } from "../../lib/routes";
import { useMediaQuery } from "../../lib/useMediaQuery";

/*
 * The 52 px page toolbar (docs/ui-v2/specs/03_SCREENS.md §1): the path or title on the left, the page's actions
 * on the right (at most one primary), then the demo badge and the AI-mode chip, which the shell adds itself.
 *
 * The shell (Layout) owns the bar and shows a default path for every route (lib/routes.ts). A page refines it
 * by rendering <PageToolbar crumbs={…} actions={…} /> anywhere in its tree: the content is portalled into the
 * bar. Rendered without the shell (a page in a unit test), the same content appears inline, so the page keeps
 * its path and actions.
 */

export interface ToolbarSlots {
  lead: HTMLElement | null;
  actions: HTMLElement | null;
  /** A page's toolbar is mounted: the default path steps aside. Returns the unregister function. */
  register: () => () => void;
}

export const ToolbarSlotsContext = createContext<ToolbarSlots | undefined>(undefined);

/** The path as a breadcrumb navigation; a single crumb is a plain title. */
export function ToolbarPath({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 1) {
    return <span className="page-toolbar__title">{crumbs[0]?.label}</span>;
  }
  return (
    <nav className="crumbs" aria-label="Путь">
      <ol>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${index}-${crumb.label}`}>
              {crumb.to && !last ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface PageToolbarProps {
  /** The path, root first; the last crumb is the current page. */
  crumbs?: Crumb[];
  /** A plain title instead of a path. */
  title?: string;
  /** Buttons for the right side; at most one primary. */
  actions?: ReactNode;
  /** Shown right after the title or path: a count, a view switch (the catalog: «Документы 83 · Список / Таблица»). */
  meta?: ReactNode;
  /** Shown before the title or path: a «Назад» of a page that shows one screen at a time on a phone. */
  lead?: ReactNode;
  /** Several wide actions: on a phone they go to the top of the content instead of overflowing the 52 px bar. */
  actionsInContentOnPhone?: boolean;
}

/** Phones (docs/ui-v2/specs/03_SCREENS.md §6). */
const PHONE_QUERY = "(max-width: 599.98px)";

export function PageToolbar({ crumbs, title, actions, meta, lead, actionsInContentOnPhone = false }: PageToolbarProps) {
  const slots = useContext(ToolbarSlotsContext);
  const register = slots?.register;
  const phone = useMediaQuery(PHONE_QUERY);
  const actionsInContent = actionsInContentOnPhone && phone;
  const named = crumbs ? <ToolbarPath crumbs={crumbs} /> : title ? <ToolbarPath crumbs={[{ label: title }]} /> : null;
  const path =
    named && (meta || lead) ? (
      <>
        {lead ? <div className="page-toolbar__before">{lead}</div> : null}
        {named}
        {meta ? <div className="page-toolbar__meta">{meta}</div> : null}
      </>
    ) : (
      named
    );
  const hasPath = path !== null;
  // Only a page that names itself replaces the default path (actions alone leave it).
  useLayoutEffect(() => (hasPath ? register?.() : undefined), [register, hasPath]);

  if (!slots) {
    return (
      <div className="page-toolbar page-toolbar--inline">
        <div className="page-toolbar__lead">{path}</div>
        {actions ? <div className="page-toolbar__actions">{actions}</div> : null}
      </div>
    );
  }
  return (
    <>
      {path && slots.lead ? createPortal(path, slots.lead) : null}
      {actions && actionsInContent ? <div className="page-actions">{actions}</div> : null}
      {actions && slots.actions && !actionsInContent ? createPortal(actions, slots.actions) : null}
    </>
  );
}
