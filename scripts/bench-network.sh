#!/usr/bin/env bash
# Compare direct vs local proxy for the hosts this project depends on.
# Usage: scripts/bench-network.sh [url ...]
set -euo pipefail

PROXY="${PROXY:-http://127.0.0.1:7897}"
MAX_TIME="${MAX_TIME:-10}"

urls=("$@")
if [ "${#urls[@]}" -eq 0 ]; then
  urls=(
    "https://registry.npmjs.org/"
    "https://bun.sh/"
    "https://go.dev/dl/"
    "https://dl.google.com/android/repository/repository2-1.xml"
    "https://github.com/"
    "https://repo1.maven.org/maven2/"
    "https://goproxy.cn/"
  )
fi

for url in "${urls[@]}"; do
  echo "== ${url} =="
  curl -o /dev/null -sS --max-time "$MAX_TIME" \
    -w 'direct  code=%{http_code} time=%{time_total}s speed=%{speed_download}B/s\n' \
    "$url" || echo "direct  FAILED"
  curl -x "$PROXY" -o /dev/null -sS --max-time "$MAX_TIME" \
    -w 'proxy   code=%{http_code} time=%{time_total}s speed=%{speed_download}B/s\n' \
    "$url" || echo "proxy   FAILED"
done
