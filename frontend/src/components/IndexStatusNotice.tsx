import { Link } from "react-router-dom";
import type { SyncStatus } from "../api/types";
import { formatDateTime, SOURCE_LABEL } from "../lib/labels";
import { Notice } from "./Feedback";

/**
 * Plain-language warning when the knowledge index is not fresh. Documents shown in that state are the
 * last successfully synced versions and must never be presented as current.
 */
export function IndexStatusNotice({ status, detailsLink = true }: { status: SyncStatus; detailsLink?: boolean }) {
  if (status.state === "fresh") return null;
  const source = SOURCE_LABEL[status.source];
  const lastSuccess = status.last_success_at ? formatDateTime(status.last_success_at) : null;
  const link = detailsLink ? (
    <Link to="/integrations" className="text-link">
      Состояние синхронизации
    </Link>
  ) : null;

  if (status.state === "never_synced") {
    return (
      <Notice tone="warning">
        <p>
          <strong>Источник ещё не синхронизирован.</strong> Документы из источника «{source}» пока не загружены в
          поисковый индекс.
        </p>
        {link}
      </Notice>
    );
  }
  return (
    <Notice tone={status.state === "error" ? "danger" : "warning"}>
      <p>
        <strong>{status.state === "error" ? "Синхронизация не удалась." : "Данные могут быть устаревшими."}</strong>{" "}
        {lastSuccess
          ? `Источник «${source}» сейчас недоступен или обновлён не полностью. Показаны версии документов на момент последней успешной синхронизации (${lastSuccess}) — они могут не совпадать с текущими.`
          : `Источник «${source}» недоступен, успешной синхронизации ещё не было.`}
      </p>
      {status.message ? <p className="muted">{status.message}</p> : null}
      {link}
    </Notice>
  );
}
