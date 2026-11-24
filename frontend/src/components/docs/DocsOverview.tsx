import { useId, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DocStatus } from "../../api/types";
import { NODE_PARAM } from "../../lib/docsView";
import {
  approvedShare,
  buildOverview,
  cellHref,
  cellLabel,
  COLUMN_BY_KEY,
  OVERVIEW_COLUMNS,
  TODO_LIMIT,
  todoGroups,
  todoNote,
  type OverviewColumnSpec,
  type OverviewRow,
  type TodoGroup,
} from "../../lib/docsOverview";
import { tableHref } from "../../lib/docsTable";
import type { TreeIndex } from "../../lib/docTree";
import { pluralRu, STATUS_LABEL } from "../../lib/labels";
import type { DocumentTreeState } from "../../lib/useDocumentTree";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { ErrorState, Loading } from "../Feedback";

/*
 * «Обзор» of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §2, design docs-03): the totals, the matrix
 * «разделы × состояние» and «Что сделать». Every number is counted from GET /api/documents/tree (lib/docsOverview.ts).
 * A number opens «Таблица» filtered by its section and column; a section opens «Список» on that section. On a
 * phone the matrix becomes a list of sections with the non-zero states as chips (no sideways scrolling).
 */

/** Phones: the matrix as a list of sections. */
const PHONE = "(max-width: 719.98px)";

const docHref = (id: string) => `/documents/${encodeURIComponent(id)}`;
const listHref = (section: string) => `/documents?view=list&${NODE_PARAM}=${encodeURIComponent(section)}`;

/** The coloured columns (a chip of the status tone); «Всего» and «Утверждено» are plain numbers. */
const CHIP_COLUMNS = OVERVIEW_COLUMNS.filter((column) => column.key !== "total" && column.key !== "approved");

function Cell({ row, column }: { row: OverviewRow; column: OverviewColumnSpec }) {
  const count = row.counts[column.key];
  const label = cellLabel(row, column);
  if (count === 0) {
    return (
      <>
        <span className="docs-matrix__zero" aria-hidden="true">
          —
        </span>
        <span className="visually-hidden">{label}</span>
      </>
    );
  }
  const plain = column.key === "total" || column.key === "approved";
  return (
    <Link
      to={cellHref(row, column)}
      className={plain ? "docs-matrix__num" : `docs-matrix__chip docs-matrix__chip--${column.key}`}
      aria-label={label}
    >
      {count}
    </Link>
  );
}

function ApprovedCell({ row }: { row: OverviewRow }) {
  return (
    <span className="docs-matrix__approved">
      <span className="docs-matrix__approved-num">
        <Cell row={row} column={COLUMN_BY_KEY.approved} />
      </span>
      <span className="docs-matrix__bar" aria-hidden="true">
        <span style={{ width: `${approvedShare(row)}%` }} />
      </span>
    </span>
  );
}

function Matrix({ rows, total }: { rows: OverviewRow[]; total: OverviewRow }) {
  return (
    <div className="docs-matrix-wrap">
      <table className="docs-matrix">
        <caption className="visually-hidden">Документы по разделам и состояниям</caption>
        <colgroup>
          <col className="docs-matrix__col-section" />
          <col className="docs-matrix__col-total" />
          <col className="docs-matrix__col-approved" />
          {CHIP_COLUMNS.map((column) => (
            <col key={column.key} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Раздел</th>
            {OVERVIEW_COLUMNS.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <Link to={listHref(row.key ?? "")} className="docs-matrix__section">
                  {row.label}
                </Link>
              </th>
              <td>
                <Cell row={row} column={COLUMN_BY_KEY.total} />
              </td>
              <td>
                <ApprovedCell row={row} />
              </td>
              {CHIP_COLUMNS.map((column) => (
                <td key={column.key}>
                  <Cell row={row} column={column} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{total.label}</th>
            <td>
              <Cell row={total} column={COLUMN_BY_KEY.total} />
            </td>
            <td>
              <Cell row={total} column={COLUMN_BY_KEY.approved} />
            </td>
            {CHIP_COLUMNS.map((column) => (
              <td key={column.key}>
                <Cell row={total} column={column} />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Phones: one item per section — its name (→ «Список»), the approved share, then the non-zero states as chips. */
function SectionList({ rows }: { rows: OverviewRow[] }) {
  return (
    <ul className="docs-matrix-list" aria-label="Документы по разделам и состояниям">
      {rows.map((row) => {
        const chips = CHIP_COLUMNS.filter((column) => row.counts[column.key] > 0);
        return (
          <li key={row.key} className="docs-matrix-list__item">
            <div className="docs-matrix-list__head">
              <Link to={listHref(row.key ?? "")} className="docs-matrix__section">
                {row.label}
              </Link>
              <Link to={cellHref(row, COLUMN_BY_KEY.total)} className="docs-matrix__num" aria-label={cellLabel(row, COLUMN_BY_KEY.total)}>
                {row.counts.total}
              </Link>
            </div>
            <div className="docs-matrix-list__approved">
              <span>
                {row.counts.approved} из {row.counts.total} утверждено
              </span>
              <span className="docs-matrix__bar" aria-hidden="true">
                <span style={{ width: `${approvedShare(row)}%` }} />
              </span>
            </div>
            {chips.length > 0 ? (
              <ul className="docs-matrix-list__chips" aria-label={`${row.label}: требуют внимания`}>
                {chips.map((column) => (
                  <li key={column.key}>
                    <Link
                      to={cellHref(row, column)}
                      className={`docs-matrix__chip docs-matrix__chip--${column.key}`}
                      aria-label={cellLabel(row, column)}
                    >
                      {column.short}: {row.counts[column.key]}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The leading mark of a «Что сделать» row: the group's shape (a dot in review, a red dot without an owner…). */
function TodoShape({ group, status }: { group: TodoGroup["key"]; status: DocStatus }) {
  const kind = group === "drafts" ? status : group;
  return <span className={`docs-todo__shape docs-todo__shape--${kind}`} aria-hidden="true" />;
}

function Todo({ index, groups }: { index: TreeIndex; groups: TodoGroup[] }) {
  const titleId = useId();
  const attention = index.tree.attention_total;
  return (
    <aside className="docs-todo" aria-labelledby={titleId}>
      <h2 id={titleId} className="docs-todo__title">
        Что сделать
      </h2>
      {attention > 0 ? (
        <p className="docs-todo__lead">
          {attention} {pluralRu(attention, "документ", "документа", "документов")}, сгруппированы по действию
        </p>
      ) : (
        <p className="docs-todo__lead">Сейчас ни один документ не требует внимания.</p>
      )}
      {groups.map((group) => {
        const shown = group.ids.slice(0, TODO_LIMIT);
        const rest = group.ids.length - shown.length;
        return (
          <section key={group.key} className="docs-todo__group" aria-labelledby={`${titleId}-${group.key}`}>
            <h3 id={`${titleId}-${group.key}`} className="docs-todo__group-title">
              <span>{group.title}</span>
              <span className="docs-todo__count">
                {group.ids.length}
                {group.key === "recheck" ? ` ${pluralRu(group.ids.length, "утверждённый", "утверждённых", "утверждённых")}` : ""}
              </span>
            </h3>
            <ul className="docs-todo__list">
              {shown.map((id) => {
                const entry = index.tree.documents[id];
                if (!entry) return null;
                return (
                  <li key={id}>
                    <Link to={docHref(id)} className="docs-todo__row" title={entry.title}>
                      <TodoShape group={group.key} status={entry.status} />
                      <span className="docs-todo__name">{entry.title}</span>
                      {/* drafts and deprecated: the status in words next to its shape (not by colour alone) */}
                      <span className="docs-todo__note">{group.key === "drafts" ? STATUS_LABEL[entry.status] : todoNote(index, group.key, id)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {rest > 0 ? (
              <Link to={group.href} className="docs-todo__more" aria-label={`${group.title}: ещё ${rest} в таблице`}>
                Ещё {rest}
              </Link>
            ) : null}
          </section>
        );
      })}
    </aside>
  );
}

export function DocsOverview({ tree, notice }: { tree: DocumentTreeState; notice?: ReactNode }) {
  const titleId = useId();
  const phone = useMediaQuery(PHONE);
  const index = tree.index;
  const overview = useMemo(() => (index ? buildOverview(index) : null), [index]);
  const groups = useMemo(() => (index ? todoGroups(index) : []), [index]);

  if (tree.error) return <ErrorState error={tree.error} onRetry={tree.reload} />;
  if (!index || !overview) return <Loading />;
  const { documents, attention, total } = overview;
  const approved = total.counts.approved;

  return (
    <div className="docs-overview">
      <section className="docs-overview__main" aria-labelledby={titleId}>
        {notice}
        <div className="docs-overview__head">
          <h2 id={titleId} className="docs-overview__title">
            {documents} {pluralRu(documents, "документ", "документа", "документов")}, {approved}{" "}
            {pluralRu(approved, "утверждён", "утверждены", "утверждены")}
          </h2>
          {attention > 0 ? (
            <Link to={tableHref({ attention: true })} className="docs-overview__attention">
              {attention} {pluralRu(attention, "требует", "требуют", "требуют")} внимания
            </Link>
          ) : (
            <span className="docs-overview__calm">Внимания не требует ни один документ</span>
          )}
        </div>
        <p className="docs-overview__hint">
          Строки — разделы, столбцы — состояние. Нажмите на число, чтобы открыть эти документы в таблице. Один документ может
          попасть в несколько столбцов.
        </p>
        {phone ? <SectionList rows={overview.rows} /> : <Matrix rows={overview.rows} total={total} />}
      </section>
      <Todo index={index} groups={groups} />
    </div>
  );
}
