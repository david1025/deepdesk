import SwiftUI
import WebKit

/// 原生设置（Cmd+,）：系统级偏好。API Key 与聊天设置仍在网页 UI 中（与 Windows 版一致）。
struct SettingsView: View {
    @ObservedObject var environment: AppEnvironment
    @State private var migrationBusy = false
    @State private var migrationMessage: String?
    @State private var storageStats: String?

    var body: some View {
        Form {
            Section("启动") {
                Toggle("登录时自动启动 DeepSeek", isOn: Binding(
                    get: { environment.loginItem.isEnabled },
                    set: { enabled in
                        do {
                            try environment.loginItem.setEnabled(enabled)
                        } catch {
                            NSLog("Login item toggle failed: %@", String(describing: error))
                        }
                    }
                ))
            }
            Section("本地存储（实验）") {
                HStack {
                    Text("存储引擎")
                    Spacer()
                    Text(storageStats ?? "读取中…")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Button(migrationBusy ? "迁移中…" : "迁移到 SQLite（保留 IndexedDB 备份）") {
                        runMigration()
                    }
                    .disabled(migrationBusy)
                    if migrationBusy {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                if let migrationMessage {
                    Text(migrationMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Section("通用") {
                HStack {
                    Text("版本")
                    Spacer()
                    Text("\(environment.version) (\(environment.build))")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("API Key")
                    Spacer()
                    Text(environment.credentialConfigured ? "已保存在本机" : "未配置")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("局域网同步")
                    Spacer()
                    Text("协议开发中（发现 \(environment.discovery.deviceCount) 台同协议设备）")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .background(WindowFrameAutosave(name: "DeepSeekSettingsWindow"))
        .frame(width: 440, height: 420)
        .task { await refreshStats() }
    }

    private func refreshStats() async {
        do {
            let stats = try await environment.storage.stats()
            let mode = (stats["mode"] as? String) ?? "idb"
            let sessions = (stats["sessions"] as? Int) ?? 0
            let attachments = (stats["attachments"] as? Int) ?? 0
            let bytes = (stats["attachmentBytes"] as? Int) ?? 0
            storageStats = mode == "sqlite"
                ? "SQLite（\(sessions) 会话 / \(attachments) 附件 / \(bytes / 1024) KB）"
                : "IndexedDB（尚未迁移）"
        } catch {
            storageStats = "读取失败"
        }
    }

    /// 通过聊天窗口的网页执行 IndexedDB → SQLite 迁移（逐条 hash 校验 + 原子切换）
    private func runMigration() {
        migrationBusy = true
        migrationMessage = nil
        Task {
            do {
                guard let webView = NSApp.windows
                    .compactMap({ $0.contentView?.deepseekWebView() })
                    .first else {
                    throw BridgeError.invalidParameter("聊天窗口尚未就绪。")
                }
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__deepseekMigrateStorage?.() ?? null",
                    arguments: [:],
                    in: nil,
                    contentWorld: .page
                )
                await MainActor.run {
                    migrationBusy = false
                    if let payload = result as? [String: Any],
                       let sessions = payload["sessions"] as? Int {
                        let attachments = payload["attachments"] as? Int ?? 0
                        migrationMessage = "迁移完成：\(sessions) 个会话、\(attachments) 个附件原件已写入 SQLite；原 IndexedDB 已保留作回滚备份。窗口将自动刷新。"
                    } else {
                        migrationMessage = "迁移脚本未返回结果（网页可能未就绪），请重试。"
                    }
                    Task { await refreshStats() }
                }
            } catch {
                await MainActor.run {
                    migrationBusy = false
                    migrationMessage = "迁移失败：\(error.localizedDescription)。原数据未受影响。"
                }
            }
        }
    }
}

extension NSView {
    /// 递归查找窗口中的聊天 webview（供迁移等网页通道使用）
    func deepseekWebView() -> WKWebView? {
        if let webView = self as? WKWebView { return webView }
        for subview in subviews {
            if let found = subview.deepseekWebView() { return found }
        }
        return nil
    }
}
