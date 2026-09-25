#!/usr/bin/env bash
# 走一遍普算的核心会话流程，验证内核确实按预期工作：
#   session.create(提问模式) → skill.list → session.models → agentPreset.list
# 用法: sh tools/probe-flow.sh [port]
set -eu
PORT="${1:-3081}"
BASE="http://127.0.0.1:$PORT"

call() {  # call <endpoint> <payload-json> [label]
  echo "─── $1 （${3:-}）───"
  curl -s --max-time 25 -X POST "$BASE/api/$1" \
    -H 'content-type: application/json' \
    --data-binary "{\"type\":\"client-request\",\"rpcId\":\"probe-$RANDOM\",\"method\":\"$1\",\"payload\":$2}" \
    -w '\n[http:%{http_code}]\n'
  echo
}

echo "════ 1. 建会话（agentPreset=question 提问式占卜）════"
SID=$(curl -s --max-time 25 -X POST "$BASE/api/session.create" \
  -H 'content-type: application/json' \
  --data-binary '{"type":"client-request","rpcId":"mk-1","method":"session.create","payload":{"agentPreset":"question"}}' \
  | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
echo "sessionId = $SID"
echo

call "skill.list"      "{\"sessionId\":\"$SID\"}" "普算技能目录"
call "agentPreset.list" "{}" "智能体预设"
call "session.models"  "{\"sessionId\":\"$SID\"}" "可用模型"
call "session.list"    "{}" "会话列表"
