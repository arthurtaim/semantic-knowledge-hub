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
}

export function ErrorState({ error, onRetry, retryLabel = "Повторить", title }: ErrorStateProps) {
  return (
    <div className="feedback feedback--error" role="alert">
      <p className="feedback__title">{title ?? errorTitle(error)}</p>
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

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="feedback feedback--empty">
      <p className="feedback__title">{title}</p>
      {children}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "info" | "warning" | "danger"; children: ReactNode }) {
  return <div className={`notice notice--${tone}`}>{children}</div>;
}
