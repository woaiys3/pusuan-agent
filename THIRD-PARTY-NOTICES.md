# 第三方组件声明（Third-Party Notices）

本软件（普算）随附以下第三方组件。各组件版权归其各自所有者所有，
按各自许可证条款使用与再分发。本文件随安装包一并分发。

## 1. 大六壬排盘引擎

- **位置**：liuren_paipan/JS/（六壬排盘独立工具模块，QuickJS 内嵌运行）
- **来源**：网络公开页面「六壬起个课（国际版）」的本地化排盘引擎（lrpp.js 等，本地离线运行，不依赖网络）
- **许可证**：来源页面未明确标注，版权归原作者所有

## 2. marked.js（Markdown 渲染）

- **位置**：frontend/marked.min.js
- **来源**：https://github.com/markedjs/marked
- **许可证**：MIT

## 3. Python 依赖包

随程序打包的 Python 依赖见 `requirements.txt`，各包按自身许可证分发：
pywebview（BSD-3-Clause）、httpx（BSD-3-Clause）等。
各包的许可证文本随包自带，安装目录内可查。

## 4. 六爻节气引擎

- **位置**：liuyao_qigua/JS/nongli.js（复制自 liuren_paipan 原版 nongli.js，QuickJS 内嵌运行）
- **来源**：同上「六壬起个课（国际版）」页面所附农历/节气脚本
- **许可证**：来源页面未明确标注，版权归原作者所有

## 5. Microsoft Edge WebView2 Runtime（Evergreen Bootstrapper）

- **位置**：webview2/MicrosoftEdgeWebview2Setup.exe（约 2MB，微软数字签名）
- **来源**：微软官方 Evergreen Bootstrapper（https://go.microsoft.com/fwlink/p/?LinkId=2124703）
- **用途**：当目标机器缺少 WebView2 Runtime 时，引导用户用微软官方安装程序
  自动下载并安装（程序仅在缺失时调用，不代替、不修改其安装行为）
- **许可证**：微软软件许可条款（随安装程序一并分发）

