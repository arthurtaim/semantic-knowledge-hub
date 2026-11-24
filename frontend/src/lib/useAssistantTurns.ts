import { useEffect, useRef } from "react";
import type { ApiError } from "../api/client";
import type { AskRequest, AskResponse, ConversationTurn } from "../api/types";
import type { Turn, TurnDisplay } from "../components/AssistantTurn";
import { clearSavedQuestion } from "./conversation";
import { cancelTurn, isBusy, runTurn, setHandlers, toApiError, useConversation } from "./conversationStore";
import type { ComposerController, ComposerMessage } from "./useComposer";

/*
 * The turns of one assistant conversation and how a message becomes one (POST /api/assistant/ask/stream): the
 * stages the stream reports, the preliminary text, the validated answer, an error or a cancellation. Used by the
 * dialog (/ask) and the assistant panel of a document; each shows its own conversation. The turns and the request
 * in flight live in the conversation store (lib/conversationStore.ts), not in the component: leaving the page
 * neither cancels the request nor loses the dialog.
 */

/** Limits of POST /api/assistant/ask(/stream) `history` (backend AskRequest). */
export const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_ANSWER_CHARS = 4000;
/** `history[i].context` (M5.7): at most 5 referents per turn. */
const MAX_HISTORY_CONTEXT = 5;

/** Cuts by code points (as the backend counts), never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/**
 * Context for a follow-up: the last completed turns with a question and a validated answer, oldest first. M5.7: a
 * turn whose answer relied on system facts also sends their referent back (`conversation_context`: the filters and
 * visible IDs), so «А сколько из них утверждено?» keeps «из них». The server re-checks every ID and every call.
 */
export function historyFrom(turns: Turn[]): ConversationTurn[] {
  return turns
    .filter((turn) => turn.response !== null && turn.request.question.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => {
      const context = (turn.response?.conversation_context ?? []).slice(0, MAX_HISTORY_CONTEXT);
      return {
        question: turn.request.question,
        answer: truncate(turn.response?.answer ?? "", MAX_HISTORY_ANSWER_CHARS),
        ...(context.length > 0 ? { context } : {}),
      };
    });
}

export { toApiError };

export function displayOf(message: ComposerMessage): TurnDisplay {
  return {
    skill: message.skill ? { id: message.skill.id, name: message.skill.name, access: message.skill.access } : null,
    files: message.attachments.map((file) => ({ id: file.id, name: file.name })),
    documents: message.documents.map((document) => ({ id: document.id, title: document.title })),
    selection: message.selection?.label ?? null,
  };
}

interface UseAssistantTurnsOptions {
  /** The conversation shown (the composer's dialog id). */
  conversationId: string;
  /** The field the question comes from: cleared after an answer, the question put back after a failure. */
  composer: ComposerController;
  /** A request starts (the dialog remembers it among the recent dialogs of this browser). */
  onStart?: (request: AskRequest, display: TurnDisplay) => void;
  /** A validated answer arrived (also when the page has been left meanwhile). */
  onAnswer?: (request: AskRequest, display: TurnDisplay, response: AskResponse) => void;
  /** The request failed (not when it was cancelled) — e.g. an attached file the server no longer has. */
  onError?: (request: AskRequest, display: TurnDisplay, error: ApiError) => void;
}

export interface AssistantTurns {
  turns: Turn[];
  /** A request is running (one at a time per conversation). */
  pending: boolean;
  /** Earlier completed turns as the context of the next request. */
  history: ConversationTurn[];
  /** Runs one request as a new turn; a failed or cancelled last turn is replaced by it. */
  run: (request: AskRequest, display: TurnDisplay) => Promise<void>;
  /** Cancels the running request (on the server too). */
  cancel: () => void;
  /** A request is running right now (synchronous, for event handlers). */
  busy: () => boolean;
}

export function useAssistantTurns({ conversationId, composer, onStart, onAnswer, onError }: UseAssistantTurnsOptions): AssistantTurns {
  const state = useConversation(conversationId);
  const field = useRef(composer);
  field.current = composer;
  const effects = useRef({ onStart, onAnswer, onError });
  effects.current = { onStart, onAnswer, onError };

  // While this view is mounted, the outcome of a request reaches its field: cleared after the answer (only if it
  // still holds this question — the next one may already be typed), the question put back after a failure or a
  // cancellation, a file the server no longer has greyed out.
  useEffect(
    () =>
      setHandlers(conversationId, {
        onAnswer: (request) => {
          const composer = field.current;
          if (request.question && composer.message().question === request.question) composer.setText("");
        },
        onError: (request, _display, error) => {
          const composer = field.current;
          if (error.code === "attachment_not_found") {
            // The server names the file it could not find; without a name every file of the request is suspect.
            const named = typeof error.details.attachment_id === "string" ? [error.details.attachment_id] : [];
            composer.markUnavailable(named.length > 0 ? named : (request.attachment_ids ?? []));
          }
          // The question is never lost: put it back unless something else has been typed meanwhile.
          const current = composer.message().question;
          if (request.question && (current === "" || current === request.question)) composer.setText(request.question);
        },
        onCancel: (request) => {
          const composer = field.current;
          const current = composer.message().question;
          if (request.question && (current === "" || current === request.question)) composer.setText(request.question);
          composer.focus();
        },
      }),
    [conversationId],
  );

  const persistKey = composer.persistKey;
  return {
    turns: state.turns,
    pending: state.running,
    history: historyFrom(state.turns),
    run: (request, display) =>
      runTurn(conversationId, request, display, {
        onStart: (...args) => effects.current.onStart?.(...args),
        onAnswer: (...args) => {
          // Answered while the page was left: the remembered field must not offer the answered question again.
          if (persistKey && args[0].question) clearSavedQuestion(persistKey, conversationId, args[0].question);
          effects.current.onAnswer?.(...args);
        },
        onError: (...args) => effects.current.onError?.(...args),
      }),
    cancel: () => cancelTurn(conversationId),
    busy: () => isBusy(conversationId),
  };
}
