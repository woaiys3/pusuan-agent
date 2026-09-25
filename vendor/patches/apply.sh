#!/usr/bin/env bash
# 把 Android 适配补丁应用到内核（kernel = 已装配到 payload 的 @deepseek-ai/dsh 树）
#
# 补丁分两类：
#  1) 原生模块桩：sharp / koffi / node-pty 在 Android(bionic) 上没有可用产物，
#     而内核多个包在**模块顶层静态 import** 它们 —— 缺了它们插件树整体加载失败。
#     内核代码逐字不动，只用"可加载、被真正调用时才报明确错误"的桩替换。
#  2) 清理：删掉与 Android 无关的平台专属子包（win32 等），减小体积。
#
# 用法: sh vendor/patches/apply.sh <kernelDir>
set -euo pipefail

K="${1:?用法: sh apply.sh <kernelDir>}"
STUBS="$(cd "$(dirname "$0")" && pwd)/native-stubs"

[ -d "$K/node_modules" ] || { echo "不是内核目录：$K" >&2; exit 1; }

echo "  应用原生模块桩："
for m in sharp koffi node-pty; do
  SRC="$STUBS/$m"
  [ -d "$SRC" ] || { echo "    缺少桩：$SRC" >&2; exit 1; }
  rm -rf "$K/node_modules/$m"
  mkdir -p "$K/node_modules/$m"
  cp -r "$SRC/." "$K/node_modules/$m/"
  echo "    $m"
done

echo "  清理平台专属子包："
# 这些是 Windows/macOS 专属的原生产物，Android 上既不能加载也白占体积
for d in \
  "$K/node_modules/@img/sharp-win32-x64" \
  "$K/node_modules/@img/sharp-darwin-arm64" \
  "$K/node_modules/@img/sharp-darwin-x64" \
  "$K/node_modules/@koromix/koffi-win32-x64" \
  "$K/node_modules/@koromix/koffi-darwin-arm64" \
  "$K/node_modules/@koromix/koffi-darwin-x64" \
  "$K/node_modules/@vscode/ripgrep-win32-x64" \
  "$K/node_modules/node-addon-require-builtin-win32-x64-msvc"
do
  [ -e "$d" ] && { rm -rf "$d"; echo "    $(echo "$d" | sed "s|$K/node_modules/||")"; }
done

# node-pty 的多平台预编译目录：只保留可能存在的 android 变体
if [ -d "$K/node_modules/node-pty" ]; then :; fi
for d in "$K"/node_modules/*/prebuilds; do
  [ -d "$d" ] || continue
  find "$d" -mindepth 1 -maxdepth 1 -type d \
    ! -name 'android-arm64' ! -name 'android-x64' -exec rm -rf {} + 2>/dev/null || true
done

echo "  补丁完成"
