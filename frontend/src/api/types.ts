// Mirrors backend Pydantic models (backend/app/domain/models.py, proposals.py).

export type DocType =
  | "overview"
  | "architecture"
  | "domain"
  | "integration"
  | "process"
  | "decision"
  | "standard"
  | "glossary";
export type DocStatus = "draft" | "in_review" | "approved" | "deprecated";
export type SourceType = "local" | "gitlab" | "confluence";
export type IntegrationState = "connected" | "disabled" | "mock" | "error";
export type Confidence = "supported" | "partial" | "insufficient_evidence";
export type SearchScope = "team" | "corporate";
export type ReviewState = "ok" | "stale" | "never_reviewed" | "not_required";
export type SyncState = "fresh" | "stale" | "error" | "never_synced";
/** "stale": the last sync could not refresh this document; it is shown with its last known revision. */
export type IndexState = "current" | "stale";
export type DocumentSort = "relevance" | "title" | "updated" | "status";
/**
 * Local lifecycle of a proposal. Deliberately separate from the GitLab MR state:
 * `ready_for_review` does not mean an MR exists, `submitted_to_gitlab` does not mean approval.
 */
export type ProposalStatus =
  | "draft"
  | "ready_for_review"
  | "submitting"
  | "submitted_to_gitlab"
  | "merged"
  | "rejected"
  | "conflict"
  | "submission_failed";
export type MergeRequestState = "opened" | "merged" | "closed" | "locked" | "unknown";
export type SourceDocumentState = "unchanged" | "changed_since_base" | "updated_by_this_proposal" | "missing";

export interface HighlightSegment {
  text: string;
  highlight: boolean;
}

export interface DocumentSummary {
  id: string;
  title: string;
  type: DocType;
  status: DocStatus;
  owner: string;
  source: SourceType;
  source_uri: string;
  revision: string;
  tags: string[];
  excerpt: string;
  is_demo: boolean;
  reviewed_at: string | null;
  updated_at: string | null;
  review_state: ReviewState;
  owner_missing: boolean;
  /** Link to this exact revision in the source system (host validated by the backend); null for local. */
  web_url: string | null;
  index_state: IndexState;
  highlights?: HighlightSegment[] | null;
}

export interface Section {
  heading: string;
  anchor: string;
  level: number;
  text: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  field: string | null;
}

export interface RelatedLink {
  id: string;
  title: string | null;
  status: DocStatus | null;
  resolved: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  summary: string | null;
  related: RelatedLink[];
  source_refs: string[];
  content_markdown: string;
  content_html: string;
  raw: string;
  path: string;
  sections: Section[];
  warnings: ValidationIssue[];
  extra_metadata: Record<string, string>;
}

export interface DocumentPage {
  items: DocumentSummary[];
  total: number;
  page: number;
  size: number;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface DocumentFacets {
  types: FacetCount[];
  statuses: FacetCount[];
  owners: FacetCount[];
  sources: FacetCount[];
  tags: FacetCount[];
  total: number;
}

export interface LoadIssue {
  path: string;
  code: string;
  message: string;
  document_id: string | null;
}

export interface ScopeStatus {
  scope: SearchScope;
  state: IntegrationState;
  message: string;
}

export interface Citation {
  ref: number;
  source_type: SourceType;
  document_id: string;
  title: string;
  source_uri: string;
  revision: string;
  status: DocStatus | null;
  section: string | null;
  section_anchor: string | null;
  excerpt: string;
  retrieved_at: string;
  is_demo: boolean;
  app_path: string | null;
}

export interface ExcludedSource {
  document_id: string;
  title: string;
  status: DocStatus;
  reason: string;
}

export interface AskRequest {
  question: string;
  sources: SearchScope[];
  include_drafts: boolean;
  include_deprecated: boolean;
}

export interface AskResponse {
  answer: string;
  mode: "mock" | "internal_api" | "disabled";
  confidence: Confidence;
  citations: Citation[];
  warnings: string[];
  excluded_sources: ExcludedSource[];
  scopes: ScopeStatus[];
  unmatched_terms: string[];
}

export interface IntegrationStatus {
  name: string;
  title: string;
  kind: string;
  state: IntegrationState;
  capabilities: string[];
  human_readable_message: string;
  details: Record<string, string>;
}

export interface IntegrationsResponse {
  items: IntegrationStatus[];
  checked_at: string;
}

/** State of the knowledge source synchronisation and of the derived search index. */
export interface SyncStatus {
  source: SourceType;
  state: SyncState;
  message: string;
  documents: number;
  issues: number;
  failed_paths: string[];
  last_attempt_at: string | null;
  last_success_at: string | null;
  source_version: string | null;
  branch: string | null;
  head_commit: string | null;
  indexed_documents: number;
  indexed_version: string | null;
  indexed_at: string | null;
}

export interface SessionResponse {
  user: { user_id: string; display_name: string; roles: string[]; is_demo: boolean };
  auth_mode: string;
  demo_content: boolean;
  knowledge_backend: string; // "local" | "gitlab"
  features: {
    ai_mode: "mock" | "internal_api" | "disabled";
    ai_edit_suggestions: boolean;
    corporate_search: IntegrationState;
    gitlab_proposals: boolean;
    confluence_publish: boolean;
  };
}

export interface DiffLine {
  kind: "context" | "add" | "remove" | "hunk";
  old_no: number | null;
  new_no: number | null;
  text: string;
}

export interface DiffResult {
  unified: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  changed: boolean;
}

export interface ProposalEvent {
  at: string;
  actor: string;
  action: string;
  status: ProposalStatus | null;
}

export interface ProposalSummary {
  id: string;
  document_id: string;
  document_title: string;
  source: SourceType;
  status: ProposalStatus;
  reason: string;
  origin: "manual" | "ai_suggestion";
  author: string;
  created_at: string;
  updated_at: string;
  base_revision: string;
  additions: number;
  deletions: number;
  error_count: number;
  warning_count: number;
  merge_request_url: string | null;
  merge_request_state: MergeRequestState | null;
}

export interface PublicationState {
  state: "local_only" | "disabled" | "submitted";
  message: string;
  external_url: string | null;
}

/** What GitLab reported about the proposal's MR (never inferred locally). */
export interface MergeRequestInfo {
  iid: string | null;
  url: string | null;
  state: MergeRequestState | null;
  source_branch: string | null;
  target_branch: string | null;
  checked_at: string | null;
}

export interface SubmissionInfo {
  attempts: number;
  last_attempt_at: string | null;
  error_code: string | null;
  error_message: string | null;
  /** GitLab may have applied a write whose answer was lost; the next attempt inspects GitLab first. */
  uncertain: boolean;
}

export interface ProposalDetail extends ProposalSummary {
  document_path: string;
  current_revision: string | null;
  is_stale: boolean;
  base_content: string;
  proposed_content: string;
  validation: ValidationIssue[];
  diff: DiffResult;
  history: ProposalEvent[];
  review_comment: string | null;
  can_mark_ready: boolean;
  can_reject: boolean;
  can_submit: boolean;
  can_refresh_status: boolean;
  publication: PublicationState;
  source_document_state: SourceDocumentState;
  branch_name: string | null;
  merge_request: MergeRequestInfo | null;
  submission: SubmissionInfo;
}

export interface ProposalList {
  items: ProposalSummary[];
  total: number;
}

export interface DraftCreate {
  document_id: string;
  base_revision: string;
  proposed_content: string;
  reason: string;
  origin?: "manual" | "ai_suggestion";
}

export interface SuggestResponse {
  document_id: string;
  base_revision: string;
  proposed_content: string;
  mode: string;
  warnings: string[];
}

export interface CorporatePage {
  page_id: string;
  space: string;
  title: string;
  body: string;
  source_uri: string;
  version: string;
  updated_at: string | null;
  is_mock: boolean;
}
