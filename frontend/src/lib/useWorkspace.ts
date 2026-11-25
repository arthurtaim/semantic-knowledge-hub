import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { AssigneeRef, TaskUpdate, WorkCapabilities, WorkGantt, WorkProject, WorkTask } from "../api/types";
import { canWriteProject } from "./work";

/*
 * One project's working state for List, Board and Gantt (docs/WORK_MANAGEMENT.md «UI»): the mode
 * (`GET /api/work/capabilities`), the project, ONE snapshot of its tasks and dependencies (`GET …/gantt`, with its
 * `plan_revision`) and the assignee directory. Every view reads the same snapshot, so after a change all three
 * show the same state (M6-36). Changes go to the server; the snapshot is re-read quietly afterwards (no loading
 * state, no page reload) so derived fields — blocked, overdue, counts, the plan revision — come from the server.
 */

export interface WorkMessage {
  tone: "info" | "success" | "warning" | "danger";
  text: string;
  /** Changes on every message, so the same text is announced again. */
  nonce: number;
}

export type UpdateResult = { ok: true; task: WorkTask } | { ok: false; error: ApiError };

export interface Workspace {
  capabilities: WorkCapabilities | null;
  project: WorkProject | null;
  snapshot: WorkGantt | null;
  assignees: AssigneeRef[];
  loading: boolean;
  error: ApiError | null;
  canWrite: boolean;
  message: WorkMessage | null;
  say: (tone: WorkMessage["tone"], text: string) => void;
  clearMessage: () => void;
  /** Re-reads the project and the snapshot without a loading state; resolves when both are in. */
  refresh: () => Promise<void>;
  reload: () => void;
  /** Optimistic for plain fields (rolled back on any error); `409 stale_task` re-reads the snapshot. */
  updateTask: (task: WorkTask, changes: Omit<TaskUpdate, "expected_version">, options?: { optimistic?: boolean }) => Promise<UpdateResult>;
  /** Replaces tasks in the snapshot with what the server returned. */
  mergeTasks: (tasks: WorkTask[]) => void;
}

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/** The fields a change can show at once, before the server answers (dates wait: the server canonicalises them). */
const OPTIMISTIC_FIELDS = new Set(["title", "status", "priority", "assignee_id", "due_date", "description"]);

function applyLocally(task: WorkTask, changes: Omit<TaskUpdate, "expected_version">, assignees: AssigneeRef[]): WorkTask {
  const next: WorkTask = { ...task };
  for (const [field, value] of Object.entries(changes)) {
    if (!OPTIMISTIC_FIELDS.has(field)) continue;
    (next as unknown as Record<string, unknown>)[field] = value;
  }
  if ("assignee_id" in changes) {
    next.assignee = changes.assignee_id ? (assignees.find((a) => a.id === changes.assignee_id) ?? null) : null;
  }
  return next;
}

export function staleTaskText(task: Pick<WorkTask, "key">): string {
  return `${task.key} уже изменили в другом месте (другая вкладка или участник). Показаны актуальные данные — повторите правку.`;
}

export function useWorkspace(projectRef: string): Workspace {
  const [capabilities, setCapabilities] = useState<WorkCapabilities | null>(null);
  const [project, setProject] = useState<WorkProject | null>(null);
  const [snapshot, setSnapshot] = useState<WorkGantt | null>(null);
  const [assignees, setAssignees] = useState<AssigneeRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<WorkMessage | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const assigneesRef = useRef(assignees);
  assigneesRef.current = assignees;

  const say = useCallback((tone: WorkMessage["tone"], text: string) => setMessage({ tone, text, nonce: Date.now() + Math.random() }), []);
  const clearMessage = useCallback(() => setMessage(null), []);

  useEffect(() => {
    let live = true;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    Promise.all([api.workCapabilities(), api.workProject(projectRef), api.workGantt(projectRef)])
      .then(([caps, proj, gantt]) => {
        if (!live || mine !== seq.current) return;
        setCapabilities(caps);
        setProject(proj);
        setSnapshot(gantt);
        // The directory is optional for reading: without it a task still shows its assignee's name.
        api
          .workAssignees(proj.id)
          .then((list) => {
            if (live) setAssignees(list);
          })
          .catch(() => {
            if (live) setAssignees([]);
          });
      })
      .catch((err: unknown) => {
        if (live && mine === seq.current) setError(toApiError(err));
      })
      .finally(() => {
        if (live && mine === seq.current) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectRef, nonce]);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [proj, gantt] = await Promise.all([api.workProject(projectRef), api.workGantt(projectRef)]);
      if (mine !== seq.current) return;
      setProject(proj);
      setSnapshot(gantt);
    } catch (err) {
      if (mine === seq.current) setMessage({ tone: "danger", text: `Не удалось обновить данные: ${toApiError(err).message}`, nonce: Date.now() });
    }
  }, [projectRef]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const mergeTasks = useCallback((tasks: WorkTask[]) => {
    if (!tasks.length) return;
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    setSnapshot((current) => (current ? { ...current, tasks: current.tasks.map((t) => byId.get(t.id) ?? t) } : current));
  }, []);

  const updateTask = useCallback<Workspace["updateTask"]>(
    async (task, changes, options = {}) => {
      const optimistic = options.optimistic ?? true;
      if (optimistic) mergeTasks([applyLocally(task, changes, assigneesRef.current)]);
      try {
        const updated = await api.workUpdateTask(task.id, { expected_version: task.version, ...changes });
        mergeTasks([updated]);
        void refresh();
        return { ok: true, task: updated };
      } catch (err) {
        const apiError = toApiError(err);
        if (optimistic) mergeTasks([task]); // roll back what was shown
        if (apiError.status === 409 && apiError.code === "stale_task") {
          say("warning", staleTaskText(task));
          await refresh();
        } else if (!(apiError.code === "schedule_conflict" && apiError.details.reason === "fs_violation")) {
          say("danger", `${task.key}: ${apiError.message}`);
        }
        return { ok: false, error: apiError };
      }
    },
    [mergeTasks, refresh, say],
  );

  return {
    capabilities,
    project,
    snapshot,
    assignees,
    loading,
    error,
    canWrite: canWriteProject(capabilities, project),
    message,
    say,
    clearMessage,
    refresh,
    reload,
    updateTask,
    mergeTasks,
  };
}
