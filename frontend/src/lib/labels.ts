import type {
  Confidence,
  DocStatus,
  DocType,
  DocumentPublicationState,
  DocumentSort,
  IntegrationAccess,
  IntegrationState,
  IntegrationTarget,
  MergeRequestState,
  NewDocumentStatus,
  ProposalOperation,
  ProposalStatus,
  PublicationAction,
  PublicationJobState,
  PublisherMode,
  ReviewState,
  SourceType,
  SyncState,
} from "../api/types";

/** Navigation order of knowledge sections (docs/UX.md: Product, Architecture, Domain, …). */
export const TYPE_ORDER: DocType[] = [
  "overview",
  "architecture",
  "source",
  "domain",
  "dataset",
  "integration",
  "process",
  "decision",
  "standard",
  "guide",
  "glossary",
];

export const TYPE_LABEL: Record<DocType, string> = {
  overview: "Продукт",
  architecture: "Архитектура",
  source: "Системы-источники",
  domain: "Домен",
  dataset: "Датасеты",
  integration: "Интеграции",
  process: "Процессы",
  decision: "Решения",
  standard: "Стандарты",
  guide: "Руководства",
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

/** Titles for AI provider errors (assistant answers and AI drafts); the server message is shown below the title. */
export const AI_ERROR_TITLE: Record<string, string> = {
  ai_busy: "Ассистент занят другим запросом",
  ai_auth_failed: "Нет доступа к языковой модели",
  ai_cli_unavailable: "Claude Code CLI недоступен",
  ai_unreachable: "Языковая модель недоступна",
  ai_timeout: "Модель не ответила вовремя",
  ai_rate_limited: "Превышен лимит запросов к модели",
  ai_misconfigured: "AI-провайдер настроен неверно",
  ai_invalid_response: "Модель вернула некорректный ответ",
  ai_upstream_error: "Ошибка на стороне языковой модели",
  ai_tool_use_blocked: "Ответ модели отклонён",
  invalid_stream: "Ответ сервера повреждён",
  stream_incomplete: "Ответ прервался",
  timeout: "Сервер не ответил вовремя",
};

export const MR_STATE_LABEL: Record<MergeRequestState, string> = {
  opened: "Открыт, ожидает ревью",
  merged: "Принят (merged)",
  closed: "Закрыт без merge",
  locked: "Заблокирован",
  unknown: "Неизвестно",
};

/** Where an integration points (never "green" just because an address is configured). */
export const INTEGRATION_TARGET_LABEL: Record<IntegrationTarget, string> = {
  none: "Не настроено",
  local: "Локально",
  mock: "Тестовый дубль (mock)",
  real: "Реальный сервер — live validation не проводилась",
};

export const INTEGRATION_ACCESS_LABEL: Record<IntegrationAccess, string> = {
  none: "не используется",
  read: "только чтение",
  write: "запись",
  read_write: "чтение и запись",
};

// --- publication to Confluence (M5) ---

/** Publication state of a document (document page). Independent of the proposal and MR states. */
export const PUBLICATION_STATE_LABEL: Record<DocumentPublicationState, string> = {
  disabled: "Не настроена",
  not_published: "Не публиковался",
  pending: "Ожидает предпросмотра",
  validating: "Идёт предпросмотр",
  dry_run_ready: "Предпросмотр готов",
  publishing: "Публикуется",
  published: "Опубликован",
  outdated: "Опубликована прежняя ревизия",
  conflict: "Конфликт",
  failed: "Ошибка публикации",
  result_unknown: "Результат не подтверждён",
};

export const PUBLICATION_JOB_STATE_LABEL: Record<PublicationJobState, string> = {
  pending: "Ожидает предпросмотра",
  validating: "Идёт предпросмотр",
  dry_run_ready: "Предпросмотр готов",
  publishing: "Публикуется",
  published: "Опубликовано",
  conflict: "Конфликт",
  failed: "Ошибка публикации",
  result_unknown: "Результат не подтверждён",
  superseded: "Заменено новой ревизией",
};

export const PUBLISHER_MODE_LABEL: Record<PublisherMode, string> = {
  disabled: "публикация не настроена",
  dry_run_only: "только предпросмотр (запись в Confluence выключена)",
  write: "запись разрешена",
};

/** The publication action in words; `published` jobs use the past tense. */
export function publicationActionText(
  action: PublicationAction | null,
  opts: { pageId?: string | null; remoteVersion?: number | null; done?: boolean } = {},
): string {
  const { pageId, remoteVersion, done = false } = opts;
  switch (action) {
    case "create":
      return done ? "Создана новая страница" : "Будет создана новая страница";
    case "update": {
      const page = pageId ? `страница ${pageId}` : "страница";
      const versions = remoteVersion != null ? ` (версия ${remoteVersion} → ${remoteVersion + 1})` : "";
      return `${done ? "Обновлена" : "Будет обновлена"} ${page}${versions}`;
    }
    case "noop":
      return "Изменений нет — новая версия не создаётся";
    case "conflict":
      return "Конфликт — страница не будет изменена";
    default:
      return "Ещё не определено: нужен предпросмотр";
  }
}

/** Labels for PublicationEvent.action; unknown actions fall back to the raw value. */
export const PUBLICATION_EVENT_LABEL: Record<string, string> = {
  job_created: "Создано задание публикации",
  superseded: "Заменено заданием для новой ревизии",
  dry_run: "Выполнен предпросмотр (dry-run)",
  plan_changed: "Предпросмотр устарел и обновлён",
  publish_started: "Начата запись в Confluence",
  publish_failed: "Запись не выполнена",
  result_unknown: "Ответ Confluence не получен",
  conflict: "Обнаружен конфликт",
  published_create: "Создана страница в Confluence",
  published_update: "Обновлена страница в Confluence",
  published_noop: "Изменений нет — версия не создавалась",
  write_confirmed_after_lost_answer: "Запись подтверждена после потерянного ответа",
  write_confirmed_on_check: "Запись подтверждена проверкой в Confluence",
  manual_edit_acknowledged: "Ручная правка подтверждена",
};

/** Extra guidance for blocking problems and warnings of a publication preview (the server message comes first). */
export const PUBLICATION_ISSUE_HINT: Record<string, string> = {
  not_merged: "Публикуются только изменения, merge которых подтверждён в GitLab.",
  status_not_publishable: "Публикуются только документы с разрешённым статусом (обычно «Утверждён»).",
  revision_superseded: "Вернитесь на страницу документа и подготовьте публикацию для актуальной ревизии.",
  space_not_found: "Проверьте пространство публикации в настройках и права сервисной учётной записи.",
  parent_not_found: "Проверьте родительскую страницу публикации в настройках.",
  unsafe_link: "Исправьте ссылку в документе через предложение изменения.",
  manual_edit: "Перенесите правку в GitLab или подтвердите её — см. блок ниже.",
  foreign_page: "Страница без метки приложения не изменяется. Разберитесь с ней в Confluence.",
  title_taken: "Переименуйте документ или существующую страницу в Confluence.",
  mapped_page_missing: "Восстановите страницу в Confluence или обратитесь к администратору.",
  page_moved: "Верните страницу в пространство публикации или обратитесь к администратору.",
  image_not_published: "Картинки остаются в GitLab; на странице будет текстовая отметка.",
  diagram_as_code: "Диаграмма будет видна как исходный код.",
  frontmatter_page_id_ignored: "Страница выбирается только по привязке приложения.",
};

/** Titles for publication API errors and job error codes. */
export const PUBLICATION_ERROR_TITLE: Record<string, string> = {
  confluence_auth_failed: "Ошибка авторизации в Confluence",
  confluence_forbidden: "Нет прав на запись в Confluence",
  confluence_unavailable: "Confluence недоступен",
  confluence_timeout: "Confluence не ответил вовремя",
  confluence_write_uncertain: "Результат записи в Confluence не подтверждён",
  interrupted: "Публикация прервана перезапуском",
  publication_disabled: "Публикация в Confluence не настроена",
  publish_disabled: "Запись в Confluence выключена",
  plan_changed: "Предпросмотр устарел",
  publication_in_progress: "Публикация уже выполняется",
  publication_job_not_found: "Задание публикации не найдено",
  invalid_transition: "Действие недоступно в текущем состоянии",
};

export const PUBLICATION_ERROR_HINT: Record<string, string> = {
  confluence_auth_failed: "Обратитесь к администратору: проверьте учётную запись публикации.",
  confluence_forbidden: "Обратитесь к администратору: проверьте права в пространстве публикации.",
  confluence_unavailable: "Повторите позже. Ничего не записано.",
  confluence_timeout: "Повторите позже. Перед повторной записью приложение проверит Confluence.",
  confluence_write_uncertain:
    "Нажмите «Проверить результат»: приложение сначала проверит Confluence и не создаст дубликат страницы.",
  interrupted: "Нажмите «Проверить результат»: приложение выяснит, была ли запись выполнена.",
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
