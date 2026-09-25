#!/usr/bin/env bash
# 装配 APK 内嵌的 payload：node 运行时 + DSH 内核 + 普算配置层
#
# 布局（App 启动时整包解压到私有目录）：
#   runtime/<abi>/bin/node, runtime/<abi>/lib/*.so
#   kernel/{package.json,lib,config,node_modules}      ← 内核与普算配置同源
#
# 内核为什么直接用 app 目录本身：`@deepseek-ai/dsh` 这个包就是 app/，
# 它的 profile-boot 用 import.meta.url 相对定位 config/（presets/skills/knowledge），
# 因此 config/ 必须与 lib/ 平级放在内核根下，位置不能挪。
#
# 用法: sh tools/prepare-payload.sh [abi]        默认 arm64-v8a
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REFDIR="${PUSUAN_REFDIR:-/d/pusuan-refs}"
KERNEL_SRC="$REFDIR/runtime2/app"
ABI="${1:-arm64-v8a}"
OUT="$ROOT/vendor/payload"

[ -d "$KERNEL_SRC" ] || { echo "缺少内核源：$KERNEL_SRC（PUSUAN_REFDIR 可覆盖）" >&2; exit 1; }
[ -d "$ROOT/vendor/runtime/$ABI" ] || { echo "缺少运行时 $ABI：先执行 tools/build-runtime.sh" >&2; exit 1; }

echo "装配 payload（ABI=$ABI）"
rm -rf "$OUT"
mkdir -p "$OUT/runtime" "$OUT/kernel"

# ── 1) node 运行时（按 ABI）──
cp -r "$ROOT/vendor/runtime/$ABI" "$OUT/runtime/$ABI"
chmod +x "$OUT/runtime/$ABI/bin/node"

# ── 2) 内核 + 配置（用 tar 管道，比逐文件复制快得多）──
( cd "$KERNEL_SRC" && tar cf - . ) | ( cd "$OUT/kernel" && tar xf - )

# ── 3) 剔除与 Android 无关的平台产物 ──
# 原包是 Windows x64 发行版，这些平台专属二进制在设备上既占体积也无法加载。
K="$OUT/kernel"
rm -f  "$K/.exe" "$K/node.exe" 2>/dev/null || true
rm -rf "$K/node_modules/@img/sharp-win32-x64" \
       "$K/node_modules/@koromix/koffi-win32-x64" \
       "$K/node_modules/node-addon-require-builtin-win32-x64-msvc" 2>/dev/null || true

# node-pty / koffi 的多平台预编译只保留 android（本发行版没有 android 产物，留空即可，
# 相应插件会在配置层禁用，不依赖这些 .node）。
for d in node_modules/node-pty/prebuilds; do
  [ -d "$K/$d" ] || continue
  find "$K/$d" -mindepth 1 -maxdepth 1 -type d \
    ! -name 'android-arm64' ! -name 'android-x64' -exec rm -rf {} + 2>/dev/null || true
done

# ── 3.5) 应用 Android 适配补丁（原生模块桩 + 平台清理）──
# 内核多个包在模块顶层静态 import 了 sharp/koffi/node-pty，
# 而这三者在 Android(bionic) 上没有可用产物 —— 不换掉就会整棵插件树加载失败。
# 补丁的取舍与理由见 vendor/patches/native-stubs/*/index.js。
sh "$ROOT/vendor/patches/apply.sh" "$K"

# ── 4) 打成单个 zip 作为 APK asset ──
# 为什么打包：assets 里放 1.4 万个小文件会显著拖慢 aapt/安装，且大量小文件在
# AssetManager 上读取开销高。打成 zip 后 App 首次启动流式解压。
# 用 jar（JDK 自带）而非第三方 zip 工具，保持构建链自包含。
ASSET_DIR="$ROOT/android/app/src/main/assets"
mkdir -p "$ASSET_DIR"
echo "  打包 payload.zip（压缩中，请稍候）"
rm -f "$ASSET_DIR/payload.zip"
( cd "$OUT" && jar cfM "$(cygpath -w "$ASSET_DIR/payload.zip")" . )

# ── 5) 汇总 ──
SIZE=$(du -sh "$OUT" | cut -f1)
FILES=$(find "$OUT" -type f | wc -l)
ZIP=$(du -sh "$ASSET_DIR/payload.zip" | cut -f1)
echo "  runtime/$ABI  $(du -sh "$OUT/runtime/$ABI" | cut -f1)"
echo "  kernel        $(du -sh "$K" | cut -f1)"
echo "  payload 合计  $SIZE / $FILES 个文件  →  payload.zip $ZIP"
echo
echo "配置层："
echo "  presets : $(ls "$K/config/agent-presets" 2>/dev/null | tr '\n' ' ')"
echo "  skills  : $(ls "$K/config/skills" 2>/dev/null | wc -l) 个"
echo "  corpus  : $(find "$K/config/knowledge/corpus" -name '*.md' 2>/dev/null | wc -l) 篇 md"
