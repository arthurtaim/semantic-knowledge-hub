"""Markdown summary of ui_*_r{1,2}.json and svc_*.json in a session dir. Usage: ui_tables.py DIR"""
import json
import statistics
import sys
from pathlib import Path

d = Path(sys.argv[1])


def load(stack):
    return [json.loads((d / f"ui_{stack}_r{r}.json").read_text()) for r in (1, 2)]


def vals(runs, path):
    out = []
    for r in runs:
        x = r
        for p in path:
            x = x[p]
        out.extend(x["values"] if isinstance(x, dict) and "values" in x else [x])
    return out


def fmt(xs):
    xs = sorted(xs)
    return f"{statistics.median(xs):.0f} ({xs[0]:.0f}–{xs[-1]:.0f})"


rows = [
    ("Первая карточка, мс", ("board", "first_card_ms")),
    ("Первая карточка + 2 кадра, мс", ("board", "first_card_paint_ms")),
    ("Long tasks при открытии, шт.", ("board", "long_tasks", "count")),
    ("Самый длинный long task, мс", ("board", "long_tasks", "max_ms")),
    ("Сумма long tasks, мс", ("board", "long_tasks", "total_ms")),
    ("Узлов DOM", ("board", "dom_nodes")),
    ("Карточек в DOM", ("board", "cards_in_dom")),
    ("Alt+→: карточка в новой колонке, мс", ("board", "interactions", "keyboard_move", "right_ms")),
    ("Alt+←: обратно, мс", ("board", "interactions", "keyboard_move", "left_ms")),
    ("Alt+→ до конца тихого перечитывания (PATCH + проект + Гант), мс", ("board", "interactions", "keyboard_move", "right_settled_ms")),
    ("Event Timing клавиши (макс. на взаимодействие), мс", ("board", "interactions", "keyboard_move", "event_max_ms")),
    ("Перетаскивание: карточка в новой колонке после отпускания, мс", ("board", "interactions", "drag", "to_ms")),
    ("Перетаскивание обратно, мс", ("board", "interactions", "drag", "back_ms")),
    ("Event Timing перетаскивания, мс", ("board", "interactions", "drag", "event_max_ms")),
    ("Поиск «Нагрузка 99» (вкл. паузу 250 мс), мс", ("board", "interactions", "search_filter", "on_ms")),
    ("Сброс поиска — снова все карточки (вкл. 250 мс), мс", ("board", "interactions", "search_filter", "off_ms")),
    ("Long task при сбросе поиска, мс", ("board", "interactions", "search_filter", "off_long_task_max_ms")),
]
base, after = load("base"), load("after")
print("| Показатель (1000 карточек, 2 серии × 5 загрузок / 3 повтора) | До: медиана (min–max) | После: медиана (min–max) |")
print("|---|---|---|")
for label, path in rows:
    print(f"| {label} | {fmt(vals(base, path))} | {fmt(vals(after, path))} |")
for label, stack in (("до", base), ("после", after)):
    s = [r["board"]["interactions"]["scroll_to_bottom"] for r in stack]
    print(f"\nПрокрутка к низу ({label}): " + "; ".join(
        f"{x['ms']} мс, long tasks {x['long_tasks']['count']} (макс. {x['long_tasks']['max']} мс), карточек в DOM {x['cards_in_dom_after']}, узлов {x['dom_nodes_after']}"
        for x in s))
    v = [r["views"] for r in stack]
    print(f"Другие виды ({label}): список — первая строка " + ", ".join(fmt(x["list"]["first_row_ms"]["values"]) for x in v)
          + "; Гант — первая полоса " + ", ".join(fmt(x["gantt"]["first_row_ms"]["values"]) for x in v)
          + "; фокус следует за карточкой: " + ", ".join(str(r["board"]["interactions"]["keyboard_move"]["focus_followed"]) for r in stack)
          + "; ошибки консоли: " + str(sum(len(r["console_errors"]) for r in stack))
          + "; load avg (начало) " + ", ".join(f"{r['loadavg_start'][0]:.2f}" for r in stack))

print("\n### Уровень сервиса (svc_bench, p50 / p95, мс; 3 прогрева + 30 замеров)\n")
OPS = ["list_projects", "get_project", "list_tasks_200", "gantt", "get_task", "update_task", "preview", "task_activity"]
print("| Задач | Версия | " + " | ".join(OPS) + " |")
print("|" + "---|" * (2 + len(OPS)))
for name, label in (("svc_base", "до"), ("svc_after", "после"), ("svc_base_audit50", "до, 50 событий аудита/задачу"),
                    ("svc_after_audit50", "после, 50 событий аудита/задачу")):
    p = d / f"{name}.json"
    if not p.exists():
        continue
    j = json.loads(p.read_text())
    for size, res in j["sizes"].items():
        print(f"| {size} | {label} | " + " | ".join(f"{res[o]['p50']:.1f} / {res[o]['p95']:.1f}" for o in OPS) + " |")
