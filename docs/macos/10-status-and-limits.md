# 当前仓库的真实交付状态（2026-11-20 更新）

> 本文件是诚实的状态账本。每项注明证据来源；「已验证」= 在本机（macOS 27.3 / Xcode 27 / arm64）真实运行或构建通过；「待验收」= 代码存在但未在真实条件（真实 API Key / 双机 / 签名环境）下测试。

## T01 Windows 前端迁入 — 已完成 ✅

- `apps/web` = chat-demo @ `5d5dd754`（Windows DeepDesk 0.1.2 CI 同一 commit）+ 用户 `patch-chat-demo.mjs` 全部定制 + 新增 `patch-macos.mjs`。
- 证据：`pnpm install --frozen-lockfile && pnpm type && pnpm build` 通过；构建产物装入 `macos/Resources/Web`。Windows 定制（合并导入文案、用量 UI、专业模式、DPAPI 桥）在 Mac App 中逐项可见（截图验证）。

## T02 Mac Debug 实机编译 — 已完成 ✅

- xcodegen 2.47 生成工程；`xcodebuild ... CODE_SIGNING_ALLOWED=NO build` **BUILD SUCCEEDED（0 warning）**，arm64。
- P0 试验结果（本机 file:// + WKWebsiteDataStore.default()）：
  - localStorage/IndexedDB 持久化、异步 chunk/字体/样式正常（App 启动并完整渲染 UI，截图验证）；
  - `crypto.subtle` 在 WKWebView file:// 下为 secure context（浏览器侧同源验证 OK；App 内未单独复测，标注待验收）；
  - 麦克风 TCC 提示已接线（prompt 决策），未用真实录音验证（待验收）。

## T03 统一 Adapter + Bridge v1 — 已完成（macOS 侧）✅

- Web 侧：`desktop.ts` 平台适配层，组件无平台分支；`nativeTransport.ts` 只在 macos 宿主生效。
- 原生侧：`NativeBridge` 白名单分发（主 frame + Bundle Web/ 路径校验、参数强校验、结构化错误 `{code,message,status}`）。
- Bridge 方法：app.getInfo/openExternal/loginItem.get/set、system.getTheme/themeChanged、security.key.*、network.request/stream.*/upload.*、import.pickArchive/reportResult、updater.check、window.new/setTitle、sync.discover。
- 事件：`nativeStreamEvent`（seq 有序）、`nativeThemeChanged`，经 `callAsyncJavaScript` 推送（无字符串拼接）。
- `contracts/bridge-v1.d.ts` 已同步实现状态；`file.pick/save/openDirectory`、`sync.pair/status/start/stop` 未实现（前端不得假装成功）。

## T04 Keychain + 原生网络层 — 已完成 ✅（真实 API 验证为负路径）

- `ApiNetworkService`：URLSession 全量代理 models/balance/files.delete/tts/messages(SSE)/files.upload/asr；Keychain 读 Key；错误分类（401/402/413/429/5xx/断网/超时→`{status,message}` 与上游 classifyApiError 对齐）；流式 chunk 30ms 合帧；取消真正取消 URLSession task。
- 旧 localStorage 明文 Key 一次性迁移：文档启动脚本 `security.key.save` → 哨兵替换（与 Windows 相同流程）。
- 证据（`--bridge-selftest`，真实 HTTPS 到 api.deepseek.com）：Keychain 写查删 ✅；无 Key→401 ✅；假 Key→服务端 401 且错误消息解析正确、不泄露密钥 ✅；非法 operation 白名单拒绝 ✅；SSE 流假 Key→error 事件 status=401 ✅。
- **待验收**：有效 Key 的正向流式对话/上传/ASR/TTS（C01/C02 正向）需真实 Key。

## T05 聊天业务联调 — 部分完成 ⚠️

- 已验证：App 启动、上游 UI 全量渲染、设置弹窗、会话列表、导入导出 UI（截图 + 浏览器端到端）。
- 待验收（需真实 Key）：流式对话、深度思考、联网搜索/链接阅读、附件上传/预览、语音 ASR/TTS、余额显示。这些路径的传输层已由 selftest 覆盖错误语义，正向功能待真实 Key 测试。

## T06 SQLite 持久化 — 代码完成 ✅（待真机签收 ⚠️）

- `StorageService.swift`（约 1400 行）：系统 libsqlite3，WAL + synchronous=NORMAL，全部写入单事务（BEGIN IMMEDIATE / 失败 ROLLBACK）；会话/消息树/文件引用三表；附件为内容寻址 blob 文件（Attachments/<sha256>）+ attachments 行引用计数，删除会话自动 GC；tombstone 表拦截已删会话旧状态写回（B07/E08）；存储故障分类（full/readonly/busy/corrupt → 结构化 `{code,message,sqliteCode}`）。
- Bridge：`storage.*` 全量 30+ 命令（含 blob 分块、staging 导入、迁移）白名单分发；`onChange` → 全部 webview 广播 `nativeStorageChanged`（contracts/bridge-v1.d.ts 已同步）。
- Web：`ChatStorageBackend` 统一接口 + `db.ts` 按 `storage.getMode` 分流（IndexedDB / 原生）；`store.ts` 多窗口订阅（删除清理、未保存会话不失效、生成中不打断、模式切换整页刷新）。
- 迁移（E04）：`migrateStorage.ts` 逐条会话 JSON + SHA-256 校验、附件 3MB 分块，原生条数核对通过才切换 `storage_mode=sqlite` 并广播；失败 abort 清理半成品，旧 IndexedDB 完整保留作回滚备份。原生设置面板有「迁移到 SQLite」入口。
- 证据（本日）：`swiftc -typecheck` 全量 0 错误 0 警告；存储自检 harness（临时 DB，真实 SQLite）10 项 PASS × 3 次：blob 往返+SHA256、消息树逐字段一致、列表/重命名/引用计数 GC、tombstone 拦截、合并导入恢复、迁移 hash/条数校验+模式切换、staging 替换/合并、getMode/stats。
- 修复的缺陷：sessions 查询引用不存在的 `deleted_at` 列（改查 tombstones）；saveSession 不读 blob-hint 导致附件登记失败；messages_staging 缺列（DDL 补齐 + ALTER 兼容旧库）。
- E08 打磨（2026-11-20）：存储写入失败新增底部横幅提示（storageBanner.ts，中英文案，「重新加载」/「知道了」），不再只打 console 静默。
- **待真机签收**：E01 崩溃/重启恢复、B07 双窗口并行实测、E04 真实数据全量迁移、E08 磁盘满/只读实测；本机 xcodebuild 受 sandbox-exec 限制无法构建 App，需在正常 Mac 环境跑一次完整 `--bridge-selftest`。

## T07 v4 完整备份 — 已完成（Web 侧）✅

- `archiveV4.ts`：archiveVersion 4；原始消息树 + 全部附件原件（含非图片，SHA-256 组织）+ 本地偏好（无 Key）+ manifest 逐条校验；路径白名单防 zip-slip；512MB/条、4GB/包上限；导入走既有 staging 管线（失败不清数据）。
- 端到端证据（真实浏览器）：导出 ZIP 的 manifest/SHA-256/消息树/图片+txt 原件内容逐项比对通过；清空本地→导入恢复完整；再次导入「新增 0、跳过 1」合并去重正确。

## T08 原生 UX — 大部分完成 ✅

- 红黄绿原生窗口（主窗口 2026-11-20 起改为 `.hiddenTitleBar` 隐藏标题栏，红绿灯浮于侧栏上，侧栏头部 236×40 拖拽区 `WindowDragStrip`，弹窗遮罩不再与标题栏割裂）、原生菜单栏（文件/编辑/显示/窗口/帮助）、Cmd+N 新聊天 / Cmd+Shift+N 新窗口 / Cmd+0 主窗口 / Cmd+R 刷新 / Cmd+, 设置 / Cmd+W / Cmd+Q、MenuBarExtra、关于窗口、主题联动（网页偏好主控，`system.themeChanged` 带 preference 防跟随系统死循环）、登录项 SMAppService、文档标题同步窗口标题、聊天内图片预览和原生 PDFKit 预览、下载保存面板、文件选择面板。
- 侧栏 logo 修复（2026-11-20）：Sider 引用的 `/deepdesk-logo.png` 此前从未进构建产物（rspack 无 publicDir 约定），已建 `apps/web/public/` 并在 rspack.config.ts 加 CopyRspackPlugin 拷贝 public/ → dist 根目录。
- 首启引导（2026-11-20 移除）：原生两步向导（Key 校验→Keychain、ZIP 导入窗口）已整体删除——API Key 与历史导入在网页设置弹窗中本就齐备，且 web 侧无 Key 时设置弹窗自动弹出"数据管理"页（官方 demo 默认行为）；原生向导只写 Keychain 不写 web localStorage，反而会造成二次弹窗。历史 ZIP 导入的原生文件选择通道（`history.import` → ImportService）保留，仍服务网页设置里的导入按钮。
- 窗口尺寸记忆（2026-11-20 补）：`WindowFrameAutosave`（NSWindow.setFrameAutosaveName）主窗口 + 设置窗口持久化 frame，重启恢复。
- 待验收：快捷键与输入法冲突实测、窗口尺寸记忆真机实测、深浅色实时切换实测。

## T09 音频/文件权限链路 — 部分完成 ⚠️

- 麦克风权限委托（主 frame + prompt）、open panel、下载已接线。getUserMedia 录音→ASR 全链路待真实麦克风测试。

## T10/T11 局域网同步 — 未完成 ❌

- 仅保留 Bonjour 浏览骨架（`sync.discover` 返回发现数量）。配对/TLS/操作日志/冲突合并/三端互通未实现。Windows/Android 侧实现不在本仓库范围。

## T12 Sparkle 更新与签名公证 — 未完成 ❌（依赖外部材料）

- Sparkle 2.10.1 SPM 已接、UpdateService 骨架在（无 feed 时明确提示）；Developer ID 证书、EdDSA 私钥、真实 appcast、公证与 DMG 均需发布者材料，无法在本仓库完成。

## T13 诊断 — 部分 ⚠️

- `--bridge-selftest` 诊断命令 + JSON 结果输出已落地；日志脱敏原则已遵守（selftest 显式断言密钥不泄露）。完整的分级日志、诊断 ZIP 未实现。

## T13 诊断 — 代码完成 ✅（2026-11-20 补齐）

- `DiagnosticsService.swift`：分级滚动日志（DEBUG/INFO/WARN/ERROR，512KB×3 轮转，`App Support/<bundle>/Logs/`）；脱敏（`sk-` 令牌 [redacted]、截断 2000 字、压平换行）；接线 NativeBridge 失败分发（方法名+错误码，不含参数）与网络错误分类（operation+status）。
- 「导出诊断信息…」帮助菜单：收集 info.txt（版本/系统/架构）、storage.txt（模式+统计）、selftest.json（若有）、最近日志 → 纯 Swift store-only ZIP（MiniZip，含 CRC32）→ 保存面板导出并在 Finder 定位。不含密钥与聊天内容。
- 证据：独立 harness 7 项 PASS——脱敏/截断、MiniZip 产物经系统 `unzip` 完整性校验+逐条目字节比对、CRC32 已知向量（123456789 → CBF43926）。

## 主要剩余风险

1. **无真实 API Key 的正向用例全部未验收**（C01-C08 的正向、D02/D03、余额显示）。
2. T06 真机签收未做（E01/B07/E04/E08 端到端 + 完整 --bridge-selftest），见上。
3. ~~窗口尺寸记忆未显式实现~~ → 本日已实现 frame autosave（见 T08）。
4. 自动更新链路需要签名材料（A03/G01-G03 无法在无证书环境完成）。
5. 三端 LAN 同步（F01-F07）需 Windows/Android 配合，本仓库只能做 Mac 端。
6. ~~App 图标仍为占位~~ → 2026-11-20 已定稿：DeepSeek 官方同款留白比例（鲸鱼占方块 85%，fitRatio 0.85）合成浅色（白底）/ 深色（深空蓝黑 #0B0F1C）两张 1024 母图；Asset Catalog 单尺寸 + Luminosity 变体（`Config/AppIcon.xcassets`，macOS 15+ Dock 随系统外观自动切换）+ `AppIcon.icns`（浅色版，旧工具链兜底）双轨入包。合成脚本 `scripts/make-app-icon.swift` 可复跑。**注意**：深色切换需 Xcode 16+ 工具链构建后于 macOS 15+ 真机确认（本机 actool 会静默丢弃变体）。
