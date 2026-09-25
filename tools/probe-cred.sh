#!/usr/bin/env bash
# 查内核的凭据与模型路由状态（判断对话是否真的能发出去）
# 用法: sh tools/probe-cred.sh [port]
set -eu
PORT="${1:-3080}"
BASE="http://127.0.0.1:$PORT"

call() {
  echo "─── $1 ───"
  curl -s --max-time 20 -X POST "$BASE/api/$1" \
    -H 'content-type: application/json' \
    --data-binary "{\"type\":\"client-request\",\"rpcId\":\"c$RANDOM\",\"method\":\"$1\",\"payload\":$2}" \
    -w '\n[http:%{http_code}]\n' | head -c 900
  echo
}

call "credentials.describe" "{}"
call "settings.describe" "{}"

echo "─── 凭据文件是否存在 ───"
ls -la /tmp/ps-home/.credentials.yaml 2>/dev/null || echo "(本地无)"
