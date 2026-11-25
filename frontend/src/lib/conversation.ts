import { newConversationId } from "./assistant";
import { resetConversationStore } from "./conversationStore";

/**
 * Assistant state kept in MEMORY while the app is open (the turns themselves live in lib/conversationStore.ts and
 * in the server's chat history):
 *
 * - each composer's draft and dialog id (`saveDraft` / `restoreDraft`, by key: the home field, `dialog:<id>`), so
 *   following a citation and coming back keeps what was typed;
 * - the id of the dialog that has not been asked anything yet (`freshDialogId`): `/ask` without `?c=` reopens it
 *   with its draft until its first question gives it a URL (`claimFresh`);
 * - the dialog this tab showed last (`lastDialogId`): `/ask` without `?c=` (a link from another section) continues
 *   it — following a citation and coming back never loses the dialog;
 * - a message sent from the home page, handed to the dialog that runs it (`handOff` / `peekHandOff`).
 */
const drafts = new Map<string, unknown>();
let pending: unknown = null;
let fresh: string | null = null;
let lastDialog: string | null = null;

/** The dialog this tab shows (named by its URL): plain `/ask` continues it. */
export function rememberLastDialog(conversationId: string): void {
  lastDialog = conversationId;
}

export function lastDialogId(): string | null {
  return lastDialog;
}

/** «Новый диалог» or a deleted dialog: plain `/ask` no longer continues it. */
export function forgetLastDialog(conversationId?: string): void {
  if (!conversationId || lastDialog === conversationId) lastDialog = null;
}

/** The composer key of one dialog (each conversation keeps its own field). */
export function dialogKey(conversationId: string): string {
  return `dialog:${conversationId}`;
}

export function saveDraft<T>(key: string, draft: T): void {
  drafts.set(key, draft);
}

export function restoreDraft<T>(key: string): T | null {
  return (drafts.get(key) as T | undefined) ?? null;
}

export function deleteDraft(key: string): void {
  drafts.delete(key);
}

/**
 * The answer arrived while its page was not shown: the remembered field must not hold the answered question when
 * the page is opened again (a field that was changed meanwhile is left alone).
 */
export function clearSavedQuestion(key: string, conversationId: string, question: string): void {
  const saved = drafts.get(key) as { conversationId?: string; draft?: { text?: string } } | undefined;
  if (!saved?.draft || saved.conversationId !== conversationId || saved.draft.text?.trim() !== question.trim()) return;
  drafts.set(key, { ...saved, draft: { ...saved.draft, text: "" } });
}

/** The dialog `/ask` opens when the URL names none: the same one until its first question (then a new one). */
export function freshDialogId(): string {
  fresh ??= newConversationId();
  return fresh;
}

/** «Новый диалог»: a new empty dialog becomes the fresh one. */
export function startFreshDialog(): string {
  fresh = newConversationId();
  return fresh;
}

/** The fresh dialog got its first question (and its `?c=` URL): the next `/ask` starts another one. */
export function claimFresh(conversationId: string): void {
  if (fresh === conversationId) fresh = null;
}

/** The home page sends a message: the dialog page picks it up and runs it as the start of a new dialog. */
export function handOff<T>(message: T): void {
  pending = message;
}

/** Reads the handed-off message without taking it (React may run an initializer twice). */
export function peekHandOff<T>(): T | null {
  return pending as T | null;
}

export function clearHandOff(): void {
  pending = null;
}

/** Tests: forget everything kept in memory (drafts, the fresh dialog, the hand-off and the conversations). */
export function clearConversation(): void {
  drafts.clear();
  pending = null;
  fresh = null;
  lastDialog = null;
  resetConversationStore();
}
