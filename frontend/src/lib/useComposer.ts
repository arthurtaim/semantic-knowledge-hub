import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ApiError, api, isCancelled } from "../api/client";
import type { AskRequest, AssistantAttachment, AssistantSkill, ConversationTurn, DocStatus } from "../api/types";
import {
  ATTACHMENT_ERROR_TEXT,
  formatBytes,
  newConversationId,
  precheckFile,
  scopeSources,
  type AskScope,
} from "./assistant";
import { restoreDraft, saveDraft } from "./conversation";

/*
 * The state behind one assistant field (components/Composer.tsx): the text, the chips (one skill, files of this
 * dialog, documents chosen with «@», a selection in a document), where to look, and the dialog id the files
 * belong to. The page owns it, so a quick skill on the home page can put its chip into the field, and the dialog
 * keeps the previous message's skill and files as chips after sending.
 */

export type ComposerFileStatus = "reading" | "ready" | "error";

/** A file chip: «Читаю…» while uploading, then ready (with the server's summary) or an error. */
export interface ComposerFile {
  key: string;
  name: string;
  size: number;
  status: ComposerFileStatus;
  /** The stored attachment once the server accepted it. */
  attachment: AssistantAttachment | null;
  /** Why the file was not accepted («формат не поддерживается», «больше 20 МБ», …). */
  error: string | null;
}

/** A knowledge-base document chosen as context (`context_document_ids`). */
export interface ComposerDocument {
  id: string;
  title: string;
  status: DocStatus | null;
}

/** A fragment selected in a document (`selection`); `label` is the chip text, e.g. «Выделение: 1 строка». */
export interface ComposerSelection {
  document_id: string;
  section_anchor?: string | null;
  text?: string;
  label: string;
}

export interface ComposerDraft {
  text: string;
  skill: AssistantSkill | null;
  files: ComposerFile[];
  documents: ComposerDocument[];
  selection: ComposerSelection | null;
  scope: AskScope;
  includeDrafts: boolean;
  includeDeprecated: boolean;
}

/** What one send carries: only READY attachments; the text trimmed. */
export interface ComposerMessage {
  conversationId: string;
  question: string;
  skill: AssistantSkill | null;
  attachments: AssistantAttachment[];
  documents: ComposerDocument[];
  selection: ComposerSelection | null;
  scope: AskScope;
  includeDrafts: boolean;
  includeDeprecated: boolean;
}

/** The API accepts at most 5 documents chosen with «@». */
export const MAX_CONTEXT_DOCUMENTS = 5;

export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  skill: null,
  files: [],
  documents: [],
  selection: null,
  scope: "team",
  includeDrafts: false,
  includeDeprecated: false,
};

/** POST /api/assistant/ask(/stream) body; the v0.4 fields only when they carry something. */
export function toAskRequest(message: ComposerMessage, history: ConversationTurn[] = []): AskRequest {
  const request: AskRequest = {
    question: message.question,
    sources: scopeSources(message.scope),
    include_drafts: message.includeDrafts,
    include_deprecated: message.includeDeprecated,
    history,
    conversation_id: message.conversationId,
  };
  if (message.skill) request.skill_id = message.skill.id;
  if (message.attachments.length > 0) request.attachment_ids = message.attachments.map((a) => a.id);
  if (message.documents.length > 0) request.context_document_ids = message.documents.map((d) => d.id);
  if (message.selection) {
    const { document_id, section_anchor, text } = message.selection;
    request.selection = { document_id, section_anchor: section_anchor ?? null, text: text ?? "" };
  }
  return request;
}

/** A failed upload (not a rejected file): a short reason for the chip. */
function uploadFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "нет связи с сервером";
    if (error.code === "assistant_disabled") return "ИИ отключён";
    return error.message;
  }
  return "не удалось загрузить";
}

export interface ComposerController {
  draft: ComposerDraft;
  conversationId: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The last change worth announcing (files read or rejected) — the composer's live region. */
  announcement: string;
  /** A file is still being read: sending waits. */
  reading: boolean;
  setText: (text: string) => void;
  setSkill: (skill: AssistantSkill | null) => void;
  setScope: (scope: AskScope) => void;
  setIncludeDrafts: (value: boolean) => void;
  setIncludeDeprecated: (value: boolean) => void;
  /** Checks, then uploads each file to this dialog; rejected files stay as error chips. */
  addFiles: (files: File[]) => void;
  /** Removes a chip; a ready file is deleted on the server, a reading one is cancelled. */
  removeFile: (key: string) => void;
  /** false when the document is already there or the limit is reached. */
  addDocument: (document: ComposerDocument) => boolean;
  removeDocument: (id: string) => void;
  setSelection: (selection: ComposerSelection | null) => void;
  /** Backspace in an empty field: removes the last chip (selection, documents, files, skill). */
  removeLast: () => boolean;
  message: () => ComposerMessage;
  /**
   * «Новый диалог»: an empty field and a new dialog id; the files of the old dialog are deleted — unless they were
   * handed over with the message (`{ handedOver: true }`: the home field after sending to the dialog). Returns
   * the new dialog id.
   */
  reset: (options?: { handedOver?: boolean }) => string;
  focus: () => void;
}

interface Saved {
  conversationId: string;
  draft: ComposerDraft;
}

/** Files still being read when the page is left are dropped: their upload is cancelled. */
function settled(draft: ComposerDraft): ComposerDraft {
  return { ...draft, files: draft.files.filter((file) => file.status !== "reading") };
}

interface UseComposerOptions {
  /** Keeps the draft in memory under this key while the app is open (lib/conversation.ts). */
  persistKey?: string;
  /** Starts from this dialog and draft instead of the remembered one. */
  initial?: Saved | null;
  /** The first draft of a new field (e.g. a document as context in a document's panel). */
  defaults?: Partial<ComposerDraft>;
}

export function useComposer({ persistKey, initial, defaults }: UseComposerOptions = {}): ComposerController {
  const [start] = useState<Saved & { replaced: Saved | null }>(() => {
    const previous = persistKey ? restoreDraft<Saved>(persistKey) : null;
    const remembered = initial ?? previous;
    return {
      ...(remembered
        ? { conversationId: remembered.conversationId, draft: settled(remembered.draft) }
        : { conversationId: newConversationId(), draft: { ...EMPTY_DRAFT, ...defaults } }),
      replaced: initial && previous && previous.conversationId !== initial.conversationId ? previous : null,
    };
  });
  const [draft, setDraft] = useState<ComposerDraft>(start.draft);
  const [conversationId, setConversationId] = useState(start.conversationId);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const uploads = useRef(new Map<string, AbortController>());
  const keySeq = useRef(0);

  // A field that starts from another dialog (a message from the home page) replaces the remembered one: the
  // files of that dialog are deleted — nobody will see them again. Declared before the save below.
  useEffect(() => {
    for (const file of start.replaced?.draft.files ?? []) {
      if (file.status === "ready" && file.attachment) void api.deleteAttachment(file.attachment.id).catch(() => undefined);
    }
  }, [start]);

  useEffect(() => {
    if (persistKey) saveDraft<Saved>(persistKey, { conversationId, draft: settled(draft) });
  }, [persistKey, conversationId, draft]);

  // Leaving the page cancels uploads in flight (their chips are not kept).
  useEffect(() => {
    const running = uploads.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  const patchFile = useCallback((key: string, patch: Partial<ComposerFile>) => {
    setDraft((current) => ({
      ...current,
      files: current.files.map((file) => (file.key === key ? { ...file, ...patch } : file)),
    }));
  }, []);

  const upload = useCallback(
    async (key: string, file: File) => {
      const controller = new AbortController();
      uploads.current.set(key, controller);
      try {
        const result = await api.uploadAttachment(conversationRef.current, file, file.name, { signal: controller.signal });
        const present = draftRef.current.files.some((item) => item.key === key);
        if (!present || controller.signal.aborted) {
          // Removed while it was being read: do not leave it on the server.
          if (result.status === "ready") void api.deleteAttachment(result.id).catch(() => undefined);
          return;
        }
        if (result.status === "ready") {
          patchFile(key, { status: "ready", attachment: result, error: null });
          setAnnouncement(`Файл «${file.name}» прочитан${result.summary ? `: ${result.summary}` : ""}.`);
        } else {
          const reason = ATTACHMENT_ERROR_TEXT[result.error_code ?? "unreadable"];
          patchFile(key, { status: "error", error: reason });
          setAnnouncement(`Файл «${file.name}» не принят: ${reason}.`);
        }
      } catch (error) {
        if (isCancelled(error) || controller.signal.aborted) return;
        const reason = uploadFailure(error);
        patchFile(key, { status: "error", error: reason });
        setAnnouncement(`Файл «${file.name}» не загружен: ${reason}.`);
      } finally {
        if (uploads.current.get(key) === controller) uploads.current.delete(key);
      }
    },
    [patchFile],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      let inDialog = draftRef.current.files.filter((file) => file.status !== "error").length;
      const added: ComposerFile[] = [];
      const toUpload: [string, File][] = [];
      for (const file of files) {
        keySeq.current += 1;
        const key = `file-${keySeq.current}`;
        const rejected = precheckFile(file, inDialog);
        if (rejected) {
          added.push({ key, name: file.name, size: file.size, status: "error", attachment: null, error: ATTACHMENT_ERROR_TEXT[rejected] });
          continue;
        }
        inDialog += 1;
        added.push({ key, name: file.name, size: file.size, status: "reading", attachment: null, error: null });
        toUpload.push([key, file]);
      }
      const next = { ...draftRef.current, files: [...draftRef.current.files, ...added] };
      draftRef.current = next;
      setDraft((current) => ({ ...current, files: [...current.files, ...added] }));
      setAnnouncement(
        added.length === 1
          ? `Файл «${added[0]?.name}» (${formatBytes(added[0]?.size ?? 0)}): ${added[0]?.error ?? "читаю…"}`
          : `Добавлено файлов: ${added.length}.`,
      );
      for (const [key, file] of toUpload) void upload(key, file);
    },
    [upload],
  );

  const removeFile = useCallback((key: string) => {
    const file = draftRef.current.files.find((item) => item.key === key);
    if (!file) return;
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
    if (file.status === "ready" && file.attachment) void api.deleteAttachment(file.attachment.id).catch(() => undefined);
    const next = { ...draftRef.current, files: draftRef.current.files.filter((item) => item.key !== key) };
    draftRef.current = next;
    setDraft((current) => ({ ...current, files: current.files.filter((item) => item.key !== key) }));
    setAnnouncement(`Файл «${file.name}» убран.`);
  }, []);

  const discardAll = useCallback(() => {
    for (const controller of uploads.current.values()) controller.abort();
    uploads.current.clear();
    for (const file of draftRef.current.files) {
      if (file.status === "ready" && file.attachment) void api.deleteAttachment(file.attachment.id).catch(() => undefined);
    }
  }, []);

  const setText = useCallback((text: string) => {
    draftRef.current = { ...draftRef.current, text };
    setDraft((current) => ({ ...current, text }));
  }, []);

  const update = useCallback((patch: Partial<ComposerDraft>) => {
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  return useMemo<ComposerController>(
    () => ({
      draft,
      conversationId,
      inputRef,
      announcement,
      reading: draft.files.some((file) => file.status === "reading"),
      setText,
      setSkill: (skill) => update({ skill }),
      setScope: (scope) => update({ scope }),
      setIncludeDrafts: (includeDrafts) => update({ includeDrafts }),
      setIncludeDeprecated: (includeDeprecated) => update({ includeDeprecated }),
      addFiles,
      removeFile,
      addDocument: (document) => {
        const current = draftRef.current.documents;
        if (current.some((item) => item.id === document.id) || current.length >= MAX_CONTEXT_DOCUMENTS) return false;
        update({ documents: [...current, document] });
        return true;
      },
      removeDocument: (id) => update({ documents: draftRef.current.documents.filter((item) => item.id !== id) }),
      setSelection: (selection) => update({ selection }),
      removeLast: () => {
        const current = draftRef.current;
        if (current.selection) {
          update({ selection: null });
          return true;
        }
        const lastDocument = current.documents[current.documents.length - 1];
        if (lastDocument) {
          update({ documents: current.documents.slice(0, -1) });
          return true;
        }
        const lastFile = current.files[current.files.length - 1];
        if (lastFile) {
          removeFile(lastFile.key);
          return true;
        }
        if (current.skill) {
          update({ skill: null });
          return true;
        }
        return false;
      },
      message: () => {
        const current = draftRef.current;
        return {
          conversationId: conversationRef.current,
          question: current.text.trim(),
          skill: current.skill,
          attachments: current.files.flatMap((file) => (file.status === "ready" && file.attachment ? [file.attachment] : [])),
          documents: current.documents,
          selection: current.selection,
          scope: current.scope,
          includeDrafts: current.includeDrafts,
          includeDeprecated: current.includeDeprecated,
        };
      },
      reset: (options) => {
        if (options?.handedOver) {
          for (const controller of uploads.current.values()) controller.abort();
          uploads.current.clear();
        } else {
          discardAll();
        }
        const keep = draftRef.current;
        const next: ComposerDraft = {
          ...EMPTY_DRAFT,
          ...defaults,
          scope: keep.scope,
          includeDrafts: keep.includeDrafts,
          includeDeprecated: keep.includeDeprecated,
        };
        draftRef.current = next;
        setDraft(next);
        const id = newConversationId();
        conversationRef.current = id;
        setConversationId(id);
        setAnnouncement("");
        return id;
      },
      focus: () => inputRef.current?.focus(),
    }),
    // `defaults` is read at reset time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, conversationId, announcement, setText, update, addFiles, removeFile, discardAll],
  );
}
