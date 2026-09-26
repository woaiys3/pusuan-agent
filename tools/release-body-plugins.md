# 普算插件合集 v1.0.1

给 **DSH 0.1.7** 的普算功能插件。**不必升内核。**

普算 = DSH 0.3.0 内核 + 配置层 + 界面。本发行版把其中的**功能面**搬到 0.1.7：
技能、人格、知识库检索、四个起卦器、正确率量化。**不含界面**（按需求不需要）。

---

## 下载哪个

| 文件 | 作用 | 大小 |
|---|---|---|
| `pusuan-skills.zip` | 8 个技能（六壬／六爻／塔罗／小六壬 ×v1/flash） | 74 KB |
| `pusuan-persona.zip` | 2 个**新增**人格预设（普算·标准／提问模式），不动原版 | 33 KB |
| `pusuan-knowledge.zip` | 570 篇语料 + `knowledge_search` 检索工具 | 11.3 MB |
| `pusuan-divination.zip` | 四个起卦器 + 正确率量化 | 2.3 MB |
| `dsh-plugin-mobile-adapt.zip` | 移动端适配（窄屏样式 + viewport） | 33 KB |

**最少装这两个**：`pusuan-knowledge`（能查资料）+ `pusuan-divination`（能起卦）。
技能与人格建议一起装，否则 agent 不知道该按什么流程占。

---

## 装法

**插件管理器（推荐）**：侧边栏 → 插件 → ＋添加插件 → 填插件目录路径 → 安装 → **重启引擎**

**手工**：解压后放进 `<dshHome>/profiles/web/node_modules/`，
再把包名加进 `<dshHome>/profiles/web/package.json` 的 `dsh.profile.bundles`，重启引擎。

`pusuan-skills` 是纯 Markdown，直接拷进 `<dshHome>/skills/`（发现深度一层）。
`pusuan-persona` 装完界面里多出「普算·标准」与「提问模式」两个预设；
**内核原有的预设一个不动**（默认仍是原版 `standard`），想用普算切过去就行。

---

## 这一版修了什么

### `pusuan-persona` 1.0.1 —— 改成**只新增、不覆盖**

早先的人格包是直接**改写**内核的 `standard` 预设。那会把默认模式占掉，
用户就回不去原版了。现在改成**新增两个预设**：

| 预设 | 说明 |
|---|---|
| `pusuan-standard`（普算·标准） | 新增：普算本体系统提示词 |
| `pusuan-question`（提问模式） | 新增：提问式占卜人格 |

内核自带的 `standard`（默认）/ `ptc` / `minimal` / `cordis` **逐字未动**，
想用普算就在界面里切过去，不想用就切回来。

实测（真 0.1.7 内核）：`standard` 的 prefix 仍是原版 `You are a coding agent…`，
默认预设仍是 `standard`，启动 0 告警。

### `pusuan-knowledge` 1.0.1 —— `knowledge_search` 永远不注册

**症状**：插件装上了、引擎启动**零警告**，但模型调 `knowledge_search` 永远回 `unknown tool`。

**根因**：`dsh-knowledge` 只导出 `default`（`KnowledgeRegistry` 类），**没有 `apply`**。
宿主半把 `import()` 得到的 ESM 模块命名空间直接交给了 `ctx.plugin()`，cordis 拒绝：

```
Error: invalid plugin, expect function or object with an "apply" method, received object
```

这条异常被 `mount()` 自己的 catch 吞成一条 `warn`（安卓宿主看不到），
于是 `knowledge` 服务从未注册、另两个包永久 pending —— 没工具、没语料，而日志一片干净。

**修法**：挂载前先取出真正的插件体（函数原样、有 `apply` 的返自身、否则回退 `default`）。

### `pusuan-divination` 1.0.1 —— 六壬排盘不传时间就必崩

**症状**：`liuren_paipan` 只要不显式传 `dt` 就崩：

```
Error: Cannot read properties of undefined (reading 'y')
```

**根因**（上游原始缺陷，非移植引入）：`resolveIntent` 里 `真太阳时`／`活时报数`／`四柱`／
`lunar` 四个分支都经 `buildParams`，而**「正时」的兜底分支直接 `return { ...base, ...p }`**
绕过了它 —— 而「dt 缺省 → 取当前时间」的兜底恰恰写在 `buildParams` 里。

**后果**：最常用的「正时」不给时间 **100% 失败**，这工具等于只能手动喂时间用。

**修法**：兜底分支改走 `buildParams`；并在入口加显式校验，缺 `dt` 时给出看得懂的错误。

---

## 实测记录

验证环境：**真 0.1.7 内核**（`@deepseek-ai/dsh@0.1.7-rc.2`，node 24），
用 **pnpm 10 真实安装**（复现设备上 `link:` 的插槽布局），真内核启动。

方法上有一条值得说：**不看日志，直接断言服务与工具是否真的注册**。
因为「装上了但工具不存在」的经典症状恰恰是**启动零警告** —— 只看日志区分不出好坏。

| 检查 | 结果 |
|---|---|
| `knowledge_search` 注册 + 语料 | ✅ 1 库 / **566 片** |
| 五个占卜工具注册 | ✅ `liuren_paipan` `liuyao_qigua` `tarot_choupai` `xiaoliuren_qike` `divination_quantify` |
| 六壬真排盘 | ✅ 盘面 **50 个顶层字段**（39.3 KB 落盘） |
| 六爻真起卦 | ✅ 本卦**泰** → 变卦**谦**，纳甲／六亲／六神／旬空／旺衰齐全 |
| 小六壬真起课 | ✅ 农历 2026-8-16 戌时 → 三宫**留连／小吉／速喜** |
| 塔罗真抽牌 | ✅ 含正逆位与**韦特牌文原文** |
| 六壬 dt 回归 | ✅ **8/8**（修复前 4/8） |
| 两插件同装联测 | ✅ 6 个工具全可用、0 告警 |

**未验证**（如实说）：`divination_quantify` 只验到注册 —— 它内部要跑四次模型阶段，
本机无 API Key。检索与解断的**质量**也取决于模型，不在自动化验证范围内。

---

## 已知限制

- `dsh-divination-methods`（管「哪个技能版本是默认」）在 0.1.7 上**挂不了**：
  它依赖插件级 `settings` 服务与 `skills/catalog-entries` 钩子，**这两样 0.1.7 都没有**。
  不影响任何起卦功能，只少掉技能目录里的默认版本标记。
- 首次启动有约 10 秒**索引空窗**（572 篇读完才注册语料）；这期间查询返回 0 条而不是报错。
- `pusuan-knowledge` 的投影是「目标存在就跳过」：**下次改它时需手动清
  `<dshHome>/profiles/node_modules/@deepseek-ai/dsh-knowledge*`**，否则改了不生效。
  （`pusuan-divination` 1.0.1 起已带版本戳，自动重投。）

---

## 校验值

| 文件 | MD5 |
|---|---|
| `pusuan-skills.zip` | `ef86ff861210d267dc61f6d842ae4b7e` |
| `pusuan-persona.zip` | `8cb5dd174339734cecee1b2f88f90cce` |
| `pusuan-knowledge.zip` | `1543615a373465ce593fa924fbeb0f97` |
| `pusuan-divination.zip` | `c6dedabdcc38a8e416b3bcc07ffb6e91` |
| `dsh-plugin-mobile-adapt.zip` | `4ec30a79fce126e3cb05a2f61b05634e` |

---

## 许可与致谢

- 智能体内核 `@deepseek-ai/dsh` 为 MIT，版权归 DeepSeek。
- 术数语料、嵌入模型、六壬引擎（`lrpp.js`）等版权归**普算原作者 sunxiaochuan48**。
- 本合集只做**搬运 + 0.1.7 适配 + manifest 规范化**，未改动引擎逻辑。
- 起卦结果为 AI 辅助参考，请理性看待。
