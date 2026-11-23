import type { IntegrationState } from "../api/types";
import { INTEGRATION_STATE_LABEL } from "../lib/labels";

export function StateBadge({ state }: { state: IntegrationState }) {
  return (
    <span className={`state state--${state}`}>
      <span className="state__dot" aria-hidden="true" />
      {INTEGRATION_STATE_LABEL[state]}
    </span>
  );
}
