# 从现有 Windows 客户端迁移到 Mac 的实操手册

## A. 首先确认输入

用户当前没有上传 Windows 源码/仓库，所以这里无法自动合并他们的私有修改。最关键的输入是 **Windows 版自定义 Web 源码** 和其当前构建/存储相关实现；单独 .exe 不够。官方 `chat-demo` 可以用于对照，但不能覆盖自定义版。

收集：
- `package.json` / lockfile / rspack config / `src/` / public assets / LICENSE；
- Windows 原生项目（若含 Native API、SQLite、Update、Tray 或自定义 JS Bridge）；
- 前端 IndexedDB schema、ZIP 导入导出实现、聊天附件逻辑；
- Windows 测试用数据 ZIP（去敏）、一份有效 DeepSeek API Key（只在开发者本地）；
- 品牌图标、签名证书与更新 feed 配置（证书/私钥禁止提交仓库）。

## B. 迁移文件流程

1. 建立 Windows 源代码稳定提交 `baseline/windows-v1`，冻结已实现功能清单、UI 截图与通过的验收用例。
2. 将 **网页源代码** 移至本仓库的 `apps/web/`（保留全部定制和锁文件）。不要直接复制 Windows 宿主或把旧 dist 当源码。
3. 运行 `cd apps/web && pnpm install --frozen-lockfile && pnpm type && pnpm build`，先确保 Web 独立构建成功。
4. 将 Windows 特有调用（`window.chrome.webview`, Electron ipcRenderer 等）找出，汇总为 `DesktopPlatformAdapter`；新增 Mac Adapter，保证组件层只消费统一接口。
5. 路由图/资源 `publicPath: auto` 与相对资源路径必须正常；用 `./scripts/install-web-dist.sh apps/web/dist` 更新 Mac 包内资源。
6. Mac 上 `./scripts/bootstrap-macos.sh` 生成工程；Debug 打开，验证真正加载的是定制 Web，而不是占位页。
7. 对照完整功能表，逐项替换 API 与存储适配：先确保聊天功能不回退，再统一到 原生本地凭据 + NativeNetworking + SQLite。
8. 用 v3 ZIP 进行基本聊天迁移，用 v4 新备份方式恢复**非图片原件**和完整本地状态；迁移成功前保留原归档可回滚。
9. 实现 Mac Native About/Update/Tray 类功能，但不要重用 Windows 右上角标题栏组件；Mac 使用原生红黄绿控件。
10. 执行所有发布门禁、打包、签名、公证、升级回归。

## C. Web 适配器必须改造的关键点

基于上游结构，应依次检查这些文件（Windows 定制版可能已经改名）：

| 上游路径 | 当前作用 | Mac 迁移要求 |
|---|---|---|
| `src/services/api/client.ts` | fetch、models、Messages、Files | 抽成 ApiTransport；Mac 使用 Native URLSession + 本地凭据 |
| `src/services/api/sse.ts` | SSE 解析 | 保持事件语义和取消行为；Native stream 事件必须正确翻译 |
| `src/services/api/speech.ts` | ASR/TTS | 走原生代理；测试 PCM/音频流 |
| `src/services/speech/recorder.ts` | getUserMedia / WAV | 优先原逻辑验证，不支持则 native AVAudioEngine |
| `src/services/chat/db.ts` | IndexedDB、暂存事务 | StorageAdapter；Mac SQLite + blob + 事务 |
| `src/services/chat/backup.ts` | 备份入口 | v3 兼容 + v4 事务备份，不丢非图片附件 |
| `src/services/chat/history/*` | ZIP 格式、验证、映射 | 保留 v3 导入；新增 v4 完整可恢复导入 |
| `src/app/theme.ts` | 前端主题 | 增加系统 NSAppearance 通知；保留用户覆盖设置 |
| `src/components/**` | 聊天/设置 UI | 平台无关，仅极少数入口根据桌面能力定制 |

## D. TypeScript 适配器建议

```ts
export interface DesktopPlatformAdapter {
  platform: 'browser'|'windows'|'macos';
  getInfo(): Promise<{version: string; platform: string}>;
  saveApiKey(key: string): Promise<void>;
  hasApiKey(): Promise<boolean>;
  streamChat(payload: unknown, onEvent: (evt: unknown)=>void, signal: AbortSignal): Promise<void>;
  uploadFile(file: File, signal: AbortSignal): Promise<{id:string}>;
  saveFile(name: string, data: Blob): Promise<void>;
  getTheme(): Promise<'light'|'dark'>;
  checkUpdate(): Promise<void>;
}
```

Mac Adapter 使用 `window.deepseekNativeCall(method, params)` + 事件订阅。Windows Adapter 对接现在已存在的原生层；Browser Adapter 保留原 `fetch`、IndexedDB。**不要把平台分支散落在 React 组件中**。

## E. 数据迁移策略（强制）

- `chat-demo` v3 ZIP 原有 `manifest.json`、`chat_sessions/*.json`、`chat_session_index.json`、图片原件。它不是完整备份，不包含 API Key、设置、非图片原件。
- 开发新 `archiveVersion:4`：包含全量会话、当前分支、所有附件原件、设置（不含 Key）、草稿、设备/同步元信息（只含公开部分），每个条目记录 SHA-256 和大小。
- 先完整校验归档路径/CRC/SHA/大小/引用树，再写入隔离暂存数据库，最后在单个迁移事务中切换到正式数据；失败保留旧会话。
- 新安装：显示一次性导入向导；不要出现“合并/覆盖”没有意义的重复选项。已有会话：由用户明确选择合并或覆盖；覆盖前提示保存备份。
- 原有 Windows 文件系统、WebView2、Mac WebKit 的 IndexedDB **不能直接互相复制**；通过格式化导出归档或同步协议交换。
- 跨 origin 升级：切换之前确保导出+验收，再导入新存储；不能直接换 Bundle ID/资源 scheme 后让用户以为旧对话还在。

## F. API 迁移的顺序

1. 只在 JS 中收集 API Key，然后用 `security.localCredential.v1.set` 交给原生本地凭据，清理旧 localStorage 凭据缓存。
2. Native API 实现 verify `/models`、stream `/anthropic/v1/messages`、Files 上传、ASR、TTS、取消、错误分类；严格限制 API URL。
3. Bridge `network.stream.start/cancel` 发送 streamId/requestId；Web 监听 `nativeStreamEvent`。处理 SSE 事件边界、多行 data、空行、ping、错误、完成与取消。
4. 网页端删除直接的跨域 API fetch；在禁网、401、429、超时、取消中测试。禁止 API Key 从 native 回传 Web。

## G. 结束条件

- 用户已有 Windows 定制功能无回退；同时 Mac 原生功能齐全。
- 经真实 Mac（arm64/Intel）编译/验收，聊天数据可跨重启和升级保留，Mac API Key 在保存后跨重启恢复。
- 安装包已签名、公证，Sparkle 更新旧版到新版可用。
- Win↔Mac↔Android 三端经配对、安全互通与数据一致性验证。
