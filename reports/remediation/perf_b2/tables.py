"""Markdown tables from a B2 session directory (load_*.json, http_*.json). Usage: tables.py SESSION_DIR"""
import json
import sys
from pathlib import Path

d = Path(sys.argv[1])
EPS = [("list200", "список 200"), ("gantt", "Гант"), ("task_patch", "PATCH"), ("schedule_preview", "preview"),
       ("project", "проект"), ("task_get", "задача GET")]


def j(p: Path):
    return json.loads(p.read_text()) if p.exists() else None


def f(x):
    return "—" if x is None else (f"{x:.1f}" if x < 100 else f"{x:.0f}")


print("### Нагрузка (p50 / p95, мс)\n")
print("| Задач | Клиенты | Версия | RPS | " + " | ".join(n for _, n in EPS) + " | 5xx | 409 | RSS max, МБ | CPU avg / max, % | load avg 1 мин (min–max) |")
print("|" + "---|" * (4 + len(EPS) + 5))
for size in (25, 200, 1000):
    for c in (1, 3, 10):
        for stack, name in (("base", "до"), ("after", "после")):
            s = j(d / f"load_{stack}_t{size}_c{c}.json")
            if not s:
                continue
            cells = []
            for ep, _ in EPS:
                e = s["endpoints"].get(ep)
                cells.append(f"{f(e['p50'])} / {f(e['p95'])}" if e else "—")
            n5 = sum(v for k, v in s["status"].items() if k.startswith("5"))
            n409 = s["status"].get("409", 0)
            print(f"| {size} | {c} | {name} | {s['rps']} | " + " | ".join(cells)
                  + f" | {n5} | {n409} | {s['rss_mb_max']} | {s['cpu_pct_avg']} / {s['cpu_pct_max']} | "
                  f"{s['loadavg1_min']}–{s['loadavg1_max']} |")
print("\n### Последовательно, 1 клиент (p50 / p95, мс; 5 прогревочных + 40 замеров)\n")
HE = [("projects_list", "список проектов"), ("project", "проект"), ("list200", "список 200"), ("gantt", "Гант"),
      ("task_get", "задача GET"), ("task_patch", "PATCH"), ("schedule_preview", "preview"),
      ("task_activity", "история задачи")]
print("| Задач | Версия | " + " | ".join(n for _, n in HE) + " |")
print("|" + "---|" * (2 + len(HE)))
for size in (25, 200, 1000):
    for stack, name in (("base", "до"), ("after", "после")):
        s = j(d / f"http_{stack}_{size}.json")
        if not s:
            continue
        print(f"| {size} | {name} | " + " | ".join(
            f"{f(s['endpoints'][e]['p50'])} / {f(s['endpoints'][e]['p95'])}" for e, _ in HE) + " |")
