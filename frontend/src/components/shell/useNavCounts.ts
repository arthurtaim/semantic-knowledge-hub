import { useEffect, useState } from "react";
import { api } from "../../api/client";

/** Sidebar counts. Each is a value the API reported; while unknown (loading, error) no count is shown. */
export interface NavCounts {
  /** Documents in the reader's snapshot (GET /api/knowledge/facets → total). */
  documents: number | null;
  /** All change proposals (GET /api/drafts → total). */
  proposals: number | null;
  /** Proposals with status «Готово к ревью» (the Ревью item opens that filter). */
  review: number | null;
}

const UNKNOWN: NavCounts = { documents: null, proposals: null, review: null };

/** Re-read on every navigation (`key`), so a count follows what the user just created or reviewed. */
export function useNavCounts(key: string): NavCounts {
  const [counts, setCounts] = useState<NavCounts>(UNKNOWN);

  useEffect(() => {
    let live = true;
    api
      .facets()
      .then((facets) => {
        if (live) setCounts((prev) => ({ ...prev, documents: facets.total }));
      })
      .catch(() => {
        if (live) setCounts((prev) => ({ ...prev, documents: null }));
      });
    api
      .drafts()
      .then((list) => {
        if (!live) return;
        setCounts((prev) => ({
          ...prev,
          proposals: list.total,
          review: list.items.filter((item) => item.status === "ready_for_review").length,
        }));
      })
      .catch(() => {
        if (live) setCounts((prev) => ({ ...prev, proposals: null, review: null }));
      });
    return () => {
      live = false;
    };
  }, [key]);

  return counts;
}
