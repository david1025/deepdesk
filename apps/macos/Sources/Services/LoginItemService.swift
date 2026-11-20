import Foundation
import ServiceManagement

/// 开机启动项（macOS 13 SMAppService）。状态以系统为准，设置界面据此显示。
@MainActor
final class LoginItemService: ObservableObject {
    @Published private(set) var isEnabled: Bool = false

    init() {
        refreshStatus()
    }

    func refreshStatus() {
        isEnabled = SMAppService.mainApp.status == .enabled
    }

    func setEnabled(_ enabled: Bool) throws {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            throw error
        }
        refreshStatus()
    }
}
