import { api } from "../api/client";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { StateBadge } from "../components/StateBadge";
import { formatDateTime } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

export function IntegrationsPage() {
  const { data, error, loading, reload } = useAsync(() => api.integrations(), "integrations");
  const issues = useAsync(() => api.issues(), "issues");

  return (
    <div className="integrations">
      <div className="page-head">
        <h1>Интеграции и источники</h1>
        <p className="lead">
          «Подключено» показывается только после реальной проверки соединения. Незаданные интеграции отключены и не
          выполняют сетевых запросов.
        </p>
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <ul className="integration-list">
            {data.items.map((item) => (
              <li key={item.name} className={`integration integration--${item.state}`}>
                <div className="integration__head">
                  <h2>{item.title}</h2>
                  <StateBadge state={item.state} />
                </div>
                <p>{item.human_readable_message}</p>
                {item.capabilities.length > 0 ? (
                  <p className="integration__caps">
                    Возможности:{" "}
                    {item.capabilities.map((cap) => (
                      <code key={cap}>{cap}</code>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="muted">Проверено: {formatDateTime(data.checked_at)}</p>
        </>
      ) : null}
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
