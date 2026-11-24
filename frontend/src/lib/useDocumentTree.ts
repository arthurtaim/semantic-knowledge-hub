import { useCallback, useMemo } from "react";
import { api } from "../api/client";
import type { DocumentTree } from "../api/types";
import { indexTree, type TreeIndex } from "./docTree";
import { useAsync, type AsyncState } from "./useAsync";

/*
 * GET /api/documents/tree for every view of «Документы» v2 and the document page's path. One request is shared:
 * the catalog always asks the server again when it opens (`maxAgeMs` 0), the document page reuses an answer that
 * is at most a minute old for its breadcrumbs.
 */

let cached: { at: number; promise: Promise<DocumentTree> } | null = null;

export function loadDocumentTree(maxAgeMs = 0): Promise<DocumentTree> {
  const now = Date.now();
  if (cached && now - cached.at <= maxAgeMs) return cached.promise;
  const entry = { at: now, promise: api.documentTree() };
  cached = entry;
  entry.promise.catch(() => {
    if (cached === entry) cached = null; // a failure is never served from the cache
  });
  return entry.promise;
}

/** Drops the shared answer (tests; after a change the catalog must not show an older tree). */
export function forgetDocumentTree(): void {
  cached = null;
}

export interface DocumentTreeState extends AsyncState<DocumentTree> {
  index: TreeIndex | null;
}

export function useDocumentTree(options: { maxAgeMs?: number } = {}): DocumentTreeState {
  const maxAgeMs = options.maxAgeMs ?? 0;
  const state = useAsync(() => loadDocumentTree(maxAgeMs), `documents-tree|${maxAgeMs}`);
  const index = useMemo(() => (state.data ? indexTree(state.data) : null), [state.data]);
  const { reload: reloadState } = state;
  const reload = useCallback(() => {
    forgetDocumentTree();
    reloadState();
  }, [reloadState]);
  return { ...state, index, reload };
}
