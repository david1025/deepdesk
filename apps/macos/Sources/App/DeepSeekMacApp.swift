import SwiftUI
import AppKit

@main
struct DeepSeekMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var environment = AppEnvironment()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        WindowGroup("DeepSeek", id: "main") {
            ChatWindowView(environment: environment)
                .frame(minWidth: 860, minHeight: 560)
        }
        .defaultSize(width: 1180, height: 780)
        // 隐藏标题栏：红绿灯浮在网页上（对齐 DeepSeek 官方 Harness 风格），
        // 网页全幅铺满窗口，弹窗遮罩不再出现"盖住标题栏"的割裂感
        .windowStyle(.hiddenTitleBar)
        .commands {
            DeepSeekCommands(environment: environment)
        }

        Window("关于 DeepSeek", id: "about") {
            AboutView(environment: environment)
        }
        .windowResizability(.contentSize)

        Settings {
            SettingsView(environment: environment)
        }
    }
}

/// 菜单与快捷键。遵循 macOS 习惯：Cmd+, 设置 / Cmd+N 新聊天 / Cmd+Shift+N 新窗口 /
/// Cmd+W 关窗口不退出 / Cmd+Q 退出 / Cmd+0 主窗口 / Cmd+R 刷新前端。
struct DeepSeekCommands: Commands {
    @ObservedObject var environment: AppEnvironment
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        // 文件菜单与官方 Harness 一致：只保留「关闭」。新建聊天/刷新等走网页 UI（⊕ 按钮），
        // 空 CommandGroup 顶掉 SwiftUI 默认的 New Window 项。
        CommandGroup(replacing: .newItem) {}
        CommandGroup(replacing: .appInfo) {
            Button("关于 DeepSeek") {
                environment.openAbout()
            }
        }
        // 应用菜单收纳：检查更新 + 导出诊断
        CommandGroup(after: .appInfo) {
            Button("检查更新…") {
                environment.updates.checkForUpdates()
            }
            Button("导出诊断信息…") {
                Task { @MainActor in
                    await environment.exportDiagnostics()
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {

    /// 菜单栏只保留 应用/文件/编辑/窗口（对齐官方 Harness）。SwiftUI 默认会创建
    /// 显示(View)与帮助(Help)菜单，CommandGroup 空替换对它们无效，只能在 AppKit 层移除。
    /// 文件菜单与官方一致只留「关闭」：清掉其它项后必须补回关闭项——空菜单会被 macOS 隐藏。
    private func trimDefaultMenus() {
        guard let menu = NSApp.mainMenu else { return }
        let removeTitles: Set<String> = ["显示", "View", "帮助", "Help"]
        for item in menu.items where removeTitles.contains(item.title) {
            menu.removeItem(item)
        }
        // 文件菜单：只留一个关闭项（⌘W performClose）
        if let file = menu.items.first(where: { $0.title == "文件" || $0.title == "File" }),
           let fileMenu = file.submenu {
            let closeItems = fileMenu.items.filter {
                $0.title.hasPrefix("关闭") || $0.title.hasPrefix("Close")
            }
            for item in fileMenu.items where !closeItems.contains(item) {
                fileMenu.removeItem(item)
            }
            if closeItems.isEmpty {
                fileMenu.addItem(Self.makeCloseItem())
            }
        } else if menu.items.first(where: { $0.title == "编辑" || $0.title == "Edit" }) != nil {
            // 文件菜单不存在（被隐藏/移除）时重建，插在编辑菜单之前
            let item = NSMenuItem(title: "文件", action: nil, keyEquivalent: "")
            let fileMenu = NSMenu(title: "文件")
            fileMenu.addItem(Self.makeCloseItem())
            item.submenu = fileMenu
            if let editIndex = menu.items.firstIndex(where: { $0.title == "编辑" || $0.title == "Edit" }) {
                menu.insertItem(item, at: editIndex)
            } else {
                menu.addItem(item)
            }
        }
    }

    private static func makeCloseItem() -> NSMenuItem {
        NSMenuItem(title: "关闭页面或窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SwiftUI 安装默认菜单晚于此回调，延迟裁剪并幂等重试
        for delay in [0.1, 0.5, 1.5, 3.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.trimDefaultMenus()
            }
        }
        // SwiftUI 在窗口增减等场景会重建菜单；用户打开任何菜单前再裁一次（幂等）
        NotificationCenter.default.addObserver(
            forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.trimDefaultMenus()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 关闭最后窗口不断开应用：可从 Dock/菜单栏恢复
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            NotificationCenter.default.post(name: .deepseekReopenMainWindow, object: nil)
        }
        return true
    }
}

extension Notification.Name {
    static let deepseekReopenMainWindow = Notification.Name("deepseek.reopen-main-window")
}
