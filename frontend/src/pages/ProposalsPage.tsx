import type { MouseEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ProposalStatus, ProposalSummary } from "../api/types";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { MergeRequestStateLabel, OperationBadge, ProposalStateLabel } from "../components/ProposalState";
import { PROPOSAL_STATUS_LABEL, PROPOSAL_STATUS_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { useMediaQuery } from "../lib/useMediaQuery";
import { When } from "../components/When";
import { PageToolbar } from "../components/shell/PageToolbar";
import { buttonClass } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";

const FILTERS: { value: ProposalStatus | ""; label: string }[] = [
  { value: "", label: "Все" },
  ...PROPOSAL_STATUS_ORDER.map((value) => ({ value, label: PROPOSAL_STATUS_LABEL[value] })),
];

const KNOWN = new Set<string>(PROPOSAL_STATUS_ORDER);
const isHttpUrl = (value: string | null): value is string => Boolean(value && /^https?:\/\//i.test(value));

/** Phones: card rows instead of the table, as in the catalog (docs/ui-v2/specs/03_SCREENS.md §6). */
const PHONE = "(max-width: 719.98px)";

function MergeRequestCell({ p }: { p: ProposalSummary }) {
  if (!p.merge_request_url && !p.merge_request_state) return <span className="muted">—</span>;
  return (
    <span className="mr-cell">
      {p.merge_request_state ? <MergeRequestStateLabel state={p.merge_request_state} /> : null}
      {isHttpUrl(p.merge_request_url) ? (
        <a href={p.merge_request_url} target="_blank" rel="noopener noreferrer" aria-label={`Открыть MR в GitLab: ${p.document_title}`}>
          Открыть MR <span aria-hidden="true">↗</span>
        </a>
      ) : null}
    </span>
  );
}

function ChangesCell({ p }: { p: ProposalSummary }) {
  return (
    <>
      <span className="diff__add">+{p.additions}</span> <span className="diff__del">−{p.deletions}</span>
    </>
  );
}

function CheckCell({ p }: { p: ProposalSummary }) {
  if (p.error_count > 0) return <span className="flag">Ошибок: {p.error_count}</span>;
  if (p.warning_count > 0) return <span>Предупреждений: {p.warning_count}</span>;
  return <span>Пройдена</span>;
}

/** One proposal as a card row (phones): title and ID, then the facts of the table's columns, then the reason. */
function ProposalCard({ p }: { p: ProposalSummary }) {
  const navigate = useNavigate();
  // The whole row opens the proposal for a pointer; the title link is the keyboard and screen-reader path.
  const open = (event: MouseEvent<HTMLLIElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    navigate(`/proposals/${p.id}`);
  };
  return (
    <li className="proposal-card" onClick={open}>
      <span className="proposal-card__title">
        <Link to={`/proposals/${p.id}`}>{p.document_title}</Link>
        <code className="doc-id">{p.document_id}</code>
      </span>
      <span className="proposal-card__meta">
        <ProposalStateLabel status={p.status} />
        <OperationBadge operation={p.operation} />
        <span>
          <span className="visually-hidden">Изменения: </span>
          <ChangesCell p={p} />
        </span>
        <CheckCell p={p} />
        <When value={p.created_at} />
      </span>
      {p.reason ? <span className="proposal-card__reason">{p.reason}</span> : null}
      {p.merge_request_url || p.merge_request_state ? (
        <span className="proposal-card__meta">
          <span>Merge Request:</span>
          <MergeRequestCell p={p} />
        </span>
      ) : null}
    </li>
  );
}

function routeNotice(state: unknown): string | null {
  if (state && typeof state === "object" && "notice" in state && typeof state.notice === "string") return state.notice;
  return null;
}

export function ProposalsPage() {
  const [params, setParams] = useSearchParams();
  // e.g. "Черновик удалён" after deleting a draft on another page
  const notice = routeNotice(useLocation().state);
  const raw = params.get("status") ?? "";
  const status = (KNOWN.has(raw) ? raw : "") as ProposalStatus | "";
  const phone = useMediaQuery(PHONE);
  const { data, error, loading, reload } = useAsync(
    () => api.drafts(status ? { status } : {}),
    `drafts-${status}`,
  );

  return (
    <div className="proposals">
      <PageToolbar
        title="Предложения"
        meta={data ? <span className="page-toolbar__count">{data.total}</span> : null}
        actions={
          <Link to="/documents/new" className={buttonClass("secondary", "md", "button--collapsible button--with-icon")}>
            <Icon name="plus" />
            <span className="button__label">Создать документ</span>
          </Link>
        }
      />
      <div className="page-head">
        <h1>Предложения</h1>
        <p className="lead">
          Все правки проходят через предложения: они не меняют документы до ревью и merge в GitLab. «Готово к ревью» и
          открытый MR — это ещё не merge.
        </p>
      </div>
      {notice ? (
        <div role="status">
          <Notice tone="success">{notice}</Notice>
        </div>
      ) : null}
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
          <p>
            Откройте документ и нажмите «Предложить изменение», чтобы подготовить правку с diff, или создайте новый
            документ.
          </p>
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
      {data && data.items.length > 0 && phone ? (
        <ul className="proposal-cards" aria-label="Предложения изменений">
          {data.items.map((p) => (
            <ProposalCard key={p.id} p={p} />
          ))}
        </ul>
      ) : null}
      {data && data.items.length > 0 && !phone ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Предложения изменений</caption>
            <thead>
              <tr>
                <th scope="col">Документ</th>
                <th scope="col">Операция</th>
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
                  <td>
                    <OperationBadge operation={p.operation} />
                  </td>
                  <td>{p.reason}</td>
                  <td>
                    <ProposalStateLabel status={p.status} />
                  </td>
                  <td>
                    <MergeRequestCell p={p} />
                  </td>
                  <td>
                    <ChangesCell p={p} />
                  </td>
                  <td>
                    <CheckCell p={p} />
                  </td>
                  <td>
                    <When value={p.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
