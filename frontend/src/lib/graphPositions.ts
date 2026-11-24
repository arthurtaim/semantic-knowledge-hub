import { useCallback, useEffect, useState } from "react";
import type { Point } from "./graph";

/*
 * Manual node positions on the knowledge map (docs/ui-v2/specs/04_KNOWLEDGE_GRAPH.md §2): kept apart from the
 * computed layout (`overrides: Map<nodeId, {x, y}>`, final position = override ?? layout), per view — mode,
 * focus or trace, depth and filters — in sessionStorage, so they live while the user explores the map in this
 * tab. Storage may be unavailable (private mode, blocked site data): every access is wrapped and the positions
 * then live only in memory.
 */

const PREFIX = "skh.graph.positions:";
const TRACE_KEY = "skh.graph.trace";
/** A view never stores more than this many manual positions (oldest are dropped first). */
export const MAX_STORED_POSITIONS = 400;

function session(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readPositions(viewKey: string): Map<string, Point> {
  const result = new Map<string, Point>();
  try {
    const raw = session()?.getItem(PREFIX + viewKey);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as { v?: number; p?: Record<string, unknown> };
    if (parsed.v !== 1 || !parsed.p || typeof parsed.p !== "object") return result;
    for (const [id, value] of Object.entries(parsed.p)) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      const [x, y] = value as unknown[];
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) result.set(id, { x, y });
    }
  } catch {
    // Unreadable or unavailable: no manual positions.
  }
  return result;
}

export function writePositions(viewKey: string, positions: ReadonlyMap<string, Point>): void {
  try {
    const storage = session();
    if (!storage) return;
    if (positions.size === 0) {
      storage.removeItem(PREFIX + viewKey);
      return;
    }
    const entries = [...positions].slice(-MAX_STORED_POSITIONS);
    const p = Object.fromEntries(entries.map(([id, point]) => [id, [Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]]));
    storage.setItem(PREFIX + viewKey, JSON.stringify({ v: 1, p }));
  } catch {
    // Not remembered (quota, blocked storage): the positions still apply on this page.
  }
}

/** The last answer trace opened in this tab: «Граф ответа» leads back to it. */
export function readLastTrace(): string | null {
  try {
    return session()?.getItem(TRACE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberTrace(trace: string): void {
  try {
    session()?.setItem(TRACE_KEY, trace);
  } catch {
    // Not remembered.
  }
}

export interface NodePositions {
  overrides: ReadonlyMap<string, Point>;
  /** Grows with every «Сбросить расположение»: the layout is computed afresh. */
  resetCount: number;
  move: (id: string, point: Point) => void;
  reset: () => void;
}

interface State {
  viewKey: string;
  baseKey: string;
  overrides: Map<string, Point>;
  resetCount: number;
}

/**
 * Manual positions of the current view. Switching to another view of the same map (another filter or depth)
 * carries the positions over — a filter change does not undo what the user arranged — and the positions stored
 * for that view earlier come back.
 */
export function useNodePositions(viewKey: string, baseKey: string): NodePositions {
  const [state, setState] = useState<State>(() => ({ viewKey, baseKey, overrides: readPositions(viewKey), resetCount: 0 }));
  let current = state;
  if (state.viewKey !== viewKey) {
    const stored = readPositions(viewKey);
    current = {
      viewKey,
      baseKey,
      overrides: state.baseKey === baseKey ? new Map([...stored, ...state.overrides]) : stored,
      resetCount: state.resetCount,
    };
    setState(current);
  }

  useEffect(() => writePositions(current.viewKey, current.overrides), [current.viewKey, current.overrides]);

  const move = useCallback((id: string, point: Point) => {
    setState((s) => {
      const overrides = new Map(s.overrides);
      overrides.delete(id); // re-inserted last: the newest positions survive the size limit
      overrides.set(id, point);
      return { ...s, overrides };
    });
  }, []);
  const reset = useCallback(() => setState((s) => ({ ...s, overrides: new Map(), resetCount: s.resetCount + 1 })), []);
  return { overrides: current.overrides, resetCount: current.resetCount, move, reset };
}
