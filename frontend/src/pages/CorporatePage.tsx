import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { ErrorState, Loading, Notice } from "../components/Feedback";
import { formatDate } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

export function CorporatePage() {
  const { id = "" } = useParams();
  const { data, error, loading } = useAsync(() => api.corporatePage(id), id);
  if (loading && !data) return <Loading />;
  if (error) {
    return (
      <div className="stack">
        <ErrorState error={error} title={error.status === 404 ? "Страница не найдена или недоступна" : undefined} />
        <Link to="/ask" className="text-link">
          Вернуться к вопросу
        </Link>
      </div>
    );
  }
  if (!data) return null;
  return (
    <article className="document">
      <div className="page-head">
        <h1>{data.title}</h1>
      </div>
      {data.is_mock ? (
        <Notice tone="warning">
          <strong>Mock-коннектор.</strong> Синтетическая страница для проверки сценария «Корпоративные источники» — это не
          Confluence.
        </Notice>
      ) : null}
      <dl className="inline-meta">
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
            <code>{data.source_uri}</code>
          </dd>
        </div>
      </dl>
      <p className="prose">{data.body}</p>
    </article>
  );
}
