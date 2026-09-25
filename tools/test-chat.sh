#!/usr/bin/env bash
# 端到端发一条消息，看内核是否真能跑通一轮对话
# 用法: sh tools/test-chat.sh [port]
set -eu
PORT="${1:-3080}"
BASE="http://127.0.0.1:$PORT"

mk() {
  curl -s --max-time 25 -X POST "$BASE/api/session.create" \
    -H 'content-type: application/json' \
    --data-binary '{"type":"client-request","rpcId":"mk","method":"session.create","payload":{"agentPreset":"question"}}' \
    | sed -E 's/.*"sessionId":"([^"]+)".*/\1/'
}

SID="$(mk)"
echo "sessionId = $SID"
echo

echo "─── session.prompt（发一句测试）───"
printf '%s' "{\"type\":\"client-request\",\"rpcId\":\"p1\",\"method\":\"session.prompt\",\"payload\":{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"你好\"}]}}" \
  | curl -s --max-time 60 -X POST "$BASE/api/session.prompt" \
      -H 'content-type: application/json' --data-binary @- \
      -w '\n[http:%{http_code}]\n' | head -c 800
echo

sleep 8

echo "─── session.history（看是否产生回复或错误）───"
printf '%s' "{\"type\":\"client-request\",\"rpcId\":\"h1\",\"method\":\"session.history\",\"payload\":{\"sessionId\":\"$SID\"}}" \
  | curl -s --max-time 25 -X POST "$BASE/api/session.history" \
      -H 'content-type: application/json' --data-binary @- | head -c 1500
echo
