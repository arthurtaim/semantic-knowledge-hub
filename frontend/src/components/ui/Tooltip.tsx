import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from "react";

interface TooltipProps {
  content: string;
  /** One focusable element (a button or a link). */
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: "top" | "bottom" | "right";
  /**
   * The tooltip repeats the control's own name (an icon rail): it is shown but not announced twice. Otherwise it
   * describes the control (`aria-describedby`).
   */
  asLabel?: boolean;
  /** Hover delay; focus shows it at once. */
  delayMs?: number;
}

/**
 * A short hint for a control (WAI-ARIA APG «Tooltip»; WCAG 1.4.13): appears on hover and on keyboard focus,
 * stays while the pointer is over it, Esc dismisses it without moving focus.
 */
export function Tooltip({ content, children, side = "top", asLabel = false, delayMs = 350 }: TooltipProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    if (delay <= 0) setVisible(true);
    else timer.current = window.setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setVisible(false);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  const trigger = asLabel ? children : cloneElement(children, { "aria-describedby": id });
  return (
    <span
      className="tooltip-anchor"
      onMouseEnter={() => show(delayMs)}
      onMouseLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
    >
      {trigger}
      <span id={id} role="tooltip" className={`tooltip tooltip--${side}`} hidden={!visible} aria-hidden={asLabel || undefined}>
        {content}
      </span>
    </span>
  );
}
