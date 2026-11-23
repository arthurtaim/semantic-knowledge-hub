import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DocumentDetail } from "../api/types";
import { formatDateTime, REVIEW_LABEL, SOURCE_LABEL, TYPE_LABEL } from "../lib/labels";
import { StatusStamp } from "./StatusStamp";

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Metadata of an approved document by trust class: system fields (the server owns them; neither people nor AI
 * edit them directly) and author fields (changed only through a reviewed change — by hand or by accepting an AI
 * proposal). Validation remarks are listed with them.
 */
export function MetadataPanel({ doc }: { doc: DocumentDetail }) {
  return (
    <div className="metadata-panel">
      <section className="metadata-panel__group" aria-labelledby="meta-system-title">
        <h3 id="meta-system-title">Системные поля</h3>
        <p className="muted">Выставляет сервер: ID, статус, ревизию, шаблон и происхождение нельзя изменить вручную или ответом ИИ.</p>
        <dl className="meta-grid">
          <Row term="ID">
            <code className="doc-id">{doc.id}</code>
          </Row>
          <Row term="Статус">
            <StatusStamp status={doc.status} />
          </Row>
          <Row term="Ревизия">
            <code className="doc-id">{doc.revision}</code>
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
          <Row term="Раздел">{TYPE_LABEL[doc.type] ?? doc.type}</Row>
          <Row term="Источник">
            {SOURCE_LABEL[doc.source]} <code className="passport__uri">{doc.source_uri}</code>
          </Row>
          <Row term="Обновлён">{doc.updated_at ? formatDateTime(doc.updated_at) : "не указано"}</Row>
          <Row term="Проверка">{REVIEW_LABEL[doc.review_state]}</Row>
          <Row term="Ссылки в тексте">{doc.wikilink_count ?? 0}</Row>
        </dl>
      </section>
      <section className="metadata-panel__group" aria-labelledby="meta-human-title">
        <h3 id="meta-human-title">Поля автора</h3>
        <p className="muted">
          Меняются только через предложение изменения и ревью — вручную или приняв предложение ИИ ниже.
        </p>
        <dl className="meta-grid">
          <Row term="Название">{doc.title}</Row>
          <Row term="Владелец">
            {doc.owner_missing ? <span className="flag">не назначен ({doc.owner})</span> : doc.owner}
          </Row>
          <Row term="Теги">{doc.tags.length > 0 ? doc.tags.join(", ") : <span className="muted">нет</span>}</Row>
          <Row term="Описание">{doc.summary ? doc.summary : <span className="muted">не задано</span>}</Row>
          <Row term="Связанные">
            {doc.related.length > 0 ? doc.related.map((r) => r.id).join(", ") : <span className="muted">нет</span>}
          </Row>
        </dl>
      </section>
      {doc.warnings.length > 0 ? (
        <section className="metadata-panel__group" aria-labelledby="meta-issues-title">
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
