import type {
  AiDraftRequest,
  AiDraftResponse,
  AskRequest,
  AskResponse,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: "application/json", "X-SKH-Client": "web" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? controller.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    throw new ApiError(
      0,
      aborted ? "timeout" : "network_error",
      aborted
        ? "Сервер не ответил вовремя. Повторите попытку."
        : "Нет связи с сервером приложения. Проверьте, что backend запущен.",
      null,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const err = (body ?? {}) as { code?: string; message?: string; request_id?: string; details?: object };
    throw new ApiError(
      response.status,
      err.code ?? "http_error",
      err.message ?? `Ошибка сервера (HTTP ${response.status}).`,
      err.request_id ?? response.headers.get("X-Request-ID"),
      err.details ?? {},
    );
  }
  return body as T;
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
  /** A text suggestion only (503 `ai_authoring_unavailable` when AI is off). */
  aiDraft: (payload: AiDraftRequest) =>
    request<AiDraftResponse>("/authoring/ai-draft", { method: "POST", body: json(payload) }),
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
