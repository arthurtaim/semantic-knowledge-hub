import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Buttons of the visual system. `primary` is the one green action of a view; `secondary` a white button with a
 * frame; `quiet` has no frame; `danger` is a secondary button in the error tone. Links that look like buttons
 * use `buttonClass()` so the look stays one.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "md" | "sm";

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return ["button", `button--${variant}`, size === "sm" ? "button--sm" : "", extra ?? ""].filter(Boolean).join(" ");
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A leading icon (decorative: the text is the name). */
  icon?: IconName;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", size = "md", icon, className, type = "button", children, ref, ...rest }: ButtonProps) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  icon: IconName;
  /** Required: an icon alone has no name. */
  label: string;
  size?: ButtonSize;
  /** `quiet` (default) for toolbars, `secondary` for a framed square. */
  variant?: "quiet" | "secondary";
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

/** A square icon-only button; its accessible name is `label`. */
export function IconButton({ icon, label, size = "md", variant = "quiet", className, type = "button", ref, children, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={buttonClass(variant, size, `button--icon${className ? ` ${className}` : ""}`)}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 15 : 16} />
      {children}
    </button>
  );
}
