/**
 * 存储错误用户可见提示（T06/E08）：
 * 本地存储写入失败时此前只打 console，用户无感知，可能以为已保存而实际丢失。
 * 这里在页面底部渲染一条持久横幅（单例、去重更新），给出「重新加载」与「知道了」。
 * 不依赖 React：store/db 层的 reportStorageError 在非组件上下文调用。
 */
import { translate } from '../../i18n/index.js'

type StorageBannerError = Error & { code?: string; status?: number }

const BANNER_ID = 'deepseek-storage-error-banner'

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const storageError = error as StorageBannerError
    if (typeof storageError.message === 'string' && storageError.message.length > 0) {
      return storageError.message
    }
  }
  return String(error)
}

const ensureBanner = (): HTMLElement => {
  const existing = document.getElementById(BANNER_ID)
  if (existing) return existing
  const banner = document.createElement('div')
  banner.id = BANNER_ID
  banner.setAttribute('role', 'alert')
  banner.setAttribute('aria-live', 'assertive')
  banner.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:16px',
    'transform:translateX(-50%)',
    'max-width:min(560px,calc(100vw - 32px))',
    'display:none',
    'align-items:center',
    'gap:12px',
    'padding:10px 14px',
    'border-radius:10px',
    'background:#2b1d1e',
    'color:#fde8e8',
    'border:1px solid #b4636a',
    'box-shadow:0 8px 24px rgba(0,0,0,.35)',
    'font-size:13px',
    'line-height:1.5',
    'z-index:2147483000',
  ].join(';')

  const text = document.createElement('span')
  text.id = `${BANNER_ID}-text`
  banner.appendChild(text)

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = translate('storageErrorReload')
  reload.style.cssText =
    'flex:none;padding:4px 10px;border-radius:6px;border:1px solid #b4636a;background:#3d2a2c;color:#fde8e8;font-size:12px;cursor:pointer'
  reload.addEventListener('click', () => window.location.reload())
  banner.appendChild(reload)

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = translate('storageErrorDismiss')
  dismiss.style.cssText =
    'flex:none;padding:4px 10px;border-radius:6px;border:none;background:transparent;color:#fde8e8;font-size:12px;cursor:pointer;text-decoration:underline'
  dismiss.addEventListener('click', () => {
    banner.style.display = 'none'
  })
  banner.appendChild(dismiss)

  document.body.appendChild(banner)
  return banner
}

/** 展示/更新存储错误横幅。同一横幅复用，避免连续失败刷屏。 */
export const showStorageErrorBanner = (error: unknown): void => {
  if (typeof document === 'undefined' || !document.body) {
    return
  }
  try {
    const banner = ensureBanner()
    const text = banner.querySelector(`#${BANNER_ID}-text`)
    if (text) {
      text.textContent = `${translate('storageErrorTitle')}：${describeError(error)}`
    }
    banner.style.display = 'flex'
  } catch {
    // 横幅渲染失败时保持原行为：错误仍在控制台可见
  }
}
