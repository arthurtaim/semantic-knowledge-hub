import { FIXED_ZOOMS, GANTT_ZOOM_LABEL, GANTT_ZOOMS, type GanttZoom } from "../../lib/gantt";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Popover";
import { SegmentedControl } from "../ui/SegmentedControl";

/*
 * The Gantt's controls at the right end of the filter row (Planner v2, docs/ui-v2/planner/specs/PLANNER_V2.md §2.4,
 * §3.2, §3.9): the zoom as segments «День | Неделя | Месяц | Квартал | Год» — a menu on a phone — and «Сегодня».
 */

interface GanttControlsProps {
  zoom: GanttZoom;
  onZoom: (zoom: GanttZoom) => void;
  onToday: () => void;
  /** Phones: the zoom is a menu (it includes «Вписать»). */
  phone: boolean;
}

export function GanttControls({ zoom, onZoom, onToday, phone }: GanttControlsProps) {
  return (
    <>
      {phone ? (
        <Menu
          label="Масштаб"
          align="end"
          className="docs-filter-menu"
          groups={[
            {
              radio: true,
              items: GANTT_ZOOMS.map((value) => ({ id: value, label: GANTT_ZOOM_LABEL[value], checked: zoom === value, onSelect: () => onZoom(value) })),
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className="docs-filter" aria-label={`Масштаб: ${GANTT_ZOOM_LABEL[zoom]}`}>
              <span className="docs-filter__text">{GANTT_ZOOM_LABEL[zoom]}</span>
              <Icon name="chevron" size={12} />
            </button>
          )}
        />
      ) : (
        <SegmentedControl
          label="Масштаб"
          className="work-toolbar__zoom"
          options={FIXED_ZOOMS.map((value): { value: GanttZoom; label: string } => ({ value, label: GANTT_ZOOM_LABEL[value] }))}
          value={zoom}
          onChange={onZoom}
        />
      )}
      <Button size="sm" onClick={onToday}>
        Сегодня
      </Button>
    </>
  );
}
