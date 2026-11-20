import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type AssistantMessage, type Session, type SessionSummary } from './types.js'
import type { ChatModel } from '../api/types.js'
import { isMacDesktop } from '../desktop.js'
import { nativeBackend } from './nativeDb.js'
import { showStorageErrorBanner } from './storageBanner.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 11

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

export type UsageRecord = {
  model: ChatModel | null
  usage: NonNullable<AssistantMessage['usage']>
  completedAt: number
}

/**
 * 存储后端统一接口（T06）：IndexedDB（浏览器 / 未迁移的 macOS）与
 * 原生 SQLite（macOS，storage_mode=sqlite）实现同一套语义。
 */
export interface ChatStorageBackend {
  loadSessionSummaries(): Promise<SessionSummary[]>
  loadAllUsageMessages(): Promise<UsageRecord[]>
  loadSessionIds(): Promise<string[]>
  loadFileIds(): Promise<string[]>
  loadSession(id: string): Promise<Session | undefined>
  saveSession(session: Session, files?: StoredFile[]): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  deleteSession(id: string): Promise<void>
  saveFiles(files: StoredFile[]): Promise<void>
  loadFile(id: string): Promise<Blob | undefined>
  clearStaging(): Promise<void>
  addStagingSession(session: Session): Promise<void>
  saveStagingFiles(files: StoredFile[]): Promise<void>
  updateStagingFileTypes(types: ReadonlyMap<string, string>): Promise<void>
  commitStaging(): Promise<SessionSummary[]>
  commitStagingMerge(): Promise<{ summaries: SessionSummary[]; skipped: number }>
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

const idbBackend: ChatStorageBackend = {
  loadSessionSummaries: async () =>
    (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary),

  loadAllUsageMessages: async () => {
    const sessions = await (await getDB()).getAll('sessions')
    return sessions.flatMap((session) =>
      session.messages
        .filter(
          (message): message is AssistantMessage & { usage: NonNullable<AssistantMessage['usage']> } =>
            message.role === 'assistant' && !!message.usage
        )
        .map((message) => ({
          model: message.model,
          usage: message.usage,
          completedAt: message.completedAt ?? message.createdAt,
        }))
    )
  },

  loadSessionIds: async () => (await (await getDB()).getAllKeys('sessions')) as string[],

  loadFileIds: async () => (await (await getDB()).getAllKeys('files')) as string[],

  loadSession: async (id) => (await getDB()).get('sessions', id),

  saveSession: async (session, files = []) => {
    const summary = storedSummary(session)
    const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
    await Promise.all([
      (async () => {
        try {
          for (const file of files) {
            await tx.objectStore('files').put(file)
          }
          await tx.objectStore('sessions').put(session)
          await tx.objectStore('sessionSummaries').put(summary)
        } catch (error) {
          abortTransaction(tx)
          throw error
        }
      })(),
      tx.done,
    ])
  },

  /** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
  renameSession: async (id, title) => {
    const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
    await Promise.all([
      (async () => {
        try {
          const sessions = tx.objectStore('sessions')
          const session = await sessions.get(id)
          if (session) {
            session.title = title
            await sessions.put(session)
            await tx.objectStore('sessionSummaries').put(storedSummary(session))
          }
        } catch (error) {
          abortTransaction(tx)
          throw error
        }
      })(),
      tx.done,
    ])
  },

  /** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
  deleteSession: async (sessionId) => {
    const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
    await Promise.all([
      (async () => {
        try {
          const summaries = tx.objectStore('sessionSummaries')
          const summary = await summaries.get(sessionId)
          await tx.objectStore('sessions').delete(sessionId)
          await summaries.delete(sessionId)
          for (const id of summary?.fileIds ?? []) {
            if ((await summaries.index('fileIds').count(id)) === 0) {
              await tx.objectStore('files').delete(id)
            }
          }
        } catch (error) {
          abortTransaction(tx)
          throw error
        }
      })(),
      tx.done,
    ])
  },

  saveFiles: async (files) => {
    const tx = (await getDB()).transaction('files', 'readwrite')
    await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
  },

  loadFile: async (id) => (await (await getDB()).get('files', id))?.blob,

  /** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
  clearStaging: async () => {
    const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
    await Promise.all([
      tx.objectStore('sessionsStaging').clear(),
      tx.objectStore('filesStaging').clear(),
      tx.done,
    ])
  },

  addStagingSession: async (session) => {
    await (await getDB()).add('sessionsStaging', session)
  },

  saveStagingFiles: async (files) => {
    const tx = (await getDB()).transaction('filesStaging', 'readwrite')
    await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
  },

  /** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
  updateStagingFileTypes: async (types) => {
    const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
    await Promise.all([
      (async () => {
        for (
          let cursor = await tx.store.openCursor();
          cursor;
          cursor = await cursor.continue()
        ) {
          const session = cursor.value
          let changed = false
          for (const message of session.messages) {
            if (message.role !== 'user') {
              continue
            }
            for (const file of message.files) {
              const type = types.get(file.id) ?? ''
              if (file.mimeType !== type) {
                file.mimeType = type
                changed = true
              }
            }
          }
          if (changed) {
            await cursor.update(session)
          }
        }
      })(),
      tx.done,
    ])
  },

  /**
   * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
   * 事务失败时整体回滚，正式数据不变。
   */
  commitStaging: async () => {
    const summaries: SessionSummary[] = []
    const tx = (await getDB()).transaction(
      ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
      'readwrite'
    )
    const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
      try {
        const target = tx.objectStore(to)
        await target.clear()
        if (to === 'sessions') {
          await tx.objectStore('sessionSummaries').clear()
        }
        for (
          let cursor = await tx.objectStore(from).openCursor();
          cursor;
          cursor = await cursor.continue()
        ) {
          await target.put(cursor.value)
          if (to === 'sessions') {
            const summary = storedSummary(cursor.value as Session)
            await tx.objectStore('sessionSummaries').put(summary)
            summaries.push(toSessionSummary(summary))
          }
        }
        await tx.objectStore(from).clear()
      } catch (error) {
        // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
        abortTransaction(tx)
        throw error
      }
    }
    await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
    return summaries
  },

  /**
   * Merge staging into the existing history. Existing session IDs are never overwritten.
   * File IDs are expected to have been remapped by the importer; a collision aborts the
   * whole transaction rather than replacing an existing attachment.
   */
  commitStagingMerge: async () => {
    const summaries: SessionSummary[] = []
    const usedFileIds = new Set<string>()
    let skipped = 0
    const tx = (await getDB()).transaction(
      ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
      'readwrite'
    )
    const operation = (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const summariesStore = tx.objectStore('sessionSummaries')
        for (
          let cursor = await tx.objectStore('sessionsStaging').openCursor();
          cursor;
          cursor = await cursor.continue()
        ) {
          const session = cursor.value
          if (await sessions.get(session.id)) {
            skipped += 1
            continue
          }
          await sessions.add(session)
          const summary = storedSummary(session)
          await summariesStore.add(summary)
          summaries.push(toSessionSummary(summary))
          for (const message of session.messages) {
            if (message.role === 'user') {
              for (const attachment of message.files) usedFileIds.add(attachment.id)
            }
          }
        }
        const files = tx.objectStore('files')
        for (
          let cursor = await tx.objectStore('filesStaging').openCursor();
          cursor;
          cursor = await cursor.continue()
        ) {
          if (usedFileIds.has(cursor.value.id)) {
            await files.add(cursor.value)
          }
        }
        await tx.objectStore('sessionsStaging').clear()
        await tx.objectStore('filesStaging').clear()
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })()
    await Promise.all([operation, tx.done])
    return { summaries, skipped }
  },
}

/**
 * 后端选择：macOS 宿主按原生 storage_mode 分流（迁移提交后宿主会刷新页面，
 * memo 自然重置）；浏览器 / Windows 恒为 IndexedDB。
 */
let backendPromise: Promise<ChatStorageBackend> | null = null

const detectBackend = async (): Promise<ChatStorageBackend> => {
  if (isMacDesktop()) {
    try {
      const result = (await window.deepseekNativeCall?.('storage.getMode')) as
        | { mode?: string }
        | undefined
      if (result?.mode === 'sqlite') {
        return nativeBackend
      }
    } catch {
      // 桥不可用或读取失败：继续使用 IndexedDB，不用清库等破坏性方式解决。
    }
  }
  return idbBackend
}

export const getChatStorageBackend = (): Promise<ChatStorageBackend> =>
  (backendPromise ??= detectBackend())

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await getChatStorageBackend()).loadSessionSummaries()

export const loadAllUsageMessages = (): Promise<UsageRecord[]> =>
  getChatStorageBackend().then((backend) => backend.loadAllUsageMessages())

export const loadSessionIds = async (): Promise<string[]> =>
  (await getChatStorageBackend()).loadSessionIds()

export const loadFileIds = async (): Promise<string[]> =>
  (await getChatStorageBackend()).loadFileIds()

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getChatStorageBackend()).loadSession(id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> =>
  (await getChatStorageBackend()).saveSession(session, files)

export const renameSession = async (id: string, title: string): Promise<void> =>
  (await getChatStorageBackend()).renameSession(id, title)

export const deleteSession = async (sessionId: string): Promise<void> =>
  (await getChatStorageBackend()).deleteSession(sessionId)

export const saveFiles = (files: StoredFile[]): Promise<void> =>
  getChatStorageBackend().then((backend) => backend.saveFiles(files))

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await getChatStorageBackend()).loadFile(id)

export const clearStaging = async (): Promise<void> =>
  (await getChatStorageBackend()).clearStaging()

export const addStagingSession = async (session: Session): Promise<void> =>
  (await getChatStorageBackend()).addStagingSession(session)

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  getChatStorageBackend().then((backend) => backend.saveStagingFiles(files))

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> =>
  (await getChatStorageBackend()).updateStagingFileTypes(types)

export const commitStaging = async (): Promise<SessionSummary[]> =>
  (await getChatStorageBackend()).commitStaging()

export const commitStagingMerge = async (): Promise<{ summaries: SessionSummary[]; skipped: number }> =>
  (await getChatStorageBackend()).commitStagingMerge()

/** 本地存储失败不打断对话：控制台留痕 + 底部横幅告知用户（E08 不静默丢数据） */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
  showStorageErrorBanner(error)
}
