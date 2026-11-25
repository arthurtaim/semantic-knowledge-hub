#!/bin/sh
# B2 measurement session over two running stacks of the SAME machine: «before» (BASE_URL, backend pid file
# $STATE_ROOT/stack-base/backend.pid) and «after» (AFTER_URL, $STATE_ROOT/stack-after/backend.pid). For each size the
# project LD is grown to N tasks through the public API on both and put into one state (spread.py); then a sequential
# per-endpoint bench and the audit's load mix at 1, 3 and 10 clients, before/after alternating (ABBA by level).
# usage: PY=<python> STATE_ROOT=<dir> session.sh OUTDIR [SECONDS=30] [WARMUP=5]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:?set PY to a python with httpx}
STATE_ROOT=${STATE_ROOT:?set STATE_ROOT}
BASE_URL=${BASE_URL:-http://127.0.0.1:8052}
AFTER_URL=${AFTER_URL:-http://127.0.0.1:8051}
OUT=$1; DUR=${2:-30}; WARM=${3:-5}
mkdir -p "$OUT"
log() { echo "$(date '+%H:%M:%S') loadavg=$(sysctl -n vm.loadavg) $*" | tee -a "$OUT/session.log"; }
url_of() { if [ "$1" = base ]; then echo "$BASE_URL"; else echo "$AFTER_URL"; fi; }
pid_of() { cat "$STATE_ROOT/stack-$1/backend.pid"; }

prep() {  # prep STACK SIZE
  until curl -s -o /dev/null -w "%{http_code}" "$(url_of "$1")/api/health" | grep -q 200; do sleep 1; done
  $PY -I "$HERE/seed.py" "$(url_of "$1")" "$2" >> "$OUT/session.log" 2>&1
  $PY -I "$HERE/spread.py" "$(url_of "$1")" >> "$OUT/session.log" 2>&1
}
bench() { $PY -I "$HERE/http_bench.py" "$(url_of "$1")" "http_$1_$2" "$OUT/http_$1_$2.json" 40 >> "$OUT/session.log" 2>&1; }
load() {
  log "load $1 tasks=$2 clients=$3"
  $PY -I "$HERE/loadgen.py" "$(url_of "$1")" "load_$1_t$2_c$3" "$3" "$DUR" "$(pid_of "$1")" "$OUT" "$WARM" \
    >> "$OUT/session.log" 2>&1
  sleep 3
}

for SIZE in 25 200 1000; do
  log "prepare $SIZE"
  prep base "$SIZE"; prep after "$SIZE"
  log "http bench $SIZE"
  bench base "$SIZE"; bench after "$SIZE"
  load base "$SIZE" 1;  load after "$SIZE" 1
  load after "$SIZE" 3; load base "$SIZE" 3
  load base "$SIZE" 10; load after "$SIZE" 10
done
log "session done"
