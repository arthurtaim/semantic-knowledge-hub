import type {
  AiDraftRequest,
  AiDraftResponse,
  AiMode,
  AskRequest,
  AskResponse,
  AskStreamEvent,
  AuthoringCheckRequest,
  AuthoringCheckResponse,
  ChangeDraftUpdate,
  CorporatePage,
  DocumentDetail,
  DocumentFacets,
  DocumentPage,
  DocumentPublicationStatus,
  DocumentSort,
  DocumentTemplateInfo,
  DraftCreate,
  IntegrationsResponse,
  LoadIssue,
  NewDocumentDraftCreate,
  NewDocumentDraftUpdate,
  ProposalDetail,
  ProposalList,
  ProposalStatus,
  PublicationJobDetail,
  PublicationJobList,
  SessionResponse,
  SuggestResponse,
  SyncStatus,
} from "./types";

const TIMEOUT_MS = 30_000;
/** An AI draft may take minutes with the Claude Code CLI provider (the backend bounds it as well). */
const AI_DRAFT_TIMEOUT_MS = 300_000;
/** The answer stream has no total timeout: it is aborted only when no data arrives for this long. */
const STREAM_IDLE_TIMEOUT_MS = 330_000;
/** A single NDJSON line larger than this is treated as a broken stream (bounded memory). */
const STREAM_MAX_LINE_CHARS = 2_000_000;

/** Structured error from the API: `{code, message, request_id}` (docs/API_CONTRACTS.md §5). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, requestId: string | null, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/** The user cancelled the request (an aborted caller signal). */
export function cancelledError(): ApiError {
  return new ApiError(0, "cancelled", "Запрос отменён.", null);
}

export function isCancelled(error: unknown): boolean {
  return error instanceof ApiError && error.code === "cancelled";
}

interface RequestOptions extends Omit<RequestInit, "signal" | "headers"> {
  headers?: Record<string, string>;
  /** Aborts the request when the whole response has not arrived in time (default 30 s). */
  timeoutMs?: number;
  /** Caller cancellation (e.g. an «Отменить» button): rejects with ApiError `cancelled`. */
  signal?: AbortSignal;
}

/**
 * An internal AbortController that fires on the caller's signal or on a timer.
 * `timedOut` tells a timeout apart from a user cancellation.
 */
function linkedAbort(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const state = { timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  arm();
  return {
    signal: controller.signal,
    state,
    /** Restarts the timer (idle timeout between stream chunks). */
    arm,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpError(response: Response, body: unknown): ApiError {
  const err = (body ?? {}) as { code?: string; message?: string; request_id?: string; details?: object };
  return new ApiError(
    response.status,
    err.code ?? "http_error",
    err.message ?? `Ошибка сервера (HTTP ${response.status}).`,
    err.request_id ?? response.headers.get("X-Request-ID"),
    err.details ?? {},
  );
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = TIMEOUT_MS, signal, headers: extraHeaders, ...init } = options;
  if (signal?.aborted) throw cancelledError();
  const abort = linkedAbort(signal, timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json", "X-SKH-Client": "web" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  let text: string;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { ...headers, ...extraHeaders },
      signal: abort.signal,
      credentials: "same-origin",
    });
    text = await response.text();
  } catch {
    if (signal?.aborted) throw cancelledError();
    throw new ApiError(
      0,
      abort.state.timedOut ? "timeout" : "network_error",
      abort.state.timedOut
        ? "Сервер не ответил вовремя. Повторите попытку."
        : "Нет связи с сервером приложения. Проверьте, что backend запущен.",
      null,
    );
  } finally {
    abort.dispose();
  }
  const body = parseJson(text);
  if (!response.ok) throw httpError(response, body);
  return body as T;
}

export interface AskStreamOptions {
  /** Aborting it cancels the generation on the server; the promise rejects with ApiError `cancelled`. */
  signal?: AbortSignal;
  /** Called for every event in order, including the terminal `final`/`error` event. */
  onEvent?: (event: AskStreamEvent) => void;
  /** Abort when no data arrives for this long (default 330 s). */
  idleTimeoutMs?: number;
}

function invalidStream(requestId: string | null): ApiError {
  return new ApiError(502, "invalid_stream", "Сервер прислал повреждённый ответ. Повторите запрос.", requestId);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses one NDJSON line; unknown event types are skipped (null) for forward compatibility. */
function parseStreamEvent(line: string, requestId: string | null): AskStreamEvent | null {
  const value = parseJson(line);
  if (!isRecord(value) || typeof value.type !== "string") throw invalidStream(requestId);
  switch (value.type) {
    case "status":
      if (value.stage !== "retrieving" && value.stage !== "generating" && value.stage !== "validating") return null;
      return {
        type: "status",
        stage: value.stage,
        passages: typeof value.passages === "number" ? value.passages : undefined,
        provider: typeof value.provider === "string" ? (value.provider as AiMode) : undefined,
      };
    case "delta":
      if (typeof value.text !== "string") throw invalidStream(requestId);
      return { type: "delta", text: value.text };
    case "final": {
      const response = value.response;
      if (!isRecord(response) || typeof response.answer !== "string" || !Array.isArray(response.citations)) {
        throw invalidStream(requestId);
      }
      return { type: "final", response: response as unknown as AskResponse };
    }
    case "error":
      return {
        type: "error",
        code: typeof value.code === "string" ? value.code : "ai_upstream_error",
        message: typeof value.message === "string" ? value.message : "Не удалось получить ответ ассистента.",
        status: typeof value.status === "number" ? value.status : 502,
      };
    default:
      return null;
  }
}

/**
 * POST /api/assistant/ask/stream: reads NDJSON events (status → delta… → final | error) and resolves with the
 * validated AskResponse. Throws ApiError for an HTTP error before the stream, an `error` event, a broken or
 * incomplete stream, a network failure, an idle timeout, or a cancellation (`cancelled`).
 */
async function askStream(payload: AskRequest, options: AskStreamOptions = {}): Promise<AskResponse> {
  const { signal, onEvent, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS } = options;
  if (signal?.aborted) throw cancelledError();
  const abort = linkedAbort(signal, idleTimeoutMs);
  let requestId: string | null = null;
  const failure = (error: unknown, connecting: boolean): ApiError => {
    if (signal?.aborted) return cancelledError();
    if (error instanceof ApiError) return error;
    if (abort.state.timedOut) {
      return new ApiError(0, "timeout", "Сервер слишком долго не присылал данные — ответ прерван. Повторите запрос.", requestId);
    }
    return new ApiError(
      0,
      "network_error",
      connecting
        ? "Нет связи с сервером приложения. Проверьте, что backend запущен."
        : "Соединение с сервером прервалось до завершения ответа. Повторите запрос.",
      requestId,
    );
  };
  try {
    let response: Response;
    try {
      response = await fetch("/api/assistant/ask/stream", {
        method: "POST",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json", "X-SKH-Client": "web" },
        body: json(payload),
        signal: abort.signal,
        credentials: "same-origin",
      });
      requestId = response.headers.get("X-Request-ID");
      if (!response.ok) throw httpError(response, parseJson(await response.text()));
    } catch (error) {
      throw failure(error, true);
    }
    if (!response.body) throw invalidStream(requestId);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: AskResponse | null = null;
    /** Handles one line; returns the validated answer of the terminal `final` event, throws on `error`. */
    const handle = (line: string): AskResponse | null => {
      if (!line.trim()) return null;
      const event = parseStreamEvent(line, requestId);
      if (!event) return null;
      onEvent?.(event);
      if (event.type === "error") throw new ApiError(event.status, event.code, event.message, requestId);
      return event.type === "final" ? event.response : null;
    };
    try {
      while (final === null) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          final = handle(buffer);
          break;
        }
        abort.arm();
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && final === null) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          final = handle(line);
          newline = buffer.indexOf("\n");
        }
        if (buffer.length > STREAM_MAX_LINE_CHARS) throw invalidStream(requestId);
      }
    } catch (error) {
      throw failure(error, false);
    } finally {
      // Releases the connection after a terminal event or a failure; a no-op on a finished stream.
      reader.cancel().catch(() => undefined);
    }
    if (final === null) {
      throw new ApiError(0, "stream_incomplete", "Ответ сервера оборвался до завершения. Повторите запрос.", requestId);
    }
    return final;
  } finally {
    abort.dispose();
  }
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const json = (value: unknown): string => JSON.stringify(value);

export interface DocumentListParams {
  query?: string;
  type?: string;
  status?: string;
  owner?: string;
  source?: string;
  tag?: string;
  sort?: DocumentSort;
  page?: number;
  size?: number;
}

export const api = {
  session: () => request<SessionResponse>("/session"),
  integrations: () => request<IntegrationsResponse>("/integrations/status"),
  documents: (params: DocumentListParams = {}) => request<DocumentPage>(`/documents${query({ ...params })}`),
  document: (id: string) => request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`),
  facets: () => request<DocumentFacets>("/knowledge/facets"),
  indexStatus: () => request<SyncStatus>("/index/status"),
  syncIndex: () => request<SyncStatus>("/index/sync", { method: "POST" }),
  issues: () => request<LoadIssue[]>("/knowledge/issues"),
  ask: (payload: AskRequest) => request<AskResponse>("/assistant/ask", { method: "POST", body: json(payload) }),
  /** Streaming variant of `ask` (NDJSON); works with every provider — mock sends only status + final. */
  askStream,
  corporatePage: (id: string) => request<CorporatePage>(`/corporate/pages/${encodeURIComponent(id)}`),
  drafts: (params: { status?: ProposalStatus; document_id?: string } = {}) =>
    request<ProposalList>(`/drafts${query({ ...params })}`),
  draft: (id: string) => request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}`),
  createDraft: (payload: DraftCreate) => request<ProposalDetail>("/drafts", { method: "POST", body: json(payload) }),
  rejectDraft: (id: string, comment?: string) =>
    request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: json({ comment: comment || null }),
    }),
  markReady: (id: string) => request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}/mark-ready`, { method: "POST" }),
  /** Creates the GitLab branch, commit and MR. Idempotent and retry-safe on the server. */
  submitDraft: (id: string) => request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}/submit`, { method: "POST" }),
  /** Asks GitLab for the MR state; only GitLab can move a proposal to "merged". */
  refreshDraftStatus: (id: string) =>
    request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}/refresh-status`, { method: "POST" }),
  suggestDraft: (payload: { document_id: string; base_revision: string; instruction: string }) =>
    request<SuggestResponse>("/drafts/suggest", { method: "POST", body: json(payload) }),
  /** Saves an editable draft; `expected_version` guards against lost updates (409 `draft_modified`). */
  saveDraft: (id: string, payload: NewDocumentDraftUpdate | ChangeDraftUpdate) =>
    request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}`, { method: "PUT", body: json(payload) }),
  deleteDraft: (id: string) => request<null>(`/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // --- authoring of new documents ---
  templates: () => request<DocumentTemplateInfo[]>("/authoring/templates"),
  /** Stateless validation + safe preview of a new document; stores nothing. */
  checkNewDocument: (payload: AuthoringCheckRequest) =>
    request<AuthoringCheckResponse>("/authoring/check", { method: "POST", body: json(payload) }),
  /**
   * A text suggestion only (503 `ai_authoring_unavailable` when AI is off). Long timeout: a Claude Code CLI run
   * may take minutes; `signal` lets the user cancel (ApiError `cancelled`).
   */
  aiDraft: (payload: AiDraftRequest, options: { signal?: AbortSignal } = {}) =>
    request<AiDraftResponse>("/authoring/ai-draft", {
      method: "POST",
      body: json(payload),
      timeoutMs: AI_DRAFT_TIMEOUT_MS,
      signal: options.signal,
    }),
  /** Persists a draft of a NEW document (proposal with operation=create). 409 when the ID/path is taken. */
  createNewDocumentDraft: (payload: NewDocumentDraftCreate) =>
    request<ProposalDetail>("/authoring/drafts", { method: "POST", body: json(payload) }),

  // --- publication to Confluence (M5) ---
  documentPublication: (id: string) =>
    request<DocumentPublicationStatus>(`/documents/${encodeURIComponent(id)}/publication`),
  /** Creates or reuses the job for the current GitLab revision and runs a dry-run (reads only). */
  preparePublication: (id: string) =>
    request<PublicationJobDetail>(`/documents/${encodeURIComponent(id)}/publication/prepare`, { method: "POST" }),
  publicationJobs: (documentId?: string) =>
    request<PublicationJobList>(`/publications/jobs${query({ document_id: documentId })}`),
  publicationJob: (id: string) => request<PublicationJobDetail>(`/publications/jobs/${encodeURIComponent(id)}`),
  /** Re-checks the preview; read requests only. */
  dryRunPublication: (id: string) =>
    request<PublicationJobDetail>(`/publications/jobs/${encodeURIComponent(id)}/dry-run`, { method: "POST" }),
  /** Writes exactly the previewed change (re-checked first; 409 `plan_changed` on a stale preview). */
  publishPublication: (id: string) =>
    request<PublicationJobDetail>(`/publications/jobs/${encodeURIComponent(id)}/publish`, { method: "POST" }),
  /** Inspects Confluence after an unconfirmed/failed write, then refreshes the preview. Never writes. */
  reconcilePublication: (id: string) =>
    request<PublicationJobDetail>(`/publications/jobs/${encodeURIComponent(id)}/reconcile`, { method: "POST" }),
  /** Human decision: take the manually edited Confluence page as the new baseline. Nothing is written. */
  acknowledgeManualEdit: (id: string) =>
    request<PublicationJobDetail>(`/publications/jobs/${encodeURIComponent(id)}/acknowledge-manual-edit`, {
      method: "POST",
    }),
  /** Recovery after the published page was deleted: forget the mapping (page verified absent), new dry-run. */
  releaseMissingPage: (id: string) =>
    request<PublicationJobDetail>(`/publications/jobs/${encodeURIComponent(id)}/release-missing-page`, {
      method: "POST",
    }),
};
