import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * macOS 宿主适配补丁。在 Windows 定制补丁（patch-chat-demo.mjs）之后执行：
 * - 新增 desktop.ts 平台适配层（T03 DesktopPlatformAdapter），组件层不做平台分支
 * - API 传输在 macOS 宿主内改走 Native Bridge（Keychain 密钥不回传 JS），
 *   浏览器/Windows 行为完全保持不变
 * - 主题上报与首启 ZIP 导入结果上报按平台分发
 * 锚点基于 chat-demo@5d5dd75 + DeepDesk 0.1.2 补丁后的内容。
 */

const root = path.resolve(process.argv[2] || '.')
const read = async (relative) => (await fs.readFile(path.join(root, relative), 'utf8')).replace(/\r\n/g, '\n')
const write = async (relative, value) => {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, value, 'utf8')
}
const replaceOnce = (source, before, after, file) => {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(file + ': expected one patch anchor, found ' + count + ': ' + before.slice(0, 90))
  return source.replace(before, after)
}

// ---------- 平台适配层 ----------
{
  await write('src/services/desktop.ts', `/**
 * 桌面平台适配层（DesktopPlatformAdapter 的宿主探测与单向通知部分）。
 * 组件与服务层只调用这里导出的函数，不直接判断平台或访问 window.webkit / chrome.webview。
 */
type NativeBridgeCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

declare global {
  interface Window {
    /** macOS 宿主在文档开始前注入的能力声明 */
    __DEEPSEEK_DESKTOP__?: { platform: 'macos'; bridgeVersion: number }
    /** macOS Native Bridge v1：contracts/bridge-v1.d.ts */
    deepseekNativeCall?: NativeBridgeCall
    /** DeepDesk 首启历史导入通道（由原生端驱动，见 main.tsx） */
    deepDeskHistoryImport?: {
      begin: (name: string, totalBytes: number) => boolean
      append: (base64: string) => boolean
      finish: () => Promise<void>
      cancel: () => void
    }
  }
}

/** macOS 宿主 + Bridge v1 就绪时才走原生传输；浏览器与 Windows 构建保持原有行为 */
export const isMacDesktop = (): boolean =>
  typeof window !== 'undefined' &&
  window.__DEEPSEEK_DESKTOP__?.platform === 'macos' &&
  typeof window.deepseekNativeCall === 'function'

export const isWindowsDesktop = (): boolean =>
  typeof window !== 'undefined' && !!window.chrome?.webview && !isMacDesktop()

/** 页面主题变化单向通知：Windows 走 WebView2 postMessage，macOS 走 Bridge 白名单命令。
 * preference 让原生区分「跟随系统」与「显式选择」，避免原生覆盖破坏跟随系统模式 */
export const reportThemeToNative = (theme: 'light' | 'dark', preference: 'system' | 'light' | 'dark'): void => {
  if (isMacDesktop()) {
    void window.deepseekNativeCall?.('system.themeChanged', { theme, preference }).catch(() => {})
    return
  }
  window.chrome?.webview?.postMessage({ type: 'deepdesk-theme', theme })
}

/** 首启历史 ZIP 导入结果单向通知 */
export const notifyHistoryImportResult = (
  success: boolean,
  result?: { imported: number; skipped: number },
  error?: string
): void => {
  if (isMacDesktop()) {
    void window.deepseekNativeCall
      ?.('import.reportResult', {
        success,
        imported: result?.imported ?? 0,
        skipped: result?.skipped ?? 0,
        error,
      })
      .catch(() => {})
    return
  }
  window.chrome?.webview?.postMessage({
    type: 'deepdesk-history-import-result',
    success,
    ...(success ? { result } : { error }),
  })
}
`)
}

// ---------- 跨平台 DPAPI/Keychain 凭据桥 ----------
{
  await write('src/services/native.ts', `/**
 * DeepDesk 桌面凭据/余额桥。
 * Windows：WebView2 postMessage（动作名与 DeepDesk 0.1.2 保持一致）。
 * macOS：window.deepseekNativeCall 映射到 Native Bridge v1 白名单命令，
 *        API Key 写入 Keychain，原生网络层自行读取，密钥不回传 JS。
 * 浏览器（pnpm dev）两套桥都不存在时按原有浏览器流程回退。
 */
import { isMacDesktop } from './desktop.js'

type NativeResponse = { type: 'response'; requestId: string; success: boolean; data: unknown }

declare global {
  interface Window {
    chrome?: { webview?: { postMessage: (message: unknown) => void; addEventListener: (type: 'message', listener: (event: MessageEvent<NativeResponse>) => void) => void } }
  }
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let sequence = 0
let listening = false

const requestWindows = <T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const webview = window.chrome?.webview
  if (!webview) return Promise.reject(new Error('Native Windows bridge is unavailable'))
  if (!listening) {
    listening = true
    webview.addEventListener('message', (event) => {
      const message = event.data
      if (!message || message.type !== 'response') return
      const task = pending.get(message.requestId)
      if (!task) return
      pending.delete(message.requestId)
      if (message.success) task.resolve(message.data)
      else {
        const detail = message.data as { message?: string }
        task.reject(new Error(detail?.message || 'Native request failed'))
      }
    })
  }
  const requestId = 'ui-' + (++sequence) + '-' + Date.now()
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: (value) => resolve(value as T), reject })
    webview.postMessage({ requestId, action, payload })
  })
}

const requestMac = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> => {
  const call = window.deepseekNativeCall
  if (!call) throw new Error('Native macOS bridge is unavailable')
  try {
    return (await call(method, params)) as T
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** 业务动作名 → macOS Bridge v1 白名单命令 */
const MAC_METHODS: Record<string, { method: string; params?: (payload: Record<string, unknown>) => Record<string, unknown> }> = {
  'settings.saveApiKey': {
    method: 'security.key.save',
    params: (payload) => ({ key: payload.apiKey }),
  },
  'api.getBalance': {
    method: 'network.request',
    params: () => ({ operation: 'balance' }),
  },
}

export const nativeRequest = <T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
  if (isMacDesktop()) {
    const mapping = MAC_METHODS[action]
    if (!mapping) return Promise.reject(new Error('Unsupported native action: ' + action))
    return requestMac<T>(mapping.method, mapping.params ? mapping.params(payload) : payload)
  }
  return requestWindows<T>(action, payload)
}

export const saveNativeApiKey = (apiKey: string) => nativeRequest<{ saved: boolean }>('settings.saveApiKey', { apiKey })
export const getNativeBalance = () => nativeRequest<{
  is_available: boolean
  balance_infos: Array<{ currency: 'CNY' | 'USD'; total_balance: string; granted_balance: string; topped_up_balance: string }>
}>('api.getBalance')
`)
}

// ---------- macOS 原生传输层 ----------
{
  await write('src/services/api/nativeTransport.ts', `/**
 * macOS 宿主专属 API 传输层：全部请求经 Native Bridge（NativeNetworking + Keychain）。
 * - 密钥参数在此层一律忽略（上游传入的是 DEEPDESK_NATIVE_CREDENTIAL 哨兵），
 *   原生侧直接从 Keychain 读取，密钥不回传 JS。
 * - SSE 语义保持不变：原生转发原始字节（base64），Web 端用上游 ServerSentEventDecoder 解析。
 * 仅在 isMacDesktop() 为真时被调用；浏览器/Windows 构建不会执行这些函数。
 */
import { ApiError } from './client.js'
import { readMessageEvent } from './parseEvent.js'
import { ServerSentEventDecoder, type ServerSentEvent } from './sse.js'
import type { CreateMessageRequest, FileObject, FilePurpose, MessageStreamEvent } from './types.js'

type BridgeErrorShape = Error & { code?: string; status?: number }

const call = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  if (typeof window.deepseekNativeCall !== 'function') {
    throw new ApiError('network', 'Native macOS bridge is unavailable')
  }
  try {
    return await window.deepseekNativeCall(method, params)
  } catch (error) {
    if (error instanceof ApiError) throw error
    const shape = error as BridgeErrorShape
    if (shape && typeof shape === 'object' && typeof shape.status === 'number') {
      throw new ApiError('http', shape.message || 'native request failed', shape.status)
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
}

const CHUNK_BYTES = 3 * 1024 * 1024

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** 用 GET /models 校验（原生用 Keychain 中的密钥）；取消由原生 25s 超时兜底 */
export const nativeVerifyApiKey = async (): Promise<void> => {
  await call('network.request', { operation: 'models' })
}

/** POST /anthropic/v1/files：分块把文件交给原生，由原生 multipart 上传 */
export const nativeUploadFile = async (
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const begin = await call('network.upload.begin', {
    operation: 'files.upload',
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    purpose,
  })
  const uploadId = begin.uploadId as string
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      signal?.throwIfAborted()
      await call('network.upload.append', {
        uploadId,
        base64: toBase64(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))),
      })
    }
    signal?.throwIfAborted()
    const result = await call('network.upload.finish', { uploadId })
    return result.file as FileObject
  } catch (error) {
    await call('network.upload.cancel', { uploadId }).catch(() => {})
    throw error
  }
}

/** DELETE /anthropic/v1/files/{file_id} */
export const nativeDeleteFile = async (fileId: string): Promise<void> => {
  await call('network.request', { operation: 'files.delete', payload: { fileId } })
}

/** ASR：WAV 分块交给原生，multipart POST /v1/tools/asr */
export const nativeTranscribe = async (audio: Blob, signal?: AbortSignal): Promise<string> => {
  const begin = await call('network.upload.begin', {
    operation: 'asr',
    name: 'recording.wav',
    mime: 'audio/wav',
    size: audio.size,
  })
  const uploadId = begin.uploadId as string
  try {
    const bytes = new Uint8Array(await audio.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      signal?.throwIfAborted()
      await call('network.upload.append', { uploadId, base64: toBase64(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))) })
    }
    signal?.throwIfAborted()
    const result = await call('network.upload.finish', { uploadId })
    return result.text as string
  } catch (error) {
    await call('network.upload.cancel', { uploadId }).catch(() => {})
    throw error
  }
}

/** TTS：原生拉取完整 PCM 后回传 base64，包装成上游期望的 ReadableStream */
export const nativeSynthesize = async (
  text: string,
  voice: 'stella' | 'tide',
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  signal.throwIfAborted()
  const result = await call('network.request', { operation: 'tts', payload: { text, voice } })
  const audioBase64 = result.audioBase64 as string
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

type StreamEventDetail = {
  streamId: string
  seq: number
  type: 'sse' | 'complete' | 'error' | 'cancelled'
  payload?: { b64?: string; message?: string; status?: number }
}

/**
 * POST /anthropic/v1/messages（stream: true）。
 * 事件顺序：原生按 seq 递增推送 nativeStreamEvent；type=sse 携带原始 SSE 字节（base64），
 * Web 用上游解码器解析，事件语义（ping、多行 data、error 帧、message_stop）与 fetch 完全一致。
 */
export async function* nativeStreamMessage(
  body: CreateMessageRequest,
  beta: boolean,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const start = await call('network.stream.start', { body: { ...body, stream: true }, beta })
  const streamId = start.streamId as string

  const decoder = new ServerSentEventDecoder()
  const buffered: ServerSentEvent[] = []
  let done = false
  let failure: unknown = null
  let wake: (() => void) | null = null

  const onStreamEvent = (event: Event) => {
    const detail = (event as CustomEvent<StreamEventDetail>).detail
    if (!detail || detail.streamId !== streamId) return
    switch (detail.type) {
      case 'sse': {
        if (detail.payload?.b64) {
          const binary = atob(detail.payload.b64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
          buffered.push(...decoder.push(new TextDecoder().decode(bytes, { stream: true })))
        }
        break
      }
      case 'complete':
        buffered.push(...decoder.end())
        done = true
        break
      case 'error':
        failure = new ApiError(
          'http',
          detail.payload?.message || '模型服务返回错误。',
          detail.payload?.status
        )
        done = true
        break
      case 'cancelled':
        failure = abortError()
        done = true
        break
    }
    wake?.()
  }
  window.addEventListener('nativeStreamEvent', onStreamEvent)

  const onAbort = () => {
    void call('network.stream.cancel', { streamId }).catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      while (buffered.length > 0) {
        const { event: eventName, data } = buffered.shift() as ServerSentEvent
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          if (eventName !== 'error') continue
        }
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error?: { message?: unknown } }).error?.message === 'string'
        ) {
          throw new ApiError('stream', (payload as { error: { message: string } }).error.message)
        }
        if (eventName === 'error') {
          throw new ApiError('stream', data)
        }
        const event = readMessageEvent(payload)
        if (!event) continue
        yield event
        if (event.type === 'message_stop') return
      }
      if (done) {
        if (failure) throw failure
        // 流在 message_stop 之前结束
        throw new ApiError('interrupted', '')
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = null
    }
  } finally {
    wake = null
    window.removeEventListener('nativeStreamEvent', onStreamEvent)
    signal.removeEventListener('abort', onAbort)
    if (!done && !signal.aborted) {
      void call('network.stream.cancel', { streamId }).catch(() => {})
    }
  }
}
`)
}

// ---------- client.ts：macOS 分支 ----------
{
  const file = 'src/services/api/client.ts'
  let s = await read(file)
  s = replaceOnce(
    s,
    "import { readMessageEvent } from './parseEvent.js'\n",
    "import { readMessageEvent } from './parseEvent.js'\nimport { isMacDesktop } from '../desktop.js'\nimport { nativeDeleteFile, nativeStreamMessage, nativeUploadFile, nativeVerifyApiKey } from './nativeTransport.js'\n",
    file
  )
  s = replaceOnce(
    s,
    "export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {\n  await request(",
    "export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {\n  // macOS 宿主：密钥在 Keychain，由原生层校验；apiKey 形参只是上游签名的哨兵值\n  if (isMacDesktop()) return nativeVerifyApiKey()\n  await request(",
    file
  )
  s = replaceOnce(
    s,
    "  signal?: AbortSignal\n): Promise<FileObject> => {\n  const form = new FormData()",
    "  signal?: AbortSignal\n): Promise<FileObject> => {\n  if (isMacDesktop()) return nativeUploadFile(file, purpose, signal)\n  const form = new FormData()",
    file
  )
  s = replaceOnce(
    s,
    "export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {\n  await request(",
    "export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {\n  if (isMacDesktop()) return nativeDeleteFile(fileId)\n  await request(",
    file
  )
  s = replaceOnce(
    s,
    "  signal: AbortSignal\n): AsyncGenerator<MessageStreamEvent> {\n  const response = await request(",
    "  signal: AbortSignal\n): AsyncGenerator<MessageStreamEvent> {\n  // macOS 宿主：原生 URLSession 发起请求并按序转发 SSE 字节，Web 端解析器保持不变\n  if (isMacDesktop()) {\n    yield* nativeStreamMessage(body, hasFile(body), signal)\n    return\n  }\n  const response = await request(",
    file
  )
  await write(file, s)
}

// ---------- speech.ts：macOS 分支 ----------
{
  const file = 'src/services/api/speech.ts'
  let s = await read(file)
  s = replaceOnce(
    s,
    "import { ApiError, API_ORIGIN, request } from './client.js'\n",
    "import { ApiError, API_ORIGIN, request } from './client.js'\nimport { isMacDesktop } from '../desktop.js'\nimport { nativeSynthesize, nativeTranscribe } from './nativeTransport.js'\n",
    file
  )
  s = replaceOnce(
    s,
    "  signal?: AbortSignal\n): Promise<string> => {\n  const form = new FormData()",
    "  signal?: AbortSignal\n): Promise<string> => {\n  if (isMacDesktop()) return nativeTranscribe(audio, signal)\n  const form = new FormData()",
    file
  )
  s = replaceOnce(
    s,
    "  signal: AbortSignal\n): Promise<ReadableStream<Uint8Array>> => {\n  const response = await request(",
    "  signal: AbortSignal\n): Promise<ReadableStream<Uint8Array>> => {\n  if (isMacDesktop()) return nativeSynthesize(text, voice, signal)\n  const response = await request(",
    file
  )
  await write(file, s)
}

// ---------- theme.ts：主题上报按平台分发 ----------
{
  const file = 'src/app/theme.ts'
  let s = await read(file)
  s = replaceOnce(
    s,
    "import { useSettings, type ThemePreference } from '../services/settings.js'\n",
    "import { useSettings, type ThemePreference } from '../services/settings.js'\nimport { reportThemeToNative } from '../services/desktop.js'\n",
    file
  )
  s = replaceOnce(
    s,
    "const applyTheme = (theme: Theme) => {",
    "const applyTheme = (theme: Theme, preference: ThemePreference) => {",
    file
  )
  s = replaceOnce(
    s,
    "  reportThemeToNative(theme)\n",
    "  reportThemeToNative(theme, preference)\n",
    file
  )
  s = replaceOnce(
    s,
    "    appliedTheme = theme\n    applyTheme(theme)",
    "    appliedTheme = theme\n    applyTheme(theme, useSettings.getState().themePreference)",
    file
  )
  await write(file, s)
}

// ---------- main.tsx：首启导入结果按平台分发 + 原生新建聊天事件 ----------
{
  const file = 'src/main.tsx'
  let s = await read(file)
  s = replaceOnce(
    s,
    "import './services/native.js'\n",
    "import './services/native.js'\nimport { notifyHistoryImportResult } from './services/desktop.js'\nimport { newChat } from './services/chat/store.js'\nimport { migrateStorageToNative } from './services/chat/migrateStorage.js'\n",
    file
  )
  s = replaceOnce(
    s,
    "createRoot(document.getElementById('root') as HTMLElement).render(<App />)",
    `// macOS 原生菜单 Cmd+N 触发的新建聊天；与网页侧新建按钮行为一致
window.addEventListener('deepdesk-native-new-chat', () => {
  newChat()
})

// 原生设置界面的「迁移到 SQLite」入口（T06/E04）
window.__deepseekMigrateStorage = () =>
  migrateStorageToNative((progress) => {
    // 进度只留控制台，不把会话内容写进日志
    console.info('[storage-migration] ' + progress.phase + ' ' + progress.done + '/' + progress.total)
  })

createRoot(document.getElementById('root') as HTMLElement).render(<App />)`,
    file
  )
  s = replaceOnce(
    s,
    `      window.chrome?.webview?.postMessage({
        type: 'deepdesk-history-import-result',
        success: true,
        result,
      })`,
    `      notifyHistoryImportResult(true, result)`,
    file
  )
  s = replaceOnce(
    s,
    `      window.chrome?.webview?.postMessage({
        type: 'deepdesk-history-import-result',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })`,
    `      notifyHistoryImportResult(false, undefined, error instanceof Error ? error.message : String(error))`,
    file
  )
  await write(file, s)
}

console.log('macOS host adaptation patches applied.')
