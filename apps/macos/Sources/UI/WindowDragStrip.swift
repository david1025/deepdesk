import SwiftUI
import AppKit

/// 隐藏标题栏后的可拖拽区：覆盖侧栏头部（logo 行），
/// `mouseDownCanMoveWindow` 让鼠标按下拖动即可移动窗口（对齐官方 Harness 风格）。
/// 只盖住 logo 区域，不覆盖右侧折叠按钮，避免吞掉网页点击。
struct WindowDragStrip: NSViewRepresentable {
    func makeNSView(context: Context) -> DragStripView {
        DragStripView()
    }

    func updateNSView(_ nsView: DragStripView, context: Context) {}

    final class DragStripView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { self }
    }
}
