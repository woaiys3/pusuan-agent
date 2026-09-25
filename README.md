# 普算（Pusuan）· Android 版

「普算」是专注术数（六壬／六爻／塔罗／小六壬）的 AI 智能体应用。本目录是 **Android 原生移植版**。

## 移植基准

对齐原作**新线 `Pusuan-Dsh` 0.3.0**（原作 2026-09 起的主力版本），而非旧线 Python+WebView2 版。

技术配方与原作在 Windows 上一致，只是外壳与界面换成 Android 原生：

| 层 | 内容 | 来源 |
|---|---|---|
| 智能体内核 | `@deepseek-ai/dsh` 0.3.0（200+ 包，Cordis 插件树） | 从官方 Release 提取 |
| 运行时 | Node 26.4.0（Android/bionic，arm64 + x86_64 两套） | Termux 源独立装配 |
| 普算配置层 | 2 个预设 + 8 个技能 + 570 篇语料 | 同上 |
| 外壳与界面 | Kotlin + Jetpack Compose（本仓库新写） | — |

**内核与配置层逐字取自原版**，未做业务改动。Android 适配只做两件事：替换平台上不可用的原生模块、在 DSH home 层禁用不适用于 Android 的插件行。

## 构建

```bash
sh tools/build-apk.sh arm64-v8a    # 真机
sh tools/build-apk.sh x86_64       # 模拟器
```

产物在 `dist/`。需要 JDK 17+、Android SDK（build-tools / platform-34）。

构建链：
1. `tools/build-runtime.sh` —— 从 Termux 源取 node 与动态库，做 soname 实体化
2. `tools/prepare-payload.sh` —— 装配内核 + 配置，应用 Android 补丁，打成单个 zip
3. Gradle `assembleDebug` —— 编译 Compose 应用并打包

## 目录

```
android/              Kotlin/Compose 应用
  app/src/main/java/com/pusuan/
    engine/           EngineManager（解压 payload + 启动 node + 探活）、EngineService（前台保活）
    api/              DshClient（/api RPC + 两条 WS 事件流）
    ui/               对话界面（ChatViewModel + Compose）
  app/src/main/assets/
    dsh-home/         Android 适配补丁（启动时写入 $DSH_HOME）
vendor/
  runtime/<abi>/      node 运行时（构建产物，不入 git）
  payload/            内核 + 配置（构建产物，不入 git）
  patches/            Android 适配：原生模块桩 + 装配脚本
tools/                构建与验证脚本
```

## 关键的 Android 适配（都有原因，改动前请先读）

### 1. targetSdk 必须是 28

Android 9（API 28）起，targetSdk ≥ 29 会**给应用私有目录挂 noexec**，随 APK 分发的 `node` 可执行文件无法 exec，引擎起不来。这是平台限制，不是配置能绕过的。

### 2. 明文 HTTP 只放行回环

内核是本机 HTTP 服务（`127.0.0.1`）。targetSdk 28 默认禁止明文，必须用 `network_security_config.xml` 显式放行 —— 且**只放行 127.0.0.1/localhost**，不全局放开。

### 3. node 需要 `--expose-internals`

内核 Web 表层会在运行时动态挂载一个 cordis HMR 实例（条目 id 是哈希，无法用 YAML 禁用），它构造时需要 node 内部模块，否则报错中断启动。

### 4. 原生模块桩（`vendor/patches/native-stubs/`）

内核多个包在**模块顶层静态 import** 了三个原生模块，而它们在 Android(bionic) 上没有可用产物 —— 不处理则整棵插件树加载失败：

| 模块 | 原状 | 处置 |
|---|---|---|
| `sharp` | 需 libvips，无 Android 产物 | 桩：调用即报明确错误 |
| `koffi` | 仅 win32-x64 FFI 绑定 | 桩：类型注册可用，触达原生库拒绝 |
| `node-pty` | 无 bionic 预编译 | 桩：调用即报明确错误 |

哪些是安全的：这些模块的**实际调用点**都在 Windows 专属分支内（`load("kernel32.dll")` 等），Android 上不会执行；模块顶层只用类型注册。桩保留"被真正调用时立刻报错"的语义，不静默返回假数据。

### 5. home 层配置补丁（`android/app/src/main/assets/dsh-home/cordis.patch.yml`）

内核 boot 会断言"所有启用条目必须激活"，所以不适用的行必须显式禁用：

- `hmr` — 手机无热重载需求（另见第 3 条的运行时挂载）
- `sandbox` — Android 无 bwrap/landlock 执行链，且其依赖的 `dsh-sandbox-windows-acl` 在模块顶层做 koffi 结构体自检
- `bash-sandbox` — 依赖 `sandbox`
- `permission` — 该插件主动拒绝挂载在无沙箱的执行器上（预设本身绑定沙箱模式）
- 补挂 `bash-local` — 让 `ctx.shell` 仍有提供方

## 当前能力与限制

**可用**：AI 对话（流式、思考过程）、六壬/六爻/塔罗/小六壬四套技能、570 篇知识库检索、提问式占卜（question 预设）、多模型选择、会话管理。

**暂不可用**（明确记录，不假装支持）：

| 项 | 原因 |
|---|---|
| 图片附件 | `sharp` 在 Android 无可用实现，需自绘 JS 编解码器 |
| `bash` 工具 | 运行时未内置 Android 版 bash（Android 系统只有 mksh）；补 Termux bash 即可 |
| `grep`/`glob` 工具 | `@vscode/ripgrep` 只带 win32 二进制，需补 Termux rg |
| 权限预设 UI | 与无沙箱执行器不兼容，已禁用 |

**安全边界**：进程处于 Android 应用 UID 沙箱内，agent 只能访问应用私有目录与用户已授权的共享存储；工具调用把关由 `approval` 行负责。不再叠加应用层沙箱。

## 许可

移植版 Apache License 2.0。内核 `@deepseek-ai/dsh` 为 MIT。原版作者 sunxiaochuan48。
