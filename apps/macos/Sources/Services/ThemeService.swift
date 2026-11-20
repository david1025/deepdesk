import AppKit

/// 主题联动。与 Windows 版一致：网页 UI 的主题偏好是主控，原生窗口外观跟随网页。
/// 网页通过 system.themeChanged 上报 {theme, preference}：
/// - preference = system：清除原生覆盖，NSApp 跟随系统（网页 matchMedia 同步跟随系统）。
/// - preference = light/dark：显式覆盖原生外观，与页面一致。
/// 系统外观变化时向网页推送 nativeThemeChanged（Bridge 契约事件；网页跟随系统
/// 模式依赖 matchMedia 自动生效，该事件用于状态展示与调试）。
@MainActor
final class ThemeService: NSObject, ObservableObject {
    @Published private(set) var currentIsDark: Bool
    private var observers: [(Bool) -> Void] = []
    private var appearanceObservation: NSKeyValueObservation?

    override init() {
        self.currentIsDark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        super.init()
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                guard dark != self.currentIsDark else { return }
                self.currentIsDark = dark
                for observer in self.observers {
                    observer(dark)
                }
            }
        }
    }

    func addThemeObserver(_ observer: @escaping (Bool) -> Void) {
        observers.append(observer)
        observer(currentIsDark)
    }

    /// 网页上报的实际主题与偏好。
    func applyWebReported(theme: String, preference: String) {
        switch preference {
        case "light":
            NSApp.appearance = NSAppearance(named: .aqua)
        case "dark":
            NSApp.appearance = NSAppearance(named: .darkAqua)
        default:
            // 跟随系统：清除覆盖，系统切换时网页与原生同步变化
            NSApp.appearance = nil
        }
    }

    var themeName: String {
        currentIsDark ? "dark" : "light"
    }
}
