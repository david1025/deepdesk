import SwiftUI
import WebKit
import AppKit

/// 内嵌 WKWebView 容器。只加载 Bundle 内可信 Web 资源；外部链接进系统浏览器；
/// Bridge 调用经 NativeBridge 白名单校验；SSE/主题等原生事件用 callAsyncJavaScript 推送。
struct WebContainerView: NSViewRepresentable {
    @ObservedObject var environment: AppEnvironment

    func makeCoordinator() -> Coordinator { Coordinator(environment: environment) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // 持久化 IndexedDB/localStorage；升级后数据保留需实测验收
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let coordinator = context.coordinator
        coordinator.bridge = NativeBridge(environment: environment, webView: nil)
        config.userContentController.addScriptMessageHandler(
            coordinator.bridge!,
            contentWorld: .page,
            name: "nativeBridge"
        )

        // 文档开始前注入：能力声明 + Bridge 封装 + 旧 localStorage 明文密钥一次性迁入 Keychain
        let injectedScript = """
        window.__DEEPSEEK_DESKTOP__ = Object.freeze({ platform: 'macos', bridgeVersion: 1, attachmentPreviewVersion: 1 });
        window.deepseekNativeCall = async function(method, params = {}) {
          const handler = window.webkit?.messageHandlers?.nativeBridge;
          if (!handler) throw new Error('nativeBridge unavailable');
          const response = await handler.postMessage({ method, params });
          if (!response || response.ok !== true) {
            const info = response?.error || {};
            const error = new Error(info.message || 'Native call failed');
            if (info.code) error.code = info.code;
            if (typeof info.status === 'number') error.status = info.status;
            throw error;
          }
          return response.data;
        };
        (async () => {
          try {
            const KEY = 'chat-demo:api-key';
            const current = localStorage.getItem(KEY);
            if (!current || current === 'DEEPDESK_NATIVE_CREDENTIAL') return;
            const handler = window.webkit?.messageHandlers?.nativeBridge;
            if (!handler) return;
            const response = await handler.postMessage({ method: 'security.key.save', params: { key: current } });
            if (response && response.ok === true) {
              localStorage.setItem(KEY, 'DEEPDESK_NATIVE_CREDENTIAL');
            }
          } catch {}
        })();
        """
        config.userContentController.addUserScript(WKUserScript(
            source: injectedScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page
        ))

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        coordinator.attach(view)
        coordinator.bridge?.attachWebView(view)
        // 注册到环境：菜单新建聊天/刷新需要定位 key window 的 webview
        environment.register(coordinator: coordinator)

        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else {
            view.loadHTMLString("<h3>Web resources missing</h3>", baseURL: nil)
            return view
        }
        let file = root.appendingPathComponent("index.html")
        if FileManager.default.fileExists(atPath: file.path) {
            view.loadFileURL(file, allowingReadAccessTo: root)
        } else {
            view.loadHTMLString("<h3>Missing Web/index.html</h3>", baseURL: nil)
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let environment: AppEnvironment
        var bridge: NativeBridge?
        private weak var view: WKWebView?
        private var titleObservation: NSKeyValueObservation?
        private var themeObserverAdded = false

        init(environment: AppEnvironment) {
            self.environment = environment
            super.init()
        }

        func attach(_ view: WKWebView) {
            self.view = view
            titleObservation = view.observe(\.title, options: [.new]) { webView, _ in
                DispatchQueue.main.async {
                    webView.window?.title = webView.title?.isEmpty == false ? webView.title! : "DeepSeek"
                }
            }
        }

        var window: NSWindow? {
            view?.window
        }

        // MARK: 导航策略

        private func bundledWebFile(_ url: URL) -> Bool {
            guard url.isFileURL, let root = Bundle.main.resourceURL?
                .appendingPathComponent("Web", isDirectory: true)
                .standardizedFileURL else { return false }
            let path = url.standardizedFileURL.path
            return path.hasPrefix(root.path + "/")
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if bundledWebFile(url) || url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "blob" {
                // 同源 blob（附件预览/导出）不进入外部浏览器
                decisionHandler(.allow)
                return
            }
            if url.scheme == "https" || url.scheme == "http" {
                if navigationAction.navigationType == .linkActivated {
                    NSWorkspace.shared.open(url)
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(.allow)
        }

        // MARK: 外部链接

        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            if url.scheme == "https" || url.scheme == "http" {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        // MARK: 下载 / 文件选择 / 权限

        func webView(_ webView: WKWebView,
                     navigationAction: WKNavigationAction,
                     didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView,
                     navigationResponse: WKNavigationResponse,
                     didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload,
                      decideDestinationUsing response: URLResponse,
                      suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedFilename.isEmpty ? "附件" : suggestedFilename
            panel.canCreateDirectories = true
            panel.begin { result in
                completionHandler(result == .OK ? panel.url : nil)
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error,
                      resumeData: Data?) {
            NSLog("Download failed: %@", error.localizedDescription)
        }

        func webView(_ webView: WKWebView,
                     runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.begin { result in
                completionHandler(result == .OK ? panel.urls : nil)
            }
        }

        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // 只对主 frame 授权麦克风；仍需 macOS TCC 系统授权
            guard frame.isMainFrame, type == .microphone,
                  origin.host.isEmpty || origin.protocol.contains("file") else {
                decisionHandler(.deny)
                return
            }
            decisionHandler(.prompt)
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            let alert = NSAlert()
            alert.messageText = message
            alert.runModal()
            completionHandler()
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            let alert = NSAlert()
            alert.messageText = message
            alert.addButton(withTitle: "确定")
            alert.addButton(withTitle: "取消")
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }

        // MARK: 主题事件

        func startObservingTheme() {
            guard !themeObserverAdded else { return }
            themeObserverAdded = true
            environment.theme.addThemeObserver { [weak self] _ in
                self?.pushNativeThemeChanged()
            }
        }

        private func pushNativeThemeChanged() {
            guard let view = view else { return }
            let detail = ["theme": environment.theme.themeName]
            Task {
                try? await view.callAsyncJavaScript(
                    "window.dispatchEvent(new CustomEvent('nativeThemeChanged', { detail }))",
                    arguments: ["detail": detail],
                    in: nil,
                    contentWorld: .page
                )
            }
        }

        /// 广播 nativeStorageChanged（多窗口一致性）
        func pushStorageChange(detail: [String: Any]) {
            guard let view = view else { return }
            Task {
                try? await view.callAsyncJavaScript(
                    "window.dispatchEvent(new CustomEvent('nativeStorageChanged', { detail }))",
                    arguments: ["detail": detail],
                    in: nil,
                    contentWorld: .page
                )
            }
        }

        func reloadPage() {
            view?.reload()
        }

        func dispatchNewChat() {
            guard let view = view else { return }
            Task {
                try? await view.callAsyncJavaScript(
                    "window.dispatchEvent(new Event('deepdesk-native-new-chat'))",
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
            }
        }
    }
}
