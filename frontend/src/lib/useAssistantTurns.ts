import { useEffect, useRef, useState } from "react";
import { ApiError, api, isCancelled } from "../api/client";
import type { AskRequest, AskResponse, AskStreamEvent, ConversationTurn } from "../api/types";
import type { Turn, TurnDisplay } from "../components/AssistantTurn";
import type { ComposerController, ComposerMessage } from "./useComposer";

/*
 * The turns of one assistant conversation and how a message becomes one (POST /api/assistant/ask/stream): the
 * stages the stream reports, the preliminary text, the validated answer, an error or a cancellation. Used by the
 * dialog (/ask) and the assistant panel of a document; each owns its own conversation.
 */

/** Limits of POST /api/assistant/ask(/stream) `history` (backend AskRequest). */
export const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_ANSWER_CHARS = 4000;

/** Cuts by code points (as the backend counts), never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/** Context for a follow-up: the last completed turns with a question and a validated answer, oldest first. */
export function historyFrom(turns: Turn[]): ConversationTurn[] {
  return turns
    .filter((turn) => turn.response !== null && turn.request.question.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      question: turn.request.question,
      answer: truncate(turn.response?.answer ?? "", MAX_HISTORY_ANSWER_CHARS),
    }));
}

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

export function displayOf(message: ComposerMessage): TurnDisplay {
  return {
    skill: message.skill ? { id: message.skill.id, name: message.skill.name, access: message.skill.access } : null,
    files: message.attachments.map((file) => ({ id: file.id, name: file.name })),
    documents: message.documents.map((document) => ({ id: document.id, title: document.title })),
    selection: message.selection?.label ?? null,
  };
}

interface UseAssistantTurnsOptions {
  /** The field the question comes from: cleared after an answer, the question put back after a failure. */
  composer: ComposerController;
  /** Completed turns to start from (the dialog restores them after a visit to a cited document). */
  initial?: () => Turn[];
  /** A request starts (the dialog remembers it among the recent dialogs). */
  onStart?: (request: AskRequest, display: TurnDisplay) => void;
  /** A validated answer arrived. */
  onAnswer?: (request: AskRequest, display: TurnDisplay, response: AskResponse) => void;
}

export interface AssistantTurns {
  turns: Turn[];
  /** A request is running (one at a time). */
  pending: boolean;
  /** Earlier completed turns as the context of the next request. */
  history: ConversationTurn[];
  /** Runs one request as a new turn; a failed or cancelled last turn is replaced by it. */
  run: (request: AskRequest, display: TurnDisplay) => Promise<void>;
  /** Cancels the running request (on the server too). */
  cancel: () => void;
  /** Forgets the conversation (unless a request is running). */
  clear: () => void;
  /** A request is running right now (synchronous, for event handlers). */
  busy: () => boolean;
}

export function useAssistantTurns({ composer, initial, onStart, onAnswer }: UseAssistantTurnsOptions): AssistantTurns {
  const [turns, setTurns] = useState<Turn[]>(() => initial?.() ?? []);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const nextId = useRef(turns.reduce((max, turn) => Math.max(max, turn.id), 0));
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page cancels a running generation on the server.
  useEffect(() => () => abortRef.current?.abort(), []);

  function patchTurn(id: number, patch: Partial<Turn> | ((turn: Turn) => Partial<Turn>)) {
    setTurns((list) =>
      list.map((turn) => (turn.id === id ? { ...turn, ...(typeof patch === "function" ? patch(turn) : patch) } : turn)),
    );
  }

  function onStreamEvent(id: number, event: AskStreamEvent) {
    if (event.type === "status") {
      patchTurn(
        id,
        event.stage === "generating"
          ? { phase: "generating", passages: event.passages ?? null, provider: event.provider ?? null }
          : { phase: event.stage },
      );
    } else if (event.type === "delta") {
      patchTurn(id, (turn) => ({ preliminary: turn.preliminary + event.text }));
    }
  }

  async function run(request: AskRequest, display: TurnDisplay) {
    if (inFlight.current) return;
    inFlight.current = true;
    onStart?.(request, display);
    const id = ++nextId.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setTurns((list) => [
      ...list.filter((turn) => turn.phase === "done"),
      { id, request, display, phase: "retrieving", passages: null, provider: null, preliminary: "", response: null, error: null },
    ]);
    try {
      const response = await api.askStream(request, {
        signal: controller.signal,
        onEvent: (event) => onStreamEvent(id, event),
      });
      // The validated answer replaces the preliminary text.
      patchTurn(id, { phase: "done", response, preliminary: "" });
      onAnswer?.(request, display, response);
      // Clear the field only if it still holds this question (the next one may already be typed there).
      if (request.question && composer.message().question === request.question) composer.setText("");
    } catch (err) {
      const error = toApiError(err);
      const cancelled = isCancelled(error);
      patchTurn(id, cancelled ? { phase: "cancelled", preliminary: "" } : { phase: "error", error, preliminary: "" });
      // The question is never lost: put it back unless something else has been typed meanwhile.
      const current = composer.message().question;
      if (request.question && (current === "" || current === request.question)) composer.setText(request.question);
      if (cancelled) composer.focus();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlight.current = false;
      setPending(false);
    }
  }

  return {
    turns,
    pending,
    history: historyFrom(turns),
    run,
    cancel: () => abortRef.current?.abort(),
    clear: () => {
      if (!inFlight.current) setTurns([]);
    },
    busy: () => inFlight.current,
  };
}
