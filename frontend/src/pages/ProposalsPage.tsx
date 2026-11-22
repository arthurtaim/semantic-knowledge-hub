import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ProposalStatus } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { MergeRequestStateLabel, ProposalStateLabel } from "../components/ProposalState";
import { formatDateTime, PROPOSAL_STATUS_LABEL, PROPOSAL_STATUS_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

const FILTERS: { value: ProposalStatus | ""; label: string }[] = [
  { value: "", label: "Все" },
  ...PROPOSAL_STATUS_ORDER.map((value) => ({ value, label: PROPOSAL_STATUS_LABEL[value] })),
];

const KNOWN = new Set<string>(PROPOSAL_STATUS_ORDER);
const isHttpUrl = (value: string | null): value is string => Boolean(value && /^https?:\/\//i.test(value));

export function ProposalsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("status") ?? "";
  const status = (KNOWN.has(raw) ? raw : "") as ProposalStatus | "";
  const { data, error, loading, reload } = useAsync(
    () => api.drafts(status ? { status } : {}),
    `drafts-${status}`,
  );

  return (
    <div className="proposals">
      <div className="page-head">
        <h1>Предложения изменений</h1>
        <p className="lead">
          Все правки проходят через предложения: они не меняют документы до ревью и merge в GitLab. «Готово к ревью» и
          открытый MR — это ещё не merge.
        </p>
      </div>
      <div className="filter-chips" role="group" aria-label="Фильтр по статусу">
        {FILTERS.map((filter) => (
          <button
            key={filter.value || "all"}
            type="button"
            className="filter-chip"
            aria-pressed={status === filter.value}
            onClick={() => setParams(filter.value ? { status: filter.value } : {})}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {loading && !data ? <Loading /> : null}
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
      </div>
      {data && data.items.length === 0 ? (
        <EmptyState title={status ? `Нет предложений со статусом «${PROPOSAL_STATUS_LABEL[status]}»` : "Предложений пока нет"}>
          <p>Откройте документ и нажмите «Предложить изменение», чтобы подготовить правку с diff.</p>
          <div className="button-row">
            <Link to="/documents" className="button button--secondary">
              Перейти к документам
            </Link>
            {status ? (
              <button type="button" className="button button--ghost" onClick={() => setParams({})}>
                Показать все предложения
              </button>
            ) : null}
          </div>
        </EmptyState>
      ) : null}
      {data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Предложения изменений</caption>
            <thead>
              <tr>
                <th scope="col">Документ</th>
                <th scope="col">Причина</th>
                <th scope="col">Статус</th>
                <th scope="col">Merge Request</th>
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
                    <ProposalStateLabel status={p.status} />
                  </td>
                  <td>
                    {p.merge_request_url || p.merge_request_state ? (
                      <span className="mr-cell">
                        {p.merge_request_state ? <MergeRequestStateLabel state={p.merge_request_state} /> : null}
                        {isHttpUrl(p.merge_request_url) ? (
                          <a
                            href={p.merge_request_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Открыть MR в GitLab: ${p.document_title}`}
                          >
                            Открыть MR <span aria-hidden="true">↗</span>
                          </a>
                        ) : null}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
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
