# Native Bridge v1 接口协议与事件约定

JS 注入 `window.__DEEPSEEK_DESKTOP__={platform:'macos',bridgeVersion:1}` 和 `window.deepseekNativeCall(method,params)`。具体类型见 `contracts/bridge-v1.d.ts`。

## 已有基础实现（骨架可用于初步 Bridge 演示）

| 命令 | 参数 | 响应 | 注意 |
|---|---|---|---|
| `app.getInfo` | `{}` | `{platform,version,build,bridgeVersion}` | 返回版本 |
| `system.getTheme` | `{}` | `{theme:'light'|'dark'}` | 尚未添加主动变化推送 |
| `security.key.exists` | `{}` | `{exists:boolean}` | 不返回密钥 |
| `security.key.save` | `{key:string}` | `{saved:true}` | Key 写入 Keychain |
| `security.key.delete` | `{}` | `{deleted:true}` | 从 Keychain 删除 |
| `app.openExternal` | `{url}` | `{opened:true}` | 仅 http/https |
| `updater.check` | `{}` | `{requested:true}` | 未配置 Sparkle feed 时显示明确提示 |

**注意**：`security.key.save` 已实现但原 chat-demo 前端尚未调用。把密钥写入 Keychain 本身不代表已杜绝其原本的 `localStorage` 路径。

## V1 必须补全的接口

| 命令 | 请求 | 返回 | 约束 |
|---|---|---|---|
| `network.request` | `{requestId,operation,payload}` | `{requestId,status,data}` | operation 只允许 models/files/asr/tts 等固定接口 |
| `network.stream.start` | `{requestId,body}` | `{streamId}` | Native 自取 Keychain，逐帧推事件 |
| `network.stream.cancel` | `{streamId}` | `{cancelled:true}` | 必须取消 URLSession 网络任务 |
| `file.pick` | `{types,multiple}` | `{files:[...]}` | 用户选文件，不允许任意路径 |
| `file.save` | `{suggestedName,blobHandle}` | `{saved:true}` | 不跨 Bridge 传大二进制 Base64 |
| `file.openDirectory` | `{}` | `{opened:true}` | 应限为用户指定/应用数据目录 |
| `sync.discover` | `{}` | `{devices:[...]}` | 发现不等于已授权 |
| `sync.pair` | `{deviceId,challenge}` | `{pairingId,status}` | 必须双向确认 |
| `sync.status` | `{}` | `{connectedPeers,lastSynced,error?}` | 不泄露设备密钥 |
| `sync.start` / `sync.stop` | `{deviceId?}` | `{state}` | 不删数据 |
| `app.loginItem.get`/`set` | `{enabled?}` | `{enabled}` | SMAppService 状态 |
| `window.new` | `{sessionId?}` | `{windowId}` | 真多窗口并发一致性 |
| `window.setTitle` | `{title}` | `{updated:true}` | 限制长度并过滤控制字符 |

## 原生主动推送事件（必须定义并加测试）

`nativeStreamEvent`：`{streamId,seq,type:'sse'|'complete'|'error'|'cancelled',payload}`

`nativeThemeChanged`：`{theme:'dark'|'light'}`

`nativeSyncEvent`：`{deviceId,phase,progress,reason?}`

`nativeStorageChanged`：`{revision,entityType,entityId}`

`nativeUpdaterEvent`：`{phase,version?,progress?,error?}`

统一事件传递建议：通过 `WKWebView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('nativeStreamEvent', {detail: payload}))", arguments:["payload":safeJSON])`，不要拼接字符串，不要向不可信 frame 广播包含私有内容的消息。

## 变更策略

方法名/字段不兼容变更时 `bridgeVersion` 增加主版本，Web 构建前校验宿主能力。Web 必须在缺少必要 Native 能力时明确提示“版本不兼容”，不能假装已成功。
