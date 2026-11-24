import type { ReactElement } from "react";

/*
 * Line icons of the visual system (docs/ui-v2/specs/01_VISUAL_SYSTEM.md, «Icon»): 24-unit paths taken from
 * the UI v2 mockups (docs/ui-v2/screens/design), drawn at 16 px with a 1.75 stroke in `currentColor`. A few shell icons
 * (menu, sidebar, home, theme) are drawn in the same style. Decorative by default (`aria-hidden`): the control
 * that holds an icon carries the accessible name.
 */

const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      <path d="m20.5 20.5-4-4" />
    </>
  ),
  assistant: <path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12Z" />,
  review: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M5.5 5h13L21 13v6H3v-6Z" />
    </>
  ),
  documents: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2Z" />
      <path d="M4 20a2 2 0 0 0 2 1h12v-3" />
    </>
  ),
  map: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="m8.3 10.9 7.4-3.7M8.3 13.1l7.4 3.7" />
    </>
  ),
  templates: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M3.5 9.5h17M9.5 20.5v-11" />
    </>
  ),
  proposals: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-4" />
      <path d="m13 4.5-2.5 2.5 2.5 2.5" />
    </>
  ),
  publications: (
    <>
      <path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" />
      <path d="M4.5 14v4.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14" />
    </>
  ),
  integrations: (
    <>
      <path d="M9 2.5v5M15 2.5v5M6 7.5h12v4a6 6 0 0 1-12 0Z" />
      <path d="M12 17.5v4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6.5A2 2 0 0 0 4.5 5v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5Z" />
      <path d="M14 3v5.5h5.5" />
    </>
  ),
  "file-text": (
    <>
      <path d="M14 3H6.5A2 2 0 0 0 4.5 5v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5Z" />
      <path d="M14 3v5.5h5.5M8 13h8M8 17h5" />
    </>
  ),
  paperclip: (
    <path d="m20.5 11.5-8.3 8.3a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 4.9 4.9L9.7 17.3a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
  ),
  skill: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4.5" />
      <path d="m14.5 7.5-5 9" />
    </>
  ),
  at: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M15.8 8v5.2a2.7 2.7 0 0 0 5.4 0V12a9.2 9.2 0 1 0-3.6 7.3" />
    </>
  ),
  send: <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </g>
  ),
  approved: (
    <>
      <path d="M12 2.8l2.3 1.7 2.9-.1.9 2.7 2.3 1.7-.8 2.8.8 2.8-2.3 1.7-.9 2.7-2.9-.1L12 21.2l-2.3-1.7-2.9.1-.9-2.7-2.3-1.7.8-2.8-.8-2.8 2.3-1.7.9-2.7 2.9.1Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 16v-4.5M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4.5M12 16h.01" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 20h14" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16Z" />,
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4v5h5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  /** A sorted column's direction (rotated for descending). */
  "sort-up": <path d="M12 19V5M6 11l6-6 6 6" />,
  // «Документы» v2 (docs/ui-v2/documents/screens/design): the tree filter and «Свернуть всё».
  filter: <path d="M3 5h18M6 12h12M10 19h4" />,
  collapse: (
    <>
      <path d="m7 15 5-5 5 5" />
      <path d="m7 20 5-5 5 5" opacity=".45" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20H4Z" />
      <path d="M9.5 20v-5.5h5V20" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

interface IconProps {
  name: IconName;
  /** Rendered size in px (16 by default; 13–15 inside compact controls). */
  size?: number;
  /** Stroke width in 24-unit space (1.7–1.8 per the spec; the approved stamp reads better at 2). */
  strokeWidth?: number;
  className?: string;
  /** Only for a standalone meaningful icon: gives it `role="img"` and this name instead of hiding it. */
  label?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.75, className, label }: IconProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const, focusable: "false" as const };
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      {...a11y}
    >
      {PATHS[name]}
    </svg>
  );
}
