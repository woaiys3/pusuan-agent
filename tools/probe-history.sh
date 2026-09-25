#!/usr/bin/env bash
# 探测 session.history 的真实返回结构（决定界面如何回填历史消息）
# 用法: sh tools/probe-history.sh [port]
set -eu
PORT="${1:-3081}"
BASE="http://127.0.0.1:$PORT"

SID=$(curl -s --max-time 25 -X POST "$BASE/api/session.create" \
  -H 'content-type: application/json' \
  --data-binary '{"type":"client-request","rpcId":"mk","method":"session.create","payload":{"agentPreset":"question"}}' \
  | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
echo "sessionId = $SID"
echo

echo "─── session.history ───"
curl -s --max-time 25 -X POST "$BASE/api/session.history" \
  -H 'content-type: application/json' \
  --data-binary "{\"type\":\"client-request\",\"rpcId\":\"h1\",\"method\":\"session.history\",\"payload\":{\"sessionId\":\"$SID\"}}" \
  -w '\n[http:%{http_code}]\n'
echo

echo "─── session.history（带分页参数）───"
curl -s --max-time 25 -X POST "$BASE/api/session.history" \
  -H 'content-type: application/json' \
  --data-binary "{\"type\":\"client-request\",\"rpcId\":\"h2\",\"method\":\"session.history\",\"payload\":{\"sessionId\":\"$SID\",\"maxMessages\":50}}" \
  -w '\n[http:%{http_code}]\n'
