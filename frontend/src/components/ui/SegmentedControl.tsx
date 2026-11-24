import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  /** Why a disabled option cannot be chosen (shown on hover). */
  hint?: string;
}

interface SegmentedControlProps<T extends string> {
  /** The group's name (a legend; visually hidden unless `showLabel`). */
  label: string;
  showLabel?: boolean;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The id of a text that explains the choice (`aria-describedby` of the group). */
  describedBy?: string;
  className?: string;
}

/**
 * One choice out of a few: native radio buttons in a fieldset, so arrow keys move the choice and screen readers
 * announce «1 из 3». The selected segment is a raised surface on a grey track (`.segmented`, --bg-raised) — never
 * a green fill. The map's modes and depth and the create page's «Как создать» use it.
 */
export function SegmentedControl<T extends string>({
  label,
  showLabel = false,
  options,
  value,
  onChange,
  describedBy,
  className,
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className={["segmented", className ?? ""].filter(Boolean).join(" ")} aria-describedby={describedBy}>
      <legend className={showLabel ? undefined : "visually-hidden"}>{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="segmented__option" title={option.disabled ? option.hint : undefined}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span>
            {option.icon ? <Icon name={option.icon} size={14} /> : null}
            {option.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
