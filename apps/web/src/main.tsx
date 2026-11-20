import { createRoot } from 'react-dom/client'
import { importHistory } from './services/chat/backup.js'
import { initializeMacCredential } from './services/native.js'
import { notifyHistoryImportResult } from './services/desktop.js'
import { newChat } from './services/chat/store.js'
import { migrateStorageToNative } from './services/chat/migrateStorage.js'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

type DeepDeskHistoryImportResult = { imported: number; skipped: number }

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
      notifyHistoryImportResult(true, result)
    } catch (error) {
      notifyHistoryImportResult(false, undefined, error instanceof Error ? error.message : String(error))
    } finally {
      resetDeepDeskHistoryImport()
    }
  },
  cancel() {
    resetDeepDeskHistoryImport()
  },
}

ensureKatex()
setupTheme()

// macOS 原生菜单 Cmd+N 触发的新建聊天；与网页侧新建按钮行为一致
window.addEventListener('deepdesk-native-new-chat', () => {
  newChat()
})

// 原生设置界面的「迁移到 SQLite」入口（T06/E04）
window.__deepseekMigrateStorage = () =>
  migrateStorageToNative((progress) => {
    // 进度只留控制台，不把会话内容写进日志
    console.info(`[storage-migration] ${progress.phase} ${progress.done}/${progress.total}`)
  })

void initializeMacCredential().catch(() => {}).then(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
})
