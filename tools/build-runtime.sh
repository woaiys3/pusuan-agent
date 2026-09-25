#!/usr/bin/env bash
# 装配 Android 运行时：Termux 版 node + 其动态库依赖
#
# 为什么不直接用 node 官方 Android 包：官方没有 Android 目标产物；
# Termux 的构建是为 Android/bionic 编的（interpreter /system/bin/linker64），可直接用。
#
# 为什么需要手动补 soname 链接：APK 内是 zip，符号链接会被压平；
# 而 node 的 DT_NEEDED 要的是 libicui18n.so.78 这类版本化名字，
# deb 里只有 libicui18n.so.78.3 —— 必须复制成同名实体文件，否则 node 起不来。
#
# 用法: sh tools/build-runtime.sh [abi ...]     默认 arm64-v8a x86_64
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REFDIR="${PUSUAN_REFDIR:-/d/pusuan-refs}"
DEBDIR="$REFDIR/runtime-debs"
OUT="$ROOT/vendor/runtime"
MIRROR="${TERMUX_MIRROR:-https://packages.termux.dev/apt/termux-main}"

# deb 包名 → 是否必需。nodejs 是本体，其余是它的动态依赖。
NODE_VER="26.4.0-1"
DEPS=(
  "libcxx:pool/main/libc/libc++/libc++_30"
  "openssl:pool/main/o/openssl/openssl_1:3.6.3"
  "c-ares:pool/main/c/c-ares/c-ares_1.34.8"
  "libicu:pool/main/libi/libicu/libicu_78.3"
  "libsqlite:pool/main/libs/libsqlite/libsqlite_3.53.4"
  "zlib:pool/main/z/zlib/zlib_1.3.2"
  "libffi:pool/main/libf/libffi/libffi_3.8.0"
)

fetch() {  # fetch <url> <dest>
  [ -f "$2" ] && { echo "  已存在 $(basename "$2")"; return 0; }
  echo "  下载 $(basename "$2")"
  curl -fsSL --retry 3 --max-time 900 -o "$2" "$1"
}

mkdir -p "$DEBDIR"

if [ $# -gt 0 ]; then ABIS=("$@"); else ABIS=(arm64-v8a x86_64); fi

for ABI in "${ABIS[@]}"; do
  case "$ABI" in
    arm64-v8a) T=aarch64 ;;
    x86_64)    T=x86_64 ;;
    *) echo "不支持的 ABI: $ABI"; exit 1 ;;
  esac
  echo "═══ 装配 $ABI ═══"

  # 1) 下载
  fetch "$MIRROR/pool/main/n/nodejs/nodejs_${NODE_VER}_${T}.deb" "$DEBDIR/nodejs_$T.deb"
  for d in "${DEPS[@]}"; do
    name="${d%%:*}"; path="${d#*:}"
    fetch "$MIRROR/${path}_${T}.deb" "$DEBDIR/dep_${name}_$T.deb"
  done

  # 2) 解包（deb = ar 归档，用 JS 解包器；本机通常没有 ar）
  TMP="$DEBDIR/_x_$T"
  rm -rf "$TMP"; mkdir -p "$TMP"
  DEBUNPACK="$ROOT/tools/debunpack.js"
  for f in "$DEBDIR/nodejs_$T.deb" "$DEBDIR"/dep_*_"$T".deb; do
    node "$DEBUNPACK" "$(cygpath -w "$f")" "$(cygpath -w "$TMP/$(basename "$f" .deb)")" >/dev/null
  done

  # 3) 组装 bin/ 与 lib/
  rm -rf "$OUT/$ABI"; mkdir -p "$OUT/$ABI/bin" "$OUT/$ABI/lib"
  NODE_BIN="$(find "$TMP" -path '*usr/bin/node' -type f | head -1)"
  [ -n "$NODE_BIN" ] || { echo "  !! 未找到 node 可执行文件"; exit 1; }
  cp -L "$NODE_BIN" "$OUT/$ABI/bin/node"
  chmod +x "$OUT/$ABI/bin/node"

  find "$TMP" -path '*usr/lib*' -name '*.so*' -type f -exec cp -L {} "$OUT/$ABI/lib/" \; 2>/dev/null || true

  # 4) soname 实体化：node 的 DT_NEEDED 用未补零的版本化名字
  cd "$OUT/$ABI/lib"
  for pair in "libicui18n.so.78:libicui18n.so.78.3" \
              "libicuuc.so.78:libicuuc.so.78.3" \
              "libicudata.so.78:libicudata.so.78.3" \
              "libicutu.so.78:libicutu.so.78.3" \
              "libz.so.1:libz.so.1.3.2" \
              "libsqlite3.so:libsqlite3.so.3.53.4"; do
    want="${pair%%:*}"; have="${pair#*:}"
    [ -f "$have" ] || [ -f "$want" ] || continue
    [ -f "$want" ] || cp -L "$have" "$want"
  done
  cd "$ROOT"

  rm -rf "$TMP"
  echo "  bin/node $(du -h "$OUT/$ABI/bin/node" | cut -f1)  |  lib $(ls "$OUT/$ABI/lib" | wc -l) 个 so  $(du -sh "$OUT/$ABI/lib" | cut -f1)"
done

echo
echo "运行时就绪：$OUT"
