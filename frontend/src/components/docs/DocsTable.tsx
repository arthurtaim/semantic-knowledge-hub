import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { DocumentTreeEntry, SourceType } from "../../api/types";
import { canAsk } from "../../lib/aiMode";
import {
  ATTENTION_PARAM,
  filterCount,
  flagOptions,
  GROUP_LABEL,
  GROUP_PARAM,
  groupIds,
  LIST_FILTERS,
  matchesFilters,
  NARROW_HIDDEN,
  nextSort,
  ownerOptions,
  parseGroup,
  parseSort,
  readFilters,
  readHiddenColumns,
  rememberHiddenColumns,
  sectionOptions,
  sortIdsBy,
  SORT_PARAM,
  sortValue,
  sourceOptions,
  statusOptions,
  systemOptions,
  TABLE_COLUMNS,
  TABLE_GROUPS,
  tableReviewMark,
  toggled,
  type ColumnKey,
  type FilterOption,
  type ListFilter,
  type SortKey,
  type TableGroup,
  type TableSort,
} from "../../lib/docsTable";
import { askAboutResults, LEGACY_QUERY_PARAM, QUERY_PARAM, queryOf, searchChanges, withParams } from "../../lib/docsView";
import type { TreeIndex } from "../../lib/docTree";
import { pluralRu, SOURCE_LABEL, STATUS_LABEL } from "../../lib/labels";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/useAsync";
import type { DocumentTreeState } from "../../lib/useDocumentTree";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { EmptyState, ErrorState, Loading, Notice } from "../Feedback";
import { StaleMark } from "../StaleMark";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button, buttonClass } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { Menu, type MenuGroup } from "../ui/Popover";
import { StatusMark } from "../ui/StatusMark";

/*
 * «Таблица» of «Документы» v2 (docs/ui-v2/documents/specs/DOCUMENTS_V2.md §3, design docs-04): every document of the
 * tree (GET /api/documents/tree) in one dense table — Название + ID, Раздел, Состояние, Владелец, Системы,
 * Проверен, Связи — with menu-button filters (Раздел, Состояние, Владелец, Система), «Только требующие внимания»,
 * «Ещё» (Тег; Источник when the base has several — each chosen value a removable chip on the panel, so an active
 * filter is never hidden), «N из M», grouping and the columns shown. Every filter, the sort and the grouping live in
 * the URL (lib/docsTable.ts); the columns in this browser. A tag or the toolbar search is
 * answered by the server (the rows it returns stay). Sorting by a header click (`aria-sort`), «Проверен ↑» by
 * default; rows of 38 px under a sticky header, the whole row opens the document, ↑↓ Home End move between rows
 * (one tab stop). No paging. On a phone the rows are cards and the filters a sheet.
 */

/** Phones: cards instead of the table, the filters in a sheet. */
const PHONE = "(max-width: 719.98px)";
/** Below this width «Системы» starts hidden (until the reader chooses the columns). */
const NARROW = "(max-width: 1279.98px)";
/** The API's page size, and how many pages a search or a tag may fill (500 documents, the table's limit). */
const SERVER_PAGE = 100;
const SERVER_PAGES = 5;

const docHref = (id: string) => `/documents/${encodeURIComponent(id)}`;
const sourceLabel = (source: string) => SOURCE_LABEL[source as SourceType] ?? source;

/**
 * The documents the server answers for the toolbar search and the tag filter (the tree has neither). The answer
 * carries the request it belongs to: while a new search loads, the rows of the previous one are not shown.
 */
function useServerIds(query: string, tags: string[]) {
  const tag = tags.join(",");
  const key = `${query}|${tag}`;
  const state = useAsync<{ key: string; ids: Set<string>; notes: string[] } | null>(async () => {
    if (!query && !tag) return null;
    const ids = new Set<string>();
    let notes: string[] = [];
    for (let page = 1; page <= SERVER_PAGES; page += 1) {
      const answer = await api.documents({ query: query || undefined, tag: tag || undefined, page, size: SERVER_PAGE });
      if (page === 1) notes = answer.notes ?? [];
      for (const item of answer.items) ids.add(item.id);
      if (page * SERVER_PAGE >= answer.total || answer.items.length === 0) break;
    }
    return { key, ids, notes };
  }, `table-ids|${key}`);
  const active = Boolean(query || tag);
  const current = active && state.data?.key === key ? state.data : null;
  return {
    /** A search or a tag is set: the rows are the server's. */
    active,
    /** The answer to the current search (null while it loads). */
    current,
    busy: active && !current && !state.error,
    error: state.error,
    reload: state.reload,
  };
}

interface FilterGroup {
  /** The URL key the values belong to. */
  key: ListFilter;
  /** A caption inside the menu when it has several groups (and in «Ещё», its chips). */
  label?: string;
  options: FilterOption[];
}

/** The filters behind «Ещё» (the owner's decision): the panel keeps Раздел, Состояние, Владелец, Система. */
const MORE_FILTERS: readonly ListFilter[] = ["tag", "source"];

interface FilterMenuProps {
  /** «Раздел»: the menu's name and the button's prefix. */
  title: string;
  /** The button with nothing chosen: «Раздел: все», «Владелец». */
  idle: string;
  groups: FilterGroup[];
  values: Record<ListFilter, string[]>;
  onToggle: (key: ListFilter, value: string) => void;
  onClear: () => void;
  /** «Ещё»: the button keeps its name (the chosen values are chips beside it) and every group has its caption. */
  more?: boolean;
}

/** A menu button with independent choices (`menuitemcheckbox`): «Раздел: все», «Раздел: Интеграции, Домен». */
function FilterMenu({ title, idle, groups, values, onToggle, onClear, more = false }: FilterMenuProps) {
  const chosen = groups.flatMap((group) =>
    values[group.key].map((value) => group.options.find((option) => option.value === value)?.label ?? value),
  );
  const active = chosen.length > 0;
  const menuGroups: MenuGroup[] = groups.map((group) => ({
    label: groups.length > 1 || more ? group.label : undefined,
    multi: true,
    items: group.options.map((option) => ({
      id: `${group.key}:${option.value}`,
      label: option.label,
      meta: String(option.count),
      checked: values[group.key].includes(option.value),
      onSelect: () => onToggle(group.key, option.value),
    })),
  }));
  if (active) menuGroups.push({ items: [{ id: "clear", label: "Показать все", onSelect: onClear }] });
  return (
    <Menu
      label={title}
      className="docs-filter-menu"
      groups={menuGroups}
      trigger={(props) => (
        <button {...props} type="button" className={active && !more ? "docs-filter docs-filter--on" : "docs-filter"}>
          <span className="docs-filter__text">{active && !more ? `${title}: ${chosen.join(", ")}` : idle}</span>
          <Icon name="chevron" size={12} />
        </button>
      )}
    />
  );
}

/** One filter of the phone sheet: toggle buttons; several values combine with «или». */
function SheetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="facet-group" aria-label={title}>
      <h3 className="facet-group__title">{title}</h3>
      <ul role="group" aria-label={title}>
        {children}
      </ul>
    </section>
  );
}

function SheetOption({ label, count, pressed, onClick }: { label: string; count?: number; pressed: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="filter-option" aria-pressed={pressed} onClick={onClick}>
        <Icon name="check" size={14} className="filter-option__check" />
        <span className="filter-option__label">{label}</span>
        {count !== undefined ? <span className="filter-option__count">{count}</span> : null}
      </button>
    </li>
  );
}

/** «Проверен»: the date (amber with a clock when overdue), «не проверялся» (amber), «не требуется» (muted). */
function Review({ entry }: { entry: DocumentTreeEntry }) {
  const mark = tableReviewMark(entry);
  return (
    <span className={`docs-table__review docs-table__review--${mark.tone}`} title={mark.description}>
      {mark.tone === "warn" ? <Icon name="clock" size={13} /> : null}
      <span aria-hidden="true">{mark.text}</span>
      <span className="visually-hidden">{mark.description}</span>
    </span>
  );
}

const SORT_NAME: Record<SortKey, string> = {
  title: "Название",
  type: "Раздел",
  status: "Состояние",
  owner: "Владелец",
  reviewed: "Проверен",
  links: "Связи",
};

export function DocsTable({ tree, notice }: { tree: DocumentTreeState; notice?: ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const phone = useMediaQuery(PHONE);
  const sheetMode = useSidePanelMode(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const narrow = useMediaQuery(NARROW);
  // The reader's choice of columns (null: never chosen — then the width decides).
  const [chosen, setChosen] = useState<Set<ColumnKey> | null>(readHiddenColumns);
  const hidden = chosen ?? new Set<ColumnKey>(narrow ? NARROW_HIDDEN : []);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLAnchorElement>());

  const query = queryOf(params);
  const filters = readFilters(params);
  const sort = parseSort(params.get(SORT_PARAM));
  const group = parseGroup(params.get(GROUP_PARAM));
  const server = useServerIds(query, filters.tag);
  const facets = useAsync(() => api.facets(), "facets");
  const index = tree.index;

  if (tree.error) return <ErrorState error={tree.error} onRetry={tree.reload} />;
  if (!index) return <Loading />;
  const documents = index.tree.documents;
  // Up to a few hundred rows: filtered and sorted on every render (cheaper than keeping it in sync).
  const rows = server.busy
    ? []
    : sortIdsBy(
        Object.keys(documents).filter(
          (id) => matchesFilters(documents[id] as DocumentTreeEntry, filters) && (!server.active || Boolean(server.current?.ids.has(id))),
        ),
        documents,
        sort,
      );

  function update(changes: Record<string, string | null>) {
    setParams(withParams(params, { ...changes, page: null }));
  }

  function toggle(key: ListFilter, value: string) {
    update({ [key]: toggled(filters[key], value) });
  }

  /** Filters and the search go; the view, the sort and the grouping stay. */
  function resetFilters() {
    update({
      ...Object.fromEntries(LIST_FILTERS.map((key) => [key, null])),
      [ATTENTION_PARAM]: null,
      [QUERY_PARAM]: null,
      [LEGACY_QUERY_PARAM]: null,
    });
  }

  function setSort(next: TableSort) {
    update({ [SORT_PARAM]: sortValue(next) });
  }

  function setGroup(next: TableGroup) {
    update({ [GROUP_PARAM]: next === "none" ? null : next });
  }

  function toggleColumn(key: ColumnKey) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    rememberHiddenColumns(next);
    setChosen(next);
  }

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const total = index.tree.total;
  const columns = TABLE_COLUMNS.filter((column) => !hidden.has(column.key));
  const groups = groupIds(rows, index, group);
  const grouped = group !== "none";
  const visibleIds = groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.ids));
  const tabStop = focusId && visibleIds.includes(focusId) ? focusId : visibleIds[0];
  const sources = new Set(rows.map((id) => documents[id]?.source));
  // The source on every row when the rows mix sources, and on every search result (provenance on each result).
  const mixedSources = sources.size > 1 || Boolean(query);
  const singleSource = sources.size === 1 && !mixedSources ? [...sources][0] : undefined;
  const activeCount = filterCount(filters) + (query ? 1 : 0);
  const busy = server.busy;
  const countText = busy ? "Поиск…" : `${rows.length} из ${total}`;
  const countLabel = busy ? "Поиск…" : `Показано ${rows.length} ${pluralRu(rows.length, "документ", "документа", "документов")} из ${total}`;
  const allSources = sourceOptions(index, sourceLabel);
  // A chosen source the base does not have (a shared link) is still offered, so it can be unticked.
  const sourceChoices: FilterOption[] = [
    ...allSources,
    ...filters.source.filter((source) => !allSources.some((option) => option.value === source)).map((source) => ({ value: source, label: sourceLabel(source), count: 0 })),
  ];
  // The 30 most used tags (the facets of the base), plus a chosen tag outside them (a link from a document).
  const topTags = (facets.data?.tags ?? []).slice(0, 30).map((f) => ({ value: f.value, label: f.value, count: f.count }));
  const tagOptions: FilterOption[] = [
    ...topTags,
    ...filters.tag
      .filter((tag) => !topTags.some((option) => option.value === tag))
      .map((tag) => ({ value: tag, label: tag, count: (facets.data?.tags ?? []).find((f) => f.value === tag)?.count ?? 0 })),
  ];

  const panelFilters: { title: string; idle: string; groups: FilterGroup[] }[] = [
    { title: "Раздел", idle: "Раздел: все", groups: [{ key: "type", options: sectionOptions(index) }] },
    {
      title: "Состояние",
      idle: "Состояние: все",
      groups: [
        { key: "status", label: "Статус", options: statusOptions(index, STATUS_LABEL) },
        { key: "flag", label: "Проверка и владелец", options: flagOptions(index) },
      ],
    },
    { title: "Владелец", idle: "Владелец", groups: [{ key: "owner", options: ownerOptions(index) }] },
    { title: "Система", idle: "Система", groups: [{ key: "system", options: systemOptions(index) }] },
  ];
  // «Ещё»: Тег, and Источник when the base has several sources. A chosen value is always offered (its group shows up).
  const moreGroups: FilterGroup[] = [
    ...(tagOptions.length > 0 ? [{ key: "tag" as const, label: "Тег", options: tagOptions }] : []),
    ...(allSources.length > 1 || filters.source.length > 0 ? [{ key: "source" as const, label: "Источник", options: sourceChoices }] : []),
  ];
  // The phone sheet lists every filter as its own group.
  const sheetFilters = [...panelFilters, ...moreGroups.map((g) => ({ title: g.label ?? g.key, idle: g.label ?? g.key, groups: [g] }))];

  /** An active filter from «Ещё» stays in sight: a chip on the panel with «×». */
  const moreChips = moreGroups.flatMap((g) =>
    filters[g.key].map((value) => {
      const label = g.options.find((option) => option.value === value)?.label ?? (g.key === "source" ? sourceLabel(value) : value);
      return (
        <Chip key={`${g.key}:${value}`} tone="filter" onRemove={() => toggle(g.key, value)} removeLabel={`Убрать фильтр «${g.label ?? g.key}: ${label}»`}>
          {g.label}: {label}
        </Chip>
      );
    }),
  );

  const attentionToggle = (
    <button
      type="button"
      className={filters.attention ? "docs-filter docs-filter--on" : "docs-filter"}
      aria-pressed={filters.attention}
      onClick={() => update({ [ATTENTION_PARAM]: filters.attention ? null : "1" })}
    >
      Только требующие внимания
    </button>
  );

  const extras = (
    <>
      {query ? (
        <Chip tone="filter" onRemove={() => update(searchChanges(""))} removeLabel="Убрать запрос">
          Запрос: «{query}»
        </Chip>
      ) : null}
      {activeCount > 0 ? (
        <Button variant="quiet" size="sm" onClick={resetFilters}>
          Сбросить фильтры
        </Button>
      ) : null}
      {query && rows.length > 0 && canAsk(session?.features.ai_mode) ? (
        <Link to={askAboutResults(query, rows)} className={buttonClass("quiet", "sm")}>
          Спросить ИИ об этих документах
        </Link>
      ) : null}
    </>
  );

  const groupMenu = (
    <Menu
      label="Группировка"
      align="end"
      groups={[
        {
          radio: true,
          items: TABLE_GROUPS.map((value) => ({
            id: value,
            label: value === "none" ? "Без группировки" : GROUP_LABEL[value],
            checked: group === value,
            onSelect: () => setGroup(value),
          })),
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className="docs-filter docs-filter--quiet">
          Группировка: {GROUP_LABEL[group]}
        </button>
      )}
    />
  );

  const columnsMenu = (
    <Menu
      label="Колонки"
      align="end"
      groups={[
        {
          multi: true,
          items: TABLE_COLUMNS.filter((column) => column.hideable).map((column) => ({
            id: column.key,
            label: column.label,
            checked: !hidden.has(column.key),
            onSelect: () => toggleColumn(column.key),
          })),
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className="docs-filter docs-filter--quiet">
          Колонки
        </button>
      )}
    />
  );

  /** A press on the row (outside its links and buttons) opens the document; the title stays the keyboard path. */
  function openRow(id: string) {
    return (event: MouseEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("a, button")) return;
      if (window.getSelection()?.toString()) return; // selecting text is not a click
      navigate(docHref(id));
    };
  }

  function focusRow(id: string | undefined) {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  }

  function onRowKey(event: KeyboardEvent<HTMLAnchorElement>, id: string) {
    const at = visibleIds.indexOf(id);
    const go = (target: string | undefined) => {
      event.preventDefault();
      focusRow(target);
    };
    if (event.key === "ArrowDown") go(visibleIds[Math.min(at + 1, visibleIds.length - 1)]);
    else if (event.key === "ArrowUp") go(visibleIds[Math.max(at - 1, 0)]);
    else if (event.key === "Home") go(visibleIds[0]);
    else if (event.key === "End") go(visibleIds[visibleIds.length - 1]);
  }

  const notes =
    server.current && server.current.notes.length > 0 ? (
      <Notice tone="info" className="docs-table__notes">
        <ul>
          {server.current.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Notice>
    ) : null;

  const empty =
    rows.length === 0 && !busy && !server.error ? (
      <EmptyState title={query ? `По запросу «${query}» ничего не найдено` : "Документов с такими фильтрами нет"}>
        <p>Измените или сбросьте фильтры. Поиск ищет по названию, тексту, тегам и связанным ID.</p>
        {activeCount > 0 ? <Button onClick={resetFilters}>Сбросить фильтры</Button> : null}
      </EmptyState>
    ) : null;

  function groupToggle(key: string, label: string, count: number) {
    return (
      <button type="button" className="docs-table__group-toggle" aria-expanded={!collapsed.has(key)} onClick={() => toggleGroup(key)}>
        <Icon name="chevron" size={14} className="docs-table__group-chevron" />
        <span>{label}</span>
        <span className="docs-table__group-count">
          {count}
          <span className="visually-hidden"> {pluralRu(count, "документ", "документа", "документов")}</span>
        </span>
      </button>
    );
  }

  // --- a phone: the filters in a sheet, the rows as cards -------------------------------------------------------
  if (phone) {
    const sheet = sheetOpen ? (
      <SidePanel id="docs-table-filters" title="Фильтры" mode={sheetMode} onClose={() => setSheetOpen(false)}>
        <div className="facet-groups">
          <SheetGroup title="Внимание">
            <SheetOption
              label="Только требующие внимания"
              pressed={filters.attention}
              onClick={() => update({ [ATTENTION_PARAM]: filters.attention ? null : "1" })}
            />
          </SheetGroup>
          {sheetFilters.flatMap((menu) =>
            menu.groups.map((g) => (
              <SheetGroup key={`${menu.title}-${g.key}`} title={menu.groups.length > 1 ? `${menu.title}: ${(g.label ?? "").toLocaleLowerCase("ru")}` : menu.title}>
                {g.options.map((option) => (
                  <SheetOption
                    key={option.value}
                    label={option.label}
                    count={option.count}
                    pressed={filters[g.key].includes(option.value)}
                    onClick={() => toggle(g.key, option.value)}
                  />
                ))}
              </SheetGroup>
            )),
          )}
          <SheetGroup title="Сортировка">
            {TABLE_COLUMNS.filter((column) => column.sort).flatMap((column) => {
              const key = column.sort as SortKey;
              return (["asc", "desc"] as const).map((dir) => (
                <SheetOption
                  key={`${key}-${dir}`}
                  label={`${SORT_NAME[key]}: ${dir === "asc" ? "по возрастанию" : "по убыванию"}`}
                  pressed={sort.key === key && sort.dir === dir}
                  onClick={() => setSort({ key, dir })}
                />
              ));
            })}
          </SheetGroup>
          <SheetGroup title="Группировка">
            {TABLE_GROUPS.map((value) => (
              <SheetOption key={value} label={value === "none" ? "Без группировки" : GROUP_LABEL[value]} pressed={group === value} onClick={() => setGroup(value)} />
            ))}
          </SheetGroup>
        </div>
        {activeCount > 0 ? (
          <Button variant="quiet" size="sm" onClick={resetFilters}>
            Сбросить фильтры
          </Button>
        ) : null}
      </SidePanel>
    ) : null;

    return (
      <div className="docs-table-view docs-table-view--phone">
        <div className="docs-table-bar">
          <Button size="sm" icon="filter" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
            Фильтры{activeCount > 0 ? ` (${activeCount})` : ""}
          </Button>
          <span className="docs-table-bar__count" aria-live="polite" aria-label={countLabel}>
            {countText}
          </span>
          {extras}
        </div>
        {sheet}
        {notice ? <div className="docs-table__notice">{notice}</div> : null}
        {notes}
        {server.error ? <ErrorState error={server.error} onRetry={server.reload} /> : null}
        {busy ? <Loading /> : null}
        {empty}
        {rows.length > 0 ? (
          <div className="docs-cards">
            {groups.map((g) => (
              <section key={g.key} aria-label={grouped ? `${GROUP_LABEL[group]}: ${g.label}` : "Документы"}>
                {grouped ? (
                  <h3 className="docs-cards__group">
                    {g.label} <span className="docs-table__group-count">{g.ids.length}</span>
                  </h3>
                ) : null}
                <ul className="docs-cards__list">
                  {g.ids.map((id) => {
                    const entry = documents[id] as DocumentTreeEntry;
                    return (
                      <li key={id} className={entry.status === "deprecated" ? "docs-card docs-card--deprecated" : "docs-card"} onClick={openRow(id)}>
                        <Link to={docHref(id)} className="docs-card__title">
                          {entry.title}
                        </Link>
                        <span className="docs-card__meta">
                          <StatusMark status={entry.status} />
                          <Review entry={entry} />
                          <span className="docs-table__id">{id}</span>
                          {mixedSources ? <SourceNote source={entry.source} /> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // --- the table ------------------------------------------------------------------------------------------------
  return (
    <div className="docs-table-view">
      <div className="docs-table-bar">
        <div className="docs-table-bar__filters" role="group" aria-label="Фильтры">
          {panelFilters.map((menu) => (
            <FilterMenu
              key={menu.title}
              title={menu.title}
              idle={menu.idle}
              groups={menu.groups}
              values={filters}
              onToggle={toggle}
              onClear={() => update(Object.fromEntries(menu.groups.map((g) => [g.key, null])))}
            />
          ))}
          {attentionToggle}
          {moreGroups.length > 0 ? (
            <FilterMenu
              more
              title="Ещё фильтры"
              idle="Ещё"
              groups={moreGroups}
              values={filters}
              onToggle={toggle}
              onClear={() => update(Object.fromEntries(MORE_FILTERS.map((key) => [key, null])))}
            />
          ) : null}
          {moreChips}
          {extras}
        </div>
        <div className="docs-table-bar__end">
          <span className="docs-table-bar__count" aria-live="polite" aria-label={countLabel}>
            {countText}
          </span>
          {groupMenu}
          {columnsMenu}
        </div>
      </div>
      {notice ? <div className="docs-table__notice">{notice}</div> : null}
      {notes}
      {server.error ? <ErrorState error={server.error} onRetry={server.reload} /> : null}
      {busy ? <Loading /> : null}
      {empty}
      {rows.length > 0 ? (
        <div className="docs-table-wrap">
          <table className="docs-table">
            <caption className="visually-hidden">
              Документы{grouped ? `, группировка: ${GROUP_LABEL[group].toLocaleLowerCase("ru")}` : ""}
              {singleSource ? `. Источник: ${sourceLabel(singleSource)}` : ""}
            </caption>
            <colgroup>
              {columns.map((column) => (
                <col key={column.key} className={`docs-table__col-${column.key}`} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((column) => {
                  const sorted = column.sort !== null && sort.key === column.sort;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      className={column.key === "links" ? "docs-table__num" : undefined}
                      aria-sort={sorted ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {column.sort ? (
                        <button type="button" className="docs-table__sort" onClick={() => setSort(nextSort(sort, column.sort as SortKey))}>
                          {column.label}
                          {sorted ? (
                            <Icon name="sort-up" size={12} strokeWidth={2.2} className={sort.dir === "desc" ? "docs-table__sort-icon docs-table__sort-icon--desc" : "docs-table__sort-icon"} />
                          ) : null}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key}>
                {grouped ? (
                  <tr className="docs-table__group">
                    <th scope="rowgroup" colSpan={columns.length}>
                      {groupToggle(g.key, g.label, g.ids.length)}
                    </th>
                  </tr>
                ) : null}
                {collapsed.has(g.key)
                  ? null
                  : g.ids.map((id) => (
                      <Row
                        key={id}
                        id={id}
                        entry={documents[id] as DocumentTreeEntry}
                        index={index}
                        columns={columns.map((c) => c.key)}
                        mixedSources={mixedSources}
                        tabStop={id === tabStop}
                        linkRef={(element) => {
                          if (element) refs.current.set(id, element);
                          else refs.current.delete(id);
                        }}
                        onOpen={openRow(id)}
                        onKeyDown={(event) => onRowKey(event, id)}
                        onFocus={() => setFocusId(id)}
                      />
                    ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** The quiet source after the ID: «GitLab», «Локальный workspace» (named «Источник» for assistive technology). */
function SourceNote({ source }: { source: string }) {
  return (
    <span className="docs-table__source">
      <span className="visually-hidden">Источник: </span>
      {sourceLabel(source)}
    </span>
  );
}

interface RowProps {
  id: string;
  entry: DocumentTreeEntry;
  index: TreeIndex;
  columns: ColumnKey[];
  mixedSources: boolean;
  tabStop: boolean;
  linkRef: (element: HTMLAnchorElement | null) => void;
  onOpen: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => void;
  onFocus: () => void;
}

function Row({ id, entry, index, columns, mixedSources, tabStop, linkRef, onOpen, onKeyDown, onFocus }: RowProps) {
  const cell = (key: ColumnKey): ReactNode => {
    switch (key) {
      case "title":
        return (
          <td key={key} className="docs-table__name">
            <span className="docs-table__name-line">
              <Link ref={linkRef} to={docHref(id)} className="docs-table__title" tabIndex={tabStop ? 0 : -1} title={entry.title} onKeyDown={onKeyDown} onFocus={onFocus}>
                {entry.title}
              </Link>
              <span className="docs-table__id">{id}</span>
              {mixedSources ? <SourceNote source={entry.source} /> : null}
              {entry.index_state === "stale" ? <StaleMark /> : null}
            </span>
          </td>
        );
      case "type": {
        const section = index.nodes.get(entry.type)?.label ?? entry.type;
        return (
          <td key={key} title={section}>
            {section}
          </td>
        );
      }
      case "status":
        return (
          <td key={key}>
            <StatusMark status={entry.status} className="docs-table__status" />
          </td>
        );
      case "owner":
        return entry.owner_missing ? (
          <td key={key} className="docs-table__no-owner">
            не назначен
          </td>
        ) : (
          <td key={key} title={entry.owner}>
            {entry.owner}
          </td>
        );
      case "systems":
        return (
          <td key={key} title={entry.systems.join(", ") || undefined}>
            {entry.systems.join(", ")}
          </td>
        );
      case "reviewed":
        return (
          <td key={key}>
            <Review entry={entry} />
          </td>
        );
      case "links":
        return (
          <td key={key} className="docs-table__num">
            {entry.link_count}
          </td>
        );
      default:
        return null;
    }
  };
  return (
    <tr className={entry.status === "deprecated" ? "docs-table__row docs-table__row--deprecated" : "docs-table__row"} onClick={onOpen}>
      {columns.map(cell)}
    </tr>
  );
}
