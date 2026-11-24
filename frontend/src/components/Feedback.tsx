import type { ReactNode } from "react";
import type { ApiError } from "../api/client";

export function Loading({ label = "Загрузка…" }: { label?: string }) {
  return (
    <p className="feedback feedback--loading" role="status" aria-live="polite">
      {label}
    </p>
  );
}

interface ErrorStateProps {
  error: ApiError;
  onRetry?: () => void;
  retryLabel?: string;
  title?: string;
  /** The error replaces the whole page: its title is the page's H1 (WCAG 1.3.1, 2.4.6). */
  page?: boolean;
}

/** Title of a feedback block: the page H1 when the block is the whole page, a paragraph otherwise. */
function FeedbackTitle({ page, children }: { page?: boolean; children: ReactNode }) {
  return page ? (
    <h1 className="feedback__title feedback__title--page">{children}</h1>
  ) : (
    <p className="feedback__title">{children}</p>
  );
}

export function ErrorState({ error, onRetry, retryLabel = "Повторить", title, page }: ErrorStateProps) {
  return (
    <div className="feedback feedback--error" role="alert">
      <FeedbackTitle page={page}>{title ?? errorTitle(error)}</FeedbackTitle>
      <p>{error.message}</p>
      {error.requestId ? <p className="feedback__meta">Код запроса: <code>{error.requestId}</code></p> : null}
      {onRetry ? (
        <button type="button" className="button button--secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

function errorTitle(error: ApiError): string {
  if (error.status === 0) return "Сервер недоступен";
  if (error.status === 403) return "Действие запрещено";
  if (error.status === 404) return "Не найдено";
  if (error.status === 409) return "Конфликт версий";
  if (error.status === 422) return "Данные не прошли проверку";
  if (error.status === 503) return "Интеграция недоступна";
  return "Не удалось выполнить запрос";
}

export function EmptyState({ title, children, page }: { title: string; children?: ReactNode; page?: boolean }) {
  return (
    <div className="feedback feedback--empty">
      <FeedbackTitle page={page}>{title}</FeedbackTitle>
      {children}
    </div>
  );
}

export function Notice({
  tone,
  children,
  className,
}: {
  tone: "info" | "warning" | "danger" | "success";
  children: ReactNode;
  className?: string;
}) {
  return <div className={`notice notice--${tone}${className ? ` ${className}` : ""}`}>{children}</div>;
}
