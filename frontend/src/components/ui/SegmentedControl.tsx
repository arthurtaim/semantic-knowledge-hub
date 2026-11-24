import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  /** The group's name (a legend; visually hidden unless `showLabel`). */
  label: string;
  showLabel?: boolean;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "sm";
  className?: string;
}

/**
 * One choice out of a few: native radio buttons in a fieldset, so arrow keys move the choice and screen readers
 * announce «1 из 3». The selected segment is a raised white surface on a grey track — never a green fill.
 */
export function SegmentedControl<T extends string>({
  label,
  showLabel = false,
  options,
  value,
  onChange,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className={["segmented-control", size === "sm" ? "segmented-control--sm" : "", className ?? ""].filter(Boolean).join(" ")}>
      <legend className={showLabel ? "segmented-control__legend" : "visually-hidden"}>{label}</legend>
      <div className="segmented-control__track">
        {options.map((option) => (
          <label key={option.value} className="segmented-control__option">
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
      </div>
    </fieldset>
  );
}
