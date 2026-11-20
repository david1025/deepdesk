# DeepSeek macOS V1 — 开发方案与可接续工程骨架

> **这是开发脚手架，不是完整成品。** 原生窗口 / WebKit 加载 / 基础 Bridge / Keychain / 更新服务接线 / Bonjour 发现骨架已有源文件；DeepSeek 聊天前端需要从你们已修改的 Windows 版本移入。文档中标明的 API 迁移、同步、完整更新、安装签名、真实设备测试等工作由下游开发 AI 完成。不能把占位网页或未经验证的能力宣称已实现。

## 快速开始（macOS + Xcode）

1. 安装 Xcode（建议 Xcode 16+）、Node.js 22.12+、pnpm、XcodeGen：`brew install xcodegen`。
2. **优先**把你们现有 Windows 版的 **网页源代码**拷贝到 `apps/web/`。不是 Windows .exe，也不是复制整个 Electron/WebView2 宿主。
3. 执行 `./scripts/build-web.sh`，把构建好的静态资源装入 `apps/macos/Resources/Web/`。
4. 执行 `./scripts/bootstrap-macos.sh`，生成 Xcode 工程并编译未签名 Debug 版本。
5. 打开 `apps/macos/DeepSeekMac.xcodeproj`，选择 `DeepSeekMac` scheme，在真 Mac 上测试。

**想先验证原生容器**：跳过第 2、3 步，直接运行 `./scripts/bootstrap-macos.sh`，将看到明确标记的 Bridge 验证占位页。它不提供聊天业务功能。

**没有 Windows 源码时**：可运行 `./scripts/checkout-upstream.sh` 下载公开的 `deepseek-ai/chat-demo`，但不会包含你们 Windows 版自定义的界面、数据和流程。

## 交付内容

- `apps/macos/project.yml`：XcodeGen 项目定义；macOS 13+、Swift 5.9、SwiftUI、WKWebView、Sparkle Swift Package。
- `apps/macos/Sources/`：原生应用启动、窗口、菜单栏、关于、WebKit、下载/文件选择、Keychain、基础 Bridge、更新与设备发现骨架。
- `apps/macos/Resources/Web/`：可替换的内置网页资源（当前是占位页）。
- `contracts/`：前端/原生调用契约与局域网同步消息结构草案。
- `scripts/`：安装前端构建资源、拉取上游、生成 Xcode 工程、静态校验。
- `docs/`：完整架构、迁移步骤、功能清单、数据协议、V1 验收、AI 分工、打包发布说明。
- `.github/workflows/`：macOS 无签名编译验证 CI 草案。

## 实施顺序

先在 **Windows 自定义前端源代码** 上建立共享 `apps/web`，然后让 macOS 宿主加载同一份构建资源。V1 需要完成：所有已有 DeepSeek 功能、原生桌面体验、跨窗口状态、Keychain + 原生网络、可靠持久化与备份、完整自动更新、签名发布，以及跨端局域网同步（要求 Windows/Android 侧配合实现同一协议）。各阶段只是开发顺序，**不表示发布后再补功能**。

完整技术方案：`docs/01-technical-plan.md`。

## 安全和发布注意事项

- `com.example.deepseekmac` 是占位 Bundle ID，正式发布前必须改为自有 ID，之后不要随意变更。
- `Info.plist` 里没有配置假的更新 URL 或假的更新公钥。请按文档生成正式配置。
- Debug 版可不签名；正式分发应使用 Developer ID 签名、公证和 Sparkle EdDSA 签名。
- 目前仅 Keychain 底层已落文件，原版 Web 仍然直接调用 API。正式 V1 必须改为原生代理请求，使 Key 不返回给 Web JS。
- `file://` 下的 IndexedDB/CORS/录音兼容性需要真机逐项验证；若不满足条件，按迁移文档启用更稳定的资源来源/原生数据适配，不可直接发布。
- Swift 项目 **尚未经过真实 Xcode 编译**（生成环境不是 macOS），CI 或 Mac 实机编译时如有 SDK API 差异需修正；这是明确的待办项。

## 上游与许可

Web 来源：https://github.com/deepseek-ai/chat-demo（MIT）
请在发版的关于/许可页面与分发包保留 MIT 声明，并排查其他依赖许可。此项目不是 DeepSeek 官方桌面客户端；商业名称、logo、分发声明需自行核对授权及品牌政策。
