import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { PageToolbar } from "../components/shell/PageToolbar";
import { StatusMark } from "../components/ui/StatusMark";
import { formatDate } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

/**
 * `/corporate/:id` — a page of the corporate knowledge (Confluence through the read-only connector), laid out like
 * a document: a status line (an external source, not team knowledge), the title, its facts, the text.
 */
export function CorporatePage() {
  const { id = "" } = useParams();
  const { data, error, loading } = useAsync(() => api.corporatePage(id), id);
  if (loading && !data) return <Loading />;
  if (error) {
    return (
      <div className="stack">
        <ErrorState error={error} title={error.status === 404 ? "Страница не найдена или недоступна" : undefined} page />
        <Link to="/ask" className="text-link">
          Вернуться к вопросу
        </Link>
      </div>
    );
  }
  if (!data) return null;
  return (
    <article className="document doc-page corporate-page">
      <PageToolbar crumbs={[{ label: "Корпоративные источники" }, { label: data.title }]} />
      <div className="doc-page__main">
        <header className="doc-head">
          <p className="doc-head__status">
            <StatusMark status={null} />
            <span>Confluence · {data.space}</span>
            {data.is_mock ? <span className="doc-head__demo">Mock-коннектор</span> : null}
          </p>
          <h1 className="doc-head__title">{data.title}</h1>
          <div className="doc-props-wrap">
            <dl className="doc-props">
              <div>
                <dt>Пространство</dt>
                <dd>{data.space}</dd>
              </div>
              <div>
                <dt>Версия</dt>
                <dd>{data.version}</dd>
              </div>
              <div>
                <dt>Обновлено</dt>
                <dd>{formatDate(data.updated_at)}</dd>
              </div>
              <div>
                <dt>Источник</dt>
                <dd>
                  <code className="doc-id">{data.source_uri}</code>
                </dd>
              </div>
            </dl>
          </div>
        </header>
        {data.is_mock ? (
          <Notice tone="warning">
            <strong>Mock-коннектор.</strong> Синтетическая страница для проверки сценария «Корпоративные источники» — это не
            Confluence.
          </Notice>
        ) : null}
        <Notice tone="info">
          Внешний источник: страница не входит в базу знаний команды и не утверждалась её ревью. Перенести её в базу можно
          только через черновик и ревью.
        </Notice>
        {/* Plain text from the connector (never rendered as HTML); its line breaks are kept. */}
        <div className="prose">
          <p className="corporate-page__body">{data.body}</p>
        </div>
      </div>
    </article>
  );
}
