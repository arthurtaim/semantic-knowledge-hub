import {
  FIXED_ZOOMS,
  GANTT_ZOOM_LABEL,
  GANTT_ZOOMS,
  LINKS_MODE_LABEL,
  LINKS_MODES,
  zoomForDayWidth,
  type GanttViewSettings,
  type GanttZoom,
} from "../../lib/gantt";
import { Button, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu, type MenuGroup } from "../ui/Popover";
import { SegmentedControl } from "../ui/SegmentedControl";

/*
 * The Gantt's controls at the right end of the filter row (Planner v2, docs/ui-v2/planner/specs/PLANNER_V2.md §2.4,
 * §3.2, §3.7, §3.9): the zoom as segments «День | Неделя | Месяц | Квартал | Год», «Вписать» (pressed while the zoom is
 * «Вписать»), «Сегодня» and «Вид» — how links and labels are drawn and the keys.
 *
 * The filter row stays one line (owner's decision): while the full form does not fit in the row — the page measures
 * the row itself, not the window — the zoom is a menu «Неделя ▾» (the phone's one) and «Вписать», «Сегодня» are icons
 * with a tooltip and a name. A smooth zoom (Ctrl/⌘ + wheel) lights no segment and checks no menu item, unless it lands
 * exactly on a named scale.
 */

const KEYS: [string, string][] = [
  ["⌘/Ctrl + колесо", "масштаб"],
  ["Shift + 1", "вписать проект"],
  ["T", "к сегодня"],
  ["← →", "сдвиг выбранной"],
  ["Shift + ← →", "длительность"],
  ["Enter", "последствия"],
  ["Esc", "отмена"],
];

const LINKS_HINT: Partial<Record<GanttViewSettings["links"], string>> = { auto: "по масштабу" };

interface GanttControlsProps {
  zoom: GanttZoom;
  /** The smooth zoom in px per day, when there is one. */
  dayWidthOverride: number | null;
  onZoom: (zoom: GanttZoom) => void;
  onFit: () => void;
  onToday: () => void;
  settings: GanttViewSettings;
  onSettings: (next: GanttViewSettings) => void;
  /** The server computes a critical path and returned one: «Критический путь» is offered (never a fake one). */
  criticalPathAvailable: boolean;
  /** The full form does not fit in the filter row: the zoom is a menu, «Вписать» and «Сегодня» are icons. */
  compact: boolean;
  /** Phones: the zoom is a menu (it includes «Вписать»); the row may wrap there. */
  phone: boolean;
}

export function GanttControls({ zoom, dayWidthOverride, onZoom, onFit, onToday, settings, onSettings, criticalPathAvailable, compact, phone }: GanttControlsProps) {
  const shown: GanttZoom | null = dayWidthOverride !== null ? zoomForDayWidth(dayWidthOverride) : zoom;
  const fitted = shown === "fit";

  const viewGroups: MenuGroup[] = [
    {
      label: "Связи между задачами",
      radio: true,
      items: LINKS_MODES.map((mode) => ({
        id: `links:${mode}`,
        label: LINKS_MODE_LABEL[mode],
        meta: LINKS_HINT[mode],
        checked: settings.links === mode,
        onSelect: () => onSettings({ ...settings, links: mode }),
      })),
    },
    {
      label: "Подписи на полосах",
      radio: true,
      items: [
        { id: "labels:auto", label: "Авто", meta: "внутри, если помещается", checked: settings.labels === "auto", onSelect: () => onSettings({ ...settings, labels: "auto" }) },
        { id: "labels:none", label: "Без подписей", meta: "названия слева", checked: settings.labels === "none", onSelect: () => onSettings({ ...settings, labels: "none" }) },
      ],
    },
    ...(criticalPathAvailable
      ? [
          {
            multi: true,
            items: [
              {
                id: "critical",
                label: "Критический путь",
                description: "по расчёту сервера",
                checked: settings.criticalPath,
                onSelect: () => onSettings({ ...settings, criticalPath: !settings.criticalPath }),
              },
            ],
          } satisfies MenuGroup,
        ]
      : []),
  ];

  const keys = (
    <div className="gantt-keys">
      <div className="gantt-keys__title">Клавиши</div>
      <dl className="gantt-keys__list">
        {KEYS.map(([key, what]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );

  const zoomMenu = (
    <Menu
      label="Масштаб"
      align="end"
      className="docs-filter-menu"
      groups={[
        {
          radio: true,
          items: GANTT_ZOOMS.map((value) => ({
            id: value,
            label: GANTT_ZOOM_LABEL[value],
            checked: shown === value,
            onSelect: () => (value === "fit" ? onFit() : onZoom(value)),
          })),
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className="docs-filter" aria-label={`Масштаб: ${shown ? GANTT_ZOOM_LABEL[shown] : "свой"}`}>
          <span className="docs-filter__text">{shown ? GANTT_ZOOM_LABEL[shown] : "Масштаб"}</span>
          <Icon name="chevron" size={12} />
        </button>
      )}
    />
  );
  const fitTitle = "Весь проект по ширине (Shift + 1)";
  const todayTitle = "К сегодня (T)";

  return (
    <>
      {phone || compact ? (
        zoomMenu
      ) : (
        <SegmentedControl
          label="Масштаб"
          className="work-toolbar__zoom"
          options={FIXED_ZOOMS.map((value): { value: GanttZoom; label: string } => ({ value, label: GANTT_ZOOM_LABEL[value] }))}
          value={shown ?? "fit"}
          onChange={onZoom}
        />
      )}
      {phone ? null : compact ? (
        <IconButton icon="fit" size="sm" variant="secondary" label="Вписать" title={fitTitle} aria-pressed={fitted} className="work-toolbar__fit" onClick={onFit} />
      ) : (
        <Button size="sm" icon="fit" aria-pressed={fitted} title={fitTitle} className="work-toolbar__fit" onClick={onFit}>
          Вписать
        </Button>
      )}
      {compact && !phone ? (
        <IconButton icon="today" size="sm" variant="secondary" label="Сегодня" title={todayTitle} onClick={onToday} />
      ) : (
        <Button size="sm" title={todayTitle} onClick={onToday}>
          Сегодня
        </Button>
      )}
      <Menu
        label="Вид диаграммы"
        align="end"
        className="gantt-view-menu"
        panelClassName="gantt-view-menu__panel"
        groups={viewGroups}
        footer={keys}
        trigger={(props) => (
          <button {...props} type="button" className="button button--secondary button--sm" title="Связи, подписи, клавиши">
            <Icon name="sliders" size={14} />
            Вид
          </button>
        )}
      />
    </>
  );
}
