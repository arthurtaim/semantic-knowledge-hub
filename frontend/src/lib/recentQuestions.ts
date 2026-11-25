import type { AssistantAttachment, AssistantSkill } from "../api/types";
import { CONVERSATION_ID_PATTERN, newConversationId } from "./assistant";
import { EMPTY_DRAFT, type ComposerDocument, type ComposerDraft, type ComposerFile } from "./useComposer";

/**
 * The user's recent dialogs as THIS browser remembers them — since the chat history (docs/API_CONTRACTS.md v0.7)
 * only the OFFLINE FALLBACK of the home page's «Недавние диалоги»: the list comes from the server (with the
 * answers); these entries are shown only when it cannot be read or the server keeps no history. Kept only in this
 * browser (localStorage, per user id), never sent anywhere, at most RECENT_LIMIT entries; answers and file
 * contents are never stored here — only the question, the skill (id and name), the dialog id, what was attached (a
 * file's id, name, size, the server's summary and expiry; a chosen document's id and title), the number of
 * sources of the answer and the time. Reopening an entry opens its dialog (stored turns if the server has them)
 * and puts the rest back into the field (`restoreDialog`) — it is never asked again by itself. Storage can be
 * unavailable (private mode, policy): every access is guarded and the UI works without it.
 *
 * Stored format (key `skh.recent-questions.v1:<user>`, a JSON array): phase 4 stored plain strings; later entries
 * are objects `{question, at, skill, sources, context}` with `skill` the skill's NAME. Round 2 adds fields only —
 * `skill_id`, `conversation_id`, `attachments`, `documents` — so older entries still read (and older code still
 * reads newer ones); anything malformed is skipped or dropped field by field.
 */
const RECENT_LIMIT = 5;
const MAX_LENGTH = 300;
const MAX_NAME = 160;
const MAX_ATTACHMENTS = 10;
const MAX_DOCUMENTS = 5;
const ATTACHMENT_ID = /^ATT-[0-9a-f]{16}$/;
const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SKILL_ID = /^[a-z][a-z0-9_]{0,63}$/;

export interface RecentSkill {
  /** null: remembered before skill ids were stored — matched by name when reopened. */
  id: string | null;
  name: string;
}

export interface RecentAttachment {
  id: string;
  name: string;
  /** Bytes; null when it was not known. */
  size: number | null;
  mime: string | null;
  /** The server's summary («3 листа»). */
  summary: string | null;
  /** ISO time after which the server no longer keeps the file. */
  expiresAt: string | null;
  /** Deleted (from this browser, or the server answered `attachment_not_found`): never sent again. */
  gone: boolean;
}

export interface RecentDocument {
  id: string;
  title: string;
}

export interface RecentDialog {
  /** The question as asked; "" when a skill ran without one. */
  question: string;
  /** ISO time of the question. */
  at: string | null;
  /** The skill; null for a plain answer. */
  skill: RecentSkill | null;
  /** Number of verified sources of the answer, once it arrived. */
  sources: number | null;
  /** The first attached file's name, or a chosen document's title. */
  context: string | null;
  /** The dialog the files belong to (the server keeps them per dialog); null for older entries. */
  conversationId: string | null;
  attachments: RecentAttachment[];
  documents: RecentDocument[];
}

/** What `rememberDialog` takes: a skill and attachments as the assistant has them. */
export interface DialogStart {
  question: string;
  skill?: RecentSkill | null;
  context?: string | null;
  at?: string;
  conversationId?: string | null;
  attachments?: (Partial<RecentAttachment> & { id: string; name: string })[];
  documents?: RecentDocument[];
}

function key(userId: string): string {
  return `skh.recent-questions.v1:${userId}`;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function parseAttachment(value: unknown): RecentAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = matching(record.id, ATTACHMENT_ID);
  const name = text(record.name, MAX_NAME);
  if (!id || !name) return null;
  return {
    id,
    name,
    size: count(record.size),
    mime: text(record.mime, 100),
    summary: text(record.summary, MAX_NAME),
    expiresAt: text(record.expires_at ?? record.expiresAt, 40),
    gone: record.gone === true,
  };
}

function parseDocument(value: unknown): RecentDocument | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = matching(record.id, DOCUMENT_ID);
  const title = text(record.title, MAX_NAME);
  return id && title ? { id, title } : null;
}

function list<T>(value: unknown, parse: (item: unknown) => T | null, max: number): T[] {
  return Array.isArray(value) ? value.map(parse).filter((item): item is T => item !== null).slice(0, max) : [];
}

/** Any stored entry (a phase-4 string, an object of any later round) as a dialog; anything else is skipped. */
function parse(entry: unknown): RecentDialog | null {
  const empty = { at: null, skill: null, sources: null, context: null, conversationId: null, attachments: [], documents: [] };
  if (typeof entry === "string") return entry.trim() ? { ...empty, question: entry.slice(0, MAX_LENGTH) } : null;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.slice(0, MAX_LENGTH) : "";
  const skillName = text(record.skill, MAX_NAME);
  if (!question && !skillName) return null;
  return {
    question,
    at: text(record.at, 40),
    skill: skillName ? { id: matching(record.skill_id, SKILL_ID), name: skillName } : null,
    sources: count(record.sources),
    context: text(record.context, MAX_NAME),
    conversationId: matching(record.conversation_id, CONVERSATION_ID_PATTERN),
    attachments: list(record.attachments, parseAttachment, MAX_ATTACHMENTS),
    documents: list(record.documents, parseDocument, MAX_DOCUMENTS),
  };
}

/** The stored shape: additive over the earlier objects (`skill` stays the name). */
function serialize(item: RecentDialog): Record<string, unknown> {
  return {
    question: item.question,
    at: item.at,
    skill: item.skill?.name ?? null,
    skill_id: item.skill?.id ?? null,
    sources: item.sources,
    context: item.context,
    conversation_id: item.conversationId,
    attachments: item.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      mime: a.mime,
      summary: a.summary,
      expires_at: a.expiresAt,
      gone: a.gone,
    })),
    documents: item.documents,
  };
}

export function readRecentDialogs(userId: string | null | undefined): RecentDialog[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(key(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parse).filter((entry): entry is RecentDialog => entry !== null).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function write(userId: string, entries: RecentDialog[]): void {
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(entries.slice(0, RECENT_LIMIT).map(serialize)));
  } catch {
    // Storage unavailable: nothing to remember, nothing breaks.
  }
}

/** One skill: by id when both entries know it, by name for entries stored before ids were. */
function sameSkill(a: RecentSkill | null, b: RecentSkill | null): boolean {
  if (!a || !b) return a === b;
  return a.id && b.id ? a.id === b.id : a.name === b.name;
}

const sameDialog = (a: RecentDialog, b: Pick<RecentDialog, "question" | "skill">) =>
  a.question === b.question && sameSkill(a.skill, b.skill);

function cleanSkill(skill: RecentSkill | null | undefined): RecentSkill | null {
  const name = skill?.name.trim().slice(0, MAX_NAME);
  return name ? { id: matching(skill?.id, SKILL_ID), name } : null;
}

/** Remembers a question (or a skill run) as the newest entry; an earlier identical entry moves up. */
export function rememberDialog(userId: string | null | undefined, entry: DialogStart): void {
  const question = entry.question.trim().slice(0, MAX_LENGTH);
  const skill = cleanSkill(entry.skill);
  if (!userId || (question.length < 3 && !skill)) return;
  const next: RecentDialog = {
    question,
    at: entry.at ?? new Date().toISOString(),
    skill,
    sources: null,
    context: entry.context?.trim().slice(0, MAX_NAME) || null,
    conversationId: matching(entry.conversationId, CONVERSATION_ID_PATTERN),
    attachments: list(
      (entry.attachments ?? []).map((a) => ({ ...a, expires_at: a.expiresAt })),
      parseAttachment,
      MAX_ATTACHMENTS,
    ),
    documents: list(entry.documents ?? [], parseDocument, MAX_DOCUMENTS),
  };
  write(userId, [next, ...readRecentDialogs(userId).filter((item) => !sameDialog(item, next))]);
}

/** Adds the number of sources once the answer arrived (to the newest matching entry). */
export function noteDialogSources(
  userId: string | null | undefined,
  probe: { question: string; skill: RecentSkill | null },
  sources: number,
): void {
  if (!userId) return;
  const items = readRecentDialogs(userId);
  const wanted = { question: probe.question.trim().slice(0, MAX_LENGTH), skill: cleanSkill(probe.skill) };
  const index = items.findIndex((item) => sameDialog(item, wanted));
  if (index < 0) return;
  items[index] = { ...(items[index] as RecentDialog), sources };
  write(userId, items);
}

/** These files are no longer on the server (deleted here, or `attachment_not_found`): reopening greys them out. */
export function markAttachmentsGone(userId: string | null | undefined, ids: string[]): void {
  if (!userId || ids.length === 0) return;
  const items = readRecentDialogs(userId);
  let changed = false;
  const next = items.map((item) => ({
    ...item,
    attachments: item.attachments.map((a) => {
      if (a.gone || !ids.includes(a.id)) return a;
      changed = true;
      return { ...a, gone: true };
    }),
  }));
  if (changed) write(userId, next);
}

/** The dialog was deleted from the history: its entry goes too. */
export function forgetRecentDialog(userId: string | null | undefined, conversationId: string): void {
  if (!userId) return;
  const items = readRecentDialogs(userId);
  const next = items.filter((item) => item.conversationId !== conversationId);
  if (next.length !== items.length) write(userId, next);
}

export function clearRecentQuestions(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(key(userId));
  } catch {
    // ignore
  }
}

// --- reopening -----------------------------------------------------------------------------------------------

/** The file can still be sent: not deleted, not past its expiry, and it belongs to the dialog it is sent in. */
export function attachmentAvailable(
  item: RecentDialog,
  attachment: RecentAttachment,
  now: number = Date.now(),
  conversationId: string | null = item.conversationId,
): boolean {
  if (attachment.gone || !item.conversationId || item.conversationId !== conversationId) return false;
  const expires = attachment.expiresAt ? Date.parse(attachment.expiresAt) : Number.NaN;
  return Number.isNaN(expires) || expires > now;
}

/**
 * The dialog's field as it was sent: the question, the files (a live file as a ready chip, an expired or deleted
 * one — or one of another dialog — as an unavailable chip that is never sent), the chosen documents. In the entry's
 * own dialog unless the page opens another (`conversationId`). The skill comes from the registry (`findSkill`) —
 * the page adds it once the registry is loaded.
 */
export function restoreDialog(
  item: RecentDialog,
  now: number = Date.now(),
  target: string | null = null,
): { conversationId: string; draft: ComposerDraft } {
  const conversationId = target ?? item.conversationId ?? newConversationId();
  const files: ComposerFile[] = item.attachments.map((a) => {
    const base = { key: `saved-${a.id}`, name: a.name, size: a.size ?? 0, error: null };
    // Without a known size the file was no longer in the field when it was remembered (removed, so deleted).
    if (!attachmentAvailable(item, a, now, conversationId) || a.size === null) return { ...base, status: "unavailable", attachment: null };
    const attachment: AssistantAttachment = {
      id: a.id,
      conversation_id: conversationId,
      name: a.name,
      size: a.size,
      mime: a.mime ?? "",
      status: "ready",
      summary: a.summary,
      error_code: null,
      expires_at: a.expiresAt,
    };
    return { ...base, status: "ready", attachment };
  });
  const documents: ComposerDocument[] = item.documents.map((d) => ({ id: d.id, title: d.title, status: null }));
  return { conversationId, draft: { ...EMPTY_DRAFT, text: item.question, files, documents } };
}

/** The registry's skill for a remembered one (by id; by name for older entries); only one that can run now. */
export function findSkill(items: AssistantSkill[] | null, skill: RecentSkill | null): AssistantSkill | null {
  if (!items || !skill) return null;
  const found = skill.id ? items.find((s) => s.id === skill.id) : items.find((s) => s.name === skill.name);
  return found?.available ? found : null;
}
