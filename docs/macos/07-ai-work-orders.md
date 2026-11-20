# 分工给其他 AI 的任务单（一次性 V1 全量开发）

## 总原则

每张任务卡都要输出真实代码/测试，并标注是否在 macOS/Windows/Android 实机运行；不要只输出讨论和效果图。你可以按依赖顺序逐个给 AI，最终由一个集成 AI 对 `docs/06-v1-acceptance.md` 逐项签收。**下文是开发顺序，不代表分期发布。**

## T01：Windows 代码迁入公共 Web 工程

输入：用户 Windows 定制版源代码 + 本项目。
输出：`apps/web` 完整源码、Windows 定制功能对照表、`pnpm type && pnpm build` 日志。
完成标准：保留全部原 UI/配置/历史/语音/附件功能；不以官方原版覆盖用户改动；构建产物可由 install-web-dist.sh 装入 Mac。

## T02：Mac Debug 实机编译和 WebKit 基线

输出：修正 XcodeGen/Swift API 编译问题，完成 app/Bundle/Web 数据持久化、CORS、麦克风、下载、字体等 P0 试验报告。必须记录 Xcode/macOS 版本。
完成标准：真实 Mac 上通过基础可用性；如 file:// 有缺陷，提出受控资源来源和原数据迁移方案，不得以重置数据解决。

## T03：统一 DesktopPlatformAdapter + Bridge

输出：Web Browser/Windows/macOS adapters；强类型命令白名单；异步请求 ID/错误码/事件订阅；原生侧入站严格校验；端到端测试。
完成标准：Web 无分散的 `window.webkit`/Windows 原生 API 调用；恶意 iframe/外链不能调用 Native Bridge。

## T04：本地凭据与原生 API 网络层

输出：启动时清理旧网页凭据缓存、本地凭据与窗口状态广播、原生 URLSession `models/messages/files/asr/tts`、SSE 流转发、取消/重试/状态码分类、脱敏日志。
完成标准：全量 C01–C03、E05 通过，明文密钥不在 Web 持久层/导出/日志；所有 API 真正经过 NativeNetworking。

## T05：完整聊天业务联调

输出：从 Windows 定制版共享 UI 迁入 Mac，所有聊天/分支/搜索/链接阅读/Markdown/高亮/附件用例和截图。
完成标准：C04–C08 与 Windows 逐项一致，流式/断流/长上下文正确。

## T06：SQLite + Blob 持久化 + 多窗口一致性

输出：持久化服务、DDL/migrations、事务、崩溃回滚、文件引用计数、StorageAdapter、数据订阅、多窗口冲突处理。
完成标准：E01/E04/E08、B07 通过；提供原 IndexedDB 数据迁移以及原 DB 的回滚备份。

## T07：备份 v4 与完整导入导出

输出：v3 兼容、v4 全量备份/恢复、hash/大小/路径/zip bomb 检查、隔离暂存、提交原子性、UI 导入向导。
完成标准：E02/E03/E07 通过，包括图片和**非图片附件原件**、当前分支和草稿。

## T08：macOS 原生 UX 与系统菜单

输出：原生红黄绿窗口、窗口尺寸记忆、菜单/快捷键、主题联动、菜单栏图标/隐藏选项、登录项、关于/引导/更新 UI、弹窗遮罩/焦点处理。
完成标准：B01–B06 全通过；与 Win 端设计风格一致但遵循 Mac 行为。

## T09：文件与音频权限全链路

输出：macOS 麦克风请求与恢复、getUserMedia 或 AVAudioEngine 兼容层、ASR/TTS、文件 picker/download/拖放/粘贴。
完成标准：D01–D04、C06/E07 全通过；失败时关闭句柄并恢复 UI。

## T10：局域网安全配对与发现（三端）

输出：Mac NWBrowser/NWListener、Windows mDNS/TLS、Android NSD/TLS；设备身份、公钥 pinning、双向配对 UI、撤销与重新配对。
完成标准：未配对不可读，跨平台真正发现与认证；禁止自动信任同一 Wi-Fi 的设备。

## T11：增量数据/附件同步与冲突合并（三端）

输出：operation log、manifest、cursor、idempotent apply、tombstone、分块附件恢复、合并策略、UI 进度、断线重试；三端共用 schema 契约。
完成标准：F01–F07 全通过；包含冲突测试证据与安全审查。

## T12：Sparkle 更新和签名公证发布

输出：定制 SwiftUI 更新界面、Sparkle 2 feed 与 EdDSA 签名、公证 DMG、Universal 构建/CI、旧版升级测试；私钥只在安全 CI/签名机器。
完成标准：A02–A04、G01–G03 全通过；错误签名必须拒绝安装。

## T13：诊断、性能与发布门禁

输出：日志脱敏、诊断导出、性能回归、低磁盘/弱网、失败态处理；CI 与 QA 实测报告。
完成标准：G04–G06 通过；`06-v1-acceptance.md` 每项能追溯日志/测试，无未解释的发布阻断问题。

## 给其他 AI 的总控提示词（直接复制）

```text
你现在接手 DeepSeekMac-V1-Starter 仓库。先完整读取 AGENTS.md、README.md、docs/01-technical-plan.md、docs/02-feature-scope.md、docs/03-migration.md、docs/06-v1-acceptance.md、docs/07-ai-work-orders.md。
本项目目标为首版 V1 一次性交付全功能：从用户已经定制的 Windows chat-demo React 前端迁入，Mac 原生 SwiftUI+AppKit+WKWebView 宿主，全量聊天/语音/附件/备份、原生系统功能、本地凭据 + Native Networking + SQLite、Sparkle、安全局域网跨 Windows/Android 增量同步。
当前压缩包仅为工程骨架，并未完成 V1。严禁把占位页当作聊天客户端，也不得以官方 upstream 覆盖用户 Windows 定制源码。任何无法实测的功能都标记待验证，不要臆称已通过。
请先评估并列出当前项目实际可用/未接通项，选择 T01 起按依赖执行。每轮直接产出可合并的代码，保持单一 Web UI、跨端 Adapter、原子迁移、密钥不回传 JS、安全白名单，并提交每项任务的文件变更、测试命令/结果、未解决问题与下一项依赖。除非需要真实凭据/证书/私有源代码，否则不要停留在口头方案。
```

## 给执行某个任务的 AI 的提示模板

```text
请基于仓库文档完整实现 docs/07-ai-work-orders.md 的 TXX，不要只讨论方案。
开始前读取当前源文件和相关协议；先写失败测试，再修改代码；完成后运行可执行的构建/测试并附日志。
绝不更换用户定制前端、绝不清空原会话数据、绝不记录 Key、绝不把“尚未验收”写成“完成”。
输出：修改文件清单、核心实现说明、测试证据、文档/契约更新、依赖或风险。
```
