import SwiftUI
import AppKit

/// 隐藏标题栏窗口的红绿灯位置调整：AppKit 无公开 API。
/// 直接对三个标准窗口按钮 setFrameOrigin（AppKit 不重置按钮 frame，仅偶发漂移），
/// 期望位置以初始位置 + 偏移量表示；挂 didUpdateNotification 校验漂移并自动校正。
struct TrafficLightOffset: NSViewRepresentable {
    /// 水平偏移（正数右移），使红绿灯与侧栏 logo 对齐
    let offsetX: CGFloat
    /// 垂直下移像素（与侧栏顶行按钮对齐）
    let offsetY: CGFloat

    func makeNSView(context: Context) -> MoverView {
        let view = MoverView()
        view.offsetX = offsetX
        view.offsetY = offsetY
        return view
    }

    func updateNSView(_ nsView: MoverView, context: Context) {
        nsView.offsetX = offsetX
        nsView.offsetY = offsetY
        nsView.apply()
    }

    final class MoverView: NSView {
        var offsetX: CGFloat = 0
        var offsetY: CGFloat = 0
        private var initialCenter: CGPoint?
        private var resizeObserver: NSObjectProtocol?
        private var updateObserver: NSObjectProtocol?
        private var adjustCount = 0
        private var failureLogged = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window = window else { return }
            if initialCenter == nil, let close = window.standardWindowButton(.closeButton) {
                initialCenter = centerWindowPoint(of: close)
            }
            apply()
            if updateObserver == nil {
                updateObserver = NotificationCenter.default.addObserver(
                    forName: NSWindow.didUpdateNotification, object: window, queue: .main
                ) { [weak self] _ in
                    self?.correctDriftIfNeeded()
                }
            }
            if resizeObserver == nil {
                resizeObserver = NotificationCenter.default.addObserver(
                    forName: NSWindow.didResizeNotification, object: window, queue: .main
                ) { [weak self] _ in
                    self?.correctDriftIfNeeded()
                }
            }
        }

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            super.viewWillMove(toWindow: newWindow)
            for observer in [resizeObserver, updateObserver].compactMap({ $0 }) {
                NotificationCenter.default.removeObserver(observer)
            }
            resizeObserver = nil
            updateObserver = nil
        }

        deinit {
            for observer in [resizeObserver, updateObserver].compactMap({ $0 }) {
                NotificationCenter.default.removeObserver(observer)
            }
        }

        private static func debugLog(_ line: String) {
            let path = "/tmp/tl-chain.txt"
            if let handle = FileHandle(forWritingAtPath: path) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data((line + "\n").utf8))
                try? handle.close()
            } else {
                try? (line + "\n").write(toFile: path, atomically: true, encoding: .utf8)
            }
        }

        /// 视图中心在窗口坐标中的位置（bottom-based：视觉下移 = y 减小）
        private func centerWindowPoint(of view: NSView) -> CGPoint {
            view.convert(view.bounds, to: nil).applying(CGAffineTransform(translationX: 0, y: 0)).midPoint
        }

        /// 期望的红绿灯中心（窗口坐标）
        private var targetCenter: CGPoint? {
            guard let initialCenter else { return nil }
            return CGPoint(x: initialCenter.x + offsetX, y: initialCenter.y - offsetY)
        }

        /// 已对齐目标位置则跳过；漂移超过 0.5px 重新校准
        private func correctDriftIfNeeded() {
            guard let window = window, let close = window.standardWindowButton(.closeButton),
                  let target = targetCenter, initialCenter != nil else { return }
            let current = centerWindowPoint(of: close)
            if abs(current.x - target.x) > 0.5 || abs(current.y - target.y) > 0.5 {
                adjustCount += 1
                if adjustCount < 50 {
                    apply()
                }
            }
        }

        func apply() {
            guard let window = window,
                  let closeButton = window.standardWindowButton(.closeButton),
                  let target = targetCenter else { return }
            let current = centerWindowPoint(of: closeButton)
            // 需要的位移（窗口坐标：右移 = x 增大，下移 = y 减小）
            let dx = target.x - current.x
            let dy = current.y - target.y
            if abs(dx) < 0.5 && abs(dy) < 0.5 { return }

            let buttonTypes: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
            let buttons = buttonTypes.compactMap { window.standardWindowButton($0) }
            guard buttons.count == 3 else {
                if !failureLogged {
                    failureLogged = true
                    Self.debugLog("standard buttons not found")
                }
                return
            }

            let originals = buttons.map { ($0, $0.frame) }
            for (button, _) in originals {
                var frame = button.frame
                frame.origin.x += dx
                frame.origin.y -= dy
                button.setFrameOrigin(frame.origin)
            }
            let after = centerWindowPoint(of: closeButton)
            if abs(after.x - target.x) < 0.5 && abs(after.y - target.y) < 0.5 {
                if adjustCount < 3 {
                    Self.debugLog("applied dx=\(dx) dy=\(dy), center=\(after), closeFrame=\(closeButton.frame)")
                }
            } else {
                // 移动未生效（坐标方向与预期相反等情况）：回滚并按相反符号重试
                for (button, frame) in originals {
                    button.setFrameOrigin(frame.origin)
                }
                for (button, _) in originals {
                    var frame = button.frame
                    frame.origin.x -= dx
                    frame.origin.y += dy
                    button.setFrameOrigin(frame.origin)
                }
                let after2 = centerWindowPoint(of: closeButton)
                if abs(after2.x - target.x) < 0.5 && abs(after2.y - target.y) < 0.5 {
                    Self.debugLog("applied (inverted sign) dx=\(dx) dy=\(dy), center=\(after2)")
                } else if !failureLogged {
                    failureLogged = true
                    Self.debugLog("frame move failed: after=\(after) after2=\(after2)")
                }
            }
        }
    }
}

private extension CGRect {
    var midPoint: CGPoint {
        CGPoint(x: midX, y: midY)
    }
}
