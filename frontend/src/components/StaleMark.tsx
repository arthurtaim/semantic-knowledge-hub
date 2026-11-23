import { STALE_DOCUMENT_LABEL } from "../lib/labels";

/** Marks a document the last sync could not refresh: it is shown with its last known revision. */
export function StaleMark() {
  return (
    <span className="stale-mark" title="Последняя синхронизация не смогла обновить документ — показана последняя известная ревизия.">
      {STALE_DOCUMENT_LABEL}
    </span>
  );
}
