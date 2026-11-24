import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { TemplateSummary } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { pluralRu, TEMPLATE_STATUS_LABEL, TYPE_LABEL, TYPE_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { When } from "../components/When";

const FILTER_KEYS = ["q", "status", "type", "category", "label"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const STATUS_OPTIONS = ["active", "deprecated", "draft", "archived"];

export function TemplateStatusBadge({ status }: { status: string }) {
  return <span className={`tpl-status tpl-status--${status}`}>{TEMPLATE_STATUS_LABEL[status] ?? status}</span>;
}

function TemplateTile({ t }: { t: TemplateSummary }) {
  const deprecated = t.status === "deprecated" || t.status === "archived";
  return (
    <li className={`template-tile${deprecated ? " template-tile--deprecated" : ""}`} data-template={t.id}>
      <div className="template-tile__head">
        <h2 className="template-tile__title">
          <Link to={`/templates/${encodeURIComponent(t.id)}`}>{t.title}</Link>
        </h2>
        <span className="version-badge" title={`Версии: ${t.versions.map((v) => `v${v}`).join(", ")}`}>
          <span className="visually-hidden">версия </span>v{t.version}
        </span>
      </div>
      <p className="template-tile__line">
        <TemplateStatusBadge status={t.status} />
        <span>{t.category}</span>
        {TYPE_LABEL[t.doc_type] && TYPE_LABEL[t.doc_type] !== t.category ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{TYPE_LABEL[t.doc_type]}</span>
          </>
        ) : null}
      </p>
      <p className="template-tile__desc">{t.description}</p>
      {deprecated ? (
        <p className="template-tile__deprecated">
          Не используется для новых документов. Документы и черновики, созданные по нему, открываются по своей версии.
        </p>
      ) : null}
      {t.labels.length > 0 ? (
        <ul className="tags" aria-label="Метки">
          {t.labels.map((label) => (
            <li key={label}>
              <Link to={`/templates?label=${encodeURIComponent(label)}`} className="tag">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="template-tile__facts">
        <div>
          <dt>Владелец</dt>
          <dd>{t.owner}</dd>
        </div>
        <div>
          <dt>Обновлён</dt>
          <dd>
            <When value={t.updated} />
          </dd>
        </div>
        <div>
          <dt>Разделы</dt>
          <dd>
            {t.required_sections} обяз.{t.optional_sections > 0 ? ` · ${t.optional_sections} необяз.` : ""}
          </dd>
        </div>
        <div>
          <dt>Документов</dt>
          <dd>{t.documents}</dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * `/templates` — the Template Hub: the same versioned registry that the backend gives the AI, as a searchable
 * catalogue. Filters live in the URL; usage counts include only documents the reader can see.
 */
export function TemplatesPage() {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""])) as Record<FilterKey, string>;
  const active = FILTER_KEYS.filter((k) => filters[k]);
  const key = JSON.stringify(filters);
  const all = useAsync(() => api.templateCatalogue(), "templates-all");
  const filtered = useAsync(() => (active.length > 0 ? api.templateCatalogue(filters) : Promise.resolve(null)), `templates-${key}`);
  const [draftQuery, setDraftQuery] = useState(filters.q);

  useEffect(() => setDraftQuery(filters.q), [filters.q]);

  function update(changes: Partial<Record<FilterKey, string | null>>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    update({ q: draftQuery.trim() || null });
  }

  const everything = all.data ?? [];
  const categories = [...new Set(everything.map((t) => t.category))].sort((a, b) => a.localeCompare(b, "ru"));
  const labels = [...new Set(everything.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b, "ru"));
  const types = TYPE_ORDER.filter((type) => everything.some((t) => t.doc_type === type));
  const items = active.length > 0 ? filtered.data : all.data;
  const loading = active.length > 0 ? filtered.loading : all.loading;
  const error = active.length > 0 ? filtered.error : all.error;

  return (
    <div className="templates">
      <div className="page-head">
        <h1>Шаблоны документов</h1>
        <p className="lead">
          Один версионированный реестр для людей и для ИИ: структура документа, обязательные поля, правила проверки,
          указания и пример. Новый документ закрепляет версию шаблона — следующие версии на него не влияют.
        </p>
      </div>

      <form className="template-filters" role="search" aria-label="Поиск шаблонов" onSubmit={onSearch}>
        <div className="field template-filters__search">
          <label htmlFor="tpl-q">Поиск</label>
          <div className="field__row">
            <input
              id="tpl-q"
              type="search"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="Название, описание, метка"
              maxLength={100}
              autoComplete="off"
            />
            <button type="submit" className="button button--primary">
              Найти
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="tpl-type">Тип документа</label>
          <select id="tpl-type" value={filters.type} onChange={(e) => update({ type: e.target.value })}>
            <option value="">Все</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tpl-status">Статус</label>
          <select id="tpl-status" value={filters.status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Все, кроме архива</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {TEMPLATE_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tpl-category">Категория</label>
          <select id="tpl-category" value={filters.category} onChange={(e) => update({ category: e.target.value })}>
            <option value="">Все</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tpl-label">Метка</label>
          <select id="tpl-label" value={filters.label} onChange={(e) => update({ label: e.target.value })}>
            <option value="">Все</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {active.length > 0 ? (
          <button type="button" className="button button--ghost template-filters__reset" onClick={() => setParams(new URLSearchParams())}>
            Сбросить фильтры
          </button>
        ) : null}
      </form>

      <p className="results__summary template-count" aria-live="polite">
        {loading && !items
          ? "Загрузка…"
          : items
            ? `${items.length} ${pluralRu(items.length, "шаблон", "шаблона", "шаблонов")}${filters.q ? ` по запросу «${filters.q}»` : ""}`
            : ""}
      </p>
      {error ? <ErrorState error={error} onRetry={active.length > 0 ? filtered.reload : all.reload} /> : null}
      {loading && !items ? <Loading label="Загрузка шаблонов…" /> : null}
      {items && items.length === 0 ? (
        <EmptyState title="Шаблонов с такими условиями нет">
          <p>Измените запрос или сбросьте фильтры.</p>
        </EmptyState>
      ) : null}
      {items && items.length > 0 ? (
        <ul className="template-grid" aria-label="Шаблоны">
          {items.map((t) => (
            <TemplateTile key={t.id} t={t} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
