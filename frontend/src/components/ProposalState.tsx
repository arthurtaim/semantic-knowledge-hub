import type { MergeRequestState, ProposalOperation, ProposalStatus } from "../api/types";
import { MR_STATE_LABEL, OPERATION_LABEL, PROPOSAL_STATUS_LABEL } from "../lib/labels";

/** Local proposal status. Never confused with document approval (StatusStamp) or the GitLab MR state. */
export function ProposalStateLabel({ status }: { status: ProposalStatus }) {
  return (
    <span className={`proposal-state proposal-state--${status}`} data-status={status}>
      {PROPOSAL_STATUS_LABEL[status]}
    </span>
  );
}

/** State of the GitLab Merge Request exactly as GitLab last reported it. */
export function MergeRequestStateLabel({ state }: { state: MergeRequestState }) {
  return (
    <span className={`mr-state mr-state--${state}`} data-mr-state={state}>
      {MR_STATE_LABEL[state]}
    </span>
  );
}

/** What the proposal does: adds a new file (`create`) or changes an existing document (`update`). */
export function OperationBadge({ operation }: { operation: ProposalOperation }) {
  return (
    <span className={`op-badge op-badge--${operation}`} data-operation={operation}>
      {OPERATION_LABEL[operation]}
    </span>
  );
}
