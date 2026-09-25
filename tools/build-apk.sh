#!/usr/bin/env bash
# 一键构建普算 APK。
#
# 用法: sh tools/build-apk.sh [arm64-v8a|x86_64] [debug|release]
#   arm64-v8a → 真机（默认）
#   x86_64    → 模拟器自测
#
# 为什么必须按 ABI 构建：APK 内嵌一份原生 node 运行时（约 50MB），
# 它只能在同架构设备上执行，所以 真机/模拟器 各出一版。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ABI="${1:-arm64-v8a}"
VARIANT="${2:-debug}"

JAVA_HOME_DEFAULT='C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot'
export JAVA_HOME="${JAVA_HOME:-$JAVA_HOME_DEFAULT}"
export ANDROID_HOME="${ANDROID_HOME:-C:\\Android}"

GRADLE="${GRADLE_BIN:-/d/pusuan-refs/gradle-dist/gradle-8.9/bin/gradle}"
[ -x "$GRADLE" ] || { echo "未找到 gradle：$GRADLE（用 GRADLE_BIN 指定）" >&2; exit 1; }

echo "═══ 1/3 运行时（node + 依赖库）═══"
sh "$ROOT/tools/build-runtime.sh" "$ABI"

echo
echo "═══ 2/3 payload（内核 + 普算配置层，ABI=$ABI）═══"
sh "$ROOT/tools/prepare-payload.sh" "$ABI"

echo
echo "═══ 3/3 打包 APK（$VARIANT）═══"
cd "$ROOT/android"
printf 'sdk.dir=C:/Android\n' > local.properties

TASK="assemble$(echo "${VARIANT:0:1}" | tr '[:lower:]' '[:upper:]')${VARIANT:1}"
# 必须 clean：payload.zip 以 noCompress 存储，增量构建会留下上一次的孤儿条目，
# 导致 APK 比实际内容大约 90MB（实测 196MB vs 应有的 110MB）。
# clean 的代价（约 45s）远低于交付一个尺寸异常的包。
"$GRADLE" --no-daemon clean "$TASK" --console=plain -PpusuanAbi="$ABI" 2>&1 | tail -30

APK="$(find "$ROOT/android/app/build/outputs/apk" -name "*.apk" -newermt '-30 minutes' | head -1)"
if [ -n "$APK" ]; then
  OUT="$ROOT/dist/pusuan-$VARIANT-$ABI.apk"
  mkdir -p "$ROOT/dist"
  cp "$APK" "$OUT"
  echo
  echo "APK → $OUT  ($(du -h "$OUT" | cut -f1))"
else
  echo "未找到产物 APK" >&2
  exit 1
fi
