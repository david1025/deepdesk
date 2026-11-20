import * as db from '../db.js'
import { createId } from '../../../utils/id.js'
import { BackupError, fail } from './errors.js'
import { isZipFile, readArchive, readEntry, ArchiveError, type ArchiveEntry } from './zipReader.js'
import { writeArchive } from './zipWriter.js'
import type { Session } from '../types.js'

/**
 * 完整备份格式（archiveVersion 4），与 v3 历史导出互补：
 * - sessions/<id>.json：本地原始会话（完整消息树/分支/状态，不压平）
 * - files/<sha256>/<文件名>：全部附件原件（含非图片）
 * - settings.json：本地偏好（显式排除 API Key）
 * - manifest.json：archiveVersion、条目清单（路径/SHA-256/大小），导入前逐条校验
 * 导入走既有暂存管线（mergeHistory/replaceHistory），失败不清空本地数据。
 */

export const ARCHIVE_VERSION_V4 = 4
const MANIFEST_PATH_V4 = 'manifest.json'
const SETTINGS_PATH_V4 = 'settings.json'
const SESSION_PREFIX_V4 = 'sessions/'
const FILE_PREFIX_V4 = 'files/'
/** 单条目与总量上限：防止超大/恶意归档耗尽内存（docs/04 §4） */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024

export type V4FileRecord = { id: string; name: string; mime: string; sha256: string; size: number }
export type V4Manifest = {
  archiveVersion: typeof ARCHIVE_VERSION_V4
  createdAt: string
  sessions: number
  files: V4FileRecord[]
  entries: { path: string; sha256: string; size: number }[]
}

const isV4Manifest = (value: unknown): value is V4Manifest =>
  typeof value === 'object' &&
  value !== null &&
  (value as V4Manifest).archiveVersion === ARCHIVE_VERSION_V4 &&
  Array.isArray((value as V4Manifest).entries) &&
  Array.isArray((value as V4Manifest).files)

const jsonBlob = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new BackupError('backupInvalidJson')
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const sanitizeFilePart = (name: string) => {
  const cleaned = name.normalize('NFC').replace(/[\\/:*?"<>|\0]/g, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'file'
}

const sessionPathV4 = (sessionId: string) => `${SESSION_PREFIX_V4}${sessionId}.json`

const filePathV4 = (sha256: string, name: string) => `${FILE_PREFIX_V4}${sha256}/${sanitizeFilePart(name)}`

const parseSessionPathV4 = (path: string): string | null => {
  const match = /^sessions\/([A-Za-z0-9-]+)\.json$/.exec(path)
  return match ? match[1] : null
}

const isRecognizedV4Path = (path: string) =>
  path === MANIFEST_PATH_V4 ||
  path === SETTINGS_PATH_V4 ||
  parseSessionPathV4(path) !== null ||
  /^files\/[a-f0-9]{64}\/.+/.test(path)

/** 导出设置快照：本地偏好不含 API Key（docs/07-ai-work-orders.md T07） */
const exportSettingsSnapshot = (): Record<string, string> => {
  const snapshot: Record<string, string> = {}
  if (typeof localStorage === 'undefined') {
    return snapshot
  }
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || key.endsWith(':api-key')) continue
    if (key.startsWith('chat-demo:') || key.startsWith('deepdesk:')) {
      const value = localStorage.getItem(key)
      if (value !== null) snapshot[key] = value
    }
  }
  return snapshot
}

/**
 * 生成 v4 完整备份 ZIP。sessions 为全部会话快照（与 v3 导出相同的读取方式）。
 */
export const exportArchiveV4 = async (
  sessions: Iterable<Session> | AsyncIterable<Session>
): Promise<Blob> => {
  const entries: { name: string; blob: Blob }[] = []
  const entryRecords: { path: string; sha256: string; size: number }[] = []
  const fileRecords: V4FileRecord[] = []
  const hashedPaths = new Map<string, string>()
  let totalBytes = 0

  const addEntry = async (path: string, blob: Blob) => {
    const bytes = await blob.arrayBuffer()
    if (bytes.byteLength > MAX_ENTRY_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
      fail('backupIncomplete')
    }
    totalBytes += bytes.byteLength
    const sha256 = await sha256Hex(bytes)
    entries.push({ name: path, blob })
    entryRecords.push({ path, sha256, size: bytes.byteLength })
    return sha256
  }

  const seenSessionIds = new Set<string>()
  const seenFileIds = new Set<string>()
  for await (const session of sessions) {
    if (seenSessionIds.has(session.id)) {
      fail('backupIncomplete')
    }
    seenSessionIds.add(session.id)
    for (const message of session.messages) {
      if (message.role !== 'user') continue
      for (const attachment of message.files) {
        if (seenFileIds.has(attachment.id)) continue
        seenFileIds.add(attachment.id)
        const blob = await db.loadFile(attachment.id)
        if (!blob) {
          // 原件缺失（如历史导入时就没有）：保留元数据，不阻断导出
          continue
        }
        const digest = await (async () => {
          const bytes = await blob.arrayBuffer()
          if (bytes.byteLength > MAX_ENTRY_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
            fail('backupIncomplete')
          }
          totalBytes += bytes.byteLength
          return sha256Hex(bytes)
        })()
        const existingPath = hashedPaths.get(digest)
        const path = existingPath ?? filePathV4(digest, attachment.name)
        if (!existingPath) {
          entries.push({ name: path, blob })
          entryRecords.push({ path, sha256: digest, size: blob.size })
          hashedPaths.set(digest, path)
        }
        fileRecords.push({
          id: attachment.id,
          name: attachment.name,
          mime: blob.type || '',
          sha256: digest,
          size: blob.size,
        })
      }
    }
    await addEntry(sessionPathV4(session.id), jsonBlob(session))
  }

  await addEntry(SETTINGS_PATH_V4, jsonBlob(exportSettingsSnapshot()))
  const manifest: V4Manifest = {
    archiveVersion: ARCHIVE_VERSION_V4,
    createdAt: new Date().toISOString(),
    sessions: seenSessionIds.size,
    files: fileRecords,
    entries: entryRecords,
  }
  entries.unshift({ name: MANIFEST_PATH_V4, blob: jsonBlob(manifest) })
  return writeArchive(entries)
}

const readJsonEntry = async (entry: ArchiveEntry): Promise<unknown> => {
  const blob = await readEntry(entry)
  try {
    return JSON.parse(await blob.text())
  } catch {
    return fail('backupInvalidJson')
  }
}

/** 读取首个 manifest 条目判断格式版本：4 → v4 完整备份；其他 → v3。 */
export const sniffArchiveVersion = async (file: File): Promise<3 | 4> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      const parsed = JSON.parse(await (await readEntry(entry)).text())
      if (isV4Manifest(parsed)) return 4
      return 3
    }
  } catch (error) {
    if (error instanceof BackupError) throw error
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  throw new BackupError('backupUnrecognized')
}

type V4ImportState = {
  manifest: V4Manifest
  verifiedBytes: { path: string; bytes: Uint8Array }[]
  sessionCount: number
}

/** 逐条校验 ZIP（路径白名单 + SHA-256 + 大小），全部通过才进入导入阶段。 */
const verifyArchiveV4 = async (file: File): Promise<V4ImportState> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  let manifest: V4Manifest | undefined
  const expected = new Map<string, { sha256: string; size: number }>()
  const sessionPaths = new Set<string>()
  const verifiedBytes: { path: string; bytes: Uint8Array }[] = []
  let totalBytes = 0
  try {
    for await (const entry of readArchive(file)) {
      const { path } = entry
      if (!manifest) {
        if (path !== MANIFEST_PATH_V4) fail('backupUnrecognized')
        const parsed = await readJsonEntry(entry)
        if (!isV4Manifest(parsed)) {
          throw new BackupError('backupUnrecognized')
        }
        manifest = parsed
        for (const record of parsed.entries) {
          if (!isRecognizedV4Path(record.path)) fail('backupUnrecognized')
          if (expected.has(record.path)) fail('backupInvalidJson')
          expected.set(record.path, { sha256: record.sha256, size: record.size })
          if (parseSessionPathV4(record.path)) sessionPaths.add(record.path)
        }
        continue
      }
      if (!isRecognizedV4Path(path)) fail('backupUnrecognized')
      const expectation = expected.get(path)
      if (expectation === undefined) {
        throw new BackupError('backupIncomplete')
      }
      const blob = await readEntry(entry)
      if (blob.size > MAX_ENTRY_BYTES) fail('backupIncomplete')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (bytes.byteLength !== expectation.size) fail('backupIncomplete')
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_TOTAL_BYTES) fail('backupIncomplete')
      if ((await sha256Hex(bytes.buffer as ArrayBuffer)) !== expectation.sha256) fail('backupIncomplete')
      verifiedBytes.push({ path, bytes })
      expected.delete(path)
    }
  } catch (error) {
    if (error instanceof BackupError) throw error
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (manifest === undefined || expected.size > 0) {
    fail('backupIncomplete')
  }
  if (manifest === undefined) {
    throw new BackupError('backupIncomplete')
  }
  if (sessionPaths.size !== manifest.sessions) fail('backupIncomplete')
  return { manifest, verifiedBytes, sessionCount: sessionPaths.size }
}

const minimalSessionCheck = (value: unknown): Session | null => {
  if (typeof value !== 'object' || value === null) return null
  const session = value as Session
  if (typeof session.id !== 'string' || !Array.isArray(session.messages)) return null
  for (const message of session.messages) {
    if (typeof message !== 'object' || message === null) return null
    if (message.role !== 'user' && message.role !== 'assistant') return null
    if (message.role === 'user' && !Array.isArray(message.files)) return null
  }
  return session
}

/**
 * v4 导入（在暂存上下文中执行；调用方负责 mergeHistory/replaceHistory 提交）。
 * 返回 merge 模式下跳过的重复会话数。
 */
export const importArchiveV4 = async (
  file: File,
  mode: 'replace' | 'merge' = 'replace'
): Promise<number> => {
  const state = await verifyArchiveV4(file)
  const existingSessionIds = mode === 'merge' ? new Set(await db.loadSessionIds()) : new Set<string>()
  const existingFileIds = mode === 'merge' ? new Set(await db.loadFileIds()) : new Set<string>()
  const remappedFileIds = new Map<string, string>()
  const fileBytes = new Map<string, Uint8Array>()
  const fileRecordBySha = new Map<string, V4FileRecord>()
  for (const record of state.manifest.files) {
    fileRecordBySha.set(record.sha256, record)
  }
  for (const item of state.verifiedBytes) {
    if (item.path.startsWith(FILE_PREFIX_V4)) {
      fileBytes.set(item.path, item.bytes)
    }
  }

  let skipped = 0
  let stagedSessions = 0
  const stagedMimes = new Map<string, string>()

  const saveFileBlob = async (id: string, record: V4FileRecord) => {
    const path = filePathV4(record.sha256, record.name)
    const bytes = fileBytes.get(path)
    if (!bytes) {
      // 清单声明了原件但归档缺条目：保留文件元数据（消息里仍显示文件名），不中断导入
      return
    }
    await db.saveStagingFiles([
      { id, blob: new Blob([bytes as unknown as BlobPart], { type: record.mime }) },
    ])
    stagedMimes.set(id, record.mime)
  }

  for (const item of state.verifiedBytes) {
    const sessionId = parseSessionPathV4(item.path)
    if (!sessionId) continue
    const session = minimalSessionCheck(JSON.parse(new TextDecoder().decode(item.bytes)))
    if (session === null || session.id !== sessionId) {
      throw new BackupError('backupIncomplete')
    }
    if (mode === 'merge' && existingSessionIds.has(sessionId)) {
      skipped += 1
      continue
    }
    for (const message of session.messages) {
      if (message.role !== 'user') continue
      for (const attachment of message.files) {
        const originalId = attachment.id
        let mappedId = remappedFileIds.get(originalId)
        if (!mappedId) {
          mappedId = originalId
          if (existingFileIds.has(mappedId)) {
            do {
              mappedId = createId()
            } while (existingFileIds.has(mappedId))
          }
          remappedFileIds.set(originalId, mappedId)
          existingFileIds.add(mappedId)
        }
        attachment.id = mappedId
        const record = state.manifest.files.find((entry) => entry.id === originalId)
        if (record && !stagedMimes.has(mappedId)) {
          await saveFileBlob(mappedId, record)
        }
      }
    }
    await db.addStagingSession(session)
    stagedSessions += 1
  }

  if (stagedSessions + skipped !== state.manifest.sessions) fail('backupIncomplete')
  await db.updateStagingFileTypes(stagedMimes)

  // 恢复设置（不覆盖 api-key）；运行中的界面在重启后生效
  for (const item of state.verifiedBytes) {
    if (item.path !== SETTINGS_PATH_V4) continue
    const snapshot = JSON.parse(new TextDecoder().decode(item.bytes)) as Record<string, unknown>
    if (typeof snapshot !== 'object' || snapshot === null) fail('backupInvalidJson')
    if (typeof localStorage !== 'undefined') {
      for (const [key, value] of Object.entries(snapshot)) {
        if (key.endsWith(':api-key')) continue
        if (typeof value === 'string' && (key.startsWith('chat-demo:') || key.startsWith('deepdesk:'))) {
          localStorage.setItem(key, value)
        }
      }
    }
  }
  return skipped
}
