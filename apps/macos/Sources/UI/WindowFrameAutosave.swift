import SwiftUI
import AppKit

/// 窗口尺寸/位置记忆（T08/B01）：SwiftUI WindowGroup 的 defaultSize 只在首次启动生效，
/// 这里借助 NSWindow.setFrameAutosaveName 把 frame 持久化到 UserDefaults，下次打开自动恢复。
/// 主窗口多实例共享同一 autosave 名（最后关闭的窗口决定记忆值），符合聊天应用习惯。
struct WindowFrameAutosave: NSViewRepresentable {
    let name: String

    func makeNSView(context: Context) -> NSView { FrameCaptureView(name: name) }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class FrameCaptureView: NSView {
        let name: String
        private var applied = false

        init(name: String) {
            self.name = name
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("unsupported")
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard !applied, let window else { return }
            applied = true
            // 设置 autosave 名时若存在记忆值会立即恢复 frame（覆盖 defaultSize）
            window.setFrameAutosaveName(name)
        }
    }
}
