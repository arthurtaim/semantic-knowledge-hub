import type { DocStatus } from "../api/types";
import { StatusMark } from "./ui/StatusMark";

interface Props {
  status: DocStatus | null;
  /** A slightly larger mark (the document's own status). */
  large?: boolean;
}

/** A document's approval status: the visual system's StatusMark (text + shape), kept under its old name. */
export function StatusStamp({ status, large = false }: Props) {
  return <StatusMark status={status} className={large ? "stamp status-mark--large" : "stamp"} />;
}
