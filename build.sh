#!/system/bin/sh
# 普算 Android 版 APK 构建脚本
# 用法: sh build.sh [release|debug]   （release 需要签名密钥）
set -e

P="$(cd "$(dirname "$0")" && pwd)"
source "$P/../buildenv/build/env.sh" 2>/dev/null || source ~/buildenv/build/env.sh

AJ="$P/../buildenv/build/platform33/android-13/android.jar"
[ -f "$AJ" ] || AJ="$P/sdk/android.jar"
JAVA_BIN="$P/../buildenv/usr/lib/jvm/java-17-openjdk/bin"
KEY="$P/release.jks"
MODE="${1:-debug}"
KEYSTORE_PASS="${KEYSTORE_PASS:-pusuan123}"

echo "== 0/8 准备输出目录 =="
rm -rf "$P/out/gen" "$P/out/classes" "$P/out/dex" "$P/out/unsigned.apk" "$P/out/aligned.apk"
mkdir -p "$P/out/gen" "$P/out/classes" "$P/out/dex"

echo "== 1/8 资源编译 (aapt) =="
aapt package -f -m -J "$P/out/gen" -M "$P/AndroidManifest.xml" -S "$P/res" -I "$AJ"

echo "== 2/8 javac =="
if ! "$JAVA_BIN/javac" -source 1.8 -target 1.8 -bootclasspath "$AJ" \
  -classpath "$P/out/gen" -d "$P/out/classes" \
  "$P/src/com/pusuan/MainActivity.java" "$P/out/gen/com/pusuan/R.java" \
  >"$P/out/javac.log" 2>&1; then
  echo "!! javac 编译失败，日志：$P/out/javac.log"
  tail -20 "$P/out/javac.log"
  exit 1
fi
NCLASS="$(find "$P/out/classes" -name '*.class' | wc -l)"
echo "  javac 完成，class 数：$NCLASS"
[ "$NCLASS" -gt 0 ] || { echo "!! javac 产物为空，中止构建"; exit 1; }

echo "== 3/8 d8 -> dex =="
d8 --release --lib "$AJ" --min-api 24 --output "$P/out/dex" \
  $(find "$P/out/classes" -name '*.class') \
  || { echo "!! d8 失败"; exit 1; }
if ! grep -aq "MainActivity" "$P/out/dex/classes.dex"; then
  echo "!! classes.dex 缺少 MainActivity，中止构建"; exit 1
fi
echo "  classes.dex 含 MainActivity，$(stat -c%s "$P/out/dex/classes.dex") bytes"

echo "== 4/8 aapt 打包 + assets =="
aapt package -f -M "$P/AndroidManifest.xml" -S "$P/res" -I "$AJ" -F "$P/out/unsigned.apk"
( cd "$P/out/dex" && aapt add "$P/out/unsigned.apk" classes.dex )

# 追加 assets（支持中文文件名，Node zip 打包器）
NODE_BIN="/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node"
export LD_LIBRARY_PATH="/data/user/0/com.deepseek.harness/files/payload/runtime/lib:$LD_LIBRARY_PATH"
[ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node || echo node)
"$NODE_BIN" "$P/pack-assets.js" "$P/out/unsigned.apk" "$P/assets"

echo "== 5/8 zipalign =="
zipalign -f 4 "$P/out/unsigned.apk" "$P/out/aligned.apk"

echo "== 6/8 安全检查：assets 中不得出现 API Key =="
if grep -rqE "sk-[A-Za-z0-9]{20,}" "$P/assets" 2>/dev/null; then
  echo "!! 检测到疑似 API Key 混入 assets，中止"; exit 1
fi

OUT="$P/Pusuan.apk"
if [ "$MODE" = "release" ]; then
  echo "== 7/8 签名 (release) =="
  [ -f "$KEY" ] || { echo "!! 缺少签名密钥 $KEY"; exit 1; }
  apksigner sign --ks "$KEY" --ks-pass "pass:${KEYSTORE_PASS}" --ks-key-alias "pusuan" --key-pass "pass:${KEYSTORE_PASS}" \
    --out "$OUT" "$P/out/aligned.apk"
else
  echo "== 7/8 签名 (debug，自签) =="
  # debug 模式：用 helloapp 现成密钥或生成临时密钥
  if [ ! -f "$KEY" ]; then
    "$JAVA_BIN/keytool" -genkeypair -v -keystore "$KEY" -alias pusuan -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" -dname "CN=Pusuan, OU=Mobile, O=Pusuan, L=CN, ST=CN, C=CN" 2>/dev/null
  fi
  apksigner sign --ks "$KEY" --ks-pass "pass:${KEYSTORE_PASS}" --ks-key-alias "pusuan" --key-pass "pass:${KEYSTORE_PASS}" \
    --out "$OUT" "$P/out/aligned.apk"
fi

echo "== 8/8 校验 =="
apksigner verify --print-certs "$OUT" 2>&1 | head -3
aapt dump badging "$OUT" | head -6
ls -la "$OUT"
echo "BUILD OK -> $OUT"
