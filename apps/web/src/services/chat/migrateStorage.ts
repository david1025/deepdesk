/**
 * IndexedDB → SQLite 一次性迁移（T06/E04）：
 * - 逐条读取旧 IndexedDB 数据（此时 storage_mode 仍为 idb，db.ts 全部走 IndexedDB）
 * - 会话整条 JSON 带 SHA-256 推给原生，原生逐条校验 hash 后写入
 * - 附件分块推送，原生落盘为内容寻址文件
 * - commit 时原生核对条数（sessions/attachments 全部一致）才切换 storage_mode=sqlite
 * - 原始 IndexedDB 完整保留（回滚备份），迁移失败不影响任何本地数据
 * - 提交成功后原生广播 storage 变更，全部窗口自动刷新切换后端
 */
import { isMacDesktop } from '../desktop.js'
import * as db from './db.js'

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

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type MigrationProgress = {
  phase: 'sessions' | 'files' | 'verifying' | 'done'
  done: number
  total: number
}

export const migrateStorageToNative = async (
  onProgress?: (progress: MigrationProgress) => void
): Promise<{ mode: string; sessions: number; attachments: number }> => {
  if (!isMacDesktop()) {
    throw new Error('仅 macOS 客户端支持原生存储迁移。')
  }
  const mode = (await call('storage.getMode'))?.mode
  if (mode === 'sqlite') {
    throw new Error('本地数据已完成原生存储迁移。')
  }
  // 读旧库快照（IndexedDB）
  const sessionIds = await db.loadSessionIds()
  const fileIds = await db.loadFileIds()
  await call('storage.migration.begin', {
    expectedSessions: sessionIds.length,
    expectedFiles: fileIds.length,
  })

  const pushFile = async (fileId: string, blob: Blob) => {
    await call('storage.migration.putFileBegin', { fileId, mime: blob.type || '' })
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        await call('storage.migration.putFileAppend', {
          fileId,
          base64: toBase64(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))),
        })
      }
      await call('storage.migration.putFileFinish', { fileId })
    } catch (error) {
      await call('storage.migration.abort').catch(() => {})
      throw error
    }
  }

  try {
    for (let index = 0; index < sessionIds.length; index += 1) {
      const session = await db.loadSession(sessionIds[index])
      if (!session) {
        throw new Error(`会话 ${sessionIds[index]} 在读取时消失，迁移已中止。`)
      }
      const json = JSON.stringify(session)
      const digest = await sha256Hex(json)
      await call('storage.migration.putSession', { session: json, sha256: digest })
      onProgress?.({ phase: 'sessions', done: index + 1, total: sessionIds.length })
    }
    for (let index = 0; index < fileIds.length; index += 1) {
      const blob = await db.loadFile(fileIds[index])
      if (!blob) {
        // 元数据存在但原件缺失：与导入行为一致，保留文件信息、跳过字节
        continue
      }
      await pushFile(fileIds[index], blob)
      onProgress?.({ phase: 'files', done: index + 1, total: fileIds.length })
    }
    onProgress?.({ phase: 'verifying', done: sessionIds.length, total: sessionIds.length })
    const result = await call('storage.migration.commit', {
      expectedSessions: sessionIds.length,
      expectedFiles: fileIds.length,
    })
    onProgress?.({ phase: 'done', done: 1, total: 1 })
    return {
      mode: result.mode as string,
      sessions: result.sessions as number,
      attachments: result.attachments as number,
    }
  } catch (error) {
    // 失败：清理原生半成品，保持 mode=idb，旧数据原样
    await call('storage.migration.abort').catch(() => {})
    throw error
  }
}
