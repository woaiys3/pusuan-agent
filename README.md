# 普算（Pusuan）· Android 版

「普算」是一款专注术数（六壬/六爻）领域的 AI 智能体应用，本仓库为 **Android 移动端移植版**。

> 原版为 Windows 桌面应用（Python + WebView2），本移植版采用 **纯 WebView + JavaScript** 方案重写：
> 前端原样复用（手机适配改造），后端（对话/工具/存储）全部 JS 化，排盘引擎（六壬 lrpp.js、六爻 JS 移植版）在 WebView 内直接运行，无需 Python 运行时。

## ✨ 功能

- 💬 **AI 对话**：流式输出、思考过程展示、多模型厂商（DeepSeek / 商汤 / TokenRhythm）
- 🌀 **大六壬排盘**：`liuren_paipan` 工具，支持正时 / 活时报数 / 四柱三种起课方式
- ☯️ **六爻起卦**：`liuyao_qigua` 工具，铜钱 / 蓍草 / 时间 / 手动四种方式，纳甲装卦全自动
- 📚 **知识库**：内置 477 篇国学/术数文档（五行、八卦、六十四卦、六壬课格等），AI 可检索引用
- 🧠 **技能系统**：六壬/六爻两套完整技能流程（skill_select 加载）
- 🛠️ **Agent 能力**：工具调用循环、子代理并行、任务清单、交互卡片、档案管理
- 🔐 **权限管理**：可授权读取手机存储（/sdcard），AI 能分析手机文件

## 📦 安装

1. 下载 APK（见下方 Release）
2. 安装时允许「未知来源应用」
3. 打开应用 → 设置 → 模型管理 → 填入 DeepSeek（或商汤）API Key → 同步模型
4. 开始对话，或直接说「帮我起个六壬课 / 用铜钱起一卦」

> 最低支持 Android 7.0（API 24）；建议 Android 10+ 体验最佳。

## 🔧 从源码构建（Android 手机/电脑均可）

需要：OpenJDK 17、Android SDK Build-Tools（aapt/d8/zipalign/apksigner）、Node.js ≥ 18

```bash
# 1. 准备构建环境（android.jar 等）
#    参考 build.sh 中的路径配置

# 2. 构建（debug 自签）
sh build.sh debug

# 3. 构建（release，需 release.jks 签名密钥）
# export KEYSTORE_PASS=你的密钥密码
sh build.sh release
```

产物：`Pusuan.apk`

## 🗂️ 项目结构

```
├── AndroidManifest.xml              # 应用清单（权限、Activity）
├── build.sh                         # APK 构建脚本（aapt/javac/d8/签名）
├── pack-assets.js                   # assets 打包器（支持中文文件名）
├── src/com/pusuan/MainActivity.java # WebView 壳 + 原生 JS 桥 + 存储权限
├── res/                             # 图标等资源
└── assets/app/                      # 前端 + JS 后端（打包进 APK）
    ├── index.html                   # 前端界面（原版改造：手机适配 + 桥接）
    ├── mobile.css                   # 手机端响应式样式
    ├── js/                          # JS 化后端
    │   ├── storage.js               # 数据层（JSON 文件存储，经原生桥落盘）
    │   ├── provider.js              # 模型厂商注册（DeepSeek 等）
    │   ├── chat.js                  # 对话引擎（流式 + 工具循环 + 子代理）
    │   ├── tools.js                 # 工具系统（排盘/知识库/技能/文件）
    │   ├── bridge.js                # pywebview.api 兼容桥接层
    │   └── engine/                  # 排盘引擎
    │       ├── liuren.js            # 六壬封装（驱动 lrpp.js）
    │       └── liuyao.js            # 六爻引擎（Python 版完整移植）
    ├── engine/liuren/               # 六壬原版引擎（lrpp.js 5MB + nongli.js）
    ├── skills/                      # 技能系统（六壬/六爻 SKILL.md + 步骤）
    ├── data/knowledge/              # 知识库（477 篇术数文档）
    └── system_prompt.md             # 系统提示词（AI 行为准则）
```

## 📜 许可

- 本移植版：Apache License 2.0
- 原版作者：sunxiaochuan48
- 移植：woaiys3（忆梦不自知）

## ⚠️ 说明

- AI 对话需要**自己的 API Key**（DeepSeek 等），请在设置中配置
- 排盘结果为 AI 辅助参考，请理性看待，勿用于迷信决策
- 本移植版为独立开发，与原版桌面应用无代码关联（除排盘引擎 JS 原版复用）
