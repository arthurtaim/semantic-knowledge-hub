import type {
  Confidence,
  DocStatus,
  DocType,
  DocumentSort,
  IntegrationState,
  MergeRequestState,
  NewDocumentStatus,
  ProposalOperation,
  ProposalStatus,
  ReviewState,
  SourceType,
  SyncState,
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
  draft: "Новое",
  ready_for_review: "Готово к ревью",
  submitting: "Отправляется в GitLab",
  submitted_to_gitlab: "MR в GitLab",
  merged: "Принято (merge)",
  rejected: "Отклонено",
  conflict: "Конфликт версий",
  submission_failed: "Ошибка отправки",
};

/** Filter order on the proposals page: lifecycle order, failures last. */
export const PROPOSAL_STATUS_ORDER: ProposalStatus[] = [
  "draft",
  "ready_for_review",
  "submitting",
  "submitted_to_gitlab",
  "merged",
  "rejected",
  "conflict",
  "submission_failed",
];

/** Proposals that wait for a person in this application (home page block). */
export const PROPOSAL_NEEDS_ACTION: ProposalStatus[] = ["draft", "ready_for_review", "submission_failed", "conflict"];

/** Labels for ProposalEvent.action; unknown actions fall back to the raw value. */
export const PROPOSAL_ACTION_LABEL: Record<string, string> = {
  created: "Создано",
  created_new_document: "Создан черновик нового документа",
  draft_saved: "Черновик сохранён",
  draft_deleted: "Черновик удалён",
  knowledge_synced: "База знаний синхронизирована после merge",
  marked_ready_for_review: "Отмечено «Готово к ревью»",
  rejected: "Отклонено",
  conflict_detected: "Обнаружен конфликт версий",
  submission_started: "Начата отправка в GitLab",
  submission_failed: "Ошибка отправки в GitLab",
  merge_request_opened: "Открыт Merge Request",
  merge_request_found: "Найден уже созданный Merge Request",
  merge_request_checked: "Состояние MR проверено в GitLab",
  merged_in_gitlab: "Merge подтверждён GitLab",
  merge_request_closed: "MR закрыт без merge",
};

/** What a proposal does to the knowledge base. */
export const OPERATION_LABEL: Record<ProposalOperation, string> = {
  create: "Новый документ",
  update: "Изменение документа",
};

/** Statuses selectable for a new document, in lifecycle order (`deprecated` is invalid for new documents). */
export const NEW_DOCUMENT_STATUSES: NewDocumentStatus[] = ["draft", "in_review", "approved"];

/** Titles for errors of the authoring endpoints and of draft save/delete. */
export const AUTHORING_ERROR_TITLE: Record<string, string> = {
  document_id_taken: "ID уже занят",
  document_path_taken: "Путь в репозитории уже занят",
  document_exists: "ID или путь уже занят в базе знаний",
  draft_modified: "Черновик изменён в другом окне или другим пользователем",
  draft_not_editable: "Черновик больше нельзя редактировать",
  draft_not_deletable: "Черновик нельзя удалить",
  ai_authoring_unavailable: "AI-помощник недоступен",
  validation_failed: "Документ не прошёл проверку",
  invalid_request: "Некорректные данные формы",
  template_not_found: "Шаблон документа не найден",
  invalid_transition: "Действие недоступно в текущем статусе",
};

export const MR_STATE_LABEL: Record<MergeRequestState, string> = {
  opened: "Открыт, ожидает ревью",
  merged: "Принят (merged)",
  closed: "Закрыт без merge",
  locked: "Заблокирован",
  unknown: "Неизвестно",
};

export const SYNC_STATE_LABEL: Record<SyncState, string> = {
  fresh: "Актуально",
  stale: "Данные могут быть устаревшими",
  error: "Ошибка синхронизации",
  never_synced: "Ещё не синхронизировано",
};

export const SORT_LABEL: Record<DocumentSort, string> = {
  relevance: "Релевантность",
  title: "Название",
  updated: "Сначала новые",
  status: "Статус",
};

/** Titles for errors returned by POST /api/drafts/{id}/submit (and other proposal actions). */
export const PROPOSAL_ERROR_TITLE: Record<string, string> = {
  revision_conflict: "Конфликт версий: документ изменился",
  validation_failed: "Предложение не прошло проверку",
  gitlab_unavailable: "GitLab недоступен",
  gitlab_timeout: "GitLab не ответил вовремя",
  gitlab_write_uncertain: "Результат записи в GitLab не подтверждён",
  gitlab_auth_failed: "Ошибка авторизации в GitLab",
  gitlab_forbidden: "Нет прав на запись в GitLab",
  gitlab_branch_conflict: "Конфликт ветки в GitLab",
  gitlab_proposals_disabled: "Отправка в GitLab отключена",
  submission_in_progress: "Отправка уже выполняется",
  submission_uncertain: "Запись в GitLab не подтверждена",
  merge_request_missing: "Merge Request не найден в GitLab",
  invalid_transition: "Действие недоступно в текущем статусе",
};

/** Extra guidance for errors where the next step is not obvious from the message alone. */
export const PROPOSAL_ERROR_HINT: Record<string, string> = {
  submission_in_progress: "Дождитесь завершения текущей отправки и обновите статус.",
  submission_uncertain:
    "Сначала нажмите «Проверить статус в GitLab» или повторите отправку: приложение выяснит, что уже создано в GitLab.",
  gitlab_write_uncertain: "Перед повторной записью приложение проверит GitLab и не создаст дубликат.",
  revision_conflict: "Документ изменился. Создайте новое предложение на основе актуальной версии.",
};

export const STALE_DOCUMENT_LABEL = "Версия может быть устаревшей";

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

/** Short form of a revision for display: `sha256:` + 8 hex characters, or the first 8 characters of a commit. */
export function shortRevision(revision: string | null | undefined): string {
  if (!revision) return "—";
  if (revision.startsWith("sha256:")) return revision.slice(0, 15);
  return revision.length > 12 ? revision.slice(0, 8) : revision;
}

const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** `HH:MM` for today, a full date and time otherwise. */
export function formatSavedAt(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
