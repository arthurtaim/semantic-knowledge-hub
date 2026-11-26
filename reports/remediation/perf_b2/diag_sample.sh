#!/bin/sh
# Where do the backend threads wait under 10 clients? Runs the load mix for 25 s and takes a macOS `sample` of the
# backend process for 8 s in the middle; sample_parse.py attributes the waits to call chains.
# usage: PY=<python> STATE_ROOT=<dir> diag_sample.sh STACK(base|after) BASE_URL LABEL OUTDIR
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:?set PY}; STATE_ROOT=${STATE_ROOT:?set STATE_ROOT}
STACK=$1; URL=$2; LABEL=$3; OUT=$4
mkdir -p "$OUT"
PID=$(cat "$STATE_ROOT/stack-$STACK/backend.pid")
$PY -I "$HERE/loadgen.py" "$URL" "$LABEL" 10 25 "$PID" "$OUT" 5 > "$OUT/$LABEL.out" 2>&1 &
LG=$!
sleep 12
sample "$PID" 8 -file "$OUT/$LABEL.sample.txt" > /dev/null 2>&1
wait $LG
cat "$OUT/$LABEL.out"
$PY -I "$HERE/sample_parse.py" "$OUT/$LABEL.sample.txt"
