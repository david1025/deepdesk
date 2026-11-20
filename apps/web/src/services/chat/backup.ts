import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { mergeHistory, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/** 导出 v4 完整备份：全部会话原始消息树 + 全部附件原件 + 本地偏好（不含 API Key）。 */
export const exportFullBackup = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        yield { ...session, ...summary }
      }
    }
    const { exportArchiveV4 } = await import('./history/archiveV4.js')
    const now = new Date()
    const blob = await exportArchiveV4(readSessions())
    return { name: backupFileName(now).replace('deepseek_data', 'deepseek_full_backup'), blob }
  })

/**
 * Import DeepSeek ZIP history. Merge is the safe default; replace is an explicit option.
 */
export const importHistory = (
  file: File,
  mode: 'merge' | 'replace' = 'merge'
): Promise<{ imported: number; skipped: number }> =>
  enqueueBackup(async () => {
    // v4 完整备份与 v3 历史导出共用一个入口，按 manifest 版本分流
    const { sniffArchiveVersion, importArchiveV4 } = await import('./history/archiveV4.js')
    if ((await sniffArchiveVersion(file)) === 4) {
      if (mode === 'merge') {
        return mergeHistory(() => importArchiveV4(file, 'merge'))
      }
      const imported = await replaceHistory(async () => {
        await importArchiveV4(file, 'replace')
      })
      return { imported, skipped: 0 }
    }
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    if (mode === 'merge') {
      return mergeHistory(() => importArchive(file, 'merge'))
    }
    const imported = await replaceHistory(async () => {
      await importArchive(file, 'replace')
    })
    return { imported, skipped: 0 }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
