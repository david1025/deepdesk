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


// ---------- Native DPAPI credential bridge and usage UI ----------
{
  const file = 'src/services/native.ts'
  await write(file, `type NativeResponse = { type: 'response'; requestId: string; success: boolean; data: unknown }

declare global {
  interface Window {
    chrome?: { webview?: { postMessage: (message: unknown) => void; addEventListener: (type: 'message', listener: (event: MessageEvent<NativeResponse>) => void) => void } }
  }
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let sequence = 0
let listening = false

export const nativeRequest = <T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
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

export const saveNativeApiKey = (apiKey: string) => nativeRequest<{ saved: boolean }>('settings.saveApiKey', { apiKey })
export const getNativeBalance = () => nativeRequest<{
  is_available: boolean
  balance_infos: Array<{ currency: 'CNY' | 'USD'; total_balance: string; granted_balance: string; topped_up_balance: string }>
}>('api.getBalance')
`)
}

{
  const file = 'src/components/settings/useApiKeyForm.ts'
  let s = await read(file)
  s = replaceOnce(s, "import { useTranslate } from '../../i18n/index.js'\n",
    "import { useTranslate } from '../../i18n/index.js'\nimport { saveNativeApiKey } from '../../services/native.js'\n", file)
  s = replaceOnce(s, "      await verifyApiKey(apiKey)\n      setApiKey(apiKey)",
    "      await verifyApiKey(apiKey)\n      try {\n        await saveNativeApiKey(apiKey)\n        setApiKey('DEEPDESK_NATIVE_CREDENTIAL')\n      } catch (error) {\n        if (error instanceof Error && error.message === 'Native Windows bridge is unavailable') {\n          setApiKey(apiKey)\n        } else {\n          throw error\n        }\n      }", file)
  await write(file, s)
}

{
  const file = 'src/components/chatInput/ChatInput.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "import styles from './ChatInput.module.css'\n",
    "import styles from './ChatInput.module.css'\nimport { SessionUsage } from '../usage/SessionUsage.js'\n", file)
  s = replaceOnce(s,
    "  return (\n    <div\n      className={clsx(styles.wrapper",
    "  return (\n    <>\n    <div\n      className={clsx(styles.wrapper", file)
  s = replaceOnce(s,
    "      {dragging ? <DragMask /> : null}\n    </div>",
    "      {dragging ? <DragMask /> : null}\n    </div>\n    <SessionUsage sessionId={sessionId} />\n    </>", file)
  await write(file, s)
}

{
  const file = 'src/components/sider/Sider.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "import styles from './Sider.module.css'\n",
    "import styles from './Sider.module.css'\nimport { AccountUsage } from '../usage/AccountUsage.js'\n", file)
  s = replaceOnce(s,
    "      <div className={styles.bottom}>\n        <button type=\"button\" className={styles.settings} onClick={() => openSettings('general')}>",
    "      <div className={styles.bottom}>\n        <button type=\"button\" className={styles.settings} onClick={() => openSettings('general')}>", file)
  s = replaceOnce(s,
    "        </button>\n      </div>\n      {deleting ? (",
    "        </button>\n        {!mobile ? <AccountUsage /> : null}\n      </div>\n      {deleting ? (", file)
  await write(file, s)
}

{
  const file = 'src/services/chat/db.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "import { toSessionSummary, type Session, type SessionSummary } from './types.js'",
    "import { toSessionSummary, type AssistantMessage, type Session, type SessionSummary } from './types.js'", file)
  s = replaceOnce(s,
    "export const loadSessionIds = async (): Promise<string[]> =>",
    "export const loadAllUsageMessages = async () => {\n  const sessions = await (await getDB()).getAll('sessions')\n  return sessions.flatMap((session) => session.messages.filter((message): message is AssistantMessage => message.role === 'assistant' && !!message.usage).map((message) => ({ model: message.model, usage: message.usage, completedAt: message.completedAt ?? message.createdAt })))\n}\n\nexport const loadSessionIds = async (): Promise<string[]> =>", file)
  await write(file, s)
}

{
  const file = 'src/components/usage/SessionUsage.tsx'
  await write(file, `import { useMemo } from 'react'
import { useChatStore } from '../../services/chat/store.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import styles from './Usage.module.css'

export const SessionUsage = ({ sessionId }: { sessionId: string | null }) => {
  const session = useChatStore((state) => sessionId ? state.sessionCache[sessionId] : undefined)
  const usage = useMemo(() => {
    const replies = (session?.messages ?? []).filter((message): message is AssistantMessage => message.role === 'assistant' && !!message.usage)
    return replies.reduce((total, message) => ({
      input: total.input + (message.usage?.input_tokens ?? 0),
      cacheCreate: total.cacheCreate + (message.usage?.cache_creation_input_tokens ?? 0),
      cacheRead: total.cacheRead + (message.usage?.cache_read_input_tokens ?? 0),
      output: total.output + (message.usage?.output_tokens ?? 0),
    }), { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 })
  }, [session])
  const total = usage.input + usage.cacheCreate + usage.cacheRead + usage.output
  if (!total) return null
  const cacheRate = usage.cacheRead + usage.cacheCreate + usage.input > 0
    ? Math.round(usage.cacheRead / (usage.cacheRead + usage.cacheCreate + usage.input) * 100)
    : 0
  return (
    <div className={styles.sessionUsage} title={"缓存读取 " + usage.cacheRead.toLocaleString() + " · 未缓存输入 " + (usage.input + usage.cacheCreate).toLocaleString() + " · 输出 " + usage.output.toLocaleString()}>
      <span>本会话</span>
      <span>{total.toLocaleString()} tok</span>
      <span>缓存命中 {cacheRate}%</span>
      <span>输出 {usage.output.toLocaleString()}</span>
    </div>
  )
}
`)
}

{
  const file = 'src/components/usage/AccountUsage.tsx'
  await write(file, `import { useEffect, useMemo, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { getNativeBalance } from '../../services/native.js'
import { loadAllUsageMessages } from '../../services/chat/db.js'
import styles from './Usage.module.css'

type Balance = Awaited<ReturnType<typeof getNativeBalance>>
type UsageRecord = Awaited<ReturnType<typeof loadAllUsageMessages>>[number]

const formatMoney = (value: number, currency: string) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 4 }).format(value)
const estimate = (records: UsageRecord[]) => records.reduce((sum, record) => {
  const pro = record.model === 'deepseek-v4-pro'
  const input = record.usage.input_tokens + record.usage.cache_creation_input_tokens
  const cache = record.usage.cache_read_input_tokens
  const output = record.usage.output_tokens
  // Peak-hour CNY list prices. Search/fetch, OCR, ASR and TTS are excluded.
  return sum + (input * (pro ? 9 : 2) + cache * (pro ? .3 : .04) + output * (pro ? 27 : 8)) / 1_000_000
}, 0)

export const AccountUsage = () => {
  const apiKey = useSettings((state) => state.apiKey)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    if (!apiKey || busy) return
    setBusy(true)
    setError('')
    try {
      const [nextBalance, nextRecords] = await Promise.all([getNativeBalance(), loadAllUsageMessages()])
      setBalance(nextBalance)
      setRecords(nextRecords)
      setUpdated(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (apiKey) void refresh()
  }, [apiKey])

  const stats = useMemo(() => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const today = records.filter((item) => item.completedAt >= todayStart)
    const month = records.filter((item) => item.completedAt >= monthStart)
    return {
      totalTokens: records.reduce((sum, item) => sum + item.usage.input_tokens + item.usage.cache_creation_input_tokens + item.usage.cache_read_input_tokens + item.usage.output_tokens, 0),
      todayCost: estimate(today),
      monthCost: estimate(month),
      count: records.length,
    }
  }, [records])

  const info = balance?.balance_infos?.[0]
  const currency = info?.currency ?? 'CNY'
  const amount = info ? Number(info.total_balance) : null

  return (
    <div className={styles.accountUsage} onMouseEnter={() => { setOpen(true); if (!balance && apiKey) void refresh() }} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={styles.balanceButton} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={styles.walletIcon}>◉</span>
        <span>{amount === null ? (apiKey ? '额度' : '配置 API') : formatMoney(amount, currency)}</span>
      </button>
      {open ? (
        <div className={styles.balancePopover} role="dialog" aria-label="API 账户用量">
          <div className={styles.popoverHeader}><strong>DeepSeek API 账户</strong><span>{balance?.is_available ? '可用' : balance ? '余额不足' : '未连接'}</span></div>
          {info ? <>
            <div className={styles.balanceAmount}>{formatMoney(Number(info.total_balance), currency)}</div>
            <div className={styles.balanceSplit}><span>充值余额</span><b>{formatMoney(Number(info.topped_up_balance), currency)}</b></div>
            <div className={styles.balanceSplit}><span>赠送余额</span><b>{formatMoney(Number(info.granted_balance), currency)}</b></div>
          </> : <p className={styles.balanceError}>{error || (apiKey ? '正在查询余额…' : '请先配置 API Key')}</p>}
          <div className={styles.popoverDivider} />
          <div className={styles.balanceSplit}><span>今日 Token 费用估算</span><b>{formatMoney(stats.todayCost, 'CNY')}</b></div>
          <div className={styles.balanceSplit}><span>本月 Token 费用估算</span><b>{formatMoney(stats.monthCost, 'CNY')}</b></div>
          <div className={styles.balanceSplit}><span>本机累计 Token</span><b>{stats.totalTokens.toLocaleString()}</b></div>
          <div className={styles.balanceSplit}><span>已统计回复</span><b>{stats.count}</b></div>
          <div className={styles.popoverFoot}>
            <small>{updated ? '更新于 ' + new Date(updated).toLocaleTimeString() : '余额为官方实时查询；费用为本机估算'}</small>
            <button type="button" disabled={busy || !apiKey} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
          </div>
          <small className={styles.estimateNote}>费用按当前公开高峰单价估算；不含联网搜索/抓取、文件解析及语音费用。其他设备的 API 消耗不会计入本机统计。</small>
        </div>
      ) : null}
    </div>
  )
}
`)
}

{
  const file = 'src/components/usage/Usage.module.css'
  await write(file, `.sessionUsage {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 14px;
  padding: 4px 10px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  user-select: none;
}
.accountUsage { position: relative; display: flex; align-items: center; margin: auto 0; }
.balanceButton {
  display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-specific-sidebar-fill);
  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.walletIcon { color: var(--dsw-alias-brand-text); }
.balancePopover {
  position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 8px); width: 286px;
  padding: 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 32px rgba(0,0,0,.14); font-size: 12px;
}
.popoverHeader,.balanceSplit,.popoverFoot { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.popoverHeader span { color: var(--dsw-alias-label-tertiary); }
.balanceAmount { margin: 10px 0 12px; font-size: 25px; font-weight: 650; font-variant-numeric: tabular-nums; }
.balanceSplit { padding: 5px 0; color: var(--dsw-alias-label-secondary); }
.balanceSplit b { color: var(--dsw-alias-label-primary); font-weight: 550; font-variant-numeric: tabular-nums; }
.popoverDivider { height:1px; margin: 9px 0; background: var(--dsw-alias-border-l1); }
.popoverFoot { margin-top: 10px; }
.popoverFoot small,.estimateNote { color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 1.5; }
.popoverFoot button { border:0; background:none; color:var(--dsw-alias-brand-text); cursor:pointer; }
.popoverFoot button:disabled { opacity:.5; cursor:default; }
.balanceError { color: var(--dsw-alias-state-error-primary); }
.estimateNote { display:block; margin-top:8px; }
`)
}
{
  const file = 'src/components/usage/Usage.module.css.d.ts'
  await write(file, `declare const styles: {
  readonly "sessionUsage": string;
  readonly "accountUsage": string;
  readonly "balanceButton": string;
  readonly "walletIcon": string;
  readonly "balancePopover": string;
  readonly "popoverHeader": string;
  readonly "balanceAmount": string;
  readonly "balanceSplit": string;
  readonly "popoverDivider": string;
  readonly "popoverFoot": string;
  readonly "balanceError": string;
  readonly "estimateNote": string;
}
export = styles
`)
}



{
  const file = 'src/components/sider/Sider.module.css'
  let s = await read(file)
  s = replaceOnce(s, "  width: 100%;\n  margin-block: auto;", "  width: auto;\n  flex: 1;\n  min-width: 0;\n  margin-block: auto;", file)
  await write(file, s)
}


// ---------- Model selection and reasoning effort ----------
{
  const file = 'src/services/api/types.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "export type ChatModel = 'deepseek-flash' | 'deepseek-v4-pro'",
    "export type ChatModel = 'deepseek-flash' | 'deepseek-v4-pro'\nexport type ReasoningEffort = 'none' | 'low' | 'high' | 'max'", file)
  s = replaceOnce(s,
    "  thinking: { type: 'enabled' | 'disabled' }\n  tools:",
    "  thinking?: { type: 'enabled' | 'disabled' }\n  output_config?: { effort: ReasoningEffort }\n  tools:", file)
  await write(file, s)
}

{
  const file = 'src/services/settings.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "import type { TtsVoice } from './api/speech.js'\n",
    "import type { TtsVoice } from './api/speech.js'\nimport type { ChatModel, ReasoningEffort } from './api/types.js'\n", file)
  s = replaceOnce(s,
    "  ttsVoice: TtsVoice\n  thinking: boolean",
    "  ttsVoice: TtsVoice\n  model: ChatModel\n  reasoningEffort: ReasoningEffort\n  thinking: boolean", file)
  s = replaceOnce(s,
    "  ttsVoice: 'chat-demo:tts-voice',\n  thinking:",
    "  ttsVoice: 'chat-demo:tts-voice',\n  model: 'deepdesk:model',\n  reasoningEffort: 'deepdesk:reasoning-effort',\n  thinking:", file)
  s = replaceOnce(s,
    "const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')",
    "const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')\n\nconst initialModel = (): ChatModel =>\n  read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'\n\nconst initialReasoningEffort = (): ReasoningEffort => {\n  const saved = read(KEYS.reasoningEffort)\n  if (saved === 'none' || saved === 'low' || saved === 'high' || saved === 'max') return saved\n  // Migrate an explicitly saved legacy DeepThink switch; a fresh install defaults to High.\n  return read(KEYS.thinking) === 'false' ? 'none' : 'high'\n}\n\nconst initialEffort = initialReasoningEffort()", file)
  s = replaceOnce(s,
    "  ttsVoice: initialTtsVoice(),\n  thinking: read(KEYS.thinking) === 'true',",
    "  ttsVoice: initialTtsVoice(),\n  model: initialModel(),\n  reasoningEffort: initialEffort,\n  thinking: initialEffort !== 'none',", file)
  s = replaceOnce(s,
    "export const setThinking = (thinking: boolean) => {\n  write(KEYS.thinking, String(thinking))\n  useSettings.setState({ thinking })\n}",
    "export const setModel = (model: ChatModel) => {\n  write(KEYS.model, model)\n  useSettings.setState({ model })\n}\n\nexport const setReasoningEffort = (reasoningEffort: ReasoningEffort) => {\n  write(KEYS.reasoningEffort, reasoningEffort)\n  write(KEYS.thinking, String(reasoningEffort !== 'none'))\n  useSettings.setState({ reasoningEffort, thinking: reasoningEffort !== 'none' })\n}\n\nexport const setThinking = (thinking: boolean) => setReasoningEffort(thinking ? 'high' : 'none')", file)
  await write(file, s)
}

{
  const file = 'src/services/chat/types.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  MessageUsage,\n  ServerToolBlock,",
    "  MessageUsage,\n  ReasoningEffort,\n  ServerToolBlock,", file)
  s = replaceOnce(s,
    "  /** 请求时是否开启深度思考 */\n  thinking?: boolean",
    "  /** 请求时的推理强度；旧历史记录可能没有该字段。 */\n  reasoningEffort?: ReasoningEffort\n  /** 请求时是否开启深度思考，保留用于兼容旧历史记录。 */\n  thinking?: boolean", file)
  await write(file, s)
}

{
  const file = 'src/services/chat/store.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "const createReply = (): AssistantMessage => {\n  const { thinking, search } = useSettings.getState()",
    "const createReply = (): AssistantMessage => {\n  const { model, reasoningEffort, search } = useSettings.getState()", file)
  s = replaceOnce(s,
    "    model: MODEL,\n    thinking,\n    search,",
    "    model,\n    reasoningEffort,\n    thinking: reasoningEffort !== 'none',\n    search,", file)
  s = replaceOnce(s,
    "  const { thinking, search } = useSettings.getState()\n  const reply: AssistantMessage = {",
    "  const { model, reasoningEffort, search } = useSettings.getState()\n  const legacyEffort = previous.thinking === false ? 'none' : previous.thinking === true ? 'high' : reasoningEffort\n  const reply: AssistantMessage = {", file)
  s = replaceOnce(s,
    "    model: previous.model ?? MODEL,\n    thinking: previous.thinking ?? thinking,",
    "    model: previous.model ?? model ?? MODEL,\n    reasoningEffort: previous.reasoningEffort ?? legacyEffort,\n    thinking: previous.thinking ?? (legacyEffort !== 'none'),", file)
  s = replaceOnce(s,
    "        const messages = toRequestMessages(\n          prepared.history,\n          prepared.question,\n          prepared.prefix,\n          initial.thinking ?? false,\n          latestReminder\n        )",
    "        const reasoningEffort = initial.reasoningEffort ?? (initial.thinking === false ? 'none' : initial.thinking === true ? 'high' : useSettings.getState().reasoningEffort)\n        const messages = toRequestMessages(\n          prepared.history,\n          prepared.question,\n          prepared.prefix,\n          reasoningEffort !== 'none',\n          latestReminder\n        )", file)
  s = replaceOnce(s,
    "            model: initial.model ?? MODEL,\n            system: SYSTEM_PROMPT,\n            messages,\n            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },",
    "            model: initial.model ?? useSettings.getState().model ?? MODEL,\n            system: SYSTEM_PROMPT,\n            messages,\n            output_config: { effort: reasoningEffort },", file)
  await write(file, s)
}

{
  const file = 'src/components/chatInput/ChatInput.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "  IconStopFill16,\n  IconThinkOutline14,\n",
    "  IconStopFill16,\n", file)
  s = replaceOnce(s,
    "import { setSearch, setThinking, useSettings } from '../../services/settings.js'",
    "import { setSearch, useSettings } from '../../services/settings.js'", file)
  s = replaceOnce(s,
    "import styles from './ChatInput.module.css'\n",
    "import styles from './ChatInput.module.css'\nimport { ModelSettings } from './ModelSettings.js'\n", file)
  s = replaceOnce(s,
    "  const thinking = useSettings((state) => state.thinking)\n", "", file)
  s = replaceOnce(s, "        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}\n        <div ref={togglesRef} className={styles.toggles}>\n          <Tooltip content={t('deactivatedThinkTooltip')}>\n            <button\n              type=\"button\"\n              className={clsx(styles.toggle, thinking && styles.selected)}\n              aria-label={t('thinkingSwitch')}\n              aria-pressed={thinking}\n              onClick={() => setThinking(!thinking)}\n            >\n              <IconThinkOutline14 />\n              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>\n            </button>\n          </Tooltip>\n          <Tooltip content={t('deactivatedSearchTooltip')}>", "        {/* 模型与推理等级选择；搜索仍保留独立开关 */}\n        <div ref={togglesRef} className={styles.toggles}>\n          <ModelSettings />\n          <Tooltip content={t('deactivatedSearchTooltip')}>", file)
  await write(file, s)
}

{
  const file = 'src/components/chatInput/ModelSettings.tsx'
  await write(file, "import { useState } from 'react'\nimport { createPortal } from 'react-dom'\nimport { useTranslate } from '../../i18n/index.js'\nimport type { ChatModel } from '../../services/api/types.js'\nimport { setModel, setReasoningEffort, useSettings, type ReasoningEffort } from '../../services/settings.js'\nimport { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'\nimport { useAnchoredPosition, useDismiss } from '../base/anchored.js'\nimport styles from './ModelSettings.module.css'\n\nconst modelOptions: { value: ChatModel; label: string }[] = [\n  { value: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },\n  { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },\n]\n\nconst effortLabels: Record<ReasoningEffort, 'settingsEffortOff' | 'settingsEffortLow' | 'settingsEffortHigh' | 'settingsEffortMax'> = {\n  none: 'settingsEffortOff',\n  low: 'settingsEffortLow',\n  high: 'settingsEffortHigh',\n  max: 'settingsEffortMax',\n}\n\nexport const ModelSettings = () => {\n  const t = useTranslate()\n  const model = useSettings((state) => state.model)\n  const reasoningEffort = useSettings((state) => state.reasoningEffort)\n  const [open, setOpen] = useState(false)\n  const [expanded, setExpanded] = useState<'model' | 'effort' | null>(null)\n  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(\n    open,\n    { side: 'top', align: 'start', offset: 8 }\n  )\n  useDismiss(open, [anchorRef, floatingRef], () => {\n    setOpen(false)\n    setExpanded(null)\n  }, { captureEscape: true })\n\n  const currentModel = modelOptions.find((option) => option.value === model)?.label ?? modelOptions[0].label\n  const currentEffort = t(effortLabels[reasoningEffort])\n\n  const chooseModel = (value: ChatModel) => {\n    setModel(value)\n    setExpanded(null)\n  }\n  const chooseEffort = (value: ReasoningEffort) => {\n    setReasoningEffort(value)\n    setExpanded(null)\n  }\n\n  return (\n    <>\n      <button\n        ref={anchorRef}\n        type=\"button\"\n        className={styles.trigger}\n        aria-haspopup=\"dialog\"\n        aria-expanded={open}\n        aria-label={t('modelSettingsTitle')}\n        title={currentModel + ' · ' + currentEffort}\n        onClick={() => {\n          setOpen((value) => !value)\n          setExpanded(null)\n        }}\n      >\n        <span className={styles.modelName}>{currentModel}</span>\n        <span className={styles.effortName}>{currentEffort}</span>\n        <IconChevronDownOutline14 />\n      </button>\n      {open\n        ? createPortal(\n            <div\n              ref={floatingRef}\n              className={styles.panel}\n              style={position ?? undefined}\n              role=\"dialog\"\n              aria-label={t('modelSettingsTitle')}\n            >\n              <div className={styles.row}>\n                <span className={styles.label}>{t('settingsModelLabel')}</span>\n                <button\n                  type=\"button\"\n                  className={styles.rowTrigger}\n                  aria-expanded={expanded === 'model'}\n                  onClick={() => setExpanded((value) => value === 'model' ? null : 'model')}\n                >\n                  <span>{currentModel}</span>\n                  <IconChevronDownOutline14 />\n                </button>\n              </div>\n              {expanded === 'model' ? (\n                <div className={styles.options} role=\"listbox\" aria-label={t('settingsModelLabel')}>\n                  {modelOptions.map((option) => (\n                    <button\n                      key={option.value}\n                      type=\"button\"\n                      role=\"option\"\n                      aria-selected={option.value === model}\n                      className={styles.option}\n                      onClick={() => chooseModel(option.value)}\n                    >\n                      <span>{option.label}</span>\n                      {option.value === model ? <IconCheckOutline16 /> : null}\n                    </button>\n                  ))}\n                </div>\n              ) : null}\n              <div className={styles.row}>\n                <span className={styles.label}>{t('settingsReasoningEffortLabel')}</span>\n                <button\n                  type=\"button\"\n                  className={styles.rowTrigger}\n                  aria-expanded={expanded === 'effort'}\n                  onClick={() => setExpanded((value) => value === 'effort' ? null : 'effort')}\n                >\n                  <span>{currentEffort}</span>\n                  <IconChevronDownOutline14 />\n                </button>\n              </div>\n              {expanded === 'effort' ? (\n                <div className={styles.options} role=\"listbox\" aria-label={t('settingsReasoningEffortLabel')}>\n                  {(['none', 'low', 'high', 'max'] as ReasoningEffort[]).map((option) => (\n                    <button\n                      key={option}\n                      type=\"button\"\n                      role=\"option\"\n                      aria-selected={option === reasoningEffort}\n                      className={styles.option}\n                      onClick={() => chooseEffort(option)}\n                    >\n                      <span>{t(effortLabels[option])}</span>\n                      {option === reasoningEffort ? <IconCheckOutline16 /> : null}\n                    </button>\n                  ))}\n                </div>\n              ) : null}\n              <p className={styles.hint}>\n                {t(model === 'deepseek-v4-pro' ? 'settingsModelProHint' : 'settingsModelFlashHint')}\n              </p>\n            </div>,\n            document.body\n          )\n        : null}\n    </>\n  )\n}\n")
}
{
  const file = 'src/components/chatInput/ModelSettings.module.css'
  await write(file, ".trigger {\n  display: inline-flex;\n  align-items: center;\n  flex-shrink: 0;\n  gap: 7px;\n  max-width: 240px;\n  height: 34px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 18px;\n  background: var(--dsw-specific-selector);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 18px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }\n.modelName { overflow: hidden; text-overflow: ellipsis; }\n.effortName { color: var(--dsw-alias-label-secondary); }\n.panel {\n  position: fixed;\n  z-index: 1100;\n  box-sizing: border-box;\n  width: 278px;\n  padding: 9px 10px;\n  border: 1px solid var(--dsw-alias-border-inverted);\n  border-radius: 14px;\n  background: var(--dsw-specific-menu);\n  color: var(--dsw-alias-label-primary);\n  box-shadow: 0 0 1px rgba(0,0,0,.2), 0 12px 32px rgba(0,0,0,.1);\n}\n.row {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  min-height: 40px;\n}\n.label {\n  flex-shrink: 0;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 13px;\n}\n.rowTrigger {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  width: 178px;\n  min-width: 0;\n  min-height: 34px;\n  padding: 0 9px;\n  border: 0;\n  border-radius: 9px;\n  background: var(--dsw-specific-selector);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n.rowTrigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.options {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  margin: 1px 0 5px 76px;\n  padding: 4px;\n  border-radius: 10px;\n  background: var(--dsw-specific-selector);\n}\n.option {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  min-height: 34px;\n  padding: 4px 8px;\n  border: 0;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  text-align: left;\n  cursor: pointer;\n}\n.option:hover, .option[aria-selected=\"true\"] { background: var(--dsw-alias-interactive-bg-hover); }\n.hint {\n  margin: 6px 2px 2px;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 10px;\n  line-height: 1.5;\n}\n")
}
{
  const file = 'src/components/chatInput/ModelSettings.module.css.d.ts'
  await write(file, "declare const styles: {\n  readonly \"trigger\": string;\n  readonly \"modelName\": string;\n  readonly \"effortName\": string;\n  readonly \"panel\": string;\n  readonly \"row\": string;\n  readonly \"label\": string;\n  readonly \"rowTrigger\": string;\n  readonly \"options\": string;\n  readonly \"option\": string;\n  readonly \"hint\": string;\n}\nexport = styles\n")
}

{
  const file = 'src/i18n/zh.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  settingsTtsVoice: '朗读音色',",
    "  modelSettingsTitle: '模型设置',\n  settingsModelLabel: '模型',\n  settingsReasoningEffortLabel: '推理等级',\n  settingsEffortOff: 'Off',\n  settingsEffortLow: 'Low',\n  settingsEffortHigh: 'High',\n  settingsEffortMax: 'Max',\n  settingsModelFlashHint: 'DeepSeek-V4.1-Flash 支持文本和图片输入。',\n  settingsModelProHint: 'DeepSeek-V4-Pro 当前仅支持文本输入。',\n  settingsTtsVoice: '朗读音色',", file)
  await write(file, s)
}
{
  const file = 'src/i18n/en.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  settingsTtsVoice: 'Read-aloud voice',",
    "  modelSettingsTitle: 'Model settings',\n  settingsModelLabel: 'Model',\n  settingsReasoningEffortLabel: 'Reasoning effort',\n  settingsEffortOff: 'Off',\n  settingsEffortLow: 'Low',\n  settingsEffortHigh: 'High',\n  settingsEffortMax: 'Max',\n  settingsModelFlashHint: 'DeepSeek-V4.1-Flash supports text and image input.',\n  settingsModelProHint: 'DeepSeek-V4-Pro currently supports text input only.',\n  settingsTtsVoice: 'Read-aloud voice',", file)
  await write(file, s)
}



// V4-Pro is text-only. Block local attachments before upload and guard already queued drafts.
{
  const file = 'src/components/chatInput/ChatInput.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "  const acceptFiles = (files: File[]) => {\n    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {\n      return\n    }",
    "  const acceptFiles = (files: File[]) => {\n    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {\n      return\n    }\n    if (useSettings.getState().model === 'deepseek-v4-pro') {\n      showToast({ key: 'modelProTextOnly', type: 'error' })\n      return\n    }", file)
  s = replaceOnce(s,
    "    if (\n      useChatStore.getState().importingHistory ||\n      voice.status !== 'idle' ||\n      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)\n    ) {\n      return\n    }",
    "    if (\n      useChatStore.getState().importingHistory ||\n      voice.status !== 'idle' ||\n      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)\n    ) {\n      return\n    }\n    if (useSettings.getState().model === 'deepseek-v4-pro' && attachments.length > 0) {\n      showToast({ key: 'modelProTextOnly', type: 'error' })\n      return\n    }", file)
  s = replaceOnce(s,
    "            disabled={importingHistory}\n            onClick={() => ensureApiKey() && fileInputRef.current?.click()}",
    "            disabled={importingHistory || useSettings.getState().model === 'deepseek-v4-pro'}\n            onClick={() => ensureApiKey() && fileInputRef.current?.click()}", file)
  await write(file, s)
}



{
  const file = 'src/i18n/zh.ts'
  let s = await read(file)
  s = replaceOnce(s, "  settingsModelProHint: 'DeepSeek-V4-Pro 当前仅支持文本输入。',",
    "  settingsModelProHint: 'DeepSeek-V4-Pro 当前仅支持文本输入。',\n  modelProTextOnly: 'DeepSeek-V4-Pro 当前仅支持文本输入，请切换 Flash 后上传文件。',", file)
  await write(file, s)
}
{
  const file = 'src/i18n/en.ts'
  let s = await read(file)
  s = replaceOnce(s, "  settingsModelProHint: 'DeepSeek-V4-Pro currently supports text input only.',",
    "  settingsModelProHint: 'DeepSeek-V4-Pro currently supports text input only.',\n  modelProTextOnly: 'DeepSeek-V4-Pro currently supports text input only. Switch to Flash to upload files.',", file)
  await write(file, s)
}

console.log('DeepDesk Chat Demo patches applied.')
