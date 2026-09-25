#!/usr/bin/env bash
# 在设备上验证：应用私有目录是否支持硬链接（内核会话持久化依赖它）
set -eu
export MSYS_NO_PATHCONV=1
A=/c/Android/platform-tools/adb.exe

echo "=== 1) 用 node 直接测 fs.link（最贴近内核的实际调用）==="
$A push "$(cygpath -w /d/pusuan/tools/linktest.js)" /data/local/tmp/linktest.js >/dev/null 2>&1
$A shell run-as com.pusuan cp /data/local/tmp/linktest.js files/linktest.js 2>&1 | head -2
NODE=/data/user/0/com.pusuan/files/payload/runtime/x86_64/bin/node
LIB=/data/user/0/com.pusuan/files/payload/runtime/x86_64/lib
$A shell run-as com.pusuan sh -c "LD_LIBRARY_PATH=$LIB $NODE files/linktest.js" 2>&1 | head -20

echo
echo "=== 2) 文件系统类型 ==="
$A shell df -T /data/user/0/com.pusuan/files 2>&1 | head -3
$A shell mount 2>/dev/null | grep -E " /data " | head -2

echo
echo "=== 3) 目录权限 ==="
$A shell run-as com.pusuan ls -ld files files/dshhome 2>&1 | head -3
