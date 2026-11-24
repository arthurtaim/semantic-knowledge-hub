// Mirrors backend Pydantic models (backend/app/domain/models.py, proposals.py).

export type DocType =
  | "overview"
  | "architecture"
  | "source"
  | "domain"
  | "dataset"
  | "integration"
  | "process"
  | "decision"
  | "standard"
  | "guide"
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
/**
 * `external_page`: a draft proposed from a Confluence page cited in an answer («Предложить в базу»);
 * `import`: Markdown brought in by a user (with or without YAML) — a draft like any other.
 */
export type ProposalOrigin = "manual" | "ai_suggestion" | "external_page" | "import";
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
  /** Why the document matched the query (with a query only), e.g. «Точное совпадение идентификатора». */
  match_reasons?: string[] | null;
  /** Found through a declared relation of this document ID (graph expansion), not by its own text. */
  related_via?: string | null;
  version?: string | null;
  /**
   * Distinct documents linked to this one in the reader's snapshot — the document page's «Связи». Set by
   * GET /api/documents; null (or absent) elsewhere.
   */
  link_count?: number | null;
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
  /** Template the document was created with and its pinned version (M5.6.3); null for older documents. */
  template_id?: string | null;
  template_version?: number | null;
  /** Number of inline WikiLinks (`[[ID|Title]]`) in the body. */
  wikilink_count?: number;
}

export interface DocumentPage {
  items: DocumentSummary[];
  total: number;
  page: number;
  size: number;
  /** Notes about the query itself, e.g. an ambiguous abbreviation. */
  notes?: string[];
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

/** One passage of GET /api/search (backend `SearchResult`); a document may appear with several sections. */
export interface SearchResult {
  id: string;
  title: string;
  type: DocType | null;
  status: DocStatus | null;
  owner: string | null;
  source: SourceType;
  source_uri: string;
  revision: string;
  tags: string[];
  excerpt: string;
  excerpt_segments: HighlightSegment[];
  section: string | null;
  section_anchor: string | null;
  score: number;
  is_demo: boolean;
  match_reasons?: string[];
  matched_fields?: string[];
  related_via?: string | null;
}

/** GET /api/search: ranked passages plus the state of every requested scope. */
export interface SearchResponse {
  query: string;
  items: SearchResult[];
  total: number;
  scopes: ScopeStatus[];
  warnings: string[];
}

export type CitationSourceKind = "local_markdown" | "gitlab_approved" | "confluence_mcp";
/** Status of a Confluence page as the page itself declares it; never the same as an approved team document. */
export type ExternalStatus = "approved" | "draft" | "unknown";
/**
 * Where a cited excerpt comes from (UI v2): a knowledge source, or a file attached to this conversation.
 * An attachment is never a knowledge-base document — show it in its own group («Вложения этого диалога»).
 */
export type CitationSourceType = SourceType | "attachment";

export interface Citation {
  ref: number;
  source_type: CitationSourceType;
  /** For an attachment: its id (ATT-…). */
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
  source_kind?: CitationSourceKind;
  /** Stable source key, e.g. "confluence:demo-wiki:200101:3" (page 200101, version 3) or "local:DEMO-INT-013". */
  source_id?: string;
  external_status?: ExternalStatus | null;
  fragment_id?: string | null;
  content_hash?: string | null;
  /** UI v2, `source_type: "attachment"` only. */
  attachment_id?: string | null;
  attachment_name?: string | null;
  /** Computed by the server from the cited lines: «строка 1», «стр. 4», «лист Fields, строка 12», «строки 3–5». */
  locator?: string | null;
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

/** A fragment selected in a document (UI v2). The server checks that `text` really is in that document/section. */
export interface AskSelection {
  document_id: string;
  /** Section heading anchor (`DocumentDetail.sections[].anchor`); required by `improve_section`. */
  section_anchor?: string | null;
  /** Verbatim selected text, ≤ 8000 characters; "" means the whole section. */
  text?: string;
}

export interface AskRequest {
  /** ≥ 3 characters, or "" when the chosen skill has `prompt_optional: true`. */
  question: string;
  sources: SearchScope[];
  include_drafts: boolean;
  include_deprecated: boolean;
  /** Earlier completed turns, oldest first, at most 6. */
  history?: ConversationTurn[];
  /** Ask the server to consult Confluence even when the team documents look sufficient. */
  search_external?: boolean;
  // --- UI v2 (docs/ui-v2/specs/02_ASSISTANT.md §5); all optional ---
  /** Client-generated id of the dialog, `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`; required with `attachment_ids`. */
  conversation_id?: string;
  /** A skill id from GET /api/assistant/skills; omitted = the plain grounded answer. */
  skill_id?: string;
  /** Ready attachments of THIS conversation, at most 10. */
  attachment_ids?: string[];
  /** Documents chosen with «@», at most 5: cited first when relevant. */
  context_document_ids?: string[];
  selection?: AskSelection | null;
}

/** The skill that produced an answer (echoed when the request named one). */
export interface AskSkillRef {
  id: string;
  name: string;
  access: SkillAccess;
}

/** An AI proposal a skill created (GET /api/ai/proposals/{id}); nothing was applied. */
export interface AskProposalRef {
  id: string;
  kind: AiProposalKind;
  status: AiProposalStatus;
  graph_link?: string | null;
}

/** Why the server consulted the external source (AskResponse.external.trigger). */
export type ExternalTrigger =
  | "no_local_passages"
  | "unmatched_entities"
  | "low_term_coverage"
  | "external_scope_selected"
  | "explicit_request";

/** How the external source (Confluence through MCP) took part in one answer. */
export interface ExternalRetrievalSummary {
  called: boolean;
  trigger: ExternalTrigger | string | null;
  candidates: number;
  fetched: number;
  cache_hits: number;
  mcp_calls: number;
  fragments: number;
  rejected: { page_id: string; version: string | number | null; reason: string }[];
  degraded: boolean;
  elapsed_ms: number;
  policy_version: string;
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
  /** Key of the evidence graph of this answer (GET /api/graph/query/{id}); expires after the retention period. */
  retrieval_trace_id?: string | null;
  index_generation?: string | null;
  instructions_version?: string | null;
  external?: ExternalRetrievalSummary | null;
  /** UI v2: the skill used (null for a plain question). */
  skill?: AskSkillRef | null;
  /** UI v2: the proposal a workflow skill created — show it as a card with a link. */
  proposal?: AskProposalRef | null;
}

// --- UI v2: assistant skills and conversation attachments (docs/ui-v2/specs/02_ASSISTANT.md §3–§5) ---

/** "read" — «чтение»; "draft" — «создаёт черновик» (never applies anything: a proposal or a draft for review). */
export type SkillAccess = "read" | "draft";

export interface SkillRequires {
  /** A chosen document (`context_document_ids[0]`) or a selection in one. */
  document: boolean;
  selection: boolean;
  attachment: boolean;
}

/** GET /api/assistant/skills — the registry, with availability in the current AI mode. */
export interface AssistantSkill {
  id: string;
  name: string;
  description: string;
  access: SkillAccess;
  requires: SkillRequires;
  /** true: Enter with an empty question runs the skill. */
  prompt_optional: boolean;
  available: boolean;
  /** One Russian line when unavailable (e.g. «ИИ отключён»). */
  unavailable_reason: string | null;
}

export type AttachmentStatus = "ready" | "error";
export type AttachmentErrorCode = "unsupported_type" | "too_large" | "limit_reached" | "unreadable";

/** POST /api/assistant/attachments: HTTP 201 when `ready`, HTTP 200 with `status: "error"` when not accepted. */
export interface AssistantAttachment {
  id: string;
  conversation_id: string;
  /** Display name only (sanitized). */
  name: string;
  size: number;
  mime: string;
  status: AttachmentStatus;
  /** «3 листа», «12 страниц», «1 240 строк» (no-break space between digit groups). */
  summary: string | null;
  error_code: AttachmentErrorCode | null;
  /** null for an error result (nothing was stored). */
  expires_at: string | null;
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
  /** Monotonic number of the applied index generation. */
  generation?: number | string | null;
  last_sync?: LastSync | null;
  search_dictionary?: string | null;
  template_registry?: string | null;
}

/** What the last incremental sync (or full rebuild) changed; lists hold document IDs. */
export interface LastSync {
  generation: number | string;
  applied: boolean;
  added: string[] | number;
  updated: string[] | number;
  renamed: unknown[] | number;
  deleted: string[] | number;
  unchanged: number | unknown[];
  rejected: { path: string; code: string; document_id: string | null }[];
  checksum: string;
  elapsed_ms: number;
  full_rebuild: boolean;
  finished_at: string | null;
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
  /** Template version the draft was created with (it is validated against this version). */
  template_version?: number | null;
  /** Current version of the same template in the registry. */
  template_current_version?: number | null;
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
  /** Current version of the template (1 for a template that never changed). */
  version?: number;
  /** false: not offered for new documents (e.g. external_import); returned only with includeHidden. */
  listed?: boolean;
  previous_versions?: number[];
}

export interface NewDocumentMetadata {
  /** Empty: the server allocates the next free ID of the template prefix, once, at creation (immutable after). */
  id: string;
  title: string;
  status: NewDocumentStatus;
  /** Empty: unknown owner, stored as `unassigned` (never invented). */
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
  /** Template version of the draft being edited (an older draft is checked against its own version). */
  template_version?: number | null;
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
  /** Idempotency key (`^[A-Za-z0-9_-]{8,64}$`): a repeated request returns the draft already created. */
  client_request_id?: string;
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

// --- M5.6: knowledge graph (backend/app/api/graph.py) ---

export type GraphNodeKind =
  | "document"
  | "source_system"
  | "integration"
  | "semantic_entity"
  | "dataset"
  | "template"
  | "external_page"
  | "query_context";
export type GraphSourceKind = "local_markdown" | "gitlab_approved" | "template_registry" | "confluence_mcp" | "query_trace";
export type GraphRelation =
  | "references"
  | "depends_on"
  | "consumes"
  | "produces"
  | "maps_to"
  | "derived_from"
  | "describes"
  | "constrains"
  | "supersedes"
  | "uses_template"
  | "retrieved_for"
  | "cited_in";
/** Where an edge comes from; only `canonical_metadata` and `verified_registry` are confirmed knowledge. */
export type GraphOrigin = "canonical_metadata" | "verified_registry" | "external_discovery" | "query_trace" | "ai_suggestion";
export type GraphFeedback = "relevant" | "irrelevant" | "unsure" | "unrated";

export interface GraphNode {
  /** "doc:DEMO-INT-002" | "template:integration" | "ext:confluence:demo-wiki:200101:3" | "query:TRACE-…" */
  id: string;
  kind: GraphNodeKind;
  label: string;
  document_id: string | null;
  doc_type: string | null;
  /** A document status; for an external page the status the page declares ("unknown" when it declares none). */
  status: string | null;
  owner: string | null;
  source_kind: GraphSourceKind;
  revision: string | null;
  version: string | null;
  /** In-app path (/documents/…, /corporate/…), never an external URL. */
  url: string | null;
  synthetic: boolean;
  /** Temporary nodes (external pages, query context) disappear after this moment. */
  expires_at: string | null;
  degree: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphRelation;
  origin: GraphOrigin;
  verified: boolean;
  /** "Why linked": the document that declares the edge, its field, file path and revision. */
  declared_in: string | null;
  field: string | null;
  path: string | null;
  revision: string | null;
  status: "active" | "dangling";
  expires_at: string | null;
  feedback: GraphFeedback | null;
  /** Every place that declares this edge: "related_ids", "body:12" (WikiLink on line 12), "relations.depends_on". */
  provenance?: string[];
}

export interface GraphLimits {
  overview_default: number;
  overview_max: number;
  neighbours_max: number;
  depth_max: number;
  path_depth_max: number;
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
  total_edges: number;
  /** Not every matching node is included (a limit or a page of neighbours). */
  partial: boolean;
  generation: string;
  /** Next page of neighbours (GET …/neighbors?cursor=); null when everything is loaded. */
  next_cursor: number | null;
  focus: string | null;
  limits: GraphLimits;
}

export interface GraphLegend {
  kinds: Record<string, string>;
  relations: Record<string, string>;
  origins: Record<string, string>;
  limits: GraphLimits;
}

export interface GraphPath {
  found: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  generation: string;
}

export interface GraphDiagnostics {
  generation: string;
  nodes: number;
  edges: number;
  edges_by_type: Record<string, number>;
  dangling: GraphEdge[];
  orphans: string[];
}

// --- M5.6: discovery memory (backend/app/api/discovery.py) ---

export type DiscoveryVerdict = "relevant" | "irrelevant" | "unsure";

export interface DiscoveryFeedbackResponse {
  recorded: boolean;
  note: string;
}

export interface DiscoveryPurgeResponse {
  removed_records: number;
  removed_cache_pages: number;
}

export interface DiscoveryMemoryStats {
  traces: number;
  links_by_feedback: Record<string, number>;
  invalidated_sources: number;
  retention_hours: number;
  stores_query_text: boolean;
  policy_version: string;
}

export interface ExternalSourceStats {
  requests: number;
  mcp_calls: number;
  cache_hits: number;
  cache_misses: number;
  timeouts: number;
  errors: number;
  rejected: number;
  revoked_or_deleted: number;
  evicted: number;
  cache_pages: number;
  cache_limit: number;
  cache_ttl_seconds: number;
  /** Circuit breaker of the external source: "closed" (normal), "open" (calls paused), "half_open". */
  breaker: string;
  max_concurrent_seen: number;
  concurrency_limit: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  limits: Record<string, number>;
}

export interface DiscoveryStats {
  discovery: DiscoveryMemoryStats | { enabled: false };
  external: ExternalSourceStats | { enabled: false };
}

// --- M5.6.3: Template Hub (backend/app/services/template_hub.py) ---

export type TemplateStatus = "draft" | "active" | "deprecated" | "archived";

export interface TemplateSummary {
  id: string;
  title: string;
  description: string;
  doc_type: DocType;
  category: string;
  owner: string;
  labels: string[];
  status: TemplateStatus | string;
  version: number;
  versions: number[];
  updated: string;
  listed: boolean;
  required_sections: number;
  optional_sections: number;
  /** Visible documents created with this template (any version). */
  documents: number;
}

export interface TemplateSection {
  title: string;
  required: boolean;
  hint: string;
}

export interface TemplateVersionRow {
  version: number;
  status: string;
  active: boolean;
  first_seen: string;
  changes: string;
  breaking: boolean;
}

export interface TemplateUsage {
  document_id: string;
  title: string;
  status: DocStatus;
  template_version: number | null;
}

export interface TemplateDetail extends TemplateSummary {
  id_prefix: string;
  default_tags: string[];
  sections: TemplateSection[];
  required_metadata: string[];
  optional_metadata: string[];
  validation: string[];
  instructions: string;
  ai_guidance: string;
  example: string;
  /** Sanitized HTML of the synthetic example; render only through <SafeHtml>. */
  example_html: string;
  skeleton: string;
  changes: string;
  breaking: boolean;
  migration: string;
  history: TemplateVersionRow[];
  used_by: TemplateUsage[];
  /** "v<N>" → number of the reader's open drafts pinned to that version. */
  my_open_drafts: Record<string, number>;
}

export interface TemplateComparison {
  template_id: string;
  from_version: number;
  to_version: number;
  sections_added: string[];
  sections_removed: string[];
  became_required: string[];
  became_optional: string[];
  metadata_required_added: string[];
  metadata_required_removed: string[];
  validation_added: string[];
  validation_removed: string[];
  status_change: string | null;
  breaking: boolean;
  migration: string;
  changes: string;
}

// --- M5.6.3: links of documents (backend/app/services/links.py) ---

/** How a link is declared: an inline WikiLink, a `related_ids` entry or a typed relation. */
export type LinkVia = "inline" | "related_ids" | "typed";

export interface LinkedDocument {
  document_id: string;
  title: string;
  status: DocStatus;
  type: DocType;
}

export interface OutgoingLink {
  target: LinkedDocument;
  relation: string;
  via: LinkVia[];
  labels: string[];
  lines: number[];
}

export interface Backlink {
  source: LinkedDocument;
  relation: string;
  via: LinkVia[];
  lines: number[];
  /** The linking line(s) of the source body (inline links only). */
  excerpts: string[];
}

export type UnresolvedReason = "missing" | "title_link" | "ambiguous_title" | "self";

export interface UnresolvedLink {
  raw_target: string;
  label: string;
  line: number;
  excerpt: string;
  reason: UnresolvedReason;
  /** Visible documents whose title/alias matches (repair chooser). */
  candidates: LinkedDocument[];
}

export interface DocumentLinks {
  document_id: string;
  generation: string;
  outgoing: OutgoingLink[];
  backlinks: Backlink[];
  unresolved: UnresolvedLink[];
}

export interface LinkSuggestion {
  document_id: string;
  title: string;
  status: DocStatus;
  type: DocType;
  matched: "id" | "title" | "alias";
  alias: string | null;
  /** What the editor inserts: `[[ID|Title]]`. */
  insert: string;
}

export interface LinkDiagnostic {
  document_id: string;
  problem: UnresolvedLink;
}

// --- M5.6.3: metadata without YAML, import (backend/app/services/metadata.py, api/metadata.py) ---

export interface DocumentTypeInfo {
  type: DocType;
  templates: string[];
  required_fields: string[];
  system_fields: string[];
  human_fields: string[];
}

export interface StagingItem {
  path: string;
  code: string;
  message: string;
  /** The backend can read it for a preview; otherwise paste the content. */
  readable: boolean;
}

/** system: set by the server · parsed: from the text · existing: from the file's YAML · suggested · missing. */
export type FieldOrigin = "system" | "parsed" | "existing" | "suggested" | "missing";

export interface MetadataField {
  field: string;
  value: unknown;
  origin: FieldOrigin;
  note: string;
  /** Document IDs / headings that support a suggestion. */
  evidence: string[];
}

export interface TemplateSuggestion {
  template_id: string;
  version: number;
  title: string;
  score: number;
  reasons: string[];
}

export type ImportState = "ready" | "needs_metadata_review" | "invalid_metadata" | "conflict";

export interface ImportPreviewRequest {
  content?: string;
  /** A staged file of the knowledge root. */
  path?: string;
  filename?: string;
}

export interface ImportPreview {
  state: ImportState;
  has_frontmatter: boolean;
  /** Kept from valid YAML, or the ID the backend would allocate. */
  document_id: string;
  title: string;
  fields: MetadataField[];
  missing: string[];
  templates: TemplateSuggestion[];
  issues: ValidationIssue[];
  body: string;
  /** Sanitized HTML; render only through <SafeHtml>. */
  preview_html: string;
  /** The original text (for the create call). */
  content: string;
  source_path: string | null;
  keeps_original_metadata: boolean;
}

export interface ImportCreateRequest {
  content: string;
  keep_original_metadata: boolean;
  template_id?: string | null;
  metadata?: NewDocumentMetadata | null;
  reason: string;
  client_request_id?: string;
}

// --- M5.6.3: AI-first workflows (backend/app/services/ai_workflows.py) ---

export type AiProposalKind =
  | "draft_from_prompt"
  | "suggest_metadata"
  | "improve_section"
  | "summarize"
  | "explain"
  | "check_completeness"
  | "find_related"
  | "explain_relation"
  | "impact_analysis";
export type AiProposalStatus = "suggested" | "applied" | "partially_applied" | "rejected" | "invalidated" | "answered";
export type AiItemKind = "metadata" | "section" | "link" | "template" | "draft" | "task" | "note";

export interface AiEvidence {
  document_id: string;
  title: string;
  revision: string;
  status: string;
  quote: string;
  reason: string;
}

export interface AiProposalItem {
  id: string;
  kind: AiItemKind;
  field: string | null;
  section: string | null;
  target_id: string | null;
  current: unknown;
  proposed: unknown;
  reason: string;
  evidence: AiEvidence[];
  /** false: information or a plan item, never applied. */
  applicable: boolean;
}

export interface AiProposalBase {
  draft_id: string | null;
  edit_version: number | null;
  document_id: string | null;
  revision: string | null;
  template_id: string | null;
  template_version: number | null;
  index_generation: string;
}

export interface AiProposal {
  id: string;
  kind: AiProposalKind;
  status: AiProposalStatus;
  created_at: string;
  decided_at: string | null;
  mode: string;
  base: AiProposalBase;
  summary: string;
  items: AiProposalItem[];
  warnings: string[];
  insufficient: boolean;
  /** In-app link to the Local Graph of the explained documents. */
  graph_link: string | null;
  applied_items: string[];
  /** The draft the accepted items went into (the same draft, a new update draft or a new document draft). */
  result_draft_id: string | null;
}

export interface AiProposalRequest {
  kind: AiProposalKind;
  draft_id?: string;
  document_id?: string;
  target_id?: string;
  section?: string;
  selection?: string;
  prompt?: string;
  title?: string;
  template_id?: string;
  goal?: string;
}
