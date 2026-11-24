import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { DocumentTreeEntry } from "../../api/types";
import { handOff } from "../../lib/conversation";
import { pathLabel, reviewMark, type TreeIndex } from "../../lib/docTree";
import { pluralRu, TYPE_LABEL } from "../../lib/labels";
import { useAsync } from "../../lib/useAsync";
import type { RecentHandOff } from "../../pages/HomePage";
import { Button, buttonClass } from "../ui/Button";
import { StatusMark } from "../ui/StatusMark";

/*
 * The right column of «Список» (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §1 «Предпросмотр», design docs-01):
 * the document from GET /api/documents/{id} — status, ID, version, the title (a link to the document), summary,
 * «Открыть» / «Спросить ассистента» / «Предложить изменение» (all secondary: the view's one primary is «Создать
 * документ» in the toolbar — the owner's decision), its place in the tree, systems, owner, review, links (the tree's
 * `link_count`, a link to the document's «Связи»), tags and its level-2 sections. A skeleton while it loads; a
 * short error with «Повторить».
 */

const docHref = (id: string) => `/documents/${encodeURIComponent(id)}`;

/** «Спросить ассистента»: a new dialog with this document as its context, as if chosen with «@» (not sent). */
export function askAboutDocument(navigate: (to: string) => void, id: string, title: string): void {
  handOff<RecentHandOff>({
    recent: {
      question: "",
      at: null,
      skill: null,
      sources: null,
      context: title,
      conversationId: null,
      attachments: [],
      documents: [{ id, title }],
    },
  });
  navigate("/ask");
}

function linksText(count: number): string {
  return count === 0 ? "нет связей" : `${count} ${pluralRu(count, "документ", "документа", "документов")}`;
}

function Skeleton() {
  return (
    <div className="doc-preview__skeleton" aria-hidden="true">
      <span className="doc-preview__bone doc-preview__bone--short" />
      <span className="doc-preview__bone doc-preview__bone--title" />
      <span className="doc-preview__bone" />
      <span className="doc-preview__bone" />
      <span className="doc-preview__bone doc-preview__bone--short" />
    </div>
  );
}

interface DocPreviewProps {
  id: string;
  /** The tree: the document's place, systems, review and links (counts from the API). */
  index: TreeIndex | null;
  /** Whether the assistant can be asked (AI on). */
  canAskAssistant: boolean;
  /** The heading level: 2 in the column, kept 2 in a sheet (the sheet's own title is the dialog name). */
  headingId?: string;
}

export function DocPreview({ id, index, canAskAssistant, headingId }: DocPreviewProps) {
  const navigate = useNavigate();
  const detail = useAsync(() => api.document(id), `preview|${id}`);
  const doc = detail.data && detail.data.id.toLowerCase() === id.toLowerCase() ? detail.data : null;
  const entry: DocumentTreeEntry | undefined = index?.tree.documents[doc?.id ?? id];

  if (detail.error && !detail.loading) {
    return (
      <div className="doc-preview doc-preview--error" role="alert">
        <p className="doc-preview__error">
          Не удалось загрузить документ {id}. {detail.error.message}
        </p>
        <Button size="sm" onClick={detail.reload}>
          Повторить
        </Button>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="doc-preview" aria-busy="true">
        <span className="visually-hidden" role="status">
          Загружаем документ…
        </span>
        <Skeleton />
      </div>
    );
  }

  const review = reviewMark({ review_state: doc.review_state, reviewed_at: doc.reviewed_at });
  const place = index ? pathLabel(index, doc.id) : null;
  const systems = entry?.systems ?? doc.systems ?? [];
  const toc = doc.sections.filter((section) => section.level === 2);

  return (
    <article className="doc-preview" aria-labelledby={headingId ?? `doc-preview-${doc.id}`}>
      <p className="doc-preview__status">
        <StatusMark status={doc.status} />
        <span className="doc-preview__id">{doc.id}</span>
        {doc.version ? <span className="doc-preview__version">версия {doc.version}</span> : null}
      </p>
      {/* The title is a link to the document (the owner's decision: «Открыть» is secondary, one primary per view). */}
      <h2 id={headingId ?? `doc-preview-${doc.id}`} className={doc.status === "deprecated" ? "doc-preview__title doc-preview__title--deprecated" : "doc-preview__title"}>
        <Link to={docHref(doc.id)} className="doc-preview__title-link">
          {doc.title}
        </Link>
      </h2>
      {doc.summary ? <p className="doc-preview__summary">{doc.summary}</p> : null}
      <div className="doc-preview__actions">
        <Link to={docHref(doc.id)} className={buttonClass("secondary", "md")}>
          Открыть
        </Link>
        {canAskAssistant ? <Button onClick={() => askAboutDocument(navigate, doc.id, doc.title)}>Спросить ассистента</Button> : null}
        <Link to={`/proposals/new?document=${encodeURIComponent(doc.id)}`} className={buttonClass("secondary", "md")}>
          Предложить изменение
        </Link>
      </div>
      <dl className="doc-preview__props">
        <div>
          <dt>Расположение</dt>
          <dd>{place ?? TYPE_LABEL[doc.type] ?? doc.type}</dd>
        </div>
        {systems.length > 0 ? (
          <div>
            <dt>Системы</dt>
            <dd>{systems.join(", ")}</dd>
          </div>
        ) : null}
        <div>
          <dt>Владелец</dt>
          <dd className={doc.owner_missing ? "flag" : undefined}>{doc.owner_missing ? "не назначен" : doc.owner}</dd>
        </div>
        <div>
          <dt>Проверен</dt>
          <dd className={review.tone === "warn" ? "doc-preview__warn" : review.tone === "muted" ? "doc-preview__muted" : undefined}>
            {review.text}
            {doc.review_state === "stale" ? ", нужна перепроверка" : ""}
          </dd>
        </div>
        {entry ? (
          <div>
            <dt>Связи</dt>
            <dd>
              <Link to={`${docHref(doc.id)}#doc-links`}>{linksText(entry.link_count)}</Link>
            </dd>
          </div>
        ) : null}
      </dl>
      {doc.tags.length > 0 ? (
        <ul className="doc-preview__tags" aria-label="Теги">
          {doc.tags.map((tag) => (
            <li key={tag}>
              <Link to={`/documents?view=table&tag=${encodeURIComponent(tag)}`} className="tag">
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {toc.length > 0 ? (
        <nav className="doc-preview__toc" aria-label="Разделы документа">
          <h3 className="doc-preview__toc-title">Разделы документа</h3>
          <ul>
            {toc.map((section) => (
              <li key={section.anchor}>
                <Link to={`${docHref(doc.id)}#${encodeURIComponent(section.anchor)}`}>{section.heading}</Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </article>
  );
}
