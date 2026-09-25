#!/usr/bin/env bash
# 检查内核的凭据状态：全新安装是否已配置 API Key
# 用法: sh tools/check-cred.sh [port]
set -eu
PORT="${1:-3080}"
BASE="http://127.0.0.1:$PORT"

req() {
  local ep="$1" pl="$2"
  echo "─── $ep ───"
  printf '%s' "{\"type\":\"client-request\",\"rpcId\":\"cc$RANDOM\",\"method\":\"$ep\",\"payload\":$pl}" \
    | curl -s --max-time 20 -X POST "$BASE/api/$ep" \
        -H 'content-type: application/json' --data-binary @- \
        -w '\n[http:%{http_code}]\n' | head -c 700
  echo
}

# 内核的 DeepSeek 适配器用 DEEPSEEK_API_KEY 作为凭据引用名
req "credentials.describe" '{"refs":["DEEPSEEK_API_KEY"]}'
# 模型是否可路由（无凭据时通常会落在 failures 里）
req "llm.providers" '{}'
