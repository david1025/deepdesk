# Native Bridge v1 接口协议与事件约定

JS 注入 `window.__DEEPSEEK_DESKTOP__={platform:'macos',bridgeVersion:1}` 和 `window.deepseekNativeCall(method,params)`。具体类型见 `contracts/bridge-v1.d.ts`。

## 已有基础实现（骨架可用于初步 Bridge 演示）

| 命令 | 参数 | 响应 | 注意 |
|---|---|---|---|
| `app.getInfo` | `{}` | `{platform,version,build,bridgeVersion}` | 返回版本 |
| `system.getTheme` | `{}` | `{theme:'light'|'dark'}` | 尚未添加主动变化推送 |
| `app.openExternal` | `{url}` | `{opened:true}` | 仅 http/https |
| `updater.check` | `{}` | `{requested:true}` | 未配置 Sparkle feed 时显示明确提示 |

## 本地 API 凭据 v1（macOS）

宿主在 `__DEEPSEEK_DESKTOP__` 中声明 `localCredentialVersion: 1`。原生窗口共用同一个本地凭据，网页只接收 `{configured: boolean, revision: number}`。

| 命令 | 参数 | 响应 |
|---|---|---|
| `security.localCredential.v1.status` | `{}` | 当前配置状态 |
| `security.localCredential.v1.set` | `{key: string}` | 新的配置状态 |
| `security.localCredential.v1.clear` | `{}` | 已清空的配置状态 |

`nativeLocalCredentialV1Changed` 以同一响应结构通知所有窗口。修订号在当前进程中单调增长。前端在渲染前查询配置，刷新或打开新窗口可继续使用当前凭据。原生端先原子保存私有文件，再返回成功和广播状态。重启会恢复已保存的凭据；保存失败返回 `CREDENTIAL_STORAGE_FAILED`。

升级时原生宿主和内置前端一起替换。旧 `security.key.*` 和仅内存测试版的 `security.sessionCredential.v1.*` 命令退役，启动时清除旧网页存储的 Key 或标记。已有钥匙串项目保留，应用不打开它。从旧版本升级时只需重新输入一次 Key。

## 附件预览 v1（macOS）

支持的宿主在 `__DEEPSEEK_DESKTOP__` 中额外声明 `attachmentPreviewVersion: 1`。
`attachment.previewPDF.v1` 接受 `{blobUrl, name}`，PDFKit 显示后返回 `{opened: true}`。
仅允许可信主 frame 的本地对象 URL，附件上限为 64 MiB。没有此能力声明的旧宿主仍使用原 Bridge v1；
新前端在旧宿主上给出 PDF 无法预览提示，升级 Mac 应用会同时更新宿主及内置前端。图片在 Web UI 内放大。

## V1 必须补全的接口

| 命令 | 请求 | 返回 | 约束 |
|---|---|---|---|
| `network.request` | `{requestId,operation,payload}` | `{requestId,status,data}` | operation 只允许 models/files/asr/tts 等固定接口 |
| `network.stream.start` | `{requestId,body}` | `{streamId}` | Native 从本地凭据服务取 Key，逐帧推事件 |
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
