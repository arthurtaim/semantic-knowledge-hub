import type {
  AskResponse,
  DocumentDetail,
  DocumentFacets,
  DocumentPage,
  IntegrationsResponse,
  ProposalDetail,
  SessionResponse,
} from "../api/types";

export const session: SessionResponse = {
  user: { user_id: "local-demo-user", display_name: "Демо-пользователь (localhost)", roles: ["reader"], is_demo: true },
  auth_mode: "local_demo",
  demo_content: true,
  knowledge_backend: "local",
  features: {
    ai_mode: "mock",
    ai_edit_suggestions: false,
    corporate_search: "disabled",
    gitlab_proposals: false,
    confluence_publish: false,
  },
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
    },
  ],
  warnings: ["Используются только демо-документы (синтетические данные) — они не являются фактами о банке."],
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
};

export const integrations: IntegrationsResponse = {
  checked_at: "2026-11-22T00:00:00Z",
  items: [
    { name: "local_knowledge", title: "Локальная база знаний", kind: "knowledge_repository", state: "connected", capabilities: ["read"], human_readable_message: "Локальный workspace", details: {} },
    { name: "gitlab_knowledge", title: "GitLab (каноническая база знаний)", kind: "knowledge_repository", state: "disabled", capabilities: [], human_readable_message: "Не подключено", details: {} },
    { name: "confluence_mcp", title: "Confluence Data Center (MCP, только чтение)", kind: "corporate_knowledge", state: "disabled", capabilities: [], human_readable_message: "Не подключено", details: {} },
    { name: "ai_provider", title: "AI-провайдер", kind: "ai", state: "mock", capabilities: ["extractive_answers"], human_readable_message: "Демо-режим", details: {} },
  ],
};

export function proposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: "a".repeat(32),
    document_id: "SEM-INT-ARIS-001",
    document_title: "ARIS integration — questions for discovery",
    source: "local",
    status: "open",
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
    history: [{ at: "2026-11-22T00:00:00Z", actor: "local-demo-user", action: "created", status: "open" }],
    review_comment: null,
    can_mark_ready: true,
    can_reject: true,
    publication: { state: "disabled", message: "GitLab MR отключён.", external_url: null },
    ...overrides,
  };
}
