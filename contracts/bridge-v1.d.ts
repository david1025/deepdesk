/** Native Bridge v1 合约；由前端 import type。平台安全限制详见 docs/04-architecture-security.md。
 * 实现状态见 docs/10-status-and-limits.md；未实现的方法调用会返回 ACTION_NOT_ALLOWED。 */
export interface NativeInfo { platform:'macos'; version:string; build:string; bridgeVersion:1 }

/** 已在 macOS 宿主实现的命令（macos/Sources/Bridge/NativeBridge.swift） */
export type NativeMethod =
  | 'app.getInfo' | 'app.openExternal' | 'app.loginItem.get' | 'app.loginItem.set'
  | 'system.getTheme' | 'system.themeChanged'
  | 'security.localCredential.v1.status' | 'security.localCredential.v1.set' | 'security.localCredential.v1.clear'
  | 'network.request' | 'network.stream.start' | 'network.stream.cancel'
  | 'network.upload.begin' | 'network.upload.append' | 'network.upload.finish' | 'network.upload.cancel'
  | 'import.pickArchive' | 'import.reportResult'
  | 'updater.check'
  | 'window.new' | 'window.setTitle'
  | 'attachment.previewPDF.v1'
  // T06 存储面（macOS 端已实现；浏览器/Windows 宿主无此通道，前端经 getMode 分流）
  | 'storage.getMode' | 'storage.stats'
  | 'storage.listSummaries' | 'storage.loadSession' | 'storage.saveSession'
  | 'storage.renameSession' | 'storage.deleteSession'
  | 'storage.listSessionIds' | 'storage.listFileIds' | 'storage.loadAllUsage'
  | 'storage.loadFileMeta' | 'storage.blob.read'
  | 'storage.blob.putBegin' | 'storage.blob.putAppend' | 'storage.blob.putFinish' | 'storage.blob.putCancel'
  | 'storage.staging.clear' | 'storage.staging.addSession'
  | 'storage.staging.putFileBegin' | 'storage.staging.putFileAppend' | 'storage.staging.putFileFinish'
  | 'storage.staging.updateFileTypes' | 'storage.staging.commitReplace' | 'storage.staging.commitMerge'
  | 'storage.migration.begin' | 'storage.migration.putSession'
  | 'storage.migration.putFileBegin' | 'storage.migration.putFileAppend' | 'storage.migration.putFileFinish'
  | 'storage.migration.commit' | 'storage.migration.abort'
  | 'sync.discover'
  // 以下协议已设计，macOS 端尚未实现；不得在前端假装成功：
  | 'file.pick' | 'file.save' | 'file.openDirectory'
  | 'sync.pair' | 'sync.status' | 'sync.start' | 'sync.stop';

/** The native process never returns the API key. Revisions order updates across windows. */
export interface LocalCredentialV1Status {
  configured: boolean
  revision: number
}

export interface LocalCredentialV1SetParams { key: string }

export interface AttachmentPDFPreviewParams {
  blobUrl: string
  name: string
}

export interface AttachmentPDFPreviewResult { opened: true }

/** network.request 的 operation 白名单（URL 固定为 https://api.deepseek.com 下的路径） */
export type NetworkOperation =
  | 'models'            // GET /models（校验 Key）
  | 'balance'           // GET /user/balance
  | 'files.delete'      // DELETE /anthropic/v1/files/{id}；payload:{fileId}
  | 'tts';              // POST /v1/tools/tts；payload:{text,voice:'stella'|'tide'} → {audioBase64,sampleRate:24000}

/** network.request 返回 { status, data }；非 2xx 由原生抛错 {code,message,status} */
export interface NetworkRequestResult { requestId:string; status:number; data:unknown }

/** network.upload.*：网页分块把文件交给原生，由原生 multipart 上传（files.upload/asr）。
 * begin → {uploadId}；finish → files.upload 返回 {file:FileObject}，asr 返回 {text} */
export interface UploadBeginParams {
  operation:'files.upload'|'asr'; name:string; mime:string; size:number; purpose?:string
}

/** 原生 → 网页事件（window CustomEvent，callAsyncJavaScript 推送） */
export interface NativeStreamEventDetail {
  streamId:string; seq:number
  type:'sse'|'complete'|'error'|'cancelled'
  /** sse: {b64} 原始 SSE 字节；error: {message,status?} */
  payload?:{ b64?:string; message?:string; status?:number }
}
export interface NativeThemeChangedDetail { theme:'dark'|'light' }

/** 存储变更广播（T06/B07 多窗口一致性）：任一窗口写入后原生推给全部 webview。
 * entityType: 'session'|'sessions'|'file'|'storage'（storage=存储模式切换，接收方整页刷新）；
 * entityId: 会话 id，批量变更/模式切换时为 '*'。 */
export interface NativeStorageChangedDetail { revision:number; entityType:'session'|'sessions'|'file'|'storage'; entityId:string }

/** 错误体：JS 侧 deepseekNativeCall 抛 Error，err.code/err.status 由此而来 */
export interface NativeBridgeError { code:string; message:string; status?:number }

export declare function deepseekNativeCall(method:NativeMethod, params?:Record<string,unknown>):Promise<unknown>;
