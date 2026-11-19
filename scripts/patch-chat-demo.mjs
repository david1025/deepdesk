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
    "      try {\n        // On Windows the host verifies the supplied key directly, avoiding the old-key header injector.\n        await saveNativeApiKey(apiKey)\n        setApiKey('DEEPDESK_NATIVE_CREDENTIAL')\n      } catch (error) {\n        if (error instanceof Error && error.message === 'Native Windows bridge is unavailable') {\n          // Browser-only development fallback; the Windows host never stores the key in renderer storage.\n          await verifyApiKey(apiKey)\n          setApiKey(apiKey)\n        } else {\n          throw error\n        }\n      }", file)
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
  await write(file, "import { useMemo, useState } from 'react'\nimport { useChatStore } from '../../services/chat/store.js'\nimport type { AssistantMessage } from '../../services/chat/types.js'\nimport styles from './Usage.module.css'\n\nconst format = (value: number) => value.toLocaleString('en-US')\n\nconst UsageMetric = ({\n  id,\n  label,\n  active,\n  onActive,\n  children,\n}: {\n  id: string\n  label: string\n  active: boolean\n  onActive: (id: string | null) => void\n  children: React.ReactNode\n}) => (\n  <div className={styles.metric} onMouseEnter={() => onActive(id)} onMouseLeave={() => onActive(null)}>\n    <button\n      type=\"button\"\n      className={styles.metricButton}\n      aria-expanded={active}\n      onFocus={() => onActive(id)}\n      onBlur={() => onActive(null)}\n      onClick={() => onActive(active ? null : id)}\n    >\n      {label}\n    </button>\n    {active ? <div className={styles.metricPopover} role=\"tooltip\">{children}</div> : null}\n  </div>\n)\n\nconst Detail = ({ label, value }: { label: string; value: string }) => (\n  <div className={styles.metricDetail}>\n    <span>{label}</span>\n    <strong>{value}</strong>\n  </div>\n)\n\nexport const SessionUsage = ({ sessionId }: { sessionId: string | null }) => {\n  const session = useChatStore((state) => sessionId ? state.sessionCache[sessionId] : undefined)\n  const [activeMetric, setActiveMetric] = useState<string | null>(null)\n  const usage = useMemo(() => {\n    const replies = (session?.messages ?? []).filter(\n      (message): message is AssistantMessage & { usage: NonNullable<AssistantMessage['usage']> } =>\n        message.role === 'assistant' && !!message.usage\n    )\n    return {\n      replies: replies.length,\n      ...replies.reduce((total, message) => ({\n        input: total.input + message.usage.input_tokens,\n        cacheCreate: total.cacheCreate + message.usage.cache_creation_input_tokens,\n        cacheRead: total.cacheRead + message.usage.cache_read_input_tokens,\n        output: total.output + message.usage.output_tokens,\n      }), { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }),\n    }\n  }, [session])\n\n  if (!sessionId) return null\n\n  const inputTotal = usage.input + usage.cacheCreate + usage.cacheRead\n  const total = inputTotal + usage.output\n  const cacheRate = inputTotal > 0 ? Math.round(usage.cacheRead / inputTotal * 100) : 0\n\n  return (\n    <div className={styles.sessionUsage}>\n      <UsageMetric id=\"total\" label={'本会话　' + format(total) + ' tok'} active={activeMetric === 'total'} onActive={setActiveMetric}>\n        <strong className={styles.metricTitle}>本会话 Token 用量</strong>\n        <Detail label=\"未缓存输入\" value={format(usage.input) + ' tok'} />\n        <Detail label=\"缓存写入\" value={format(usage.cacheCreate) + ' tok'} />\n        <Detail label=\"缓存读取\" value={format(usage.cacheRead) + ' tok'} />\n        <Detail label=\"输出\" value={format(usage.output) + ' tok'} />\n        <Detail label=\"完成回复\" value={String(usage.replies)} />\n      </UsageMetric>\n      <UsageMetric id=\"cache\" label={'缓存命中　' + cacheRate + '%'} active={activeMetric === 'cache'} onActive={setActiveMetric}>\n        <strong className={styles.metricTitle}>上下文缓存</strong>\n        <Detail label=\"缓存命中率\" value={cacheRate + '%'} />\n        <Detail label=\"缓存读取\" value={format(usage.cacheRead) + ' tok'} />\n        <Detail label=\"缓存写入\" value={format(usage.cacheCreate) + ' tok'} />\n        <Detail label=\"未缓存输入\" value={format(usage.input) + ' tok'} />\n      </UsageMetric>\n      <UsageMetric id=\"output\" label={'输出　' + format(usage.output)} active={activeMetric === 'output'} onActive={setActiveMetric}>\n        <strong className={styles.metricTitle}>输出 Token</strong>\n        <Detail label=\"累计输出\" value={format(usage.output) + ' tok'} />\n        <Detail label=\"完成回复\" value={String(usage.replies)} />\n      </UsageMetric>\n    </div>\n  )\n}\n")
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
  await write(file, ".sessionUsage {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-wrap: wrap;\n  gap: 16px;\n  padding: 5px 10px 0;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 18px;\n  user-select: none;\n}\n.metric { position: relative; display: inline-flex; align-items: center; }\n.metricButton {\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.metricButton:hover, .metricButton:focus-visible { color: var(--dsw-alias-label-primary); outline: none; }\n.metricPopover {\n  position: absolute;\n  z-index: 1200;\n  left: 50%;\n  bottom: calc(100% + 9px);\n  transform: translateX(-50%);\n  width: max-content;\n  min-width: 218px;\n  max-width: min(280px, calc(100vw - 24px));\n  box-sizing: border-box;\n  padding: 12px 13px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-3);\n  color: var(--dsw-alias-label-primary);\n  box-shadow: 0 6px 24px rgba(0,0,0,.12);\n  font-size: 12px;\n  line-height: 18px;\n  user-select: text;\n}\n.metricTitle { display: block; margin-bottom: 7px; font-weight: 600; }\n.metricDetail { display: flex; justify-content: space-between; gap: 18px; padding: 3px 0; color: var(--dsw-alias-label-secondary); }\n.metricDetail strong { color: var(--dsw-alias-label-primary); font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.accountUsage { position: relative; display: flex; align-items: center; margin: auto 0; }\n.balanceButton {\n  display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px;\n  color: var(--dsw-alias-label-primary); background: var(--dsw-specific-sidebar-fill);\n  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;\n}\n.walletIcon { color: var(--dsw-alias-brand-text); }\n.balancePopover {\n  position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 8px); width: 286px;\n  padding: 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;\n  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);\n  box-shadow: 0 8px 32px rgba(0,0,0,.14); font-size: 12px;\n}\n.popoverHeader,.balanceSplit,.popoverFoot { display:flex; align-items:center; justify-content:space-between; gap:10px; }\n.popoverHeader span { color: var(--dsw-alias-label-tertiary); }\n.balanceAmount { margin: 10px 0 12px; font-size: 25px; font-weight: 650; font-variant-numeric: tabular-nums; }\n.balanceSplit { padding: 5px 0; color: var(--dsw-alias-label-secondary); }\n.balanceSplit b { color: var(--dsw-alias-label-primary); font-weight: 550; font-variant-numeric: tabular-nums; }\n.popoverDivider { height:1px; margin: 9px 0; background: var(--dsw-alias-border-l1); }\n.popoverFoot { margin-top: 10px; }\n.popoverFoot small,.estimateNote { color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 1.5; }\n.popoverFoot button { border:0; background:none; color:var(--dsw-alias-brand-text); cursor:pointer; }\n.popoverFoot button:disabled { opacity:.5; cursor:default; }\n.balanceError { color: var(--dsw-alias-state-error-primary); }\n.estimateNote { display:block; margin-top:8px; }\n")
}
{
  const file = 'src/components/usage/Usage.module.css.d.ts'
  await write(file, "declare const styles: {\n  readonly \"sessionUsage\": string;\n  readonly \"metric\": string;\n  readonly \"metricButton\": string;\n  readonly \"metricPopover\": string;\n  readonly \"metricTitle\": string;\n  readonly \"metricDetail\": string;\n  readonly \"accountUsage\": string;\n  readonly \"balanceButton\": string;\n  readonly \"walletIcon\": string;\n  readonly \"balancePopover\": string;\n  readonly \"popoverHeader\": string;\n  readonly \"balanceAmount\": string;\n  readonly \"balanceSplit\": string;\n  readonly \"popoverDivider\": string;\n  readonly \"popoverFoot\": string;\n  readonly \"balanceError\": string;\n  readonly \"estimateNote\": string;\n}\nexport = styles\n")
}


// ---------- Final compact selector and real token-detail popovers ----------
{
  await write('src/components/chatInput/ModelSettings.tsx', "import { useState } from 'react'\nimport { createPortal } from 'react-dom'\nimport { useTranslate } from '../../i18n/index.js'\nimport type { ChatModel, ReasoningEffort } from '../../services/api/types.js'\nimport { setModel, setReasoningEffort, useSettings } from '../../services/settings.js'\nimport { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'\nimport { useAnchoredPosition, useDismiss } from '../base/anchored.js'\nimport styles from './ModelSettings.module.css'\n\nconst models: { value: ChatModel; label: string }[] = [\n  { value: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },\n  { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },\n]\nconst efforts: { value: ReasoningEffort; label: string }[] = [\n  { value: 'none', label: 'Off' }, { value: 'low', label: 'Low' },\n  { value: 'high', label: 'High' }, { value: 'max', label: 'Max' },\n]\nexport const ModelSettings = () => {\n  const t = useTranslate()\n  const model = useSettings((state) => state.model)\n  const effort = useSettings((state) => state.reasoningEffort)\n  const [open, setOpen] = useState(false)\n  const [expanded, setExpanded] = useState<'model' | 'effort' | null>(null)\n  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(\n    open, { side: 'top', align: 'start', offset: 8 }\n  )\n  useDismiss(open, [anchorRef, floatingRef], () => { setOpen(false); setExpanded(null) }, { captureEscape: true })\n  const modelName = models.find((item) => item.value === model)?.label ?? models[0].label\n  const effortName = efforts.find((item) => item.value === effort)?.label ?? 'High'\n  return <>\n    <button ref={anchorRef} type=\"button\" className={styles.trigger} aria-haspopup=\"dialog\"\n      aria-expanded={open} aria-label={t('modelSettingsTitle')} title={modelName + ' · ' + effortName}\n      onClick={() => { setOpen((value) => !value); setExpanded(null) }}>\n      <span className={styles.modelName}>{modelName}</span><span className={styles.effortName}>{effortName}</span><IconChevronDownOutline14 />\n    </button>\n    {open ? createPortal(\n      <div ref={floatingRef} className={styles.panel} style={position ?? undefined} role=\"dialog\" aria-label={t('modelSettingsTitle')}>\n        <div className={styles.row}>\n          <span className={styles.label}>{t('settingsModelLabel')}</span>\n          <button type=\"button\" className={styles.rowTrigger} aria-expanded={expanded === 'model'}\n            onClick={() => setExpanded((v) => v === 'model' ? null : 'model')}>\n            <span>{modelName}</span><IconChevronDownOutline14 />\n          </button>\n        </div>\n        {expanded === 'model' ? <div className={styles.options} role=\"listbox\" aria-label={t('settingsModelLabel')}>\n          {models.map((item) => <button key={item.value} type=\"button\" role=\"option\" aria-selected={item.value === model}\n            className={styles.option} onClick={() => { setModel(item.value); setExpanded(null) }}>\n            <span>{item.label}</span>{item.value === model ? <IconCheckOutline16 /> : null}\n          </button>)}\n        </div> : null}\n        <div className={styles.row}>\n          <span className={styles.label}>{t('settingsReasoningEffortLabel')}</span>\n          <button type=\"button\" className={styles.rowTrigger} aria-expanded={expanded === 'effort'}\n            onClick={() => setExpanded((v) => v === 'effort' ? null : 'effort')}>\n            <span>{effortName}</span><IconChevronDownOutline14 />\n          </button>\n        </div>\n        {expanded === 'effort' ? <div className={styles.options} role=\"listbox\" aria-label={t('settingsReasoningEffortLabel')}>\n          {efforts.map((item) => <button key={item.value} type=\"button\" role=\"option\" aria-selected={item.value === effort}\n            className={styles.option} onClick={() => { setReasoningEffort(item.value); setExpanded(null) }}>\n            <span>{item.label}</span>{item.value === effort ? <IconCheckOutline16 /> : null}\n          </button>)}\n        </div> : null}\n      </div>, document.body) : null}\n  </>\n}\n")
  await write('src/components/chatInput/ModelSettings.module.css', ".trigger { display:inline-flex; align-items:center; flex-shrink:0; gap:7px; max-width:300px; height:34px; padding:0 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:18px; background:var(--dsw-specific-selector); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:18px; cursor:pointer; white-space:nowrap; }\n.trigger:hover { background:var(--dsw-alias-interactive-bg-hover); }\n.modelName { overflow:hidden; text-overflow:ellipsis; }\n.effortName { color:var(--dsw-alias-label-secondary); }\n.panel { position:fixed; z-index:1100; box-sizing:border-box; width:300px; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:14px; background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); box-shadow:0 6px 24px rgba(0,0,0,.12); }\n.row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:42px; }\n.label { flex-shrink:0; color:var(--dsw-alias-label-secondary); font-size:13px; }\n.rowTrigger { display:flex; align-items:center; justify-content:space-between; gap:8px; width:204px; min-width:0; min-height:38px; padding:0 10px; border:0; border-radius:10px; background:var(--dsw-specific-selector); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; }\n.rowTrigger span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.rowTrigger:hover,.rowTrigger[aria-expanded=\"true\"] { background:var(--dsw-alias-interactive-bg-hover); }\n.options { display:flex; flex-direction:column; gap:2px; margin:2px 0 7px 82px; padding:5px; border-radius:10px; background:var(--dsw-specific-selector); }\n.option { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:35px; padding:4px 9px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; text-align:left; cursor:pointer; }\n.option:hover,.option[aria-selected=\"true\"] { background:var(--dsw-alias-interactive-bg-hover); }\n")
  await write('src/components/chatInput/ModelSettings.module.css.d.ts', "declare const styles: { readonly \"trigger\": string; readonly \"modelName\": string; readonly \"effortName\": string; readonly \"panel\": string; readonly \"row\": string; readonly \"label\": string; readonly \"rowTrigger\": string; readonly \"options\": string; readonly \"option\": string; }\nexport = styles\n")
  await write('src/components/usage/SessionUsage.tsx', "import { useMemo, useState, type ReactNode } from 'react'\nimport { useChatStore } from '../../services/chat/store.js'\nimport type { AssistantMessage } from '../../services/chat/types.js'\nimport styles from './Usage.module.css'\nconst fmt = (n: number) => n.toLocaleString('en-US')\nconst Metric = ({ id, label, active, setActive, children }: { id: string; label: string; active: boolean; setActive: (id: string | null) => void; children: ReactNode }) => (\n  <div className={styles.metric} onMouseEnter={() => setActive(id)} onMouseLeave={() => setActive(null)}>\n    <button type=\"button\" className={styles.metricButton} aria-expanded={active}\n      onFocus={() => setActive(id)} onBlur={() => setActive(null)} onClick={() => setActive(active ? null : id)}>{label}</button>\n    {active ? <div className={styles.metricPopover} role=\"tooltip\">{children}</div> : null}\n  </div>\n)\nconst Detail = ({ label, value }: { label: string; value: string }) => <div className={styles.metricDetail}><span>{label}</span><strong>{value}</strong></div>\nexport const SessionUsage = ({ sessionId }: { sessionId: string | null }) => {\n  const session = useChatStore((state) => sessionId ? state.sessionCache[sessionId] : undefined)\n  const [active, setActive] = useState<string | null>(null)\n  const usage = useMemo(() => {\n    const replies = (session?.messages ?? []).filter((m): m is AssistantMessage & { usage: NonNullable<AssistantMessage['usage']> } => m.role === 'assistant' && !!m.usage)\n    return { replies: replies.length, ...replies.reduce((a,m) => ({\n      input:a.input+m.usage.input_tokens, create:a.create+m.usage.cache_creation_input_tokens,\n      cache:a.cache+m.usage.cache_read_input_tokens, output:a.output+m.usage.output_tokens\n    }), {input:0,create:0,cache:0,output:0}) }\n  }, [session])\n  if (!sessionId) return null\n  const input = usage.input + usage.create + usage.cache\n  const total = input + usage.output\n  const hit = input ? Math.round(usage.cache / input * 100) : 0\n  return <div className={styles.sessionUsage}>\n    <Metric id=\"total\" label={'本会话　' + fmt(total) + ' tok'} active={active === 'total'} setActive={setActive}>\n      <strong className={styles.metricTitle}>本会话 Token 用量</strong>\n      <Detail label=\"未缓存输入\" value={fmt(usage.input)+' tok'} /><Detail label=\"缓存写入\" value={fmt(usage.create)+' tok'} />\n      <Detail label=\"缓存读取\" value={fmt(usage.cache)+' tok'} /><Detail label=\"输出\" value={fmt(usage.output)+' tok'} />\n      <Detail label=\"完成回复\" value={String(usage.replies)} />\n    </Metric>\n    <Metric id=\"cache\" label={'缓存命中　' + hit + '%'} active={active === 'cache'} setActive={setActive}>\n      <strong className={styles.metricTitle}>上下文缓存</strong>\n      <Detail label=\"缓存命中率\" value={hit+'%'} /><Detail label=\"缓存读取\" value={fmt(usage.cache)+' tok'} />\n      <Detail label=\"缓存写入\" value={fmt(usage.create)+' tok'} /><Detail label=\"未缓存输入\" value={fmt(usage.input)+' tok'} />\n    </Metric>\n    <Metric id=\"output\" label={'输出　' + fmt(usage.output)} active={active === 'output'} setActive={setActive}>\n      <strong className={styles.metricTitle}>输出 Token</strong><Detail label=\"累计输出\" value={fmt(usage.output)+' tok'} />\n      <Detail label=\"完成回复\" value={String(usage.replies)} />\n    </Metric>\n  </div>\n}\n")
  await write('src/components/usage/Usage.module.css', ".sessionUsage { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:16px; padding:5px 10px 0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; user-select:none; }\n.metric { position:relative; display:inline-flex; align-items:center; }\n.metricButton { padding:0; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; white-space:nowrap; }\n.metricButton:hover,.metricButton:focus-visible { color:var(--dsw-alias-label-primary); outline:none; }\n.metricPopover { position:absolute; z-index:1200; left:50%; bottom:calc(100% + 9px); transform:translateX(-50%); width:max-content; min-width:218px; max-width:min(280px,calc(100vw - 24px)); box-sizing:border-box; padding:12px 13px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); box-shadow:0 6px 24px rgba(0,0,0,.12); font-size:12px; line-height:18px; user-select:text; }\n.metricTitle { display:block; margin-bottom:7px; font-weight:600; }\n.metricDetail { display:flex; justify-content:space-between; gap:18px; padding:3px 0; color:var(--dsw-alias-label-secondary); }\n.metricDetail strong { color:var(--dsw-alias-label-primary); font-weight:500; font-variant-numeric:tabular-nums; white-space:nowrap; }\n.accountUsage { position:relative; display:flex; align-items:center; margin:auto 0; }\n.balanceButton { display:flex; align-items:center; gap:7px; min-height:34px; padding:0 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:18px; color:var(--dsw-alias-label-primary); background:var(--dsw-specific-sidebar-fill); font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }\n.walletIcon { color:var(--dsw-alias-brand-text); }\n.balancePopover { position:absolute; z-index:1000; left:0; bottom:calc(100% + 8px); width:286px; padding:14px; border:1px solid var(--dsw-alias-border-l2); border-radius:14px; background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); box-shadow:0 8px 32px rgba(0,0,0,.14); font-size:12px; }\n.popoverHeader,.balanceSplit,.popoverFoot { display:flex; align-items:center; justify-content:space-between; gap:10px; }\n.popoverHeader span { color:var(--dsw-alias-label-tertiary); }\n.balanceAmount { margin:10px 0 12px; font-size:25px; font-weight:650; font-variant-numeric:tabular-nums; }\n.balanceSplit { padding:5px 0; color:var(--dsw-alias-label-secondary); }\n.balanceSplit b { color:var(--dsw-alias-label-primary); font-weight:550; font-variant-numeric:tabular-nums; }\n.popoverDivider { height:1px; margin:9px 0; background:var(--dsw-alias-border-l1); }\n.popoverFoot { margin-top:10px; }\n.popoverFoot small,.estimateNote { color:var(--dsw-alias-label-tertiary); font-size:10px; line-height:1.5; }\n.popoverFoot button { border:0; background:none; color:var(--dsw-alias-brand-text); cursor:pointer; }\n.popoverFoot button:disabled { opacity:.5; cursor:default; }\n.balanceError { color:var(--dsw-alias-state-error-primary); }\n.estimateNote { display:block; margin-top:8px; }\n")
  await write('src/components/usage/Usage.module.css.d.ts', "declare const styles: { readonly \"sessionUsage\": string; readonly \"metric\": string; readonly \"metricButton\": string; readonly \"metricPopover\": string; readonly \"metricTitle\": string; readonly \"metricDetail\": string; readonly \"accountUsage\": string; readonly \"balanceButton\": string; readonly \"walletIcon\": string; readonly \"balancePopover\": string; readonly \"popoverHeader\": string; readonly \"balanceAmount\": string; readonly \"balanceSplit\": string; readonly \"popoverDivider\": string; readonly \"popoverFoot\": string; readonly \"balanceError\": string; readonly \"estimateNote\": string; }\nexport = styles\n")
}
// ---------- Tighten persisted usage record type and API effort precedence ----------
{
  const file = 'src/services/chat/db.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "message is AssistantMessage => message.role === 'assistant' && !!message.usage",
    "message is AssistantMessage & { usage: NonNullable<AssistantMessage['usage']> } => message.role === 'assistant' && !!message.usage", file)
  await write(file, s)
}
{
  const file = 'src/components/usage/AccountUsage.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "type UsageRecord = Awaited<ReturnType<typeof loadAllUsageMessages>>[number]",
    "type UsageRecord = Omit<Awaited<ReturnType<typeof loadAllUsageMessages>>[number], 'usage'> & { usage: NonNullable<Awaited<ReturnType<typeof loadAllUsageMessages>>[number]['usage']> }", file)
  await write(file, s)
}


// ---------- Restore the original thinking switch; add optional professional model controls ----------
{
  const file = 'src/services/api/types.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "export type ChatModel = 'deepseek-flash' | 'deepseek-v4-pro'",
    "export type ChatModel = 'deepseek-flash' | 'deepseek-v4-pro'\n\nexport type ReasoningEffort = 'none' | 'low' | 'high' | 'max'", file)
  s = replaceOnce(s,
    "  thinking: { type: 'enabled' | 'disabled' }\n  tools:",
    "  thinking?: { type: 'enabled' | 'disabled' }\n  output_config?: { effort: ReasoningEffort }\n  tools:", file)
  await write(file, s)
}
{
  const file = 'src/services/settings.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "import type { TtsVoice } from './api/speech.js'",
    "import type { ChatModel, ReasoningEffort } from './api/types.js'\nimport type { TtsVoice } from './api/speech.js'", file)
  s = replaceOnce(s,
    "  thinking: boolean\n  search: boolean",
    "  thinking: boolean\n  professionalMode: boolean\n  model: ChatModel\n  reasoningEffort: ReasoningEffort\n  search: boolean", file)
  s = replaceOnce(s,
    "  thinking: 'chat-demo:thinking',\n  search:",
    "  thinking: 'chat-demo:thinking',\n  professionalMode: 'deepdesk:professional-mode',\n  model: 'deepdesk:model',\n  reasoningEffort: 'deepdesk:reasoning-effort',\n  search:", file)
  s = replaceOnce(s,
    "export const useSettings = create<Settings>(() => ({",
    "const initialModel = (): ChatModel => read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'\nconst initialReasoningEffort = (): ReasoningEffort => {\n  const value = read(KEYS.reasoningEffort)\n  return value === 'none' || value === 'low' || value === 'max' ? value : 'high'\n}\n\nexport const useSettings = create<Settings>(() => ({", file)
  s = replaceOnce(s,
    "  thinking: read(KEYS.thinking) === 'true',\n  search:",
    "  thinking: read(KEYS.thinking) === 'true',\n  professionalMode: read(KEYS.professionalMode) === 'true',\n  model: initialModel(),\n  reasoningEffort: initialReasoningEffort(),\n  search:", file)
  s = replaceOnce(s,
    "export const setSearch = (search: boolean) => {",
    "export const setProfessionalMode = (professionalMode: boolean) => {\n  write(KEYS.professionalMode, String(professionalMode))\n  useSettings.setState({ professionalMode })\n}\n\nexport const setModel = (model: ChatModel) => {\n  write(KEYS.model, model)\n  useSettings.setState({ model })\n}\n\nexport const setReasoningEffort = (reasoningEffort: ReasoningEffort) => {\n  write(KEYS.reasoningEffort, reasoningEffort)\n  useSettings.setState({ reasoningEffort })\n}\n\nexport const setSearch = (search: boolean) => {", file)
  await write(file, s)
}
{
  const file = 'src/services/chat/types.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  ChatModel,\n  MessageUsage,",
    "  ChatModel,\n  ReasoningEffort,\n  MessageUsage,", file)
  s = replaceOnce(s,
    "  /** 请求时是否开启深度思考 */\n  thinking?: boolean",
    "  /** 请求时是否开启深度思考 */\n  thinking?: boolean\n  /** 专业模式下本轮请求使用的推理强度；缺省时沿用原版请求方式。 */\n  reasoningEffort?: ReasoningEffort", file)
  await write(file, s)
}
{
  const file = 'src/services/chat/store.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  const { thinking, search } = useSettings.getState()\n  return {\n    id: createId(),",
    "  const { thinking, search, professionalMode, model, reasoningEffort } = useSettings.getState()\n  return {\n    id: createId(),", file)
  s = replaceOnce(s,
    "    model: MODEL,\n    thinking,\n    search,",
    "    model: professionalMode ? model : MODEL,\n    thinking: professionalMode ? reasoningEffort !== 'none' : thinking,\n    reasoningEffort: professionalMode ? reasoningEffort : undefined,\n    search,", file)
  s = replaceOnce(s,
    "            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },",
    "            ...(initial.reasoningEffort\n              ? { output_config: { effort: initial.reasoningEffort } }\n              : { thinking: { type: initial.thinking ? 'enabled' : 'disabled' } }),", file)
  await write(file, s)
}
{
  const file = 'src/components/chatInput/ChatInput.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "import { SessionUsage } from '../usage/SessionUsage.js'",
    "import { SessionUsage } from '../usage/SessionUsage.js'\nimport { ModelSettings } from './ModelSettings.js'", file)
  s = replaceOnce(s,
    "          </Tooltip>\n        </div>\n        <div className={styles.right}>",
    "          </Tooltip>\n          <ModelSettings />\n        </div>\n        <div className={styles.right}>", file)
  await write(file, s)
}
{
  const file = 'src/components/chatInput/ModelSettings.tsx'
  await write(file, "import { useState } from 'react'\nimport { createPortal } from 'react-dom'\nimport clsx from 'clsx'\nimport { useTranslate } from '../../i18n/index.js'\nimport type { ChatModel, ReasoningEffort } from '../../services/api/types.js'\nimport { setModel, setProfessionalMode, setReasoningEffort, useSettings } from '../../services/settings.js'\nimport { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'\nimport { useAnchoredPosition, useDismiss } from '../base/anchored.js'\nimport styles from './ModelSettings.module.css'\n\nconst models: { value: ChatModel; label: string }[] = [\n  { value: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },\n  { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },\n]\nconst efforts: { value: ReasoningEffort; label: string }[] = [\n  { value: 'low', label: 'Low' },\n  { value: 'high', label: 'High' },\n  { value: 'max', label: 'Max' },\n]\n\nexport const ModelSettings = () => {\n  const t = useTranslate()\n  const professionalMode = useSettings((state) => state.professionalMode)\n  const model = useSettings((state) => state.model)\n  const effort = useSettings((state) => state.reasoningEffort)\n  const [open, setOpen] = useState(false)\n  const [expanded, setExpanded] = useState<'model' | 'effort' | null>(null)\n  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(\n    open, { side: 'top', align: 'start', offset: 8 }\n  )\n  useDismiss(open, [anchorRef, floatingRef], () => {\n    setOpen(false)\n    setExpanded(null)\n  }, { captureEscape: true })\n\n  const modelName = models.find((item) => item.value === model)?.label ?? models[0].label\n  const effortName = efforts.find((item) => item.value === effort)?.label ?? 'High'\n\n  return <>\n    <button\n      ref={anchorRef}\n      type=\"button\"\n      className={clsx(styles.trigger, professionalMode && styles.active)}\n      aria-haspopup=\"dialog\"\n      aria-expanded={open}\n      aria-pressed={professionalMode}\n      aria-label={t('professionalSettingsTitle')}\n      title={professionalMode ? modelName + ' · ' + effortName : t('professionalSettingsTitle')}\n      onClick={() => { setOpen((value) => !value); setExpanded(null) }}\n    >\n      <span>专业</span>\n      <IconChevronDownOutline14 />\n    </button>\n    {open ? createPortal(\n      <div\n        ref={floatingRef}\n        className={styles.panel}\n        style={position ?? undefined}\n        role=\"dialog\"\n        aria-label={t('professionalSettingsTitle')}\n      >\n        <div className={styles.header}>\n          <strong className={styles.title}>{t('professionalSettingsTitle')}</strong>\n          <button type=\"button\" className={styles.close} aria-label={t('close')}\n            onClick={() => { setOpen(false); setExpanded(null) }}>×</button>\n        </div>\n        <div className={styles.modeRow}>\n          <div className={styles.modeCopy}>\n            <strong>{t('professionalModeEnable')}</strong>\n            <span>{t('professionalModeDescription')}</span>\n          </div>\n          <button\n            type=\"button\"\n            role=\"switch\"\n            aria-checked={professionalMode}\n            className={clsx(styles.switch, professionalMode && styles.switchActive)}\n            onClick={() => { setProfessionalMode(!professionalMode); setExpanded(null) }}\n          >\n            <span className={styles.switchThumb} />\n          </button>\n        </div>\n        <div className={clsx(styles.fields, !professionalMode && styles.disabled)}>\n          <div className={styles.row}>\n            <span className={styles.label}>{t('settingsModelLabel')}</span>\n            <button type=\"button\" className={styles.rowTrigger} disabled={!professionalMode}\n              aria-expanded={expanded === 'model'}\n              onClick={() => setExpanded((value) => value === 'model' ? null : 'model')}>\n              <span>{modelName}</span><IconChevronDownOutline14 />\n            </button>\n          </div>\n          {expanded === 'model' && professionalMode ? (\n            <div className={styles.options} role=\"listbox\" aria-label={t('settingsModelLabel')}>\n              {models.map((item) => (\n                <button key={item.value} type=\"button\" role=\"option\"\n                  aria-selected={item.value === model} className={styles.option}\n                  onClick={() => { setModel(item.value); setExpanded(null) }}>\n                  <span>{item.label}</span>{item.value === model ? <IconCheckOutline16 /> : null}\n                </button>\n              ))}\n            </div>\n          ) : null}\n          <div className={styles.row}>\n            <span className={styles.label}>{t('settingsReasoningEffortLabel')}</span>\n            <button type=\"button\" className={styles.rowTrigger} disabled={!professionalMode}\n              aria-expanded={expanded === 'effort'}\n              onClick={() => setExpanded((value) => value === 'effort' ? null : 'effort')}>\n              <span>{effortName}</span><IconChevronDownOutline14 />\n            </button>\n          </div>\n          {expanded === 'effort' && professionalMode ? (\n            <div className={styles.options} role=\"listbox\" aria-label={t('settingsReasoningEffortLabel')}>\n              {efforts.map((item) => (\n                <button key={item.value} type=\"button\" role=\"option\"\n                  aria-selected={item.value === effort} className={styles.option}\n                  onClick={() => { setReasoningEffort(item.value); setExpanded(null) }}>\n                  <span>{item.label}</span>{item.value === effort ? <IconCheckOutline16 /> : null}\n                </button>\n              ))}\n            </div>\n          ) : null}\n        </div>\n        <p className={styles.hint}>{t('professionalModeThinkingHint')}</p>\n        {professionalMode && model === 'deepseek-v4-pro'\n          ? <p className={styles.hint}>{t('settingsModelProHint')}</p>\n          : null}\n      </div>,\n      document.body\n    ) : null}\n  </>\n}\n")
  await write('src/components/chatInput/ModelSettings.module.css', ".trigger {\n  display: inline-flex; align-items: center; flex-shrink: 0; gap: 6px;\n  height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 18px; background: transparent; color: var(--dsw-alias-label-primary);\n  font: inherit; font-size: 13px; line-height: 20px; font-weight: 500;\n  white-space: nowrap; cursor: pointer; transition: background .2s, border-color .2s;\n}\n.trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }\n.active {\n  background: var(--dsw-alias-button-ghost-active-fill);\n  color: var(--dsw-alias-brand-text);\n  border-color: var(--dsw-alias-button-ghost-active-border);\n}\n.panel {\n  position: fixed; z-index: 1100; box-sizing: border-box; width: 318px; padding: 12px;\n  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;\n  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);\n  box-shadow: 0 8px 28px rgba(0,0,0,.14);\n}\n.header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }\n.title { font-size:14px; font-weight:600; }\n.close { width:26px; height:26px; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-tertiary); font-size:20px; line-height:1; cursor:pointer; }\n.close:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }\n.modeRow { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 2px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); }\n.modeCopy { display:flex; flex-direction:column; gap:3px; min-width:0; }\n.modeCopy strong { font-size:13px; font-weight:550; }\n.modeCopy span { color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.45; }\n.switch { position:relative; flex-shrink:0; width:36px; height:21px; padding:0; border:0; border-radius:12px; background:var(--dsw-alias-border-l2); cursor:pointer; transition:background .18s; }\n.switchActive { background:var(--dsw-alias-brand-solid); }\n.switchThumb { position:absolute; top:3px; left:3px; width:15px; height:15px; border-radius:50%; background:white; box-shadow:0 1px 2px rgba(0,0,0,.16); transition:transform .18s; }\n.switchActive .switchThumb { transform:translateX(15px); }\n.fields { padding-top:7px; }\n.disabled { opacity:.45; }\n.row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:42px; }\n.label { flex-shrink:0; color:var(--dsw-alias-label-secondary); font-size:13px; }\n.rowTrigger {\n  display:flex; align-items:center; justify-content:space-between; gap:8px;\n  width:208px; min-width:0; min-height:36px; padding:0 10px;\n  border:1px solid var(--dsw-alias-border-l1); border-radius:9px;\n  background:var(--dsw-specific-selector); color:var(--dsw-alias-label-primary);\n  font:inherit; font-size:12px; cursor:pointer;\n}\n.rowTrigger span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.rowTrigger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }\n.rowTrigger:disabled { cursor:not-allowed; }\n.options {\n  display:flex; flex-direction:column; gap:2px; margin:2px 0 6px 76px;\n  padding:4px; border-radius:9px; background:var(--dsw-specific-selector);\n}\n.option {\n  display:flex; align-items:center; justify-content:space-between; gap:8px;\n  min-height:33px; padding:4px 8px; border:0; border-radius:7px;\n  background:transparent; color:var(--dsw-alias-label-primary);\n  font:inherit; font-size:12px; text-align:left; cursor:pointer;\n}\n.option:hover,.option[aria-selected=\"true\"] { background:var(--dsw-alias-interactive-bg-hover); }\n.hint { margin:9px 2px 0; color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.5; }\n")
  await write('src/components/chatInput/ModelSettings.module.css.d.ts', "declare const styles: {\n  readonly \"trigger\": string;\n  readonly \"active\": string;\n  readonly \"panel\": string;\n  readonly \"header\": string;\n  readonly \"title\": string;\n  readonly \"close\": string;\n  readonly \"modeRow\": string;\n  readonly \"modeCopy\": string;\n  readonly \"switch\": string;\n  readonly \"switchActive\": string;\n  readonly \"switchThumb\": string;\n  readonly \"fields\": string;\n  readonly \"disabled\": string;\n  readonly \"row\": string;\n  readonly \"label\": string;\n  readonly \"rowTrigger\": string;\n  readonly \"options\": string;\n  readonly \"option\": string;\n  readonly \"hint\": string;\n}\nexport = styles\n")
}
{
  const file = 'src/i18n/zh.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  settingsTtsVoice: '朗读音色',",
    "  professionalSettingsTitle: '专业设置',\n  professionalModeEnable: '启用专业模式',\n  professionalModeDescription: '开启后可自选模型和推理强度；关闭时沿用普通模式。',\n  professionalModeThinkingHint: '深度思考开关仍负责开启或关闭；推理强度仅在开启时生效。',\n  settingsModelLabel: '模型',\n  settingsReasoningEffortLabel: '推理强度',\n  settingsEffortLow: 'Low（低）',\n  settingsEffortHigh: 'High（标准）',\n  settingsEffortMax: 'Max（最高）',\n  settingsModelProHint: 'DeepSeek-V4-Pro 当前不支持图片输入。',\n  settingsTtsVoice: '朗读音色',", file)
  await write(file, s)
}
{
  const file = 'src/i18n/en.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  settingsTtsVoice: 'Read-aloud voice',",
    "  professionalSettingsTitle: 'Professional settings',\n  professionalModeEnable: 'Enable professional mode',\n  professionalModeDescription: 'Choose a model and reasoning effort. Turn it off to return to the default experience.',\n  professionalModeThinkingHint: 'The original Deep Thinking switch still turns thinking on or off. Effort applies only when thinking is on.',\n  settingsModelLabel: 'Model',\n  settingsReasoningEffortLabel: 'Reasoning effort',\n  settingsEffortLow: 'Low',\n  settingsEffortHigh: 'High',\n  settingsEffortMax: 'Max',\n  settingsModelProHint: 'DeepSeek-V4-Pro does not support image input.',\n  settingsTtsVoice: 'Read-aloud voice',", file)
  await write(file, s)
}


{
  const file = 'src/components/chatInput/ChatInput.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "  const thinking = useSettings((state) => state.thinking)\n",
    "  const thinking = useSettings((state) => state.thinking)\n  const professionalMode = useSettings((state) => state.professionalMode)\n", file)
  s = replaceOnce(s,
    "          <Tooltip content={t('deactivatedThinkTooltip')}>\n            <button\n              type=\"button\"\n              className={clsx(styles.toggle, thinking && styles.selected)}\n              aria-label={t('thinkingSwitch')}\n              aria-pressed={thinking}\n              onClick={() => setThinking(!thinking)}\n            >\n              <IconThinkOutline14 />\n              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>\n            </button>\n          </Tooltip>",
    "          {!professionalMode ? (\n            <Tooltip content={t('deactivatedThinkTooltip')}>\n              <button\n                type=\"button\"\n                className={clsx(styles.toggle, thinking && styles.selected)}\n                aria-label={t('thinkingSwitch')}\n                aria-pressed={thinking}\n                onClick={() => setThinking(!thinking)}\n              >\n                <IconThinkOutline14 />\n                <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>\n              </button>\n            </Tooltip>\n          ) : null}", file)
  await write(file, s)
}
{
  const file = 'src/components/chatInput/ModelSettings.tsx'
  await write(file, "import { useState } from 'react'\nimport { createPortal } from 'react-dom'\nimport clsx from 'clsx'\nimport { useTranslate } from '../../i18n/index.js'\nimport type { ChatModel, ReasoningEffort } from '../../services/api/types.js'\nimport { setModel, setProfessionalMode, setReasoningEffort, useSettings } from '../../services/settings.js'\nimport { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'\nimport { useAnchoredPosition, useDismiss } from '../base/anchored.js'\nimport styles from './ModelSettings.module.css'\n\nconst models: { value: ChatModel; label: string }[] = [\n  { value: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },\n  { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },\n]\nconst efforts: { value: ReasoningEffort; label: string }[] = [\n  { value: 'none', label: 'Off' },\n  { value: 'low', label: 'Low' },\n  { value: 'high', label: 'High' },\n  { value: 'max', label: 'Max' },\n]\n\nexport const ModelSettings = () => {\n  const t = useTranslate()\n  const professionalMode = useSettings((state) => state.professionalMode)\n  const model = useSettings((state) => state.model)\n  const effort = useSettings((state) => state.reasoningEffort)\n  const [open, setOpen] = useState(false)\n  const [expanded, setExpanded] = useState<'model' | 'effort' | null>(null)\n  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(\n    open, { side: 'top', align: 'start', offset: 8 }\n  )\n  useDismiss(open, [anchorRef, floatingRef], () => {\n    setOpen(false)\n    setExpanded(null)\n  }, { captureEscape: true })\n\n  const modelName = models.find((item) => item.value === model)?.label ?? models[0].label\n  const effortName = efforts.find((item) => item.value === effort)?.label ?? 'High'\n\n  const openProfessionalSettings = () => {\n    if (!professionalMode) {\n      setProfessionalMode(true)\n    }\n    setExpanded(null)\n    setOpen(true)\n  }\n  const closeProfessionalSettings = () => {\n    setProfessionalMode(false)\n    setExpanded(null)\n    setOpen(false)\n  }\n\n  return <>\n    <button\n      ref={anchorRef}\n      type=\"button\"\n      className={clsx(styles.trigger, professionalMode && styles.active)}\n      aria-haspopup=\"dialog\"\n      aria-expanded={open}\n      aria-pressed={professionalMode}\n      aria-label={professionalMode ? modelName + ' ' + effortName : t('professionalSettingsTitle')}\n      title={professionalMode ? modelName + ' · ' + effortName : t('professionalSettingsTitle')}\n      onClick={() => {\n        if (!professionalMode) {\n          openProfessionalSettings()\n        } else {\n          setOpen((value) => !value)\n          setExpanded(null)\n        }\n      }}\n    >\n      {professionalMode ? <>\n        <span className={styles.modelName}>{modelName}</span>\n        <span className={styles.effortName}>{effortName}</span>\n      </> : <span>专业</span>}\n      <IconChevronDownOutline14 />\n    </button>\n    {open ? createPortal(\n      <div\n        ref={floatingRef}\n        className={styles.panel}\n        style={position ?? undefined}\n        role=\"dialog\"\n        aria-label={t('professionalSettingsTitle')}\n      >\n        <div className={styles.row}>\n          <span className={styles.label}>{t('settingsModelLabel')}</span>\n          <button\n            type=\"button\"\n            className={styles.rowTrigger}\n            aria-expanded={expanded === 'model'}\n            onClick={() => setExpanded((value) => value === 'model' ? null : 'model')}\n          >\n            <span>{modelName}</span>\n            <IconChevronDownOutline14 />\n          </button>\n          {expanded === 'model' ? (\n            <div className={clsx(styles.options, styles.modelOptions)} role=\"listbox\" aria-label={t('settingsModelLabel')}>\n              {models.map((item) => (\n                <button\n                  key={item.value}\n                  type=\"button\"\n                  role=\"option\"\n                  aria-selected={item.value === model}\n                  className={styles.option}\n                  onClick={() => { setModel(item.value); setExpanded(null) }}\n                >\n                  <span>{item.label}</span>\n                  {item.value === model ? <IconCheckOutline16 /> : null}\n                </button>\n              ))}\n            </div>\n          ) : null}\n        </div>\n        <div className={styles.row}>\n          <span className={styles.label}>{t('settingsReasoningEffortLabel')}</span>\n          <button\n            type=\"button\"\n            className={styles.rowTrigger}\n            aria-expanded={expanded === 'effort'}\n            onClick={() => setExpanded((value) => value === 'effort' ? null : 'effort')}\n          >\n            <span>{effortName}</span>\n            <IconChevronDownOutline14 />\n          </button>\n          {expanded === 'effort' ? (\n            <div className={clsx(styles.options, styles.effortOptions)} role=\"listbox\" aria-label={t('settingsReasoningEffortLabel')}>\n              {efforts.map((item) => (\n                <button\n                  key={item.value}\n                  type=\"button\"\n                  role=\"option\"\n                  aria-selected={item.value === effort}\n                  className={styles.option}\n                  onClick={() => { setReasoningEffort(item.value); setExpanded(null) }}\n                >\n                  <span>{item.label}</span>\n                  {item.value === effort ? <IconCheckOutline16 /> : null}\n                </button>\n              ))}\n            </div>\n          ) : null}\n        </div>\n        <div className={styles.footer}>\n          <span>{t('professionalSettingsTitle')}</span>\n          <button type=\"button\" onClick={closeProfessionalSettings}>{t('professionalModeExit')}</button>\n        </div>\n      </div>,\n      document.body\n    ) : null}\n  </>\n}\n")
  await write('src/components/chatInput/ModelSettings.module.css', ".trigger {\n  display: inline-flex;\n  align-items: center;\n  flex-shrink: 0;\n  gap: 7px;\n  max-width: 300px;\n  height: 34px;\n  padding: 0 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 18px;\n  background: var(--dsw-specific-selector);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  line-height: 18px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }\n.active {\n  background: var(--dsw-alias-button-ghost-active-fill);\n  color: var(--dsw-alias-brand-text);\n  border-color: var(--dsw-alias-button-ghost-active-border);\n}\n.modelName { overflow: hidden; text-overflow: ellipsis; }\n.effortName { color: var(--dsw-alias-label-secondary); }\n.panel {\n  position: fixed;\n  z-index: 1100;\n  box-sizing: border-box;\n  width: 272px;\n  padding: 8px;\n  overflow: visible;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 14px;\n  background: var(--dsw-alias-bg-layer-3);\n  color: var(--dsw-alias-label-primary);\n  box-shadow: 0 6px 24px rgba(0,0,0,.12);\n}\n.row {\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  min-height: 44px;\n}\n.label {\n  flex: 0 0 76px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 13px;\n}\n.rowTrigger {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  flex: 1;\n  min-width: 0;\n  height: 38px;\n  padding: 0 10px;\n  border: 0;\n  border-radius: 10px;\n  background: var(--dsw-specific-selector);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  cursor: pointer;\n}\n.rowTrigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.rowTrigger:hover, .rowTrigger[aria-expanded=\"true\"] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.options {\n  position: absolute;\n  z-index: 2;\n  left: calc(100% + 8px);\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  box-sizing: border-box;\n  width: 218px;\n  padding: 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-3);\n  box-shadow: 0 6px 24px rgba(0,0,0,.12);\n}\n.modelOptions { top: 1px; }\n.effortOptions { top: 45px; }\n.option {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  min-height: 36px;\n  padding: 4px 9px;\n  border: 0;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  text-align: left;\n  cursor: pointer;\n}\n.option:hover, .option[aria-selected=\"true\"] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.footer {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  margin: 6px 2px 0;\n  padding-top: 8px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n}\n.footer button {\n  padding: 3px 0;\n  border: 0;\n  background: transparent;\n  color: var(--dsw-alias-brand-text);\n  font: inherit;\n  cursor: pointer;\n}\n")
  await write('src/components/chatInput/ModelSettings.module.css.d.ts', "declare const styles: {\n  readonly \"trigger\": string;\n  readonly \"active\": string;\n  readonly \"modelName\": string;\n  readonly \"effortName\": string;\n  readonly \"panel\": string;\n  readonly \"row\": string;\n  readonly \"label\": string;\n  readonly \"rowTrigger\": string;\n  readonly \"options\": string;\n  readonly \"modelOptions\": string;\n  readonly \"effortOptions\": string;\n  readonly \"option\": string;\n  readonly \"footer\": string;\n}\nexport = styles\n")
}
// Professional mode types and request mapping are patched once above; do not re-patch generated anchors.

{
  const file = 'src/i18n/zh.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  professionalModeThinkingHint: '深度思考开关仍负责开启或关闭；推理强度仅在开启时生效。',",
    "  professionalModeThinkingHint: '专业模式使用推理强度控制思考方式。',\n  professionalModeExit: '退出专业模式',", file)
  await write(file, s)
}
{
  const file = 'src/i18n/en.ts'
  let s = await read(file)
  s = replaceOnce(s,
    "  professionalModeThinkingHint: 'The original Deep Thinking switch still turns thinking on or off. Effort applies only when thinking is on.',",
    "  professionalModeThinkingHint: 'Professional mode uses the selected reasoning effort.',\n  professionalModeExit: 'Exit professional mode',", file)
  await write(file, s)
}

{
  const file = 'src/main.tsx'
  let s = await read(file)
  s = replaceOnce(s,
    "import { createRoot } from 'react-dom/client'\n",
    "import { createRoot } from 'react-dom/client'\nimport { importHistory } from './services/chat/backup.js'\nimport './services/native.js'\n", file)
  const bridge = `type DeepDeskHistoryImportResult = { imported: number; skipped: number }

declare global {
  interface Window {
    deepDeskHistoryImport?: {
      begin: (name: string, totalBytes: number) => boolean
      append: (base64: string) => boolean
      finish: () => Promise<void>
      cancel: () => void
    }
  }
}

let deepDeskHistoryName = ''
let deepDeskHistoryExpectedBytes = 0
let deepDeskHistoryReceivedBytes = 0
let deepDeskHistoryChunks: Uint8Array[] = []

const resetDeepDeskHistoryImport = () => {
  deepDeskHistoryName = ''
  deepDeskHistoryExpectedBytes = 0
  deepDeskHistoryReceivedBytes = 0
  deepDeskHistoryChunks = []
}

window.deepDeskHistoryImport = {
  begin(name, totalBytes) {
    if (!name.toLowerCase().endsWith('.zip') ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes <= 0 ||
        totalBytes > 512 * 1024 * 1024) {
      return false
    }
    resetDeepDeskHistoryImport()
    deepDeskHistoryName = name
    deepDeskHistoryExpectedBytes = totalBytes
    return true
  },
  append(base64) {
    if (!deepDeskHistoryExpectedBytes || typeof base64 !== 'string') return false
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    if (deepDeskHistoryReceivedBytes + bytes.byteLength > deepDeskHistoryExpectedBytes) {
      resetDeepDeskHistoryImport()
      return false
    }
    deepDeskHistoryChunks.push(bytes)
    deepDeskHistoryReceivedBytes += bytes.byteLength
    return true
  },
  async finish() {
    try {
      if (!deepDeskHistoryExpectedBytes ||
          deepDeskHistoryReceivedBytes !== deepDeskHistoryExpectedBytes) {
        throw new Error('文件传输不完整，请重新选择 ZIP 文件。')
      }
      const parts: BlobPart[] = deepDeskHistoryChunks.map((chunk) => {
        const copy = new Uint8Array(chunk.byteLength)
        copy.set(chunk)
        return copy.buffer
      })
      const file = new File(parts, deepDeskHistoryName, { type: 'application/zip' })
      const result: DeepDeskHistoryImportResult = await importHistory(file, 'merge')
      window.chrome?.webview?.postMessage({
        type: 'deepdesk-history-import-result',
        success: true,
        result,
      })
    } catch (error) {
      window.chrome?.webview?.postMessage({
        type: 'deepdesk-history-import-result',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      resetDeepDeskHistoryImport()
    }
  },
  cancel() {
    resetDeepDeskHistoryImport()
  },
}

`
  s = appendBefore(s, "ensureKatex()\n", bridge, file)
  await write(file, s)
}

console.log('DeepDesk Chat Demo patches applied.')
