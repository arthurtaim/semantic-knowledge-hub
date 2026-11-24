import type { IntegrationState } from "../api/types";
import { INTEGRATION_STATE_LABEL } from "../lib/labels";

/**
 * State of an integration. `mock` of the AI provider is a MODE — no language model — not demo content, so it is named
 * «Без модели (mock)»; a mock connector of a system (Confluence, GitLab) keeps «Демо (mock)»: synthetic pages.
 */
export function StateBadge({ state, kind }: { state: IntegrationState; kind?: string }) {
  return (
    <span className={`state state--${state}`}>
      <span className="state__dot" aria-hidden="true" />
      {kind === "ai" && state === "mock" ? "Без модели (mock)" : INTEGRATION_STATE_LABEL[state]}
    </span>
  );
}
