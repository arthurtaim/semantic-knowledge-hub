import type {
  Confidence,
  DocStatus,
  DocType,
  IntegrationState,
  ProposalStatus,
  ReviewState,
  SourceType,
} from "../api/types";

/** Navigation order of knowledge sections (docs/UX.md: Product, Architecture, Domain, …). */
export const TYPE_ORDER: DocType[] = [
  "overview",
  "architecture",
  "domain",
  "integration",
  "process",
  "decision",
  "standard",
  "glossary",
];

export const TYPE_LABEL: Record<DocType, string> = {
  overview: "Продукт",
  architecture: "Архитектура",
  domain: "Домен",
  integration: "Интеграции",
  process: "Процессы",
  decision: "Решения",
  standard: "Стандарты",
  glossary: "Глоссарий",
};

export const STATUS_ORDER: DocStatus[] = ["approved", "in_review", "draft", "deprecated"];

export const STATUS_LABEL: Record<DocStatus, string> = {
  draft: "Черновик",
  in_review: "На ревью",
  approved: "Утверждён",
  deprecated: "Устарел",
};

export const SOURCE_LABEL: Record<SourceType, string> = {
  local: "Локальный workspace",
  gitlab: "GitLab",
  confluence: "Confluence",
};

export const REVIEW_LABEL: Record<ReviewState, string> = {
  ok: "Проверен",
  stale: "Проверка устарела",
  never_reviewed: "Не проверялся",
  not_required: "Проверка не требуется",
};

export const INTEGRATION_STATE_LABEL: Record<IntegrationState, string> = {
  connected: "Подключено",
  disabled: "Не подключено",
  mock: "Демо (mock)",
  error: "Ошибка",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  supported: "Подтверждено источником",
  partial: "Подтверждено частично",
  insufficient_evidence: "Недостаточно данных",
};

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  open: "Открыто",
  ready_for_review: "Готово к ревью",
  submitted: "Отправлено в GitLab MR",
  rejected: "Отклонено",
};

export const PROPOSAL_ACTION_LABEL: Record<string, string> = {
  created: "Создано",
  marked_ready_for_review: "Отмечено «Готово к ревью»",
  rejected: "Отклонено",
  merge_request_opened: "Открыт Merge Request",
};

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormat.format(date);
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
