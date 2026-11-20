/**
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
