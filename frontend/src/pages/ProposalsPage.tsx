import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ProposalStatus } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { formatDateTime, PROPOSAL_STATUS_LABEL } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

const FILTERS: { value: ProposalStatus | ""; label: string }[] = [
  { value: "", label: "Все" },
  { value: "open", label: PROPOSAL_STATUS_LABEL.open },
  { value: "ready_for_review", label: PROPOSAL_STATUS_LABEL.ready_for_review },
  { value: "submitted", label: PROPOSAL_STATUS_LABEL.submitted },
  { value: "rejected", label: PROPOSAL_STATUS_LABEL.rejected },
];

export function ProposalsPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "") as ProposalStatus | "";
  const { data, error, loading, reload } = useAsync(
    () => api.drafts(status ? { status } : {}),
    `drafts-${status}`,
  );

  return (
    <div className="proposals">
      <div className="page-head">
        <h1>Предложения изменений</h1>
        <p className="lead">
          Все правки проходят через предложения: они хранятся локально и не меняют документы до ревью и merge в
          GitLab.
        </p>
      </div>
      <div className="tabs" role="tablist" aria-label="Фильтр по статусу">
        {FILTERS.map((filter) => (
          <button
            key={filter.value || "all"}
            type="button"
            role="tab"
            aria-selected={status === filter.value}
            onClick={() => setParams(filter.value ? { status: filter.value } : {})}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && data.items.length === 0 ? (
        <EmptyState title="Предложений пока нет">
          <p>Откройте документ и нажмите «Предложить изменение», чтобы подготовить правку с diff.</p>
          <Link to="/documents" className="button button--secondary">
            Перейти к документам
          </Link>
        </EmptyState>
      ) : null}
      {data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Документ</th>
                <th scope="col">Причина</th>
                <th scope="col">Статус</th>
                <th scope="col">Изменения</th>
                <th scope="col">Проверка</th>
                <th scope="col">Создано</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/proposals/${p.id}`}>{p.document_title}</Link>
                    <code className="doc-id doc-id--block">{p.document_id}</code>
                  </td>
                  <td>{p.reason}</td>
                  <td>
                    <span className={`proposal-state proposal-state--${p.status}`}>{PROPOSAL_STATUS_LABEL[p.status]}</span>
                  </td>
                  <td>
                    <span className="diff__add">+{p.additions}</span> <span className="diff__del">−{p.deletions}</span>
                  </td>
                  <td>
                    {p.error_count > 0 ? (
                      <span className="flag">Ошибок: {p.error_count}</span>
                    ) : p.warning_count > 0 ? (
                      <span>Предупреждений: {p.warning_count}</span>
                    ) : (
                      <span>Пройдена</span>
                    )}
                  </td>
                  <td>{formatDateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
