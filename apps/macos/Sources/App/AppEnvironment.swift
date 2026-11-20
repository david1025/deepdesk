import AppKit
import SwiftUI
import WebKit

@MainActor
final class AppEnvironment: ObservableObject {
    let keychain = KeychainService()
    let updates = UpdateService()
    let discovery = LANDiscoveryService()
    let network: ApiNetworkService
    let theme = ThemeService()
    let loginItem = LoginItemService()
    let imports = ImportService()
    let storage: StorageService

    /// 由 App scene 注入 SwiftUI openWindow
    var windowOpener: ((String) -> Void)?

    private var coordinators: NSHashTable<AnyObject> = .weakObjects()

    init() {
        self.network = ApiNetworkService(keychain: keychain)
        self.storage = StorageService()
        discovery.start { _ in }
        // 多窗口一致性（B07）：任何窗口的写入都广播 nativeStorageChanged 给全部 webview
        self.storage.onChange = { [weak self] revision, entityType, entityId in
            self?.broadcastStorageChange(revision: revision, entityType: entityType, entityId: entityId)
        }
        Task { @MainActor in
            _ = try? await self.storage.cleanupOrphans()
        }
        BridgeSelfTest.runIfRequested(environment: self)
        DiagnosticsService.shared.log(.info, "app", "launch \(version) (\(build))")
    }

    /// 帮助菜单「导出诊断信息」：汇总日志/存储统计/自检结果为 ZIP（不含密钥与聊天内容）
    @MainActor
    func exportDiagnostics() async {
        do {
            let mode = (try? await storage.getMode()) ?? "?"
            let stats = (try? await storage.stats()) ?? [:]
            let summary = """
            mode=\(mode)
            sessions=\(stats["sessions"] ?? 0)
            attachments=\(stats["attachments"] ?? 0)
            """
            guard let url = try DiagnosticsService.shared.exportDiagnostics(storageSummary: summary) else {
                return
            }
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            DiagnosticsService.shared.log(.error, "diag", "export failed: \(error)")
        }
    }

    private func broadcastStorageChange(revision: Int, entityType: String, entityId: String) {
        let detail = ["revision": revision, "entityType": entityType, "entityId": entityId] as [String: Any]
        for coordinator in coordinators.allObjects.compactMap({ $0 as? WebContainerView.Coordinator }) {
            coordinator.pushStorageChange(detail: detail)
        }
    }

    var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "开发版"
    }

    var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "-"
    }

    // MARK: - WebView 注册表（菜单动作定位 key window 的 webview）

    func register(coordinator: WebContainerView.Coordinator) {
        coordinators.add(coordinator)
        coordinator.startObservingTheme()
    }

    private var keyWindowCoordinator: WebContainerView.Coordinator? {
        coordinators.allObjects
            .compactMap { $0 as? WebContainerView.Coordinator }
            .first { $0.window === NSApp.keyWindow }
    }

    // MARK: - 窗口动作

    func openMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        windowOpener?("main")
    }

    func openAbout() {
        windowOpener?("about")
    }

    /// 新窗口：WindowGroup 支持多实例，共享同一受控存储
    func openNewWindow() {
        openMainWindow()
    }

    /// Cmd+N：在当前 key window 的网页里新建聊天
    func newChatInKeyWindow() {
        NSApp.activate(ignoringOtherApps: true)
        keyWindowCoordinator?.dispatchNewChat()
    }

    /// Cmd+R：刷新当前 key window 的前端（不影响本地数据）
    func reloadKeyWindowPage() {
        keyWindowCoordinator?.reloadPage()
    }
}
