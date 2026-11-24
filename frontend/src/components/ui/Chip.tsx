import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * A compact token: an active filter, an attachment, a skill (the green tone: one per message) or a document
 * in context. Optionally a toggle (`onClick` + `selected`) and/or removable — the remove button always has its
 * own name («Убрать фильтр: Статус» and the like).
 */
export type ChipTone = "neutral" | "filter" | "skill" | "file" | "document" | "danger";

type RemoveProps = { onRemove: () => void; removeLabel: string } | { onRemove?: undefined; removeLabel?: undefined };

type ChipProps = RemoveProps & {
  children: ReactNode;
  tone?: ChipTone;
  icon?: IconName;
  /** Secondary text after the label (a file size, a document ID). */
  meta?: ReactNode;
  /** Makes the chip a toggle button. */
  onClick?: () => void;
  selected?: boolean;
  title?: string;
  className?: string;
};

export function Chip({ children, tone = "neutral", icon, meta, onClick, selected, onRemove, removeLabel, title, className }: ChipProps) {
  const classes = ["chip", `chip--${tone}`, selected ? "is-selected" : "", onRemove ? "chip--removable" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className="chip__label">{children}</span>
      {meta ? <span className="chip__meta">{meta}</span> : null}
    </>
  );
  return (
    <span className={classes} title={title}>
      {onClick ? (
        <button type="button" className="chip__body" aria-pressed={selected === undefined ? undefined : selected} onClick={onClick}>
          {body}
        </button>
      ) : (
        <span className="chip__body">{body}</span>
      )}
      {onRemove ? (
        <button type="button" className="chip__remove" aria-label={removeLabel} onClick={onRemove}>
          <Icon name="close" size={12} strokeWidth={2} />
        </button>
      ) : null}
    </span>
  );
}
