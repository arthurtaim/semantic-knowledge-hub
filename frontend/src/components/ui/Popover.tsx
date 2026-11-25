import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useDisclosure } from "../../lib/useDisclosure";
import { Icon, type IconName } from "./Icon";

export type PopoverSide = "bottom" | "top";
export type PopoverAlign = "start" | "end";

function placementClass(base: string, side: PopoverSide, align: PopoverAlign, extra?: string): string {
  return [base, `${base}--${side}`, `${base}--${align}`, extra ?? ""].filter(Boolean).join(" ");
}

export interface PopoverTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
}

interface PopoverProps {
  /** The panel's id (the trigger's `aria-controls`). */
  id: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Content; a function gets the open state (to render details only while open) and `close`. */
  children: ReactNode | ((state: { open: boolean; close: () => void }) => ReactNode);
  side?: PopoverSide;
  align?: PopoverAlign;
  /** A landmark-ish role for the wrapper (the demo tag is the page's one `note`). */
  role?: string;
  className?: string;
  panelClassName?: string;
}

/**
 * A button-controlled, non-modal floating panel (APG disclosure): the trigger reports `aria-expanded`; Esc
 * closes it and returns focus to the trigger; a press outside or navigation closes it; Tab leaves as usual.
 * The panel stays in the DOM while closed (`hidden`).
 */
export function Popover({ id, trigger, children, side = "bottom", align = "end", role, className, panelClassName }: PopoverProps) {
  const { open, setOpen, toggle, root, button } = useDisclosure();
  const close = () => setOpen(false);
  return (
    <div className={["popover-anchor", className ?? ""].filter(Boolean).join(" ")} role={role} ref={root}>
      {trigger({ ref: button, "aria-expanded": open, "aria-controls": id, onClick: toggle })}
      <div id={id} className={placementClass("popover", side, align, panelClassName)} hidden={!open}>
        {typeof children === "function" ? children({ open, close }) : children}
      </div>
    </div>
  );
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** A second line under the label. */
  description?: string;
  /** A short note at the end of the item (a count). */
  meta?: string;
  onSelect: () => void;
  /** For a radio group: the current choice (`menuitemradio` + `aria-checked`). */
  checked?: boolean;
  disabled?: boolean;
}

export interface MenuGroup {
  /** Names the group (`role="group"`); shown as a small caption. */
  label?: string;
  /** The items are mutually exclusive choices (theme and the like). */
  radio?: boolean;
  /**
   * The items are independent on/off choices (`menuitemcheckbox` + `aria-checked`): choosing one toggles it and the
   * menu stays open, so several can be chosen in a row (filters, columns).
   */
  multi?: boolean;
  items: MenuItem[];
}

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  id: string;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

interface MenuProps {
  /** The menu's accessible name. */
  label: string;
  trigger: (props: MenuTriggerProps) => ReactNode;
  groups: MenuGroup[];
  /** Non-interactive content above the items (who is signed in and the like). */
  header?: ReactNode;
  /** Non-interactive content below the items (the keys of a view). */
  footer?: ReactNode;
  /** A class for the floating panel (its width). */
  panelClassName?: string;
  side?: PopoverSide;
  align?: PopoverAlign;
  className?: string;
}

/**
 * A menu button (WAI-ARIA APG «Menu Button»): Enter, Space or ↓ opens the menu on its first item, ↑ on the last;
 * ↑/↓ move (wrapping), Home/End jump, a letter moves to the next item starting with it; Enter or Space
 * chooses and closes (an item of a `multi` group toggles and keeps the menu open); Esc closes and returns focus to
 * the button; Tab or a press outside closes it.
 */
export function Menu({ label, trigger, groups, header, footer, panelClassName, side = "bottom", align = "start", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<"first" | "last">("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const buttonId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);

  useEffect(() => {
    if (!open) return;
    const list = items();
    (initial === "last" ? list[list.length - 1] : list[0])?.focus();
  }, [open, initial]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function openAt(where: "first" | "last") {
    setInitial(where);
    setOpen(true);
  }

  function closeAndReturn() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openAt(event.key === "ArrowUp" ? "last" : "first");
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusAt(0);
        return;
      case "End":
        event.preventDefault();
        focusAt(list.length - 1);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeAndReturn();
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const key = event.key.toLocaleLowerCase("ru");
          for (let step = 1; step <= list.length; step += 1) {
            const candidate = list[(index + step) % list.length];
            if (candidate?.textContent?.trim().toLocaleLowerCase("ru").startsWith(key)) {
              candidate.focus();
              break;
            }
          }
        }
    }
  }

  function choose(item: MenuItem, keepOpen: boolean) {
    if (item.disabled) return;
    item.onSelect();
    if (!keepOpen) closeAndReturn();
  }

  return (
    <div className={["popover-anchor", className ?? ""].filter(Boolean).join(" ")} ref={rootRef}>
      {trigger({
        ref: triggerRef,
        id: buttonId,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        onClick: () => (open ? setOpen(false) : openAt("first")),
        onKeyDown: onTriggerKeyDown,
      })}
      <div className={placementClass("popover", side, align, ["menu-popup", panelClassName ?? ""].filter(Boolean).join(" "))} hidden={!open}>
        {header ? <div className="menu__header">{header}</div> : null}
        <div id={menuId} role="menu" aria-label={label} className="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {groups.map((group, groupIndex) => {
            const checkable = Boolean(group.radio || group.multi);
            const body = group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                role={group.radio ? "menuitemradio" : group.multi ? "menuitemcheckbox" : "menuitem"}
                aria-checked={checkable ? Boolean(item.checked) : undefined}
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                className="menu__item"
                onClick={() => choose(item, Boolean(group.multi))}
              >
                {item.icon ? <Icon name={item.icon} /> : null}
                <span className="menu__text">
                  <span className="menu__label">{item.label}</span>
                  {item.description ? <span className="menu__description">{item.description}</span> : null}
                </span>
                {item.meta ? <span className="menu__meta">{item.meta}</span> : null}
                {checkable ? <Icon name="check" className="menu__check" /> : null}
              </button>
            ));
            return (
              <Fragment key={group.label ?? groupIndex}>
                {groupIndex > 0 ? <div role="separator" className="menu__separator" /> : null}
                <div role="group" aria-label={group.label} className="menu__group">
                  {group.label ? (
                    <div className="menu__group-label" aria-hidden="true">
                      {group.label}
                    </div>
                  ) : null}
                  {body}
                </div>
              </Fragment>
            );
          })}
        </div>
        {footer ? <div className="menu__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
