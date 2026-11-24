import { Link } from "react-router-dom";
import { ATTENTION_NODE } from "../../lib/docTree";
import { pluralRu } from "../../lib/labels";
import type { DocumentTreeState } from "../../lib/useDocumentTree";
import { ErrorState, Loading } from "../Feedback";

/**
 * «Обзор» — for now the sections with their totals and the documents that need attention, every number from
 * GET /api/documents/tree. The matrix «разделы × состояние» and «Что сделать» (docs/ui-v2/documents/specs/
 * DOCUMENTS_V2.md §2) replace this table; a section opens «Список» on that section.
 */
export function DocsOverview({ tree }: { tree: DocumentTreeState }) {
  if (tree.error) return <ErrorState error={tree.error} onRetry={tree.reload} />;
  if (!tree.index) return <Loading />;
  const { index } = tree;
  const total = index.tree.total;
  const attention = index.tree.attention_total;
  return (
    <section className="docs-overview" aria-labelledby="docs-overview-title">
      <h2 id="docs-overview-title" className="docs-overview__title">
        {total} {pluralRu(total, "документ", "документа", "документов")}
        {attention > 0 ? (
          <Link to={`/documents?view=list&node=${ATTENTION_NODE}`} className="docs-overview__attention">
            {attention} {pluralRu(attention, "требует", "требуют", "требуют")} внимания
          </Link>
        ) : null}
      </h2>
      <table className="docs-overview__table">
        <caption className="visually-hidden">Разделы базы знаний</caption>
        <thead>
          <tr>
            <th scope="col">Раздел</th>
            <th scope="col" className="docs-overview__num">
              Всего
            </th>
            <th scope="col" className="docs-overview__num">
              Требуют внимания
            </th>
          </tr>
        </thead>
        <tbody>
          {index.sections.map((section) => (
            <tr key={section.key}>
              <th scope="row">
                <Link to={`/documents?view=list&node=${encodeURIComponent(section.key)}`}>{section.label}</Link>
              </th>
              <td className="docs-overview__num">{section.count}</td>
              <td className={section.attention > 0 ? "docs-overview__num" : "docs-overview__num docs-overview__none"}>
                {section.attention > 0 ? section.attention : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
