# 平台协议与安全模型

## 1. 信任边界

```
Untrusted internet (DeepSeek HTTPS / external websites)
        | URLSession + TLS (hostname validation)
Mac native host (Keychain + database + filesystem + sync)
        | trusted command-only, main-frame-only bridge
WKWebView bundled UI (trusted first party JS only)
        | sanitization
Untrusted model-generated Markdown, links, citations, attachments
```

- WebView 只允许加载 App Bundle 的 `Web/` 路径；`http/https` 链接在外部浏览器打开。`about:blank` / Blob 子框架不得拥有 Bridge 调用权限。
- 只有主 frame 且来源为 bundle UI 的消息可以调用 Bridge；参数按 JSON Schema 或强类型严格验证，包括长度、URL scheme、路径许可、大小限制。
- 不实现 `shell.exec`、`runCommand`、任意 `readFile(path)` 等通用高权限调用。对文件使用操作系统文件选择器/保存面板，获得用户明确批准。
- 模型输出 Markdown/HTML 必须经过现有可信渲染器清洗，禁止将引用页面内容拼进 `evaluateJavaScript` 代码字符串。原生事件向 Web 传参使用 `callAsyncJavaScript(arguments:)` 而非字符串拼接。
- 在非开发模式关闭 Web Inspector、调试加载任意远端 UI 的入口；关闭不必要的 WebKit 权限和新窗口请求。

## 2. Bridge 执行模型

JS 调用：`await window.deepseekNativeCall('app.getInfo')`。

Native reply 格式：

```json
{ "ok": true, "data": { "platform": "macos", "bridgeVersion": 1 } }
```

失败格式：

```json
{ "ok": false, "error": "invalid-request" }
```

Swift 服务只返回允许的字段，不回传 Keychain 密钥。耗时请求不可在 WKScriptMessageHandler 回调中同步阻塞主线程；Bridge 返回 requestId，后台处理并异步分发事件。

- `network.stream.start`: 接受 `requestId`, `messages`, `model`, `options`；返回 `{streamId}`。
- `network.stream.cancel`: 接受 `{streamId}`；取消 URLSession 任务；终态必须唯一。
- `nativeStreamEvent`: `{streamId, seq, type, payload}`，type 为 `sse|complete|error|cancelled`；有序、幂等、可检测缺包。
- `file.pick/save`: 采用文件选择器；不可接受任意绝对路径覆写。
- `sync.pair`: 用户在 Mac/另一设备都确认短码；不能无提示开始同步。

## 3. Keychain

1. 移入原 Web 前先检查旧 localStorage 是否存在 Key。
2. 首次运行一次性迁移，原生成功保存 -> 确认存在 -> 删除原明文 -> 重新加载配置，不保存明文到日志。
3. NativeNetworking 在本地读密钥；JS 没有 `security.key.get`。
4. Keychain 服务采用最终稳定 Bundle ID；签名 Team 变化、Bundle ID 变化会影响访问，升级流程必须涵盖密钥恢复体验。
5. 配对凭据单独使用 Keychain 账户记录，严禁复用 API Key 或同步成聊天附件。

## 4. 数据安全

- SQLite 可使用系统文件保护/应用私有目录；若要强加密，选择 SQLCipher 并做好安全密钥解锁与密钥轮换。macOS 上仅用 SQLite **不等于数据库加密**。
- 原件按 hash 文件名保存，引用路径限制在 Application Support 内；解压 ZIP 防 zip-slip、符号链接、过大文件、嵌套炸弹。
- 不允许混合 chat-demo v3 和本地 v4 归档时未经校验就覆盖所有记录。
- 不记录聊天正文、完整 API URL 查询、原始附件和 Key。诊断导出需要用户知情选择，默认仅匿名事件/版本/错误码。

## 5. 网络安全

- Native API 限制为 HTTPS；证书验证不能关闭。不要把 `api.deepseek.com` 的 token 发送给用户配置的任意域名。
- 网络中断/429/5xx 不把已完成的部分回答无条件重复扣费；续写、重试由原消息状态/用户确认驱动。
- 本地同步服务仅监听明确指定的接口与端口，并提供授权认证；Bonjour 只用于发现，不等于信任。必须设置最大单帧/文件大小、重放防护、速率限制、配对撤销。

## 6. Entitlements 说明

骨架暂以 Developer ID 非 Sandbox 模式开发，entitlements 中 `app-sandbox=false`。这不意味着用户无需授权访问麦克风或目录。若目标转 App Store 或要求 Sandbox，必须另行配置 network.client/network.server、文件安全作用域、Keychain group 等，重新验证更新和同步方案；不要简单切换一个布尔值就发版。

## 7. 安全验收清单

- 任意远端网站无法调用 nativeBridge；iframe 不可调用。
- `file://` 指向 Bundle 外或路径穿越无法获得 Bridge 权限。
- API Key 不出现在 localStorage、IndexedDB、导出 ZIP、stdout、崩溃日志或设备间同步中。
- 从不接受任意 `file://` / `javascript:` / `data:` 外链；复制或另存由用户主动操作。
- 导入恶意 ZIP、超大文件、重复 ID、错误 hash、损坏树不破坏现有记录。
- 未配对设备不能读取同步消息；撤销配对后旧密钥失效。
