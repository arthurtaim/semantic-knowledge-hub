import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AiMode, AssistantSkill } from "../api/types";
import { canAsk } from "./aiMode";

/** The skill registry (GET /api/assistant/skills): never hard-coded; null while loading or unavailable. */
export interface SkillsState {
  items: AssistantSkill[] | null;
  /** The registry could not be read: the composer says so instead of showing an empty list. */
  failed: boolean;
}

/** Loads the registry once per mount while the assistant can be asked (not with `AI_PROVIDER=disabled`). */
export function useSkills(mode: AiMode | null | undefined, enabled = true): SkillsState {
  const active = enabled && canAsk(mode);
  const [state, setState] = useState<SkillsState>({ items: null, failed: false });

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    api
      .assistantSkills()
      .then((items) => {
        if (live) setState({ items, failed: false });
      })
      .catch(() => {
        if (live) setState({ items: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [active]);

  return active ? state : { items: null, failed: false };
}
