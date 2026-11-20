import SwiftUI

struct ChatWindowView: View {
    @ObservedObject var environment: AppEnvironment
    @Environment(\.openWindow) private var openWindow
    @State private var reopenObserver: NSObjectProtocol?

    var body: some View {
        WebContainerView(environment: environment)
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            // 隐藏标题栏后的窗口拖拽区：盖住红绿灯周边（其下方网页内容不可点，
            // 侧栏内容已避让到红绿灯之外，互不干扰）
            .overlay(alignment: .topLeading) {
                WindowDragStrip()
                    .frame(width: 86, height: 54)
                    .accessibilityHidden(true)
            }
            .background(WindowFrameAutosave(name: "DeepSeekMainWindow"))
            // 红绿灯下移+右移：与侧栏顶行按钮（y≈24）垂直对齐、与品牌 logo 中心（x≈27）水平对齐
            .background(TrafficLightOffset(offsetX: 3, offsetY: 8))
            .onAppear {
                // 注入 SwiftUI openWindow：Bridge window.new / 菜单 / Dock 重开共用
                if environment.windowOpener == nil {
                    environment.windowOpener = { windowId in
                        openWindow(id: windowId)
                    }
                }
                if reopenObserver == nil {
                    reopenObserver = NotificationCenter.default.addObserver(
                        forName: .deepseekReopenMainWindow, object: nil, queue: .main
                    ) { _ in
                        Task { @MainActor in
                            environment.openMainWindow()
                        }
                    }
                }
            }
    }
}
