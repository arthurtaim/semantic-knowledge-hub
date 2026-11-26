import { useSyncExternalStore } from "react";
import { ApiError, api, isCancelled } from "../api/client";
import type {
  AskRequest,
  AskResponse,
  AskStreamEvent,
  AskStreamRetrievalStep,
  StoredConversation,
  StoredTurn,
  StoredTurnRequest,
} from "../api/types";
import type { Turn, TurnDisplay } from "../components/AssistantTurn";
import { pluralRu } from "./labels";
import { toolActivity } from "./systemFacts";

/*
 * The assistant's conversations while the app is open, OUTSIDE the component tree (the reported defect: leaving
 * /ask aborted an answer in flight and lost the dialog). Keyed by the conversation id: the turns, the request
 * running in it (its AbortController lives here, so unmounting a page never cancels it — only «Отменить» does)
 * and whether the stored turns were loaded from the server (GET /api/assistant/conversations/{id}). A reload
 * empties this module; completed turns then come back from the server, and a turn that never completed is shown
 * as such («Ответ не был получен»), never re-run.
 */

export type LoadState = "none" | "new" | "loading" | "loaded" | "missing" | "failed";

export interface ConversationState {
  turns: Turn[];
  /** A request of this conversation is running. */
  running: boolean;
  /** `new`: started in this tab (nothing to load); `missing`: the server has no such conversation for this browser. */
  load: LoadState;
  loadError: ApiError | null;
  /** The stored conversation (title, origin, document, generation) once loaded. */
  stored: Omit<StoredConversation, "turns"> | null;
}

/** Outcome callbacks of a request: the page's field reacts while it is mounted (`setHandlers`). */
export interface TurnHandlers {
  onAnswer?: (request: AskRequest, display: TurnDisplay, response: AskResponse) => void;
  onError?: (request: AskRequest, display: TurnDisplay, error: ApiError) => void;
  onCancel?: (request: AskRequest, display: TurnDisplay) => void;
}

/** Side effects that do not depend on a mounted page (remembering the dialog in this browser). */
export interface TurnEffects extends TurnHandlers {
  onStart?: (request: AskRequest, display: TurnDisplay) => void;
}

/** How stored turns become dialog turns (the document panel shows its document once, above). */
export interface LoadOptions {
  /** A document the view shows as its context: left out of each turn's chips. */
  contextDocumentId?: string;
  /** The label of a quick action that ran without a question («Объяснить раздел»), by skill id. */
  actionLabel?: (skillId: string) => string | null;
  /** `origin` of requests sent again from these turns. */
  origin?: "dialog" | "document";
}

interface Entry {
  state: ConversationState;
  controller: AbortController | null;
  nextId: number;
}

const EMPTY: ConversationState = { turns: [], running: false, load: "none", loadError: null, stored: null };

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const handlers = new Map<string, TurnHandlers>();

function emit(id: string): void {
  for (const listener of listeners.get(id) ?? []) listener();
}

function entryOf(id: string, load: LoadState = "new"): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { state: { ...EMPTY, load }, controller: null, nextId: 0 };
    entries.set(id, entry);
  }
  return entry;
}

function update(id: string, change: (state: ConversationState) => ConversationState): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.state = change(entry.state);
  emit(id);
}

function patchTurn(id: string, turnId: number, patch: Partial<Turn> | ((turn: Turn) => Partial<Turn>)): void {
  update(id, (state) => ({
    ...state,
    turns: state.turns.map((turn) => (turn.id === turnId ? { ...turn, ...(typeof patch === "function" ? patch(turn) : patch) } : turn)),
  }));
}

export function subscribe(id: string, listener: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) listeners.delete(id);
  };
}

export function peekConversation(id: string): ConversationState {
  return entries.get(id)?.state ?? EMPTY;
}

/** The conversation's state for a component; re-renders on every change of THIS conversation. */
export function useConversation(id: string): ConversationState {
  return useSyncExternalStore(
    (listener) => subscribe(id, listener),
    () => peekConversation(id),
  );
}

/** The mounted view of a conversation reacts to outcomes (clears or refills its field). Returns the unregister. */
export function setHandlers(id: string, value: TurnHandlers): () => void {
  handlers.set(id, value);
  return () => {
    if (handlers.get(id) === value) handlers.delete(id);
  };
}

/** A conversation started in this tab: nothing to load from the server. */
export function markNew(id: string): void {
  entryOf(id, "new");
}

export function isBusy(id: string): boolean {
  return entries.get(id)?.controller != null;
}

// --- stored turns → dialog turns -------------------------------------------------------------------------------

function selectionLabel(selection: NonNullable<StoredTurnRequest["selection"]>): string {
  const n = selection.lines;
  if (n > 0) return `Выделение: ${n} ${pluralRu(n, "строка", "строки", "строк")}`;
  return selection.section ? `Раздел «${selection.section}»` : "Выделение";
}

/** The request a stored turn was made with, as the dialog would send it again (live files only, no selection text). */
export function requestOf(stored: StoredTurnRequest, conversationId: string, origin?: "dialog" | "document"): AskRequest {
  const request: AskRequest = {
    question: stored.question,
    sources: stored.sources,
    include_drafts: stored.include_drafts,
    include_deprecated: stored.include_deprecated,
    history: [],
    conversation_id: conversationId,
  };
  if (stored.search_external) request.search_external = true;
  if (stored.skill) request.skill_id = stored.skill.id;
  const files = stored.attachments.filter((file) => file.available).map((file) => file.id);
  if (files.length > 0) request.attachment_ids = files;
  if (stored.documents.length > 0) request.context_document_ids = stored.documents.map((doc) => doc.id);
  if (origin === "document") request.origin = "document";
  return request;
}

/** One stored turn as a turn of the dialog: rendered by the same components as a live answer. */
export function turnFromStored(stored: StoredTurn, id: number, conversationId: string, options: LoadOptions = {}): Turn {
  const req = stored.request;
  const display: TurnDisplay = {
    skill: req.skill,
    files: req.attachments.map((file) => ({ id: file.id, name: file.name })),
    documents: req.documents.filter((doc) => doc.id !== options.contextDocumentId),
    selection: req.selection ? selectionLabel(req.selection) : null,
    action: !req.question && req.skill ? (options.actionLabel?.(req.skill.id) ?? null) : null,
  };
  const phase = stored.status === "done" ? "done" : stored.status === "failed" ? "error" : "interrupted";
  return {
    id,
    request: requestOf(req, conversationId, options.origin),
    display,
    phase,
    passages: null,
    provider: null,
    preliminary: "",
    activity: null,
    response: stored.response,
    error: stored.error ? new ApiError(stored.error.status, stored.error.code, stored.error.message, null) : null,
    stored: {
      seq: stored.seq,
      status: stored.status,
      notes: stored.notes,
      withheld: stored.withheld,
      // A selection is stored as a reference only: its text cannot be sent again.
      resendable: req.selection === null,
      request: req,
    },
  };
}

/**
 * Loads the stored turns once (unless the conversation already lives in this tab). 404 → `missing` (deleted, too
 * old, another browser, history off); another failure → `failed` with the error (the view offers to retry).
 */
export async function ensureLoaded(id: string, options: LoadOptions = {}, force = false): Promise<void> {
  const existing = entries.get(id);
  if (existing && !force && existing.state.load !== "none") return;
  const entry = entryOf(id, "loading");
  if (entry.controller) return;
  update(id, (state) => ({ ...state, load: "loading", loadError: null }));
  try {
    const stored = await api.conversation(id);
    const { turns: storedTurns, ...meta } = stored;
    let next = 0;
    const turns = storedTurns.map((turn) => turnFromStored(turn, ++next, id, options));
    entry.nextId = Math.max(entry.nextId, next);
    // Turns started in this tab meanwhile (none normally: the view waits) stay after the stored ones.
    update(id, (state) => ({
      ...state,
      turns: [...turns, ...state.turns.filter((turn) => !turn.stored)],
      load: "loaded",
      stored: meta,
    }));
  } catch (err) {
    const error = toApiError(err);
    const missing = error.status === 404;
    update(id, (state) => ({ ...state, load: missing ? "missing" : "failed", loadError: missing ? null : error }));
  }
}

// --- running a turn -----------------------------------------------------------------------------------------------

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/** Adaptive RAG: one short line of what the retrieval is doing (no model output, no queries). */
export const RETRIEVAL_ACTIVITY: Record<AskStreamRetrievalStep, string> = {
  assessing: "Проверяю, хватает ли сведений в документах команды…",
  external: "Ищу недостающее во внешнем источнике (Confluence)…",
};

function onStreamEvent(id: string, turnId: number, event: AskStreamEvent): void {
  if (event.type === "status") {
    patchTurn(id, turnId, (turn) =>
      event.stage === "generating"
        ? {
            phase: "generating",
            passages: event.passages ?? null,
            provider: event.provider ?? null,
            activity: null,
            // M5.7: every model round after the first starts a NEW preliminary text — never glue rounds together.
            preliminary: (event.round ?? 1) > 1 ? "" : turn.preliminary,
          }
        : { phase: event.stage, activity: event.stage === "retrieving" && event.step ? RETRIEVAL_ACTIVITY[event.step] : null },
    );
  } else if (event.type === "delta") {
    patchTurn(id, turnId, (turn) => ({ preliminary: turn.preliminary + event.text }));
  } else if (event.type === "tool_call") {
    // One short line of what is being checked («Проверяю каталог…»); no payloads, no debug view.
    patchTurn(id, turnId, { activity: toolActivity(event.tool) });
  }
}

/**
 * Runs one request as a new turn of the conversation (POST /api/assistant/ask/stream); a failed, cancelled or
 * interrupted last turn is replaced by it. One request at a time per conversation. It keeps running when the page
 * that started it is left: only `cancelTurn` aborts it.
 */
export async function runTurn(id: string, request: AskRequest, display: TurnDisplay, effects: TurnEffects = {}): Promise<void> {
  const entry = entryOf(id, "new");
  if (entry.controller) return;
  const controller = new AbortController();
  entry.controller = controller;
  effects.onStart?.(request, display);
  const turnId = ++entry.nextId;
  update(id, (state) => ({
    ...state,
    running: true,
    turns: [
      ...state.turns.filter((turn) => turn.phase === "done"),
      { id: turnId, request, display, phase: "retrieving", passages: null, provider: null, preliminary: "", activity: null, response: null, error: null },
    ],
  }));
  try {
    const response = await api.askStream(request, { signal: controller.signal, onEvent: (event) => onStreamEvent(id, turnId, event) });
    // The validated answer replaces the preliminary text.
    patchTurn(id, turnId, { phase: "done", response, preliminary: "", activity: null });
    effects.onAnswer?.(request, display, response);
    handlers.get(id)?.onAnswer?.(request, display, response);
  } catch (err) {
    const error = toApiError(err);
    const cancelled = isCancelled(error);
    patchTurn(id, turnId, cancelled ? { phase: "cancelled", preliminary: "" } : { phase: "error", error, preliminary: "" });
    if (cancelled) {
      effects.onCancel?.(request, display);
      handlers.get(id)?.onCancel?.(request, display);
    } else {
      effects.onError?.(request, display, error);
      handlers.get(id)?.onError?.(request, display, error);
    }
  } finally {
    if (entry.controller === controller) entry.controller = null;
    update(id, (state) => ({ ...state, running: false }));
  }
}

/** Cancels the running request of the conversation (on the server too). */
export function cancelTurn(id: string): void {
  entries.get(id)?.controller?.abort();
}

/** The conversation was deleted: forget it here too (never while a request runs). */
export function forgetConversation(id: string): void {
  if (isBusy(id)) return;
  entries.delete(id);
  emit(id);
}

/** «Очистить историю»: forget every conversation that is not running. */
export function forgetAllConversations(): void {
  for (const id of [...entries.keys()]) forgetConversation(id);
}

/** Tests: abort everything and start from an empty store. */
export function resetConversationStore(): void {
  for (const entry of entries.values()) entry.controller?.abort();
  entries.clear();
  handlers.clear();
  for (const id of [...listeners.keys()]) emit(id);
}
