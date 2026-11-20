# Web 源码（apps/web）

本目录是 DeepSeekMac 与 Windows DeepDesk **共用的聊天前端**。

## 来源与组成

- 基线：`deepseek-ai/chat-demo` @ `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（v0.1.1，与 Windows DeepDesk 0.1.2 CI 锁定的同一个 commit）
- `scripts/patch-chat-demo.mjs`（来自 Windows 仓库）：用户已有的全部 Windows 定制 —— 合并导入、DPAPI 凭据桥、用量/余额 UI、专业模式、主题上报、品牌
- `scripts/patch-macos.mjs`（本仓库新增）：macOS 宿主适配 —— API 传输改走 Native Bridge（Keychain 密钥不回传 JS）、跨平台 `desktop.ts` 适配层、首启导入结果上报、原生菜单新建聊天事件

Windows 定制补丁的语义完全保留；macOS 补丁只在 `window.__DEEPSEEK_DESKTOP__` 存在时生效，浏览器/Windows 行为不变。

## 从零构建（全新流水线）

```bash
# 1. 检出 pinned 上游（本目录 scripts/ 需保留）
git init apps/web-tmp && cd apps/web-tmp
git remote add origin https://github.com/deepseek-ai/chat-demo.git
git fetch --depth 1 origin 5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c
git checkout -q FETCH_HEAD
# 2. 覆盖到 apps/web（保留本目录 scripts/）
# 3. 应用补丁
node scripts/patch-chat-demo.mjs .   # Windows 定制（锚点必须命中 pinned commit）
node scripts/patch-macos.mjs .       # macOS 适配
# 4. 构建与安装
pnpm install --frozen-lockfile && pnpm type && pnpm build
../../scripts/install-web-dist.sh dist
```

当前目录已包含应用补丁后的源码；日常重构建只需 `pnpm type && pnpm build && ../../scripts/install-web-dist.sh dist`。

## 平台适配层（T03）

- `src/services/desktop.ts`：宿主探测（`isMacDesktop`/`isWindowsDesktop`）、主题上报、首启导入结果上报。组件层不做平台分支。
- `src/services/api/nativeTransport.ts`：macOS 专属传输 —— `network.request`（models/balance/files.delete/tts）、`network.upload.*`（files.upload/asr 分块上传）、`network.stream.start/cancel` + `nativeStreamEvent`（SSE 原始字节 base64，Web 端用上游 `ServerSentEventDecoder` 解析，事件语义与 fetch 完全一致）。
- `src/services/native.ts`：跨平台凭据/余额桥（Windows postMessage / macOS `deepseekNativeCall`）。
- API Key：macOS 下输入的 Key 只经 `security.key.save` 进 Keychain，页面存储只留 `DEEPDESK_NATIVE_CREDENTIAL` 哨兵；原生网络层自行读 Keychain。

## v4 完整备份（T07）

`src/services/chat/history/archiveV4.ts`：`archiveVersion: 4`，包含会话原始消息树、
全部附件原件（含非图片，按 SHA-256 组织）、本地偏好（不含 API Key）、manifest 逐条
SHA-256/大小校验；导入走既有暂存管线（merge/replace），失败不清空本地数据；路径
白名单 + 单条目 512MB / 总量 4GB 上限防 zip 炸弹。与 v3 历史导出共用导入入口。
