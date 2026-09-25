#!/usr/bin/env bash
# 在内核运行期间探测其 HTTP 与 API 是否真的可用。
# 用法: sh tools/probe-api.sh [port]
set -eu
PORT="${1:-3081}"
BASE="http://127.0.0.1:$PORT"

echo "=== GET / （应为前端 SPA 的 index.html）==="
curl -s --max-time 10 -w '\n[http:%{http_code} bytes:%{size_download}]\n' "$BASE/" | head -c 400
echo

echo
echo "=== POST /api/host.describe ==="
curl -s --max-time 15 -X POST "$BASE/api/host.describe" \
  -H 'content-type: application/json' \
  --data-binary '{"type":"client-request","rpcId":"probe-1","method":"host.describe","payload":{}}' \
  -w '\n[http:%{http_code}]\n' | head -c 700
echo

echo
echo "=== POST /api/skill.list （应返回普算的 8 个技能）==="
curl -s --max-time 15 -X POST "$BASE/api/skill.list" \
  -H 'content-type: application/json' \
  --data-binary '{"type":"client-request","rpcId":"probe-2","method":"skill.list","payload":{}}' \
  -w '\n[http:%{http_code}]\n' | head -c 1200
echo
