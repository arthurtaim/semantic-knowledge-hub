import { useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { IntegrationState, IntegrationStatus, PublisherMode, SyncStatus } from "../api/types";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { StateBadge } from "../components/StateBadge";
import {
  formatDateTime,
  INTEGRATION_ACCESS_LABEL,
  INTEGRATION_TARGET_LABEL,
  pluralRu,
  PUBLISHER_MODE_LABEL,
  SOURCE_LABEL,
  SYNC_STATE_LABEL,
} from "../lib/labels";
import { useAsync } from "../lib/useAsync";

const PUBLISHER_MODES = new Set<string>(["disabled", "dry_run_only", "write"]);
/** Failed checks first (they need attention), then connected, demo doubles; unconfigured ones last. */
const STATE_ORDER: Record<IntegrationState, number> = { error: 0, connected: 1, mock: 2, disabled: 3 };

/** Target, access and last check of one integration; a configured address alone is never shown as "green". */
function IntegrationFacts({ item }: { item: IntegrationStatus }) {
  const publisherMode: PublisherMode | null =
    item.name === "confluence_publisher"
      ? PUBLISHER_MODES.has(item.details.mode ?? "")
        ? (item.details.mode as PublisherMode)
        : "disabled"
      : null;
  return (
    <dl className="integration__facts">
      <div>
        <dt>Цель</dt>
        <dd data-target={item.target}>{INTEGRATION_TARGET_LABEL[item.target]}</dd>
      </div>
      <div>
        <dt>Доступ</dt>
        <dd data-access={item.access}>{INTEGRATION_ACCESS_LABEL[item.access]}</dd>
      </div>
      {publisherMode ? (
        <div>
          <dt>Режим публикации</dt>
          <dd data-mode={publisherMode}>{PUBLISHER_MODE_LABEL[publisherMode]}</dd>
        </div>
      ) : null}
      <div>
        <dt>Последняя проверка</dt>
        <dd>{item.checked_at ? formatDateTime(item.checked_at) : "не проверялось"}</dd>
      </div>
      {item.capabilities.length > 0 ? (
        <div>
          <dt>Возможности</dt>
          <dd className="integration__caps">
            {item.capabilities.map((cap) => (
              <code key={cap}>{cap}</code>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** One row: name, state and what it means on the left; target, access, last check and capabilities on the right. */
function IntegrationRow({ item }: { item: IntegrationStatus }) {
  return (
    <li className={`integration integration--${item.state}`}>
      <div className="integration__main">
        <div className="integration__head">
          <h2>{item.title}</h2>
          <StateBadge state={item.state} />
        </div>
        <p>{item.human_readable_message}</p>
      </div>
      <IntegrationFacts item={item} />
    </li>
  );
}

function SyncFacts({ status }: { status: SyncStatus }) {
  return (
    <dl className="sync__facts">
      <div>
        <dt>Источник</dt>
        <dd>
          {SOURCE_LABEL[status.source]}
          {status.branch ? (
            <>
              , ветка <code>{status.branch}</code>
            </>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Последняя успешная синхронизация</dt>
        <dd>{status.last_success_at ? formatDateTime(status.last_success_at) : "не было"}</dd>
      </div>
      <div>
        <dt>Последняя попытка</dt>
        <dd>{status.last_attempt_at ? formatDateTime(status.last_attempt_at) : "не было"}</dd>
      </div>
      <div>
        <dt>Документов в источнике</dt>
        <dd>{status.documents}</dd>
      </div>
      <div>
        <dt>Документов в поисковом индексе</dt>
        <dd>{status.indexed_documents}</dd>
      </div>
      <div>
        <dt>Проблемных файлов</dt>
        <dd>{status.issues}</dd>
      </div>
      {status.head_commit || status.source_version ? (
        <div>
          <dt>Версия источника</dt>
          <dd>
            <code className="doc-id">{status.head_commit ?? status.source_version}</code>
          </dd>
        </div>
      ) : null}
      {status.indexed_version ? (
        <div>
          <dt>Версия индекса</dt>
          <dd>
            <code className="doc-id">{status.indexed_version}</code>
            {status.indexed_at ? <span className="muted"> от {formatDateTime(status.indexed_at)}</span> : null}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function SyncSection() {
  const status = useAsync(() => api.indexStatus(), "index-status");
  const [pending, setPending] = useState(false);
  const [syncError, setSyncError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<string>("");
  const inFlight = useRef(false);

  async function sync() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setSyncError(null);
    setResult("");
    try {
      const next = await api.syncIndex();
      status.setData(next);
      setResult(
        next.state === "fresh"
          ? `Синхронизация завершена: ${next.indexed_documents} ${pluralRu(next.indexed_documents, "документ", "документа", "документов")} в индексе.`
          : `Синхронизация выполнена с проблемами: ${SYNC_STATE_LABEL[next.state].toLowerCase()}.`,
      );
    } catch (err) {
      setSyncError(err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const data = status.data;
  return (
    <section className="panel sync" aria-labelledby="sync-title">
      <div className="sync__head">
        <h2 id="sync-title">Синхронизация и поисковый индекс</h2>
        {data ? <span className={`sync-state sync-state--${data.state}`}>{SYNC_STATE_LABEL[data.state]}</span> : null}
      </div>
      {status.loading && !data ? <Loading label="Загрузка состояния синхронизации…" /> : null}
      {status.error && !data ? <ErrorState error={status.error} onRetry={status.reload} /> : null}
      {data ? (
        <>
          {data.message ? <p>{data.message}</p> : null}
          {data.state === "stale" || data.state === "error" ? (
            <Notice tone={data.state === "error" ? "danger" : "warning"}>
              Показанные в базе знаний документы — версии последней успешной синхронизации
              {data.last_success_at ? ` (${formatDateTime(data.last_success_at)})` : ""}. Они могут не совпадать с
              текущим состоянием источника.
            </Notice>
          ) : null}
          <SyncFacts status={data} />
          {data.failed_paths.length > 0 ? (
            <details className="sync__failed" open={data.failed_paths.length <= 5}>
              <summary>Не удалось обновить файлов: {data.failed_paths.length}</summary>
              <ul>
                {data.failed_paths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      <div className="button-row sync__actions">
        <button type="button" className="button button--secondary" onClick={sync} disabled={pending || (!data && status.loading)}>
          Синхронизировать сейчас
        </button>
      </div>
      <div aria-live="polite" role="status">
        {pending ? <p className="muted">Синхронизация выполняется…</p> : null}
        {result && !pending ? <p className="success">{result}</p> : null}
      </div>
      {syncError ? <ErrorState error={syncError} title="Синхронизация не выполнена" /> : null}
    </section>
  );
}

export function IntegrationsPage() {
  const { data, error, loading, reload } = useAsync(() => api.integrations(), "integrations");
  const issues = useAsync(() => api.issues(), "issues");
  // Stable sort: within one state the server's order is kept.
  const sorted = [...(data?.items ?? [])].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const active = sorted.filter((item) => item.state !== "disabled");
  const off = sorted.filter((item) => item.state === "disabled");

  return (
    <div className="integrations">
      <div className="page-head">
        <h1>Интеграции и источники</h1>
        <p className="lead">
          «Подключено» показывается только после реальной проверки соединения. Незаданные интеграции отключены и не
          выполняют сетевых запросов. Для каждой интеграции указано, куда она направлена (локально, тестовый дубль или
          реальный сервер) и разрешена ли запись.
        </p>
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          {active.length > 0 ? (
            <ul className="integration-list">
              {active.map((item) => (
                <IntegrationRow key={item.name} item={item} />
              ))}
            </ul>
          ) : null}
          {off.length > 0 ? (
            <>
              <h2 className="integration-group__title">Не подключено</h2>
              <ul className="integration-list integration-list--off">
                {off.map((item) => (
                  <IntegrationRow key={item.name} item={item} />
                ))}
              </ul>
            </>
          ) : null}
          <p className="muted">Проверено: {formatDateTime(data.checked_at)}</p>
        </>
      ) : null}
      <SyncSection />
      {issues.data && issues.data.length > 0 ? (
        <section aria-labelledby="issues-title">
          <h2 id="issues-title">Проблемы загрузки документов</h2>
          <Notice tone="warning">
            Эти файлы не показаны в базе знаний, пока проблема не исправлена.
          </Notice>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Файл</th>
                  <th scope="col">Проблема</th>
                </tr>
              </thead>
              <tbody>
                {issues.data.map((issue, index) => (
                  <tr key={`${issue.path}-${issue.code}-${index}`}>
                    <td>
                      <code>{issue.path}</code>
                    </td>
                    <td>{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
