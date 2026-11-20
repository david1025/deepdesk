# DeepSeek macOS 桌面客户端 V1 完整技术方案

状态：工程设计 + 启动骨架；目标发布版本 V1.0；2026-11-19。

## 1. 目标与约束

- 现有 Windows 客户端基于 `deepseek-ai/chat-demo` 进行深度定制。**不重写聊天界面**，以 Windows 版 React/TypeScript 前端作为共享代码源。
- Mac 必须是真正原生宿主：SwiftUI + AppKit + WKWebView，适配 macOS 13+、Apple Silicon 和 Intel；支持独立 DMG 分发。
- V1 首发必须覆盖现有聊天体验、语音/附件/导出、完整原生系统体验、安全密钥、可靠存储/恢复、菜单栏、启动项、多窗口、检查更新与自动更新，包含多端局域网同步能力。功能可有依赖开发顺序，但不拆入未来版本。
- 无中心化聊天数据后端；DeepSeek API 直接服务聊天/搜索/文件/语音。用户聊天记录与附件保存在本地；局域网同步走用户设备之间的加密通道。
- 质量目标：用户数据不可静默丢失；不能以停用系统安全能力换取功能；必须签名公证；网络 API 失败/中断应有可恢复状态。

## 2. 实测上游仓库事实

`chat-demo` 基于 React 18 / TS / Rspack，`pnpm build` 输出 `dist` 静态资源，不需要 Node 后端。上游 `src/services/api/client.ts` 通过 `fetch` 调用 `https://api.deepseek.com` 下的 Messages/Files，使用 SSE；`speech/recorder.ts` 通过 getUserMedia 录制，ASR/TTS 使用工具 API。`src/services/chat/db.ts` 使用 IndexedDB `chat-demo`，当前 DB_VERSION=11，store 为 sessions/sessionSummaries/files/sessionsStaging/filesStaging。会话 ZIP 导出协议当前 export_format_version=3，并非完整系统备份。上游源代码为 MIT。

这些都是**上游当前版本**事实；用户 Windows 定制版的实际目录与变更必须先对照检查。

## 3. 系统组件

```text
macOS App (SwiftUI / AppKit)
├── Window / Dock / MenuBarExtra / Commands / LoginItem
├── WKWebView (bundle web assets; persistent WebKit store)
│   └── shared React Chat UI + DesktopPlatformAdapter
├── NativeBridge: origin + main-frame + method/parameter whitelist
├── NativeNetworking: URLSession, SSE / Files / ASR / TTS, cancel
├── Local credentials: private per-user API Key file
├── LocalStorage: SQLite (session + operations) / attachment blobs + migration
├── Backup: full ZIP with manifest, optional user-supplied encryption
├── LAN Sync: Bonjour discovery / paired TLS / incremental exchange
└── Updater: Sparkle 2 / signed appcast / notarized DMG
```

**层次边界**：
- Web 负责 UI、消息树视图、格式化显示、编辑分支、页面状态和用户交互。
- Swift 负责安全、系统资源、持久化读写、下载、网络请求、更新、同步。
- TypeScript Adapter 封装原生和浏览器两套实现。绝不能让 UI 直接理解 Swift 内部数据库细节。
- Windows 可继续使用其现有本地原生实现或逐步对齐相同 TypeScript 接口；Android 用 Kotlin 原生实现相同数据/同步协议。

## 4. 关于 WKWebView 资源来源的重要决策

启动骨架使用 `loadFileURL()` 加载 `Web/index.html`，目的是最少改动启动 UI。**这只代表可启动架构，不等于 file:// 的全部能力已验证**。

在 Mac 实机执行 P0 比较试验：
1. `file://` + WKWebsiteDataStore.default()：确认 localStorage / IndexedDB / Blob 持久化和跨版本升级、异步 JS chunk / 字体 / KaTeX / Mermaid 正确；
2. `file://` 远端 API CORS，Fetch SSE / HTTP 预检；
3. WebKit 麦克风和文件导出；
4. 如上述任一阻断，推荐将 API 与存储转为 Native Adapter，不依赖 file:// 的跨域或音频能力。资源来源如需改造，先做原数据导出迁移后再切换 origin；不同 origin 的 WebKit 数据不会自然共享。

禁止将 `https://` 伪装为自定义 WKURLSchemeHandler 注册（WebKit 不允许覆盖其内置 HTTP/HTTPS 协议）。也不要用一个每次启动端口随机的本地 HTTP origin 存放 IndexedDB：端口改变会更换 origin。若使用 loopback 服务，需要固定可重复的存储域名/端口、端口占用/防其他进程访问处理，并对所有请求做鉴权。

## 5. 原生窗口与交互规范

- 标准红黄绿按钮，不复制 Windows 右上角最小化/关闭图标。
- 主界面保留 Web 的会话侧栏，原生顶栏不重复展示顶部导航；与系统深/浅主题一致，支持用户强制主题覆盖。
- cmd+, 设置；cmd+n 新会话；cmd+shift+n 新窗口；cmd+w 关闭窗口但不退出；cmd+q 退出；cmd+0 显示主窗口；cmd+r 可手动刷新前端（不影响数据）。快捷键冲突须整体梳理。
- 菜单栏图标（可关闭）提供打开、检查更新、关于、退出。关闭全部窗口后仍可从 Dock/菜单栏恢复；增加开机启动开关。
- 多窗口默认共享同一个受控存储引擎，Web 端采用订阅更新/版本检查避免窗口内数据互相覆盖。不同窗口允许选择不同会话，输入草稿按 session/window 作用域保存。
- 关于/更新/引导/错误信息统一品牌风格但使用真正的原生 SwiftUI 面板；原生系统授权弹窗除外。

## 6. 数据一致性策略

V1 **目标最终存储**：SQLite 是正式会话存储，原件为 Application Support 下按 content hash 组织的 blob 文件。Swift 原生用 GRDB（如采纳需添加 SPM、迁移与测试），或内建 SQLite3 实现。当前骨架没有实现 SQLite 引擎，不能误认为已交付。

- 表：sessions/messages/branches/attachments/session_attachments/drafts/settings/devices/operations/sync_cursors/tombstones。建表草案见 `docs/05-lan-sync.md`。
- 所有消息数据写入必须在事务内，附件先写临时文件、fsync/原子移动再引用；失败清理孤儿。
- 旧 Web 数据迁移需读取 IndexedDB，生成完整 v4 归档或 Native Adapter 批量搬运、验证 count/hash 后切换；强制留回滚备份。
- 旧 Windows 到 Mac 的跨设备迁移，使用经验证的导出归档；原 chat-demo v3 只保证导出原图片，不包含原非图片附件/API Key/完整设置，故**完整迁移优先开发 v4 导出**。
- 索引/消息树/当前分支/状态/附件下载内容必须可回放；不允许简单将消息树压平成聊天文本。

## 7. 网络与本地凭据

- API Key 由 Web 用户输入后交给 Mac 原生端，原子保存到 Application Support 中的私有凭据文件，重启恢复。前端只保留配置状态，启动时清理旧网页凭据缓存。
- Web 通过 `network.*` Bridge 请求原生 URLSession，Swift 从本地凭据服务取得 Key 发起 HTTPS 请求。仅允许配置的 DeepSeek 域名与完整 HTTPS 路径；禁自定义不可信 API 基址，若必须支持需做明确用户确认与 allowlist。
- 原生 SSE 维护 requestId、取消句柄、重试策略、状态码、上传进度、错误映射；消息增量通过 IPC 事件推给 Web，Web 原有解析器复用或在 adapter 中翻译。
- Messages / Files / Models / ASR / TTS 统一入该层。保证停止回答时真正取消底层 task，不能只关闭 UI。
- API Key 不进入 Web 导出、日志、异常报告、局域网传输、应用更新清单。对敏感系统错误做脱敏。

## 8. 同步：V1 发布要求

实现 Windows、Mac、Android 共同遵循 `contracts/sync-v1.schema.json`；发现用 Bonjour/mDNS，认证必须双向配对（短码/二维码 + 确认）。链路采用 TLS 及设备身份 pinning，首次配对后保存公钥指纹到系统安全存储。

Sync 以会话/消息/文件的稳定 ID、递增逻辑版本与幂等操作日志交换；先 manifest 再差异操作与按需 blob。删除使用 tombstone，不允许旧设备把删除的记录自动复活。并发修改需确定规则，例如消息节点为追加不可改、标题和会话显示属性采用带 deviceId tie-break 的 LWW；出现难以无损合并的情况转人工冲突副本。

注意：只有 Mac 实现发现/监听不构成“跨端同步已完成”；Windows 和 Android 必须都能安装兼容版本，经过跨端互操作测试。完整协议详见 `05-lan-sync.md`。

## 9. 打包、更新与发布

- Xcode 构建 Release universal arm64+x86_64，Developer ID Application 签名 + Hardened Runtime，`notarytool` 公证并 staple。
- DMG 人工可安装；Sparkle 2 获取 HTTPS appcast 更新，EdDSA 独立更新签名密钥，支持检查更新、更新说明、下载、安装和回滚前备份。
- 服务端不要把 `SUFeedURL` 配成无效 URL 然后向用户显示“已是最新”；发布前必须有真实私钥、feed 和签名更新包，并端到端测试旧版本升级。
- 在 Mac 真机分别验收 arm64 / x86_64（或受控 Intel CI）和弱网/代理。

## 10. 开发及发布门禁

开发任务见 `docs/07-ai-work-orders.md`，每一项完成后附构建日志和用例证据。只有通过 `docs/06-v1-acceptance.md` 中全部发布阻断项，才能称为 V1 发布候选。

## 11. 参考

- Upstream: https://github.com/deepseek-ai/chat-demo
- WKWebView: https://developer.apple.com/documentation/webkit/wkwebview
- Sparkle: https://sparkle-project.org/documentation/
- XcodeGen: https://yonaskolb.github.io/XcodeGen/Docs/ProjectSpec.html
