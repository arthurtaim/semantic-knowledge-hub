import type { DocStatus } from "../../api/types";
import { STATUS_LABEL } from "../../lib/labels";
import { Icon } from "./Icon";

/**
 * A document's status as text plus shape, never colour alone (docs/ui-v2/specs/01_VISUAL_SYSTEM.md):
 * «Утверждён» — the normal state — is a quiet stamp with a tick and ordinary text; the exceptions are louder:
 * «На ревью» a filled dot, «Черновик» a dashed circle, «Устарел» a dash and struck-through text.
 * `null` is a page outside the team's knowledge (an external source).
 */
export function StatusMark({ status, className }: { status: DocStatus | null; className?: string }) {
  const kind = status ?? "external";
  const classes = ["status-mark", `status-mark--${kind}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes} data-status={status ?? undefined}>
      {kind === "approved" ? (
        <Icon name="approved" size={14} strokeWidth={2} className="status-mark__icon" />
      ) : (
        <span className="status-mark__shape" aria-hidden="true" />
      )}
      {status ? STATUS_LABEL[status] : "Внешний источник"}
    </span>
  );
}
