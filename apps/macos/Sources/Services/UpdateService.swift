import Foundation
import AppKit
import Sparkle

/// 正式发布前需配置 Info.plist 中的 SUFeedURL / SUPublicEDKey，并验收签名和 appcast。
@MainActor
final class UpdateService {
    private let controller: SPUStandardUpdaterController?

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let feed = info["SUFeedURL"] as? String ?? ""
        let publicKey = info["SUPublicEDKey"] as? String ?? ""
        if feed.hasPrefix("https://") && !publicKey.isEmpty {
            controller = SPUStandardUpdaterController(
                startingUpdater: true,
                updaterDelegate: nil,
                userDriverDelegate: nil
            )
        } else {
            controller = nil
        }
    }

    func checkForUpdates() {
        guard let controller else {
            let alert = NSAlert()
            alert.messageText = "尚未配置更新服务"
            alert.informativeText = "请在正式发布前添加 SUFeedURL 和 SUPublicEDKey，并生成已签名的更新清单。"
            alert.alertStyle = .informational
            alert.runModal()
            return
        }
        controller.checkForUpdates(nil)
    }
}
