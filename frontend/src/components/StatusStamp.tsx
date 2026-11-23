import type { DocStatus } from "../api/types";
import { STATUS_LABEL } from "../lib/labels";

interface Props {
  status: DocStatus | null;
  large?: boolean;
}

/** Approval status as a stamp: the one bold, recurring element of the interface. */
export function StatusStamp({ status, large = false }: Props) {
  if (status === null) {
    return <span className={`stamp stamp--external${large ? " stamp--large" : ""}`}>Внешний источник</span>;
  }
  return (
    <span className={`stamp stamp--${status}${large ? " stamp--large" : ""}`} data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}
