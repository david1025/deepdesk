import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'vendor/chat-demo')
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
const appendBefore = (source, marker, addition, file) => replaceOnce(source, marker, addition + marker, file)

// Safe merge import: never overwrite an existing session or file.
{
  const file = 'src/services/chat/db.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>\n  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)\n",
    "export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>\n  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)\n\nexport const loadSessionIds = async (): Promise<string[]> =>\n  (await (await getDB()).getAllKeys('sessions')) as string[]\n\nexport const loadFileIds = async (): Promise<string[]> =>\n  (await (await getDB()).getAllKeys('files')) as string[]\n\n", file)
  const marker = "/** 本地存储失败不打断对话，只在控制台留痕 */"
  const merge = `/**
 * Merge staging into the existing history. Existing session IDs are never overwritten.
 * File IDs are expected to have been remapped by the importer; a collision aborts the
 * whole transaction rather than replacing an existing attachment.
 */
export const commitStagingMerge = async (): Promise<{ summaries: SessionSummary[]; skipped: number }> => {
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
}

`
  s = appendBefore(s, marker, merge, file)
  await write(file, s)
}

{
  const file = 'src/services/chat/history/importArchive.ts'
  let s = await read(file)
  s = replaceOnce(s, "import * as db from '../db.js'\n", "import * as db from '../db.js'\nimport { createId } from '../../../utils/id.js'\n", file)
  s = replaceOnce(s, "export const importArchive = async (file: File): Promise<void> => {",
    "export const importArchive = async (file: File, mode: 'replace' | 'merge' = 'replace'): Promise<number> => {", file)
  s = replaceOnce(s, "  const imported = new Set<string>()\n  const images = new Map<string, string>()",
    "  const imported = new Set<string>()\n  const existingSessionIds = mode === 'merge' ? new Set(await db.loadSessionIds()) : new Set<string>()\n  const existingFileIds = mode === 'merge' ? new Set(await db.loadFileIds()) : new Set<string>()\n  const remappedFileIds = new Map<string, string>()\n  const images = new Map<string, string>()", file)
  s = replaceOnce(s, "  let currentSessionId: string | undefined\n",
    "  let currentSessionId: string | undefined\n  let skippedSessions = 0\n", file)
  const before = `        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        await db.addStagingSession(local.session)`
  const after = `        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        if (mode === 'merge' && existingSessionIds.has(sessionId)) {
          skippedSessions += 1
        } else {
          // Remap colliding local file IDs. Repeated references to one original ID share its new ID.
          for (const message of local.session.messages) {
            if (message.role !== 'user') continue
            for (const attachment of message.files) {
              const originalId = attachment.id
              let mappedId = remappedFileIds.get(originalId)
              if (!mappedId) {
                mappedId = originalId
                if (existingFileIds.has(mappedId)) {
                  do { mappedId = createId() } while (existingFileIds.has(mappedId))
                }
                remappedFileIds.set(originalId, mappedId)
                existingFileIds.add(mappedId)
              }
              attachment.id = mappedId
            }
          }
          for (const [imagePath, id] of local.images) {
            images.set(imagePath, remappedFileIds.get(id) ?? id)
          }
          await db.addStagingSession(local.session)
        }`
  s = replaceOnce(s, before, after, file)
  s = replaceOnce(s, "  await db.updateStagingFileTypes(stored)\n}",
    "  await db.updateStagingFileTypes(stored)\n  return skippedSessions\n}", file)
  await write(file, s)
}

{
  const file = 'src/services/chat/store.ts'
  let s = await read(file)
  const marker = "export const newChat = () => {"
  const merge = `/**
 * Merge imported sessions without clearing local chats, drafts, or the active conversation.
 * Ongoing replies are allowed to finish; the import lock prevents new edits during commit.
 */
export const mergeHistory = async (write: () => Promise<number>): Promise<{ imported: number; skipped: number }> => {
  if (get().importingHistory) {
    throw new Error('History import is already in progress')
  }
  set({ importingHistory: true })
  try {
    await Promise.all(deletionTasks)
    await waitForIdle()
    await db.clearStaging()
    let skippedFromArchive = 0
    let committed: Awaited<ReturnType<typeof db.commitStagingMerge>>
    try {
      skippedFromArchive = await write()
      committed = await db.commitStagingMerge()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history merge'))
      throw error
    }
    const addedIds = new Set(committed.summaries.map((item) => item.id))
    set((state) => ({
      sessions: sortSessions([
        ...state.sessions.filter((item) => !addedIds.has(item.id)),
        ...committed.summaries,
      ]),
    }))
    return {
      imported: committed.summaries.length,
      skipped: skippedFromArchive + committed.skipped,
    }
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

`
  s = appendBefore(s, marker, merge, file)
  await write(file, s)
}

{
  const file = 'src/services/chat/backup.ts'
  let s = await read(file)
  s = replaceOnce(s, "import { replaceHistory, useChatStore } from './store.js'",
    "import { mergeHistory, replaceHistory, useChatStore } from './store.js'", file)
  const before = `/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory(() => importArchive(file))
  })`
  const after = `/**
 * Import DeepSeek ZIP history. Merge is the safe default; replace is an explicit option.
 */
export const importHistory = (
  file: File,
  mode: 'merge' | 'replace' = 'merge'
): Promise<{ imported: number; skipped: number }> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    if (mode === 'merge') {
      return mergeHistory(() => importArchive(file, 'merge'))
    }
    const imported = await replaceHistory(async () => {
      await importArchive(file, 'replace')
    })
    return { imported, skipped: 0 }
  })`
  s = replaceOnce(s, before, after, file)
  await write(file, s)
}

// UI: merge is selected by default; replace requires explicit selection.
{
  const file = 'src/components/settings/SettingsDialog.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "  const [status, setStatus] = useState<Status>(null)\n  const importing = useRef(false)\n\n  const confirm = async () => {",
    "  const [status, setStatus] = useState<Status>(null)\n  const [mode, setMode] = useState<'merge' | 'replace'>('merge')\n  const importing = useRef(false)\n\n  const confirm = async () => {", file)
  s = replaceOnce(s,
    "      const count = await importHistory(file)\n      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })",
    "      const result = await importHistory(file, mode)\n      setStatus({ key: 'historyImportSummary', params: { imported: result.imported, skipped: result.skipped } })", file)
  s = replaceOnce(s,
    "  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }\n}",
    "  return { file, busy, status, mode, setMode, select: setFile, cancel: () => setFile(null), confirm }\n}", file)
  const before = `      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>`
  const after = `      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={historyImport.mode === 'replace' ? 'dangerOutlined' : 'outlined'}
            size="m"
            onClick={() => void historyImport.confirm()}
          >
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', cursor: 'pointer' }}>
          <input type="radio" name="deepdesk-import-mode" checked={historyImport.mode === 'merge'} onChange={() => historyImport.setMode('merge')} />
          <span><strong>{t('historyImportModeMerge')}</strong><br />{t('historyImportMergeDescription')}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', cursor: 'pointer' }}>
          <input type="radio" name="deepdesk-import-mode" checked={historyImport.mode === 'replace'} onChange={() => historyImport.setMode('replace')} />
          <span><strong>{t('historyImportModeReplace')}</strong><br />{t('historyImportReplaceDescription')}</span>
        </label>
      </div>`
  s = replaceOnce(s, before, after, file)
  await write(file, s)
}

{
  const file = 'src/i18n/zh.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  historyImportConfirmDescription: '上传的历史对话会覆盖当前所有对话记录，是否确认导入？',\n  historyImportDescription: '导入历史对话会覆盖全部本地对话和附件，支持 DeepSeek 导出的 ZIP 文件。',",
    "  historyImportConfirmDescription: '请选择导入方式。合并导入不会删除本地对话；覆盖导入会替换全部本地历史。',\n  historyImportDescription: '支持 DeepSeek 网页版导出的 ZIP。默认合并导入，只添加本地不存在的会话。',\n  historyImportModeMerge: '合并导入（推荐）',\n  historyImportMergeDescription: '保留本地对话，只添加尚不存在的会话；重复会话自动跳过。',\n  historyImportModeReplace: '覆盖导入',\n  historyImportReplaceDescription: '用 ZIP 中的历史替换全部本地对话和附件，此操作不可撤销。',\n  historyImportSummary: '导入完成：新增 {imported} 个会话，跳过 {skipped} 个重复会话。',", file)
  await write(file, s)
}
{
  const file = 'src/i18n/en.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  historyImportConfirmDescription:\n    'The uploaded chat history will replace all your current chats. Import anyway?',\n  historyImportDescription:\n    'Importing chat history replaces all local chats and attachments. Supports ZIP files exported from DeepSeek.',",
    "  historyImportConfirmDescription:\n    'Choose how to import. Merge keeps local chats; replace removes the current local history.',\n  historyImportDescription:\n    'Supports ZIP files exported from DeepSeek. Merge is the default and only adds chats not already stored locally.',\n  historyImportModeMerge: 'Merge (recommended)',\n  historyImportMergeDescription: 'Keep local chats and add only missing sessions. Duplicate session IDs are skipped.',\n  historyImportModeReplace: 'Replace all local history',\n  historyImportReplaceDescription: 'Replace all local chats and attachments with the ZIP contents. This cannot be undone.',\n  historyImportSummary: 'Import complete: added {imported} chats and skipped {skipped} duplicates.',", file)
  await write(file, s)
}

// Usage completion timestamp, derived from the real stream lifecycle.
{
  const file = 'src/services/chat/types.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  /** 最近一次请求的用量，续写后更新 */\n  usage?: MessageUsage",
    "  /** 最近一次请求的用量，续写后更新 */\n  usage?: MessageUsage\n  /** 回复结束时间，用于本地估算输出速度；旧历史记录可能没有该字段。 */\n  completedAt?: number", file)
  await write(file, s)
}
{
  const file = 'src/services/chat/reply.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  ...reply,\n  status,\n  error,\n  blocks: reply.blocks.flatMap",
    "  ...reply,\n  status,\n  error,\n  completedAt: now,\n  blocks: reply.blocks.flatMap", file)
  await write(file, s)
}

console.log('DeepDesk Chat Demo patches applied.')
