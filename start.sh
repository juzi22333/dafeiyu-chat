#!/usr/bin/env bash
# 启动大肥鱼聊天。可覆盖：PORT / HOST / UPSTREAM_BASE_URL / UPSTREAM_API_KEY / UPSTREAM_MODEL
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
exec node server.js
