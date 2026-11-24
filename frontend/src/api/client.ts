import type {
  AiDraftRequest,
  AiDraftResponse,
  AiMode,
  AiProposal,
  AiProposalRequest,
  AskRequest,
  AskResponse,
  AskStreamEvent,
  AssistantAttachment,
  AssistantSkill,
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
  DocumentTree,
  DocumentLinks,
  DocumentTypeInfo,
  DiscoveryFeedbackResponse,
  DiscoveryPurgeResponse,
  DiscoveryStats,
  DiscoveryVerdict,
  DraftCreate,
  GraphDiagnostics,
  GraphLegend,
  GraphPath,
  ImportCreateRequest,
  ImportPreview,
  ImportPreviewRequest,
  IntegrationsResponse,
  LinkDiagnostic,
  LinkSuggestion,
  LoadIssue,
  NewDocumentDraftCreate,
  NewDocumentDraftUpdate,
  ProposalDetail,
  ProposalList,
  ProposalStatus,
  PublicationJobDetail,
  PublicationJobList,
  SearchResponse,
  SearchScope,
  SessionResponse,
  StagingItem,
  Subgraph,
  SuggestResponse,
  SyncStatus,
  TemplateComparison,
  TemplateDetail,
  TemplateSummary,
} from "./types";

const TIMEOUT_MS = 30_000;
/** An AI draft may take minutes with the Claude Code CLI provider (the backend bounds it as well). */
const AI_DRAFT_TIMEOUT_MS = 300_000;
/** Uploading up to 20 MB and extracting its text (the server bounds extraction at 20 s). */
const ATTACHMENT_TIMEOUT_MS = 120_000;
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
  // FormData sets its own multipart Content-Type with the boundary.
  if (init.body !== undefined && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";
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

export interface TemplateCatalogueParams {
  q?: string;
  status?: string;
  type?: string;
  category?: string;
  label?: string;
}

export interface GraphOverviewParams {
  limit?: number;
  /** Comma-separated values (the backend accepts CSV); empty means "all". */
  kind?: string;
  relation?: string;
  status?: string;
  type?: string;
  q?: string;
  deprecated?: boolean;
}

export interface GraphNeighbourParams {
  depth?: 1 | 2;
  direction?: "both" | "out" | "in";
  relation?: string;
  limit?: number;
  cursor?: number;
}

export const api = {
  session: () => request<SessionResponse>("/session"),
  integrations: () => request<IntegrationsResponse>("/integrations/status"),
  documents: (params: DocumentListParams = {}) => request<DocumentPage>(`/documents${query({ ...params })}`),
  document: (id: string) => request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`),
  /** «Документы» v2: sections → groups → documents of the whole visible base, with attention counts. */
  documentTree: () => request<DocumentTree>("/documents/tree"),
  facets: () => request<DocumentFacets>("/knowledge/facets"),
  indexStatus: () => request<SyncStatus>("/index/status"),
  syncIndex: () => request<SyncStatus>("/index/sync", { method: "POST" }),
  issues: () => request<LoadIssue[]>("/knowledge/issues"),
  /** GET /api/search: ranked passages (title, ID, section, status); the composer's «@» uses it. */
  search: (params: { q: string; source?: SearchScope[]; limit?: number }, options: { signal?: AbortSignal } = {}) =>
    request<SearchResponse>(
      `/search${query({ q: params.q, source: params.source?.join(","), limit: params.limit })}`,
      { signal: options.signal },
    ),
  ask: (payload: AskRequest) => request<AskResponse>("/assistant/ask", { method: "POST", body: json(payload) }),
  /** Streaming variant of `ask` (NDJSON); works with every provider — mock sends only status + final. */
  askStream,

  // --- UI v2: assistant skills and conversation attachments ---
  /** The skill registry with availability in the current AI mode (never hard-code the list). */
  assistantSkills: () => request<AssistantSkill[]>("/assistant/skills"),
  /**
   * Attaches a file to one conversation. Resolves with `status: "ready"` or `status: "error"` + `error_code`
   * (unsupported_type, too_large, limit_reached, unreadable); throws ApiError for 422/503.
   */
  uploadAttachment: (conversationId: string, file: Blob, name?: string, options: { signal?: AbortSignal } = {}) => {
    const form = new FormData();
    form.append("conversation_id", conversationId); // before the file: read even when the file is too large
    form.append("file", file, name ?? (file instanceof File ? file.name : "file"));
    return request<AssistantAttachment>("/assistant/attachments", {
      method: "POST",
      body: form,
      timeoutMs: ATTACHMENT_TIMEOUT_MS,
      signal: options.signal,
    });
  },
  /** Idempotent: also succeeds for an attachment that already expired or was never stored. */
  deleteAttachment: (id: string) =>
    request<null>(`/assistant/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  corporatePage: (id: string) => request<CorporatePage>(`/corporate/pages/${encodeURIComponent(id)}`),
  /** `exclude_own`: not the caller's own proposals (the «Ревью» list); `open_only`: only open ones (API v0.4). */
  drafts: (params: { status?: ProposalStatus; document_id?: string; exclude_own?: boolean; open_only?: boolean } = {}) =>
    request<ProposalList>(
      `/drafts${query({
        status: params.status,
        document_id: params.document_id,
        exclude_own: params.exclude_own ? "true" : undefined,
        open_only: params.open_only ? "true" : undefined,
      })}`,
    ),
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
  /** Templates for new documents; `includeHidden` also returns unlisted ones (to reopen their drafts). */
  templates: (includeHidden = false) =>
    request<DocumentTemplateInfo[]>(`/authoring/templates${includeHidden ? "?include_hidden=true" : ""}`),
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

  // --- knowledge graph (M5.6, read-only and bounded by the server) ---
  graphLegend: () => request<GraphLegend>("/graph/legend"),
  graphOverview: (params: GraphOverviewParams = {}) =>
    request<Subgraph>(
      `/graph/overview${query({ ...params, deprecated: params.deprecated === undefined ? undefined : String(params.deprecated) })}`,
    ),
  /** 404 `graph_node_not_found` for an unknown or not visible node. */
  graphNeighbours: (nodeId: string, params: GraphNeighbourParams = {}) =>
    request<Subgraph>(`/graph/nodes/${encodeURIComponent(nodeId)}/neighbors${query({ ...params })}`),
  graphPath: (source: string, target: string, maxDepth?: number) =>
    request<GraphPath>(`/graph/path${query({ source, target, max_depth: maxDepth })}`),
  /** Evidence graph of one answer; 404 `trace_not_found` once the trace expired or was erased. */
  graphQuery: (traceId: string) => request<Subgraph>(`/graph/query/${encodeURIComponent(traceId)}`),
  graphDiagnostics: () => request<GraphDiagnostics>("/graph/diagnostics"),

  // --- discovery memory: optional relevance feedback, erase, operator stats ---
  discoveryFeedback: (payload: { trace_id: string; source_id: string; verdict: DiscoveryVerdict }) =>
    request<DiscoveryFeedbackResponse>("/discovery/feedback", { method: "POST", body: json(payload) }),
  /** A DRAFT of a new curated document quoting the external page (never an import, never approved). */
  discoveryPropose: (payload: { trace_id: string; source_id: string }) =>
    request<ProposalDetail>("/discovery/propose", { method: "POST", body: json(payload) }),
  discoveryPurge: () => request<DiscoveryPurgeResponse>("/discovery", { method: "DELETE" }),
  discoveryStats: () => request<DiscoveryStats>("/discovery/stats"),

  // --- M5.6.3: Template Hub (the same versioned registry the AI reads) ---
  templateCatalogue: (params: TemplateCatalogueParams = {}) =>
    request<TemplateSummary[]>(`/templates${query({ ...params })}`),
  /** The current version; 404 `template_not_found`. */
  templateDetail: (id: string) => request<TemplateDetail>(`/templates/${encodeURIComponent(id)}`),
  /** An exact version (also older ones that drafts are pinned to); 404 `template_version_not_found`. */
  templateVersion: (id: string, version: number) =>
    request<TemplateDetail>(`/templates/${encodeURIComponent(id)}/versions/${version}`),
  templateCompare: (id: string, from: number, to: number) =>
    request<TemplateComparison>(`/templates/${encodeURIComponent(id)}/compare${query({ from, to })}`),

  // --- M5.6.3: links (WikiLinks, backlinks, `[[` autocomplete) ---
  documentLinks: (id: string) => request<DocumentLinks>(`/documents/${encodeURIComponent(id)}/links`),
  /** `[[` autocomplete over visible IDs, titles and aliases; never picks a target by itself. */
  linkSuggest: (q: string, limit = 8, options: { signal?: AbortSignal } = {}) =>
    request<LinkSuggestion[]>(`/links/suggest${query({ q, limit })}`, { signal: options.signal }),
  linkDiagnostics: () => request<LinkDiagnostic[]>("/links/diagnostics"),

  // --- M5.6.3: metadata without YAML and import ---
  documentTypes: () => request<DocumentTypeInfo[]>("/document-types"),
  /** Files of the knowledge root without valid YAML: not indexed, not cited. */
  importStaging: () => request<StagingItem[]>("/documents/import/staging"),
  /** What an import would create; writes nothing. */
  importPreview: (payload: ImportPreviewRequest) =>
    request<ImportPreview>("/documents/import/preview", { method: "POST", body: json(payload) }),
  /** Creates a DRAFT (origin `import`); approved only through the usual review and merge. */
  importDocument: (payload: ImportCreateRequest) =>
    request<ProposalDetail>("/documents/import", { method: "POST", body: json(payload) }),

  // --- M5.6.3: AI proposals (evidence + explicit Accept/Reject; nothing is applied without Accept) ---
  /** Long timeout: a Claude Code CLI provider may take minutes; `signal` cancels. */
  aiPropose: (payload: AiProposalRequest, options: { signal?: AbortSignal } = {}) =>
    request<AiProposal>("/ai/proposals", {
      method: "POST",
      body: json(payload),
      timeoutMs: AI_DRAFT_TIMEOUT_MS,
      signal: options.signal,
    }),
  aiProposal: (id: string) => request<AiProposal>(`/ai/proposals/${encodeURIComponent(id)}`),
  aiProposals: (params: { draft_id?: string; document_id?: string } = {}) =>
    request<AiProposal[]>(`/ai/proposals${query({ ...params })}`),
  /** Applies the chosen items to a draft; 409 `ai_proposal_stale` (base changed → invalidated) or `ai_proposal_closed`. */
  aiAccept: (id: string, itemIds: string[], reason?: string) =>
    request<AiProposal>(`/ai/proposals/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: json({ item_ids: itemIds, ...(reason ? { reason } : {}) }),
    }),
  aiReject: (id: string) => request<AiProposal>(`/ai/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" }),
};
