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
/**
 * The AI provider behind assistant answers and AI drafts. `claude_cli` is EXPERIMENTAL (Claude Code CLI through an
 * isolated worker, personal test only); its answers pass the same citation validation as every other provider.
 */
export type AiMode = "mock" | "internal_api" | "claude_cli" | "disabled";
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
/**
 * `new_document`: a `create` proposal whose document is not in the knowledge base yet (expected before merge);
 * `id_taken`: a document with the proposed ID/path appeared in the knowledge base before this proposal merged;
 * `merged_pending_sync`: GitLab confirmed the merge, the knowledge base has not been re-synced yet
 * (`merged_revision` is null; "refresh status" retries the sync).
 */
export type SourceDocumentState =
  | "unchanged"
  | "changed_since_base"
  | "updated_by_this_proposal"
  | "missing"
  | "new_document"
  | "id_taken"
  | "merged_pending_sync";
/** `create`: a new file in the knowledge base; `update`: a change of an existing document. */
export type ProposalOperation = "create" | "update";
export type ProposalOrigin = "manual" | "ai_suggestion";
/** Statuses a NEW document may have; `deprecated` is invalid for a new document. */
export type NewDocumentStatus = Exclude<DocStatus, "deprecated">;

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

/** An earlier turn of the same conversation (context for the model only — never evidence, never stored). */
export interface ConversationTurn {
  /** 1..2000 characters. */
  question: string;
  /** The validated answer of that turn, at most 4000 characters. */
  answer: string;
}

export interface AskRequest {
  question: string;
  sources: SearchScope[];
  include_drafts: boolean;
  include_deprecated: boolean;
  /** Earlier completed turns, oldest first, at most 6. */
  history?: ConversationTurn[];
}

export interface AskResponse {
  answer: string;
  mode: AiMode;
  confidence: Confidence;
  citations: Citation[];
  warnings: string[];
  excluded_sources: ExcludedSource[];
  scopes: ScopeStatus[];
  unmatched_terms: string[];
}

// --- POST /api/assistant/ask/stream: NDJSON events, one JSON object per line ---

export type AskStreamStage = "retrieving" | "generating" | "validating";

/** `generating` carries the number of retrieved passages and the provider; absent when nothing was found. */
export interface AskStreamStatusEvent {
  type: "status";
  stage: AskStreamStage;
  passages?: number;
  provider?: AiMode;
}

/** PRELIMINARY model text: NOT validated, may contain raw markers like [C1]. Only streaming providers send it. */
export interface AskStreamDeltaEvent {
  type: "delta";
  text: string;
}

/** Terminal event: the validated answer, the same shape as the POST /api/assistant/ask response. */
export interface AskStreamFinalEvent {
  type: "final";
  response: AskResponse;
}

/** Terminal event: the generation failed; `message` is a safe Russian text, `status` the HTTP-equivalent code. */
export interface AskStreamErrorEvent {
  type: "error";
  code: string;
  message: string;
  status: number;
}

export type AskStreamEvent = AskStreamStatusEvent | AskStreamDeltaEvent | AskStreamFinalEvent | AskStreamErrorEvent;

/**
 * Where an integration points: `none` not configured · `local` built into this app (fixtures, demo) ·
 * `mock` a declared local test double · `real` a real server (NOT live-validated by this application).
 */
export type IntegrationTarget = "none" | "local" | "mock" | "real";
export type IntegrationAccess = "none" | "read" | "write" | "read_write";

export interface IntegrationStatus {
  name: string;
  title: string;
  kind: string;
  state: IntegrationState;
  capabilities: string[];
  human_readable_message: string;
  details: Record<string, string>;
  target: IntegrationTarget;
  access: IntegrationAccess;
  checked_at: string | null;
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
    ai_mode: AiMode;
    ai_edit_suggestions: boolean;
    /** AI-assisted authoring of new documents (POST /api/authoring/ai-draft) is available. */
    ai_authoring: boolean;
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
  operation: ProposalOperation;
  document_id: string;
  document_title: string;
  source: SourceType;
  status: ProposalStatus;
  reason: string;
  origin: ProposalOrigin;
  author: string;
  created_at: string;
  updated_at: string;
  /** Empty for `create` proposals: a new file has no base revision. */
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
  template_id: string | null;
  /** Optimistic-locking version for PUT /api/drafts/{id} (`expected_version`). */
  edit_version: number;
  can_edit: boolean;
  can_delete: boolean;
  /** Form view of a `create` proposal (frontmatter fields + Markdown body); null for updates. */
  new_document: NewDocumentView | null;
  /** Revision of the document in the knowledge base after the confirmed merge and sync. */
  merged_revision: string | null;
  synced_at: string | null;
}

export interface NewDocumentView {
  metadata: Record<string, unknown>;
  body: string;
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
  origin?: ProposalOrigin;
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

// --- authoring of new documents (backend/app/domain/proposals.py, api/authoring.py) ---

export interface DocumentTemplateInfo {
  id: string;
  title: string;
  description: string;
  doc_type: DocType;
  id_prefix: string;
  default_tags: string[];
  sections: string[];
  /** Markdown body skeleton WITHOUT the `# Title` heading. */
  skeleton: string;
  suggested_id: string;
  suggested_path: string;
}

export interface NewDocumentMetadata {
  id: string;
  title: string;
  status: NewDocumentStatus;
  owner: string;
  tags: string[];
  related_ids: string[];
  source_refs: string[];
  summary: string | null;
}

export interface AuthoringCheckRequest {
  template_id: string;
  metadata: NewDocumentMetadata;
  body: string;
  path?: string | null;
  origin: ProposalOrigin;
  /** The draft being edited, so that it does not collide with itself. */
  exclude_proposal_id?: string | null;
}

export interface AuthoringCheckResponse {
  /** The full Markdown file that would be proposed (generated YAML frontmatter + body). */
  content: string;
  path: string;
  validation: ValidationIssue[];
  /** Sanitized HTML; render only through <SafeHtml>. */
  preview_html: string;
  id_available: boolean;
  path_available: boolean;
  error_count: number;
  warning_count: number;
}

export interface AiDraftRequest {
  template_id: string;
  title: string;
  request: string;
  related_ids: string[];
}

export interface AuthoringReference {
  document_id: string;
  title: string;
  revision: string;
  status: DocStatus;
  source: SourceType;
  is_demo: boolean;
}

export interface AuthoringCitation {
  document_id: string;
  title: string;
  revision: string;
  status: DocStatus;
  section: string | null;
  quote: string;
}

/** A text suggestion only: not stored, never a proposal by itself. */
export interface AiDraftResponse {
  mode: AiMode;
  /** Markdown body including the `# title` heading. */
  body: string;
  references: AuthoringReference[];
  citations: AuthoringCitation[];
  unverified_claims: string[];
  warnings: string[];
  insufficient_data: boolean;
  suggested_related_ids: string[];
  access_scope: string;
}

export interface NewDocumentDraftCreate {
  template_id: string;
  metadata: NewDocumentMetadata;
  body: string;
  path?: string | null;
  reason: string;
  origin: ProposalOrigin;
}

/** PUT /api/drafts/{id} for a `create` draft. */
export interface NewDocumentDraftUpdate {
  expected_version: number;
  reason?: string;
  origin?: ProposalOrigin;
  metadata: NewDocumentMetadata;
  body: string;
  path?: string | null;
}

/** PUT /api/drafts/{id} for an `update` draft. */
export interface ChangeDraftUpdate {
  expected_version: number;
  reason?: string;
  origin?: ProposalOrigin;
  proposed_content: string;
}

// --- M5: publication of merged GitLab documents to Confluence (backend/app/domain/publications.py) ---

export type PublicationJobState =
  | "pending"
  | "validating"
  | "dry_run_ready"
  | "publishing"
  | "published"
  | "conflict"
  | "failed"
  | "result_unknown"
  | "superseded";
export type PublicationAction = "create" | "update" | "noop" | "conflict";
export type DocumentPublicationState =
  | "disabled"
  | "not_published"
  | "pending"
  | "validating"
  | "dry_run_ready"
  | "publishing"
  | "published"
  | "outdated"
  | "conflict"
  | "failed"
  | "result_unknown";
export type PublisherMode = "disabled" | "dry_run_only" | "write";
export type PublicationDiffKind = "new_page" | "page_update" | "manual_edit" | "none";

export interface PublicationTarget {
  space_key: string;
  parent_id: string;
  page_id: string | null;
  title: string;
  url: string | null;
}

export interface MergeEvidence {
  iid: string;
  url: string | null;
  merged_at: string | null;
}

/** Result of a dry-run (read requests only). */
export interface PublicationPlan {
  action: PublicationAction;
  revision: string;
  target: PublicationTarget;
  /** Exact Confluence storage XHTML that would be written — show as code, never render as HTML. */
  storage: string;
  /** Unified diff: current page → new body (or, for `manual_edit`, last published → current page). */
  diff: string;
  diff_kind: PublicationDiffKind;
  warnings: ValidationIssue[];
  /** Blocking problems. */
  problems: ValidationIssue[];
  remote_version: number | null;
  rendered_hash: string;
  merge_request: MergeEvidence | null;
  checked_at: string;
}

export interface PublicationEvent {
  at: string;
  actor: string;
  action: string;
  state: string | null;
  revision: string | null;
}

export interface PublicationJobSummary {
  id: string;
  document_id: string;
  document_path: string;
  revision: string;
  state: PublicationJobState;
  action: PublicationAction | null;
  proposal_id: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  /** A write may have happened without a confirmed answer; the next step inspects Confluence first. */
  uncertain: boolean;
  page_id: string | null;
  version_after: number | null;
  published_at: string | null;
}

export interface PublicationJobDetail extends PublicationJobSummary {
  plan: PublicationPlan | null;
  history: PublicationEvent[];
  can_dry_run: boolean;
  can_publish: boolean;
  can_reconcile: boolean;
  publish_enabled: boolean;
  publish_disabled_reason: string | null;
}

export interface PublicationJobList {
  items: PublicationJobSummary[];
  total: number;
}

export interface PublicationMapping {
  page_id: string;
  space_key: string;
  parent_id: string;
  page_title: string;
  page_version: number;
  published_revision: string;
  last_published_at: string;
  url: string | null;
}

export interface PublisherInfo {
  mode: PublisherMode;
  target_kind: IntegrationTarget;
  space_key: string | null;
  parent_id: string | null;
  message: string;
}

export interface DocumentPublicationStatus {
  document_id: string;
  current_revision: string | null;
  state: DocumentPublicationState;
  message: string;
  publisher: PublisherInfo;
  mapping: PublicationMapping | null;
  latest_job: PublicationJobSummary | null;
  can_prepare: boolean;
}
