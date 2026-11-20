/**
 * DeepDesk 桌面凭据/余额桥。
 * Windows：WebView2 postMessage（动作名与 DeepDesk 0.1.2 保持一致）。
 * macOS：window.deepseekNativeCall 映射到 Native Bridge v1 白名单命令，
 *        API Key 写入 Keychain，原生网络层自行读取，密钥不回传 JS。
 * 浏览器（pnpm dev）两套桥都不存在时按原有浏览器流程回退。
 */
import { isMacDesktop, isWindowsDesktop } from './desktop.js'
import { setApiKey, useSettings } from './settings.js'

type NativeResponse = { type: 'response'; requestId: string; success: boolean; data: unknown }

type CredentialChanged = { type: 'deepdesk-credentials-changed'; configured: boolean }

declare global {
  interface Window {
    chrome?: { webview?: { postMessage: (message: unknown) => void; addEventListener: (type: 'message', listener: (event: MessageEvent<NativeResponse | CredentialChanged>) => void) => void } }
  }
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let sequence = 0
let listening = false
let credentialRevision = 0

const applyWindowsCredentialStatus = (configured: boolean) => {
  const next = configured ? 'DEEPDESK_NATIVE_CREDENTIAL' : null
  if (useSettings.getState().apiKey !== next) setApiKey(next)
}

const requestWindows = <T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const webview = window.chrome?.webview
  if (!webview) return Promise.reject(new Error('Native Windows bridge is unavailable'))
  if (!listening) {
    listening = true
    webview.addEventListener('message', (event) => {
      const message = event.data
      if (!message) return
      if (message.type === 'deepdesk-credentials-changed') {
        credentialRevision++
        applyWindowsCredentialStatus(message.configured)
        return
      }
      if (message.type !== 'response') return
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

if (isWindowsDesktop()) {
  const initialRevision = credentialRevision
  void requestWindows<{ apiKeyConfigured: boolean }>('app.getStatus')
    .then(({ apiKeyConfigured }) => {
      if (credentialRevision === initialRevision) applyWindowsCredentialStatus(apiKeyConfigured)
    })
    .catch(() => {})
}

const requestMac = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> => {
  const call = window.deepseekNativeCall
  if (!call) throw new Error('Native macOS bridge is unavailable')
  try {
    return (await call(method, params)) as T
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** 业务动作名 → macOS Bridge v1 白名单命令 */
const MAC_METHODS: Record<string, { method: string; params?: (payload: Record<string, unknown>) => Record<string, unknown> }> = {
  'settings.saveApiKey': {
    method: 'security.key.save',
    params: (payload) => ({ key: payload.apiKey }),
  },
  'api.getBalance': {
    method: 'network.request',
    params: () => ({ operation: 'balance' }),
  },
}

export const nativeRequest = <T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
  if (isMacDesktop()) {
    const mapping = MAC_METHODS[action]
    if (!mapping) return Promise.reject(new Error('Unsupported native action: ' + action))
    return requestMac<T>(mapping.method, mapping.params ? mapping.params(payload) : payload)
  }
  return requestWindows<T>(action, payload)
}

export const saveNativeApiKey = (apiKey: string) => nativeRequest<{ saved: boolean }>('settings.saveApiKey', { apiKey })
export const getNativeBalance = () => nativeRequest<{
  is_available: boolean
  balance_infos: Array<{ currency: 'CNY' | 'USD'; total_balance: string; granted_balance: string; topped_up_balance: string }>
}>('api.getBalance')
