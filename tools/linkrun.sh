#!/system/bin/sh
# 在设备上运行：验证硬链接与 rename 能力（由 test-hardlink.sh 推入并执行）
P=/data/user/0/com.pusuan/files
NODE=$P/payload/runtime/x86_64/bin/node
export LD_LIBRARY_PATH=$P/payload/runtime/x86_64/lib
echo "--- node 版本 ---"
$NODE --version
echo "--- 硬链接/rename 测试 ---"
$NODE $P/linktest.js
