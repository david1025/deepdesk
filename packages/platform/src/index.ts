/**
 * Web/Windows/Mac 平台抽象的起步代码。接入 app/web 时请不要替换原有业务实现。
 * 这是类型与 Bridge 封装，不是完整 Native API/存储/同步客户端。
 */
export type Platform = 'browser' | 'windows' | 'macos';

export interface AppInfo {
  platform: Platform;
  version: string;
  build?: string;
  bridgeVersion?: number;
}

export interface DesktopPlatformAdapter {
  readonly platform: Platform;
  getInfo(): Promise<AppInfo>;
  getSystemTheme(): Promise<'dark' | 'light'>;
  openExternal(url: string): Promise<void>;
  checkForUpdates(): Promise<void>;
  hasApiKey(): Promise<boolean>;
  saveApiKey(apiKey: string): Promise<void>;
  deleteApiKey(): Promise<void>;
}

declare global {
  interface Window {
    __DEEPSEEK_DESKTOP__?: Readonly<{platform:'macos'; bridgeVersion: number}>;
    deepseekNativeCall?: (method: string, params?: Record<string,unknown>) => Promise<unknown>;
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid native response');
  }
  return value as Record<string, unknown>;
}

export class MacPlatformAdapter implements DesktopPlatformAdapter {
  readonly platform = 'macos' as const;
  private call(method: string, params: Record<string,unknown> = {}): Promise<unknown> {
    const bridge = window.deepseekNativeCall;
    if (!bridge || window.__DEEPSEEK_DESKTOP__?.bridgeVersion !== 1) {
      throw new Error('Incompatible macOS native bridge');
    }
    return bridge(method, params);
  }

  async getInfo(): Promise<AppInfo> {
    const obj = requireObject(await this.call('app.getInfo'));
    if (obj.platform !== 'macos' || typeof obj.version !== 'string') {
      throw new Error('Invalid app info');
    }
    return {
      platform: 'macos', version: obj.version,
      build: typeof obj.build === 'string' ? obj.build : undefined,
      bridgeVersion: typeof obj.bridgeVersion === 'number' ? obj.bridgeVersion : undefined,
    };
  }
  async getSystemTheme(): Promise<'dark' | 'light'> {
    const theme = requireObject(await this.call('system.getTheme')).theme;
    if (theme !== 'dark' && theme !== 'light') throw new Error('Invalid theme');
    return theme;
  }
  async openExternal(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) links allowed');
    await this.call('app.openExternal', {url});
  }
  async checkForUpdates(): Promise<void> { await this.call('updater.check'); }
  async hasApiKey(): Promise<boolean> {
    const value = requireObject(await this.call('security.key.exists')).exists;
    if (typeof value !== 'boolean') throw new Error('Invalid Keychain reply');
    return value;
  }
  async saveApiKey(apiKey: string): Promise<void> {
    if (!apiKey) throw new Error('Missing API key');
    await this.call('security.key.save', {key: apiKey});
  }
  async deleteApiKey(): Promise<void> { await this.call('security.key.delete'); }
}

export function detectPlatform(): Platform {
  if (typeof window !== 'undefined' && window.__DEEPSEEK_DESKTOP__?.platform === 'macos') return 'macos';
  // 在迁移 Windows 源码后补充其原生宿主识别方式；此处故意不猜测。
  return 'browser';
}

export function getMacAdapterIfAvailable(): MacPlatformAdapter | null {
  return detectPlatform() === 'macos' ? new MacPlatformAdapter() : null;
}
