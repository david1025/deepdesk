/**
 * macOS 原生存储后端（T06）：全部会话/附件数据经 Native Bridge 读写 SQLite 与
 * 内容寻址 blob 文件（详见 macos/Sources/Services/StorageService.swift）。
 * 接口与 IndexedDB 后端完全一致；仅在 isMacDesktop() 且 storage_mode=sqlite 时启用。
 * 附件字节分块传输（3MB/块），读取按 1MB 分块组装 Blob。
 */
import type { Session, SessionSummary } from './types.js'
import type { ChatModel } from '../api/types.js'
import type { MessageUsage } from '../api/types.js'
import type { StoredFile } from './db.js'

type NativeBridgeError = Error & { code?: string }

const call = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  if (typeof window.deepseekNativeCall !== 'function') {
    throw new Error('Native macOS bridge is unavailable')
  }
  return window.deepseekNativeCall(method, params)
}

const CHUNK_BYTES = 3 * 1024 * 1024

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

const throwNative = (error: unknown): never => {
  if (error instanceof Error) {
    throw error
  }
  throw new Error(String(error))
}

/** 把附件字节分块推到原生 blob 暂存（saveSession 时才落盘登记） */
const putBlob = async (fileId: string, mime: string, blob: Blob): Promise<void> => {
  await call('storage.blob.putBegin', { fileId, mime })
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      await call('storage.blob.putAppend', {
        fileId,
        base64: toBase64(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))),
      })
    }
    await call('storage.blob.putFinish', { fileId })
  } catch (error) {
    await call('storage.blob.putCancel', { fileId }).catch(() => {})
    throwNative(error)
  }
}

export const nativeBackend = {
  async loadSessionSummaries(): Promise<SessionSummary[]> {
    const result = await call('storage.listSummaries')
    return (result.summaries as SessionSummary[]) ?? []
  },

  async loadAllUsageMessages(): Promise<
    { model: ChatModel | null; usage: MessageUsage; completedAt: number }[]
  > {
    const result = await call('storage.loadAllUsage')
    return (
      (result.records as { model?: string | null; usage: MessageUsage; completedAt: number }[]) ??
      []
    ).map((record) => ({
      model: (record.model ?? null) as ChatModel | null,
      usage: record.usage,
      completedAt: record.completedAt,
    }))
  },

  async loadSessionIds(): Promise<string[]> {
    const result = await call('storage.listSessionIds')
    return (result.ids as string[]) ?? []
  },

  async loadFileIds(): Promise<string[]> {
    const result = await call('storage.listFileIds')
    return (result.ids as string[]) ?? []
  },

  async loadSession(id: string): Promise<Session | undefined> {
    const result = await call('storage.loadSession', { id })
    const sessionJson = result?.session
    if (typeof sessionJson !== 'string') {
      return undefined
    }
    return JSON.parse(sessionJson) as Session
  },

  async saveSession(session: Session, files: StoredFile[] = []): Promise<void> {
    for (const file of files) {
      await putBlob(file.id, file.blob.type || '', file.blob)
    }
    await call('storage.saveSession', {
      session: JSON.stringify(session),
      fileIds: files.map((file) => file.id),
    })
  },

  async renameSession(id: string, title: string): Promise<void> {
    await call('storage.renameSession', { id, title })
  },

  async deleteSession(id: string): Promise<void> {
    await call('storage.deleteSession', { id })
  },

  async saveFiles(files: StoredFile[]): Promise<void> {
    for (const file of files) {
      await putBlob(file.id, file.blob.type || '', file.blob)
    }
  },

  async loadFile(id: string): Promise<Blob | undefined> {
    const meta: { mime: string; size: number } = await (async () => {
      try {
        return await call('storage.loadFileMeta', { fileId: id })
      } catch (error) {
        if ((error as NativeBridgeError).code === 'STORAGE_NOT_FOUND') {
          return { mime: '', size: 0 }
        }
        throwNative(error)
      }
    })()
    if (meta.size === 0) {
      return meta.mime ? new Blob([], { type: meta.mime }) : undefined
    }
    const chunks: ArrayBuffer[] = []
    let offset = 0
    const step = 1024 * 1024
    while (offset < meta.size) {
      const result = await call('storage.blob.read', { fileId: id, offset, length: step })
      const binary = atob(result.base64 as string)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      chunks.push(bytes.buffer as ArrayBuffer)
      offset += bytes.byteLength
    }
    return new Blob(chunks, { type: meta.mime })
  },

  async clearStaging(): Promise<void> {
    await call('storage.staging.clear')
  },

  async addStagingSession(session: Session): Promise<void> {
    await call('storage.staging.addSession', { session: JSON.stringify(session) })
  },

  async saveStagingFiles(files: StoredFile[]): Promise<void> {
    for (const file of files) {
      await call('storage.staging.putFileBegin', { fileId: file.id, mime: file.blob.type || '' })
      try {
        const bytes = new Uint8Array(await file.blob.arrayBuffer())
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          await call('storage.staging.putFileAppend', {
            fileId: file.id,
            base64: toBase64(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))),
          })
        }
        await call('storage.staging.putFileFinish', { fileId: file.id })
      } catch (error) {
        throwNative(error)
      }
    }
  },

  async updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void> {
    await call('storage.staging.updateFileTypes', { types: Object.fromEntries(types) })
  },

  async commitStaging(): Promise<SessionSummary[]> {
    const result = await call('storage.staging.commitReplace')
    return (result.summaries as SessionSummary[]) ?? []
  },

  async commitStagingMerge(): Promise<{ summaries: SessionSummary[]; skipped: number }> {
    const result = await call('storage.staging.commitMerge')
    return {
      summaries: (result.summaries as SessionSummary[]) ?? [],
      skipped: (result.skipped as number) ?? 0,
    }
  },
}

export type NativeStorageBackend = typeof nativeBackend
