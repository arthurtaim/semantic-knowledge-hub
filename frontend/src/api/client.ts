import type {
  AskRequest,
  AskResponse,
  CorporatePage,
  DocumentDetail,
  DocumentFacets,
  DocumentPage,
  DraftCreate,
  IntegrationsResponse,
  LoadIssue,
  ProposalDetail,
  ProposalList,
  ProposalStatus,
  SessionResponse,
  SuggestResponse,
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
  page?: number;
  size?: number;
}

export const api = {
  session: () => request<SessionResponse>("/session"),
  integrations: () => request<IntegrationsResponse>("/integrations/status"),
  documents: (params: DocumentListParams = {}) => request<DocumentPage>(`/documents${query({ ...params })}`),
  document: (id: string) => request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`),
  facets: () => request<DocumentFacets>("/knowledge/facets"),
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
  openMergeRequest: (id: string) =>
    request<ProposalDetail>(`/drafts/${encodeURIComponent(id)}/open-mr`, { method: "POST" }),
  suggestDraft: (payload: { document_id: string; base_revision: string; instruction: string }) =>
    request<SuggestResponse>("/drafts/suggest", { method: "POST", body: json(payload) }),
};
