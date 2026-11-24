"""Latency of /api/search and the catalog query on the same KB, same queries, production refresh interval."""
import json, sys, time, warnings
warnings.filterwarnings("ignore")
from pathlib import Path
import yaml
from app.evaluation.knowledge_eval import eval_client
KB = Path(sys.argv[1]).resolve(); CASES = Path(sys.argv[2]).resolve(); LABEL = sys.argv[3]
qs = []
for f in sorted(CASES.glob("*.yaml")):
    for c in yaml.safe_load(f.read_text()) or []:
        if c.get("method") == "search" and c.get("question"):
            qs.append(c["question"])
def pct(t, p): t = sorted(t); return round(t[min(len(t) - 1, round(p * (len(t) - 1)))], 2)
out = {"label": LABEL, "queries": len(qs), "rounds": 5}
with eval_client(KB, extra={"repository_refresh_seconds": 2.0}) as c:
    for q in qs: c.get("/api/search", params={"q": q})  # warm-up
    for name, call in (("search", lambda q: c.get("/api/search", params={"q": q})),
                       ("catalog_query", lambda q: c.get("/api/documents", params={"query": q}))):
        t, errors = [], 0
        for _ in range(5):
            for q in qs:
                s = time.perf_counter(); r = call(q); t.append((time.perf_counter() - s) * 1000)
                errors += r.status_code != 200
        out[name] = {"p50_ms": pct(t, .5), "p95_ms": pct(t, .95), "max_ms": round(max(t), 2), "errors": errors}
    s = time.perf_counter(); r = c.post("/api/index/sync"); out["sync_noop_ms"] = round((time.perf_counter() - s) * 1000, 2)
    s = time.perf_counter(); r = c.post("/api/index/sync", params={"rebuild": "true"}); out["sync_rebuild_ms"] = round((time.perf_counter() - s) * 1000, 2)
print(json.dumps(out, ensure_ascii=False))
