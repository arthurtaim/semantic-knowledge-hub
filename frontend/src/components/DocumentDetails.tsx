import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DocumentDetail, DocumentPublicationStatus } from "../api/types";
import { formatDate, formatDateTime, REVIEW_LABEL, SOURCE_LABEL, TYPE_LABEL } from "../lib/labels";
import { PublicationPassportRow } from "./DocumentPublication";
import { StaleMark } from "./StaleMark";
import { StatusStamp } from "./StatusStamp";

const isHttpUrl = (value: string | null): value is string => Boolean(value && /^https?:\/\//i.test(value));

/** Where the document lives: a validated link to this exact revision, or an honest "local workspace" note. */
export function SourceLocation({ doc }: { doc: DocumentDetail }) {
  if (isHttpUrl(doc.web_url)) {
    return (
      <a href={doc.web_url} className="doc-details__source-link" target="_blank" rel="noopener noreferrer">
        {doc.source === "gitlab" ? "Открыть в GitLab" : "Открыть в источнике"}
        <span aria-hidden="true"> ↗</span>
      </a>
    );
  }
  if (doc.source === "local") {
    return <span className="doc-details__note">Документ хранится в локальном workspace — внешней ссылки нет.</span>;
  }
  return <span className="doc-details__note">Ссылка на ревизию в источнике не указана.</span>;
}

function Row({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface DocumentDetailsProps {
  doc: DocumentDetail;
  publication: { status: DocumentPublicationStatus | null; failed: boolean };
}

/**
 * «Сведения о документе» — every fact of the former passport and metadata tab, by trust class: system fields
 * (the server owns them; neither people nor AI edit them directly) and author fields (changed only through a
 * reviewed change — by hand or by accepting an AI proposal), then validation remarks.
 */
export function DocumentDetails({ doc, publication }: DocumentDetailsProps) {
  return (
    <div className="doc-details">
      {doc.is_demo ? (
        // A fact about the document, next to the other trust facts.
        <p className="doc-details__demo">
          <strong>Демо-данные.</strong> Синтетический документ для проверки приложения — не источник фактов о банке.
        </p>
      ) : null}

      <section className="doc-details__group" aria-labelledby="meta-system-title">
        <h3 id="meta-system-title">Системные поля</h3>
        <p className="muted">Выставляет сервер: ID, статус, ревизию, шаблон и происхождение нельзя изменить вручную или ответом ИИ.</p>
        <dl className="doc-details__fields">
          <Row term="ID">
            <code className="doc-id">{doc.id}</code>
          </Row>
          <Row term="Статус">
            <StatusStamp status={doc.status} />
          </Row>
          <Row term="Ревизия">
            <code className="doc-id">{doc.revision}</code>
            {doc.index_state === "stale" ? <StaleMark /> : null}
          </Row>
          <Row term="Дата ревизии">
            {doc.updated_at ? <time dateTime={doc.updated_at}>{formatDateTime(doc.updated_at)}</time> : "не указана"}
          </Row>
          <Row term="Версия">{doc.version ?? "не указана"}</Row>
          <Row term="Шаблон">
            {doc.template_id ? (
              <>
                <Link to={`/templates/${encodeURIComponent(doc.template_id)}`}>{doc.template_id}</Link>{" "}
                <span className="version-badge">v{doc.template_version ?? 1}</span>
                <span className="muted"> — версия закреплена при создании</span>
              </>
            ) : (
              <span className="muted">не указан (документ создан до реестра шаблонов)</span>
            )}
          </Row>
          <Row term="Раздел">
            <Link to={`/documents?type=${doc.type}`}>{TYPE_LABEL[doc.type] ?? doc.type}</Link>
          </Row>
          <Row term="Источник">
            {SOURCE_LABEL[doc.source]}
            <code className="doc-details__uri">{doc.source_uri}</code>
            <SourceLocation doc={doc} />
          </Row>
          <Row term="Файл">
            <code className="doc-details__uri">{doc.path}</code>
          </Row>
          <Row term="Проверка">
            {REVIEW_LABEL[doc.review_state]}
            {doc.reviewed_at ? <span className="muted"> · {formatDate(doc.reviewed_at)}</span> : null}
          </Row>
          <Row term="Ссылки в тексте">{doc.wikilink_count ?? 0}</Row>
          <PublicationPassportRow status={publication.status} failed={publication.failed} />
        </dl>
      </section>

      <section className="doc-details__group" aria-labelledby="meta-human-title">
        <h3 id="meta-human-title">Поля автора</h3>
        <p className="muted">Меняются только через предложение изменения и ревью — вручную или приняв предложение ИИ.</p>
        <dl className="doc-details__fields">
          <Row term="Название">{doc.title}</Row>
          <Row term="Владелец">
            {doc.owner_missing ? <span className="flag">не назначен ({doc.owner})</span> : doc.owner}
          </Row>
          <Row term="Теги">
            {doc.tags.length > 0 ? (
              <ul className="tags">
                {doc.tags.map((tag) => (
                  <li key={tag}>
                    <Link to={`/documents?tag=${encodeURIComponent(tag)}`} className="tag">
                      {tag}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">нет</span>
            )}
          </Row>
          <Row term="Описание">{doc.summary ? doc.summary : <span className="muted">не задано</span>}</Row>
          <Row term="Обновлён">
            {doc.metadata_updated_at ? formatDate(doc.metadata_updated_at) : <span className="muted">дата не указана</span>}
          </Row>
          <Row term="Связанные">
            {doc.related.length > 0 ? (
              <ul className="doc-details__related">
                {doc.related.map((rel) =>
                  rel.resolved ? (
                    <li key={rel.id}>
                      <Link to={`/documents/${encodeURIComponent(rel.id)}`}>{rel.title}</Link>{" "}
                      <code className="doc-id">{rel.id}</code>
                    </li>
                  ) : (
                    <li key={rel.id} className="muted">
                      <code className="doc-id">{rel.id}</code> — не найден в базе знаний
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <span className="muted">нет</span>
            )}
          </Row>
          {doc.source_refs.length > 0 ? (
            <Row term="Внешние источники">
              <ul className="doc-details__related">
                {doc.source_refs.map((ref) => (
                  <li key={ref}>
                    <code className="doc-details__uri">{ref}</code>
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
          {Object.entries(doc.extra_metadata).map(([key, value]) => (
            <Row key={key} term={<code>{key}</code>}>
              {value}
            </Row>
          ))}
        </dl>
      </section>

      {doc.warnings.length > 0 ? (
        <section className="doc-details__group" aria-labelledby="meta-issues-title">
          <h3 id="meta-issues-title">Замечания проверки</h3>
          <ul>
            {doc.warnings.map((w) => (
              <li key={`${w.code}-${w.field ?? ""}`}>{w.message}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
