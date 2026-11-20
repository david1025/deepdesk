/**
 * 桌面平台适配层（DesktopPlatformAdapter 的宿主探测与单向通知部分）。
 * 组件与服务层只调用这里导出的函数，不直接判断平台或访问 window.webkit / chrome.webview。
 */
type NativeBridgeCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

declare global {
  interface Window {
    /** macOS 宿主在文档开始前注入的能力声明 */
    __DEEPSEEK_DESKTOP__?: { platform: 'macos'; bridgeVersion: number; attachmentPreviewVersion?: number; localCredentialVersion?: number }
    /** macOS Native Bridge v1：contracts/bridge-v1.d.ts */
    deepseekNativeCall?: NativeBridgeCall
    /** 原生存储迁移入口（原生设置界面驱动，见 migrateStorage.ts） */
    __deepseekMigrateStorage?: () => Promise<{ mode: string; sessions: number; attachments: number }>
    /** DeepDesk 首启历史导入通道（由原生端驱动，见 main.tsx） */
    deepDeskHistoryImport?: {
      begin: (name: string, totalBytes: number) => boolean
      append: (base64: string) => boolean
      finish: () => Promise<void>
      cancel: () => void
    }
  }
}

/** macOS 宿主 + Bridge v1 就绪时才走原生传输；浏览器与 Windows 构建保持原有行为 */
export const isMacDesktop = (): boolean =>
  typeof window !== 'undefined' &&
  window.__DEEPSEEK_DESKTOP__?.platform === 'macos' &&
  typeof window.deepseekNativeCall === 'function'

export const isWindowsDesktop = (): boolean =>
  typeof window !== 'undefined' && !!window.chrome?.webview && !isMacDesktop()

/** 页面主题变化单向通知：Windows 走 WebView2 postMessage，macOS 走 Bridge 白名单命令。
 * preference 让原生区分「跟随系统」与「显式选择」，避免原生覆盖破坏跟随系统模式 */
export const reportThemeToNative = (theme: 'light' | 'dark', preference: 'system' | 'light' | 'dark'): void => {
  if (isMacDesktop()) {
    void window.deepseekNativeCall?.('system.themeChanged', { theme, preference }).catch(() => {})
    return
  }
  window.chrome?.webview?.postMessage({ type: 'deepdesk-theme', theme })
}

/** 首启历史 ZIP 导入结果单向通知 */
export const notifyHistoryImportResult = (
  success: boolean,
  result?: { imported: number; skipped: number },
  error?: string
): void => {
  if (isMacDesktop()) {
    void window.deepseekNativeCall
      ?.('import.reportResult', {
        success,
        imported: result?.imported ?? 0,
        skipped: result?.skipped ?? 0,
        error,
      })
      .catch(() => {})
    return
  }
  window.chrome?.webview?.postMessage({
    type: 'deepdesk-history-import-result',
    success,
    ...(success ? { result } : { error }),
  })
}

/** PDFKit 需要同一页面创建的 blob URL，宿主不会读取外部地址或本机路径。 */
export const previewMacPDF = async (blobUrl: string, name: string): Promise<void> => {
  if (window.__DEEPSEEK_DESKTOP__?.attachmentPreviewVersion !== 1 || !window.deepseekNativeCall) {
    throw new Error('PDF preview unavailable')
  }
  await window.deepseekNativeCall('attachment.previewPDF.v1', { blobUrl, name })
}
