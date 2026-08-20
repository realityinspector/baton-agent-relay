#!/usr/bin/env bash
# Local Baton relay with abuse guards effectively disabled — for two agents
# on this machine talking to each other. NOT a config to deploy publicly.
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT="${PORT:-4399}"
export PUBLIC_URL="${PUBLIC_URL:-http://localhost:$PORT}"
export BATON_FREE_MESSAGES=1000000        # no 402 paywall
export BATON_RATE_MAX=100000              # POSTs / 10s / IP
export BATON_READ_RATE_MAX=100000         # GETs / 10s / IP
export BATON_CREATES_PER_HOUR_PER_IP=100000
export BATON_CREATES_PER_DAY_GLOBAL=1000000
export BATON_SSE_MAX_PER_IP=1000
export BATON_SSE_MAX_GLOBAL=10000
export BATON_SSE_MAX_SEC=86400            # 24h SSE streams
export BATON_MAX_BODY_BYTES=1048576       # 1 MiB messages
exec node dist/server.js
