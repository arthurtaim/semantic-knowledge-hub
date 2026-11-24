import { useEffect, useState } from "react";
import { api } from "../../api/client";

/** Sidebar counts. Each is a value the API reported; while unknown (loading, error) no count is shown. */
export interface NavCounts {
  /** Documents in the reader's snapshot (GET /api/knowledge/facets → total). */
  documents: number | null;
  /** Open change proposals (GET /api/drafts?open_only=true → total): merged, rejected and conflict are closed. */
  proposals: number | null;
  /** Proposals «Готово к ревью» that someone else created (GET /api/drafts?status=ready_for_review&exclude_own=true
   * → total): the Ревью item opens the same list. Usually 0 in the single-user demo — then no badge. */
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
      .drafts({ open_only: true })
      .then((list) => {
        if (!live) return;
        setCounts((prev) => ({ ...prev, proposals: list.total }));
      })
      .catch(() => {
        if (live) setCounts((prev) => ({ ...prev, proposals: null }));
      });
    api
      .drafts({ status: "ready_for_review", exclude_own: true })
      .then((list) => {
        if (live) setCounts((prev) => ({ ...prev, review: list.total }));
      })
      .catch(() => {
        if (live) setCounts((prev) => ({ ...prev, review: null }));
      });
    return () => {
      live = false;
    };
  }, [key]);

  return counts;
}
