import type { DocumentPublicationState, PublicationJobState } from "../api/types";
import { PUBLICATION_JOB_STATE_LABEL, PUBLICATION_STATE_LABEL } from "../lib/labels";

/** Publication state of a document in Confluence: a lifecycle of its own, separate from proposals and MRs. */
export function PublicationStateLabel({ state }: { state: DocumentPublicationState }) {
  return (
    <span className={`pub-state pub-state--${state}`} data-publication-state={state}>
      {PUBLICATION_STATE_LABEL[state]}
    </span>
  );
}

/** State of one publication job. */
export function PublicationJobStateLabel({ state }: { state: PublicationJobState }) {
  return (
    <span className={`pub-state pub-state--${state}`} data-publication-state={state}>
      {PUBLICATION_JOB_STATE_LABEL[state]}
    </span>
  );
}
