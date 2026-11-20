import SwiftUI

struct AboutView: View {
    @ObservedObject var environment: AppEnvironment

    var body: some View {
        VStack(spacing: 12) {
            // 真实应用图标（鲸鱼 icns）；拿不到时回退占位符号
            if let icon = NSApp.applicationIconImage {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            } else {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 48, weight: .medium))
                    .foregroundStyle(Color.accentColor)
            }
            Text("DeepSeek")
                .font(.title.bold())
            Text("本地桌面客户端 · 独立第三方实现")
                .foregroundStyle(.secondary)
            Text("版本 \(environment.version) (\(environment.build))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("基于 MIT 许可的开源项目 deepseek-ai/chat-demo 构建；\nAPI Key 存储在 macOS Keychain，聊天数据保存在本机。")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Button("检查更新") {
                    environment.updates.checkForUpdates()
                }
                Button("上游许可") {
                    if let url = URL(string: "https://github.com/deepseek-ai/chat-demo/blob/main/LICENSE") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
        .padding(30)
        .frame(width: 380)
    }
}
