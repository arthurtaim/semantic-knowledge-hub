import type {
  AiDraftResponse,
  AskResponse,
  AssistantAttachment,
  AssistantSkill,
  AuthoringCheckResponse,
  DocumentDetail,
  DocumentFacets,
  DocumentPage,
  DocumentPublicationStatus,
  DocumentTemplateInfo,
  IntegrationsResponse,
  ProposalDetail,
  ProposalList,
  ProposalSummary,
  PublicationJobDetail,
  SessionResponse,
  SyncStatus,
} from "../api/types";

export const session: SessionResponse = {
  user: { user_id: "local-demo-user", display_name: "Демо-пользователь (localhost)", roles: ["reader"], is_demo: true },
  auth_mode: "local_demo",
  demo_content: true,
  knowledge_backend: "local",
  features: {
    ai_mode: "mock",
    ai_edit_suggestions: false,
    ai_authoring: true,
    corporate_search: "disabled",
    gitlab_proposals: false,
    confluence_publish: false,
  },
};

/** Session of a deployment where GitLab is the knowledge source and MR creation is enabled. */
export const gitlabSession: SessionResponse = {
  ...session,
  knowledge_backend: "gitlab",
  features: { ...session.features, gitlab_proposals: true },
};

export const arisSummary = {
  id: "SEM-INT-ARIS-001",
  title: "ARIS integration — questions for discovery",
  type: "integration" as const,
  status: "draft" as const,
  owner: "demo-team",
  source: "local" as const,
  source_uri: "local://SEM-INT-ARIS-001",
  revision: "sha256:df6c505c42a7e51e",
  tags: ["aris", "demo"],
  excerpt: "ARIS is used here only as a topic.",
  is_demo: true,
  reviewed_at: null,
  updated_at: "2026-11-22T00:00:00Z",
  review_state: "not_required" as const,
  owner_missing: false,
  web_url: null,
  index_state: "current" as const,
  highlights: [
    { text: "Real ", highlight: false },
    { text: "ARIS", highlight: true },
    { text: " integration", highlight: false },
  ],
};

export const documentPage: DocumentPage = { items: [arisSummary], total: 1, page: 1, size: 20 };
export const emptyPage: DocumentPage = { items: [], total: 0, page: 1, size: 20 };

export const facets: DocumentFacets = {
  types: [{ value: "integration", count: 1 }],
  statuses: [{ value: "draft", count: 1 }],
  owners: [{ value: "demo-team", count: 1 }],
  sources: [{ value: "local", count: 1 }],
  tags: [{ value: "aris", count: 1 }],
  total: 1,
};

export const arisDetail: DocumentDetail = {
  ...arisSummary,
  summary: "Synthetic discovery questions.",
  related: [{ id: "SEM-ARCH-001", title: "Semantic Layer — demonstration architecture", status: "approved", resolved: true }],
  source_refs: [],
  content_markdown: "# ARIS",
  content_html:
    '<h1 id="aris">ARIS</h1><p>Body</p><script>window.__xss = true</script>' +
    '<img src="x" onerror="window.__xss = true"><a href="javascript:alert(1)">bad</a>' +
    '<a href="/documents/SEM-ARCH-001">arch</a>',
  raw: "---\nid: SEM-INT-ARIS-001\n---\n# ARIS\n",
  path: "SEM-INT-ARIS-001.md",
  sections: [{ heading: "ARIS", anchor: "aris", level: 1, text: "Body" }],
  warnings: [],
  extra_metadata: {},
};

/** The same document served from GitLab: a validated link to the exact revision and a stale index marker. */
export const gitlabDetail: DocumentDetail = {
  ...arisDetail,
  source: "gitlab",
  source_uri: "gitlab://semantic-kb/docs/SEM-INT-ARIS-001.md",
  revision: "3f2a9c1d",
  updated_at: "2026-11-20T09:30:00Z",
  web_url: "https://gitlab.example.test/semantic-kb/-/blob/3f2a9c1d/docs/SEM-INT-ARIS-001.md",
  index_state: "stale",
};

export const freshSync: SyncStatus = {
  source: "local",
  state: "fresh",
  message: "Синхронизировано.",
  documents: 12,
  issues: 0,
  failed_paths: [],
  last_attempt_at: "2026-11-22T08:00:00Z",
  last_success_at: "2026-11-22T08:00:00Z",
  source_version: "sha256:abc",
  branch: null,
  head_commit: null,
  indexed_documents: 12,
  indexed_version: "sha256:abc",
  indexed_at: "2026-11-22T08:00:00Z",
};

export const staleSync: SyncStatus = {
  ...freshSync,
  source: "gitlab",
  state: "stale",
  message: "GitLab недоступен: тайм-аут соединения.",
  issues: 1,
  failed_paths: ["docs/SEM-INT-ARIS-001.md"],
  last_attempt_at: "2026-11-22T09:00:00Z",
  last_success_at: "2026-11-21T18:45:00Z",
  branch: "main",
  head_commit: "3f2a9c1d",
};

export const supportedAnswer: AskResponse = {
  answer: "Демо-режим: дословные выдержки.\n\n1. «This local demonstration models a knowledge base with four layers» [1]",
  mode: "mock",
  confidence: "supported",
  citations: [
    {
      ref: 1,
      source_type: "local",
      document_id: "SEM-ARCH-001",
      title: "Semantic Layer — demonstration architecture",
      source_uri: "local://SEM-ARCH-001",
      revision: "sha256:0b52b3c354720bc",
      status: "approved",
      section: "Semantic Layer — demonstration architecture",
      section_anchor: "semantic-layer-demonstration-architecture",
      excerpt: "This local demonstration models a knowledge base with four layers",
      retrieved_at: "2026-11-22T00:00:00Z",
      is_demo: true,
      app_path: "/documents/SEM-ARCH-001#semantic-layer-demonstration-architecture",
      provenance: "synthetic",
    },
  ],
  // Synthetic origin is metadata of the cited source (`provenance`), not a fixed warning (docs/API_CONTRACTS.md).
  warnings: [],
  provenance: { overall: "synthetic", synthetic: 1, not_synthetic: 0, unknown: 0, by_kind: { team: 1 } },
  excluded_sources: [],
  scopes: [
    { scope: "team", state: "connected", message: "Локальный workspace с демо-документами." },
    { scope: "corporate", state: "disabled", message: "Корпоративные источники не подключены." },
  ],
  unmatched_terms: [],
};

export const insufficientAnswer: AskResponse = {
  answer: "Недостаточно данных: в доступных источниках нет упоминаний «ЦФТ».",
  mode: "mock",
  confidence: "insufficient_evidence",
  citations: [],
  warnings: [],
  excluded_sources: [
    {
      document_id: "SEM-INT-ARIS-001",
      title: "ARIS integration — questions for discovery",
      status: "draft",
      reason: "Неутверждённый документ исключён.",
    },
  ],
  scopes: [{ scope: "team", state: "connected", message: "Локальный workspace с демо-документами." }],
  unmatched_terms: ["ЦФТ"],
  // No evidence: no provenance claim (never «only demo» because some accessible document is demo).
  provenance: { overall: "none", synthetic: 0, not_synthetic: 0, unknown: 0, by_kind: {} },
};

export const integrations: IntegrationsResponse = {
  checked_at: "2026-11-22T00:00:00Z",
  items: [
    { name: "local_knowledge", title: "Локальная база знаний", kind: "knowledge_repository", state: "connected", capabilities: ["read"], human_readable_message: "Локальный workspace", details: {}, target: "local", access: "read", checked_at: "2026-11-22T00:00:00Z" },
    { name: "gitlab_knowledge", title: "GitLab (каноническая база знаний)", kind: "knowledge_repository", state: "disabled", capabilities: [], human_readable_message: "Не подключено", details: {}, target: "none", access: "none", checked_at: "2026-11-22T00:00:00Z" },
    { name: "confluence_mcp", title: "Confluence Data Center (MCP, только чтение)", kind: "corporate_knowledge", state: "disabled", capabilities: [], human_readable_message: "Не подключено", details: {}, target: "none", access: "none", checked_at: "2026-11-22T00:00:00Z" },
    { name: "ai_provider", title: "AI-провайдер", kind: "ai", state: "mock", capabilities: ["extractive_answers"], human_readable_message: "Демо-режим", details: {}, target: "local", access: "read", checked_at: "2026-11-22T00:00:00Z" },
    { name: "confluence_publisher", title: "Confluence Data Center (REST, публикация)", kind: "confluence_publisher", state: "disabled", capabilities: [], human_readable_message: "Не настроено (CONFLUENCE_REST_URL не задан).", details: {}, target: "none", access: "none", checked_at: "2026-11-22T00:00:00Z" },
  ],
};

export function proposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  const status = overrides.status ?? "draft";
  return {
    id: "a".repeat(32),
    operation: "update",
    document_id: "SEM-INT-ARIS-001",
    document_title: "ARIS integration — questions for discovery",
    source: "local",
    status: "draft",
    reason: "Уточнение формулировки",
    origin: "manual",
    author: "local-demo-user",
    created_at: "2026-11-22T00:00:00Z",
    updated_at: "2026-11-22T00:00:00Z",
    base_revision: "sha256:df6c505c42a7e51e",
    additions: 1,
    deletions: 1,
    error_count: 0,
    warning_count: 0,
    document_path: "SEM-INT-ARIS-001.md",
    current_revision: "sha256:df6c505c42a7e51e",
    is_stale: false,
    base_content: "a\nold line\nc",
    proposed_content: "a\nnew line\nc",
    validation: [],
    diff: {
      unified: "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-old line\n+new line\n c",
      lines: [
        { kind: "hunk", old_no: null, new_no: null, text: "@@ -1,3 +1,3 @@" },
        { kind: "context", old_no: 1, new_no: 1, text: "a" },
        { kind: "remove", old_no: 2, new_no: null, text: "old line" },
        { kind: "add", old_no: null, new_no: 2, text: "new line" },
        { kind: "context", old_no: 3, new_no: 3, text: "c" },
      ],
      additions: 1,
      deletions: 1,
      changed: true,
    },
    history: [{ at: "2026-11-22T00:00:00Z", actor: "local-demo-user", action: "created", status: "draft" }],
    review_comment: null,
    can_mark_ready: true,
    can_reject: true,
    can_submit: false,
    can_refresh_status: false,
    publication: { state: "disabled", message: "GitLab MR отключён.", external_url: null },
    merge_request_url: null,
    merge_request_state: null,
    source_document_state: "unchanged",
    branch_name: null,
    merge_request: null,
    submission: { attempts: 0, last_attempt_at: null, error_code: null, error_message: null, uncertain: false },
    template_id: null,
    edit_version: 1,
    can_edit: status === "draft",
    can_delete: status === "draft",
    new_document: null,
    merged_revision: null,
    synced_at: null,
    ...overrides,
  };
}

export const MR_URL = "https://gitlab.example.test/semantic-kb/-/merge_requests/42";

/** A proposal with an MR in GitLab (status and MR state given by the caller). */
export function submittedProposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return proposal({
    status: "submitted_to_gitlab",
    can_mark_ready: false,
    can_reject: false,
    can_refresh_status: true,
    publication: { state: "submitted", message: "MR открыт.", external_url: MR_URL },
    merge_request_url: MR_URL,
    merge_request_state: "opened",
    branch_name: "skh/proposal-aaaaaaaa",
    merge_request: {
      iid: "42",
      url: MR_URL,
      state: "opened",
      source_branch: "skh/proposal-aaaaaaaa",
      target_branch: "main",
      checked_at: "2026-11-22T10:00:00Z",
    },
    submission: { attempts: 1, last_attempt_at: "2026-11-22T09:59:00Z", error_code: null, error_message: null, uncertain: false },
    history: [
      { at: "2026-11-22T00:00:00Z", actor: "local-demo-user", action: "created", status: "draft" },
      { at: "2026-11-22T01:00:00Z", actor: "local-demo-user", action: "marked_ready_for_review", status: "ready_for_review" },
      { at: "2026-11-22T09:59:00Z", actor: "local-demo-user", action: "merge_request_opened", status: "submitted_to_gitlab" },
    ],
    ...overrides,
  });
}

export function proposalSummary(overrides: Partial<ProposalSummary> = {}): ProposalSummary {
  const p = proposal();
  return {
    id: p.id,
    operation: p.operation,
    document_id: p.document_id,
    document_title: p.document_title,
    source: p.source,
    status: p.status,
    reason: p.reason,
    origin: p.origin,
    author: p.author,
    created_at: p.created_at,
    updated_at: p.updated_at,
    base_revision: p.base_revision,
    additions: p.additions,
    deletions: p.deletions,
    error_count: p.error_count,
    warning_count: p.warning_count,
    merge_request_url: null,
    merge_request_state: null,
    ...overrides,
  };
}

export const actionableProposals: ProposalList = {
  items: [
    proposalSummary({ id: "p-draft", status: "draft", reason: "Новая формулировка" }),
    proposalSummary({ id: "p-failed", status: "submission_failed", reason: "Не ушло в GitLab" }),
    proposalSummary({
      id: "p-mr",
      status: "submitted_to_gitlab",
      reason: "Уже в GitLab",
      merge_request_url: MR_URL,
      merge_request_state: "opened",
    }),
    proposalSummary({ id: "p-merged", status: "merged", reason: "Уже принято" }),
  ],
  total: 4,
};

// --- authoring of new documents ---

export const architectureTemplate: DocumentTemplateInfo = {
  id: "architecture",
  title: "Архитектура",
  description: "Архитектура системы, компонента или контура семантического слоя.",
  doc_type: "architecture",
  id_prefix: "SEM-ARCH",
  default_tags: ["architecture"],
  sections: ["Назначение", "Контекст", "Компоненты"],
  skeleton:
    "## Назначение\n> Требует уточнения: какую задачу решает система.\n\n" +
    "## Контекст\n> Требует уточнения: окружение и границы.\n\n" +
    "## Компоненты\n> Требует уточнения: основные компоненты.\n",
  suggested_id: "SEM-ARCH-002",
  suggested_path: "docs/SEM-ARCH-002.md",
};

export const adrTemplate: DocumentTemplateInfo = {
  id: "adr",
  title: "ADR",
  description: "Архитектурное решение: контекст, альтернативы, решение и последствия.",
  doc_type: "decision",
  id_prefix: "SEM-ADR",
  default_tags: ["adr"],
  sections: ["Контекст", "Проблема", "Решение"],
  skeleton: "## Контекст\n> Требует уточнения: контекст.\n\n## Проблема\n> Требует уточнения: проблема.\n\n## Решение\n> Требует уточнения: решение.\n",
  suggested_id: "SEM-ADR-001",
  suggested_path: "docs/SEM-ADR-001.md",
};

export const templates: DocumentTemplateInfo[] = [architectureTemplate, adrTemplate];

export function checkResponse(overrides: Partial<AuthoringCheckResponse> = {}): AuthoringCheckResponse {
  return {
    content:
      "---\nid: SEM-ARCH-002\ntitle: Витрина метрик\ntype: architecture\nstatus: draft\nowner: local-demo-user\n" +
      "tags: [architecture]\nrelated_ids: []\nsource_refs: []\nreviewed_at: null\n---\n\n# Витрина метрик\n",
    path: "docs/SEM-ARCH-002.md",
    validation: [
      {
        severity: "warning",
        code: "unresolved_placeholders",
        message: "Осталось мест с пометкой «Требует уточнения»: 3.",
        field: null,
      },
    ],
    preview_html: "<h1>Витрина метрик</h1><p>Предпросмотр документа</p>",
    id_available: true,
    path_available: true,
    error_count: 0,
    warning_count: 1,
    ...overrides,
  };
}

export const aiDraft: AiDraftResponse = {
  mode: "mock",
  body:
    "# Витрина метрик\n\n## Назначение\n> Требует уточнения: какую задачу решает система.\n\n" +
    "## Контекст\n> This local demonstration models a knowledge base with four layers\n",
  references: [
    {
      document_id: "SEM-ARCH-001",
      title: "Semantic Layer — demonstration architecture",
      revision: "sha256:0b52b3c354720bc",
      status: "approved",
      source: "local",
      is_demo: true,
    },
  ],
  citations: [
    {
      document_id: "SEM-ARCH-001",
      title: "Semantic Layer — demonstration architecture",
      revision: "sha256:0b52b3c354720bc",
      status: "approved",
      section: "Overview",
      quote: "This local demonstration models a knowledge base with four layers",
    },
  ],
  unverified_claims: ["Состав компонентов витрины не подтверждён источниками."],
  warnings: ["Документ SEM-INT-ARIS-001 не утверждён и не используется как источник."],
  insufficient_data: true,
  suggested_related_ids: ["SEM-ARCH-001"],
  access_scope: "team",
};

export const NEW_DOC_ID = "b".repeat(32);
export const NEW_DOC_BODY = "# Витрина метрик\n\n## Назначение\nСобирает метрики клиентов.\n";

/** A stored `create` proposal (a draft of a new document) as the server returns it. */
export function newDocumentProposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  const content =
    "---\nid: SEM-ARCH-002\ntitle: Витрина метрик\ntype: architecture\nstatus: draft\nowner: semantic-team\n" +
    "tags: [architecture]\n---\n\n" +
    NEW_DOC_BODY;
  const lines = content.replace(/\n$/, "").split("\n");
  return proposal({
    id: NEW_DOC_ID,
    operation: "create",
    template_id: "architecture",
    document_id: "SEM-ARCH-002",
    document_title: "Витрина метрик",
    document_path: "docs/SEM-ARCH-002.md",
    reason: "Описать витрину клиентских метрик",
    base_revision: "",
    base_content: "",
    proposed_content: content,
    current_revision: null,
    source_document_state: "new_document",
    additions: lines.length,
    deletions: 0,
    diff: {
      unified: "",
      lines: [
        { kind: "hunk", old_no: null, new_no: null, text: `@@ -0,0 +1,${lines.length} @@` },
        ...lines.map((text, index) => ({ kind: "add" as const, old_no: null, new_no: index + 1, text })),
      ],
      additions: lines.length,
      deletions: 0,
      changed: true,
    },
    history: [{ at: "2026-11-22T00:00:00Z", actor: "local-demo-user", action: "created_new_document", status: "draft" }],
    new_document: {
      metadata: {
        id: "SEM-ARCH-002",
        title: "Витрина метрик",
        type: "architecture",
        status: "draft",
        owner: "semantic-team",
        tags: ["architecture"],
        related_ids: [],
        source_refs: [],
        reviewed_at: null,
      },
      body: NEW_DOC_BODY,
    },
    ...overrides,
  });
}

// --- publication to Confluence (M5) ---

export const PUB_JOB_ID = "c".repeat(32);
export const PUB_REVISION = "3f2a9c1d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
export const CONFLUENCE_PAGE_URL = "http://confluence-mock.test/pages/viewpage.action?pageId=98765";

export function publicationStatus(overrides: Partial<DocumentPublicationStatus> = {}): DocumentPublicationStatus {
  return {
    document_id: "SEM-INT-ARIS-001",
    current_revision: PUB_REVISION,
    state: "not_published",
    message: "Документ ещё не публиковался в Confluence.",
    publisher: {
      mode: "write",
      target_kind: "mock",
      space_key: "SKHTEST",
      parent_id: "1001",
      message: "Публикация включена для тестового пространства (локальный тестовый дубль Confluence).",
    },
    mapping: null,
    latest_job: null,
    can_prepare: true,
    ...overrides,
  };
}

export const disabledPublication = publicationStatus({
  state: "disabled",
  message: "Публикация в Confluence не настроена.",
  publisher: { mode: "disabled", target_kind: "none", space_key: null, parent_id: null, message: "Публикация в Confluence не настроена." },
  can_prepare: false,
});

export function publicationJob(overrides: Partial<PublicationJobDetail> = {}): PublicationJobDetail {
  return {
    id: PUB_JOB_ID,
    document_id: "SEM-INT-ARIS-001",
    document_path: "docs/SEM-INT-ARIS-001.md",
    revision: PUB_REVISION,
    state: "dry_run_ready",
    action: "create",
    proposal_id: null,
    created_at: "2026-11-22T10:00:00Z",
    updated_at: "2026-11-22T10:00:05Z",
    attempts: 0,
    error_code: null,
    error_message: null,
    uncertain: false,
    page_id: null,
    version_after: null,
    published_at: null,
    plan: {
      action: "create",
      revision: PUB_REVISION,
      target: { space_key: "SKHTEST", parent_id: "1001", page_id: null, title: "ARIS integration — questions for discovery", url: null },
      storage: "<h1>ARIS integration</h1>\n<p>Synthetic discovery questions.</p>",
      diff: "--- /dev/null\n+++ new-page\n@@ -0,0 +1,2 @@\n+<h1>ARIS integration</h1>\n+<p>Synthetic discovery questions.</p>",
      diff_kind: "new_page",
      warnings: [
        {
          severity: "warning",
          code: "image_not_published",
          message: "Изображения не публикуются: на странице будет текстовая отметка вместо картинки.",
          field: null,
        },
      ],
      problems: [],
      remote_version: null,
      rendered_hash: "sha256:abc",
      merge_request: { iid: "42", url: MR_URL, merged_at: "2026-11-22T09:00:00Z" },
      checked_at: "2026-11-22T10:00:05Z",
    },
    history: [
      { at: "2026-11-22T10:00:00Z", actor: "local-demo-user", action: "job_created", state: "pending", revision: PUB_REVISION },
      { at: "2026-11-22T10:00:05Z", actor: "local-demo-user", action: "dry_run", state: "dry_run_ready", revision: PUB_REVISION },
    ],
    can_dry_run: true,
    can_publish: true,
    can_reconcile: false,
    publish_enabled: true,
    publish_disabled_reason: null,
    ...overrides,
  };
}

// --- UI v2 phase C: the skill registry as the mock provider reports it (GET /api/assistant/skills) ---

const skill = (
  id: string,
  name: string,
  description: string,
  access: AssistantSkill["access"],
  requires: Partial<AssistantSkill["requires"]> = {},
  extra: Partial<AssistantSkill> = {},
): AssistantSkill => ({
  id,
  name,
  description,
  access,
  requires: { document: false, selection: false, attachment: false, ...requires },
  prompt_optional: true,
  available: true,
  unavailable_reason: null,
  ...extra,
});

export const skills: AssistantSkill[] = [
  skill("answer", "Ответ по базе знаний", "Отвечает только по документам, с цитатами", "read", {}, { prompt_optional: false }),
  skill("explain", "Объяснить", "Объяснит выделенный фрагмент или документ по утверждённым источникам", "read", { document: true }),
  skill("summarize", "Кратко пересказать", "Коротко перескажет документ или выделенный фрагмент", "read", { document: true }),
  skill("check_freshness", "Что перепроверить", "Покажет связанные документы, которые могли устареть", "read", { document: true }),
  skill("find_related", "Найти связи", "Покажет связанные документы и путь на карте знаний", "read", { document_or_question: true }),
  skill("compare_with_file", "Сравнить с файлом", "Сверит вложение с утверждёнными документами", "read", { attachment: true }),
  skill("draft_document", "Черновик документа", "Подберёт шаблон и подготовит черновик на ревью", "draft", {}, { prompt_optional: false }),
  skill(
    "improve_section",
    "Улучшить раздел",
    "Предложит новую формулировку раздела; применяется только после вашего решения",
    "draft",
    { document: true, selection: true },
    { available: false, unavailable_reason: "В демо-режиме нет языковой модели: переписать раздел нельзя." },
  ),
];

export const attachmentReady = (overrides: Partial<AssistantAttachment> = {}): AssistantAttachment => ({
  id: "ATT-0123456789abcdef",
  conversation_id: "conv-test-0001",
  name: "aris_export_2026-11.csv",
  size: 48 * 1024,
  mime: "text/csv",
  status: "ready",
  summary: "1 240 строк",
  error_code: null,
  expires_at: "2026-11-25T10:00:00Z",
  ...overrides,
});
