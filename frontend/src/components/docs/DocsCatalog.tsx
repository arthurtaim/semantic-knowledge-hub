import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { DocStatus, DocumentSort, FacetCount } from "../../api/types";
import { canAsk } from "../../lib/aiMode";
import {
  activeFilters,
  FILTER_KEYS,
  FILTER_TITLE,
  filterValues,
  GROUP_LABEL,
  initialGroup,
  rememberGroup,
  toggleValue,
  type CatalogGroup,
  type FilterKey,
} from "../../lib/catalog";
import { queryOf, searchChanges, withParams } from "../../lib/docsView";
import { pluralRu, SORT_LABEL, SOURCE_LABEL, STATUS_LABEL, STATUS_ORDER, TYPE_LABEL, TYPE_ORDER } from "../../lib/labels";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/useAsync";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { CatalogTable } from "../CatalogTable";
import { EmptyState, ErrorState, Loading, Notice } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button, buttonClass } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { Menu, Popover } from "../ui/Popover";

/** The table loads up to the API maximum so groups are whole. */
const PAGE_SIZE = 100;
/** Explicit orders; relevance (with a query) and section/title order (without) are the server default. */
const EXPLICIT_SORTS: DocumentSort[] = ["title", "updated", "status"];
/** Phones: cards instead of the table, filters in a sheet. */
const PHONE = "(max-width: 719.98px)";

function parseSort(value: string | null): DocumentSort | null {
  return value && (EXPLICIT_SORTS as string[]).includes(value) ? (value as DocumentSort) : null;
}

function counts(facets: FacetCount[] | undefined): Map<string, number> {
  return new Map(facets?.map((f) => [f.value, f.count]) ?? []);
}

/** «Спросить ИИ об этих документах»: the assistant page with a question about the query and the top results. */
export function askAboutResults(query: string, ids: string[]): string {
  const top = ids.slice(0, 5);
  const question = `Что говорят документы по запросу «${query.slice(0, 200)}»${top.length ? ` (${top.join(", ")})` : ""}? Ответь со ссылками на источники.`;
  return `/ask?q=${encodeURIComponent(question)}`;
}

interface FacetGroupProps {
  title: string;
  name: FilterKey;
  options: { value: string; label: string; count?: number }[];
  active: string[];
  onToggle: (name: FilterKey, value: string) => void;
}

/** One facet of «+ Фильтр»: toggle buttons; several values of one facet combine with «или». */
function FacetGroup({ title, name, options, active, onToggle }: FacetGroupProps) {
  if (options.length === 0) return null;
  return (
    <section className="facet-group" aria-label={title}>
      <h3 className="facet-group__title">{title}</h3>
      <ul role="group" aria-label={title}>
        {options.map((option) => (
          <li key={option.value}>
            <button
              type="button"
              className="filter-option"
              aria-pressed={active.includes(option.value)}
              onClick={() => onToggle(name, option.value)}
            >
              <Icon name="check" size={14} className="filter-option__check" />
              <span className="filter-option__label">{option.label}</span>
              {option.count !== undefined ? <span className="filter-option__count">{option.count}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface DocsCatalogProps {
  /** The filter row sits right under the toolbar (the view switch and the search are in the toolbar). */
  flush?: boolean;
  /** The index-state notice, under the filter row. */
  notice?: ReactNode;
}

/**
 * The catalog table of UI v2 (design-05): active filters as chips, «+ Фильтр» with the facets, grouping and sorting
 * on the right, then the documents as a grouped table (cards on a phone). Every filter, the query, the sort and the
 * page live in the URL; the grouping in this browser. «Документы» v2 keeps it as the «Таблица» view until that
 * view gets its own filters (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §3).
 */
export function DocsCatalog({ flush = false, notice }: DocsCatalogProps) {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const query = queryOf(params);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const sort = parseSort(params.get("sort"));
  const [group, setGroup] = useState<CatalogGroup>(initialGroup);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const phone = useMediaQuery(PHONE);
  const sheetMode = useSidePanelMode(true);
  const filters = activeFilters(params);
  const values = Object.fromEntries(FILTER_KEYS.map((k) => [k, filterValues(params, k)])) as Record<FilterKey, string[]>;

  const pageSize = PAGE_SIZE;
  const facets = useAsync(() => api.facets(), "facets");
  const listKey = [query, page, pageSize, sort, ...FILTER_KEYS.map((k) => params.get(k))].join("|");
  const list = useAsync(
    () =>
      api.documents({
        query,
        page,
        size: pageSize,
        type: params.get("type") ?? undefined,
        status: params.get("status") ?? undefined,
        owner: params.get("owner") ?? undefined,
        tag: params.get("tag") ?? undefined,
        source: params.get("source") ?? undefined,
        sort: sort ?? undefined,
      }),
    listKey,
  );

  function update(changes: Record<string, string | null>) {
    const next = withParams(params, changes);
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  }

  function toggle(name: FilterKey, value: string) {
    update({ [name]: toggleValue(values[name], value) });
  }

  /** Filters and the query go; the chosen view stays. */
  function resetFilters() {
    const view = params.get("view");
    setParams(view ? new URLSearchParams({ view }) : new URLSearchParams());
  }

  function chooseGroup(next: CatalogGroup) {
    setGroup(next);
    rememberGroup(next);
  }

  const typeCounts = counts(facets.data?.types);
  const statusCounts = counts(facets.data?.statuses);
  const hasFilters = Boolean(query) || filters.length > 0;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = list.data?.items ?? [];
  // The source is shown per row only when the results mix sources; otherwise once, above the list.
  const sources = [...new Set(items.map((d) => d.source))];
  const singleSource = sources.length === 1 ? sources[0] : null;

  const facetGroups = (
    <div className="facet-groups">
      <FacetGroup
        title="Раздел"
        name="type"
        active={values.type}
        onToggle={toggle}
        options={TYPE_ORDER.filter((t) => typeCounts.has(t)).map((t) => ({ value: t, label: TYPE_LABEL[t], count: typeCounts.get(t) }))}
      />
      <FacetGroup
        title="Статус"
        name="status"
        active={values.status}
        onToggle={toggle}
        options={STATUS_ORDER.filter((s) => statusCounts.has(s)).map((s) => ({
          value: s,
          label: STATUS_LABEL[s as DocStatus],
          count: statusCounts.get(s),
        }))}
      />
      <FacetGroup
        title="Владелец"
        name="owner"
        active={values.owner}
        onToggle={toggle}
        options={(facets.data?.owners ?? []).map((f) => ({ value: f.value, label: f.value, count: f.count }))}
      />
      <FacetGroup
        title="Источник"
        name="source"
        active={values.source}
        onToggle={toggle}
        options={(facets.data?.sources ?? []).map((f) => ({
          value: f.value,
          label: SOURCE_LABEL[f.value as keyof typeof SOURCE_LABEL] ?? f.value,
          count: f.count,
        }))}
      />
      <FacetGroup
        title="Тег"
        name="tag"
        active={values.tag}
        onToggle={toggle}
        options={(facets.data?.tags ?? []).slice(0, 30).map((f) => ({ value: f.value, label: f.value, count: f.count }))}
      />
      {facets.error ? <p className="flag">Фильтры не загрузились: {facets.error.message}</p> : null}
    </div>
  );

  const filterCount = filters.reduce((n, f) => n + f.values.length, 0);
  const sortMenu = (
    <Menu
      label="Вид списка"
      align="end"
      groups={[
        {
          label: "Сортировка",
          radio: true,
          items: [
            {
              id: "default",
              label: query ? SORT_LABEL.relevance : "По разделам",
              checked: sort === null,
              onSelect: () => update({ sort: null }),
            },
            ...EXPLICIT_SORTS.map((value) => ({
              id: value,
              label: SORT_LABEL[value],
              checked: sort === value,
              onSelect: () => update({ sort: value }),
            })),
          ],
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className={buttonClass("quiet", "sm", "catalog-bar__menu")}>
          Вид
          <Icon name="chevron" size={14} />
        </button>
      )}
    />
  );

  const groupMenu = (
    <Menu
        label="Группировка"
        align="end"
        groups={[
          {
            radio: true,
            items: (["type", "status", "owner", "none"] as const).map((value) => ({
              id: value,
              label: GROUP_LABEL[value],
              checked: group === value,
              onSelect: () => chooseGroup(value),
            })),
          },
        ]}
        trigger={(props) => (
          <button {...props} type="button" className={buttonClass("quiet", "sm", "catalog-bar__menu")}>
            Группировка: {GROUP_LABEL[group]}
            <Icon name="chevron" size={14} />
          </button>
        )}
      />
  );

  const quietSummary = !query && pages <= 1;
  const summaryText = list.loading
    ? "Поиск…"
    : `${total} ${pluralRu(total, "документ", "документа", "документов")}${query ? ` по запросу «${query}»` : ""}`;

  return (
    <div className="docs-catalog">
      <div className={flush ? "catalog-bar catalog-bar--flush" : "catalog-bar"}>
        <ul className="catalog-bar__chips" aria-label="Активные фильтры">
          {filters.map((f) => (
            <li key={f.key}>
              <Chip tone="filter" onRemove={() => update({ [f.key]: null })} removeLabel={`Убрать фильтр: ${FILTER_TITLE[f.key]}`}>
                {f.label}
              </Chip>
            </li>
          ))}
          {query ? (
            <li>
              <Chip tone="filter" onRemove={() => update(searchChanges(""))} removeLabel="Убрать запрос">
                Запрос: «{query}»
              </Chip>
            </li>
          ) : null}
          <li>
            {phone ? (
              <Button size="sm" icon="plus" className="catalog-bar__add" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>
                Фильтр{filterCount > 0 ? ` (${filterCount})` : ""}
              </Button>
            ) : (
              <Popover
                id="catalog-filters"
                align="start"
                panelClassName="facet-popover"
                trigger={(props) => (
                  <Button {...props} size="sm" icon="plus" className="catalog-bar__add">
                    Фильтр
                  </Button>
                )}
              >
                {facetGroups}
              </Popover>
            )}
          </li>
          {hasFilters ? (
            <li>
              <Button variant="quiet" size="sm" onClick={resetFilters}>
                Сбросить фильтры
              </Button>
            </li>
          ) : null}
        </ul>
        <div className="catalog-bar__end">
          {groupMenu}
          {sortMenu}
        </div>
      </div>

      {filtersOpen && phone ? (
        <SidePanel id="catalog-filters-sheet" title="Фильтры" mode={sheetMode} onClose={() => setFiltersOpen(false)}>
          {facetGroups}
          {hasFilters ? (
            <Button variant="quiet" size="sm" onClick={resetFilters}>
              Сбросить фильтры
            </Button>
          ) : null}
        </SidePanel>
      ) : null}

      {notice}

      <section className={quietSummary ? "results results--quiet" : "results"} aria-labelledby="results-title" aria-busy={list.loading}>
        <div className="results__bar">
          <div className="results__heading">
            {/* Browsing the table, the toolbar already shows the count: the summary stays for screen readers. */}
            <h2 id="results-title" className={quietSummary ? "visually-hidden" : "results__summary"} aria-live="polite">
              {summaryText}
              {quietSummary && singleSource ? `. Источник: ${SOURCE_LABEL[singleSource]}` : ""}
            </h2>
            {singleSource && !list.loading && !quietSummary ? (
              <p className="results__source">Источник: {SOURCE_LABEL[singleSource]}</p>
            ) : null}
            {pages > 1 && !list.loading ? (
              <p className="results__source">
                Показаны {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}
                {group !== "none" ? "; группы считают документы этой страницы" : ""}.
              </p>
            ) : null}
          </div>
          {query && items.length > 0 && !list.loading && canAsk(session?.features.ai_mode) ? (
            <Link to={askAboutResults(query, items.map((d) => d.id))} className={buttonClass("secondary", "sm", "results__ask")}>
              Спросить ИИ об этих документах
            </Link>
          ) : null}
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
        {list.data && items.length === 0 && !list.loading ? (
          <EmptyState title={query ? `По запросу «${query}» ничего не найдено` : "Документов с такими фильтрами нет"}>
            <p>Проверьте написание, попробуйте другое слово или сбросьте фильтры. Поиск ищет по названию, тексту, тегам и связанным ID.</p>
            {hasFilters ? <Button onClick={resetFilters}>Сбросить фильтры</Button> : null}
          </EmptyState>
        ) : null}
        {items.length > 0 ? <CatalogTable items={items} group={group} singleSource={singleSource !== null} cards={phone} /> : null}
        {pages > 1 ? (
          <nav className="pager" aria-label="Страницы результатов">
            <Button disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              Назад
            </Button>
            <span>
              Страница {page} из {pages}
            </span>
            <Button disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>
              Вперёд
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
