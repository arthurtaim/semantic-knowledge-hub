import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { DocStatus, DocType, DocumentSort, FacetCount } from "../api/types";
import { EmptyState, ErrorState, Loading, Notice } from "../components/Feedback";
import { Highlighted } from "../components/Highlighted";
import { IndexStatusNotice } from "../components/IndexStatusNotice";
import { StaleMark } from "../components/StaleMark";
import { StatusStamp } from "../components/StatusStamp";
import {
  formatDate,
  pluralRu,
  REVIEW_LABEL,
  SORT_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  TYPE_LABEL,
  TYPE_ORDER,
} from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { useMediaQuery } from "../lib/useMediaQuery";

const PAGE_SIZE = 20;
/** Explicit orders; relevance (with a query) and section/title order (without) are the server default. */
const EXPLICIT_SORTS: DocumentSort[] = ["title", "updated", "status"];

function parseSort(value: string | null): DocumentSort | null {
  return value && (EXPLICIT_SORTS as string[]).includes(value) ? (value as DocumentSort) : null;
}
const FILTER_KEYS = ["type", "status", "owner", "tag", "source"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
/** Same breakpoint as the one-column explorer layout in app.css. */
const NARROW = "(max-width: 860px)";

interface FilterGroupProps {
  title: string;
  name: FilterKey;
  options: { value: string; label: string; count?: number }[];
  active: string | null;
  onToggle: (name: FilterKey, value: string) => void;
  collapsed?: boolean;
}

function FilterGroup({ title, name, options, active, onToggle, collapsed = false }: FilterGroupProps) {
  if (options.length === 0) return null;
  return (
    <details className="filter-group" open={!collapsed || active !== null}>
      <summary>
        {title}
        {active ? <span className="filter-group__active"> (выбрано)</span> : null}
      </summary>
      <ul role="group" aria-label={title}>
        {options.map((option) => (
          <li key={option.value}>
            <button
              type="button"
              className="filter-option"
              aria-pressed={active === option.value}
              onClick={() => onToggle(name, option.value)}
            >
              <span>{option.label}</span>
              {option.count !== undefined ? <span className="filter-option__count">{option.count}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function counts(facets: FacetCount[] | undefined): Map<string, number> {
  return new Map(facets?.map((f) => [f.value, f.count]) ?? []);
}

/** «Спросить ИИ об этих документах»: the assistant page with a question about the query and the top results. */
function askAboutResults(query: string, ids: string[]): string {
  const top = ids.slice(0, 5);
  const question = `Что говорят документы по запросу «${query.slice(0, 200)}»${top.length ? ` (${top.join(", ")})` : ""}? Ответь со ссылками на источники.`;
  return `/ask?q=${encodeURIComponent(question)}`;
}

export function ExplorerPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("query") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k)])) as Record<FilterKey, string | null>;
  const sort = parseSort(params.get("sort"));
  const [draftQuery, setDraftQuery] = useState(query);
  const narrow = useMediaQuery(NARROW);
  const activeFilters = FILTER_KEYS.filter((k) => filters[k]).length;
  // Phones: filters sit in a disclosure, closed by default and opened whenever a filter becomes active.
  const [filtersOpen, setFiltersOpen] = useState(activeFilters > 0);
  const [seenActiveFilters, setSeenActiveFilters] = useState(activeFilters);
  if (activeFilters !== seenActiveFilters) {
    setSeenActiveFilters(activeFilters);
    if (activeFilters > 0) setFiltersOpen(true);
  }

  useEffect(() => setDraftQuery(query), [query]);

  const facets = useAsync(() => api.facets(), "facets");
  const index = useAsync(() => api.indexStatus(), "index-status");
  const key = params.toString();
  const list = useAsync(
    () =>
      api.documents({
        query,
        page,
        size: PAGE_SIZE,
        type: filters.type ?? undefined,
        status: filters.status ?? undefined,
        owner: filters.owner ?? undefined,
        tag: filters.tag ?? undefined,
        source: filters.source ?? undefined,
        sort: sort ?? undefined,
      }),
    key,
  );

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(name);
      else next.set(name, value);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  }

  function toggle(name: FilterKey, value: string) {
    update({ [name]: filters[name] === value ? null : value });
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    update({ query: draftQuery.trim() || null });
  }

  const typeCounts = counts(facets.data?.types);
  const statusCounts = counts(facets.data?.statuses);
  const hasFilters = Boolean(query) || FILTER_KEYS.some((k) => filters[k]);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeType = filters.type as DocType | null;
  const items = list.data?.items ?? [];
  // The source is shown per row only when the results mix sources; otherwise once, above the list.
  const sources = [...new Set(items.map((d) => d.source))];
  const singleSource = sources.length === 1 ? sources[0] : null;

  const filterGroups = (
    <>
      <FilterGroup
        title="Раздел"
        name="type"
        active={filters.type}
        onToggle={toggle}
        options={TYPE_ORDER.filter((t) => typeCounts.has(t)).map((t) => ({
          value: t,
          label: TYPE_LABEL[t],
          count: typeCounts.get(t),
        }))}
      />
      <FilterGroup
        title="Статус"
        name="status"
        active={filters.status}
        onToggle={toggle}
        options={STATUS_ORDER.filter((s) => statusCounts.has(s)).map((s) => ({
          value: s,
          label: STATUS_LABEL[s as DocStatus],
          count: statusCounts.get(s),
        }))}
      />
      <FilterGroup
        title="Владелец"
        name="owner"
        collapsed
        active={filters.owner}
        onToggle={toggle}
        options={(facets.data?.owners ?? []).map((f) => ({ value: f.value, label: f.value, count: f.count }))}
      />
      <FilterGroup
        title="Источник"
        name="source"
        collapsed
        active={filters.source}
        onToggle={toggle}
        options={(facets.data?.sources ?? []).map((f) => ({
          value: f.value,
          label: SOURCE_LABEL[f.value as keyof typeof SOURCE_LABEL] ?? f.value,
          count: f.count,
        }))}
      />
      <FilterGroup
        title="Тег"
        name="tag"
        collapsed
        active={filters.tag}
        onToggle={toggle}
        options={(facets.data?.tags ?? []).slice(0, 30).map((f) => ({ value: f.value, label: f.value, count: f.count }))}
      />
      {hasFilters ? (
        <button type="button" className="button button--ghost" onClick={() => setParams(new URLSearchParams())}>
          Сбросить фильтры
        </button>
      ) : null}
    </>
  );

  return (
    <div className="explorer">
      <div className="page-head">
        <h1>{activeType && TYPE_LABEL[activeType] ? TYPE_LABEL[activeType] : "База знаний"}</h1>
        <form className="search-box search-box--compact" role="search" onSubmit={onSearch}>
          <label htmlFor="explorer-search" className="visually-hidden">
            Поиск по документам
          </label>
          <input
            id="explorer-search"
            type="search"
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            placeholder="Название, текст, теги, связанные ID"
            maxLength={200}
            autoComplete="off"
          />
          <button type="submit" className="button button--primary">
            Найти
          </button>
        </form>
        <Link to="/documents/new" className="button button--secondary">
          Создать документ
        </Link>
      </div>

      {index.data ? <IndexStatusNotice status={index.data} /> : null}

      <div className="explorer__body">
        <aside className="filters" aria-label="Фильтры">
          {narrow ? (
            <details
              className="filters-disclosure"
              open={filtersOpen}
              onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
            >
              <summary>Фильтры{activeFilters > 0 ? ` (${activeFilters})` : ""}</summary>
              <div className="filters-disclosure__body">{filterGroups}</div>
            </details>
          ) : (
            filterGroups
          )}
        </aside>

        <section className="results" aria-labelledby="results-title" aria-busy={list.loading}>
          <div className="results__bar">
            <div className="results__heading">
              <h2 id="results-title" className="results__summary" aria-live="polite">
                {list.loading
                  ? "Поиск…"
                  : `${total} ${pluralRu(total, "документ", "документа", "документов")}${query ? ` по запросу «${query}»` : ""}`}
              </h2>
              {singleSource && !list.loading ? (
                <p className="results__source">Источник: {SOURCE_LABEL[singleSource]}</p>
              ) : null}
              {query && list.data && list.data.items.length > 0 && !list.loading ? (
                <Link to={askAboutResults(query, list.data.items.map((d) => d.id))} className="button button--ask results__ask">
                  Спросить ИИ об этих документах
                </Link>
              ) : null}
            </div>
            <div className="sort-control">
              <label htmlFor="explorer-sort">Сортировка</label>
              <select id="explorer-sort" value={sort ?? ""} onChange={(e) => update({ sort: e.target.value || null })}>
                <option value="">{query ? SORT_LABEL.relevance : "По разделам"}</option>
                {EXPLICIT_SORTS.map((value) => (
                  <option key={value} value={value}>
                    {SORT_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
          {list.data?.notes && list.data.notes.length > 0 && !list.loading ? (
            <Notice tone="info" className="results__notes">
              <ul>
                {list.data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {list.loading && !list.data ? <Loading /> : null}
          {list.data && list.data.items.length === 0 && !list.loading ? (
            <EmptyState title={query ? `По запросу «${query}» ничего не найдено` : "Документов с такими фильтрами нет"}>
              <p>Проверьте написание, попробуйте другое слово или сбросьте фильтры. Поиск ищет по названию, тексту, тегам и связанным ID.</p>
              {hasFilters ? (
                <button type="button" className="button button--secondary" onClick={() => setParams(new URLSearchParams())}>
                  Сбросить фильтры
                </button>
              ) : null}
            </EmptyState>
          ) : null}
          {list.data && list.data.items.length > 0 ? (
            <ol className="result-list">
              {list.data.items.map((doc) => (
                <li key={doc.id} className="result">
                  <div className="result__head">
                    <Link to={`/documents/${doc.id}`} className="result__title">
                      {doc.title}
                    </Link>
                    <span className="result__badges">
                      {doc.related_via ? (
                        <span className="related-via" title="Найден через объявленную связь, а не по своему тексту">
                          Связан с {doc.related_via}
                        </span>
                      ) : null}
                      {doc.index_state === "stale" ? <StaleMark /> : null}
                      {doc.review_state === "stale" || doc.review_state === "never_reviewed" ? (
                        <span className="review-flag" title="Проверка документа">
                          {REVIEW_LABEL[doc.review_state]}
                        </span>
                      ) : null}
                      <StatusStamp status={doc.status} />
                    </span>
                  </div>
                  <p className="result__excerpt">
                    {doc.highlights ? <Highlighted segments={doc.highlights} /> : doc.excerpt}
                  </p>
                  <dl className="result__meta">
                    <div>
                      <dt>ID</dt>
                      <dd>
                        <code className="doc-id">{doc.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Раздел</dt>
                      <dd>{TYPE_LABEL[doc.type]}</dd>
                    </div>
                    <div>
                      <dt>Владелец</dt>
                      <dd className={doc.owner_missing ? "flag" : undefined}>
                        {doc.owner_missing ? "не назначен" : doc.owner}
                      </dd>
                    </div>
                    {/* One source for the whole list: shown once above it; the row keeps it for screen readers. */}
                    <div className={singleSource ? "visually-hidden" : undefined}>
                      <dt>Источник</dt>
                      <dd>{SOURCE_LABEL[doc.source]}</dd>
                    </div>
                    <div>
                      <dt>Обновлён</dt>
                      <dd>
                        {doc.updated_at ? <time dateTime={doc.updated_at}>{formatDate(doc.updated_at)}</time> : "не указано"}
                      </dd>
                    </div>
                  </dl>
                  {doc.match_reasons && doc.match_reasons.length > 0 ? (
                    <p className="result__why">Почему найдено: {doc.match_reasons.join("; ")}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {pages > 1 ? (
            <nav className="pager" aria-label="Страницы результатов">
              <button
                type="button"
                className="button button--secondary"
                disabled={page <= 1}
                onClick={() => update({ page: String(page - 1) })}
              >
                Назад
              </button>
              <span>
                Страница {page} из {pages}
              </span>
              <button
                type="button"
                className="button button--secondary"
                disabled={page >= pages}
                onClick={() => update({ page: String(page + 1) })}
              >
                Вперёд
              </button>
            </nav>
          ) : null}
          {list.data?.items.some((d) => d.is_demo) ? (
            <Notice tone="info">Показаны синтетические демо-документы. Они не являются фактами о банке.</Notice>
          ) : null}
        </section>
      </div>
    </div>
  );
}
